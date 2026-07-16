// ▼▼▼ MARKETPLACE ▼▼▼  Task 5.2 Tier 3 — Buyer Marketplace (self-contained / removable)
// The storefront doc is a PUBLIC, UNENCRYPTED per-vendor JSON pinned via
// pinJSONToBoth. It is the single artifact the marketplace reads per vendor:
// a deliberately-public identity block + a denormalized catalog summary, so
// browsing is one fetch per vendor instead of a per-vendor ledger scan.
// To uninstall after the feature is dropped: delete this file and remove its
// imports (all MARKETPLACE-bracketed). Nothing else depends on it.

export const STOREFRONT_SCHEMA_VERSION = 1;

// Public seller identity — entered on purpose by the seller (NOT copied from the
// encrypted profile), so publishing is a deliberate, consented act.
export interface StorefrontIdentity {
  name: string;         // marketplace display / company name
  country: string;      // country of origin
  website: string;
  description: string;  // short "what we make"
  contact: string;      // public contact (email or link)
}

// One lightweight row per SKU — denormalized public fields for a fast list render.
// Heavy/live data (full docs, live qty, image bytes) is fetched only on row-select.
export interface StorefrontItem {
  sku: string;            // vendor SKU (may be '')
  partNumber: string;
  name: string;
  shortDescription: string;
  category: string;       // public browse/filter field (e.g. 'Hardware')
  price: number;          // list price at write time
  currency: string;       // pricing currency (e.g. 'USD')
  imageCid: string;       // productImageUri (may be '')
  qtySnapshot: number;    // OutstandingAmount at write time (display hint only)
  nftId: string;          // for detail lookup on row-select
  mptIssuanceId: string;  // for live-qty lookup on row-select
}

export interface VendorStorefront {
  v: number;                    // schema version
  addr: string;                 // vendor classic address
  updatedAt: number;            // ms epoch when generated
  identity: StorefrontIdentity;
  items: StorefrontItem[];
}

// Loosely-typed item input so App.tsx can pass its InventoryItemV2[] directly
// (structural match; extra fields ignored) without this module importing a type
// that lives in App.tsx.
interface StorefrontItemInput {
  sku?: string;
  partNumber?: string;
  name?: string;
  shortDescription?: string;
  category?: string;
  listPrice?: number;
  pricingCurrency?: string;
  productImageUri?: string;
  quantityOnHand?: number;
  nftId?: string;
  mptIssuanceId?: string;
}

/**
 * Pure builder — no I/O, no app internals. Takes the seller's public identity
 * fields and their current inventory, returns the storefront doc to be pinned.
 */
export const buildStorefront = (
  vendorAddress: string,
  identity: StorefrontIdentity,
  items: StorefrontItemInput[]
): VendorStorefront => {
  const rows: StorefrontItem[] = (items || []).map((it): StorefrontItem => ({
    sku: it.sku || '',
    partNumber: it.partNumber || '',
    name: it.name || '',
    shortDescription: it.shortDescription || '',
    category: it.category || '',
    price: typeof it.listPrice === 'number' ? it.listPrice : 0,
    currency: it.pricingCurrency || 'USD',
    imageCid: it.productImageUri || '',
    qtySnapshot: typeof it.quantityOnHand === 'number' ? it.quantityOnHand : 0,
    nftId: it.nftId || '',
    mptIssuanceId: it.mptIssuanceId || '',
  }));
  return {
    v: STOREFRONT_SCHEMA_VERSION,
    addr: vendorAddress,
    updatedAt: Date.now(),
    identity: {
      name: identity.name || '',
      country: identity.country || '',
      website: identity.website || '',
      description: identity.description || '',
      contact: identity.contact || '',
    },
    items: rows,
  };
};
