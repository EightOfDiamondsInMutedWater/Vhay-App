// ─────────────────────────────────────────────────────────────────────────────
// SC.PO Phase 6B — PO Financing Helpers
//
// Bridge/marketplace model: SC.PO connects vendor borrowers with licensed
// lenders. SC.PO provides identity, collateral proof, and servicing.
// Lenders make credit decisions and hold licenses.
//
// ⚠️ LEGAL REVIEW REQUIRED before enabling for real users.
//
// This file provides:
//   1. FinancingPackage — structured proof-of-funds for lender review
//   2. assembleFinancingPackage() — builds package from on-chain data
//   3. scanFinancingRequests() — scan wallet for FINANCE_REQUEST memos
//   4. scanFinancingResponses() — scan wallet for APPROVE/DENY memos
//   5. computeDaysUntilCancel() — key risk metric for lenders
//   6. formatFinancingTermsForDisplay() — human-readable terms
// ─────────────────────────────────────────────────────────────────────────────

import * as xrpl from 'xrpl';
import { getXRPLClient } from './xrplHelpers';
import { parseMemo, SCPO_ACTIONS } from './memoHelpers';

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — Core Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FinancingPackage — the complete proof-of-funds document sent to a lender.
 *
 * The locked escrow IS the collateral. This package proves it exists,
 * how much is locked, when it expires, and who the parties are.
 * Lenders verify independently via the XRPL ledger using the tx hashes.
 */
export interface FinancingPackage {
  // ── The escrow proof (primary collateral evidence) ────────────────────────
  escrowSequence:     number;   // Escrow ledger sequence
  escrowAmount:       string;   // Exact RLUSD locked (e.g. "1000.00")
  escrowCurrency:     string;   // 'RLUSD' or 'XRP'
  escrowOwner:        string;   // Buyer wallet address
  escrowDestination:  string;   // Vendor wallet address
  finishAfter:        string;   // ISO date — earliest claim date
  cancelAfter:        string;   // ISO date — ⚠️ key risk: funds return to buyer after this
  daysUntilCancel:    number;   // Days remaining before escrow expires
  conditionHex:       string;   // Crypto-condition hash (proves escrow is tied to this PO)

  // ── The PO proof ──────────────────────────────────────────────────────────
  poIssuanceId:       string;   // MPT issuance ID
  poName:             string;
  poTotal:            string;   // Matches escrow amount
  paymentTerms:       string;
  ipfsUri:            string;   // Full PO document (IPFS)
  txHashes: {
    created:  string;           // MPTokenIssuanceCreate tx
    accepted: string;           // MPTokenAuthorize tx
    funded:   string;           // EscrowCreate tx
  };

  // ── Identity proof ────────────────────────────────────────────────────────
  buyerAddress:       string;
  buyerCredTier:      string;   // 'basic' | 'verified' | 'institutional'
  vendorAddress:      string;
  vendorCredTier:     string;

  // ── Financing request details ─────────────────────────────────────────────
  requestId:          string;   // UUID for this specific request
  requestedAdvance:   string;   // RLUSD amount vendor wants (e.g. "800.00")
  advanceRate:        number;   // Fraction of PO total (e.g. 0.80 = 80%)
  lenderAddress:      string;   // Lender wallet in Permissioned Domain
  scpoFeeRate:        number;   // SC.PO fee fraction of advance (e.g. 0.01 = 1%)
  scpoFeeAmount:      string;   // Calculated SC.PO fee in RLUSD
  termsCID:           string;   // IPFS CID of the financing terms document

  // ── Metadata ─────────────────────────────────────────────────────────────
  packageVersion:     number;   // Schema version — bump if shape changes
  assembledAt:        string;   // ISO timestamp
  networkId:          string;   // 'devnet' | 'testnet' | 'mainnet'
}

/**
 * FinancingRequest — local state tracking a vendor's financing request.
 *
 * Created when vendor submits a request. Updated when lender responds.
 * Persisted on-chain via FINANCE_REQUEST, FINANCE_APPROVED, FINANCE_DENIED memos.
 */
export interface FinancingRequest {
  requestId:          string;
  poIssuanceId:       string;
  vendorAddress:      string;
  lenderAddress:      string;
  requestedAmount:    string;   // RLUSD
  advanceRate:        number;
  termsCID:           string;
  requestTxHash:      string;
  requestTimestamp:   number;   // Unix seconds
  status: 'pending_lender' | 'approved' | 'denied' | 'disbursed' | 'repaid' | 'defaulted';

  // ── Set on approval ───────────────────────────────────────────────────────
  approvedAmount?:    string;
  approvedAPR?:       number;
  repayBy?:           number;   // Unix seconds (tied to escrow CancelAfter)
  approvalTxHash?:    string;

  // ── Set on denial ─────────────────────────────────────────────────────────
  denialReason?:      string;
  denialTxHash?:      string;

  // ── Set on disbursement ───────────────────────────────────────────────────
  disbursementTxHash?: string;
  disbursedAt?:        number;

  // ── Set on repayment ──────────────────────────────────────────────────────
  repaidTxHash?:       string;
  repaidAt?:           number;
}

/**
 * LenderProfile — a registered lender in the Permissioned Domain.
 * Holds an Institutional credential. Visible to vendors when requesting financing.
 */
export interface LenderProfile {
  walletAddress:  string;
  displayName:    string;       // From their DID/profile
  credTier:       string;       // Should always be 'institutional'
  publishedAPR?:  number;       // Optional: lender publishes their rate on-chain
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — Constants
// ─────────────────────────────────────────────────────────────────────────────

/** SC.PO platform fee on financing advances (1% of advance amount) */
export const SCPO_FINANCE_FEE_RATE = 0.01;

/** Maximum advance rate allowed (80% of PO total) */
export const MAX_ADVANCE_RATE = 0.80;

/** Minimum days until CancelAfter required to offer financing */
export const MIN_DAYS_UNTIL_CANCEL = 3;

/** Package schema version */
export const FINANCING_PACKAGE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────
// § 3 — Key Risk Utility
// ─────────────────────────────────────────────────────────────────────────────

const RIPPLE_EPOCH = 946684800;

/**
 * computeDaysUntilCancel — the primary risk metric for PO financing.
 *
 * Fetches the escrow's CancelAfter from the ledger and returns how many
 * days remain before the escrow expires. If this is <= MIN_DAYS_UNTIL_CANCEL,
 * financing should be blocked — not enough time for disbursement + repayment.
 *
 * @param buyerAddress  - Escrow owner
 * @param escrowSequence - Escrow sequence number
 * @returns { daysUntilCancel, cancelAfterDate, finishAfterDate, escrowAmount }
 */
export const fetchEscrowDetails = async (
  buyerAddress: string,
  escrowSequence: number
): Promise<{
  daysUntilCancel: number;
  cancelAfterDate: string;
  finishAfterDate: string;
  escrowAmount: string;
  escrowCurrency: string;
  conditionHex: string;
}> => {
  const client = await getXRPLClient();
  const response: any = await client.request({
    command: 'ledger_entry',
    escrow: { owner: buyerAddress, seq: escrowSequence },
    ledger_index: 'validated',
  });

  const escrow = response.result.node;
  if (!escrow) throw new Error('Escrow not found on ledger');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cancelAfterUnix = (escrow.CancelAfter || 0) + RIPPLE_EPOCH;
  const finishAfterUnix = (escrow.FinishAfter || 0) + RIPPLE_EPOCH;
  const daysUntilCancel = Math.max(0, (cancelAfterUnix - nowSeconds) / 86400);

  // Parse amount
  let escrowAmount = '0';
  let escrowCurrency = 'XRP';
  if (typeof escrow.Amount === 'string') {
    escrowAmount = xrpl.dropsToXrp(escrow.Amount).toString();
    escrowCurrency = 'XRP';
  } else if (typeof escrow.Amount === 'object' && escrow.Amount?.value) {
    escrowAmount = escrow.Amount.value;
    escrowCurrency = escrow.Amount.currency || 'RLUSD';
  }

  return {
    daysUntilCancel: parseFloat(daysUntilCancel.toFixed(1)),
    cancelAfterDate: new Date(cancelAfterUnix * 1000).toISOString(),
    finishAfterDate: new Date(finishAfterUnix * 1000).toISOString(),
    escrowAmount,
    escrowCurrency,
    conditionHex: escrow.Condition || '',
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 4 — FinancingPackage Assembler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * assembleFinancingPackage — builds the complete proof-of-funds document.
 *
 * Called when vendor clicks "Request Financing" on a funded PO.
 * All data derived from on-chain sources — no off-chain state required.
 *
 * @param po              - The funded SavedPO
 * @param requestId       - UUID for this financing request
 * @param requestedAmount - RLUSD advance amount vendor wants
 * @param lenderAddress   - Lender wallet address
 * @param buyerCredTier   - Buyer's credential tier (from validateCredential)
 * @param vendorCredTier  - Vendor's credential tier
 * @param auditLog        - Existing audit log entries (for tx hashes)
 * @param termsCID        - IPFS CID of the financing terms document
 */
export const assembleFinancingPackage = async (
  po: {
    issuanceId: string;
    poName: string;
    total: string;
    paymentTerms: string;
    ipfsUri: string;
    escrowSequence: number;
    buyerAddress: string;
    vendorAddress: string;
    escrowCurrency?: string;
    txHash: string;
  },
  requestId: string,
  requestedAmount: string,
  lenderAddress: string,
  buyerCredTier: string,
  vendorCredTier: string,
  auditLog: Array<{ action: string; ref: string; txHash: string; date: string }>,
  termsCID: string
): Promise<FinancingPackage> => {

  // Fetch live escrow details from ledger
  const escrowDetails = await fetchEscrowDetails(po.buyerAddress, po.escrowSequence);

  // Resolve tx hashes from audit log
  const poAudit = auditLog.filter(e => e.ref === po.issuanceId);
  const fundEntry    = poAudit.find(e => e.action === 'FUND_ESCROW');
  const acceptEntry  = poAudit.find(e => e.action === 'ACCEPT_PO');

  // Calculate fees
  const advance      = parseFloat(requestedAmount);
  const poTotal      = parseFloat(po.total);
  const advanceRate  = poTotal > 0 ? advance / poTotal : 0;
  const scpoFeeAmt   = (advance * SCPO_FINANCE_FEE_RATE).toFixed(6);

  // Detect network
  const client = await getXRPLClient();
  const serverInfo: any = await client.request({ command: 'server_info' });
  const network = serverInfo.result?.info?.network_id === 0 ? 'devnet'
    : serverInfo.result?.info?.network_id === 1 ? 'mainnet'
    : 'testnet';

  return {
    escrowSequence:    po.escrowSequence,
    escrowAmount:      escrowDetails.escrowAmount,
    escrowCurrency:    escrowDetails.escrowCurrency,
    escrowOwner:       po.buyerAddress,
    escrowDestination: po.vendorAddress,
    finishAfter:       escrowDetails.finishAfterDate,
    cancelAfter:       escrowDetails.cancelAfterDate,
    daysUntilCancel:   escrowDetails.daysUntilCancel,
    conditionHex:      escrowDetails.conditionHex,

    poIssuanceId:      po.issuanceId,
    poName:            po.poName,
    poTotal:           po.total,
    paymentTerms:      po.paymentTerms,
    ipfsUri:           po.ipfsUri,
    txHashes: {
      created:  po.txHash || '',
      accepted: acceptEntry?.txHash || '',
      funded:   fundEntry?.txHash || '',
    },

    buyerAddress:      po.buyerAddress,
    buyerCredTier,
    vendorAddress:     po.vendorAddress,
    vendorCredTier,

    requestId,
    requestedAdvance:  requestedAmount,
    advanceRate:       parseFloat(advanceRate.toFixed(4)),
    lenderAddress,
    scpoFeeRate:       SCPO_FINANCE_FEE_RATE,
    scpoFeeAmount:     scpoFeeAmt,
    termsCID,

    packageVersion:    FINANCING_PACKAGE_VERSION,
    assembledAt:       new Date().toISOString(),
    networkId:         network,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — On-Chain Scanners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scanFinancingRequests — scan a vendor wallet for all FINANCE_REQUEST memos.
 * Returns all financing requests the vendor has submitted, with current status.
 */
export const scanFinancingRequests = async (
  vendorAddress: string
): Promise<FinancingRequest[]> => {
  const requests = new Map<string, FinancingRequest>();

  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: vendorAddress,
      limit: 400,
    });

    for (const txEntry of resp.result.transactions || []) {
      const tx = (txEntry as any).tx_json || (txEntry as any).tx || {};
      if (!tx?.Memos?.length) continue;

      for (const memoWrapper of tx.Memos) {
        const memo = parseMemo(memoWrapper.Memo);
        if (!memo) continue;

        const action  = memo.a as string;
        const payload = memo.p as any;
        const hash    = (txEntry as any).hash || tx.hash || '';
        const closeTime = (txEntry as any).close_time_iso || null;
        const timestamp = closeTime ? Math.floor(new Date(closeTime).getTime() / 1000) : Math.floor(Date.now() / 1000);

        if (action === SCPO_ACTIONS.FINANCE_REQUEST) {
          const reqId = memo.r as string;
          if (!requests.has(reqId)) {
            requests.set(reqId, {
              requestId:        reqId,
              poIssuanceId:     payload.poRef || '',
              vendorAddress,
              lenderAddress:    payload.lender || '',
              requestedAmount:  payload.amt || '0',
              advanceRate:      payload.advRate || 0,
              termsCID:         payload.termsCID || '',
              requestTxHash:    hash,
              requestTimestamp: timestamp,
              status:           'pending_lender',
            });
          }
        }

        if (action === SCPO_ACTIONS.FINANCE_APPROVED) {
          const reqId = payload.reqId || memo.r;
          const existing = requests.get(reqId);
          if (existing) {
            requests.set(reqId, {
              ...existing,
              status:         'approved',
              approvedAmount: payload.advAmt,
              approvedAPR:    payload.apr,
              repayBy:        payload.repayBy,
              approvalTxHash: hash,
            });
          }
        }

        if (action === SCPO_ACTIONS.FINANCE_DENIED) {
          const reqId = payload.reqId || memo.r;
          const existing = requests.get(reqId);
          if (existing) {
            requests.set(reqId, {
              ...existing,
              status:       'denied',
              denialReason: payload.reason,
              denialTxHash: hash,
            });
          }
        }

        if (action === SCPO_ACTIONS.FINANCE_DISBURSED) {
          const reqId = payload.reqId || memo.r;
          const existing = requests.get(reqId);
          if (existing) {
            requests.set(reqId, {
              ...existing,
              status:              'disbursed',
              disbursementTxHash:  payload.txRef,
              disbursedAt:         timestamp,
            });
          }
        }

        if (action === SCPO_ACTIONS.FINANCE_REPAID) {
          const reqId = payload.reqId || memo.r;
          const existing = requests.get(reqId);
          if (existing) {
            requests.set(reqId, {
              ...existing,
              status:      'repaid',
              repaidTxHash: hash,
              repaidAt:     timestamp,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[scanFinancingRequests] scan failed:', err);
  }

  return Array.from(requests.values()).sort(
    (a, b) => b.requestTimestamp - a.requestTimestamp
  );
};

/**
 * getActiveFinancingRequest — check if a specific PO has an active financing request.
 * Used by claimEscrowForPO to detect whether repayment routing is needed.
 *
 * @param vendorAddress  - Vendor wallet to scan
 * @param poIssuanceId   - PO to check
 * @returns FinancingRequest if active (approved or disbursed), null otherwise
 */
export const getActiveFinancingRequest = async (
  vendorAddress: string,
  poIssuanceId: string
): Promise<FinancingRequest | null> => {
  const requests = await scanFinancingRequests(vendorAddress);
  return requests.find(
    r => r.poIssuanceId === poIssuanceId &&
         (r.status === 'approved' || r.status === 'disbursed')
  ) || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// § 6 — Financing Terms Display Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * formatFinancingTermsForDisplay — human-readable terms summary.
 * Shown to vendor before they submit the financing request.
 *
 * @param poTotal         - PO total in RLUSD
 * @param advanceRate     - Requested advance rate (e.g. 0.80)
 * @param publishedAPR    - Lender's published APR (e.g. 0.12 = 12%)
 * @param daysUntilCancel - Days until escrow expires
 */
export const formatFinancingTerms = (
  poTotal: string,
  advanceRate: number,
  publishedAPR: number,
  daysUntilCancel: number
): {
  advanceAmount:    string;
  scpoFee:          string;
  netToVendor:      string;
  estimatedInterest: string;
  totalRepayment:   string;
  remainderAtClaim: string;
  isEligible:       boolean;
  ineligibleReason?: string;
} => {
  const total    = parseFloat(poTotal);
  const advance  = total * advanceRate;
  const scpoFee  = advance * SCPO_FINANCE_FEE_RATE;
  const netToVendor = advance - scpoFee;

  // Interest accrues from disbursement until claim (estimated as daysUntilCancel / 2)
  const estimatedDays     = Math.max(1, daysUntilCancel / 2);
  const estimatedInterest = advance * publishedAPR * (estimatedDays / 365);
  const totalRepayment    = advance + estimatedInterest;
  const remainderAtClaim  = total - totalRepayment - scpoFee;

  const isEligible = daysUntilCancel > MIN_DAYS_UNTIL_CANCEL && advance > 0 && remainderAtClaim > 0;
  const ineligibleReason = !isEligible
    ? daysUntilCancel <= MIN_DAYS_UNTIL_CANCEL
      ? `Escrow expires in ${daysUntilCancel.toFixed(1)} days — too soon for financing`
      : remainderAtClaim <= 0
        ? 'Advance rate too high — repayment would exceed escrow amount'
        : undefined
    : undefined;

  const fmt = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return {
    advanceAmount:     fmt(advance),
    scpoFee:           fmt(scpoFee),
    netToVendor:       fmt(netToVendor),
    estimatedInterest: fmt(estimatedInterest),
    totalRepayment:    fmt(totalRepayment),
    remainderAtClaim:  fmt(remainderAtClaim),
    isEligible,
    ineligibleReason,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 7 — Repayment Calculator (used at claim time)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeRepaymentSplit — calculate the three-way split when a financed
 * escrow is claimed.
 *
 * Split order:
 *   1. Lender repayment (advance + accrued interest)
 *   2. SC.PO fee
 *   3. Remainder to vendor
 *
 * @param escrowAmount     - Total escrow amount in RLUSD
 * @param advanceAmount    - Original advance disbursed
 * @param apr              - Agreed APR (e.g. 0.12)
 * @param disbursedAt      - Unix seconds when advance was sent
 * @returns { lenderRepayment, scpoFee, vendorRemainder } all as RLUSD strings
 */
export const computeRepaymentSplit = (
  escrowAmount: string,
  advanceAmount: string,
  apr: number,
  disbursedAt: number
): {
  lenderRepayment: string;
  scpoFee:         string;
  vendorRemainder: string;
  interestAccrued: string;
} => {
  const escrow   = parseFloat(escrowAmount);
  const advance  = parseFloat(advanceAmount);
  const nowSecs  = Math.floor(Date.now() / 1000);
  const daysHeld = Math.max(0, (nowSecs - disbursedAt) / 86400);

  const interest        = advance * apr * (daysHeld / 365);
  const lenderRepayment = advance + interest;
  const scpoFee         = advance * SCPO_FINANCE_FEE_RATE;
  const vendorRemainder = Math.max(0, escrow - lenderRepayment - scpoFee);

  const fmt = (n: number) => n.toFixed(6);

  return {
    lenderRepayment: fmt(lenderRepayment),
    scpoFee:         fmt(scpoFee),
    vendorRemainder: fmt(vendorRemainder),
    interestAccrued: fmt(interest),
  };
};
