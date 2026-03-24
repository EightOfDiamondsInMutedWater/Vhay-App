// ─────────────────────────────────────────────────────────────────────────────
// Task 4.7 — Data Export Utility
// Exports all SC.PO data as structured JSON or CSV — derived entirely from ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface SCPOExportBundle {
  exportedAt: string;
  walletAddress: string;
  pos: any[];
  feeEntries: any[];
  auditLog: any[];
}

// ── JSON Export ──
export const exportAsJSON = (bundle: SCPOExportBundle): void => {
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scpo-export-${bundle.walletAddress.slice(0, 8)}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
};

// ── CSV Export ──
const toCSVRow = (obj: Record<string, any>): string =>
  Object.values(obj).map(v => {
    const str = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${str.replace(/"/g, '""')}"`;
  }).join(',');

const toCSV = (rows: Record<string, any>[]): string => {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]).join(',');
  return [headers, ...rows.map(toCSVRow)].join('\n');
};

const downloadCSV = (csv: string, filename: string): void => {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

// ── 1099 Export ──
export interface NinetyNineRow {
  tax_year: number;
  buyer_company: string;
  buyer_wallet: string;
  buyer_name: string;
  buyer_email: string;
  buyer_address: string;
  total_payments_usd: string;
  po_count: number;
  po_issuance_ids: string;
}

export const export1099CSV = (rows: NinetyNineRow[], taxYear: number, vendorWallet: string): void => {
  const csv = toCSV(rows);
  downloadCSV(csv, `scpo-1099-${vendorWallet.slice(0, 8)}-${taxYear}.csv`);
};

export const exportAsCSV = (bundle: SCPOExportBundle): void => {
  const prefix = `scpo-${bundle.walletAddress.slice(0, 8)}-${Date.now()}`;

  // POs CSV
  if (bundle.pos.length > 0) {
    const poRows = bundle.pos.map(po => ({
      poName: po.poName,
      status: po.status,
      dateIssued: po.dateIssued,
      total: po.total,
      currency: po.escrowCurrency || 'XRP',
      buyerAddress: po.buyerAddress,
      vendorAddress: po.vendorAddress,
      paymentTerms: po.paymentTerms,
      issuanceId: po.issuanceId,
      txHash: po.txHash,
      ipfsUri: po.ipfsUri,
    }));
    downloadCSV(toCSV(poRows), `${prefix}-pos.csv`);
  }

  // Fees CSV
  if (bundle.feeEntries.length > 0) {
    const feeRows = bundle.feeEntries.map(f => ({
      date: f.date,
      poName: f.poName,
      amount: f.amount,
      txHash: f.txHash,
    }));
    downloadCSV(toCSV(feeRows), `${prefix}-fees.csv`);
  }

  // Audit Log CSV
  if (bundle.auditLog.length > 0) {
    const auditRows = bundle.auditLog.map(e => ({
      date: e.date,
      action: e.action,
      ref: e.ref,
      account: e.account,
      txHash: e.txHash,
      payload: JSON.stringify(e.payload),
    }));
    downloadCSV(toCSV(auditRows), `${prefix}-audit.csv`);
  }
};
