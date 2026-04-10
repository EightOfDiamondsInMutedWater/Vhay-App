// ─────────────────────────────────────────────────────────────────────────────
// SC.PO Phase 6C — Inventory Financing Helpers
//
// Bridge/marketplace model: SC.PO connects vendor borrowers with licensed
// lenders. Vendors pledge inventory NFTs as collateral for a credit line.
// SC.PO enforces a soft lock (on-chain memo + app-level check).
// Lenders make credit decisions and hold licenses.
//
// ⚠️ LEGAL REVIEW REQUIRED before enabling for real users.
//
// This file provides:
//   1. CreditLine / DrawEvent / RepayEvent — core state types
//   2. CollateralValuation — output of collateral math
//   3. scanCreditLines() — reconstruct credit lines from on-chain memos
//   4. getActiveCreditLines() — filter to active only
//   5. calculateCollateralValue() — pure valuation function
//   6. isPledged() — soft lock check
//   7. computeInterestAccrued() — time-weighted interest
//   8. computeCoverageRatio() — health check with status
// ─────────────────────────────────────────────────────────────────────────────

import * as xrpl from 'xrpl';
import { getXRPLClient } from './xrplHelpers';
import { parseMemo, SCPO_ACTIONS } from './memoHelpers';

// ─────────────────────────────────────────────────────────────────────────────
// § 1 — Core Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DrawEvent {
  drawId: string;
  amount: string;
  newBalance: string;
  txHash: string;
  timestamp: number;
}

export interface RepayEvent {
  repayId: string;
  principalAmount: string;
  interestAmount: string;
  newBalance: string;
  txHash: string;
  timestamp: number;
}

export interface CreditLine {
  pledgeId: string;
  vendorAddress: string;
  lenderAddress: string;
  pledgedNftIds: string[];
  grossValuation: string;
  haircutPct: number;
  creditLimit: string;
  termsCID: string;
  pledgeTxHash: string;
  pledgeTimestamp: number;
  status: 'active' | 'released' | 'defaulted';
  totalDrawn: string;
  totalRepaid: string;
  currentBalance: string;
  interestAccrued: string;
  draws: DrawEvent[];
  repayments: RepayEvent[];
  releaseTxHash?: string;
  releasedAt?: number;
  defaultTxHash?: string;
  defaultedAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2 — Valuation Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CollateralValuationItem {
  nftId: string;
  partNumber: string;
  name: string;
  qty: number;
  listPrice: number;
  lineValue: number;
}

export interface CollateralValuation {
  grossValue: number;
  haircutPct: number;
  lendableValue: number;
  coverageRatio: number;
  itemsIncluded: CollateralValuationItem[];
}

export interface CoverageStatus {
  ratio: number;
  status: 'healthy' | 'warning' | 'critical' | 'no_balance';
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3 — Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_HAIRCUT = 0.65;
export const COVERAGE_HEALTHY = 1.5;
export const COVERAGE_WARNING = 1.2;
export const MIN_DRAW_AMOUNT = 100;
export const CREDIT_LINE_SCPO_FEE = 0.01;

// ─────────────────────────────────────────────────────────────────────────────
// § 4 — Pure Computation Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const calculateCollateralValue = (
  items: Array<{
    nftId: string;
    partNumber: string;
    name: string;
    quantityOnHand: number;
    listPrice: number;
  }>,
  haircutPct: number = DEFAULT_HAIRCUT,
  currentBalance: number = 0
): CollateralValuation => {
  const itemsIncluded: CollateralValuationItem[] = [];
  let grossValue = 0;

  for (const item of items) {
    const qty = item.quantityOnHand || 0;
    const price = item.listPrice || 0;
    if (qty <= 0 || price <= 0) continue;
    const lineValue = qty * price;
    grossValue += lineValue;
    itemsIncluded.push({
      nftId:      item.nftId,
      partNumber: item.partNumber,
      name:       item.name,
      qty,
      listPrice:  price,
      lineValue,
    });
  }

  const lendableValue = grossValue * haircutPct;
  const coverageRatio = currentBalance > 0 ? grossValue / currentBalance : Infinity;

  return { grossValue, haircutPct, lendableValue, coverageRatio, itemsIncluded };
};

export const computeInterestAccrued = (
  draws: DrawEvent[],
  repayments: RepayEvent[],
  apr: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): number => {
  if (!draws.length || apr <= 0) return 0;

  let grossInterest = 0;
  for (const draw of draws) {
    const principal = parseFloat(draw.amount) || 0;
    if (principal <= 0) continue;
    const daysElapsed = Math.max(0, (nowSeconds - draw.timestamp) / 86400);
    grossInterest += principal * apr * (daysElapsed / 365);
  }

  const interestPaid = repayments.reduce(
    (sum, r) => sum + (parseFloat(r.interestAmount) || 0),
    0
  );

  return Math.max(0, grossInterest - interestPaid);
};

export const computeCoverageRatio = (
  grossValue: number,
  currentBalance: number
): CoverageStatus => {
  if (currentBalance <= 0) {
    return { ratio: Infinity, status: 'no_balance', label: 'No Balance' };
  }
  const ratio = grossValue / currentBalance;
  if (ratio >= COVERAGE_HEALTHY) {
    return { ratio, status: 'healthy',  label: `${ratio.toFixed(1)}x ✓` };
  }
  if (ratio >= COVERAGE_WARNING) {
    return { ratio, status: 'warning',  label: `${ratio.toFixed(1)}x ⚠️` };
  }
  return { ratio, status: 'critical', label: `${ratio.toFixed(1)}x 🚨` };
};

export const isPledged = (
  nftId: string,
  creditLines: CreditLine[]
): boolean => {
  return creditLines.some(
    line => line.status === 'active' && line.pledgedNftIds.includes(nftId)
  );
};

export const getPledgeForNft = (
  nftId: string,
  creditLines: CreditLine[]
): CreditLine | null => {
  return creditLines.find(
    line => line.status === 'active' && line.pledgedNftIds.includes(nftId)
  ) ?? null;
};

export const getAvailableCredit = (line: CreditLine): number => {
  const limit   = parseFloat(line.creditLimit)    || 0;
  const balance = parseFloat(line.currentBalance) || 0;
  return Math.max(0, limit - balance);
};

export const formatCreditLineId = (pledgeId: string): string =>
  `CL-${pledgeId.slice(0, 8).toUpperCase()}`;

// ─────────────────────────────────────────────────────────────────────────────
// § 5 — On-Chain Scanner
// ─────────────────────────────────────────────────────────────────────────────

export const scanCreditLines = async (
  vendorAddress: string
): Promise<CreditLine[]> => {
  const lines = new Map<string, CreditLine>();

  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: vendorAddress,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 400,
    });

    const sortedTxs = [...(resp.result.transactions || [])].reverse();

    for (const txEntry of sortedTxs) {
      const tx = (txEntry as any).tx_json || (txEntry as any).tx || {};
      if (!tx?.Memos?.length) continue;

      for (const memoWrapper of tx.Memos) {
        const memo = parseMemo(memoWrapper.Memo);
        if (!memo) continue;

        const action    = memo.a as string;
        const payload   = memo.p as any;
        const ref       = memo.r as string;
        const hash      = (txEntry as any).hash || tx.hash || '';
        const closeTime = (txEntry as any).close_time_iso || null;
        const timestamp = closeTime
          ? Math.floor(new Date(closeTime).getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        if (action === SCPO_ACTIONS.COLLATERAL_PLEDGE) {
          const pledgeId = ref;
          if (!lines.has(pledgeId)) {
            const grossVal = parseFloat(payload.valuation || '0');
            const haircut  = payload.haircut ?? DEFAULT_HAIRCUT;
            const lineAmt  = payload.lineAmt || (grossVal * haircut).toFixed(2);
            lines.set(pledgeId, {
              pledgeId,
              vendorAddress,
              lenderAddress:   payload.lender   || '',
              pledgedNftIds:   payload.nfts      || [],
              grossValuation:  payload.valuation || '0',
              haircutPct:      haircut,
              creditLimit:     lineAmt,
              termsCID:        payload.termsCID  || '',
              pledgeTxHash:    hash,
              pledgeTimestamp: timestamp,
              status:          'active',
              totalDrawn:      '0',
              totalRepaid:     '0',
              currentBalance:  '0',
              interestAccrued: '0',
              draws:           [],
              repayments:      [],
            });
          }
        }

        if (action === SCPO_ACTIONS.COLLATERAL_DRAW) {
          const pledgeId = payload.pledgeId || ref;
          const existing = lines.get(pledgeId);
          if (existing) {
            const drawAmt       = parseFloat(payload.drawAmt || '0');
            const newTotalDrawn = (parseFloat(existing.totalDrawn) + drawAmt).toFixed(2);
            const newBalance    = payload.newBal
              || (parseFloat(existing.currentBalance) + drawAmt).toFixed(2);
            existing.draws.push({
              drawId:     ref,
              amount:     payload.drawAmt || '0',
              newBalance,
              txHash:     hash,
              timestamp,
            });
            existing.totalDrawn     = newTotalDrawn;
            existing.currentBalance = newBalance;
            lines.set(pledgeId, existing);
          }
        }

        if (action === SCPO_ACTIONS.COLLATERAL_REPAY) {
          const pledgeId = payload.pledgeId || ref;
          const existing = lines.get(pledgeId);
          if (existing) {
            const principalAmt   = parseFloat(payload.repayAmt || '0');
            const newTotalRepaid = (parseFloat(existing.totalRepaid) + principalAmt).toFixed(2);
            const newBalance     = payload.newBal
              || Math.max(0, parseFloat(existing.currentBalance) - principalAmt).toFixed(2);
            existing.repayments.push({
              repayId:         ref,
              principalAmount: payload.repayAmt || '0',
              interestAmount:  payload.intAmt   || '0',
              newBalance,
              txHash:          hash,
              timestamp,
            });
            existing.totalRepaid    = newTotalRepaid;
            existing.currentBalance = newBalance;
            lines.set(pledgeId, existing);
          }
        }

        if (action === SCPO_ACTIONS.COLLATERAL_RELEASE) {
          const pledgeId = payload.pledgeId || ref;
          const existing = lines.get(pledgeId);
          if (existing) {
            existing.status        = 'released';
            existing.releaseTxHash = hash;
            existing.releasedAt    = timestamp;
            lines.set(pledgeId, existing);
          }
        }

        if (action === SCPO_ACTIONS.COLLATERAL_DEFAULT) {
          const pledgeId = payload.pledgeId || ref;
          const existing = lines.get(pledgeId);
          if (existing) {
            existing.status        = 'defaulted';
            existing.defaultTxHash = hash;
            existing.defaultedAt   = timestamp;
            lines.set(pledgeId, existing);
          }
        }
      }
    }
  } catch (err) {
    console.error('[scanCreditLines] scan failed:', err);
  }

  return Array.from(lines.values()).sort(
    (a, b) => b.pledgeTimestamp - a.pledgeTimestamp
  );
};

export const getActiveCreditLines = async (
  vendorAddress: string
): Promise<CreditLine[]> => {
  const all = await scanCreditLines(vendorAddress);
  return all.filter(line => line.status === 'active');
};

// ─────────────────────────────────────────────────────────────────────────────
// § 6 — Display Helpers
// ─────────────────────────────────────────────────────────────────────────────

export const formatCreditLineStatus = (status: CreditLine['status']): string => {
  switch (status) {
    case 'active':    return '● Active';
    case 'released':  return '✓ Released';
    case 'defaulted': return '⚠️ Defaulted';
    default:          return status;
  }
};

export const formatCreditLineSummary = (line: CreditLine): string => {
  const limit     = parseFloat(line.creditLimit)    || 0;
  const balance   = parseFloat(line.currentBalance) || 0;
  const available = Math.max(0, limit - balance);
  const fmt = (n: number) =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  return `Limit ${fmt(limit)} | Balance ${fmt(balance)} | Available ${fmt(available)}`;
};
