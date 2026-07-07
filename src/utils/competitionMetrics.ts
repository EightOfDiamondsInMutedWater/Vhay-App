// ═════════════════════════════════════════════════════════════════════════════
// COMPETITION_METRICS (Task 5.1 — Make Waves Challenge, T&Cs §8)
// SELF-CONTAINED / REMOVABLE: nothing in the app imports FROM this file except
// the Competition Metrics admin sub-tab. To uninstall after the competition:
//   1. delete this file
//   2. grep App.tsx for "COMPETITION_METRICS" and delete each marked block
//   3. remove 'competitionMetrics' from the adminSubTab union
//
// Approach (Option 2 — company-wallet discovery, memo-inclusive):
//   Pass 1: discover participants from the company wallet's transaction history
//           (anyone who paid a platform fee / transacted with the company).
//   Pass 2: scan each participant's full account_tx (paginated), keep only
//           SourceTag === SOURCE_TAG AND meta.TransactionResult === 'tesSUCCESS',
//           dedupe by txHash.
// Guardrails: tag filter, tesSUCCESS-only, txHash dedupe, volume on escrow LOCK
//   (FUND_ESCROW) not release (no double-count). Off-chain metadata edits are not
//   on-chain events and are intentionally not counted.
// This is a self-computed MIRROR; the official figure is whatever XRPL Commons
//   computes from their Source Tag indexer.
// ═════════════════════════════════════════════════════════════════════════════
import * as xrpl from 'xrpl';
import { getXRPLClient, SOURCE_TAG } from './xrplHelpers';

// PO-lifecycle actions (a ref carrying any of these is a Purchase Order)
const PO_ACTIONS = new Set(['CREATE_PO', 'UPDATE_PO', 'ACCEPT_PO', 'FUND_ESCROW', 'CLAIM_PO', 'RECALL_PO']);
// Inventory actions (a ref carrying any of these is an inventory item)
const INV_ACTIONS = new Set(['MINT_INV', 'RECEIVE_INV', 'BURN_INV', 'UPDATE_INV_STATUS']);
// Phase 6 (paused) — counted if they ever appear, else read 0
const PHASE6_ACTIONS = new Set([
  'YIELD_OPT_IN','YIELD_ROUTE','YIELD_RETURN','YIELD_FAILED',
  'FINANCE_REQUEST','FINANCE_APPROVED','FINANCE_DENIED','FINANCE_DISBURSED','FINANCE_REPAID','FINANCE_DEFAULT',
  'COLLATERAL_PLEDGE','COLLATERAL_DRAW','COLLATERAL_REPAY','COLLATERAL_RELEASE','COLLATERAL_DEFAULT','COLLATERAL_MARGIN_NOTICE',
]);

export interface CompetitionMetrics {
  sourceTag: number;
  generatedAt: string;
  scannedWallets: number;
  totalTransactions: number;
  uniqueAccounts: number;
  accounts: string[];
  totalVolumeUSD: number;
  totalVolumeXRP: number;
  // PO lifecycle
  totalPOs: number;
  settledPOs: number;      // has CLAIM_PO
  inFlightPOs: number;     // funded/accepted, not yet claimed
  // Inventory
  inventoryItems: number;  // distinct inventory refs
  totalUnitsTokenized: number; // COMPETITION_METRICS: cumulative units minted/received (tagged)
  inventoryMints: number;  // MINT_INV count
  inventoryReceives: number;
  inventoryBurns: number;
  // Identity
  profileLinks: number;
  profileUnlinks: number;
  // Breakdowns
  txByType: Record<string, number>;
  actionByType: Record<string, number>;
  phase6ActionCount: number; // total Phase 6 actions (0 while paused)
}

const isIssuanceRef = (ref: string): boolean =>
  // PO/MPT issuance IDs are 48-hex chars; NFT IDs start '0008'; account refs start 'r'
  /^[0-9A-Fa-f]{48}$/.test(ref) && !ref.startsWith('r');

const fetchAllAccountTx = async (client: any, account: string, maxPages = 20): Promise<any[]> => {
  const out: any[] = [];
  let marker: any; let pages = 0;
  do {
    const req: any = { command: 'account_tx', account, ledger_index_min: -1, ledger_index_max: -1, limit: 200 };
    if (marker) req.marker = marker;
    const resp = await client.request(req);
    out.push(...(resp.result?.transactions || []));
    marker = resp.result?.marker; pages += 1;
  } while (marker && pages < maxPages);
  return out;
};

export const computeCompetitionMetrics = async (companyWallet: string): Promise<CompetitionMetrics> => {
  const client = await getXRPLClient();

  // ── Pass 1: discover participants from the company wallet ──
  const participants = new Set<string>();
  if (companyWallet) participants.add(companyWallet);
  if (companyWallet) {
    for (const tx of await fetchAllAccountTx(client, companyWallet)) {
      const t = tx.tx_json || tx.tx || {};
      if (t.Account && t.Account !== companyWallet) participants.add(t.Account);
      if (t.Destination && t.Destination !== companyWallet) participants.add(t.Destination);
    }
  }

  // ── Pass 2: scan each participant, keep tagged + successful, dedupe ──
  const seen = new Set<string>();
  const txByType: Record<string, number> = {};
  const actionByType: Record<string, number> = {};
  const accounts = new Set<string>();
  const refActions: Record<string, Set<string>> = {};
  let totalTransactions = 0, totalVolumeUSD = 0, totalVolumeXRP = 0;
  let inventoryMintCount = 0; // COMPETITION_METRICS: inventory items via SCPO_INV_META memo (MINT_INV action is unused)
  let totalUnitsTokenized = 0; // COMPETITION_METRICS: sum of qty across initial loads (SCPO_INV_RECV) + restocks (RECEIVE_INV)

  for (const addr of Array.from(participants)) {
    let txs: any[] = [];
    try { txs = await fetchAllAccountTx(client, addr); } catch { continue; }
    for (const tx of txs) {
      const t = tx.tx_json || tx.tx || {};
      const meta = tx.meta || tx.metaData || {};
      if (t.SourceTag !== SOURCE_TAG) continue;
      if ((meta.TransactionResult || meta.result) !== 'tesSUCCESS') continue;
      const hash = t.hash || tx.hash || '';
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);

      totalTransactions += 1;
      txByType[t.TransactionType || '?'] = (txByType[t.TransactionType || '?'] || 0) + 1;
      if (t.Account) accounts.add(t.Account);

      for (const mm of (t.Memos || [])) {
        const memo = mm.Memo || {};
        if (!memo.MemoType || !memo.MemoData) continue;
        try {
          const memoTypeStr = xrpl.convertHexToString(memo.MemoType);
          if (memoTypeStr === 'SCPO_INV_META') { inventoryMintCount += 1; continue; } // COMPETITION_METRICS: one inventory SKU minted
          if (memoTypeStr === 'SCPO_INV_RECV') { // COMPETITION_METRICS: initial unit load at mint
            try { const ie = JSON.parse(xrpl.convertHexToString(memo.MemoData)); const q = parseInt(ie && ie.qty, 10); if (!isNaN(q)) totalUnitsTokenized += q; } catch { /* ignore */ }
            continue;
          }
          if (memoTypeStr !== 'SCPO') continue;
          const e = JSON.parse(xrpl.convertHexToString(memo.MemoData));
          if (!e || !e.a) continue;
          actionByType[e.a] = (actionByType[e.a] || 0) + 1;
          if (e.r) (refActions[e.r] ||= new Set()).add(e.a);
          if (e.a === 'FUND_ESCROW' && e.p) {
            const amt = parseFloat(e.p.amount);
            if (!isNaN(amt)) {
              if ((e.p.currency || 'USD').toUpperCase() === 'XRP') totalVolumeXRP += amt;
              else totalVolumeUSD += amt;
            }
          }
          if (e.a === 'RECEIVE_INV' && e.p) { const q = parseInt(e.p.qty, 10); if (!isNaN(q)) totalUnitsTokenized += q; } // COMPETITION_METRICS: restock units
        } catch { /* ignore malformed memo */ }
      }
    }
  }

  // ── Classify refs into POs vs inventory ──
  let totalPOs = 0, settledPOs = 0, inFlightPOs = 0;
  for (const ref in refActions) {
    const acts = refActions[ref];
    const hasPO = Array.from(acts).some(a => PO_ACTIONS.has(a));
    const hasInv = Array.from(acts).some(a => INV_ACTIONS.has(a));
    if (hasPO && isIssuanceRef(ref)) {
      totalPOs += 1;
      if (acts.has('CLAIM_PO')) settledPOs += 1;
      else if (acts.has('FUND_ESCROW') || acts.has('ACCEPT_PO')) inFlightPOs += 1;
    }
    // (inventory items counted separately via SCPO_INV_META memos — see inventoryMintCount)
  }

  const phase6ActionCount = Object.entries(actionByType)
    .filter(([a]) => PHASE6_ACTIONS.has(a))
    .reduce((s, [, n]) => s + n, 0);

  return {
    sourceTag: SOURCE_TAG,
    generatedAt: new Date().toISOString(),
    scannedWallets: participants.size,
    totalTransactions,
    uniqueAccounts: accounts.size,
    accounts: Array.from(accounts),
    totalVolumeUSD,
    totalVolumeXRP,
    totalPOs,
    settledPOs,
    inFlightPOs,
    inventoryItems: inventoryMintCount,
    totalUnitsTokenized,
    inventoryMints: actionByType['MINT_INV'] || 0,
    inventoryReceives: actionByType['RECEIVE_INV'] || 0,
    inventoryBurns: actionByType['BURN_INV'] || 0,
    profileLinks: actionByType['LINK_PROFILE'] || 0,
    profileUnlinks: actionByType['UNLINK_PROFILE'] || 0,
    txByType,
    actionByType,
    phase6ActionCount,
  };
};
