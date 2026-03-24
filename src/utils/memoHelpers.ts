import * as xrpl from 'xrpl';

// ─────────────────────────────────────────────────────────────────────────────
// SC.PO Memo Schema — v1
// ─────────────────────────────────────────────────────────────────────────────

export const SCPO_ACTIONS = {
  // PO lifecycle
  CREATE_PO:    'CREATE_PO',
  UPDATE_PO:    'UPDATE_PO',
  ACCEPT_PO:    'ACCEPT_PO',
  FUND_ESCROW:  'FUND_ESCROW',
  CLAIM_PO:     'CLAIM_PO',
  RECALL_PO:    'RECALL_PO',

  // Inventory
  MINT_INV:          'MINT_INV',
  RECEIVE_INV:       'RECEIVE_INV',
  BURN_INV:          'BURN_INV',
  UPDATE_INV_STATUS: 'UPDATE_INV_STATUS',

  // Identity / linking
  LINK_PROFILE:   'LINK_PROFILE',
  UNLINK_PROFILE: 'UNLINK_PROFILE',

  // Platform
  FEE_PAYMENT:  'FEE_PAYMENT',

  // ── Phase 6A: Escrow Yield ──────────────────────────────────────────────────
  YIELD_OPT_IN:   'YIELD_OPT_IN',
  YIELD_ROUTE:    'YIELD_ROUTE',
  YIELD_RETURN:   'YIELD_RETURN',
  YIELD_FAILED:   'YIELD_FAILED',

  // ── Phase 6B: PO Financing ──────────────────────────────────────────────────
  FINANCE_REQUEST:   'FINANCE_REQUEST',
  FINANCE_APPROVED:  'FINANCE_APPROVED',
  FINANCE_DENIED:    'FINANCE_DENIED',
  FINANCE_DISBURSED: 'FINANCE_DISBURSED',
  FINANCE_REPAID:    'FINANCE_REPAID',
  FINANCE_DEFAULT:   'FINANCE_DEFAULT',

  // ── Phase 6C: Inventory Financing ──────────────────────────────────────────
  COLLATERAL_PLEDGE:        'COLLATERAL_PLEDGE',
  COLLATERAL_DRAW:          'COLLATERAL_DRAW',
  COLLATERAL_REPAY:         'COLLATERAL_REPAY',
  COLLATERAL_RELEASE:       'COLLATERAL_RELEASE',
  COLLATERAL_DEFAULT:       'COLLATERAL_DEFAULT',
  COLLATERAL_MARGIN_NOTICE: 'COLLATERAL_MARGIN_NOTICE',
} as const;

export type ScpoAction = typeof SCPO_ACTIONS[keyof typeof SCPO_ACTIONS];

// ── Existing Payload Types (unchanged) ───────────────────────────────────────
export interface PayloadCreatePO        { poName: string; total: string; currency: 'XRP' | 'RLUSD'; vendorAddr: string; }
export interface PayloadUpdatePO        { oldRef: string; poName: string; }
export interface PayloadAcceptPO        { }
export interface PayloadFundEscrow      { poName: string; amount: string; currency: 'XRP' | 'RLUSD'; terms: string; escrowSeq?: number; ipfs: string; itemCount: number; }
export interface PayloadClaimPO         { escrowTx: string; }
export interface PayloadRecallPO        { reason?: string; }
export interface PayloadMintInv         { pn: string; initialQty: number; }
export interface PayloadReceiveInv      { mptId: string; pn: string; qty: number; lot: string; }
export interface PayloadBurnInv         { mptId: string; }
export interface PayloadUpdateInvStatus { status: string; }
export interface PayloadLinkProfile     { linkedAddr: string; role: 'vendor' | 'customer'; profileUUID: string; ipfsUri: string; }
export interface PayloadFeePayment      { poName: string; feeType: 'CREATE'; amount: string; }

// ── Phase 6A Payload Types ────────────────────────────────────────────────────
export interface PayloadYieldOptIn {
  posId: string;   // YieldPosition UUID
  pid:   string;   // partnerId
  apr:   number;   // locked APR decimal (e.g. 0.045 = 4.5%)
  est?:  number;   // estimated claim Unix seconds
}
export interface PayloadYieldRoute {
  posId:  string;
  amt:    string;
  toAddr: string;
  txRef:  string;
}
export interface PayloadYieldReturn {
  posId:     string;
  principal: string;
  gross:     string;
  scFee:     string;
  partFee:   string;
  net:       string;
  claimTx?:  string;
}
export interface PayloadYieldFailed {
  posId:  string;
  reason: string;
}

// ── Phase 6B Payload Types ────────────────────────────────────────────────────
export interface PayloadFinanceRequest {
  poRef:    string;
  amt:      string;
  advRate:  number;
  lender:   string;
  termsCID: string;
}
export interface PayloadFinanceApproved {
  reqId:   string;
  apr:     number;
  advAmt:  string;
  repayBy: number;
}
export interface PayloadFinanceDenied    { reqId: string; reason: string; }
export interface PayloadFinanceDisbursed { reqId: string; txRef: string; amt: string; }
export interface PayloadFinanceRepaid    { reqId: string; lenderTx: string; scTx: string; netTx: string; }
export interface PayloadFinanceDefault   { reqId: string; escrowSeq: number; }

// ── Phase 6C Payload Types ────────────────────────────────────────────────────
export interface PayloadCollateralPledge {
  pledgeId:  string;
  nfts:      string[];
  valuation: string;
  haircut:   number;
  lineAmt:   string;
  lender:    string;
  termsCID:  string;
}
export interface PayloadCollateralDraw   { pledgeId: string; drawAmt: string; newBal: string; txRef: string; }
export interface PayloadCollateralRepay  { pledgeId: string; repayAmt: string; intAmt: string; newBal: string; txRef: string; }
export interface PayloadCollateralRelease { pledgeId: string; nfts: string[]; }
export interface PayloadCollateralDefault { pledgeId: string; nfts: string[]; }
export interface PayloadCollateralMarginNotice {
  pledgeId: string;
  curVal:   string;
  minVal:   string;
  action:   'reduce_line' | 'add_collateral';
}

// ── Envelope Type ─────────────────────────────────────────────────────────────
interface MemoEnvelope<P = Record<string, unknown>> {
  a: ScpoAction;
  r: string;
  v: 1;
  p: P;
}

// ── Builder ───────────────────────────────────────────────────────────────────
export const buildMemo = <P extends Record<string, unknown>>(
  action: ScpoAction,
  ref: string,
  payload: P
): { Memo: { MemoType: string; MemoFormat: string; MemoData: string } } => {
  const envelope: MemoEnvelope<P> = { a: action, r: ref, v: 1, p: payload };
  const json = JSON.stringify(envelope);
  if (process.env.NODE_ENV !== 'production' && json.length > 900) {
    console.warn(`[buildMemo] Memo payload approaching 1KB limit (${json.length} chars) for action: ${action}`);
  }
  return {
    Memo: {
      MemoType:   xrpl.convertStringToHex('SCPO'),
      MemoFormat: xrpl.convertStringToHex('application/json'),
      MemoData:   xrpl.convertStringToHex(json),
    }
  };
};

// ── Parser ────────────────────────────────────────────────────────────────────
export const parseMemo = <P = Record<string, unknown>>(
  memo: { MemoType?: string; MemoFormat?: string; MemoData?: string }
): MemoEnvelope<P> | null => {
  try {
    if (!memo.MemoType || !memo.MemoData) return null;
    const memoType = xrpl.convertHexToString(memo.MemoType);
    if (memoType !== 'SCPO') return null;
    const raw = xrpl.convertHexToString(memo.MemoData);
    const parsed = JSON.parse(raw) as MemoEnvelope<P>;
    if (!parsed.a || !parsed.r || parsed.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
};

// ── Legacy Parsers ────────────────────────────────────────────────────────────
export const parseLegacyRefMemo = (
  memoType: string,
  memoData: string
): string | null => {
  try {
    const type = xrpl.convertHexToString(memoType);
    if (!['SCPO_RECALL', 'SCPO_CLAIM', 'SCPO_ESCROW', 'SCPO_INV_RECV', 'link', 'PO_UPDATE'].includes(type)) return null;
    const data = JSON.parse(xrpl.convertHexToString(memoData));
    return data.mpt || data.nft || null;
  } catch {
    return null;
  }
};

// ── Phase 6 Action Groups (for scanners) ─────────────────────────────────────
export const YIELD_ACTIONS      = new Set([SCPO_ACTIONS.YIELD_OPT_IN, SCPO_ACTIONS.YIELD_ROUTE, SCPO_ACTIONS.YIELD_RETURN, SCPO_ACTIONS.YIELD_FAILED] as const);
export const FINANCE_ACTIONS    = new Set([SCPO_ACTIONS.FINANCE_REQUEST, SCPO_ACTIONS.FINANCE_APPROVED, SCPO_ACTIONS.FINANCE_DENIED, SCPO_ACTIONS.FINANCE_DISBURSED, SCPO_ACTIONS.FINANCE_REPAID, SCPO_ACTIONS.FINANCE_DEFAULT] as const);
export const COLLATERAL_ACTIONS = new Set([SCPO_ACTIONS.COLLATERAL_PLEDGE, SCPO_ACTIONS.COLLATERAL_DRAW, SCPO_ACTIONS.COLLATERAL_REPAY, SCPO_ACTIONS.COLLATERAL_RELEASE, SCPO_ACTIONS.COLLATERAL_DEFAULT, SCPO_ACTIONS.COLLATERAL_MARGIN_NOTICE] as const);