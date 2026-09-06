// ▼▼▼ MARKETPLACE ▼▼▼ Task 5.2 Tier 3 — Step 4a: buyer-side discovery + storefront read.
// Self-contained / removable (delete file + its MARKETPLACE-bracketed imports).
// Reads the PUBLIC storefront doc a seller published in 3a/3b: DID → "s" pointer → IPFS JSON.
// es5-safe: no for...of over iterables, no iterable spreads.
import type { VendorStorefront } from './marketplaceStorefront';

// A minimal resolver signature so this module doesn't reach into App.tsx internals.
// App passes in its existing resolveDID (returns { didDocument, uri, ... }).
export type DIDResolver = (address: string) => Promise<{ didDocument: any | null; uri: string | null }>;

// ── Curated seller set for v1 ────────────────────────────────────────────────
// Discovery is behind this one function so the real company-wallet scan (metrics
// Pass 1) can slot in later WITHOUT touching MarketplaceTab. For now: a known set.
// TODO(scale): replace the body with a company-wallet participant scan
//   (generalize competitionMetrics Pass 1) that returns inventory-holding vendors.
const CURATED_VENDOR_ADDRESSES: string[] = [
  'rsiPEXNs1XGn14DV7MHXsTfQVpGiEpJ347', // test vendor (Selling Goods / Vhay Industries)
];

export const discoverVendors = async (): Promise<string[]> => {
  // v1: curated. Interface is the seam; implementation swaps later.
  return CURATED_VENDOR_ADDRESSES.slice();
};

// Convert an ipfs:// URI (or bare CID) to a gateway URL for fetching.
const ipfsToGateway = (uri: string): string => {
  if (!uri) return '';
  const cid = uri.indexOf('ipfs://') === 0 ? uri.slice('ipfs://'.length) : uri;
  return 'https://rose-near-hyena-327.mypinata.cloud/ipfs/' + cid;
};

// Read one vendor's public storefront: DID → "s" pointer → fetch JSON.
// Returns null when the vendor has no storefront yet (un-migrated seller).
export const readStorefront = async (
  vendorAddress: string,
  resolveDID: DIDResolver
): Promise<VendorStorefront | null> => {
  try {
    const didResult = await resolveDID(vendorAddress);
    const storefrontUri: string | undefined =
      didResult && didResult.didDocument ? didResult.didDocument.s : undefined;
    if (!storefrontUri) {
      // TODO(un-migrated seller): live-derivation fallback via
      // fetchVendorInventoryV2ForCustomer(vendorAddress). Not built in v1 — the
      // only seller today has a storefront. This seam is where it slots in.
      console.warn('[MARKETPLACE] no storefront pointer on DID for', vendorAddress, '— skipped in v1');
      return null;
    }
    const url = ipfsToGateway(storefrontUri);
    const resp = await fetch(url);
    if (!resp.ok) { console.warn('[MARKETPLACE] storefront fetch failed', resp.status, url); return null; }
    const doc = await resp.json();
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.items)) {
      console.warn('[MARKETPLACE] storefront JSON malformed for', vendorAddress);
      return null;
    }
    return doc as VendorStorefront;
  } catch (e) {
    console.warn('[MARKETPLACE] readStorefront error for', vendorAddress, e);
    return null;
  }
};

// Convenience: discover + read all, dropping vendors with no storefront (v1).
export const loadMarketplace = async (resolveDID: DIDResolver): Promise<VendorStorefront[]> => {
  const addrs = await discoverVendors();
  const out: VendorStorefront[] = [];
  // Sequential to stay gentle on the shared cluster / gateway rate limits.
  for (let i = 0; i < addrs.length; i++) {
    const sf = await readStorefront(addrs[i], resolveDID);
    if (sf) out.push(sf);
  }
  return out;
};
