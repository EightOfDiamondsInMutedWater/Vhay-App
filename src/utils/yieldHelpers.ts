// ─────────────────────────────────────────────────────────────────────────────
// SC.PO Phase 6 — Trade Finance Types & Yield Partner Infrastructure
//
// This file defines:
//   1. Core Phase 6 data types (YieldPosition, FinancingRequest, CollateralPledge)
//   2. YieldPartnerAdapter interface — the plug-in contract for yield partners
//   3. StubYieldPartner — devnet mock implementation (replace with real partner)
//   4. scanYieldPositions — ledger scanner for yield opt-ins
//   5. getActiveYieldPosition — check if a PO has an active yield position
//   6. computeAccruedYield — time-weighted yield calculation
//
// PARTNER INTEGRATION NOTE:
//   To add a real yield partner, implement YieldPartnerAdapter and register it
//   in YIELD_PARTNER_REGISTRY below. No other code changes required.
// ─────────────────────────────────────────────────────────────────────────────

import * as xrpl from 'xrpl';
import type { AccountTxResponse } from 'xrpl';
import { getXRPLClient, submitBlobQueued } from './xrplHelpers';
import { buildMemo, parseMemo, SCPO_ACTIONS } from './memoHelpers';
import type {
  PayloadYieldOptIn,
  PayloadYieldRoute,
  PayloadYieldReturn,
  PayloadYieldFailed,
} from './memoHelpers';

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — Core Phase 6 Data Types
// ─────────────────────────────────────────────────────────────────────────────

// ── Credential Tiers (extended for Phase 6) ───────────────────────────────────

/**
 * Extended credential tier model.
 * Institutional is the new tier added in Phase 6 for lender/partner wallets.
 * Yield opt-in is available to Verified+ users (Verified or Institutional).
 * PO financing and inventory financing require Verified+ on both sides.
 */
export type CredentialTier = 'basic' | 'verified' | 'institutional';

export const YIELD_REQUIRED_TIER: CredentialTier = 'verified';
export const FINANCE_REQUIRED_TIER: CredentialTier = 'verified';

// ── Yield Position ─────────────────────────────────────────────────────────────

/**
 * YieldPosition — tracks one escrow's participation in the yield pool.
 *
 * Lifecycle:
 *   pending   → created client-side, opt-in memo not yet confirmed
 *   accruing  → principal in pool, yield accumulating
 *   withdrawn → principal + yield returned, claim executed
 *   failed    → partner failed to return funds (requires manual resolution)
 */
export interface YieldPosition {
  /** UUID generated at opt-in time. Used as the primary reference in memos. */
  positionId: string;

  /** PO issuanceId this position is attached to */
  poIssuanceId: string;

  /** XRPL escrow sequence number */
  escrowSequence: number;

  /** Buyer wallet address (capital owner — receives net yield) */
  buyerAddress: string;

  /** Vendor wallet address (escrow destination) */
  vendorAddress: string;

  /** Principal amount in RLUSD (string for precision) */
  principalAmount: string;

  /** APR locked at opt-in time (e.g. 0.045 = 4.5%) */
  lockedAPR: number;

  /** Partner ID — references an entry in YIELD_PARTNER_REGISTRY */
  partnerId: string;

  /** On-chain tx hash of the opt-in memo (written on EscrowCreate) */
  optInTxHash: string;

  /** Unix seconds timestamp of opt-in confirmation */
  optInTimestamp: number;

  /** Estimated claim date (Unix seconds, derived from payment terms at opt-in) */
  estimatedClaimDate?: number;

  /** 'pending' before opt-in confirmed; 'accruing' once routed; etc. */
  status: 'pending' | 'accruing' | 'withdrawn' | 'failed';

  // ── Populated at withdrawal ──

  /** Gross yield generated (before fees) */
  grossYieldAtClaim?: string;

  /** SC.PO platform fee taken from yield */
  scFeeAtClaim?: string;

  /** Partner fee taken from yield */
  partnerFeeAtClaim?: string;

  /** Net yield credited to buyer (gross - scFee - partnerFee) */
  netYieldToBuyer?: string;

  /** Withdrawal/YIELD_RETURN tx hash */
  withdrawTxHash?: string;

  /** Unix seconds when withdrawal completed */
  withdrawTimestamp?: number;
}

// ── Yield Summary (for buyer dashboard) ───────────────────────────────────────

export interface YieldSummary {
  /** Total RLUSD principal currently in the yield pool across all active positions */
  totalPrincipalAccruing: string;

  /** Number of POs with active (accruing) yield positions */
  activePOCount: number;

  /** Total gross yield accrued so far on active positions (calculated, not confirmed) */
  totalAccruedActiveEstimate: string;

  /** Total net yield received by buyer this calendar year (confirmed withdrawals) */
  totalNetReceivedThisYear: string;

  /** Total gross yield generated on all completed positions this year */
  totalGrossThisYear: string;

  /** Total fees paid (SC.PO + partner) this year */
  totalFeesThisYear: string;

  /** Effective APY across all opted-in escrows this year */
  averageAPY: number;

  /** All positions — active and completed */
  positions: YieldPosition[];
}

// ── Financing Request (Phase 6B) ───────────────────────────────────────────────

/**
 * FinancingRequest — tracks one vendor's advance request against a funded PO.
 *
 * Lifecycle: draft → pending_lender → approved → disbursed → repaid | defaulted
 */
export interface FinancingRequest {
  /** UUID generated at request time */
  requestId: string;

  /** 'po_advance' for 6B; 'inventory_line' for 6C */
  type: 'po_advance' | 'inventory_line';

  /** Vendor wallet address (borrower) */
  vendorAddress: string;

  /** Lender wallet address in the Permissioned Domain */
  lenderAddress: string;

  /** PO issuanceId being financed (6B only) */
  poIssuanceId?: string;

  /** NFTokenIDs pledged as collateral (6C only) */
  collateralNFTIds?: string[];

  /** Advance amount requested (RLUSD) */
  requestedAmount: string;

  /** Advance rate (e.g. 0.80 = 80% of PO value) */
  advanceRate: number;

  /** IPFS CID of the financing terms document */
  termsCID: string;

  /** Current lifecycle status */
  status: 'draft' | 'pending_lender' | 'approved' | 'denied' | 'disbursed' | 'repaid' | 'defaulted';

  /** On-chain tx hash of FINANCE_REQUEST memo */
  requestTxHash: string;

  /** Unix seconds of request submission */
  requestTimestamp: number;

  // ── Populated after lender decision ──

  /** Agreed APR (set on approval) */
  approvedAPR?: number;

  /** Actual advance amount approved (may differ from requested) */
  approvedAmount?: string;

  /** Repayment due date (Unix seconds) */
  repayBy?: number;

  /** Denial reason code */
  denialReason?: string;

  /** Disbursement tx hash */
  disbursementTxHash?: string;

  /** Unix seconds when advance was sent to vendor */
  disbursementTimestamp?: number;
}

// ── Collateral Pledge (Phase 6C) ───────────────────────────────────────────────

/**
 * CollateralPledge — tracks vendor's inventory NFTs pledged for a credit line.
 *
 * Soft lock: enforced by the app checking for active COLLATERAL_PLEDGE memos
 * before any operation that would modify/transfer/burn the pledged NFTs.
 * Not a protocol-level lock — cannot be bypassed via the app.
 *
 * Lifecycle: active → released | defaulted
 */
export interface CollateralPledge {
  /** UUID generated at pledge time */
  pledgeId: string;

  /** Vendor wallet address (borrower) */
  vendorAddress: string;

  /** Lender wallet address */
  lenderAddress: string;

  /** NFTokenIDs soft-locked as collateral */
  nftIds: string[];

  /** Total RLUSD valuation at pledge time (from NFT pricing metadata) */
  totalValuation: string;

  /** Loan-to-value haircut (e.g. 0.65 = lend 65% of value) */
  haircut: number;

  /** Approved credit line amount (totalValuation × haircut) */
  creditLineAmount: string;

  /** Current outstanding balance drawn on the credit line */
  drawnAmount: string;

  /** IPFS CID of the financing terms document */
  termsCID: string;

  /** On-chain tx hash of COLLATERAL_PLEDGE memo */
  pledgeTxHash: string;

  /** Unix seconds of pledge */
  pledgeTimestamp: number;

  /** Current status */
  status: 'active' | 'released' | 'defaulted';

  /** Release tx hash (set on full repayment) */
  releaseTxHash?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — YieldPartnerAdapter Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YieldPartnerAdapter — the plug-in contract every yield partner must implement.
 *
 * DESIGN PRINCIPLES:
 * - All monetary values are strings to avoid floating-point precision issues
 * - All async methods return { success, error? } shaped results for clean error handling
 * - Partners are identified by a stable partnerId string (never changes after registration)
 * - The adapter is stateless — all state lives in YieldPosition objects on-chain
 *
 * TO ADD A REAL PARTNER:
 *   1. Create a new file: src/utils/partners/<partnerName>Adapter.ts
 *   2. Implement YieldPartnerAdapter
 *   3. Add an instance to YIELD_PARTNER_REGISTRY below
 *   4. No other changes needed
 */
export interface YieldPartnerAdapter {
  /** Stable unique identifier (e.g. 'stub_v1', 'partner_acme_v1') */
  readonly partnerId: string;

  /** Human-readable display name shown in UI */
  readonly partnerName: string;

  /** Short description of the partner / product */
  readonly partnerDescription: string;

  /** XRPL wallet address of the partner's pool — principal is sent here */
  readonly partnerPoolWallet: string;

  /**
   * Fetch the current APR offered by this partner.
   * Called at opt-in time to lock the rate into the YieldPosition.
   * @returns APR as a decimal (e.g. 0.045 = 4.5%)
   */
  getCurrentAPR(): Promise<{ apr: number; error?: string }>;

  /**
   * Send principal to the partner pool.
   * Called immediately after EscrowCreate is confirmed.
   *
   * @param amount     - RLUSD amount string (e.g. '1000.00')
   * @param positionId - YieldPosition UUID (used as memo reference)
   * @param wallet     - SC.PO company wallet (signs the payment)
   * @returns txHash of the payment on success
   */
  depositPrincipal(
    amount: string,
    positionId: string,
    wallet: xrpl.Wallet
  ): Promise<{ success: boolean; txHash?: string; error?: string }>;

  /**
   * Request return of principal + accrued yield before escrow claim.
   * Called when vendor initiates claim, before EscrowFinish executes.
   *
   * @param amount     - Original principal amount
   * @param positionId - YieldPosition UUID
   * @param wallet     - SC.PO company wallet (receives the return payment)
   * @returns principal and grossYield amounts, plus txHash
   */
  withdrawPrincipal(
    amount: string,
    positionId: string,
    wallet: xrpl.Wallet
  ): Promise<{
    success: boolean;
    principal?: string;
    grossYield?: string;
    txHash?: string;
    error?: string;
  }>;

  /**
   * Calculate accrued yield for display purposes (does NOT withdraw).
   * Used for the "yield accruing" live display in the buyer dashboard.
   *
   * @param principal   - RLUSD principal string
   * @param apr         - Locked APR decimal
   * @param daysElapsed - Days since opt-in
   * @returns Estimated accrued yield as RLUSD string
   */
  calculateAccrued(
    principal: string,
    apr: number,
    daysElapsed: number
  ): string;

  /**
   * Fee structure for this partner.
   * Both values are fractions (e.g. 0.10 = 10% of gross yield).
   * SC.PO fee and partner fee together must be < 1.0.
   */
  readonly feeStructure: {
    /** Partner's fee fraction of gross yield */
    partnerFeeFraction: number;
    /** SC.PO platform fee fraction of gross yield */
    scpoFeeFraction: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3 — Stub Yield Partner (devnet mock)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * StubYieldPartner — devnet implementation of YieldPartnerAdapter.
 *
 * Behavior:
 * - getCurrentAPR() returns a fixed 4.5% APR
 * - depositPrincipal() sends a 1-drop payment to itself as a simulated deposit
 *   (devnet only — no actual RLUSD movement to external pool)
 * - withdrawPrincipal() simulates yield calculation and returns a mock response
 * - Used to build and test the full yield UI/UX before a real partner exists
 *
 * REPLACE THIS with a real partner adapter before mainnet launch.
 */
export class StubYieldPartner implements YieldPartnerAdapter {
  readonly partnerId = 'stub_v1';
  readonly partnerName = 'SC.PO Yield (Devnet)';
  readonly partnerDescription = 'Simulated yield pool for development and testing. Not connected to any real yield source.';

  // On devnet, the "pool wallet" is the SC.PO company wallet itself.
  // In production, this would be the partner's dedicated pool address.
  readonly partnerPoolWallet: string;

  readonly feeStructure = {
    partnerFeeFraction: 0.15,  // Partner takes 15% of gross yield
    scpoFeeFraction:    0.10,  // SC.PO takes 10% of gross yield
    // Buyer receives 75% of gross yield net
  };

  private readonly fixedAPR = 0.045; // 4.5% APR

  constructor(companyWallet: string) {
    this.partnerPoolWallet = companyWallet;
  }

  async getCurrentAPR(): Promise<{ apr: number; error?: string }> {
    // Real partner: fetch from their API or on-chain oracle
    // Stub: return fixed rate
    return { apr: this.fixedAPR };
  }

  async depositPrincipal(
    amount: string,
    positionId: string,
    wallet: xrpl.Wallet
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    // STUB BEHAVIOR (devnet):
    // Send a 1-drop payment to company wallet as a "receipt" of the simulated deposit.
    // The actual RLUSD stays in the buyer's escrow on-chain (non-custodial simulation).
    // Real partner: send actual RLUSD to partner pool wallet via Payment transaction.
    try {
      const client = await getXRPLClient();
      const payment: any = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: this.partnerPoolWallet,
        Amount: '1', // 1 drop — just a receipt
        Memos: [buildMemo(SCPO_ACTIONS.YIELD_ROUTE, positionId, {
          posId: positionId,
          amt: amount,
          toAddr: this.partnerPoolWallet,
          txRef: 'stub_deposit',
        } as any)]
      };
      const prepared = await client.autofill(payment);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const result = await submitBlobQueued(signed.tx_blob);
      const meta = result.result.meta as any;
      if (meta?.TransactionResult !== 'tesSUCCESS') {
        return { success: false, error: meta?.TransactionResult || 'unknown' };
      }
      console.log(`[StubYieldPartner] Simulated deposit of ${amount} RLUSD for position ${positionId}`);
      return { success: true, txHash: result.result.hash };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async withdrawPrincipal(
    amount: string,
    positionId: string,
    wallet: xrpl.Wallet
  ): Promise<{
    success: boolean;
    principal?: string;
    grossYield?: string;
    txHash?: string;
    error?: string;
  }> {
    // STUB BEHAVIOR:
    // Simulate a yield calculation without any actual fund movement.
    // Real partner: call their withdrawal API or submit on-chain withdrawal request.
    // The partner would then send principal + yield back to SC.PO company wallet,
    // which distributes it: partnerFee to partner, scFee to company wallet, net to buyer.
    // ⚠️ PRODUCTION REPLACEMENT REQUIRED:
    // A real partner adapter must implement this method to:
    //   1. Call the partner's withdrawal API or submit an on-chain redemption request
    //   2. Receive principal + gross yield back into REACT_APP_COMPANY_WALLET
    //   3. Return the txHash of the partner's payment transaction
    // The YIELD_RETURN memo and fee distribution are handled by claimEscrowForPO
    // after this method returns — no memo writing needed here.
    //
    // STUB: returns simulated success with zero yield.
    // No transaction is submitted because the stub pool wallet === company wallet,
    // which would cause temREDUNDANT. Real partners use a separate pool wallet.
    console.log(`[StubYieldPartner] ⚠️ STUB withdrawal — no funds moved. Position: ${positionId}, amount: ${amount}`);
    console.log(`[StubYieldPartner] Replace StubYieldPartner with a real YieldPartnerAdapter before mainnet.`);
    return {
      success: true,
      principal: amount,
      grossYield: '0.00',
      txHash: undefined, // no tx — stub only
    };
  }

  calculateAccrued(principal: string, apr: number, daysElapsed: number): string {
    // Simple time-weighted yield: principal × APR × (days / 365)
    const p = parseFloat(principal);
    if (isNaN(p) || p <= 0 || daysElapsed <= 0) return '0.00';
    const accrued = p * apr * (daysElapsed / 365);
    return accrued.toFixed(6);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4 — Partner Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YIELD_PARTNER_REGISTRY — the single source of truth for available partners.
 *
 * ADD A REAL PARTNER:
 *   import { AcmePartnerAdapter } from './partners/acmeAdapter';
 *   registry.set('partner_acme_v1', new AcmePartnerAdapter());
 *
 * The partnerId key must match YieldPartnerAdapter.partnerId.
 * Partners are selected by the buyer at opt-in time.
 */
export const buildYieldPartnerRegistry = (
  companyWallet: string
): Map<string, YieldPartnerAdapter> => {
  const registry = new Map<string, YieldPartnerAdapter>();
  registry.set('stub_v1', new StubYieldPartner(companyWallet));
  // Future: registry.set('partner_acme_v1', new AcmePartnerAdapter());
  return registry;
};

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — Yield Fee Calculator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the three-way yield distribution from a gross yield amount.
 * All inputs and outputs are RLUSD strings.
 *
 * @param grossYield   - Total yield generated by the partner (RLUSD string)
 * @param adapter      - The partner adapter (provides fee fractions)
 * @returns { partnerFee, scpoFee, netToBuyer } all as RLUSD strings
 */
export const computeYieldDistribution = (
  grossYield: string,
  adapter: YieldPartnerAdapter
): { partnerFee: string; scpoFee: string; netToBuyer: string } => {
  const gross = parseFloat(grossYield);
  if (isNaN(gross) || gross <= 0) {
    return { partnerFee: '0.00', scpoFee: '0.00', netToBuyer: '0.00' };
  }
  const partnerFee = gross * adapter.feeStructure.partnerFeeFraction;
  const scpoFee    = gross * adapter.feeStructure.scpoFeeFraction;
  const netToBuyer = gross - partnerFee - scpoFee;

  return {
    partnerFee: partnerFee.toFixed(6),
    scpoFee:    scpoFee.toFixed(6),
    netToBuyer: Math.max(0, netToBuyer).toFixed(6),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 6 — Yield Computation Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * computeAccruedYield — calculate yield accrued on a position up to now.
 * Used for live dashboard display. Does NOT trigger a withdrawal.
 *
 * @param position - The YieldPosition to calculate for
 * @param adapter  - The partner adapter (for calculateAccrued method)
 * @returns Estimated accrued RLUSD string
 */
export const computeAccruedYield = (
  position: YieldPosition,
  adapter: YieldPartnerAdapter
): string => {
  if (position.status !== 'accruing') return '0.00';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const daysElapsed = (nowSeconds - position.optInTimestamp) / 86400;
  return adapter.calculateAccrued(position.principalAmount, position.lockedAPR, daysElapsed);
};

/**
 * computeYieldSummary — aggregate all positions into a YieldSummary for the dashboard.
 *
 * @param positions - All YieldPositions for the current buyer wallet
 * @param registry  - The partner registry to look up adapters
 * @returns YieldSummary object ready for the dashboard UI
 */
export const computeYieldSummary = (
  positions: YieldPosition[],
  registry: Map<string, YieldPartnerAdapter>
): YieldSummary => {
  const currentYear = new Date().getFullYear();
  const yearStart = new Date(`${currentYear}-01-01`).getTime() / 1000;

  let totalPrincipalAccruing = 0;
  let activePOCount = 0;
  let totalAccruedActiveEstimate = 0;
  let totalNetReceivedThisYear = 0;
  let totalGrossThisYear = 0;
  let totalFeesThisYear = 0;
  let totalWeightedAPY = 0;
  let totalPrincipalForAPY = 0;

  for (const pos of positions) {
    const adapter = registry.get(pos.partnerId);
    if (!adapter) continue;

    if (pos.status === 'accruing') {
      const principal = parseFloat(pos.principalAmount);
      totalPrincipalAccruing += principal;
      activePOCount++;

      const accrued = parseFloat(computeAccruedYield(pos, adapter));
      totalAccruedActiveEstimate += accrued;

      // Weight APY by principal size
      totalWeightedAPY += pos.lockedAPR * principal;
      totalPrincipalForAPY += principal;
    }

    if (pos.status === 'withdrawn' && pos.withdrawTimestamp && pos.withdrawTimestamp >= yearStart) {
      totalNetReceivedThisYear += parseFloat(pos.netYieldToBuyer || '0');
      totalGrossThisYear += parseFloat(pos.grossYieldAtClaim || '0');
      totalFeesThisYear += parseFloat(pos.scFeeAtClaim || '0') + parseFloat(pos.partnerFeeAtClaim || '0');

      // Include completed positions in APY calculation
      const principal = parseFloat(pos.principalAmount);
      totalWeightedAPY += pos.lockedAPR * principal;
      totalPrincipalForAPY += principal;
    }
  }

  const averageAPY = totalPrincipalForAPY > 0
    ? totalWeightedAPY / totalPrincipalForAPY
    : 0;

  return {
    totalPrincipalAccruing:        totalPrincipalAccruing.toFixed(2),
    activePOCount,
    totalAccruedActiveEstimate:    totalAccruedActiveEstimate.toFixed(6),
    totalNetReceivedThisYear:      totalNetReceivedThisYear.toFixed(6),
    totalGrossThisYear:            totalGrossThisYear.toFixed(6),
    totalFeesThisYear:             totalFeesThisYear.toFixed(6),
    averageAPY,
    positions,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 7 — On-Chain Scanners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scanYieldPositions — scan a wallet's transaction history for YIELD_OPT_IN memos.
 * Returns all YieldPositions associated with the wallet (as buyer).
 *
 * NOTE: This builds positions from opt-in memos only. For full position state
 * (accruing vs withdrawn), it also looks for YIELD_RETURN and YIELD_FAILED memos.
 *
 * @param buyerAddress - The buyer wallet to scan
 * @returns Array of YieldPosition objects sorted newest first
 */
// Ripple epoch offset — defined here so scanYieldPositions can use it
const RIPPLE_EPOCH = 946684800;
export const convertRippleTime = (rippleTime: number): number =>
  rippleTime + RIPPLE_EPOCH;

export const scanYieldPositions = async (
  buyerAddress: string
): Promise<YieldPosition[]> => {
  const positions: Map<string, YieldPosition> = new Map();

  try {
    const client = await getXRPLClient();
    let marker: any = undefined;
    let hasMore = true;

    while (hasMore) {
      const response: AccountTxResponse = await client.request({
        command: 'account_tx',
        account: buyerAddress,
        limit: 400,
        marker,
      });

      for (const txEntry of response.result.transactions) {
        const tx = txEntry.tx_json as any;
        if (!tx?.Memos?.length) continue;

        for (const memoWrapper of tx.Memos) {
          const memo = parseMemo(memoWrapper.Memo);
          if (!memo) continue;

          const action = memo.a as string;
          const ref = memo.r as string;
          const payload = memo.p as any;

          if (action === SCPO_ACTIONS.YIELD_OPT_IN) {
            const posId: string = payload.posId;
            if (!positions.has(posId)) {
              positions.set(posId, {
                positionId:         posId,
                poIssuanceId:       ref,
                escrowSequence:     tx.Sequence || 0,
                buyerAddress,
                vendorAddress:      tx.Destination || '',
                principalAmount:    payload.amt || '0',
                lockedAPR:          payload.apr || 0,
                partnerId:          payload.pid || 'stub_v1',
                optInTxHash:        (txEntry as any).hash || tx.hash || '',
                optInTimestamp:     tx.date ? convertRippleTime(tx.date) : Math.floor(Date.now() / 1000),
                estimatedClaimDate: payload.est || undefined,
                status:             'accruing',
              });
            }
          }

          if (action === SCPO_ACTIONS.YIELD_RETURN) {
            const posId: string = payload.posId;
            const existing = positions.get(posId);
            if (existing) {
              positions.set(posId, {
                ...existing,
                status:            'withdrawn',
                grossYieldAtClaim: payload.gross,
                scFeeAtClaim:      payload.scFee,
                partnerFeeAtClaim: payload.partFee,
                netYieldToBuyer:   payload.net,
                withdrawTxHash:    (txEntry as any).hash || tx.hash || '',
                withdrawTimestamp: convertRippleTime(tx.date || 0),
              });
            }
          }

          if (action === SCPO_ACTIONS.YIELD_FAILED) {
            const posId: string = payload.posId;
            const existing = positions.get(posId);
            if (existing) {
              positions.set(posId, { ...existing, status: 'failed' });
            }
          }
        }
      }

      marker = response.result.marker;
      hasMore = !!marker;
    }
  } catch (err) {
    console.error('[scanYieldPositions] scan failed:', err);
  }

  // Deduplicate by poIssuanceId — keep the earliest position per PO
  const deduped = new Map<string, YieldPosition>();
  Array.from(positions.values()).forEach(pos => {
    const existing = deduped.get(pos.poIssuanceId);
    if (!existing || pos.optInTimestamp < existing.optInTimestamp) {
      deduped.set(pos.poIssuanceId, pos);
    }
  });

  return Array.from(deduped.values()).sort(
    (a, b) => b.optInTimestamp - a.optInTimestamp
  );
};

/**
 * getActiveYieldPosition — check if a specific PO issuanceId has an active
 * yield position. Returns the position if accruing, null otherwise.
 *
 * Used by claimEscrowForPO to detect whether to trigger yield withdrawal
 * before executing EscrowFinish.
 *
 * @param buyerAddress - Buyer wallet to scan
 * @param poIssuanceId - PO to check
 */
export const getActiveYieldPosition = async (
  buyerAddress: string,
  poIssuanceId: string
): Promise<YieldPosition | null> => {
  const positions = await scanYieldPositions(buyerAddress);
  return positions.find(
    p => p.poIssuanceId === poIssuanceId && p.status === 'accruing'
  ) || null;
};

/**
 * scanCollateralPledges — scan for active soft-locked collateral pledges.
 * Used to gate operations on pledged NFTs.
 *
 * @param vendorAddress - Vendor wallet to scan
 * @returns Map of nftId → pledgeId for all currently active pledges
 */
export const scanCollateralPledges = async (
  vendorAddress: string
): Promise<Map<string, string>> => {
  // nftId → pledgeId mapping (only active pledges)
  const activePledges: Map<string, string> = new Map();
  // pledgeId → released (to filter out released pledges)
  const releasedPledges: Set<string> = new Set();

  try {
    const client = await getXRPLClient();
    let marker: any = undefined;

    do {
      const response: AccountTxResponse = await client.request({
        command: 'account_tx',
        account: vendorAddress,
        limit: 400,
        marker,
      });

      for (const txEntry of response.result.transactions) {
        const tx = txEntry.tx_json as any;
        if (!tx?.Memos?.length) continue;

        for (const memoWrapper of tx.Memos) {
          const memo = parseMemo(memoWrapper.Memo);
          if (!memo) continue;

          if (memo.a === SCPO_ACTIONS.COLLATERAL_PLEDGE) {
            const p = memo.p as any;
            const pledgeId = p.pledgeId;
            if (!releasedPledges.has(pledgeId) && Array.isArray(p.nfts)) {
              for (const nftId of p.nfts) {
                activePledges.set(nftId, pledgeId);
              }
            }
          }

          if (memo.a === SCPO_ACTIONS.COLLATERAL_RELEASE || memo.a === SCPO_ACTIONS.COLLATERAL_DEFAULT) {
            const p = memo.p as any;
            const pledgeId = p.pledgeId;
            releasedPledges.add(pledgeId);
            // Remove any nfts from this pledge from activePledges
            Array.from(activePledges.entries()).forEach(([nftId, pid]) => {
              if (pid === pledgeId) activePledges.delete(nftId);
            });
          }
        }
      }

      marker = response.result.marker;
    } while (marker);
  } catch (err) {
    console.error('[scanCollateralPledges] scan failed:', err);
  }

  return activePledges;
};

/**
 * isNFTPledged — quick check whether a specific NFT is currently soft-locked.
 * Use this before any NFT burn, transfer, or status-update operation.
 *
 * @param vendorAddress - Vendor wallet to scan
 * @param nftId         - NFTokenID to check
 * @returns pledgeId string if pledged, null if free
 */
export const isNFTPledged = async (
  vendorAddress: string,
  nftId: string
): Promise<string | null> => {
  const pledges = await scanCollateralPledges(vendorAddress);
  return pledges.get(nftId) || null;
};

// ─────────────────────────────────────────────────────────────────────────────
// § 8 — Updated claimEscrowForPO routing logic (drop-in replacement logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * checkPreClaimConditions — run before EscrowFinish in claimEscrowForPO.
 *
 * Checks for:
 *   1. Active YieldPosition on this PO → must withdraw yield before claiming
 *   2. Active FinancingRequest on this PO (Phase 6B) → repayment routing needed
 *
 * Returns a routing decision object:
 *   { hasYield, yieldPosition, hasFinancing, financingRequest }
 *
 * The claim function should:
 *   - If hasYield: call adapter.withdrawPrincipal() FIRST, write YIELD_RETURN memo,
 *     then proceed with EscrowFinish
 *   - If hasFinancing: split escrow proceeds — repay lender first (Phase 6B)
 *   - If neither: proceed with existing direct claim flow (no changes)
 */
export const checkPreClaimConditions = async (
  buyerAddress: string,
  poIssuanceId: string
): Promise<{
  hasYield: boolean;
  yieldPosition: YieldPosition | null;
  hasFinancing: boolean;
  // financingRequest will be added in Phase 6B implementation
}> => {
  // Check for active yield position
  const yieldPosition = await getActiveYieldPosition(buyerAddress, poIssuanceId);

  return {
    hasYield:       yieldPosition !== null,
    yieldPosition,
    hasFinancing:   false, // Phase 6B: scan for FINANCE_APPROVED memos on this PO
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 9 — Institutional Credential Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SCPO_INSTITUTIONAL_HEX — hex encoding of "SCPO_INST" credential type string.
 * Used to issue Institutional-tier credentials to lender/partner wallets.
 *
 * This is the Phase 6.0b deliverable: a new credential tier above Verified,
 * reserved for licensed lenders and yield partners registered in the domain.
 *
 * Issuance flow (admin only):
 *   1. Admin verifies the lender/partner identity off-platform
 *   2. Admin calls issueCredential(client, platformWallet, lenderAddress, SCPO_INSTITUTIONAL_HEX)
 *   3. Lender calls acceptCredential(client, lenderWallet, platformAddress, SCPO_INSTITUTIONAL_HEX)
 *   4. Permissioned Domain is updated to also accept SCPO_INSTITUTIONAL_HEX credentials
 *
 * The domain update (step 4) adds SCPO_INSTITUTIONAL_HEX to the AcceptedCredentials array
 * on the PermissionedDomainSet transaction. This is a one-time config change.
 *
 * Gating in Phase 6:
 *   - Yield opt-in: requires buyer to have Verified or Institutional credential
 *   - Lender review dashboard access: requires Institutional credential on lender wallet
 *   - PO advance requests: require vendor to have Verified or Institutional credential
 */
export const SCPO_INSTITUTIONAL_CREDENTIAL_TYPE = 'SCPO_INST'; // short form for on-chain efficiency

/**
 * canOptInToYield — check if a buyer wallet is eligible to opt into yield.
 * Requires Verified or Institutional credential.
 *
 * @param credentialTier - The buyer's current credential tier
 * @returns { allowed, reason }
 */
export const canOptInToYield = (
  credentialTier: string | undefined
): { allowed: boolean; reason?: string } => {
  if (!credentialTier) {
    return { allowed: false, reason: 'No credential found. Complete your profile to get credentialed.' };
  }
  if (credentialTier === 'basic') {
    return {
      allowed: false,
      reason: 'Yield opt-in requires a Verified credential. Upgrade your account to access this feature.',
    };
  }
  // 'verified' or 'institutional' — allowed
  return { allowed: true };
};

/**
 * canRequestFinancing — check if a vendor wallet is eligible to request PO financing.
 * Requires Verified or Institutional credential.
 *
 * @param credentialTier - The vendor's current credential tier
 * @returns { allowed, reason }
 */
export const canRequestFinancing = (
  credentialTier: string | undefined
): { allowed: boolean; reason?: string } => {
  if (!credentialTier) {
    return { allowed: false, reason: 'No credential found. Complete your profile to get credentialed.' };
  }
  if (credentialTier === 'basic') {
    return {
      allowed: false,
      reason: 'PO financing requires a Verified credential. Upgrade your account to access this feature.',
    };
  }
  return { allowed: true };
};

// ─────────────────────────────────────────────────────────────────────────────
// § 10 — Utility Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format RLUSD amount string for display (2 decimal places) */
export const formatRLUSD = (amount: string): string => {
  const n = parseFloat(amount);
  if (isNaN(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Format APR decimal as percentage string (e.g. 0.045 → "4.50%") */
export const formatAPR = (apr: number): string =>
  `${(apr * 100).toFixed(2)}%`;

/** Format days elapsed from Unix seconds timestamp */
export const daysElapsed = (fromTimestamp: number): number => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.max(0, (nowSeconds - fromTimestamp) / 86400);
};

// AccountTxResponse is imported from xrpl at the top of this file.
// Import it directly in App.tsx from 'xrpl' if needed there.
