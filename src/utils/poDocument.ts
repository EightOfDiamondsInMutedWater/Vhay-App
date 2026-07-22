// ─────────────────────────────────────────────────────────────────────────────
// PO_BUILDOUT — Task 5.2 Tier 3 #10
// Typed PO document schema + pure builders. Self-contained (no app imports) so
// it stays removable. es5-safe: only .map/.reduce/.forEach/.concat/.slice — no
// for...of, no Set/Map iteration, no iterable spread (object spread is fine → __assign).
//
// Design invariants:
//  • Every v2-only field is OPTIONAL, so legacy / superseded POs (which lack them)
//    remain valid POMetadataV2 values — PO history keeps rendering.
//  • A PO with NO tax and NO shipping yields grandTotal === subtotal, i.e. the
//    exact number the app escrows today. Turning the flag on cannot change the
//    amount of a tax-less PO.
//  • buildPODoc is pure and state-free: the Create form, an ERP adapter, a bulk
//    loop, or an RFQ→PO conversion all assemble the same input and call it.
// ─────────────────────────────────────────────────────────────────────────────

/** A single PO line item. Superset of the app's `Item` type — new fields optional. */
export interface POItemV2 {
  num: string;                 // item # / SKU            (existing Item.num)
  qty: string;                 // quantity                (existing Item.qty)
  piecePrice?: string;         // unit price              (existing Item.piecePrice)
  total: string;               // line total, PRE-tax     (existing Item.total)
  invNFTId?: string;           // inventory NFT id        (existing Item.invNFTId)
  // ── v2 additions ──
  desc?: string;               // per-line description
  taxRate?: string;            // per-line tax rate, percent string e.g. "8.25"
  lineTax?: string;            // computed tax for this line
  lineTotal?: string;          // total + lineTax (convenience)
  invMptIssuanceId?: string;   // reserved: inventory MPT id for multi-line burn loop
}

/** Buyer letterhead / seller identity block. */
export interface POParty {
  address: string;             // XRPL classic address
  company?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  duns?: string;               // buyer AND seller DUNS ride here
  postal?: string;             // free-text postal block (matches profile.address textarea)
  logoCid?: string;            // letterhead logo, IPFS CID (buyer)
}

export interface POAddress {
  label?: string;
  raw?: string;                // free-text (profile addresses are textareas today)
  line1?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface POTotals {
  subtotal: string;
  taxTotal: string;
  shipping?: string;
  grandTotal: string;
  currency: string;
}

/** Reserved for future proof-of-delivery / advanced-release. Nullable now. */
export interface POFulfillment {
  status?: string;             // 'pending' | 'shipped' | 'delivered' | ...
  trackingNumber?: string;
  carrier?: string;
  docCids?: string[];          // attached POD document CIDs
  confirmedAt?: number;
}

export interface POHistoryEntry {
  ts: number;
  status: string;
  by: string;
}

/** Full PO document — the typed shape of the (encrypted-IPFS) doc AND the local
 *  metadata bag. Fields above `── v2 additions ──` match buildPOMetadata's output. */
export interface POMetadataV2 {
  poName: string;
  description: string;
  department: string;
  paymentTerms: string;
  deliveryTerms: string;
  items: POItemV2[];
  attachments: Array<{ name: string; uri: string }>;
  buyerAddress: string;
  vendorAddress: string;
  issued: number;
  lastUpdated: number;
  status: string;
  parentIssuanceId?: string;
  clawbackEnabled?: boolean;
  history: POHistoryEntry[];
  // ── v2 additions (all optional) ──
  schemaVersion?: number;              // 2 = new; absent/1 = legacy
  poNumber?: string;                   // human-readable, derived post-mint or caller-supplied
  poDate?: string;
  escrowCurrency?: string;
  createdBy?: { name?: string; email?: string; phone?: string };
  buyer?: POParty;                     // letterhead (company details + DUNS + logo)
  seller?: POParty;                    // denormalized seller identity + DUNS
  shipTo?: POAddress;
  billTo?: POAddress;
  requestedDeliveryDate?: string;
  legalTerms?: string;                 // T&Cs text block
  notes?: string;
  totals?: POTotals;
  // ── reserved-nullable (future features, not populated this pass) ──
  sourceSystem?: string;               // ERP/CRM origin
  externalId?: string;                 // caller-supplied external id
  rfqRef?: string;                     // linked RFQ/RFP reference
  fulfillment?: POFulfillment;
}

function round2(n: number): string {
  return parseFloat((isFinite(n) ? n : 0).toFixed(2)).toString();
}

/** Returns a copy of the item with lineTax + lineTotal derived from taxRate. */
export function withLineTax(item: POItemV2): POItemV2 {
  const base = parseFloat(item.total || '0') || 0;
  const rate =
    item.taxRate !== undefined && item.taxRate !== '' ? parseFloat(item.taxRate) || 0 : 0;
  const lineTax = base * (rate / 100);
  return { ...item, lineTax: round2(lineTax), lineTotal: round2(base + lineTax) };
}

export interface ComputeTotalsInput {
  items: POItemV2[];
  shipping?: string;
  currency?: string;
}

/** Sums line totals + per-line tax + optional shipping into grandTotal.
 *  Prefers an item's explicit lineTax; else derives from taxRate. */
export function computeTotals(input: ComputeTotalsInput): POTotals {
  const items = input.items || [];
  let subtotal = 0;
  let taxTotal = 0;
  items.forEach(function (it) {
    const base = parseFloat(it.total || '0') || 0;
    subtotal += base;
    let lt = 0;
    if (it.lineTax !== undefined && it.lineTax !== '') {
      lt = parseFloat(it.lineTax) || 0;
    } else if (it.taxRate !== undefined && it.taxRate !== '') {
      lt = base * ((parseFloat(it.taxRate) || 0) / 100);
    }
    taxTotal += lt;
  });
  const hasShipping = input.shipping !== undefined && input.shipping !== '';
  const shipping = hasShipping ? parseFloat(input.shipping as string) || 0 : 0;
  return {
    subtotal: round2(subtotal),
    taxTotal: round2(taxTotal),
    shipping: hasShipping ? round2(shipping) : undefined,
    grandTotal: round2(subtotal + taxTotal + shipping),
    currency: input.currency || 'XRP',
  };
}

/** Stateless, collision-free human PO number derived from the on-chain MPT
 *  issuance id. Format: PO-YYYYMMDD-<last 6 hex, upper>. No counter, no backend. */
export function derivePONumber(issuanceId: string, date?: Date): string {
  const d = date || new Date();
  const ymd =
    d.getFullYear() +
    ('0' + (d.getMonth() + 1)).slice(-2) +
    ('0' + d.getDate()).slice(-2);
  const suffix = (issuanceId || '').slice(-6).toUpperCase();
  return 'PO-' + ymd + '-' + (suffix || 'PENDING');
}

export interface BuildPODocInput {
  poName: string;
  description?: string;
  department?: string;
  paymentTerms: string;
  deliveryTerms?: string;
  escrowCurrency?: string;
  items: POItemV2[];
  attachments?: Array<{ name: string; uri: string }>;
  buyerAddress: string;
  vendorAddress: string;
  status: string;
  parentIssuanceId?: string;
  clawbackEnabled?: boolean;
  priorHistory?: POHistoryEntry[];
  by?: string;                         // history actor, default 'buyer'
  // v2
  poNumber?: string;
  poDate?: string;
  createdBy?: { name?: string; email?: string; phone?: string };
  buyer?: POParty;
  seller?: POParty;
  shipTo?: POAddress;
  billTo?: POAddress;
  requestedDeliveryDate?: string;
  legalTerms?: string;
  notes?: string;
  shipping?: string;
  // reserved
  sourceSystem?: string;
  externalId?: string;
  rfqRef?: string;
  fulfillment?: POFulfillment;
}

/** Assemble a complete, typed PO document. Pure — no React/xrpl/state. */
export function buildPODoc(input: BuildPODocInput): POMetadataV2 {
  const now = Date.now();
  const items = (input.items || []).map(withLineTax);
  const totals = computeTotals({
    items: items,
    shipping: input.shipping,
    currency: input.escrowCurrency,
  });
  const prior = input.priorHistory || [];
  const history = prior.concat([{ ts: now, status: input.status, by: input.by || 'buyer' }]);
  return {
    schemaVersion: 2,
    poName: input.poName,
    description: input.description || '',
    department: input.department || '',
    paymentTerms: input.paymentTerms,
    deliveryTerms: input.deliveryTerms || '',
    escrowCurrency: input.escrowCurrency,
    items: items,
    attachments: input.attachments || [],
    buyerAddress: input.buyerAddress,
    vendorAddress: input.vendorAddress,
    issued: now,
    lastUpdated: now,
    status: input.status,
    parentIssuanceId: input.parentIssuanceId,
    clawbackEnabled: input.clawbackEnabled !== undefined ? input.clawbackEnabled : true,
    history: history,
    poNumber: input.poNumber,
    poDate: input.poDate,
    createdBy: input.createdBy,
    buyer: input.buyer,
    seller: input.seller,
    shipTo: input.shipTo,
    billTo: input.billTo,
    requestedDeliveryDate: input.requestedDeliveryDate,
    legalTerms: input.legalTerms,
    notes: input.notes,
    totals: totals,
    sourceSystem: input.sourceSystem,
    externalId: input.externalId,
    rfqRef: input.rfqRef,
    fulfillment: input.fulfillment,
  };
}
