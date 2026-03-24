import React, { useState, useEffect, useRef } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, EscrowFinish, Payment, AccountSet, Transaction, Memo, AccountTxResponse, AccountInfoResponse, AccountNFTsResponse, AccountNFToken } from 'xrpl';
import CryptoJS from 'crypto-js';
import { x25519 } from '@noble/curves/ed25519';
import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/curves/abstract/utils';
import { v4 as uuidv4 } from 'uuid';
import { 
  getXRPLClient, getBuyerPOs, getVendorAuthorizedPOs, getEscrowsForPO,
  deployPermissionedDomain, issueCredential, acceptCredential,
  validateCredential, canCreatePO, revokeCredential, checkAndRenewCredential, isRLUSDConfigured, canUseRLUSDEscrow, setupRLUSDTrustLine, getRLUSDBalance, getRLUSDCurrency,
 scanFeeEntries,
  scanLinkedProfiles,
  submitBlobQueued,
  scanAuditLog,
  getPOCreationDate,
  getPOCreationInfo,
} from './utils/xrplHelpers';
import type { FeeEntry, ProfileLinkOnChain, AuditLogEntry } from './utils/xrplHelpers';
import { exportAsJSON, exportAsCSV, export1099CSV } from './utils/exportHelpers';
import type { SCPOExportBundle, NinetyNineRow } from './utils/exportHelpers';
import { buildMemo, parseMemo, parseLegacyRefMemo, SCPO_ACTIONS } from './utils/memoHelpers';
import { pinJSONToBoth, pinEncryptedToBoth, pinFileToBoth } from './utils/ipfsHelpers';
import {
  YieldPosition,
  YieldSummary,
  buildYieldPartnerRegistry,
  computeYieldSummary,
  computeAccruedYield,
  computeYieldDistribution,
  checkPreClaimConditions,
  canOptInToYield,
  scanYieldPositions,
  formatRLUSD as fmtRLUSD,
  formatAPR,
  daysElapsed as yieldDaysElapsed,
} from './utils/yieldHelpers';
import { issueInstitutionalCredential } from './utils/xrplHelpers';
import {
  FinancingRequest,
  FinancingPackage,
  LenderProfile,
  assembleFinancingPackage,
  scanFinancingRequests,
  getActiveFinancingRequest,
  formatFinancingTerms,
  computeRepaymentSplit,
  fetchEscrowDetails,
  MAX_ADVANCE_RATE,
  MIN_DAYS_UNTIL_CANCEL,
} from './utils/financeHelpers';

const getOrGenerateUUID = (key: string): string => {
  let uuid = localStorage.getItem(key);
  if (!uuid) {
    uuid = uuidv4();
    localStorage.setItem(key, uuid);
  }
  return uuid;
};

interface Item { num: string; qty: string; piecePrice?: string; total: string; invNFTId?: string; }
interface Attachment { name: string; uri: string; }
interface POData { poName: string; description: string; department: string; paymentTerms: string; deliveryTerms: string; escrowCurrency?: 'XRP' | 'RLUSD'; items: Item[]; attachments?: Attachment[]; parentIssuanceId?: string; }
interface SavedPO { id: string; poName: string; dateIssued: string; total: string; ipfsUri: string; status: 'open' | 'accepted' | 'funded' | 'claimed' | 'updated' | 'recalled' | 'superseded'; issuanceId: string; escrowSequence?: number; txHash: string; buyerAddress: string; vendorAddress: string; paymentTerms: string; escrowCurrency?: 'XRP' | 'RLUSD'; vendorUUID?: string; clawbackEnabled?: boolean; parentIssuanceId?: string; yieldOptIn?: boolean; metadata: any; }
interface Profile { company: string; name: string; email: string; phone: string; address: string; city: string; state: string; zip: string; country: string; seed: string; classicAddress: string; uniqueID: string; profileUUID: string; walletHistory: string[]; lastUpdateSource?: { postedBy: string; timestamp: number }; lastOnChainHash?: string; ipfsUri?: string; profileVersion?: number; }
interface PublicProfile { company: string; name: string; email: string; phone: string; address: string; city: string; state: string; zip: string; country: string; uniqueID: string; classicAddress: string; profileUUID: string; timestamp: number; expiresAt?: number; ipfsUri?: string; linkTxHash?: string; walletHistory: string[]; lastUpdateSource?: { postedBy: string; timestamp: number }; }
interface ProfileLink { linkerUUID: string; linkeeUUID: string; linkerAddress: string; linkeeAddress: string; txHash: string; createdAt: number; }

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Inventory Catalog Enhancement (Task 3.1a)
// ─────────────────────────────────────────────────────────────────────────────

// ── Schema Constants ──────────────────────────────────────────────────────────

/** On-chain identifier stamped in NFT Memo: MemoType = hex("SCPO_INV_META") */
const INV_META_TYPE = 'SCPO_INV' as const;

/** MPT metadata type identifier */
const INV_QTY_TYPE = 'SCPO_INV_QTY' as const;

/** Memo type key used on NFTokenMint transaction */
const INV_MEMO_TYPE = 'SCPO_INV_META' as const;

/** NFT taxon — same value as Phase 1 for backward compat with existing fetches */
const INV_NFT_TAXON = 1 as const;

/** High ceiling for bulk inventory MPTs (MaximumAmount is immutable after creation) */
const BULK_MPT_MAX = '999999' as const;

/** Hex-encoded memo type constants for on-chain use */
const INV_HEX_CONSTANTS = {
  /** hex("SCPO_INV_META") */
  MEMO_TYPE: '5343504F5F494E565F4D455441',
} as const;

// ── Union Types ───────────────────────────────────────────────────────────────

/** Lifecycle status of an inventory item */
type ItemStatus = 'active' | 'discontinued' | 'out_of_stock';

/**
 * How physical units are tracked.
 * - bulk: single MPT issuance tracks total quantity (Phase 3)
 * - serialized: one MPT per physical unit with serial in metadata (future)
 */
type TrackingMode = 'bulk' | 'serialized';

/** Supported units of measure for inventory quantities */
type UnitOfMeasure = 'ea' | 'kg' | 'lb' | 'm' | 'ft' | 'box' | string;

// ── Pricing Sub-Types ─────────────────────────────────────────────────────────

/**
 * A single volume price tier for customer-facing pricing.
 * Stored in sharedUri (ECDH-encrypted IPFS file).
 */
interface VolumePriceTier {
  /** Minimum quantity to qualify for this tier price */
  minQty: number;
  /** Unit price at this tier */
  price: string;
}

/**
 * A single cost break tier for vendor-only cost tracking.
 * Stored in vendorUri (self-encrypted IPFS file).
 */
interface CostBreakTier {
  /** Minimum quantity to qualify for this cost break */
  minQty: number;
  /** Unit cost at this tier */
  unitCost: string;
}

/**
 * Customer-visible pricing block — goes into sharedUri.
 * No cost data here — only what a customer needs to place an order.
 */
interface SharedPricing {
  /** List price per unit */
  unitPrice: string;
  /** ISO 4217 currency code (e.g. "USD") */
  currency: string;
  /** Volume-based price tiers, sorted ascending by minQty */
  volumeTiers: VolumePriceTier[];
  /** ISO date when this pricing becomes effective (YYYY-MM-DD) */
  effectiveDate: string;
  /** ISO date when this pricing expires (YYYY-MM-DD) */
  expiresDate: string;
}

/**
 * Vendor-only cost block — goes into vendorUri.
 * Contains internal cost data never shared with customers.
 */
interface VendorCost {
  /** Standard unit cost */
  unitCost: string;
  /** ISO 4217 currency code (e.g. "USD") */
  currency: string;
  /** Volume-based cost breaks, sorted ascending by minQty */
  costBreaks: CostBreakTier[];
}

/**
 * Vendor-only pricing block — goes into vendorUri.
 * Contains list price + volume tiers for vendor reference.
 */
interface VendorPricing {
  /** List price per unit */
  listPrice: string;
  /** ISO 4217 currency code */
  currency: string;
  /** Volume price tiers (mirrors sharedUri, vendor can see everything) */
  volumeTiers: VolumePriceTier[];
  /** ISO date when pricing becomes effective */
  effectiveDate: string;
  /** ISO date when pricing expires */
  expiresDate: string;
}

// ── IPFS Document Types ───────────────────────────────────────────────────────

/**
 * Document attachment reference stored in IPFS files.
 * Same shape as existing Attachment interface — kept separate for clarity.
 */
interface InventoryAttachment {
  /** Human-readable file name */
  name: string;
  /** IPFS URI: ipfs://Qm... */
  uri: string;
}

/**
 * Vendor-only IPFS document (self-encrypted with deriveSelfEncryptionKey).
 * Contains ALL data: cost, pricing, supplier, design files, BOMs.
 * Only the vendor can decrypt this file.
 */
interface VendorInventoryDoc {
  // ── Catalog fields (duplicated from on-chain for self-contained record) ──
  partNumber: string;
  partName: string;
  fullDescription: string;
  category: string;
  familyCode: string;
  productBrand: string;
  department: string;
  productionPlant: string;
  weight: string;
  competitiveFlag: boolean;
  trackingMode: TrackingMode;
  status: ItemStatus;

  // ── Vendor-only financials ──
  cost: VendorCost;
  pricing: VendorPricing;

  // ── Supplier data ──
  supplierCode: string;
  supplierName: string;

  // ── Document attachments ──
  attachments: {
    productImage?: InventoryAttachment; // Task 3.8 — product photo
    pricingSheet?: InventoryAttachment;
    designFile?: InventoryAttachment;
    bom?: InventoryAttachment;
    usageGuide?: InventoryAttachment;
  };

  // ── Links back to on-chain tokens ──
  nftId: string;
  mptIssuanceId: string;

  // ── Metadata ──
  createdAt: number;   // Unix timestamp (seconds)
  updatedAt: number;   // Unix timestamp (seconds)
  lastUpdated: string; // ISO date string (YYYY-MM-DD) for human display
  version: number;
}

/**
 * Customer-shared IPFS document (ECDH-encrypted — any linked customer
 * who knows the vendor's public key can derive the decryption key via
 * deriveSharedSecret(vendorPubKey, vendorPubKey)).
 *
 * Contains: part info, pricing, usage docs.
 * Does NOT contain: cost, supplier code, design files, BOMs.
 */
interface SharedInventoryDoc {
  // ── Public catalog fields ──
  partNumber: string;
  partName: string;
  description: string;
  category: string;
  productBrand: string;
  weight: string;

  // ── Customer-visible pricing ──
  pricing: SharedPricing;

  // ── Product image (public-safe — no cost/supplier info) ──
  productImageUri?: string; // Task 3.8 — ipfs://Qm...

  // ── Usage/installation documents only ──
  usageDocuments: InventoryAttachment[];

  // ── Link back to on-chain NFT ──
  nftId: string;

  // ── Metadata ──
  version: number;
}

/**
 * On-chain NFT Memo metadata (stored as hex-encoded JSON in MemoData).
 * MemoType = hex("SCPO_INV_META").
 *
 * Uses compact single-char keys to minimize on-chain byte usage.
 * The NFT URI field stores sharedUri for backward compat with existing
 * inventory fetching code (fetchVendorInventory reads URI directly).
 */
interface InventoryNFTMeta {
  /** Type tag — always "SCPO_INV" */
  t: typeof INV_META_TYPE;
  /** Part number / SKU */
  pn: string;
  /** Display name */
  nm: string;
  /** Short public description (≤60 chars recommended) */
  desc: string;
  /** Product category */
  cat: string;
  /** Product family code */
  fc: string;
  /** Brand name */
  brand: string;
  /** Whether item is competitive/restricted */
  cf: boolean;
  /** Unit weight with unit (e.g. "0.25kg") */
  wt: string;
  /** Department */
  dept: string;
  /** Production plant identifier */
  plant: string;
  /** Item lifecycle status */
  st: ItemStatus;
  /** Tracking mode — "bulk" for Phase 3, "serialized" for future */
  tm: TrackingMode;
  /** Parent NFT ID for supersession chain (empty string if first version) */
  parent: string;
  /** Metadata schema version */
  v: number;
  /** IPFS URI for vendor-only encrypted data */
  vu: string;
  /** IPFS URI for customer-shared encrypted data */
  su: string;
}

/**
 * On-chain MPT metadata stored in MPTokenMetadata field (hex-encoded JSON).
 * Links the quantity token back to its parent NFT catalog entry.
 */
interface InventoryMPTMeta {
  /** Type tag — always "SCPO_INV_QTY" */
  t: typeof INV_QTY_TYPE;
  /** Parent NFTokenID (links quantity to catalog entry) */
  nft: string;
  /** Part number (duplicated for quick lookup without resolving NFT) */
  pn: string;
  /** Unit of measure */
  unit: UnitOfMeasure;
}

// ── Main V2 Interface ─────────────────────────────────────────────────────────

/**
 * InventoryItemV2 — Phase 3 inventory catalog item.
 *
 * Backward compat: InventoryItem (Phase 1) still works for old NFTs.
 * Detection: presence of mptIssuanceId field OR SCPO_INV_META memo on the
 * mint transaction identifies a V2 item. V1 items lack both.
 *
 * Token model:
 *   - NFT = permanent catalog identity / SKU (immutable once minted)
 *   - MPT = fungible quantity token (mint/burn as stock changes)
 */
interface InventoryItem { id: string; name: string; department: string; description: string; attachments: Attachment[]; nftId: string; ipfsUri: string; dateAdded: string; }

interface InventoryItemV2 {
  // ── Local identity ──
  /** Local UUID (Date.now() string, same pattern as SavedPO.id) */
  id: string;

  // ── On-chain token identifiers ──
  /** NFTokenID of the catalog NFT */
  nftId: string;
  /** MPTokenIssuanceID of the quantity token (48-char hex) */
  mptIssuanceId: string;

  // ── On-chain metadata (from NFT Memo: SCPO_INV_META) ──
  partNumber: string;
  name: string;
  /** Short public description (≤60 chars) */
  shortDescription: string;
  category: string;
  familyCode: string;
  productBrand: string;
  competitiveFlag: boolean;
  weight: string;
  department: string;
  productionPlant: string;
  status: ItemStatus;
  trackingMode: TrackingMode;
  /** NFTokenID of the previous version (empty string if first version) */
  parentNFTId: string;
  /** On-chain metadata schema version */
  version: number;

  // ── IPFS URIs ──
  /** Self-encrypted IPFS URI — vendor eyes only (cost, supplier, all docs) */
  vendorUri: string;
  /** ECDH-encrypted IPFS URI — shared with linked customers (price, usage docs) */
  sharedUri: string;
 // ── Quantity (resolved from MPT balance) ──
  /** Current quantity on hand from MPT balance query */
  quantityOnHand: number;
  /** Unit of measure matching InventoryMPTMeta.unit */
  unit: UnitOfMeasure;

  // ── Pricing (resolved from vendorDoc at load time — no IPFS fetch needed at display) ──
  /** List price per unit — from vendorDoc.pricing.listPrice */
  listPrice: number;
  /** Unit cost — from vendorDoc.cost.unitCost */
  unitCost: number;
  /** Currency code e.g. "USD" */
  pricingCurrency: string;
  /** Task 3.8 — product image IPFS URI from vendorDoc.attachments.productImage */
  productImageUri?: string;   

  // ── Local metadata ──
  /** ISO date string when item was first added */
  dateAdded: string;
  /** ISO date string when item was last updated locally */
  dateUpdated: string;
}

/**
 * extractNFTokenID
 * Scans AffectedNodes from an NFTokenMint transaction result to find the
 * newly minted NFTokenID. Handles both CreatedNode (new page) and
 * ModifiedNode (appended to existing page) cases.
 *
 * @param meta - Transaction metadata object from submitAndWait result
 * @returns NFTokenID string or null if not found
 */

// ── Task 3.9 — stub for future third-party inventory adapters ─────────────
// Not implemented yet. Defines the contract for future adapters that can
// map foreign NFT schemas (e.g. other platforms) into InventoryItemV2.
interface ExternalInventoryAdapter {
  /** Human-readable source identifier e.g. 'xls20_uri', 'csv', 'custom_memo' */
  source: string;
  /** Returns true if this adapter can handle the given raw NFT object */
  detect: (nft: any) => boolean;
  /** Maps a foreign NFT to a partial InventoryItemV2 for vendor review */
  toInventoryItemV2: (nft: any) => Partial<InventoryItemV2>;
}
const extractNFTokenID = (meta: any): string | null => {
  if (!meta?.AffectedNodes) return null;

  for (const node of meta.AffectedNodes) {
    // Case 1: New NFTokenPage created (first NFT on account)
    if (node.CreatedNode?.LedgerEntryType === 'NFTokenPage') {
      const tokens = node.CreatedNode.NewFields?.NFTokens || [];
      if (tokens.length > 0) {
        return tokens[tokens.length - 1]?.NFToken?.NFTokenID || null;
      }
    }
    // Case 2: Existing NFTokenPage modified (appended to existing page)
    if (node.ModifiedNode?.LedgerEntryType === 'NFTokenPage') {
      const finalTokens = node.ModifiedNode.FinalFields?.NFTokens || [];
      const prevTokens = node.ModifiedNode.PreviousFields?.NFTokens || [];
      // The new token is in FinalFields but not in PreviousFields
      const prevIds = new Set(prevTokens.map((t: any) => t.NFToken?.NFTokenID));
      for (const token of finalTokens) {
        const id = token.NFToken?.NFTokenID;
        if (id && !prevIds.has(id)) return id;
      }
    }
  }
  return null;
};

// ── 3.2b — resolvePrice utility ──────────────────────────────────────────────
/**
 * Resolves the correct unit price for a given quantity using volume tiers.
 * Falls back to unitPrice if no tiers exist or qty is below the first tier.
 */
const resolvePrice = (pricing: SharedPricing, qty: number): string => {
  if (!pricing.volumeTiers || pricing.volumeTiers.length === 0) {
    return pricing.unitPrice;
  }
  // Walk tiers descending so highest qualifying tier wins
  const sorted = [...pricing.volumeTiers].sort((a, b) => b.minQty - a.minQty);
  const match = sorted.find(t => qty >= t.minQty);
  return match ? match.price : pricing.unitPrice;
};


const buildLedgerMetadata = (poName: string, ipfsUri: string, status: string, buyerAddress?: string, vendorAddress?: string, total?: string, payTerms?: string, parentIssuanceId?: string, escrowCur?: string) => ({
  t: "SCPO",
  n: poName,
  ac: "rwa",
  as: "other",
  in: "SC.PO",
  i: "https://example.com/scpo.png",
  uri: ipfsUri,
  ext: JSON.stringify({ s: status, b: buyerAddress || '', v: vendorAddress || '', amt: total || '0', pt: payTerms || '', pid: parentIssuanceId || '', ec: escrowCur || 'XRP', dt: new Date().toLocaleDateString() })
});
const buildPOMetadata = (poName: string, description: string, department: string, paymentTerms: string, deliveryTerms: string, items: Item[], attachments: Attachment[] | undefined, buyerAddress: string, vendorAddress: string, status: string, parentIssuanceId?: string, clawbackEnabled: boolean = true, history: Array<{ts: number; status: string; by: string}> = []) => ({
  poName, description, department, paymentTerms, deliveryTerms, items: items.map(i => ({ ...i })), attachments: attachments || [], buyerAddress, vendorAddress, issued: Date.now(), lastUpdated: Date.now(), status, parentIssuanceId, clawbackEnabled, history: [...history, { ts: Date.now(), status, by: 'buyer' }]
});
// This links each escrow to its specific PO on-chain without localStorage
// TODO: When integrating RLUSD stablecoin escrows via the Token Escrow Amendment,
// this same Condition/Fulfillment mechanism works identically — only the Amount field changes.
// Scan account transactions for SCPO_CLAIM memo receipts
// Returns a Set of issuanceIds that have been claimed
  const getClaimedPOIds = async (address: string): Promise<Set<string>> => {
  const claimedIds = new Set<string>();
  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: address,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 400
    });
    for (const tx of resp.result.transactions || []) {
      try {
        const txObj = (tx as any).tx_json || (tx as any).tx || {};
        const memos = txObj.Memos || [];
        for (const m of memos) {
          const memoType = m.Memo?.MemoType || '';
          const memoData = m.Memo?.MemoData || '';
          if (!memoType || !memoData) continue;
          try {
            // Try v1 standard envelope first
            const envelope = parseMemo({ MemoType: memoType, MemoData: memoData });
            if (envelope?.a === SCPO_ACTIONS.CLAIM_PO) {
              claimedIds.add(envelope.r);
            } else {
              // Legacy fallback — pre-standardization SCPO_CLAIM memos
              const legacyRef = parseLegacyRefMemo(memoType, memoData);
              if (legacyRef) claimedIds.add(legacyRef);
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip unparseable tx */ }
    }
    console.log(`Found ${claimedIds.size} claimed PO receipts for ${address}`);
  } catch (e) {
    console.error('Failed to scan claim receipts:', e);
  }
return claimedIds;
};
const getRecalledPOIds = async (address: string): Promise<Set<string>> => {
  const recalledIds = new Set<string>();
  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: address,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 400
    });
    for (const tx of resp.result.transactions || []) {
      try {
        const txObj = (tx as any).tx_json || (tx as any).tx || {};
        const memos = txObj.Memos || [];
        for (const m of memos) {
          const memoType = m.Memo?.MemoType || '';
          const memoData = m.Memo?.MemoData || '';
          if (!memoType || !memoData) continue;
          try {
            // Try v1 standard envelope first
            const envelope = parseMemo({ MemoType: memoType, MemoData: memoData });
            if (envelope?.a === SCPO_ACTIONS.RECALL_PO) {
              recalledIds.add(envelope.r);
            } else {
              // Legacy fallback — pre-standardization SCPO_RECALL memos
              const legacyRef = parseLegacyRefMemo(memoType, memoData);
              if (legacyRef) recalledIds.add(legacyRef);
            }
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }
    }
    console.log(`Found ${recalledIds.size} recalled PO receipts for ${address}`);
  } catch (e) {
    console.error('Failed to scan recall receipts:', e);
  }
  return recalledIds;
};

// PREIMAGE-SHA-256 crypto-condition using MPTokenIssuanceID as preimage  
const generateEscrowCondition = async (issuanceId: string): Promise<{ condition: string; fulfillment: string }> => {
  const preimage = new Uint8Array(issuanceId.length);
  for (let i = 0; i < issuanceId.length; i++) {
    preimage[i] = issuanceId.charCodeAt(i);
  }
  // Build fulfillment: type prefix (A0) + length + preimage
  const fulfillmentBytes = new Uint8Array(preimage.length + 2);
  fulfillmentBytes[0] = 0xA0;
  fulfillmentBytes[1] = preimage.length;
  fulfillmentBytes.set(preimage, 2);
  
  // Condition = type prefix + compound length + fingerprint tag + hash length + SHA256(fulfillment) + cost tag + cost length + preimage length
  const hash = await crypto.subtle.digest('SHA-256', fulfillmentBytes);
  const hashArray = new Uint8Array(hash);
  
  // Build condition per PREIMAGE-SHA-256 spec
  // A0 25 80 20 [32-byte-hash] 81 01 [preimage-length]
  const conditionBytes = new Uint8Array(39);
  conditionBytes[0] = 0xA0;  // type: PREIMAGE-SHA-256
  conditionBytes[1] = 0x25;  // total inner length: 32 + 2 + 1 + 2 = 37
  conditionBytes[2] = 0x80;  // fingerprint tag
  conditionBytes[3] = 0x20;  // fingerprint length (32)
  conditionBytes.set(hashArray, 4);  // 32-byte SHA-256 hash
  conditionBytes[36] = 0x81; // cost tag
  conditionBytes[37] = 0x01; // cost length
  conditionBytes[38] = preimage.length; // max fulfillment length
  
  const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return { condition: toHex(conditionBytes).toUpperCase(), fulfillment: toHex(fulfillmentBytes).toUpperCase() };
};

// ── Task 5.10 — XRP Gain/Loss Component ──
const XRPGainLossTable: React.FC<{
  pos: SavedPO[];
  copyToClipboard: (text: string, label: string) => void;
  getXRPLClient: () => Promise<any>;
}> = ({ pos, copyToClipboard, getXRPLClient }) => {
  const [currentXrpPrice, setCurrentXrpPrice] = React.useState<number | null>(null);
  const [xrpAmounts, setXrpAmounts] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      // Fetch current XRP price
      let price = 0.5;
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd');
        const data = await res.json();
        price = data.ripple.usd;
      } catch { price = 0.5; }
      if (cancelled) return;
      setCurrentXrpPrice(price);

      // For funded (still open) escrows, fetch actual XRP amount from ledger
      const amounts: Record<string, number> = {};
      for (const po of pos) {
        if (po.status === 'funded' && po.escrowSequence) {
          try {
            const client = await getXRPLClient();
            const resp: any = await client.request({
              command: 'ledger_entry',
              escrow: { owner: po.buyerAddress, seq: po.escrowSequence },
              ledger_index: 'validated',
            });
            const escrowObj = resp.result.node;
            if (escrowObj && typeof escrowObj.Amount === 'string') {
              // XRP escrow — Amount is drops
              amounts[po.issuanceId] = parseFloat(escrowObj.Amount) / 1_000_000;
            }
          } catch {
            // Escrow not found or error — fall back to back-calculation
            const poTotal = parseFloat(po.total || '0');
            amounts[po.issuanceId] = poTotal > 0 && price > 0 ? poTotal / price : 0;
          }
        } else {
          // Claimed — back-calculate from original PO total ÷ current price as best estimate
          const poTotal = parseFloat(po.total || '0');
          amounts[po.issuanceId] = poTotal > 0 && price > 0 ? poTotal / price : 0;
        }
      }
      if (cancelled) return;
      setXrpAmounts(amounts);
      setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [pos.map(p => p.issuanceId).join(',')]);

  if (loading || currentXrpPrice === null) {
    return <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>Loading XRP prices...</p>;
  }

  const fmtUSD = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtXRP = (n: number) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} XRP`;

  let totalOriginal = 0, totalCurrent = 0;

  const rows = pos.map(po => {
    const originalUSD = parseFloat(po.total || '0');
    const xrpQty = xrpAmounts[po.issuanceId] ?? 0;
    const currentUSD = xrpQty * currentXrpPrice;
    const gainLoss = currentUSD - originalUSD;
    const pct = originalUSD > 0 ? (gainLoss / originalUSD) * 100 : 0;
    totalOriginal += originalUSD;
    totalCurrent += currentUSD;
    return { po, originalUSD, xrpQty, currentUSD, gainLoss, pct };
  });

  const totalGainLoss = totalCurrent - totalOriginal;
  const totalPct = totalOriginal > 0 ? (totalGainLoss / totalOriginal) * 100 : 0;

  return (
    <>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '130px', background: 'white', border: '2px solid #D88F2E', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#D88F2E', marginBottom: '4px', textTransform: 'uppercase' }}>Original USD Value</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{fmtUSD(totalOriginal)}</div>
          <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>at time of PO creation</div>
        </div>
        <div style={{ flex: 1, minWidth: '130px', background: 'white', border: '2px solid #2e86de', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#2e86de', marginBottom: '4px', textTransform: 'uppercase' }}>Current USD Value</div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{fmtUSD(totalCurrent)}</div>
          <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>XRP @ ${currentXrpPrice.toFixed(4)}</div>
        </div>
        <div style={{ flex: 1, minWidth: '130px', background: 'white', border: `2px solid ${totalGainLoss >= 0 ? '#27ae60' : '#e74c3c'}`, borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
          <div style={{ fontSize: '10px', fontWeight: 'bold', color: totalGainLoss >= 0 ? '#27ae60' : '#e74c3c', marginBottom: '4px', textTransform: 'uppercase' }}>
            {totalGainLoss >= 0 ? 'Unrealized Gain' : 'Unrealized Loss'}
          </div>
          <div style={{ fontSize: '20px', fontWeight: 'bold', color: totalGainLoss >= 0 ? '#27ae60' : '#e74c3c' }}>
            {totalGainLoss >= 0 ? '+' : '-'}{fmtUSD(totalGainLoss)}
          </div>
          <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>
            {totalGainLoss >= 0 ? '+' : ''}{totalPct.toFixed(1)}% vs. original
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: '#FFF3E0', borderBottom: '2px solid #FFE0B2' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>PO Name</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Original USD</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>XRP Qty</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Current USD</th>
              <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Gain / Loss</th>
              <th style={{ padding: '8px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>Status</th>
              <th style={{ padding: '8px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>XRP Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const isLive = row.po.status === 'funded' && row.po.escrowSequence;
              return (
                <tr key={row.po.issuanceId} style={{ borderBottom: '1px solid #FFE0B2', background: idx % 2 === 0 ? 'white' : '#FFFDF8' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 'bold', color: '#333' }}>{row.po.poName}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666' }}>{fmtUSD(row.originalUSD)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666', fontFamily: 'monospace' }}>{fmtXRP(row.xrpQty)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', color: '#333', fontWeight: 'bold' }}>{fmtUSD(row.currentUSD)}</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 'bold', color: row.gainLoss >= 0 ? '#27ae60' : '#e74c3c' }}>
                    {row.gainLoss >= 0 ? '+' : '-'}{fmtUSD(row.gainLoss)}
                    <span style={{ fontSize: '11px', fontWeight: 'normal', marginLeft: '4px' }}>({row.gainLoss >= 0 ? '+' : ''}{row.pct.toFixed(1)}%)</span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    <span style={{ background: row.po.status === 'claimed' ? '#e8f8f0' : '#FFF3E0', color: row.po.status === 'claimed' ? '#27ae60' : '#D88F2E', borderRadius: '999px', padding: '2px 8px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>
                      {row.po.status}
                    </span>
                  </td>
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    <span style={{ fontSize: '11px', color: isLive ? '#2e86de' : '#999' }}>
                      {isLive ? '🔴 Live ledger' : '📐 Back-calculated'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: '11px', color: '#bbb', margin: '10px 0 0', textAlign: 'center' }}>
        Live ledger = XRP amount fetched directly from on-chain escrow. Back-calculated = XRP qty estimated from PO total ÷ current price. Consult a tax professional for realized gain/loss reporting.
      </p>
    </>
  );
};

// ── Phase 6A: Yield Badge — shown on any PO row that has an active yield position
const YieldBadge: React.FC<{ poIssuanceId: string; positions: YieldPosition[] }> = ({ poIssuanceId, positions }) => {
  const active = positions.find(p => p.poIssuanceId === poIssuanceId && p.status === 'accruing');
  if (!active) return null;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '3px',
      background: '#F0FFF4', border: '1px solid #68D391',
      borderRadius: '999px', padding: '2px 7px',
      fontSize: '10px', fontWeight: 'bold', color: '#276749',
      marginLeft: '6px', verticalAlign: 'middle',
    }}>
      🌱 Yield
    </span>
  );
};

// ── Phase 6A: Yield Dashboard Component ──────────────────────────────────────
const YieldDashboard: React.FC<{
  positions: YieldPosition[];
  summary: YieldSummary | null;
  loading: boolean;
  partnerRegistry: Map<string, any>;
  onRefresh: () => void;
}> = ({ positions, summary, loading, partnerRegistry, onRefresh }) => {
  const fmtU = (s: string) => { const n = parseFloat(s); return isNaN(n) ? '$0.00' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`; };
  const fmtP = (n: number) => `${(n * 100).toFixed(2)}%`;
  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: '#68D391' }}>Loading yield positions...</div>;
  const accruing  = positions.filter(p => p.status === 'accruing');
  const completed = positions.filter(p => p.status === 'withdrawn');
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
        <button onClick={onRefresh} style={{ padding: '6px 14px', borderRadius: '8px', border: '1px solid #68D391', background: 'white', color: '#276749', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer' }}>↻ Refresh</button>
      </div>
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '24px' }}>
          {[
            { label: 'Principal Accruing', value: fmtU(summary.totalPrincipalAccruing), sub: `${summary.activePOCount} active POs`, color: '#276749', border: '#68D391' },
            { label: 'Accrued So Far',     value: fmtU(summary.totalAccruedActiveEstimate), sub: 'estimated', color: '#2B6CB0', border: '#90CDF4' },
            { label: 'Net Received (YTD)', value: fmtU(summary.totalNetReceivedThisYear), sub: 'after all fees', color: '#553C9A', border: '#B794F4' },
            { label: 'Avg APY',            value: fmtP(summary.averageAPY), sub: 'opted-in escrows', color: '#C05621', border: '#FBD38D' },
          ].map(c => (
            <div key={c.label} style={{ background: 'white', border: `2px solid ${c.border}`, borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
              <div style={{ fontSize: '10px', fontWeight: 'bold', color: c.color, marginBottom: '4px', textTransform: 'uppercase' }}>{c.label}</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#1A202C' }}>{c.value}</div>
              <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{c.sub}</div>
            </div>
          ))}
        </div>
      )}
      <h4 style={{ fontSize: '13px', fontWeight: 'bold', color: '#276749', marginBottom: '10px', textTransform: 'uppercase' }}>🌱 Currently Accruing ({accruing.length})</h4>
      {accruing.length === 0 ? (
        <p style={{ color: '#999', fontSize: '13px', textAlign: 'center', padding: '20px' }}>No active yield positions. Opt in when funding an RLUSD escrow.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: '24px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead><tr style={{ background: '#F0FFF4', borderBottom: '2px solid #C6F6D5' }}>
              {['PO Issuance', 'Principal', 'Partner', 'Rate', 'Days In', 'Accrued (est.)', 'Est. at Term'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: h === 'PO Issuance' ? 'left' : 'right', color: '#276749', fontWeight: 'bold' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {accruing.filter((pos, idx, self) => self.findIndex(p => p.positionId === pos.positionId) === idx).map((pos, idx) => {
                const adapter = partnerRegistry.get(pos.partnerId);
                const days = yieldDaysElapsed(pos.optInTimestamp);
                const accrued = adapter ? computeAccruedYield(pos, adapter) : '0';
                const netAccrued = adapter ? (parseFloat(accrued) * (1 - adapter.feeStructure.partnerFeeFraction - adapter.feeStructure.scpoFeeFraction)).toFixed(6) : '0';
                const estDays = pos.estimatedClaimDate ? Math.max(0, (pos.estimatedClaimDate - pos.optInTimestamp) / 86400) : 30;
                const estTotal = adapter ? adapter.calculateAccrued(pos.principalAmount, pos.lockedAPR, estDays) : '0';
                const estNet = adapter ? (parseFloat(estTotal) * (1 - adapter.feeStructure.partnerFeeFraction - adapter.feeStructure.scpoFeeFraction)).toFixed(6) : '0';
                return (
                  <tr key={pos.positionId} style={{ borderBottom: '1px solid #C6F6D5', background: idx % 2 === 0 ? 'white' : '#F0FFF4' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '11px' }}>{pos.poIssuanceId.slice(0, 12)}...</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 'bold', color: '#276749' }}>{fmtU(pos.principalAmount)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666' }}>{adapter?.partnerName || pos.partnerId}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#553C9A', fontWeight: 'bold' }}>{fmtP(pos.lockedAPR)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666' }}>{days.toFixed(1)}d</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#276749', fontWeight: 'bold' }}>{fmtU(netAccrued)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#2B6CB0' }}>{fmtU(estNet)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {completed.length > 0 && (
        <>
          <h4 style={{ fontSize: '13px', fontWeight: 'bold', color: '#4A5568', marginBottom: '10px', textTransform: 'uppercase' }}>✅ Completed ({completed.length})</h4>
          <div style={{ overflowX: 'auto', marginBottom: '24px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead><tr style={{ background: '#EDF2F7', borderBottom: '2px solid #CBD5E0' }}>
                {['PO Issuance', 'Principal', 'Gross Yield', 'SC.PO Fee', 'Partner Fee', 'Net to You'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: h === 'PO Issuance' ? 'left' : 'right', color: '#4A5568', fontWeight: 'bold' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {completed.map((pos, idx) => (
                  <tr key={pos.positionId} style={{ borderBottom: '1px solid #EDF2F7', background: idx % 2 === 0 ? 'white' : '#F7FAFC' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '11px' }}>{pos.poIssuanceId.slice(0, 12)}...</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#666' }}>{fmtU(pos.principalAmount)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#276749' }}>{fmtU(pos.grossYieldAtClaim || '0')}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#E53E3E' }}>-{fmtU(pos.scFeeAtClaim || '0')}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: '#E53E3E' }}>-{fmtU(pos.partnerFeeAtClaim || '0')}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 'bold', color: '#276749' }}>{fmtU(pos.netYieldToBuyer || '0')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {summary && (parseFloat(summary.totalGrossThisYear) > 0 || parseFloat(summary.totalNetReceivedThisYear) > 0) && (
        <div style={{ background: '#FFFBEB', border: '1px solid #FBD38D', borderRadius: '10px', padding: '16px' }}>
          <h4 style={{ fontSize: '13px', fontWeight: 'bold', color: '#C05621', marginBottom: '12px', textTransform: 'uppercase' }}>📊 Annual Summary ({new Date().getFullYear()})</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', fontSize: '13px' }}>
            {[['Gross Yield Generated', fmtU(summary.totalGrossThisYear)], ['Fees Paid', fmtU(summary.totalFeesThisYear)], ['Net Yield Received', fmtU(summary.totalNetReceivedThisYear)], ['Effective APY', fmtP(summary.averageAPY)]].map(([l, v]) => (
              <div key={l}><span style={{ color: '#92400E' }}>{l}:</span><span style={{ fontWeight: 'bold', marginLeft: '8px' }}>{v}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [mode, setMode] = useState<'customer' | 'vendor'>('customer');
  const [activeTab, setActiveTab] = useState<'create' | 'view' | 'scpoAction' | 'inventoryCatalog' | 'customerProfile' | 'vendorProfile' | 'admin' | 'accounting'>('create');
  const [inputVendorWalletAddress, setInputVendorWalletAddress] = useState('');
  const [inputCustomerWalletAddress, setInputCustomerWalletAddress] = useState('');
  const [customerProfileSubTab, setCustomerProfileSubTab] = useState<'profile' | 'links'>('profile');
  const [vendorProfileSubTab, setVendorProfileSubTab] = useState<'profile' | 'links'>('profile');
  const [overviewSubTab, setOverviewSubTab] = useState<'summary' | 'details'>('summary');
  const [createSubTab, setCreateSubTab] = useState<'creation' | 'update'>('creation');
  const [poName, setPoName] = useState('');
  const [seed, setSeed] = useState('');
  const [vendor, setVendor] = useState('');
  const [selectedVendorUUID, setSelectedVendorUUID] = useState('');
  const [desc, setDesc] = useState('');
  const [department, setDepartment] = useState('1');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryTerms, setDeliveryTerms] = useState('FOB');
  const [result, setResult] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [newItemNum, setNewItemNum] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newPiecePrice, setNewPiecePrice] = useState('');
  const [newTotal, setNewTotal] = useState('');
  const [totalEscrowAmount, setTotalEscrowAmount] = useState('0');
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  const [scpoSuccess, setScpoSuccess] = useState(false);
  const [selectedUpdatePO, setSelectedUpdatePO] = useState<SavedPO | null>(null);
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  const [domainID, setDomainID] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [revokeAddress, setRevokeAddress] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [adminSubTab, setAdminSubTab] = useState<'fees' | 'credentials' | 'auditLog'>('fees');

  // ── Phase 6A: Yield state ───────────────────────────────────────────────────
  const [yieldPositions, setYieldPositions] = useState<YieldPosition[]>([]);
  const [yieldSummary, setYieldSummary] = useState<YieldSummary | null>(null);
  const [yieldLoading, setYieldLoading] = useState(false);
  const [yieldOptIn, setYieldOptIn] = useState(false);
  const [yieldOptInAPR, setYieldOptInAPR] = useState<number | null>(null);
  const [yieldOptInLoading, setYieldOptInLoading] = useState(false);
  const [yieldEstimatedReturn, setYieldEstimatedReturn] = useState<string | null>(null);
  const [selectedPartnerId] = useState<string>('stub_v1');
  const yieldPartnerRegistry = React.useMemo(
    () => buildYieldPartnerRegistry(process.env.REACT_APP_COMPANY_WALLET || ''),
    []
  );

  // ── Phase 6B: Financing state ───────────────────────────────────────────────
  const [financingRequests, setFinancingRequests] = useState<FinancingRequest[]>([]);
  const [financingLoading, setFinancingLoading] = useState(false);

  // Financing request modal state
  const [showFinancingModal, setShowFinancingModal] = useState(false);
  const [financingModalPO, setFinancingModalPO] = useState<SavedPO | null>(null);
  const [financingAdvanceRate, setFinancingAdvanceRate] = useState<number>(0.80);
  const [financingLenderAddress, setFinancingLenderAddress] = useState('');
  const [financingLenderAPR, setFinancingLenderAPR] = useState<number>(0.12);
  const [financingSubmitting, setFinancingSubmitting] = useState(false);
  const [financingEscrowDetails, setFinancingEscrowDetails] = useState<Awaited<ReturnType<typeof fetchEscrowDetails>> | null>(null);
  const [financingEscrowLoading, setFinancingEscrowLoading] = useState(false);

  // ── Phase 6.0b: Institutional credential state (Admin tab) ─────────────────
  const [institutionalCredAddress, setInstitutionalCredAddress] = useState('');
  const [institutionalCredLoading, setInstitutionalCredLoading] = useState(false);
  const [institutionalCredResult, setInstitutionalCredResult] = useState('');
  const [pendingEscrowRecovery, setPendingEscrowRecovery] = useState<{ po: SavedPO; escrowSequence: number; escrowTxHash: string } | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [notifications, setNotifications] = useState<{ id: string; message: string; type: 'info' | 'success' | 'warning'; timestamp: number; read: boolean }[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const knownPOStates = useRef<Record<string, string>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  const isMobile = windowWidth <= 768;
  const [exportLoading, setExportLoading] = useState(false);

  const buildExportBundle = async (walletAddress: string): Promise<SCPOExportBundle> => {
    const [fees, audit] = await Promise.all([
      scanFeeEntries(process.env.REACT_APP_COMPANY_WALLET || ''),
      scanAuditLog(walletAddress),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      walletAddress,
      pos: savedPOs,
      feeEntries: fees,
      auditLog: audit,
    };
  };
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [auditLogLoading, setAuditLogLoading] = useState(false);
  const [auditLogFilter, setAuditLogFilter] = useState('');
  const [cfPeriod, setCfPeriod] = useState<'30' | '90' | '180' | '365' | 'all'>('90');
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [expandedJournal, setExpandedJournal] = useState<string | null>(null);
  const [taxPeriod, setTaxPeriod] = useState<'month' | 'quarter' | 'year' | 'custom'>('year');
  const [taxCustomStart, setTaxCustomStart] = useState('');
  const [taxCustomEnd, setTaxCustomEnd] = useState('');
  const [customerCredStatus, setCustomerCredStatus] = useState<{ valid: boolean; tier?: string } | null>(null);
  const [vendorCredStatus, setVendorCredStatus] = useState<{ valid: boolean; tier?: string } | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [feeEntries, setFeeEntries] = useState<FeeEntry[]>([]);
  const [feeSearchTerm, setFeeSearchTerm] = useState('');
  const [openExpanded, setOpenExpanded] = useState(false);
  const [acceptedExpanded, setAcceptedExpanded] = useState(false);
  const [fundedExpanded, setFundedExpanded] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);
  const [profileLinks, setProfileLinks] = useState<ProfileLink[]>([]);
  const [claimSeed, setClaimSeed] = useState('');
  const [claimOwner, setClaimOwner] = useState('');
  const [claimOfferSequence, setClaimOfferSequence] = useState('');
  const [claimResult, setClaimResult] = useState('');
  const [vendorAcceptSeed, setVendorAcceptSeed] = useState('');
  const [offerIndex, setOfferIndex] = useState('');
  const [acceptResult, setAcceptResult] = useState('');
  const [selectedOpenPO, setSelectedOpenPO] = useState<SavedPO | null>(null);
  const [selectedFundedPO, setSelectedFundedPO] = useState<SavedPO | null>(null);
  const [claimableAfter, setClaimableAfter] = useState<Date | null>(null);
  const [isClaimable, setIsClaimable] = useState(false);
  const [countdown, setCountdown] = useState('');
  const [ipfsUri, setIpfsUri] = useState('');
  const [savedPOs, setSavedPOs] = useState<SavedPO[]>([]);
  const [customerProfile, setCustomerProfile] = useState<Profile>({ company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: '', walletHistory: [], lastOnChainHash: '' });
  const [vendorProfile, setVendorProfile] = useState<Profile>({ company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: '', walletHistory: [], lastOnChainHash: '' });
  const [publicProfiles, setPublicProfiles] = useState<{ [uuid: string]: PublicProfile }>({});
  const [customerLinkedVendorUUIDs, setCustomerLinkedVendorUUIDs] = useState<string[]>([]);
  const [vendorLinkedCustomerUUIDs, setVendorLinkedCustomerUUIDs] = useState<string[]>([]);
  const customerLinkedVendorUUIDsRef = useRef<string[]>([]);
  const vendorLinkedCustomerUUIDsRef = useRef<string[]>([]);
  const publicProfilesRef = useRef<{ [uuid: string]: PublicProfile }>({});
  const pendingVendorUUIDsRef = useRef<string[] | null>(null);
  const pendingPublicProfilesRef = useRef<{ [uuid: string]: PublicProfile } | null>(null);
  const [selectedLinkedVendor, setSelectedLinkedVendor] = useState<PublicProfile | null>(null);
  const [selectedLinkedCustomer, setSelectedLinkedCustomer] = useState<PublicProfile | null>(null);
  const [vendorsExpanded, setVendorsExpanded] = useState(false);
  const [customersExpanded, setCustomersExpanded] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isLoadingPOs = useRef(false);
  const loadPOsVersion = useRef(0);
  const loadPOsFromLedgerRef = useRef<() => Promise<void>>(async () => {});
  const [hydrated, setHydrated] = useState(false);
  const [customerScpoActionViewedPO, setCustomerScpoActionViewedPO] = useState<POData | null>(null);
  const [customerScpoActionPoLoadError, setCustomerScpoActionPoLoadError] = useState<string | null>(null);
  const [vendorScpoActionViewedPO, setVendorScpoActionViewedPO] = useState<POData | null>(null);
  const [vendorScpoActionPoLoadError, setVendorScpoActionPoLoadError] = useState<string | null>(null);
  const [customerViewViewedPO, setCustomerViewViewedPO] = useState<POData | null>(null);
  const [customerViewPoLoadError, setCustomerViewPoLoadError] = useState<string | null>(null);
  const [vendorViewViewedPO, setVendorViewViewedPO] = useState<POData | null>(null);
  const [vendorViewPoLoadError, setVendorViewPoLoadError] = useState<string | null>(null);
  const [inventorySubTab, setInventorySubTab] = useState<'list' | 'add' | 'import'>('list');
  const [invResult, setInvResult] = useState('');
  const [invName, setInvName] = useState('');
  const [invDepartment, setInvDepartment] = useState('');
  const [invDesc, setInvDesc] = useState('');
  const [invPricingFile, setInvPricingFile] = useState<File | null>(null);
  const [invDesignFile, setInvDesignFile] = useState<File | null>(null);
  const [invBomFile, setInvBomFile] = useState<File | null>(null);
  const [invUsageFile, setInvUsageFile] = useState<File | null>(null);
  const [invImageFile, setInvImageFile] = useState<File | null>(null); // Task 3.8
  const [editImageFile, setEditImageFile] = useState<File | null>(null); // Task 3.8
  // ── Task 3.10 — quick status update state ────────────────────────────────
  const [statusUpdatingNFTId, setStatusUpdatingNFTId] = useState<string | null>(null);
  // ── Task 3.9 — Bulk CSV Import state ─────────────────────────────────────
  const [csvImportSubTab, setCsvImportSubTab] = useState<'csv' | 'xrpl'>('csv');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<string[][]>([]);
  const [csvMapping, setCsvMapping] = useState<{ [csvHeader: string]: string }>({});
  const [csvPreviewRows, setCsvPreviewRows] = useState<any[]>([]);
  const [csvDuplicateAction, setCsvDuplicateAction] = useState<'skip' | 'version'>('skip');
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvProgress, setCsvProgress] = useState<{ current: number; total: number; currentName: string }>({ current: 0, total: 0, currentName: '' });
  const [csvErrors, setCsvErrors] = useState<{ row: number; partNumber: string; error: string }[]>([]);
  const [csvImportDone, setCsvImportDone] = useState(false);
  const [csvImportedCount, setCsvImportedCount] = useState(0);
  const [csvSkippedCount, setCsvSkippedCount] = useState(0);
  const [vendorInventories, setVendorInventories] = useState<{ [vendorAddress: string]: InventoryItem[] }>({});
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<string>('custom');
 // Add alongside existing inventory state variables
  const [invPartNumber, setInvPartNumber] = useState('');
  const [invCategory, setInvCategory] = useState('');
  const [invFamilyCode, setInvFamilyCode] = useState('');
  const [invBrand, setInvBrand] = useState('');
  const [invWeight, setInvWeight] = useState('');
  const [invPlant, setInvPlant] = useState('');
  const [invCompetitiveFlag, setInvCompetitiveFlag] = useState(false);
  const [invShortDesc, setInvShortDesc] = useState('');
// Pricing (goes to sharedUri)
  const [invUnitPrice, setInvUnitPrice] = useState('');
  const [invPriceCurrency, setInvPriceCurrency] = useState('USD');
  const [invEffectiveDate, setInvEffectiveDate] = useState('');
  const [invExpiresDate, setInvExpiresDate] = useState('');
// Cost (goes to vendorUri only)
  const [invUnitCost, setInvUnitCost] = useState('');
  const [invCostCurrency, setInvCostCurrency] = useState('USD');
// Supplier (goes to vendorUri only)
  const [invSupplierCode, setInvSupplierCode] = useState('');
  const [invSupplierName, setInvSupplierName] = useState('');
// Quantity
  const [invInitialQty, setInvInitialQty] = useState('');
  const [invUnit, setInvUnit] = useState<UnitOfMeasure>('ea');
// ── 3.2a — Volume pricing state for Add Inventory form ─────────────────────
  const [invUseVolumePricing, setInvUseVolumePricing] = useState(false);
  const [invVolumeTiers, setInvVolumeTiers] = useState<{ minQty: string; maxQty: string; price: string }[]>([]);
// V2 inventory storage (parallel to savedInventory for V1 backward compat)
  const [savedInventoryV2, setSavedInventoryV2] = useState<InventoryItemV2[]>([]);
 // 3.1d — V2 inventory for vendor's own view (decrypted with self-key)
  const [vendorInventoryV2, setVendorInventoryV2] = useState<InventoryItemV2[]>([]);
  const [vendorInventoryV2Loading, setVendorInventoryV2Loading] = useState(false);
  const [vendorInventorySuperseded, setVendorInventorySuperseded] = useState<InventoryItemV2[]>([]);
  const [showVersionHistoryModal, setShowVersionHistoryModal] = useState(false);
  const [versionHistoryItems, setVersionHistoryItems] = useState<InventoryItemV2[]>([]);
  const [versionHistoryPartNumber, setVersionHistoryPartNumber] = useState('');
  const [versionHistoryIndex, setVersionHistoryIndex] = useState(0);
  const [versionHistoryDoc, setVersionHistoryDoc] = useState<VendorInventoryDoc | null>(null);
  const [versionHistoryDocLoading, setVersionHistoryDocLoading] = useState(false);
  // ── Task 3.5 — DID catalog endpoint state ────────────────────────────────
  const [catalogDIDStatus, setCatalogDIDStatus] = useState<'checking' | 'registered' | 'not_registered' | 'no_did' | null>(null);
  const [catalogDIDUri, setCatalogDIDUri] = useState<string | null>(null);
  // ── Task 3.6 — Inventory search/filter state ──────────────────────────────
  const [invSearchText, setInvSearchText] = useState('');
  const [invFilterDept, setInvFilterDept] = useState('');
  const [invFilterStatus, setInvFilterStatus] = useState('');
  const [invFilterCategory, setInvFilterCategory] = useState('');
  const [invFilterMinPrice, setInvFilterMinPrice] = useState('');
  const [invFilterMaxPrice, setInvFilterMaxPrice] = useState('');
  // ── Task 3.7 — Inventory valuation state ─────────────────────────────────
  const [invPricingMap, setInvPricingMap] = useState<{
    [nftId: string]: { listPrice: number; unitCost: number; currency: string }
  }>({});
  const [invValuationLoading, setInvValuationLoading] = useState(false);
  // ── Task 3.7 — Receive Inventory state ───────────────────────────────────
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [receiveModalItem, setReceiveModalItem] = useState<InventoryItemV2 | null>(null);
  const [receiveQty, setReceiveQty] = useState('');
  const [receiveLotRef, setReceiveLotRef] = useState('');
  const [receiveResult, setReceiveResult] = useState('');
  const [receiveLoading, setReceiveLoading] = useState(false);
  // Warehouse wallet: a second vendor-controlled account that HOLDS inventory MPTs.
  // The issuer (vendor main wallet) pays tokens TO this address — increasing
  // OutstandingAmount. Balance of this wallet = units physically on hand.
  // Stored in vendorProfile so it persists. Can be any funded XRPL account.
  const [warehouseWalletAddress, setWarehouseWalletAddress] = useState<string>(
    () => localStorage.getItem('scpo_warehouse_wallet') || ''
  );
  const [warehouseWalletSeed, setWarehouseWalletSeed] = useState<string>(
    () => localStorage.getItem('scpo_warehouse_seed') || ''
  );
  const [showWarehouseSetup, setShowWarehouseSetup] = useState(false);
  const [warehouseSetupInput, setWarehouseSetupInput] = useState('');
  const [warehouseSetupSeedInput, setWarehouseSetupSeedInput] = useState('');
  // 3.1d — V2 inventory for a linked vendor (customer view, sharedUri decrypted)
  const [linkedVendorInventoryV2, setLinkedVendorInventoryV2] = useState<{ [vendorAddress: string]: InventoryItemV2[] }>({});
  // 3.1f — Vendor inventory detail modal
  const [showInventoryDetailModal, setShowInventoryDetailModal] = useState(false);
  const [inventoryDetailItem, setInventoryDetailItem] = useState<InventoryItemV2 | null>(null);
  const [inventoryDetailDoc, setInventoryDetailDoc] = useState<VendorInventoryDoc | null>(null);
  const [inventoryDetailLoading, setInventoryDetailLoading] = useState(false);
  // ── 3.2h — Edit pricing state ─────────────────────────────────────────────
  const [showEditPricing, setShowEditPricing] = useState(false);
  const [editPricingResult, setEditPricingResult] = useState('');
  const [editPricingSaving, setEditPricingSaving] = useState(false);
  // Full edit form fields
  const [editName, setEditName] = useState('');
  const [editPartNumber, setEditPartNumber] = useState('');
  const [editShortDesc, setEditShortDesc] = useState('');
  const [editFullDesc, setEditFullDesc] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editFamilyCode, setEditFamilyCode] = useState('');
  const [editBrand, setEditBrand] = useState('');
  const [editWeight, setEditWeight] = useState('');
  const [editDepartment, setEditDepartment] = useState('');
  const [editPlant, setEditPlant] = useState('');
  const [editCompetitiveFlag, setEditCompetitiveFlag] = useState(false);
  const [editStatus, setEditStatus] = useState<ItemStatus>('active');
  const [editUnitPrice, setEditUnitPrice] = useState('');
  const [editPriceCurrency, setEditPriceCurrency] = useState('USD');
  const [editEffectiveDate, setEditEffectiveDate] = useState('');
  const [editExpiresDate, setEditExpiresDate] = useState('');
  const [editUseVolumeTiers, setEditUseVolumeTiers] = useState(false);
  const [editVolumeTiers, setEditVolumeTiers] = useState<{ minQty: string; maxQty: string; price: string }[]>([]);
  const [editUnitCost, setEditUnitCost] = useState('');
  const [editCostCurrency, setEditCostCurrency] = useState('USD');
  const [editSupplierCode, setEditSupplierCode] = useState('');
  const [editSupplierName, setEditSupplierName] = useState('');
  // 3.1g — PO Inventory modal
  const [showPOInventoryModal, setShowPOInventoryModal] = useState(false);
  const [poInventoryModalPO, setPoInventoryModalPO] = useState<SavedPO | null>(null);
  const [poInventoryModalIndex, setPoInventoryModalIndex] = useState(0);
  const [poInventoryModalItems, setPoInventoryModalItems] = useState<{
    item: Item;
    invItem: InventoryItemV2 | null;
    vendorDoc: VendorInventoryDoc | null;
    sharedDoc: SharedInventoryDoc | null;
    loading: boolean;
  }[]>([]);
  const [customerScpoActionPoInventory, setCustomerScpoActionPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [vendorScpoActionPoInventory, setVendorScpoActionPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [customerViewPoInventory, setCustomerViewPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [vendorViewPoInventory, setVendorViewPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [vendorOverviewViewedPO, setVendorOverviewViewedPO] = useState<POData | null>(null);
  const [vendorOverviewPoLoadError, setVendorOverviewPoLoadError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [historyModalIndex, setHistoryModalIndex] = useState(0);
  const [historyModalVersions, setHistoryModalVersions] = useState<{po: SavedPO; poData: POData | null; loading: boolean}[]>([]);
  const [showProfilesModal, setShowProfilesModal] = useState(false);
  const [profilesModalPO, setProfilesModalPO] = useState<SavedPO | null>(null);
  const [profilesModalIndex, setProfilesModalIndex] = useState(0);
  const [updateResult, setUpdateResult] = useState('');
  const [isLoadingEditPO, setIsLoadingEditPO] = useState(false);
  const [escrowCurrency, setEscrowCurrency] = useState<'XRP' | 'RLUSD'>(isRLUSDConfigured() ? 'RLUSD' : 'XRP');
  const linkedVendors = customerLinkedVendorUUIDs.map(uuid => publicProfiles[uuid]).filter(Boolean) as PublicProfile[];
  const linkedCustomers = vendorLinkedCustomerUUIDs.map(uuid => publicProfiles[uuid]).filter(Boolean) as PublicProfile[];

  // ── Phase 6B: Request Financing ────────────────────────────────────────────
  const requestFinancing = async () => {
    if (!financingModalPO || !vendorProfile.seed) return;
    if (!financingLenderAddress) return alert('Select a lender');
    const po = financingModalPO;
    const poTotal = parseFloat(po.total || '0');
    if (poTotal <= 0) return alert('PO total must be greater than 0');
    if (!po.escrowSequence) return alert('No escrow sequence found');

    const requestedAmount = (poTotal * financingAdvanceRate).toFixed(2);

    // Gate: funded RLUSD POs only
    if (po.escrowCurrency !== 'RLUSD') {
      return alert('PO financing is only available for RLUSD escrows.');
    }
    if (po.status !== 'funded') {
      return alert('PO financing is only available for funded POs.');
    }

    // Gate: enough time before CancelAfter
    if (financingEscrowDetails && financingEscrowDetails.daysUntilCancel <= MIN_DAYS_UNTIL_CANCEL) {
      return alert(`Escrow expires in ${financingEscrowDetails.daysUntilCancel.toFixed(1)} days — too soon to request financing safely.`);
    }

    setFinancingSubmitting(true);
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const requestId = uuidv4();

      // Pin financing terms document to IPFS
      const termsDoc = {
        requestId,
        poIssuanceId:    po.issuanceId,
        poTotal:         po.total,
        requestedAmount,
        advanceRate:     financingAdvanceRate,
        lenderAddress:   financingLenderAddress,
        vendorAddress:   wallet.classicAddress,
        buyerAddress:    po.buyerAddress,
        scpoFeeRate:     0.01,
        publishedAPR:    financingLenderAPR,
        escrowSequence:  po.escrowSequence,
        requestedAt:     new Date().toISOString(),
        version:         1,
      };
      const termsCID = await pinJSONToBoth(termsDoc, `financing-terms-${requestId}`);
      const ipfsCID = termsCID.replace('ipfs://', '');

      // Write FINANCE_REQUEST memo on-chain
      const requestPayment: Payment = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: financingLenderAddress,
        Amount: '1',
        Memos: [buildMemo(SCPO_ACTIONS.FINANCE_REQUEST, requestId, {
          poRef:    po.issuanceId,
          amt:      requestedAmount,
          advRate:  financingAdvanceRate,
          lender:   financingLenderAddress,
          termsCID: ipfsCID,
        } as any)]
      };
      const prepared = await client.autofill(requestPayment);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const result = await submitBlobQueued(signed.tx_blob);
      const txHash = result.result.hash;

      // Add to local state immediately
      const newRequest: FinancingRequest = {
        requestId,
        poIssuanceId:     po.issuanceId,
        vendorAddress:    wallet.classicAddress,
        lenderAddress:    financingLenderAddress,
        requestedAmount,
        advanceRate:      financingAdvanceRate,
        termsCID:         ipfsCID,
        requestTxHash:    txHash,
        requestTimestamp: Math.floor(Date.now() / 1000),
        status:           'pending_lender',
      };
      setFinancingRequests(prev => [newRequest, ...prev]);

      console.log(`[requestFinancing] ✅ FINANCE_REQUEST written. RequestId: ${requestId}, Tx: ${txHash}`);
      alert(`✅ Financing request submitted!\n\nRequest ID: ${requestId}\nAmount: $${requestedAmount} RLUSD\nTx: ${txHash}\n\nThe lender will review and respond on-chain.`);
      setShowFinancingModal(false);
      setFinancingModalPO(null);
    } catch (err: any) {
      alert('Financing request failed: ' + err.message);
    } finally {
      setFinancingSubmitting(false);
    }
  };
  const unlinkProfile = async (profileUUID: string) => {
    if (!window.confirm('Remove this link? You can re-link at any time by entering their wallet address again.')) return;
    const profile = publicProfiles[profileUUID];
    if (!profile) return alert('Profile not found');
    const seed = mode === 'customer' ? customerProfile.seed : vendorProfile.seed;
    if (!seed) return alert('Wallet seed required');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const unlinkPayment: Payment = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: profile.classicAddress,
        Amount: '1',
        Memos: [buildMemo(SCPO_ACTIONS.UNLINK_PROFILE, profile.classicAddress, {
          linkedAddr:  profile.classicAddress,
          profileUUID: profile.profileUUID,
          role:        mode as 'vendor' | 'customer',
        })]
      };
      const prepared = await client.autofill(unlinkPayment);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      await submitBlobQueued(signed.tx_blob);

      // Update local state immediately — scanner confirms on next load
      if (mode === 'customer') {
        setCustomerLinkedVendorUUIDs(prev => prev.filter(uuid => uuid !== profileUUID));
        if (selectedLinkedVendor?.profileUUID === profileUUID) setSelectedLinkedVendor(null);
      } else {
        setVendorLinkedCustomerUUIDs(prev => prev.filter(uuid => uuid !== profileUUID));
        if (selectedLinkedCustomer?.profileUUID === profileUUID) setSelectedLinkedCustomer(null);
      }
      console.log(`[unlinkProfile] ✅ UNLINK_PROFILE memo written for ${profile.classicAddress}`);
      alert('Unlinked successfully.');
    } catch (err: any) {
      alert('Unlink failed: ' + err.message);
    }
  };

  useEffect(() => {
    const total = items.reduce((sum, item) => sum + parseFloat(item.total || '0'), 0);
    setTotalEscrowAmount(parseFloat(total.toFixed(2)).toString());
  }, [items]);

  useEffect(() => {
    if (process.env.REACT_APP_COMPANY_WALLET) {
      scanFeeEntries(process.env.REACT_APP_COMPANY_WALLET)
        .then(fees => setFeeEntries(fees))
        .catch(() => setFeeEntries([]));
    }
    // Profile links reconstructed from on-chain LINK_PROFILE memos
    const savedMode = localStorage.getItem('mode');
    if (savedMode) setMode(savedMode as 'customer' | 'vendor');
  }, []);

  useEffect(() => { localStorage.setItem('mode', mode); }, [mode]);

  const addItem = () => {
    if (newItemNum && newQty) {
      let invNFTId: string | undefined = undefined;
      let selectedV2Item: InventoryItemV2 | undefined = undefined;
      if (selectedInventoryItem !== 'custom' && vendor) {
        const v2items = linkedVendorInventoryV2[vendor] || [];
        const v2item = v2items.find(i => i.partNumber === selectedInventoryItem || i.name === selectedInventoryItem);
        if (v2item) {
          invNFTId = v2item.nftId;
          selectedV2Item = v2item;
        } else if (vendorInventories[vendor]) {
          const invItem = vendorInventories[vendor].find(i => i.name === newItemNum);
          invNFTId = invItem?.nftId;
        }
      }

      // Task 3.10 — discontinued confirmation
      if (selectedV2Item?.status === 'discontinued') {
        const confirmed = window.confirm(
          `⛔ "${selectedV2Item.name}" has been marked as discontinued by the vendor.\n\nThis item may no longer be available for fulfillment. Contact the vendor before submitting.\n\nAdd it to the PO anyway?`
        );
        if (!confirmed) return;
      }

      const qty = parseFloat(newQty);
      const piece = parseFloat(newPiecePrice);
      const computedTotal = newTotal
        ? parseFloat(parseFloat(newTotal).toFixed(2)).toString()
        : (qty > 0 && piece > 0 ? parseFloat((qty * piece).toFixed(2)).toString() : '0');
      setItems([...items, { num: newItemNum, qty: newQty, piecePrice: newPiecePrice || undefined, total: computedTotal, invNFTId }]);
      setNewItemNum(''); setNewQty(''); setNewPiecePrice(''); setNewTotal('');
      setSelectedInventoryItem('custom');
    }
  };

  const removeItem = (index: number) => setItems(items.filter((_, i) => i !== index));

// Phase 5: Load POs live from XRPL (now a reusable function)
const loadPOsFromLedger = async () => {
  if (isLoadingPOs.current) {
    return;
  }
  isLoadingPOs.current = true;
  const thisVersion = ++loadPOsVersion.current;
  // Ensure fresh connection
  try {
    const client = await getXRPLClient();
    if (!client.isConnected()) {
      await client.connect();
    }
  } catch (e) {
    console.error('Failed to connect to XRPL:', e);
    isLoadingPOs.current = false;
    return;
  }
  const currentMode = mode;
if (currentMode === 'customer' && !customerProfile.classicAddress) {
  isLoadingPOs.current = false;
  return;
}
if (currentMode === 'vendor' && !vendorProfile.classicAddress) {
  isLoadingPOs.current = false;
  return;
}
  try {
    let livePOs: SavedPO[] = [];
    if (currentMode === 'customer' && customerProfile.classicAddress) {
      const buyerMPTs = await getBuyerPOs(customerProfile.classicAddress);
      // Scan for claimed PO receipts once for all POs
      const claimedPOIds = await getClaimedPOIds(customerProfile.classicAddress);
      const recalledPOIds = await getRecalledPOIds(customerProfile.classicAddress);
      for (const mpt of buyerMPTs as any[]) {
        let meta: any = {};
        try {
          const metadataStr = xrpl.convertHexToString(mpt.MPTokenMetadata || '');
          if (metadataStr) {
            meta = JSON.parse(metadataStr);
            if (meta.ext) {
              try { const ext = JSON.parse(meta.ext); Object.assign(meta, ext); } catch (e) {}
            }
          }
        } catch (e) {}        
        const issuanceId = mpt.MPTokenIssuanceID || mpt.mpt_issuance_id || '';
        let poStatus: SavedPO['status'] = 'open';
        let customerEscrowSequence: number | undefined = undefined;
        const vendorAddr = meta.v || '';
        // Check if vendor has accepted (authorized the MPT)
        if (vendorAddr && issuanceId) {
          try {
            const isHeld = await isMPTHeldByVendor(issuanceId, vendorAddr);
            if (isHeld) {
              poStatus = 'accepted';
              // Match escrow to THIS PO using crypto-condition derived from issuanceId
              try {
                const { condition: expectedCondition } = await generateEscrowCondition(issuanceId);
                const client = await getXRPLClient();
                const escrowResp = await client.request({
                  command: 'account_objects',
                  account: customerProfile.classicAddress,
                  type: 'escrow',
                  ledger_index: 'validated'
                });
                const matchingEscrow = escrowResp.result.account_objects.find((obj: any) => 
                  obj.Destination === vendorAddr && obj.Condition === expectedCondition
                );
                if (matchingEscrow) {
                  poStatus = 'funded';
                  customerEscrowSequence = (matchingEscrow as any).Sequence;
                }
              } catch (e) { /* no escrows or lookup failed */ }
              // Check if this PO was claimed (receipt memo is definitive proof)
              if (claimedPOIds.has(issuanceId)) {
                poStatus = 'claimed';
                // Keep escrowSequence — it's valid historical data needed for proof of payment
              }
            }
          } catch (e) {}
        }

        // Skip recalled POs
        if (recalledPOIds.has(issuanceId)) continue;

        const poInfo1 = meta.dt ? null : await getPOCreationInfo(issuanceId);
          livePOs.push({
            id: issuanceId || Date.now().toString(),
            poName: meta.n || 'PO #' + issuanceId.slice(0, 8),
            dateIssued: meta.dt || poInfo1?.date || new Date().toLocaleDateString(),
            total: meta.amt || meta.total || meta.amount || '0',
            ipfsUri: meta.uri || '',
            status: poStatus,
            escrowSequence: customerEscrowSequence,
            issuanceId,
            txHash: poInfo1?.txHash || '',
            buyerAddress: customerProfile.classicAddress,
          vendorAddress: vendorAddr,
          vendorUUID: customerLinkedVendorUUIDsRef.current.find(uuid => publicProfiles[uuid]?.classicAddress === vendorAddr) || '',
          paymentTerms: meta.pt || '',
          escrowCurrency: (meta.ec === 'RLUSD' ? 'RLUSD' : 'XRP') as 'XRP' | 'RLUSD',
          parentIssuanceId: meta.pid || undefined,
          metadata: meta
        });
      }
     } else if (currentMode === 'vendor' && vendorProfile.classicAddress) {
      const vendorPOList: SavedPO[] = [];
      
      // Check authorized MPTs the vendor already holds
      // Scan for claimed PO receipts once for all POs
      const vendorClaimedPOIds = await getClaimedPOIds(vendorProfile.classicAddress);
      
      try {
        const authorizedMPTs = await getVendorAuthorizedPOs(vendorProfile.classicAddress);
        for (const mpt of authorizedMPTs as any[]) {
        let meta: any = {};
        try {
          const metadataStr = xrpl.convertHexToString(mpt.MPTokenMetadata || '');
          if (metadataStr) {
            meta = JSON.parse(metadataStr);
            if (meta.ext) {
              try { const ext = JSON.parse(meta.ext); Object.assign(meta, ext); } catch (e) {}
            }
          }
        } catch (e) {}
          const issuanceId = mpt.MPTokenIssuanceID || mpt.mpt_issuance_id || '';
          // If no metadata on the MPToken, look up the issuance object
          if (!meta.n && issuanceId) {
            try {
              const client = await getXRPLClient();
              const issuanceResp = await client.request({
                command: 'ledger_entry',
                mpt_issuance: issuanceId,
                ledger_index: 'validated'
              });
              const issuanceNode = issuanceResp.result.node as any;
              if (issuanceNode?.MPTokenMetadata) {
                try {
                  meta = JSON.parse(xrpl.convertHexToString(issuanceNode.MPTokenMetadata));
                  if (meta.ext) {
                    try { const ext = JSON.parse(meta.ext); Object.assign(meta, ext); } catch (e) {}
                  }
                } catch (e) {}
              }
            } catch (e) { console.log('Could not look up issuance metadata for', issuanceId); }
          }
          // Match escrow to THIS PO using crypto-condition derived from issuanceId
          let vendorPoStatus: SavedPO['status'] = 'accepted';
          let vendorEscrowSequence: number | undefined = undefined;
          const posBuyerAddr = meta.b || '';
          if (posBuyerAddr && issuanceId) {
            try {
              const { condition: expectedCondition } = await generateEscrowCondition(issuanceId);
              const client = await getXRPLClient();
              const escrowResp = await client.request({
                command: 'account_objects',
                account: posBuyerAddr,
                type: 'escrow',
                ledger_index: 'validated'
              });
              const matchingEscrow = escrowResp.result.account_objects.find((obj: any) => 
                obj.Destination === vendorProfile.classicAddress && obj.Condition === expectedCondition
              );
              if (matchingEscrow) {
                vendorPoStatus = 'funded';
                vendorEscrowSequence = (matchingEscrow as any).Sequence;
              }
            } catch (e) { /* no escrows or lookup failed */ }
          }
          // Check if this PO was claimed (receipt memo is definitive proof)
          if (issuanceId && vendorClaimedPOIds.has(issuanceId)) {
            vendorPoStatus = 'claimed';
            // Keep escrowSequence — valid historical data needed for proof of payment
          }
          // Check if this PO was recalled by the buyer
          if (issuanceId && posBuyerAddr) {
            try {
              const buyerRecalls = await getRecalledPOIds(posBuyerAddr);
              if (buyerRecalls.has(issuanceId)) continue;
            } catch (e) { /* skip */ }
          }
          const poInfo2 = meta.dt ? null : await getPOCreationInfo(issuanceId);
          vendorPOList.push({
            id: issuanceId || Date.now().toString(),
            poName: meta.n || 'PO #' + issuanceId.slice(0, 8),
            dateIssued: meta.dt || poInfo2?.date || new Date().toLocaleDateString(),
            total: meta.amt || meta.total || meta.amount || '0',
            ipfsUri: meta.uri || '',
            status: vendorPoStatus,
            escrowSequence: vendorEscrowSequence,
            issuanceId,          
            txHash: poInfo2?.txHash || '',
            buyerAddress: meta.b || '',
            vendorAddress: vendorProfile.classicAddress,
            vendorUUID: vendorProfile.profileUUID,
            paymentTerms: meta.pt || '',
            escrowCurrency: (meta.ec === 'RLUSD' ? 'RLUSD' : 'XRP') as 'XRP' | 'RLUSD',
            parentIssuanceId: meta.pid || undefined,
            metadata: meta
          });
        }
      } catch (e) { console.log('No authorized MPTs found'); }
      // Scan linked customers' issuances addressed to this vendor
      // Use pending data if available (passed directly from LinkScanner before React syncs state)
      // Use the most complete UUID list available — never downgrade to empty
      const pendingUUIDs = pendingVendorUUIDsRef.current;
      const refUUIDs = vendorLinkedCustomerUUIDsRef.current;
      const vendorUUIDsToScan = (pendingUUIDs && pendingUUIDs.length > 0)
        ? pendingUUIDs
        : refUUIDs;
      const profilesToScan = pendingPublicProfilesRef.current ?? publicProfilesRef.current;
      // Only clear pending once the ref is synced — prevents downgrade on next load
      if (refUUIDs.length >= (pendingUUIDs?.length ?? 0)) {
        pendingVendorUUIDsRef.current = null;
        pendingPublicProfilesRef.current = null;
      }
      
      for (const uuid of vendorUUIDsToScan) {
        await new Promise(r => setTimeout(r, 500)); // throttle to avoid XRPL timeouts      
        const customerAddr = profilesToScan[uuid]?.classicAddress;
        if (!customerAddr) continue;
        try {
          const buyerRecalledIds = await getRecalledPOIds(customerAddr);
          const buyerMPTs = await getBuyerPOs(customerAddr);
          for (const mpt of buyerMPTs as any[]) {
        let meta: any = {};
        try {
          const metadataStr = xrpl.convertHexToString(mpt.MPTokenMetadata || '');
          if (metadataStr) {
            meta = JSON.parse(metadataStr);
            if (meta.ext) {
              try { const ext = JSON.parse(meta.ext); Object.assign(meta, ext); } catch (e) {}
            }
          }
        } catch (e) {}
            if (meta.v !== vendorProfile.classicAddress) continue;
            const issuanceId = mpt.MPTokenIssuanceID || mpt.mpt_issuance_id || '';
            if (vendorPOList.some(p => p.issuanceId === issuanceId)) continue;
            if (buyerRecalledIds.has(issuanceId)) continue;
            const poInfo3 = meta.dt ? null : await getPOCreationInfo(issuanceId);
            vendorPOList.push({
              id: issuanceId || Date.now().toString(),
              poName: meta.n || 'PO #' + issuanceId.slice(0, 8),
              dateIssued: meta.dt || poInfo3?.date || new Date().toLocaleDateString(),
              total: meta.amt || meta.total || meta.amount || '0',
              ipfsUri: meta.uri || '',
              status: 'open',
              issuanceId,
              txHash: poInfo3?.txHash || '',
              buyerAddress: customerAddr,
              vendorAddress: vendorProfile.classicAddress,
              vendorUUID: vendorProfile.profileUUID,
              paymentTerms: meta.pt || '',
              escrowCurrency: (meta.ec === 'RLUSD' ? 'RLUSD' : 'XRP') as 'XRP' | 'RLUSD',
              parentIssuanceId: meta.pid || undefined,
              metadata: meta
            });
          }
        } catch (e) { console.log(`Failed to scan buyer ${customerAddr}:`, e); }
      }
      
      livePOs = vendorPOList;
    }
    // Mark superseded POs: if any PO has a parentIssuanceId, the parent is superseded
    const parentIds = new Set<string>();
    livePOs.forEach(po => {
      if (po.parentIssuanceId) {
        parentIds.add(po.parentIssuanceId);
      }
    });
    livePOs = livePOs.map(po => {
      if (parentIds.has(po.issuanceId) && po.status !== 'claimed') {
        return { ...po, status: 'superseded' as const };
      }
      return po;
    });
    // Keep recalled POs in savedPOs for history traversal, but mark them so tables filter them out
    // getLatestActivePOs already filters by status, so recalled POs won't show in active tables
    if (thisVersion !== loadPOsVersion.current) {
      
      isLoadingPOs.current = false;
      return;
    }
    setSavedPOs([...livePOs].sort((a, b) => new Date(b.dateIssued).getTime() - new Date(a.dateIssued).getTime()));
    console.log(`✅ [loadPOsFromLedger] COMMITTING ${livePOs.length} POs. Version: ${thisVersion}/${loadPOsVersion.current}. Mode: ${currentMode}`);
    diffPOsForNotifications(livePOs);    
    diffPOsForNotifications(livePOs);
  } catch (err: any) {
    console.error('Failed to load POs from XRPL:', err.message);
  } finally {
    isLoadingPOs.current = false;
  }
};
// Always keep the ref pointing to the latest version of loadPOsFromLedger
// so interval callbacks call the current closure, not a stale one
loadPOsFromLedgerRef.current = loadPOsFromLedger;

// Auto-refresh POs every 45 seconds (ledger is the source of truth)
// Dep array is intentionally minimal — addresses/mode are read via closure inside the callback,
// NOT listed as deps so that a re-render caused by setSavedPOs does not tear down and recreate
// this interval, which was the root cause of the continuous reload loop.
useEffect(() => {
  if (!autoRefreshEnabled) return;
  let cancelled = false;
  const interval = setInterval(() => {
    if (cancelled) return;
    loadPOsFromLedgerRef.current();
  }, 45000);
  return () => {
    cancelled = true;
    clearInterval(interval);
  };
}, [autoRefreshEnabled]);
// Auto-refresh linked profiles every 60 seconds via DID resolution
// IMPORTANT: dep array is ONLY [autoRefreshEnabled] — mode and UUID arrays are read via
// refs so that re-renders caused by setPublicProfiles do not teardown/recreate this interval.
useEffect(() => {
  if (!autoRefreshEnabled) return;
  const interval = setInterval(async () => {
    const allUUIDs = mode === 'customer'
      ? customerLinkedVendorUUIDsRef.current
      : vendorLinkedCustomerUUIDsRef.current;
    for (const uuid of allUUIDs) {
      try {
        await manualRefreshProfile(uuid);
      } catch (e) { /* silent fail on auto-refresh */ }
    }
  }, 60000);
  return () => clearInterval(interval);
}, [autoRefreshEnabled]);

// Keep UUID refs in sync so loadPOsFromLedger always reads current values from stale closures
useEffect(() => { customerLinkedVendorUUIDsRef.current = customerLinkedVendorUUIDs; }, [customerLinkedVendorUUIDs]);
  useEffect(() => { vendorLinkedCustomerUUIDsRef.current = vendorLinkedCustomerUUIDs; }, [vendorLinkedCustomerUUIDs]);
  useEffect(() => { publicProfilesRef.current = publicProfiles; }, [publicProfiles]);

// Trigger load on mode/profile change (only when address actually changes)
const prevCustomerAddr = useRef('');
const prevVendorAddr = useRef('');
const prevMode = useRef(mode);

useEffect(() => {
  const customerChanged = customerProfile.classicAddress !== prevCustomerAddr.current;
  const vendorChanged = vendorProfile.classicAddress !== prevVendorAddr.current;
  const modeChanged = mode !== prevMode.current;

  prevCustomerAddr.current = customerProfile.classicAddress;
  prevVendorAddr.current = vendorProfile.classicAddress;
  prevMode.current = mode;
  
  if (customerChanged || vendorChanged || modeChanged) {
    loadPOsFromLedgerRef.current();
  }
}, [mode, customerProfile.classicAddress, vendorProfile.classicAddress]);

useEffect(() => {
  const checkCred = async () => {
    if (customerProfile.classicAddress && process.env.REACT_APP_DOMAIN_ID) {
      try {
        const result = await validateCredential(customerProfile.classicAddress, process.env.REACT_APP_DOMAIN_ID);
        setCustomerCredStatus(result);
      } catch { setCustomerCredStatus(null); }
    }
    if (vendorProfile.classicAddress && process.env.REACT_APP_DOMAIN_ID) {
      try {
        const result = await validateCredential(vendorProfile.classicAddress, process.env.REACT_APP_DOMAIN_ID);
        setVendorCredStatus(result);
      } catch { setVendorCredStatus(null); }
    }
  };
  checkCred();
}, [customerProfile.classicAddress, vendorProfile.classicAddress]);

    const saveNewPO = (po: SavedPO) => {
    const updated = [...savedPOs, po];
    setSavedPOs(updated);
    // No localStorage - ledger is the source of truth
  };
  const updatePO = (updatedPO: SavedPO) => {
    const updated = savedPOs.map(p => p.id === updatedPO.id ? updatedPO : p);
    setSavedPOs(updated);
  };
  const updatePOStatus = (id: string, status: SavedPO['status']) => {
    const updated = savedPOs.map(p => p.id === id ? { ...p, status } : p);
    setSavedPOs(updated);
  };
  const deleteOpenPO = (id: string) => {
    if (window.confirm('Delete this Open SC.PO from dashboard? (Local only)')) {
      const updated = savedPOs.filter(p => p.id !== id);
      setSavedPOs(updated);
    }
  };
  const recallPO = async (po: SavedPO) => {
    if (po.status === 'funded' || po.status === 'claimed') {
      alert('Cannot recall a funded or claimed PO.');
      return;
    }
    if (po.status === 'accepted') {
      if (!window.confirm('This PO has been accepted. Recalling will cancel it and require the vendor to re-accept if you edit. Continue?')) return;
    } else if (!window.confirm('Recall this PO on-chain?')) return;
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(customerProfile.seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      let newIssuanceId = po.issuanceId;

      if (po.status === 'open') {
        // Open PO: destroy the MPT issuance (no holders, so this works)
        try {
          const destroyTx: any = {
            TransactionType: 'MPTokenIssuanceDestroy',
            Account: wallet.classicAddress,
            MPTokenIssuanceID: po.issuanceId
          };
          const preparedDestroy = await client.autofill(destroyTx);
          preparedDestroy.LastLedgerSequence = currentLedger + 20;
          const signedDestroy = wallet.sign(preparedDestroy);
          await submitBlobQueued(signedDestroy.tx_blob);
          console.log('MPT issuance destroyed (open PO recall)');
        } catch (e: any) {
          console.error('Destroy failed, sending recall receipt instead:', e.message);
          // Fallback: send recall receipt memo so loadPOsFromLedger filters it out
          try {
            const recallDest = po.vendorAddress || process.env.REACT_APP_COMPANY_WALLET || wallet.classicAddress;
            const recallReceipt: Payment = {
              TransactionType: 'Payment',
              Account: wallet.classicAddress,
              Destination: recallDest,
              Amount: '1',
              Memos: [buildMemo(SCPO_ACTIONS.RECALL_PO, po.issuanceId, {})]
            };
            const preparedRecall = await client.autofill(recallReceipt);
            preparedRecall.LastLedgerSequence = currentLedger + 20;
            const signedRecall = wallet.sign(preparedRecall);
            await submitBlobQueued(signedRecall.tx_blob);
            console.log('Recall receipt memo sent on-chain (fallback)');
          } catch (e2) { console.error('Recall receipt also failed:', e2); }
        }
        updatePO({ ...po, status: 'recalled', escrowSequence: undefined });
        alert('PO recalled on-chain.');
        setTimeout(() => loadPOsFromLedger(), 2000);
        return;
      }

      // Accepted PO: clawback first, then create recalled version
      try {
        const clawbackTx: any = {
          TransactionType: 'Clawback',
          Account: wallet.classicAddress,
          Amount: {
            mpt_issuance_id: po.issuanceId,
            value: '1'
          },
          Holder: po.vendorAddress
        };
        const preparedClaw = await client.autofill(clawbackTx);
        preparedClaw.LastLedgerSequence = currentLedger + 20;
        const signedClaw = wallet.sign(preparedClaw);
        await submitBlobQueued(signedClaw.tx_blob);
        console.log('Clawback successful');
      } catch (e: any) {
        console.error('Clawback failed:', e.message);
      }

      if (po.status === 'accepted') {
        // No new MPT needed — clawback + recall receipt memo is sufficient
        // loadPOsFromLedger filters by SCPO_RECALL memos
      }

      // Send recall receipt memo to vendor (permanent on-chain proof)
      try {
        const recallDest = po.vendorAddress || process.env.REACT_APP_COMPANY_WALLET || wallet.classicAddress;
        const recallReceipt: Payment = {
          TransactionType: 'Payment',
          Account: wallet.classicAddress,
          Destination: recallDest,
          Amount: '1',
          Memos: [buildMemo(SCPO_ACTIONS.RECALL_PO, po.issuanceId, {})]
        };
        const preparedRecall = await client.autofill(recallReceipt);
        preparedRecall.LastLedgerSequence = currentLedger + 20;
        const signedRecall = wallet.sign(preparedRecall);
        await submitBlobQueued(signedRecall.tx_blob);
        console.log('Recall receipt memo sent on-chain');
      } catch (e) {
        console.error('Failed to send recall receipt:', e);
      }
      // Also recall parent PO if this is an updated version
      if (po.parentIssuanceId) {
        try {
          const parentRecallDest = po.vendorAddress || process.env.REACT_APP_COMPANY_WALLET || wallet.classicAddress;
          const parentRecallReceipt: Payment = {
            TransactionType: 'Payment',
            Account: wallet.classicAddress,
            Destination: parentRecallDest,
            Amount: '1',
            Memos: [buildMemo(SCPO_ACTIONS.RECALL_PO, po.parentIssuanceId ?? '', {})]
          };
          const preparedParentRecall = await client.autofill(parentRecallReceipt);
          preparedParentRecall.LastLedgerSequence = currentLedger + 20;
          const signedParentRecall = wallet.sign(preparedParentRecall);
          await submitBlobQueued(signedParentRecall.tx_blob);
          console.log('Parent PO recall receipt sent:', po.parentIssuanceId);
        } catch (e) {
          console.error('Failed to send parent recall receipt:', e);
        }
      
        updatePO({ ...po, status: 'recalled', escrowSequence: undefined });
        alert('PO recalled on-chain.');
        setTimeout(() => loadPOsFromLedger(), 2000);
        return;
      }
    } catch (err: any) { alert('Recall failed: ' + err.message); }
  };
  const viewPOFromUri = async (uri: string, po: SavedPO | null, setViewedPO: React.Dispatch<React.SetStateAction<POData | null>>, setPoLoadError: React.Dispatch<React.SetStateAction<string | null>>) => {
    setIpfsUri(uri);
    setViewedPO(null);
    setPoLoadError(null);
    const hash = uri.replace('ipfs://', '');
    const gateways = [`https://gateway.pinata.cloud/ipfs/${hash}`];
    let encryptedData;
    for (const gatewayUrl of gateways) {
      try {
        const response = await fetch(gatewayUrl, { cache: 'no-store' });
        if (response.ok) { const data = await response.json(); encryptedData = data.encryptedData; break; }
      } catch (err: any) { console.error(`Failed to fetch from ${gatewayUrl}:`, err.message); }
    }
    if (!encryptedData) { setPoLoadError('Failed to fetch from all IPFS gateways.'); return; }
    try {
      let password;
      if (po) {
        if (mode === 'vendor') { password = po.vendorUUID ? getPOEncryptionKey(po.vendorUUID) : null; } else { password = po.vendorUUID ? getPOEncryptionKey(po.vendorUUID) : null; }
        if (!password) throw new Error('No shared password found');
        const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
        if (!decrypted) throw new Error('Decryption failed');
        const poData: POData = JSON.parse(decrypted);
        setViewedPO(poData);
      }
    } catch (err: any) { setPoLoadError('Decryption failed: ' + err.message); }
  };
   const prefillFromPO = async (po: SavedPO) => {
    setIsLoadingEditPO(true);
    // Don't set any form fields yet — wait for IPFS data first
    let loadedName = po.poName;
    let loadedDesc = '';
    let loadedDept = '1';
    let loadedPayTerms = po.metadata?.pt || po.paymentTerms || '';
    let loadedDelTerms = 'FOB';
    let loadedItems: Item[] = [];

    if (po.ipfsUri) {
      try {
        let password;
        password = po.vendorUUID ? getPOEncryptionKey(po.vendorUUID) : null;
        if (password) {
          const hash = po.ipfsUri.replace('ipfs://', '');
          const response = await fetch(`https://gateway.pinata.cloud/ipfs/${hash}`, { cache: 'no-store' });
          if (response.ok) {
            const data = await response.json();
            const decrypted = CryptoJS.AES.decrypt(data.encryptedData, password).toString(CryptoJS.enc.Utf8);
            if (decrypted) {
              const poData: POData = JSON.parse(decrypted);
              loadedName = poData.poName || po.poName;
              loadedDesc = poData.description || '';
              loadedDept = poData.department || '1';
              loadedPayTerms = poData.paymentTerms || '';
              loadedDelTerms = poData.deliveryTerms || 'FOB';
              loadedItems = poData.items || [];
            }
          }
        }
      } catch (e) {
        console.error('Failed to load PO details from IPFS for edit:', e);
      }
    }

    // Set all fields at once — no double refresh
    setPoName(loadedName);
    setDesc(loadedDesc);
    setDepartment(loadedDept);
    setPaymentTerms(loadedPayTerms);
    setDeliveryTerms(loadedDelTerms);
    setEscrowCurrency(po.escrowCurrency || (isRLUSDConfigured() ? 'RLUSD' : 'XRP'));
    setItems(loadedItems);
    setIsLoadingEditPO(false);
  };

  const createSCPO = async () => {
    if (!poName) return alert('PO Name is required');
    if (!seed) return alert('Wallet seed required');
    if (!vendor) return alert('Vendor address required');
    if (!selectedVendorUUID || !getPOEncryptionKey(selectedVendorUUID)) return alert('Link vendor first');
    if (items.length === 0) return alert('Add at least one item');
    if (parseFloat(totalEscrowAmount) <= 0) return alert('Total > 0');
    if (!paymentTerms) return alert('Select Payment Terms');

    // Phase 1B: Verify both buyer and vendor hold valid credentials
    const wallet = xrpl.Wallet.fromSeed(seed);
    const credCheck = await canCreatePO(wallet.classicAddress, vendor);
    if (!credCheck.allowed) {
      return alert(`Cannot create PO: ${credCheck.reason}\n\nBoth parties must have a valid credential in the SC.PO domain. Save your profile to get one.`);
    }

    const feeUsd = 0.01;
    let feeAmount: any;
    let feeLabel: string;
    if (escrowCurrency === 'RLUSD' && isRLUSDConfigured()) {
      const rlusd = getRLUSDCurrency();
      feeAmount = { currency: rlusd.currency, issuer: rlusd.issuer, value: feeUsd.toString() };
      feeLabel = `$${feeUsd.toFixed(2)} RLUSD`;
    } else {
      const xrpPriceUsd = await getXrpPriceUsd();
      const feeXrp = feeUsd / xrpPriceUsd;
      feeAmount = xrpl.xrpToDrops(feeXrp.toFixed(6));
      feeLabel = `$${feeUsd.toFixed(2)} USD (${feeXrp.toFixed(6)} XRP)`;
    }
    let attachments: Attachment[] = [];
    if (selectedFiles && selectedFiles.length > 0) {
      setResult('Uploading attachments...');
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        try { const uri = await uploadFileToIPFS(file); attachments.push({ name: file.name, uri }); } catch (err: any) { alert('Failed to upload attachment: ' + err.message); return; }
      }
    }
    const poData: POData = { poName, description: desc, department, paymentTerms, deliveryTerms, escrowCurrency, items, attachments: attachments.length > 0 ? attachments : undefined };
    try {
      setResult('Encrypting and uploading PO data to IPFS...');
      const password = getPOEncryptionKey(selectedVendorUUID)!;
      const ipfsUri = await uploadEncryptedToIPFS(poData, password);
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      setResult(`Sending $0.01 creation fee...`);
      const feePayment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: process.env.REACT_APP_COMPANY_WALLET || '', Amount: feeAmount, Memos: [buildMemo(SCPO_ACTIONS.FEE_PAYMENT, wallet.classicAddress, { poName, feeType: 'CREATE', amount: feeLabel })] };
      const preparedFee = await client.autofill(feePayment); preparedFee.LastLedgerSequence = currentLedger + 20;
      const signedFee = wallet.sign(preparedFee);
      const feeResult = await submitBlobQueued(signedFee.tx_blob);
      if (typeof feeResult.result.meta === 'object' && feeResult.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Fee failed');
      setResult('Creating MPToken Issuance...');
      const fullMetadata = buildPOMetadata(poName, desc, department, paymentTerms, deliveryTerms, items, attachments, wallet.classicAddress, vendor, 'open', undefined, true);
      const ledgerMetadata = buildLedgerMetadata(poName, ipfsUri, 'open', wallet.classicAddress, vendor, totalEscrowAmount, paymentTerms, undefined, escrowCurrency);
      const mptCreate: any = {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: wallet.classicAddress,
        MPTokenMetadata: xrpl.convertStringToHex(JSON.stringify(ledgerMetadata)),
        MaximumAmount: '1',
        AssetScale: 0,
        TransferFee: 0,
        Flags: xrpl.MPTokenIssuanceCreateFlags.tfMPTCanClawback
      };
      const preparedCreate = await client.autofill(mptCreate); preparedCreate.LastLedgerSequence = currentLedger + 20;
      const signedCreate = wallet.sign(preparedCreate);
      const createResult = await submitBlobQueued(signedCreate.tx_blob);
      if (typeof createResult.result.meta === 'object' && createResult.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('IssuanceCreate failed');
      const meta = createResult.result.meta as any;
      if (!meta || meta.TransactionResult !== "tesSUCCESS") {
        throw new Error("Issuance transaction failed on-chain.");
      }
      let issuanceId = meta.mpt_issuance_id || '';
      if (!issuanceId) {
        const affectedNodes = meta.AffectedNodes || [];
        for (const node of affectedNodes) {
          if (node.CreatedNode && node.CreatedNode.LedgerEntryType === "MPTokenIssuance") {
            issuanceId = node.CreatedNode.NewFields.MPTokenIssuanceID;
            break;
          }
        }
      }
      if (!issuanceId || issuanceId.length !== 48) {
        console.error("Failed to extract 48-char MPT ID. Full Meta:", meta);
        throw new Error("Could not capture a valid MPTokenIssuanceID (Expected 48 chars).");
      }
      
      const txHash = createResult.result.hash;
      const newPO: SavedPO = { id: Date.now().toString(), poName, dateIssued: new Date().toLocaleDateString(), total: totalEscrowAmount, ipfsUri, status: 'open', issuanceId, txHash, buyerAddress: wallet.classicAddress, vendorAddress: vendor, paymentTerms, escrowCurrency, vendorUUID: selectedVendorUUID, clawbackEnabled: true, yieldOptIn: yieldOptIn && escrowCurrency === 'RLUSD', metadata: fullMetadata };
      saveNewPO(newPO);
      const newFee: FeeEntry = { date: new Date().toLocaleString(), poName, amount: feeLabel, txHash: feeResult.result.hash };
      setFeeEntries(prev => [...prev, newFee]);

      // ── Phase 6A: Write yield intent memo on-chain at PO creation ────────────
      // This is the canonical on-chain record of yield opt-in intent.
      // fundEscrow scans for this memo to know whether to activate yield.
      if (yieldOptIn && escrowCurrency === 'RLUSD') {
        try {
          const yieldIntentPayment: Payment = {
            TransactionType: 'Payment',
            Account: wallet.classicAddress,
            Destination: process.env.REACT_APP_COMPANY_WALLET || wallet.classicAddress,
            Amount: '1',
            Memos: [buildMemo(SCPO_ACTIONS.YIELD_OPT_IN, issuanceId, {
              posId: uuidv4(),
              pid:   selectedPartnerId,
              apr:   yieldOptInAPR || 0,
              est:   0,
              amt:   items.reduce((sum, item) => sum + parseFloat(item.total || '0'), 0).toFixed(2),
            } as any)]
          };
          const preparedIntent = await client.autofill(yieldIntentPayment);
          preparedIntent.LastLedgerSequence = currentLedger + 20;
          const signedIntent = wallet.sign(preparedIntent);
          await submitBlobQueued(signedIntent.tx_blob);
          console.log(`[createSCPO] Yield intent memo written on-chain for issuanceId: ${issuanceId}`);
        } catch (yieldErr: any) {
          console.warn('[createSCPO] Yield intent memo failed (PO still created):', yieldErr.message);
        }
      }

      setResult(`SC.PO Created Successfully!\nIssuance ID: ${issuanceId}\nTx Hash: ${txHash}\nIPFS URI: ${ipfsUri}\n\nVendor must now ACCEPT to authorize.`);
      setScpoSuccess(true); setTimeout(() => setScpoSuccess(false), 3000);
      setItems([]); localStorage.removeItem('createItems');
      setYieldOptIn(false); setYieldOptInAPR(null); setYieldEstimatedReturn(null);
    } catch (err: any) { alert('Operation failed: ' + err.message); setResult('Error: ' + err.message); }
  };

  const updateSCPO = async () => {
    if (!selectedUpdatePO) return alert('Select a PO to update');
    if (!poName) return alert('PO Name is required');
    if (items.length === 0) return alert('Add at least one item');
    const password = getPOEncryptionKey(selectedUpdatePO.vendorUUID || '') || '';
    if (!password) return alert('Vendor password missing');
    let attachments: Attachment[] = [];
    if (selectedFiles && selectedFiles.length > 0) {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        try { const uri = await uploadFileToIPFS(file); attachments.push({ name: file.name, uri }); } catch (err: any) { alert('Failed to upload attachment: ' + err.message); return; }
      }
    }
    const poData: POData = { poName, description: desc, department, paymentTerms, deliveryTerms, escrowCurrency, items, attachments: attachments.length > 0 ? attachments : undefined };
    try {
      setUpdateResult('Encrypting and uploading updated PO...');
      const ipfsUri = await uploadEncryptedToIPFS(poData, password);
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed || customerProfile.seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      
      updatePO({ ...selectedUpdatePO, status: 'superseded', escrowSequence: undefined });
      setSavedPOs([...savedPOs]);
      if (selectedUpdatePO.status === 'accepted') {
        setUpdateResult('Clawing back old PO version...');
        try {
          const clawbackTx: any = {
            TransactionType: 'Clawback',
            Account: wallet.classicAddress,
            Amount: { mpt_issuance_id: selectedUpdatePO.issuanceId, value: '1' },
            Holder: selectedUpdatePO.vendorAddress
          };
          const preparedClaw = await client.autofill(clawbackTx);
          preparedClaw.LastLedgerSequence = currentLedger + 20;
          const signedClaw = wallet.sign(preparedClaw);
          await submitBlobQueued(signedClaw.tx_blob);
          console.log('Clawback successful for update');
        } catch (e: any) { console.error('Clawback failed during update:', e.message); }
        // Send recall receipt so old version is filtered out
        try {
          const recallDest = selectedUpdatePO.vendorAddress || wallet.classicAddress;
          const recallReceipt: Payment = {
            TransactionType: 'Payment',
            Account: wallet.classicAddress,
            Destination: recallDest,
            Amount: '1',
            Memos: [buildMemo(SCPO_ACTIONS.RECALL_PO, selectedUpdatePO.issuanceId, {})]
          };
          const preparedRecall = await client.autofill(recallReceipt);
          preparedRecall.LastLedgerSequence = currentLedger + 20;
          const signedRecall = wallet.sign(preparedRecall);
          await submitBlobQueued(signedRecall.tx_blob);
          console.log('Recall receipt sent for updated PO');
        } catch (e) { console.error('Recall receipt failed during update:', e); }
      }
      const fullMetadata = buildPOMetadata(poName, desc, department, paymentTerms, deliveryTerms, items, attachments, wallet.classicAddress, selectedUpdatePO.vendorAddress, 'open', selectedUpdatePO.issuanceId, true, selectedUpdatePO.metadata?.history || []);
      const ledgerMetadata = buildLedgerMetadata(poName, ipfsUri, 'open', wallet.classicAddress, selectedUpdatePO.vendorAddress, totalEscrowAmount, paymentTerms, selectedUpdatePO.issuanceId, escrowCurrency);
      const mptCreate: any = {
        TransactionType: 'MPTokenIssuanceCreate',
        Account: wallet.classicAddress,
        MPTokenMetadata: xrpl.convertStringToHex(JSON.stringify(ledgerMetadata)),
        MaximumAmount: '1',
        AssetScale: 0,
        TransferFee: 0,
        Flags: xrpl.MPTokenIssuanceCreateFlags.tfMPTCanClawback
      };
      const preparedCreate = await client.autofill(mptCreate); preparedCreate.LastLedgerSequence = currentLedger + 20;
      const signedCreate = wallet.sign(preparedCreate);
      const createResult = await submitBlobQueued(signedCreate.tx_blob);
      if (typeof createResult.result.meta === 'object' && createResult.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('IssuanceCreate failed');
      const meta = createResult.result.meta as any;
      if (!meta || meta.TransactionResult !== "tesSUCCESS") {
        throw new Error("Issuance transaction failed on-chain.");
      }
      let issuanceId = meta.mpt_issuance_id || '';
      if (!issuanceId) {
        const affectedNodes = meta.AffectedNodes || [];
        for (const node of affectedNodes) {
          if (node.CreatedNode && node.CreatedNode.LedgerEntryType === "MPTokenIssuance") {
            issuanceId = node.CreatedNode.NewFields.MPTokenIssuanceID;
            break;
          }
        }
      }
      if (!issuanceId || issuanceId.length !== 48) {
        console.error("Failed to extract 48-char MPT ID. Full Meta:", meta);
        throw new Error("Could not capture a valid MPTokenIssuanceID (Expected 48 chars).");
      }
      const txHash = createResult.result.hash;
      const newPO: SavedPO = { id: Date.now().toString(), poName, dateIssued: new Date().toLocaleDateString(), total: totalEscrowAmount, ipfsUri, status: 'open', issuanceId, txHash, buyerAddress: wallet.classicAddress, vendorAddress: selectedUpdatePO.vendorAddress, paymentTerms, escrowCurrency, vendorUUID: selectedUpdatePO.vendorUUID, clawbackEnabled: true, parentIssuanceId: selectedUpdatePO.issuanceId, metadata: fullMetadata };
      saveNewPO(newPO);
      const memoPayment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: selectedUpdatePO.vendorAddress, Amount: '1', Memos: [buildMemo(SCPO_ACTIONS.UPDATE_PO, issuanceId, { oldRef: selectedUpdatePO.issuanceId, poName })] };
      const preparedMemo = await client.autofill(memoPayment); preparedMemo.LastLedgerSequence = currentLedger + 20;
      const signedMemo = wallet.sign(preparedMemo);
      await submitBlobQueued(signedMemo.tx_blob);
      setUpdateResult(`PO Updated and Sent Successfully! New Issuance: ${issuanceId}\nTx Hash: ${txHash}\n\nVendor notified to re-accept. Old version hidden.`);
      setSelectedUpdatePO(null);
      // Immediate refresh to update tables
      setTimeout(() => loadPOsFromLedger(), 2000);
    } catch (err: any) { alert('Update failed: ' + err.message); setUpdateResult('Error: ' + err.message); }
  };

  const acceptMPTOfferForPO = async (po: SavedPO) => {
    if (po.status === 'superseded') return alert('This PO version is superseded. Use the latest version.');
    if (!po.issuanceId || po.issuanceId.length !== 48) {
      return alert('Invalid or missing MPTokenIssuanceID on this PO.');
    }
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const authorizeTx: any = {
        TransactionType: 'MPTokenAuthorize',
        Account: wallet.classicAddress,
        MPTokenIssuanceID: po.issuanceId,
        Memos: [buildMemo(SCPO_ACTIONS.ACCEPT_PO, po.issuanceId, { poName: po.poName, buyerAddress: po.buyerAddress })]
      };
      console.log('Vendor Authorize Tx payload:', JSON.stringify(authorizeTx, null, 2));
      const prepared = await client.autofill(authorizeTx);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const acceptResultTx = await submitBlobQueued(signed.tx_blob);
      if (typeof acceptResultTx.result.meta === 'object' && acceptResultTx.result.meta.TransactionResult === 'tesSUCCESS') {
        alert(`PO ${po.poName} Accepted & Authorized!`); updatePOStatus(po.id, 'accepted');
      } else { alert('Accept failed'); }
    } catch (err: any) { alert('Accept failed: ' + err.message); }
  };

  const isMPTHeldByVendor = async (issuanceId: string, vendorAddress: string): Promise<boolean> => {
    try {
      const client = await getXRPLClient();
      const response = await client.request({ command: 'account_objects', account: vendorAddress, type: 'mptoken', ledger_index: 'validated' });
      return response.result.account_objects.some((obj: any) => obj.MPTokenIssuanceID === issuanceId);
    } catch { return false; }
  };

// ── Task 2.3: Fund Escrow with RLUSD or XRP ──────────────────
  const fundEscrow = async (po: SavedPO) => {
    if (po.status === 'superseded') return alert('This PO version is superseded. Use the latest version.');
    const isHeld = await isMPTHeldByVendor(po.issuanceId, po.vendorAddress);
    if (!isHeld) return alert('Vendor has not accepted the MPT yet');
    if (!seed) return alert('Wallet seed required');
    const totalNum = parseFloat(po.total || '0');
    if (totalNum <= 0) return alert('PO total must be greater than 0. Current value: ' + po.total);

    // Determine currency for this PO
    const currency = po.escrowCurrency || 'XRP';
    let escrowAmount: any;

    if (currency === 'RLUSD') {
      // ── RLUSD path: check trust lines first ──
      setResult('Checking RLUSD trust lines...');
      const readiness = await canUseRLUSDEscrow(
        xrpl.Wallet.fromSeed(seed).classicAddress,
        po.vendorAddress
      );

      if (!readiness.ready) {
        // Offer to set up trust lines
        const setupMsg = readiness.reason + '\n\nWould you like to set up the missing trust line now?';
        if (!window.confirm(setupMsg)) return;

        // Set up missing trust lines
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(seed);

        if (!readiness.buyerTrustLine) {
          setResult('Setting up buyer RLUSD trust line...');
          const result = await setupRLUSDTrustLine(client, wallet);
          if (!result.success) return alert('Failed to set up buyer trust line: ' + result.error);
        }

        if (!readiness.vendorTrustLine) {
          alert('The vendor also needs a RLUSD trust line before receiving payment. They will need to set this up from their profile. Falling back to XRP escrow.');
          // Fall back to XRP
          setEscrowCurrency('XRP');
          return;
        }
      }

      // Check buyer has enough RLUSD
      const balance = await getRLUSDBalance(xrpl.Wallet.fromSeed(seed).classicAddress);
      if (parseFloat(balance) < totalNum) {
        return alert(`Insufficient RLUSD balance. You have $${balance} RLUSD but need $${totalNum}.`);
      }

      // RLUSD Amount format for token escrow
      const rlusd = getRLUSDCurrency();
      escrowAmount = {
        currency: rlusd.currency,
        issuer: rlusd.issuer,
        value: parseFloat(totalNum.toFixed(2)).toString()
      };
      console.log(`Funding escrow: $${totalNum} RLUSD (1:1 USD)`);

    } else {
      // ── XRP path: existing behavior ──
      const xrpPriceUsd = await getXrpPriceUsd();
      const xrpAmount = (totalNum / xrpPriceUsd).toFixed(6);
      escrowAmount = xrpl.xrpToDrops(xrpAmount);
      console.log(`Funding escrow: $${totalNum} USD = ${xrpAmount} XRP = ${escrowAmount} drops`);
    }

    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const closedLedgerResponse = await client.request({ command: 'ledger', ledger_index: 'closed' });
      const currentRippleTime = closedLedgerResponse.result.ledger.close_time;
      const daysParsed = parseInt(po.paymentTerms?.split(' ')[0]);
      const days = isNaN(daysParsed) ? 30 : daysParsed;
      console.log(`Escrow terms: ${days} days, paymentTerms: "${po.paymentTerms}"`);
      const buffer = 60; const finishRipple = currentRippleTime + (days * 86400) + buffer; const cancelRipple = finishRipple + (7 * 86400);
      const { condition, fulfillment } = await generateEscrowCondition(po.issuanceId);
      console.log(`Escrow linked to PO via condition. IssuanceID: ${po.issuanceId}`);
      const escrow: any = { TransactionType: 'EscrowCreate', Account: wallet.classicAddress, Destination: po.vendorAddress, Amount: escrowAmount, FinishAfter: finishRipple, CancelAfter: cancelRipple, Condition: condition, Memos: [buildMemo(SCPO_ACTIONS.FUND_ESCROW, po.issuanceId, { poName: po.poName, amount: po.total, currency, terms: po.paymentTerms, ipfs: po.ipfsUri, itemCount: po.metadata?.items?.length || 0 })] };
      const preparedEscrow = await client.autofill(escrow); preparedEscrow.LastLedgerSequence = currentLedger + 20;
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await submitBlobQueued(signedEscrow.tx_blob);
      if (typeof escrowResult.result.meta === 'object' && escrowResult.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Escrow creation failed: ' + (escrowResult.result.meta as any).TransactionResult);
      const escrowSequence = escrowResult.result.tx_json.Sequence as number;
      setResult('Delivering PO (MPT) to Vendor...');
      const paymentTx: any = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: po.vendorAddress,
        Amount: {
          mpt_issuance_id: po.issuanceId,
          value: '1'
        }
      };
      const preparedPayment = await client.autofill(paymentTx); preparedPayment.LastLedgerSequence = currentLedger + 20;
      const signedPayment = wallet.sign(preparedPayment);
      const paymentResult = await submitBlobQueued(signedPayment.tx_blob);
      if (typeof paymentResult.result.meta === 'object' && paymentResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        // Escrow created but MPT delivery failed — store recovery state
        setPendingEscrowRecovery({ po, escrowSequence, escrowTxHash: escrowResult.result.hash });
        alert(`⚠️ Escrow was funded successfully but MPT delivery to vendor failed.\n\nYour funds are safe — the escrow is on-chain.\n\nUse the "Resume Delivery" button to retry MPT delivery without re-funding.`);
        return;
      }
      updatePO({ ...po, escrowSequence, status: 'funded' });
      setPendingEscrowRecovery(null);

      // ── Phase 6A: Yield opt-in (RLUSD escrows only) ───────────────────────
      // ── Phase 6A: Check on-chain for yield intent memo written at PO creation
      let yieldIntentOnChain = false;
      let yieldIntentPositionId = uuidv4();
      let yieldIntentAPR = 0;
      try {
        const client2 = await getXRPLClient();
        const txHistory = await client2.request({
          command: 'account_tx',
          account: wallet.classicAddress,
          limit: 200,
        });
        for (const txEntry of txHistory.result.transactions) {
          const tx = txEntry.tx_json as any;
          if (!tx?.Memos?.length) continue;
          for (const memoWrapper of tx.Memos) {
            const memo = parseMemo(memoWrapper.Memo);
            if (!memo) continue;
            if ((memo.a as string) === SCPO_ACTIONS.YIELD_OPT_IN && memo.r === po.issuanceId) {
              yieldIntentOnChain = true;
              yieldIntentPositionId = (memo.p as any).posId || yieldIntentPositionId;
              yieldIntentAPR = (memo.p as any).apr || 0;
              break;
            }
          }
          if (yieldIntentOnChain) break;
        }
      } catch (scanErr) {
        console.warn('[fundEscrow] Could not scan for yield intent memo:', scanErr);
      }
      console.log('[fundEscrow] yield check — on-chain intent:', yieldIntentOnChain, '| currency:', currency);
      if (yieldIntentOnChain && currency === 'RLUSD') {
        try {
          const adapter = yieldPartnerRegistry.get(selectedPartnerId);
          if (adapter) {
            const positionId = yieldIntentPositionId;
            const aprResult = await adapter.getCurrentAPR();
            const apr = yieldIntentAPR > 0 ? yieldIntentAPR : aprResult.apr;
            // No second YIELD_OPT_IN memo here — the canonical one was written at PO creation.
            const companyWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED || '');
            await adapter.depositPrincipal(po.total, positionId, companyWallet);
            const newPosition: YieldPosition = {
              positionId, poIssuanceId: po.issuanceId, escrowSequence,
              buyerAddress: wallet.classicAddress, vendorAddress: po.vendorAddress,
              principalAmount: po.total, lockedAPR: apr, partnerId: selectedPartnerId,
              optInTxHash: '', optInTimestamp: Math.floor(Date.now() / 1000),
              estimatedClaimDate: finishRipple + 946684800, status: 'accruing',
            };
            setYieldPositions(prev => [newPosition, ...prev]);
            setYieldOptIn(false);
          }
        } catch (yieldErr: any) {
          console.error('[fundEscrow] Yield opt-in failed (escrow still funded):', yieldErr);
          alert(`⚠️ Escrow funded successfully but yield opt-in failed: ${yieldErr.message}\n\nYour escrow is safe.`);
        }
      }

      const currencyLabel = currency === 'RLUSD' ? `$${totalNum} RLUSD` : `${xrpl.dropsToXrp(escrowAmount)} XRP`;
      alert(`Escrow funded (${currencyLabel}) & PO delivered! Sequence: ${escrowSequence}`);
    } catch (err: any) { alert('Failed to fund escrow: ' + err.message); }
  };

  // ── Task 4.9: Event Notifications ──
  const addNotification = (message: string, type: 'info' | 'success' | 'warning' = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setNotifications(prev => [{ id, message, type, timestamp: Date.now(), read: false }, ...prev].slice(0, 50));
  };

  const diffPOsForNotifications = (newPOs: SavedPO[]) => {
    const prev = knownPOStates.current;
    const isFirstLoad = Object.keys(prev).length === 0;
    for (const po of newPOs) {
      const prevStatus = prev[po.issuanceId];
      if (!prevStatus) {
        // New PO appeared
        if (!isFirstLoad) {
          if (mode === 'vendor') addNotification(`📋 New PO received: ${po.poName}`, 'info');
          if (mode === 'customer') addNotification(`✅ PO created on-chain: ${po.poName}`, 'success');
        }
      } else if (prevStatus !== po.status) {
        // Status changed
        if (po.status === 'accepted') addNotification(`✅ ${po.poName} accepted by vendor`, 'success');
        if (po.status === 'funded') addNotification(`💰 Escrow funded for ${po.poName}`, 'success');
        if (po.status === 'claimed') addNotification(`🎉 ${po.poName} claimed — payment complete`, 'success');
        if (po.status === 'recalled') addNotification(`⚠️ ${po.poName} was recalled`, 'warning');
      }
      prev[po.issuanceId] = po.status;
    }
  };
  // ── Task 4.5: Escrow Recovery — retry MPT delivery after partial failure ──
  const resumeEscrowDelivery = async () => {
    if (!pendingEscrowRecovery) return;
    const { po, escrowSequence } = pendingEscrowRecovery;
    setRecoveryLoading(true);
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const currentLedger = (await client.request({ command: 'ledger_current' })).result.ledger_current_index;
      const paymentTx: any = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: po.vendorAddress,
        Amount: { mpt_issuance_id: po.issuanceId, value: '1' }
      };
      const preparedPayment = await client.autofill(paymentTx);
      preparedPayment.LastLedgerSequence = currentLedger + 20;
      const signedPayment = wallet.sign(preparedPayment);
      const paymentResult = await submitBlobQueued(signedPayment.tx_blob);
      if (typeof paymentResult.result.meta === 'object' && paymentResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error('MPT Delivery retry failed: ' + paymentResult.result.meta.TransactionResult);
      }
      updatePO({ ...po, escrowSequence, status: 'funded' });
      setPendingEscrowRecovery(null);
      alert(`✅ MPT delivery recovered successfully! PO is now funded.`);
    } catch (err: any) {
      alert(`Recovery failed: ${err.message}\n\nPlease contact support with escrow tx: ${pendingEscrowRecovery.escrowTxHash}`);
    } finally {
      setRecoveryLoading(false);
    }
  };
  // ── Task 2.4: Claim Escrow (supports both XRP and RLUSD) ──
  // ── Phase 6.0c: Pre-claim routing check added ──────────────────────────────
  const claimEscrowForPO = async (po: SavedPO) => {
    if (po.status === 'superseded') return alert('This PO version is superseded. Use the latest version.');

    // ── Phase 6.0c: Check for active yield position before claiming ───────────
    let preClaimConditions: Awaited<ReturnType<typeof checkPreClaimConditions>> | null = null;
    try {
      preClaimConditions = await checkPreClaimConditions(po.buyerAddress, po.issuanceId);
    } catch (e) {
      console.warn('[claimEscrowForPO] Pre-claim check failed, proceeding without yield withdrawal:', e);
    }

    if (preClaimConditions?.hasYield && preClaimConditions.yieldPosition) {
      const position = preClaimConditions.yieldPosition;
      const adapter = yieldPartnerRegistry.get(position.partnerId);
      if (adapter) {
        setResult('Withdrawing yield position before claim...');
        try {
          const companyWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED || '');
          const withdrawResult = await adapter.withdrawPrincipal(
            position.principalAmount,
            position.positionId,
            companyWallet
          );
          if (withdrawResult.success) {
            const grossYield = withdrawResult.grossYield || '0.00';
            const { partnerFee, scpoFee, netToBuyer } = computeYieldDistribution(grossYield, adapter);
            console.log(`[claimEscrowForPO] Yield withdrawn: principal=${position.principalAmount}, gross=${grossYield}, net=${netToBuyer}`);

            // Write YIELD_RETURN memo from vendor wallet → buyer wallet.
            // Vendor wallet is always available at claim time and avoids self-payment
            // conflicts regardless of which partner adapter is used.
            // Real partners return their own txHash via withdrawResult.txHash —
            // this memo is the on-chain audit record on top of that.
            let yieldReturnTxHash = withdrawResult.txHash;
            try {
              const yieldReturnClient = await getXRPLClient();
              const yieldReturnWallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
              const yieldReturnPayment: Payment = {
                TransactionType: 'Payment',
                Account: yieldReturnWallet.classicAddress,
                Destination: po.buyerAddress,
                Amount: '1',
                Memos: [buildMemo(SCPO_ACTIONS.YIELD_RETURN, position.positionId, {
                  posId:     position.positionId,
                  principal: position.principalAmount,
                  gross:     grossYield,
                  scFee:     scpoFee,
                  partFee:   partnerFee,
                  net:       netToBuyer,
                } as any)]
              };
              const preparedReturn = await yieldReturnClient.autofill(yieldReturnPayment);
              preparedReturn.LastLedgerSequence = (await yieldReturnClient.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
              const signedReturn = yieldReturnWallet.sign(preparedReturn);
              const returnResult = await submitBlobQueued(signedReturn.tx_blob);
              yieldReturnTxHash = returnResult.result.hash;
              console.log(`[claimEscrowForPO] YIELD_RETURN memo written on-chain. Tx: ${yieldReturnTxHash}`);
            } catch (memoErr: any) {
              console.warn('[claimEscrowForPO] YIELD_RETURN memo failed (yield still processed):', memoErr.message);
            }

            setYieldPositions(prev => prev.map(p =>
              p.positionId === position.positionId
                ? { ...p, status: 'withdrawn' as const, grossYieldAtClaim: grossYield, scFeeAtClaim: scpoFee, partnerFeeAtClaim: partnerFee, netYieldToBuyer: netToBuyer, withdrawTxHash: yieldReturnTxHash, withdrawTimestamp: Math.floor(Date.now() / 1000) }
                : p
            ));
          } else {
            console.error('[claimEscrowForPO] Yield withdrawal failed:', withdrawResult.error);
            alert(`⚠️ Yield withdrawal encountered an issue: ${withdrawResult.error}\n\nThe escrow claim will proceed. Please contact support to resolve the yield position.`);
          }
        } catch (yieldErr: any) {
          console.error('[claimEscrowForPO] Yield withdrawal exception:', yieldErr);
        }
      }
    }
    // Phase 6B placeholder: financing repayment routing goes here

    // ── Existing claim logic (unchanged) ──────────────────────────────────────
    if (!vendorProfile.seed) return alert('Claim seed required');
    if (!po.escrowSequence) return alert('No escrow sequence');
    try {
      const claimable = await fetchEscrowInfo(po.buyerAddress, po.escrowSequence);
      if (!claimable) { alert('Not yet claimable'); return; }
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const { condition, fulfillment } = await generateEscrowCondition(po.issuanceId);
      // DEBUG — compare on-chain condition vs generated
      try {
        const client2 = await getXRPLClient();
        const escrowLookup: any = await client2.request({ command: 'ledger_entry', escrow: { owner: po.buyerAddress, seq: po.escrowSequence }, ledger_index: 'validated' });
        const onChainCondition = escrowLookup.result.node?.Condition;
        console.log('issuanceId used:', po.issuanceId);
        console.log('Generated condition:', condition);
        console.log('On-chain condition: ', onChainCondition);
        console.log('Match:', condition === onChainCondition);
        console.log('Generated fulfillment:', fulfillment);
        console.log('Vendor wallet:', wallet.classicAddress);
        console.log('On-chain Destination:', escrowLookup.result.node?.Destination);
        console.log('On-chain Owner:', escrowLookup.result.node?.Account);
        console.log('Destination match:', wallet.classicAddress === escrowLookup.result.node?.Destination);
      } catch (e) { console.log('Debug lookup failed:', e); }
      // Use 'any' type because EscrowFinish type doesn't include token escrow fields yet
      const escrowFinish: any = { TransactionType: 'EscrowFinish', Account: wallet.classicAddress, Owner: po.buyerAddress, OfferSequence: po.escrowSequence, Condition: condition, Fulfillment: fulfillment };      
      const prepared = await client.autofill(escrowFinish);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      // Send 1-drop claim receipt memo (permanent on-chain proof of claim)
      try {
        const claimReceipt: Payment = {
          TransactionType: 'Payment',
          Account: wallet.classicAddress,
          Destination: po.buyerAddress,
          Amount: '1',
          Memos: [buildMemo(SCPO_ACTIONS.CLAIM_PO, po.issuanceId, { escrowTx: result.result.hash })]
        };
        const preparedReceipt = await client.autofill(claimReceipt);
        preparedReceipt.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
        const signedReceipt = wallet.sign(preparedReceipt);
        await client.submitAndWait(signedReceipt.tx_blob);
        console.log('Claim receipt memo sent on-chain');
      } catch (e) {
        console.error('Failed to send claim receipt memo (escrow was still claimed):', e);
      }
      alert(`Escrow claimed! Tx: ${result.result.hash}`);
      updatePO({ ...po, status: 'claimed' });

      // ── Phase 6.0a: Auto-burn inventory MPTs on claim ─────────────────────
      // Fetch PO items from IPFS to find which inventory NFTs were in this PO,
      // then burn the corresponding MPT quantities from the warehouse wallet.
      if (po.ipfsUri && warehouseWalletSeed && vendorProfile.seed) {
        try {
          const password = po.vendorUUID ? getPOEncryptionKey(po.vendorUUID) : null;
          if (password) {
            const hash = po.ipfsUri.replace('ipfs://', '');
            const response = await fetch(`https://gateway.pinata.cloud/ipfs/${hash}`, { cache: 'no-store' });
            if (response.ok) {
              const data = await response.json();
              const decrypted = CryptoJS.AES.decrypt(data.encryptedData, password).toString(CryptoJS.enc.Utf8);
              if (decrypted) {
                const poData: POData = JSON.parse(decrypted);
                const warehouseWallet = xrpl.Wallet.fromSeed(warehouseWalletSeed);
                const burnClient = await getXRPLClient();

                for (const item of poData.items) {
                  if (!item.invNFTId) continue;
                  const qty = parseInt(item.qty, 10);
                  if (!qty || qty <= 0) continue;

                  // Look up mptIssuanceId from vendorInventoryV2
                  const invItem = vendorInventoryV2.find(i => i.nftId === item.invNFTId);
                  if (!invItem?.mptIssuanceId) {
                    console.warn(`[AutoBurn] No mptIssuanceId found for NFT ${item.invNFTId} — skipping`);
                    continue;
                  }

                  try {
                    const burnTx: any = {
                      TransactionType: 'Payment',
                      Account: warehouseWallet.classicAddress,
                      Destination: wallet.classicAddress, // return to issuer = burn
                      Amount: {
                        mpt_issuance_id: invItem.mptIssuanceId,
                        value: qty.toString(),
                      },
                      Memos: [buildMemo(SCPO_ACTIONS.BURN_INV, invItem.nftId, {
                        mptId: invItem.mptIssuanceId,
                      })]
                    };
                    const preparedBurn = await burnClient.autofill(burnTx);
                    preparedBurn.LastLedgerSequence = (await burnClient.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
                    const signedBurn = warehouseWallet.sign(preparedBurn);
                    const burnResult = await submitBlobQueued(signedBurn.tx_blob);
                    const burnMeta = burnResult.result.meta as any;
                    if (burnMeta?.TransactionResult === 'tesSUCCESS') {
                      console.log(`[AutoBurn] ✅ Burned ${qty} of ${item.num} (MPT: ${invItem.mptIssuanceId})`);
                    } else {
                      console.warn(`[AutoBurn] ⚠️ Burn failed for ${item.num}: ${burnMeta?.TransactionResult}`);
                    }
                  } catch (burnErr: any) {
                    console.warn(`[AutoBurn] ⚠️ Burn exception for ${item.num}:`, burnErr.message);
                  }
                }

                // Refresh vendor inventory to reflect updated OutstandingAmount
                try {
                  const freshWallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
                  const freshItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, freshWallet);
                  setVendorInventoryV2(freshItems);
                  console.log('[AutoBurn] ✅ Inventory refreshed after claim');
                } catch { /* non-fatal */ }
              }
            }
          }
        } catch (burnErr: any) {
          // Auto-burn is best-effort — escrow claim already succeeded
          console.error('[AutoBurn] Failed to auto-burn inventory:', burnErr.message);
        }
      }

    } catch (err: any) { alert('Claim failed: ' + err.message); }
  };

  const fetchEscrowInfo = async (owner: string, sequence: number): Promise<boolean> => {
    try {
      const client = await getXRPLClient();
      const response: any = await client.request({ command: 'ledger_entry', escrow: { owner, seq: sequence }, ledger_index: 'validated' });
      if (response.result.node && response.result.node.LedgerEntryType === 'Escrow') {
        const escrowObj = response.result.node;
        const rippleEpochStart = 946684800;
        const finishTime = new Date(((escrowObj as any).FinishAfter + rippleEpochStart) * 1000);
        const claimable = new Date() >= finishTime;
        setClaimableAfter(finishTime); setIsClaimable(claimable);
        // Detect escrow currency — if Amount is an object, it's a token escrow
        if (typeof escrowObj.Amount === 'object' && escrowObj.Amount.currency) {
          console.log(`Escrow holds ${escrowObj.Amount.value} ${escrowObj.Amount.currency} (token escrow)`);
        } else {
          console.log(`Escrow holds ${xrpl.dropsToXrp(escrowObj.Amount)} XRP`);
        }
      return claimable;
      } else { setClaimableAfter(null); setIsClaimable(false); return false; }
    } catch (err: any) { if (err.data?.error === 'entryNotFound') { setClaimableAfter(null); setIsClaimable(false); } return false; }
  };

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (claimableAfter && !isClaimable) {
      interval = setInterval(() => {
        const now = new Date(); const diff = claimableAfter.getTime() - now.getTime();
        if (diff <= 0) { setIsClaimable(true); setCountdown('Claimable now'); if (interval) clearInterval(interval); }
        else { const days = Math.floor(diff / (1000 * 60 * 60 * 24)); const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)); const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)); const seconds = Math.floor((diff % (1000 * 60)) / 1000); setCountdown(`${days}d ${hours}h ${minutes}m ${seconds}s`); }
      }, 1000);
    } else if (isClaimable) { setCountdown('Claimable now'); }
    return () => { if (interval) clearInterval(interval); };
  }, [claimableAfter, isClaimable]);

  const copyToClipboard = (text: string, label: string) => { navigator.clipboard.writeText(text); alert(`${label} copied!`); };
  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1.05)'; e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.2)'; };
  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = e.currentTarget.dataset.originalShadow || '0 4px 10px rgba(0,0,0,0.1)'; };
  const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(0.98)'; };
  const handleMouseUp = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'scale(1.05)'; };

  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `@keyframes scpoPulse { 0% { box-shadow: 0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5); } 50% { box-shadow: 0 0 50px #FFD700, 0 0 80px #FFA500, inset 0 0 30px rgba(255,255,255,0.7); } 100% { box-shadow: 0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5); } }`;
    document.head.appendChild(style);
    return () => { if (document.head.contains(style)) document.head.removeChild(style); };
  }, []);

  const sortPOsNewestFirst = (pos: SavedPO[]) => [...pos].sort((a, b) => new Date(b.dateIssued).getTime() - new Date(a.dateIssued).getTime());
  const sortFeesNewestFirst = (fees: FeeEntry[]) => fees.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const filteredFees = sortFeesNewestFirst(feeEntries.filter(entry => entry.poName.toLowerCase().includes(feeSearchTerm.toLowerCase()) || entry.date.toLowerCase().includes(feeSearchTerm.toLowerCase())));
  const isOutdated = (profile: PublicProfile) => profile.expiresAt && Date.now() > profile.expiresAt + (30 * 24 * 60 * 60 * 1000);
  const getLatestActivePOs = (status: SavedPO['status']): SavedPO[] => {
  return sortPOsNewestFirst(savedPOs.filter(po => {
    if (po.status !== status) return false;
    // Never show superseded or recalled POs in active tables
    if (po.status === 'superseded' || po.status === 'recalled') return false;
    if (mode === 'customer') {
      return !po.buyerAddress || po.buyerAddress === customerProfile.classicAddress;
    }
    if (mode === 'vendor') {
      return !po.vendorAddress || po.vendorAddress === vendorProfile.classicAddress;
    }
    return false;
  }));
};
const getUpdatablePOs = () => {
  return sortPOsNewestFirst(savedPOs.filter(po => {
    if (po.status !== 'open' && po.status !== 'accepted') return false;
    if (mode === 'customer') return po.buyerAddress === customerProfile.classicAddress;
    if (mode === 'vendor') return po.vendorAddress === vendorProfile.classicAddress;
    return false;
  }));
};
  const getVendorUpdatedPOs = () => {
  return sortPOsNewestFirst(savedPOs.filter(po => 
    po.vendorAddress === vendorProfile.classicAddress &&
    po.status === 'open' &&
    po.parentIssuanceId
  ));
};
  const getPOHistory = (po: SavedPO | null): SavedPO[] => {
    if (!po) return [];
    console.log(`getPOHistory: po=${po.poName}, parentIssuanceId=${po.parentIssuanceId}, savedPOs count=${savedPOs.length}`);
    const history: SavedPO[] = [];
    let current: SavedPO | undefined = po;
    let depth = 0;
    const buyerOrVendor = po.buyerAddress || po.vendorAddress;

    while (current && depth < 15) {
      if (current.id !== po.id) {
        const histCopy = { ...current, status: 'superseded' as const };
        history.push(histCopy);
      }
      current = savedPOs.find(p => p.issuanceId === current!.parentIssuanceId && 
        (p.buyerAddress === buyerOrVendor || p.vendorAddress === buyerOrVendor));
      depth++;
    }
    return history.reverse();
  };

  const openHistoryModal = async (currentPO: SavedPO | null, currentViewedPO: POData | null) => {
    if (!currentPO) return;
    const historyPOs = getPOHistory(currentPO);
    if (historyPOs.length === 0) return;
    const versions: {po: SavedPO; poData: POData | null; loading: boolean}[] = [];
    for (const hist of historyPOs) {
      versions.push({ po: hist, poData: null, loading: true });
    }
    versions.push({ po: currentPO, poData: currentViewedPO, loading: false });
    setHistoryModalVersions(versions);
    setHistoryModalIndex(versions.length - 1);
    setShowHistoryModal(true);
    for (let i = 0; i < historyPOs.length; i++) {
      const hist = historyPOs[i];
      if (!hist.ipfsUri) { setHistoryModalVersions(prev => prev.map((v, idx) => idx === i ? { ...v, loading: false } : v)); continue; }
      try {
        const hash = hist.ipfsUri.replace('ipfs://', '');
        const response = await fetch(`https://gateway.pinata.cloud/ipfs/${hash}`, { cache: 'no-store' });
        if (response.ok) {
          const data = await response.json();
          let password: string | null = null;
          password = hist.vendorUUID ? getPOEncryptionKey(hist.vendorUUID) : null;
          if (password) {
            const decrypted = CryptoJS.AES.decrypt(data.encryptedData, password).toString(CryptoJS.enc.Utf8);
            if (decrypted) {
              const poData: POData = JSON.parse(decrypted);
              setHistoryModalVersions(prev => prev.map((v, idx) => idx === i ? { ...v, poData, loading: false } : v));
              continue;
            }
          }
        }
      } catch (e) { console.error('Failed to load history version:', e); }
      setHistoryModalVersions(prev => prev.map((v, idx) => idx === i ? { ...v, loading: false } : v));
    }
  };
// 3.1f — Open vendor inventory detail modal
  const openInventoryDetail = async (item: InventoryItemV2) => {
    setInventoryDetailItem(item);
    setInventoryDetailDoc(null);
    setInventoryDetailLoading(true);
    setShowInventoryDetailModal(true);
    try {
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      // Load IPFS doc and refresh superseded list in parallel
      const [doc, freshItems, allItems] = await Promise.all([
        fetchVendorInventoryDoc(item.vendorUri, wallet),
        fetchVendorInventoryV2(vendorProfile.classicAddress, wallet),
        fetchVendorInventoryV2(vendorProfile.classicAddress, wallet, true)
      ]);
      setInventoryDetailDoc(doc);
      setVendorInventoryV2(freshItems);
      setVendorInventorySuperseded(allItems.filter(i => !freshItems.find(a => a.nftId === i.nftId)));
      console.log('[VersionHistory] superseded items for', item.partNumber, ':', allItems.filter(i => !freshItems.find(a => a.nftId === i.nftId) && i.partNumber === item.partNumber).length);
    } catch (err) {
      console.error('Failed to load vendor inventory doc:', err);
    } finally {
      setInventoryDetailLoading(false);
    }
  };

  // Load IPFS vendor doc whenever the version history modal index changes
  useEffect(() => {
    if (!showVersionHistoryModal || versionHistoryItems.length === 0) return;
    const item = versionHistoryItems[versionHistoryIndex];
    if (!item || !item.vendorUri || !vendorProfile.seed) return;
    let cancelled = false;
    setVersionHistoryDoc(null);
    setVersionHistoryDocLoading(true);
    (async () => {
      try {
        const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
        const doc = await fetchVendorInventoryDoc(item.vendorUri, wallet);
        if (!cancelled) setVersionHistoryDoc(doc);
      } catch (err) {
        console.warn('[VersionHistory] Failed to load doc:', err);
      } finally {
        if (!cancelled) setVersionHistoryDocLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [showVersionHistoryModal, versionHistoryIndex, versionHistoryItems]);

  // 3.1g — Open PO inventory modal
  const openPOInventoryModal = async (po: SavedPO | null, poData: POData | null) => {
    if (!po || !poData || poData.items.length === 0) return;
    setPoInventoryModalPO(po);
    setPoInventoryModalIndex(0);
    setShowPOInventoryModal(true);
    const slots = poData.items.map(item => ({
      item,
      invItem: null as InventoryItemV2 | null,
      vendorDoc: null as VendorInventoryDoc | null,
      sharedDoc: null as SharedInventoryDoc | null,
      loading: true,
    }));
    setPoInventoryModalItems(slots);
    // Pre-fetch vendor inventory if not cached for this vendor address
    let resolvedV2: InventoryItemV2[] = vendorInventoryV2.length > 0
      ? vendorInventoryV2
      : (linkedVendorInventoryV2[po.vendorAddress] || []);
    if (resolvedV2.length === 0 && po.vendorAddress) {
      try {
        if (mode === 'vendor') {
          const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
          resolvedV2 = await fetchVendorInventoryV2(po.vendorAddress, wallet);
        } else {
          resolvedV2 = await fetchVendorInventoryV2ForCustomer(po.vendorAddress);
          setLinkedVendorInventoryV2(prev => ({ ...prev, [po.vendorAddress]: resolvedV2 }));
        }
      } catch (fetchErr) {
        console.warn('[POInventoryModal] Could not fetch vendor inventory:', fetchErr);
      }
    }

    for (let i = 0; i < poData.items.length; i++) {
      const item = poData.items[i];
      try {
        const allVendorV2 = resolvedV2;
        let invItem: InventoryItemV2 | null = null;
        if (item.invNFTId) invItem = allVendorV2.find(v => v.nftId === item.invNFTId) || null;
        if (!invItem) invItem = allVendorV2.find(v => v.name === item.num || v.partNumber === item.num) || null;
        let vendorDoc: VendorInventoryDoc | null = null;
        let sharedDoc: SharedInventoryDoc | null = null;
        if (invItem) {
          if (mode === 'vendor' && vendorProfile.seed && invItem.vendorUri) {
            try {
              const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
              vendorDoc = await fetchVendorInventoryDoc(invItem.vendorUri, wallet);
            } catch { /* silent */ }
          }
          if (mode === 'customer' && invItem.sharedUri) {
            try {
              const didResult = await resolveDID(po.vendorAddress);
              const vendorPubKey = didResult.didDocument?.vm;
              if (vendorPubKey) sharedDoc = await fetchSharedInventoryDoc(invItem.sharedUri, vendorPubKey);
            } catch { /* silent */ }
          }
        }
        setPoInventoryModalItems(prev => prev.map((slot, idx) =>
          idx === i ? { ...slot, invItem, vendorDoc, sharedDoc, loading: false } : slot
        ));
      } catch {
        setPoInventoryModalItems(prev => prev.map((slot, idx) =>
          idx === i ? { ...slot, loading: false } : slot
        ));
      }
    }
  };
  const openProfilesModal = (po: SavedPO | null) => {
    if (!po) return;
    setProfilesModalPO(po);
    setProfilesModalIndex(0);
    setShowProfilesModal(true);
  };

  const getProfileForAddress = (address: string): PublicProfile | null => {
    if (customerProfile.classicAddress === address) {
      return { company: customerProfile.company, name: customerProfile.name, email: customerProfile.email, phone: customerProfile.phone, address: customerProfile.address, city: customerProfile.city, state: customerProfile.state, zip: customerProfile.zip, country: customerProfile.country, uniqueID: customerProfile.uniqueID, classicAddress: customerProfile.classicAddress, profileUUID: customerProfile.profileUUID, timestamp: Date.now(), walletHistory: customerProfile.walletHistory };
    }
    if (vendorProfile.classicAddress === address) {
      return { company: vendorProfile.company, name: vendorProfile.name, email: vendorProfile.email, phone: vendorProfile.phone, address: vendorProfile.address, city: vendorProfile.city, state: vendorProfile.state, zip: vendorProfile.zip, country: vendorProfile.country, uniqueID: vendorProfile.uniqueID, classicAddress: vendorProfile.classicAddress, profileUUID: vendorProfile.profileUUID, timestamp: Date.now(), walletHistory: vendorProfile.walletHistory };
    }
    const allUUIDs = [...customerLinkedVendorUUIDs, ...vendorLinkedCustomerUUIDs];
    for (const uuid of allUUIDs) {
      const p = publicProfiles[uuid];
      if (p && p.classicAddress === address) return p;
    }
    return null;
  };

  const getTimeRemaining = (po: SavedPO) => {
    const issueDate = new Date(po.dateIssued); const days = parseInt(po.paymentTerms.split(' ')[0]); const claimDate = new Date(issueDate.getTime() + days * 86400000); const now = new Date(); const diff = claimDate.getTime() - now.getTime();
    if (diff <= 0) return <span style={{ color: 'green' }}>Claimable</span>;
    const d = Math.floor(diff / 86400000); const h = Math.floor((diff % 86400000) / 3600000); const m = Math.floor((diff % 3600000) / 60000); return `${d}d ${h}h ${m}m`;
  };

  const isWithin24HoursOfClaimable = (po: SavedPO) => {
    const issueDate = new Date(po.dateIssued); const days = parseInt(po.paymentTerms.split(' ')[0]); const claimDate = new Date(issueDate.getTime() + days * 86400000); const now = new Date(); return now >= new Date(claimDate.getTime() - 24 * 3600000);
  };

  const EscrowRecoveryBanner = pendingEscrowRecovery ? (
    <div style={{ position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', background: '#FFF3E0', border: '2px solid #F2B04A', borderRadius: '15px', padding: '15px 25px', zIndex: 9999, boxShadow: '0 4px 20px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: '15px', maxWidth: '600px' }}>
      <span style={{ fontSize: '20px' }}>⚠️</span>
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontWeight: 'bold', color: '#D88F2E' }}>Escrow Recovery Needed</p>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#666' }}>Escrow funded for <strong>{pendingEscrowRecovery.po.poName}</strong> but MPT delivery failed. Funds are safe.</p>
      </div>
      <button onClick={resumeEscrowDelivery} disabled={recoveryLoading} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', padding: '10px 20px', borderRadius: '20px', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
        {recoveryLoading ? 'Retrying...' : '↻ Resume Delivery'}
      </button>
      <button onClick={() => setPendingEscrowRecovery(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '18px' }}>✕</button>
    </div>
  
) : null;

  const unreadCount = notifications.filter(n => !n.read).length;

  const NotificationBell = (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => { setShowNotifications(v => !v); setNotifications(prev => prev.map(n => ({ ...n, read: true }))); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '22px', position: 'relative', padding: '4px' }}>
        🔔
        {unreadCount > 0 && (
          <span style={{ position: 'absolute', top: '-4px', right: '-4px', background: '#e74c3c', color: 'white', borderRadius: '50%', width: '18px', height: '18px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {showNotifications && (
        <div style={{ position: 'absolute', right: 0, top: '36px', width: '320px', background: 'white', borderRadius: '15px', boxShadow: '0 8px 30px rgba(0,0,0,0.15)', border: '1px solid #FFE0B2', zIndex: 9999, maxHeight: '400px', overflowY: 'auto' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #FFE0B2', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 'bold', color: '#D88F2E' }}>Notifications</span>
            <button onClick={() => setNotifications([])} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '12px' }}>Clear all</button>
          </div>
          {notifications.length === 0 ? (
            <p style={{ padding: '20px', textAlign: 'center', color: '#999', margin: 0 }}>No notifications</p>
          ) : (
            notifications.map(n => (
              <div key={n.id} style={{ padding: '12px 16px', borderBottom: '1px solid #FFF3E0', background: n.read ? 'white' : '#FFFDF8' }}>
                <p style={{ margin: 0, fontSize: '14px', color: n.type === 'warning' ? '#e67e22' : n.type === 'success' ? '#27ae60' : '#333' }}>{n.message}</p>
                <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#999' }}>{new Date(n.timestamp).toLocaleTimeString()}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  const tabs = mode === 'customer' ? [{ label: 'Create', key: 'create' }, { label: 'Action', key: 'scpoAction' }, { label: 'Overview', key: 'view' }, { label: 'Profile', key: 'customerProfile' }, { label: 'Accounting', key: 'accounting' }, { label: 'Admin', key: 'admin' }] : [{ label: 'Overview', key: 'view' }, { label: 'Action', key: 'scpoAction' }, { label: 'Inventory', key: 'inventoryCatalog' }, { label: 'Profile', key: 'vendorProfile' }, { label: 'Accounting', key: 'accounting' }, { label: 'Admin', key: 'admin' }];
  // ── Task 3.9 — CSV parse utility ─────────────────────────────────────────
  // Handles quoted fields and commas inside quotes.
  const parseCSV = (text: string): { headers: string[]; rows: string[][] } => {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
    const parseRow = (line: string): string[] => {
      const fields: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      fields.push(current.trim());
      return fields;
    };
    const headers = parseRow(lines[0]);
    const rows = lines.slice(1).map(parseRow);
    return { headers, rows };
  };

  // ── Task 3.9 — Build InventoryItemV2 row from CSV mapping ────────────────
  const csvRowToFields = (
    row: string[],
    headers: string[],
    mapping: { [csvHeader: string]: string }
  ): { [field: string]: string } => {
    const result: { [field: string]: string } = {};
    headers.forEach((header, idx) => {
      const mappedField = mapping[header];
      if (mappedField && mappedField !== '__ignore__') {
        result[mappedField] = row[idx] || '';
      }
    });
    return result;
  };

  // ── Task 3.9 — Bulk mint one CSV row ─────────────────────────────────────
  const mintCSVRow = async (
    fields: { [key: string]: string },
    wallet: xrpl.Wallet,
    client: any,
    todayStr: string,
    now: number
  ): Promise<InventoryItemV2> => {
    const partNumber = fields.partNumber || '';
    const name = fields.name || '';
    const listPrice = fields.listPrice || '0';
    const unitCost = fields.unitCost || '0';
    const initialQty = parseInt(fields.initialQty || '0', 10);
    const unit = (fields.unit as UnitOfMeasure) || 'ea';

    const vendorDoc: VendorInventoryDoc = {
      partNumber,
      partName: name,
      fullDescription: fields.fullDescription || fields.shortDescription || '',
      category: fields.category || '',
      familyCode: fields.familyCode || '',
      productBrand: fields.brand || '',
      department: fields.department || '',
      productionPlant: fields.productionPlant || '',
      weight: fields.weight || '',
      competitiveFlag: false,
      trackingMode: 'bulk',
      status: 'active',
      cost: { unitCost, currency: 'USD', costBreaks: [] },
      pricing: {
        listPrice,
        currency: 'USD',
        volumeTiers: [],
        effectiveDate: todayStr,
        expiresDate: '',
      },
      supplierCode: fields.supplierCode || '',
      supplierName: fields.supplierName || '',
      attachments: {},
      nftId: '',
      mptIssuanceId: '',
      createdAt: now,
      updatedAt: now,
      lastUpdated: todayStr,
      version: 1,
    };

    const vendorUri = await uploadVendorInventoryDoc(vendorDoc, wallet);

    const sharedDoc: SharedInventoryDoc = {
      partNumber,
      partName: name,
      description: fields.shortDescription || name.substring(0, 60),
      category: fields.category || '',
      productBrand: fields.brand || '',
      weight: fields.weight || '',
      pricing: {
        unitPrice: listPrice,
        currency: 'USD',
        volumeTiers: [],
        effectiveDate: todayStr,
        expiresDate: '',
      },
      usageDocuments: [],
      nftId: '',
      version: 1,
    };

    const sharedUri = await uploadSharedInventoryDoc(sharedDoc, wallet);

    // Mint NFT
    const nftMeta: InventoryNFTMeta = {
      t: INV_META_TYPE,
      pn: partNumber,
      nm: name,
      desc: fields.shortDescription || name.substring(0, 60),
      cat: fields.category || '',
      fc: fields.familyCode || '',
      brand: fields.brand || '',
      cf: false,
      wt: fields.weight || '',
      dept: fields.department || '',
      plant: fields.productionPlant || '',
      st: 'active',
      tm: 'bulk',
      parent: '',
      v: 1,
      vu: vendorUri,
      su: sharedUri,
    };

    const nftTx: any = {
      TransactionType: 'NFTokenMint',
      Account: wallet.classicAddress,
      URI: xrpl.convertStringToHex(vendorUri),
      Flags: 8,
      NFTokenTaxon: INV_NFT_TAXON,
      Memos: [{ Memo: {
        MemoType: xrpl.convertStringToHex(INV_MEMO_TYPE),
        MemoData: xrpl.convertStringToHex(JSON.stringify(nftMeta)),
      }}],
    };
    const preparedNFT = await client.autofill(nftTx);
    const signedNFT = wallet.sign(preparedNFT);
    const nftResult = await submitBlobQueued(signedNFT.tx_blob);
    if (typeof nftResult.result.meta === 'object' &&
        nftResult.result.meta.TransactionResult !== 'tesSUCCESS') {
      throw new Error('NFT mint failed: ' + nftResult.result.meta.TransactionResult);
    }
    const nftId = extractNFTokenID(nftResult.result.meta) || 'unknown';

    // Create MPT
    const mptMeta: InventoryMPTMeta = { t: INV_QTY_TYPE, nft: nftId, pn: partNumber, unit };
    const mptLedgerMeta = {
      t: 'SCPOINV', n: partNumber, ac: 'rwa', as: 'other',
      in: 'SC.PO', i: 'https://example.com/scpo.png',
      ext: JSON.stringify(mptMeta),
    };
    const mptCreateTx: any = {
      TransactionType: 'MPTokenIssuanceCreate',
      Account: wallet.classicAddress,
      MaximumAmount: BULK_MPT_MAX,
      MPTokenMetadata: xrpl.convertStringToHex(JSON.stringify(mptLedgerMeta)),
      Flags: 96,
    };
    const preparedMPT = await client.autofill(mptCreateTx);
    const signedMPT = wallet.sign(preparedMPT);
    const mptResult = await submitBlobQueued(signedMPT.tx_blob);
    if (typeof mptResult.result.meta === 'object' &&
        mptResult.result.meta.TransactionResult !== 'tesSUCCESS') {
      throw new Error('MPT create failed: ' + mptResult.result.meta.TransactionResult);
    }

    let mptIssuanceId = (mptResult.result.meta as any)?.mpt_issuance_id || '';
    if (!mptIssuanceId) {
      const mptNodes = (mptResult.result.meta as any)?.AffectedNodes || [];
      for (const node of mptNodes) {
        if (node.CreatedNode?.LedgerEntryType === 'MPTokenIssuance') {
          mptIssuanceId = node.CreatedNode.NewFields?.MPTokenIssuanceID
            || node.CreatedNode.LedgerIndex || '';
          break;
        }
      }
    }

    // Finalize docs with token IDs
    vendorDoc.nftId = nftId;
    vendorDoc.mptIssuanceId = mptIssuanceId;
    await uploadVendorInventoryDoc(vendorDoc, wallet);
    sharedDoc.nftId = nftId;
    await uploadSharedInventoryDoc(sharedDoc, wallet);

    // ── Send initial qty to warehouse (same pattern as generateInventoryV2) ─
    if (mptIssuanceId && initialQty > 0 && warehouseWalletAddress) {
      try {
        await authorizeWarehouseForIssuance(mptIssuanceId);
        const initPayTx: any = {
          TransactionType: 'Payment',
          Account: wallet.classicAddress,
          Destination: warehouseWalletAddress,
          Amount: { mpt_issuance_id: mptIssuanceId, value: String(initialQty) },
          Memos: [{ Memo: {
            MemoType: xrpl.convertStringToHex('SCPO_INV_RECV'),
            MemoData: xrpl.convertStringToHex(JSON.stringify({
              type: 'SCPO_INV_RECV',
              nft: nftId,
              pn: partNumber,
              qty: initialQty,
              lot: 'CSV_IMPORT',
              ts: Date.now()
            }))
          }}]
        };
        const preparedInit = await client.autofill(initPayTx);
        if (!preparedInit.Fee || parseInt(preparedInit.Fee) < 12) preparedInit.Fee = '12';
        const signedInit = wallet.sign(preparedInit);
        await submitBlobQueued(signedInit.tx_blob);
      } catch (initPayErr: any) {
        console.warn('[CSVImport] Initial warehouse payment warning for', partNumber, ':', initPayErr.message);
        // Non-fatal — item is still minted, vendor can use + Receive to set qty manually
      }
    }

    const newItem: InventoryItemV2 = {
      id: Date.now().toString(),
      nftId,
      mptIssuanceId,
      partNumber,
      name,
      shortDescription: fields.shortDescription || name.substring(0, 60),
      category: fields.category || '',
      familyCode: fields.familyCode || '',
      productBrand: fields.brand || '',
      competitiveFlag: false,
      weight: fields.weight || '',
      department: fields.department || '',
      productionPlant: fields.productionPlant || '',
      status: 'active',
      trackingMode: 'bulk',
      parentNFTId: '',
      version: 1,
      vendorUri,
      sharedUri,
      quantityOnHand: initialQty,
      unit,
      listPrice: parseFloat(listPrice) || 0,
      unitCost: parseFloat(unitCost) || 0,
      pricingCurrency: 'USD',
      dateAdded: new Date().toLocaleDateString(),
      dateUpdated: new Date().toLocaleDateString(),
    };

    return newItem;
  };

  // ── Task 3.9 — Main bulk import handler ──────────────────────────────────
  const runCSVImport = async () => {
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    if (csvRows.length === 0) return alert('No rows to import');

    const requiredMapped = ['partNumber', 'name'].every(f =>
      Object.values(csvMapping).includes(f)
    );
    if (!requiredMapped) return alert('You must map at least Part Number and Name columns before importing.');

    setCsvImporting(true);
    setCsvImportDone(false);
    setCsvErrors([]);
    setCsvImportedCount(0);
    setCsvSkippedCount(0);

    const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
    const client = await getXRPLClient();
    const now = Math.floor(Date.now() / 1000);
    const todayStr = new Date().toISOString().split('T')[0];

    const existingPartNumbers = new Set(vendorInventoryV2.map(i => i.partNumber));
    let imported = 0;
    let skipped = 0;
    const errors: { row: number; partNumber: string; error: string }[] = [];

    setCsvProgress({ current: 0, total: csvRows.length, currentName: '' });

    for (let i = 0; i < csvRows.length; i++) {
      const row = csvRows[i];
      const fields = csvRowToFields(row, csvHeaders, csvMapping);
      const partNumber = fields.partNumber || '';
      const name = fields.name || '';

      setCsvProgress({ current: i + 1, total: csvRows.length, currentName: name || partNumber });

      if (!partNumber || !name) {
        errors.push({ row: i + 2, partNumber: partNumber || '(blank)', error: 'Missing Part Number or Name — row skipped' });
        skipped++;
        continue;
      }

      // Duplicate check
      if (existingPartNumbers.has(partNumber)) {
        if (csvDuplicateAction === 'skip') {
          errors.push({ row: i + 2, partNumber, error: 'Duplicate part number — skipped' });
          skipped++;
          continue;
        }
        // 'version' — falls through to mint, generateInventoryV2 pattern handles versioning
        // For now we mint a fresh item; full version-chain wiring is a future enhancement
      }

      try {
        const newItem = await mintCSVRow(fields, wallet, client, todayStr, now);
        await saveNewInventoryV2(newItem);
        existingPartNumbers.add(partNumber); // prevent duplicate within same import batch
        imported++;
      } catch (err: any) {
        errors.push({ row: i + 2, partNumber, error: err.message });
        skipped++;
      }
    }

    // Refresh catalog from chain
    const freshItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, wallet);
    setVendorInventoryV2(freshItems);

    setCsvImportedCount(imported);
    setCsvSkippedCount(skipped);
    setCsvErrors(errors);
    setCsvImporting(false);
    setCsvImportDone(true);
  };
  const saveNewInventoryV2 = async (item: InventoryItemV2) => {
    // Append the new item directly to state — no chain reload needed here.
    // generateInventoryV2 already calls fetchVendorInventoryV2 + loadInventoryValuation
    // after this function returns, so the full refresh happens once from there.
    setVendorInventoryV2(prev => {
      const exists = prev.find(i => i.nftId === item.nftId);
      return exists ? prev : [...prev, item];
    });
  };
  const fetchVendorInventory = async (vendorAddress: string): Promise<InventoryItem[]> => {
    try {
      const client = await getXRPLClient();
      const response = await client.request({ command: 'account_nfts', account: vendorAddress, ledger_index: 'validated' }) as AccountNFTsResponse;
      const inventoryNFTs: xrpl.AccountNFToken[] = response.result.account_nfts.filter((nft: xrpl.AccountNFToken) => nft.NFTokenTaxon === 1);
      const items: InventoryItem[] = [];
      for (const nft of inventoryNFTs) {
        if (nft.URI) {
          const ipfsUri = xrpl.convertHexToString(nft.URI);
          const data = await fetchFromIPFS(ipfsUri);
          items.push({ id: nft.NFTokenID, nftId: nft.NFTokenID, ipfsUri, dateAdded: 'Unknown', ...data });
        }
      }
      return items;
    } catch (err) { console.error('Fetch vendor inventory error:', err); return []; }
  };
// ── fetchVendorInventoryV2ForCustomer (Task 3.1d) ─────────────────────────
  // Customer-facing fetch: resolves vendor DID for public key, decrypts
  // sharedUri on each item so pricing is available in the Create tab dropdown.
  const fetchVendorInventoryV2ForCustomer = async (
    vendorAddress: string
  ): Promise<InventoryItemV2[]> => {
    try {
      const didResult = await resolveDID(vendorAddress);
      const vendorPubKey = didResult.didDocument?.vm || null;
      console.log('[V2ForCustomer] vendorPubKey:', vendorPubKey);
      if (!vendorPubKey) return [];
      const items = await fetchVendorInventoryV2(vendorAddress);
      console.log('[V2ForCustomer] raw items from fetchVendorInventoryV2:', items.map(i => ({ name: i.name, partNumber: i.partNumber, sharedUri: i.sharedUri })));
      const enriched: InventoryItemV2[] = [];
      for (const item of items) {
        if (item.sharedUri) {
          try {
            console.log('[V2ForCustomer] fetching sharedDoc for:', item.partNumber || item.name, 'sharedUri:', item.sharedUri);
            const sharedDoc = await fetchSharedInventoryDoc(item.sharedUri, vendorPubKey);
            console.log('[V2ForCustomer] sharedDoc pricing:', sharedDoc.pricing);
            enriched.push({
              ...item,
              name: sharedDoc.partName || item.name,
              shortDescription: sharedDoc.description || item.shortDescription,
              productImageUri: sharedDoc.productImageUri || item.productImageUri, // Task 3.8
            });
          } catch (err) {
            console.error('[V2ForCustomer] fetchSharedInventoryDoc failed for:', item.partNumber || item.name, err);
            enriched.push(item);
          }
        } else {
          console.warn('[V2ForCustomer] no sharedUri for item:', item.partNumber || item.name);
          enriched.push(item);
        }
      }
      console.log('[V2ForCustomer] final enriched items:', enriched.map(i => ({ name: i.name, partNumber: i.partNumber, sharedUri: i.sharedUri })));
      return enriched;
    } catch (err) {
      console.error('fetchVendorInventoryV2ForCustomer error:', err);
      return [];
    }
  };
  // ── fetchVendorInventoryV2 (Task 3.1d) ────────────────────────────────────
  // Reads an account's inventory NFTs (taxon=1) and returns InventoryItemV2[]
  // for any that have an SCPO_INV_META memo (V2 items). V1 items are skipped
  // here — they continue to be handled by fetchVendorInventory above.
  //
  // For the vendor (isOwner=true): decrypts vendorUri with self-encryption key
  //   to get full cost/supplier/pricing data.
  // For a customer (isOwner=false): only parses on-chain Memo metadata.
  //   Customer-facing price data will be in a future RFP/quote workflow.
  const fetchVendorInventoryV2 = async (
    vendorAddress: string,
    viewerWallet?: xrpl.Wallet,
    returnSuperseded?: boolean
  ): Promise<InventoryItemV2[]> => {
    try {
      const client = await getXRPLClient();

      // Step 1: Get all NFTs for this account with taxon=1 (inventory)
      const nftResponse = await client.request({
        command: 'account_nfts',
        account: vendorAddress,
        ledger_index: 'validated'
      }) as AccountNFTsResponse;
      const inventoryNFTs = nftResponse.result.account_nfts.filter(
        (nft: xrpl.AccountNFToken) => nft.NFTokenTaxon === INV_NFT_TAXON
      );
      console.log('[FetchV2] account_nfts returned', inventoryNFTs.length, 'inventory NFTs:', inventoryNFTs.map((n: xrpl.AccountNFToken) => n.NFTokenID));

     const items: InventoryItemV2[] = [];        // active (non-superseded) only
      const allBuiltItems: InventoryItemV2[] = []; // all including superseded

      // ── 3.4 — Fetch memos: paginate account_tx to ensure all mint txs are found ─
      const allMemos: { nftId: string; meta: InventoryNFTMeta }[] = [];
      const neededNFTIds = new Set(inventoryNFTs.map((n: xrpl.AccountNFToken) => n.NFTokenID));

      let marker: any = undefined;
      let pagesFetched = 0;
      const MAX_PAGES = 10; // up to 4,000 txs total

      do {
        const txResponse: any = await client.request({
          command: 'account_tx',
          account: vendorAddress,
          ledger_index_min: -1,
          ledger_index_max: -1,
          limit: 400,
          forward: false,
          ...(marker ? { marker } : {}),
        });
        const txList = txResponse.result.transactions || [];
        marker = txResponse.result.marker;
        pagesFetched++;
        console.log('[FetchV2] account_tx page', pagesFetched, 'returned', txList.length, 'txs, marker:', !!marker);

        for (const txEntry of txList) {
          const tx = txEntry.tx_json || txEntry.tx || txEntry.transaction || txEntry;
          if (tx.TransactionType !== 'NFTokenMint') continue;
          for (const memoWrapper of (tx.Memos || [])) {
            const memo = memoWrapper.Memo;
            if (!memo?.MemoType || !memo?.MemoData) continue;
            let memoTypeStr = '';
            try { memoTypeStr = xrpl.convertHexToString(memo.MemoType); } catch { continue; }
            if (memoTypeStr !== INV_MEMO_TYPE) continue;
            let parsedMeta: InventoryNFTMeta | null = null;
            try { parsedMeta = JSON.parse(xrpl.convertHexToString(memo.MemoData)) as InventoryNFTMeta; } catch { continue; }
            // Try to get the minted NFT ID — but don't skip if we can't, still use parent info
            const txMeta = txEntry.meta ?? txEntry.tx_metadata ?? txEntry.metaData ?? txEntry.metadata;
            const mintedId = extractNFTokenID(txMeta);
            if (mintedId && neededNFTIds.has(mintedId) && !allMemos.find(m => m.nftId === mintedId)) {
              allMemos.push({ nftId: mintedId, meta: parsedMeta });
              neededNFTIds.delete(mintedId);
            }
            // Always register parent links regardless of whether we got the minted ID
            if (parsedMeta.parent) {
              allMemos.push({ nftId: `parent-ref-${parsedMeta.parent}`, meta: parsedMeta });
            }
            break;
          }
        }

        // Stop early if we've found memos for all NFTs
        if (neededNFTIds.size === 0) break;
      } while (marker && pagesFetched < MAX_PAGES);

      console.log('[FetchV2] memo fetch complete. Found:', allMemos.length, 'Missing:', neededNFTIds.size);

      // Build set of NFT IDs that are referenced as a parent — these are superseded.
      console.log('[FetchV2] allMemos raw:', JSON.stringify(allMemos.map(m => ({ nftId: m.nftId, parent: m.meta.parent, pn: m.meta.pn, v: m.meta.v }))));
      const supersededIds = new Set(allMemos.filter(m => m.meta.parent).map(m => m.meta.parent));
      console.log('[FetchV2] supersededIds:', Array.from(supersededIds));
      // Fetch ALL MPT issuances ONCE — shared across every NFT in the loop below
      // Previously this was inside the loop, causing 1 network call per inventory item
      let issuanceObjects: any[] = [];
      try {
        const issuanceResponse = await client.request({
          command: 'account_objects',
          account: vendorAddress,
          type: 'mpt_issuance',
          ledger_index: 'validated'
        });
        issuanceObjects = (issuanceResponse.result as any).account_objects || [];
        console.log('[MPT 3.7] fetched', issuanceObjects.length, 'MPT issuances (one-time for all NFTs)');
      } catch (mptFetchErr) {
        console.warn('[MPT 3.7] account_objects one-time fetch failed:', mptFetchErr);
      }

      for (const nft of inventoryNFTs) {
        // Track superseded NFTs but still build them for history
        const isSuperseded = supersededIds.has(nft.NFTokenID);
        if (isSuperseded) {
          console.log('[FetchV2] NFT is superseded (has newer version):', nft.NFTokenID);
        }
        try {
          // Step 2: Retrieve already-parsed memo from allMemos (collected above)
          const memoEntry = allMemos.find(m => m.nftId === nft.NFTokenID);
          let metaMemo: InventoryNFTMeta | null = memoEntry?.meta || null;
          console.log('[FetchV2] metaMemo for NFT', nft.NFTokenID, ':', JSON.stringify(metaMemo));

         if (!metaMemo) {
            console.warn('[FetchV2] No SCPO_INV_META memo found for NFT:', nft.NFTokenID, '— skipping');
            continue;
          }
          console.log('[FetchV2] NFT', nft.NFTokenID, 'su field value:', JSON.stringify(metaMemo.su));

          // Step 3: Match pre-fetched MPT issuance to this NFT
          // issuanceObjects is fetched ONCE above the loop — reuse it here
          let quantityOnHand = 0;
          let mptIssuanceId = '';
          let resolvedUnit: UnitOfMeasure = 'ea';
          // Build ancestor chain for this NFT using allMemos already in memory.
          // MPT metadata stores the ORIGINAL NFT ID at issuance creation time —
          // it is immutable on-chain. When a new NFT version is minted (View Details → Save),
          // the same MPT issuance is reused, so issuanceMeta.nft will be an ancestor,
          // not the current NFT ID. Walking the parent chain resolves this correctly
          // regardless of name or part number changes across versions.
          const buildAncestorSet = (startNFTId: string): Set<string> => {
            const ancestors = new Set<string>();
            let current: string | undefined = startNFTId;
            while (current) {
              ancestors.add(current);
              const parentMemo = allMemos.find(m => m.nftId === current);
              current = parentMemo?.meta?.parent || undefined;
            }
            return ancestors;
          };
          const ancestorIds = buildAncestorSet(nft.NFTokenID);
          for (const issuance of issuanceObjects) {
            const issuanceId = issuance.mpt_issuance_id || issuance.MPTokenIssuanceID || issuance.index;
            if (!issuanceId) continue;
            const metaHex = issuance.MPTokenMetadata || issuance.Metadata;
            if (!metaHex) continue;
            try {
              const rawMeta = JSON.parse(xrpl.convertHexToString(metaHex)) as any;
              const issuanceMeta: InventoryMPTMeta = rawMeta.ext ? JSON.parse(rawMeta.ext) : rawMeta;
              if (issuanceMeta.nft && ancestorIds.has(issuanceMeta.nft)) {
                mptIssuanceId = issuanceId;
                // OutstandingAmount is the on-chain source of truth.
                // It increases with every Receive (issuer → warehouse wallet Payment).
                quantityOnHand = parseInt(issuance.OutstandingAmount || '0', 10);
                resolvedUnit = issuanceMeta.unit || 'ea';
                console.log('[MPT 3.7] matched issuance for', issuanceMeta.pn, '— qty:', quantityOnHand, 'id:', issuanceId);
                break;
              }
            } catch { continue; }
          }
          // Step 4: Optionally decrypt vendorUri if caller is the owner
          let vendorDoc: VendorInventoryDoc | null = null;
          if (viewerWallet && metaMemo.vu) {
            try {
              vendorDoc = await fetchVendorInventoryDoc(metaMemo.vu, viewerWallet);
            } catch (decryptErr) {
              console.warn('Could not decrypt vendorUri for', nft.NFTokenID, decryptErr);
            }
          }

          // Step 5: Build InventoryItemV2
          // Extract listPrice and unitCost from already-decrypted vendorDoc (no extra IPFS call)
          const listPrice = parseFloat(vendorDoc?.pricing?.listPrice || '0') || 0;
          const unitCost = parseFloat(vendorDoc?.cost?.unitCost || '0') || 0;
          const pricingCurrency = vendorDoc?.pricing?.currency || vendorDoc?.cost?.currency || 'USD';
          const productImageUri = vendorDoc?.attachments?.productImage?.uri; // Task 3.8

          const item: InventoryItemV2 = {
            id: nft.NFTokenID,
            nftId: nft.NFTokenID,
            mptIssuanceId,
            partNumber: metaMemo.pn,
            name: metaMemo.nm,
            shortDescription: metaMemo.desc,
            category: metaMemo.cat,
            familyCode: metaMemo.fc,
            productBrand: metaMemo.brand,
            competitiveFlag: metaMemo.cf,
            weight: metaMemo.wt,
            department: metaMemo.dept,
            productionPlant: metaMemo.plant,
            status: (vendorDoc?.status || metaMemo.st) as ItemStatus,
            trackingMode: metaMemo.tm,
            parentNFTId: metaMemo.parent,
            version: metaMemo.v,
            vendorUri: metaMemo.vu,
            sharedUri: metaMemo.su,
            quantityOnHand,
            unit: resolvedUnit,
            listPrice,
            unitCost,
            pricingCurrency,
            productImageUri, // Task 3.8
            dateAdded: new Date().toLocaleDateString(),
            dateUpdated: new Date().toLocaleDateString(),
          };
          allBuiltItems.push(item);
          if (!isSuperseded) items.push(item);
        } catch (nftErr) {
          console.warn('Error processing NFT', nft.NFTokenID, nftErr);
          continue;
        }
      }
      if (returnSuperseded) return allBuiltItems;
      return items;
    } catch (err) {
      console.error('fetchVendorInventoryV2 error:', err);
      return [];
    }
  };

  // Load V2 inventory when vendor opens Inventory tab — auto-syncs with chain
  useEffect(() => {
    if (mode !== 'vendor' || activeTab !== 'inventoryCatalog') return;
    if (!vendorProfile.classicAddress || !vendorProfile.seed) return;
    if (editPricingSaving) return; // block reload while a save is in progress
    // Task 3.5: Check catalog DID endpoint status whenever tab is opened
    checkCatalogDIDEndpoint();
    const load = async () => {
      setVendorInventoryV2Loading(true);
      try {
        const client = await getXRPLClient();
        const nftResponse = await client.request({
          command: 'account_nfts',
          account: vendorProfile.classicAddress,
          ledger_index: 'validated'
        }) as AccountNFTsResponse;
        const onChainNFTIds = new Set(
          nftResponse.result.account_nfts
            .filter((nft: xrpl.AccountNFToken) => nft.NFTokenTaxon === INV_NFT_TAXON)
            .map((nft: xrpl.AccountNFToken) => nft.NFTokenID)
        );
        // Auto-remove any savedInventoryV2 entries that no longer exist on-chain
        const synced = savedInventoryV2.filter(i => onChainNFTIds.has(i.nftId));
        if (synced.length !== savedInventoryV2.length) {
          setSavedInventoryV2(synced);
        }
        const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
        const items = await fetchVendorInventoryV2(vendorProfile.classicAddress, wallet);
        const allItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, wallet, true);
        // listPrice, unitCost, pricingCurrency are now resolved inside fetchVendorInventoryV2
        // from the already-decrypted vendorDoc — no separate loadInventoryValuation call needed
        setVendorInventoryV2(items);
        setVendorInventorySuperseded(allItems.filter(i => !items.find(a => a.nftId === i.nftId)));
      } catch (err) {
        console.error('Failed to load V2 inventory:', err);
      } finally {
        setVendorInventoryV2Loading(false);
      }
    };
    load();
  }, [mode, activeTab, vendorProfile.classicAddress]);
  // Load vendor inventory for customer Create tab (V2 only)
  useEffect(() => {
    if (mode !== 'customer' || activeTab !== 'create' || !vendor) return;
    setLinkedVendorInventoryV2(prev => ({ ...prev, [vendor]: [] }));
    const load = async () => {
      try {
        const v2items = await fetchVendorInventoryV2ForCustomer(vendor);
        const validItems = v2items.filter(i => i.nftId && i.nftId !== 'unknown');
        setLinkedVendorInventoryV2(prev => ({ ...prev, [vendor]: validItems }));
      } catch (err) {
        console.error('V2 inventory fetch failed:', err);
      }
    };
    load();
  }, [vendor, mode, activeTab]);
// Cache selected inventory item pricing when item is selected
  const [selectedItemPricing, setSelectedItemPricing] = React.useState<SharedPricing | null>(null);
  const [selectedItemPricingLoading, setSelectedItemPricingLoading] = React.useState(false);

  useEffect(() => {
    if (selectedInventoryItem === 'custom' || !vendor) {
      setSelectedItemPricing(null);
      return;
    }
    const v2items = linkedVendorInventoryV2[vendor] || [];
    console.log('[PriceFetch] v2items full objects:', v2items);
    // Guard: if array contains strings instead of objects, the fetch hasn't completed yet
    if (v2items.length > 0 && typeof v2items[0] === 'string') {
      console.warn('[PriceFetch] v2items not yet loaded as objects, skipping');
      setSelectedItemPricing(null);
      return;
    }
    const v2item = v2items.find((i: any) => i.partNumber === selectedInventoryItem || i.name === selectedInventoryItem);
    if (!v2item?.sharedUri) {
      console.warn('[PriceFetch] No sharedUri found for item:', selectedInventoryItem, 'v2items:', v2items.map((i: any) => i.partNumber || i.name));
      setSelectedItemPricing(null);
      return;
    }
    const loadPricing = async () => {
      setSelectedItemPricingLoading(true);
      try {
        console.log('[PriceFetch] Fetching pricing for:', selectedInventoryItem, 'sharedUri:', v2item.sharedUri);
        const didResult = await resolveDID(vendor);
        const vendorPubKey = didResult.didDocument?.vm;
        if (!vendorPubKey) {
          console.warn('[PriceFetch] No vendorPubKey found in DID for:', vendor);
          return;
        }
        const sharedDoc = await fetchSharedInventoryDoc(v2item.sharedUri, vendorPubKey);
        console.log('[PriceFetch] sharedDoc received:', sharedDoc);
        console.log('[PriceFetch] pricing:', sharedDoc.pricing);
        setSelectedItemPricing(sharedDoc.pricing || null);
      } catch (err) {
        console.error('[PriceFetch] Failed to fetch pricing:', err);
        setSelectedItemPricing(null);
      }
      finally { setSelectedItemPricingLoading(false); }
    };
    loadPricing();
  }, [selectedInventoryItem, vendor]);

  // ── 3.2f — Auto-compute Piece Price and Total $ using resolvePrice ─────────
  useEffect(() => {
    if (selectedInventoryItem === 'custom' || !newQty || !selectedItemPricing) return;
    const qty = parseFloat(newQty);
    if (qty > 0) {
      const resolvedPrice = parseFloat(resolvePrice(selectedItemPricing, qty));
      if (resolvedPrice > 0) {
        setNewPiecePrice(resolvedPrice.toFixed(2));
        setNewTotal((qty * resolvedPrice).toFixed(2));
      }
    }
  }, [newQty, selectedItemPricing, selectedInventoryItem]);

  // ── 3.2g — Pricing expiry warning (computed, not stored in state) ──────────
  const pricingExpiryWarning: { message: string; color: string; bg: string } | null = (() => {
    if (!selectedItemPricing?.expiresDate) return null;
    const today = new Date();
    const expires = new Date(selectedItemPricing.expiresDate);
    const daysUntil = Math.ceil((expires.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysUntil < 0) return { message: `⚠ Pricing expired on ${selectedItemPricing.expiresDate} — confirm current pricing with vendor`, color: '#7B3F00', bg: '#FFF3CD' };
    if (daysUntil <= 30) return { message: `⚠ Pricing expires ${selectedItemPricing.expiresDate} (${daysUntil} days) — confirm with vendor`, color: '#856404', bg: '#FFF3CD' };
    return null;
  })();
  const loadPoInventory = async (viewedPO: POData, savedPO: SavedPO, setPoInventory: React.Dispatch<React.SetStateAction<{[itemNum: string]: InventoryItem}>>) => {
    if (!vendorInventories[savedPO.vendorAddress]) { const inv = await fetchVendorInventory(savedPO.vendorAddress); setVendorInventories(prev => ({ ...prev, [savedPO.vendorAddress]: inv })); }
    const inventory = vendorInventories[savedPO.vendorAddress] || [];
    const poInv: {[itemNum: string]: InventoryItem} = {};
    viewedPO.items.forEach(item => { const matchingInv = inventory.find(invItem => invItem.name === item.num); if (matchingInv) poInv[item.num] = matchingInv; });
    setPoInventory(poInv);
  };

  useEffect(() => { if (customerScpoActionViewedPO && selectedOpenPO) loadPoInventory(customerScpoActionViewedPO, selectedOpenPO, setCustomerScpoActionPoInventory); }, [customerScpoActionViewedPO, selectedOpenPO]);
  useEffect(() => { if (vendorScpoActionViewedPO && selectedOpenPO) loadPoInventory(vendorScpoActionViewedPO, selectedOpenPO, setVendorScpoActionPoInventory); }, [vendorScpoActionViewedPO, selectedOpenPO]);
  useEffect(() => { if (customerViewViewedPO && selectedFundedPO) loadPoInventory(customerViewViewedPO, selectedFundedPO, setCustomerViewPoInventory); }, [customerViewViewedPO, selectedFundedPO]);
  useEffect(() => { if (vendorViewViewedPO && selectedFundedPO) loadPoInventory(vendorViewViewedPO, selectedFundedPO, setVendorViewPoInventory); }, [vendorViewViewedPO, selectedFundedPO]);

  // ── generateInventoryV2 (Task 3.1c) ──────────────────────────────────────
  // Replaces generateInventory for new V2 items.
  // Flow:
  //   1. Upload VendorInventoryDoc to IPFS (self-encrypted) → vendorUri
  //   2. Mint NFT with SCPO_INV_META memo + vendorUri in URI field
  //   3. Create MPT issuance (quantity token linked to NFT)
  //   4. Mint initial quantity to self
  //   5. Save InventoryItemV2 to state
  const generateInventoryV2 = async () => {
    if (!invName) return alert('Name required');
    if (!invPartNumber) return alert('Part Number required');
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');

    // ── 3.2d — Volume tier validation ────────────────────────────────────────
    if (invUseVolumePricing) {
      const filledTiers = invVolumeTiers.filter(t => t.minQty && t.price);
      if (filledTiers.length < 2) return alert('Volume pricing requires at least 2 tiers. Add another tier or uncheck "Enable Volume Pricing".');
      for (let i = 0; i < filledTiers.length; i++) {
        const minQty = parseInt(filledTiers[i].minQty);
        const price = parseFloat(filledTiers[i].price);
        if (isNaN(minQty) || minQty < 1) return alert(`Tier ${i + 1}: Min Qty must be a positive number.`);
        if (isNaN(price) || price <= 0) return alert(`Tier ${i + 1}: Price must be greater than 0.`);
        if (i === 0 && minQty !== 1) return alert('First tier must start at Min Qty = 1.');
        if (i > 0) {
          const prevMaxQty = parseInt(filledTiers[i - 1].maxQty);
          const expectedMin = isNaN(prevMaxQty) ? null : prevMaxQty + 1;
          if (expectedMin !== null && minQty !== expectedMin) {
            return alert(`Tier ${i + 1}: Min Qty must be ${expectedMin} to follow the previous tier's Max Qty of ${prevMaxQty}. Tiers must be contiguous.`);
          }
          const prevPrice = parseFloat(filledTiers[i - 1].price);
          if (price >= prevPrice) {
            if (!window.confirm(`Warning: Tier ${i + 1} price ($${price}) is not lower than the previous tier ($${prevPrice}). Volume pricing usually decreases with quantity. Continue anyway?`)) return;
          }
        }
      }
    }

    try {
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const client = await getXRPLClient();
      const now = Math.floor(Date.now() / 1000);
      const todayStr = new Date().toISOString().split('T')[0];

      // ── Step 1: Upload vendor-only IPFS doc (self-encrypted) ──────────────
      setInvResult('Uploading vendor data to IPFS...');

      // Upload document attachments first
      const pricingAttachment = invPricingFile
        ? { name: invPricingFile.name, uri: await uploadFileToIPFS(invPricingFile) }
        : undefined;
      const designAttachment = invDesignFile
        ? { name: invDesignFile.name, uri: await uploadFileToIPFS(invDesignFile) }
        : undefined;
      const bomAttachment = invBomFile
        ? { name: invBomFile.name, uri: await uploadFileToIPFS(invBomFile) }
        : undefined;
      const usageAttachment = invUsageFile
        ? { name: invUsageFile.name, uri: await uploadFileToIPFS(invUsageFile) }
        : undefined;

      // Task 3.8 — product image upload
      const imageAttachment = invImageFile
        ? { name: invImageFile.name, uri: await uploadFileToIPFS(invImageFile) }
        : undefined;

      const vendorDoc: VendorInventoryDoc = {
        partNumber: invPartNumber,
        partName: invName,
        fullDescription: invDesc,
        category: invCategory,
        familyCode: invFamilyCode,
        productBrand: invBrand,
        department: invDepartment,
        productionPlant: invPlant,
        weight: invWeight,
        competitiveFlag: invCompetitiveFlag,
        trackingMode: 'bulk',
        status: 'active',
        cost: {
          unitCost: invUnitCost || '0',
          currency: invCostCurrency || 'USD',
          costBreaks: [],
        },
        pricing: {
          listPrice: invUnitPrice || '0',
          currency: invPriceCurrency || 'USD',
          volumeTiers: invUseVolumePricing
            ? invVolumeTiers
                .filter(t => t.minQty && t.price)
                .map(t => ({ minQty: parseInt(t.minQty), price: t.price }))
            : [],
          effectiveDate: invEffectiveDate || todayStr,
          expiresDate: invExpiresDate || '',
        },
        supplierCode: invSupplierCode,
        supplierName: invSupplierName,
        attachments: {
          productImage: imageAttachment, // Task 3.8
          pricingSheet: pricingAttachment,
          designFile: designAttachment,
          bom: bomAttachment,
          usageGuide: usageAttachment,
        },
        nftId: '',           // filled in after mint
        mptIssuanceId: '',   // filled in after MPT create
        createdAt: now,
        updatedAt: now,
        lastUpdated: todayStr,
        version: 1,
      };

      const vendorUri = await uploadVendorInventoryDoc(vendorDoc, wallet);

      // ── Step 1b: Build and upload customer-shared IPFS doc ────────────────
      setInvResult('Uploading shared catalog data to IPFS...');

      const sharedDoc: SharedInventoryDoc = {
        partNumber: invPartNumber,
        partName: invName,
        description: invShortDesc || invDesc.substring(0, 60),
        category: invCategory,
        productBrand: invBrand,
        weight: invWeight,
        productImageUri: imageAttachment?.uri, // Task 3.8
        pricing: {
          unitPrice: invUnitPrice || '0',
          currency: invPriceCurrency || 'USD',
          volumeTiers: invUseVolumePricing
            ? invVolumeTiers
                .filter(t => t.minQty && t.price)
                .map(t => ({ minQty: parseInt(t.minQty), price: t.price }))
            : [],
          effectiveDate: invEffectiveDate || todayStr,
          expiresDate: invExpiresDate || '',
        },
        usageDocuments: usageAttachment ? [usageAttachment] : [],
        nftId: '',           // filled in after mint
        version: 1,
      };

      const sharedUri = await uploadSharedInventoryDoc(sharedDoc, wallet);
      console.log('[CreateInv] sharedUri after upload:', sharedUri);
      if (!sharedUri) {
        setInvResult('❌ Failed to upload shared catalog data to IPFS. Check Pinata API key.');
        return;
      }

      // ── Step 2: Mint NFT with SCPO_INV_META memo ──────────────────────────
      setInvResult('Minting inventory NFT on XRPL...');
      const nftMeta: InventoryNFTMeta = {
        t: INV_META_TYPE,
        pn: invPartNumber,
        nm: invName,
        desc: invShortDesc || invDesc.substring(0, 60),
        cat: invCategory,
        fc: invFamilyCode,
        brand: invBrand,
        cf: invCompetitiveFlag,
        wt: invWeight,
        dept: invDepartment,
        plant: invPlant,
        st: 'active',
        tm: 'bulk',
        parent: '',
        v: 1,
        vu: vendorUri,
        su: sharedUri,
      };

      const nftTx: any = {
        TransactionType: 'NFTokenMint',
        Account: wallet.classicAddress,
        URI: xrpl.convertStringToHex(vendorUri),  // URI field stores vendorUri
        Flags: 8,  // tfTransferable — needed for Phase 6 collateral
        NFTokenTaxon: INV_NFT_TAXON,
        Memos: [{
          Memo: {
            MemoType: xrpl.convertStringToHex(INV_MEMO_TYPE),
            MemoData: xrpl.convertStringToHex(JSON.stringify(nftMeta)),
          }
        }],
      };
      const preparedNFT = await client.autofill(nftTx);
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await submitBlobQueued(signedNFT.tx_blob);

      if (typeof nftResult.result.meta === 'object' &&
          nftResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        setInvResult('NFT Mint failed: ' + nftResult.result.meta.TransactionResult);
        return;
      }

      const nftId = extractNFTokenID(nftResult.result.meta) || 'unknown';

      // ── Step 3: Create MPT issuance (quantity token) ──────────────────────
      setInvResult('Creating quantity token (MPT)...');

      const mptMeta: InventoryMPTMeta = {
        t: INV_QTY_TYPE,
        nft: nftId,
        pn: invPartNumber,
        unit: invUnit,
      };

      // AFTER — XLS-89 compliant wrapper silences the console warning
      // Custom inventory data preserved in 'ext' field (same pattern as PO metadata)
      const mptLedgerMeta = {
          t: 'SCPOINV',        // uppercase only, ≤6 chars ✓
          n: invPartNumber,
          ac: 'rwa',
          as: 'other',         // required when ac is 'rwa'
          in: 'SC.PO',
          i: 'https://example.com/scpo.png',
          ext: JSON.stringify(mptMeta),
      };
       const mptCreateTx: any = {
         TransactionType: 'MPTokenIssuanceCreate',
         Account: wallet.classicAddress,
         MaximumAmount: BULK_MPT_MAX,
         MPTokenMetadata: xrpl.convertStringToHex(JSON.stringify(mptLedgerMeta)),
         Flags: 96,
      };
      const preparedMPT = await client.autofill(mptCreateTx);
      const signedMPT = wallet.sign(preparedMPT);
      const mptResult = await submitBlobQueued(signedMPT.tx_blob);

      if (typeof mptResult.result.meta === 'object' &&
          mptResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        setInvResult('MPT Create failed: ' + mptResult.result.meta.TransactionResult);
        return;
      }

      // Extract MPTokenIssuanceID from result
      // On devnet the ID lives in LedgerIndex (the created object's index),
      // not in NewFields.MPTokenIssuanceID — so we check both.
      let mptIssuanceId = (mptResult.result.meta as any)?.mpt_issuance_id || '';
      if (!mptIssuanceId) {
        const mptNodes = (mptResult.result.meta as any)?.AffectedNodes || [];
        for (const node of mptNodes) {
          if (node.CreatedNode?.LedgerEntryType === 'MPTokenIssuance') {
            mptIssuanceId = node.CreatedNode.NewFields?.MPTokenIssuanceID
              || node.CreatedNode.LedgerIndex
              || '';
            break;
          }
        }
      }
      console.log('[Inventory] extracted mptIssuanceId:', mptIssuanceId);

      // ── Step 4: If a warehouse wallet is configured and initialQty > 0,
      // pay tokens to it now so OutstandingAmount reflects qty immediately.
      // If no warehouse wallet is set up yet, the vendor must use + Receive
      // after configuring one — qty will show 0 until then.
      const initialQty = parseInt(invInitialQty || '0', 10);
      if (mptIssuanceId && initialQty > 0 && warehouseWalletAddress) {
        setInvResult('Sending initial quantity to warehouse...');
        try {
          // Authorize warehouse wallet for this issuance first
          await authorizeWarehouseForIssuance(mptIssuanceId);
          // Pay initial qty from issuer to warehouse wallet — sets OutstandingAmount on chain
          const initPayTx: any = {
            TransactionType: 'Payment',
            Account: wallet.classicAddress,
            Destination: warehouseWalletAddress,
            Amount: {
              mpt_issuance_id: mptIssuanceId,
              value: String(initialQty),
            },
            Memos: [{ Memo: {
              MemoType: xrpl.convertStringToHex('SCPO_INV_RECV'),
              MemoData: xrpl.convertStringToHex(JSON.stringify({
                type: 'SCPO_INV_RECV',
                nft: nftId,
                pn: invPartNumber,
                qty: initialQty,
                lot: 'INITIAL',
                ts: Date.now()
              }))
            }}]
          };
          const preparedInit = await client.autofill(initPayTx);
          if (!preparedInit.Fee || parseInt(preparedInit.Fee) < 12) preparedInit.Fee = '12';
          const signedInit = wallet.sign(preparedInit);
          await submitBlobQueued(signedInit.tx_blob);
          console.log('[Inventory] initial qty paid to warehouse:', initialQty, 'issuance:', mptIssuanceId);
        } catch (initPayErr: any) {
          console.warn('[Inventory] Initial warehouse payment warning:', initPayErr.message);
        }
      } else if (initialQty > 0 && !warehouseWalletAddress) {
        console.warn('[Inventory] No warehouse wallet configured — initial qty will show 0 until Receive is used.');
      }
      // ── Step 5: Update vendorDoc and sharedDoc with final token IDs and re-upload ───────
      vendorDoc.nftId = nftId;
      vendorDoc.mptIssuanceId = mptIssuanceId;
      const finalVendorUri = await uploadVendorInventoryDoc(vendorDoc, wallet);

      sharedDoc.nftId = nftId;
      const finalSharedUri = await uploadSharedInventoryDoc(sharedDoc, wallet);

      // ── Step 6: Save locally ──────────────────────────────────────────────
      const newItem: InventoryItemV2 = {
        id: Date.now().toString(),
        nftId,
        mptIssuanceId,
        partNumber: invPartNumber,
        name: invName,
        shortDescription: invShortDesc || invDesc.substring(0, 60),
        category: invCategory,
        familyCode: invFamilyCode,
        productBrand: invBrand,
        competitiveFlag: invCompetitiveFlag,
        weight: invWeight,
        department: invDepartment,
        productionPlant: invPlant,
        status: 'active',
        trackingMode: 'bulk',
        parentNFTId: '',
        version: 1,
        vendorUri: finalVendorUri,
        sharedUri: finalSharedUri,
        quantityOnHand: initialQty,
        unit: invUnit,
        listPrice: parseFloat(invUnitPrice || '0') || 0,
        unitCost: parseFloat(invUnitCost || '0') || 0,
        pricingCurrency: 'USD',
        productImageUri: imageAttachment?.uri, // Task 3.8
        dateAdded: new Date().toLocaleDateString(),
        dateUpdated: new Date().toLocaleDateString(),
      };
      await saveNewInventoryV2(newItem);

      setLinkedVendorInventoryV2({});
      setVendorInventories({});
      setInvResult(
        `✅ Inventory Item Created!\n` +
        `NFT ID: ${nftId}\n` +
        `MPT Issuance ID: ${mptIssuanceId}\n` +
        `Vendor URI: ${finalVendorUri}\n` +
        `Initial Qty: ${initialQty} ${invUnit}`
      );

      // Refresh inventory from chain so the table reflects the minted qty immediately
      // listPrice/unitCost are now embedded in each item — no separate valuation call needed
      const freshWallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const freshItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, freshWallet);
      setVendorInventoryV2(freshItems);

      // Reset form
      setInvName(''); setInvPartNumber(''); setInvCategory(''); setInvFamilyCode('');
      setInvBrand(''); setInvWeight(''); setInvPlant(''); setInvDepartment('');
      setInvDesc(''); setInvShortDesc(''); setInvCompetitiveFlag(false);
      setInvUnitPrice(''); setInvUnitCost(''); setInvEffectiveDate(''); setInvExpiresDate('');
      setInvSupplierCode(''); setInvSupplierName('');
      setInvInitialQty(''); setInvUnit('ea');
      setInvPricingFile(null); setInvDesignFile(null); setInvBomFile(null);
      setInvUsageFile(null); setInvImageFile(null); // Task 3.8

    } catch (err: any) { setInvResult('Error: ' + err.message); }
  };

  // ── Task 3.10 — Quick status update (Option A: vendorDoc re-upload only) ─
  // Updates status by re-uploading vendorDoc to IPFS with the new status.
  // No NFT mint, no version increment — version is reserved for real catalog
  // changes (price, spec, description). Status is operational state.
  const quickUpdateItemStatus = async (item: InventoryItemV2, newStatus: ItemStatus) => {
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    if (item.status === newStatus) return;

    setStatusUpdatingNFTId(item.nftId);
    try {
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);

      // Fetch current vendorDoc to preserve all existing fields
      let vendorDoc: VendorInventoryDoc | null = null;
      try {
        vendorDoc = await fetchVendorInventoryDoc(item.vendorUri, wallet);
      } catch (err) {
        console.warn('[StatusUpdate] Could not fetch vendorDoc:', err);
        alert('Could not load item data. Please try again.');
        return;
      }
      if (!vendorDoc) { alert('Could not load item data. Please try again.'); return; }

      // Re-upload vendorDoc with updated status only — no version bump
      const updatedVendorDoc: VendorInventoryDoc = {
        ...vendorDoc,
        status: newStatus,
        updatedAt: Math.floor(Date.now() / 1000),
        lastUpdated: new Date().toISOString().split('T')[0],
      };

      await uploadVendorInventoryDoc(updatedVendorDoc, wallet);

      // Patch local state immediately — no chain reload needed
      setVendorInventoryV2(prev =>
        prev.map(i => i.nftId === item.nftId ? { ...i, status: newStatus } : i)
      );

      console.log('[StatusUpdate] ✅', item.partNumber, '→', newStatus, '(vendorDoc re-upload only, no mint)');

    } catch (err: any) {
      alert('Status update failed: ' + err.message);
    } finally {
      setStatusUpdatingNFTId(null);
    }
  };
  // ── burnInventoryItemV2 (Task 3.1 cleanup) ────────────────────────────────
  const burnInventoryItemV2 = async (item: InventoryItemV2) => {
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${item.name}" (${item.partNumber})?\n\nThis will burn the NFT and remove it from your catalog permanently. This cannot be undone.`
    );
    if (!confirmed) return;

    try {
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const client = await getXRPLClient();
      setInvResult(`Deleting ${item.name}...`);

      // Step 1: Burn the NFT
      const burnTx: any = {
        TransactionType: 'NFTokenBurn',
        Account: wallet.classicAddress,
        NFTokenID: item.nftId,
      };
      const preparedBurn = await client.autofill(burnTx);
      const signedBurn = wallet.sign(preparedBurn);
      const burnResult = await submitBlobQueued(signedBurn.tx_blob);

      if (typeof burnResult.result.meta === 'object' &&
          burnResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        setInvResult('NFT Burn failed: ' + burnResult.result.meta.TransactionResult);
        return;
      }
      console.log('[BurnInv] NFT burned:', item.nftId);

      // Step 2: Destroy the MPT issuance if it exists
      if (item.mptIssuanceId) {
        try {
          const mptDestroyTx: any = {
            TransactionType: 'MPTokenIssuanceDestroy',
            Account: wallet.classicAddress,
            MPTokenIssuanceID: item.mptIssuanceId,
          };
          const preparedDestroy = await client.autofill(mptDestroyTx);
          const signedDestroy = wallet.sign(preparedDestroy);
          const destroyResult = await submitBlobQueued(signedDestroy.tx_blob);
          if (typeof destroyResult.result.meta === 'object' &&
              destroyResult.result.meta.TransactionResult !== 'tesSUCCESS') {
            console.warn('[BurnInv] MPT destroy failed:', destroyResult.result.meta.TransactionResult);
          } else {
            console.log('[BurnInv] MPT issuance destroyed:', item.mptIssuanceId);
          }
        } catch (mptErr) {
          console.warn('[BurnInv] MPT destroy error (non-fatal):', mptErr);
        }
      }

    // Step 3: Remove just the deleted item from UI immediately — don't blank the whole list
      const updatedSaved = savedInventoryV2.filter(i => i.nftId !== item.nftId && i.id !== item.id);
      setSavedInventoryV2(updatedSaved);
      setVendorInventoryV2(prev => prev.filter(i => i.nftId !== item.nftId));
      setLinkedVendorInventoryV2({});
      setVendorInventories({});
      console.log('[BurnInv] removed from UI:', item.nftId);

      setInvResult(`✅ "${item.name}" (${item.partNumber}) has been permanently deleted.`);

    } catch (err: any) {
      setInvResult('Delete failed: ' + err.message);
    }
  };

  // ── syncInventoryWithChain ────────────────────────────────────────────────
  const syncInventoryWithChain = async () => {
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    try {
      setInvResult('Syncing inventory with chain...');
      const client = await getXRPLClient();
      const nftResponse = await client.request({
        command: 'account_nfts',
        account: vendorProfile.classicAddress,
        ledger_index: 'validated'
      }) as AccountNFTsResponse;
      const onChainNFTIds = new Set(
        nftResponse.result.account_nfts
          .filter((nft: xrpl.AccountNFToken) => nft.NFTokenTaxon === INV_NFT_TAXON)
          .map((nft: xrpl.AccountNFToken) => nft.NFTokenID)
      );
      console.log('[SyncInv] on-chain NFT IDs:', Array.from(onChainNFTIds));
      console.log('[SyncInv] savedInventoryV2 NFT IDs:', savedInventoryV2.map(i => i.nftId));
      const synced = savedInventoryV2.filter(i => onChainNFTIds.has(i.nftId));
      const removedCount = savedInventoryV2.length - synced.length;
      setSavedInventoryV2(synced);
      setVendorInventoryV2([]);
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const freshItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, wallet);
      setVendorInventoryV2(freshItems);
      setInvResult(`✅ Sync complete. Removed ${removedCount} ghost item(s). ${synced.length} item(s) remain.`);
    } catch (err: any) {
      setInvResult('Sync failed: ' + err.message);
    }
  };

  // ── Task 3.7 — Authorize warehouse wallet for an MPT issuance ────────────
  const authorizeWarehouseForIssuance = async (issuanceId: string): Promise<boolean> => {
    console.log('[Warehouse] authorizeWarehouseForIssuance called, issuanceId:', issuanceId, 'hasSeed:', !!warehouseWalletSeed);
    if (!warehouseWalletSeed) {
      console.warn('[Warehouse] No warehouse seed — cannot authorize');
      return false;
    }
    try {
      const client = await getXRPLClient();
      const warehouseWallet = xrpl.Wallet.fromSeed(warehouseWalletSeed);
      console.log('[Warehouse] warehouse address:', warehouseWallet.classicAddress);
      const authTx: any = {
        TransactionType: 'MPTokenAuthorize',
        Account: warehouseWallet.classicAddress,
        MPTokenIssuanceID: issuanceId,
      };
      const prepared = await client.autofill(authTx);
      if (!prepared.Fee || parseInt(prepared.Fee) < 12) prepared.Fee = '12';
      const signed = warehouseWallet.sign(prepared);
      const result = await submitBlobQueued(signed.tx_blob);
      const meta = result.result.meta as any;
      console.log('[Warehouse] MPTokenAuthorize result:', meta.TransactionResult);
      // tesSUCCESS = newly authorized, temREDUNDANT / tecDUPLICATE = already authorized
      // Both already-authorized codes are success conditions for our purposes
      if (
        meta.TransactionResult === 'tesSUCCESS' ||
        meta.TransactionResult === 'temREDUNDANT' ||
        meta.TransactionResult === 'tecDUPLICATE'
      ) {
        console.log('[Warehouse] Authorized issuance:', issuanceId);
        return true;
      }
      console.warn('[Warehouse] Auth failed:', meta.TransactionResult);
      return false;
    } catch (err: any) {
      console.error('[Warehouse] Auth exception:', err.message);
      if (err.message?.includes('temREDUNDANT') || err.message?.includes('tecDUPLICATE')) return true;
      return false;
    }
  };

  // ── Task 3.7 — Receive Inventory (mint against existing SKU) ─────────────
  // XRPL MPTs: issuer cannot pay themselves. We pay tokens to a warehouse wallet
  // (a second vendor-controlled account). OutstandingAmount = units in warehouse.
  // The warehouse wallet address is stored in localStorage and set once via UI.
  const receiveInventory = async () => {
    if (!receiveModalItem || !vendorProfile.seed) return;
    const qty = parseInt(receiveQty, 10);
    if (!qty || qty <= 0) return alert('Enter a valid quantity greater than 0.');

    // Look up fresh mptIssuanceId from current vendorInventoryV2 state
    const freshItem = vendorInventoryV2.find(i => i.nftId === receiveModalItem.nftId);
    const resolvedIssuanceId = freshItem?.mptIssuanceId || receiveModalItem.mptIssuanceId;
    console.log('[Receive] resolvedIssuanceId:', resolvedIssuanceId);

    if (!resolvedIssuanceId) {
      return alert('No MPT issuance found for this item. Cannot receive inventory.');
    }
    if (!warehouseWalletAddress) {
      setShowReceiveModal(false);
      setShowWarehouseSetup(true);
      return;
    }

    setReceiveLoading(true);
    setReceiveResult('⏳ Authorizing warehouse wallet...');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);

      // Step 1: Authorize warehouse wallet for this issuance using its seed
      const authorized = await authorizeWarehouseForIssuance(resolvedIssuanceId);
      if (!authorized) {
        throw new Error('Failed to authorize warehouse wallet. Make sure the warehouse seed is saved in warehouse setup.');
      }

      // Step 2: Issuer pays tokens to warehouse wallet — increases OutstandingAmount
      setReceiveResult('⏳ Sending tokens to warehouse...');
      const mintPayment: any = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: warehouseWalletAddress,
        Amount: {
          mpt_issuance_id: resolvedIssuanceId,
          value: qty.toString()
        },
        Memos: [buildMemo(SCPO_ACTIONS.RECEIVE_INV, receiveModalItem.nftId, {
          mptId: resolvedIssuanceId,
          pn:    receiveModalItem.partNumber,
          qty,
          lot:   receiveLotRef || '',
        })]
      };
      const prepared = await client.autofill(mintPayment);
      if (!prepared.Fee || parseInt(prepared.Fee) < 12) prepared.Fee = '12';
      const signed = wallet.sign(prepared);
      const result = await submitBlobQueued(signed.tx_blob);
      const meta = result.result.meta as any;

      if (meta.TransactionResult !== 'tesSUCCESS') {
        if (meta.TransactionResult === 'tecNO_AUTH') {
          throw new Error('Warehouse wallet has not authorized this MPT. The warehouse wallet must run MPTokenAuthorize for this issuance first.');
        }
        throw new Error(`Receive failed: ${meta.TransactionResult}`);
      }

      setReceiveResult(`✅ Received ${qty} ${receiveModalItem.unit} of ${receiveModalItem.name}.\nTx: ${result.result.hash}`);

      // Refresh inventory from chain — OutstandingAmount is source of truth
      // listPrice/unitCost are embedded in each item — no separate valuation call needed
      const freshWallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const freshItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, freshWallet);
      setVendorInventoryV2(freshItems);
      const updatedModalItem = freshItems.find((i: InventoryItemV2) => i.nftId === receiveModalItem.nftId);
      if (updatedModalItem) setReceiveModalItem(updatedModalItem);
      setReceiveQty('');
      setReceiveLotRef('');
    } catch (err: any) {
      setReceiveResult('❌ Error: ' + err.message);
    } finally {
      setReceiveLoading(false);
    }
  };
  // Fetches and decrypts each item's vendorUri IPFS doc to extract listPrice
  // and unitCost. Results stored in invPricingMap keyed by nftId.
  // Called after vendorInventoryV2 loads. Runs in background — UI stays live.
  const loadInventoryValuation = async (items: InventoryItemV2[]) => {
    if (!vendorProfile.seed || items.length === 0) return;
    setInvValuationLoading(true);
    const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
    const newMap: { [nftId: string]: { listPrice: number; unitCost: number; currency: string } } = {};
    for (const item of items) {
      if (!item.vendorUri) continue;
      try {
        const doc = await fetchVendorInventoryDoc(item.vendorUri, wallet);
        const listPrice = parseFloat(doc.pricing?.listPrice || '0') || 0;
        const unitCost = parseFloat(doc.cost?.unitCost || '0') || 0;
        const currency = doc.pricing?.currency || doc.cost?.currency || 'USD';
        newMap[item.nftId] = { listPrice, unitCost, currency };
      } catch (err) {
        console.warn('[Valuation] Failed to load pricing for', item.partNumber, err);
      }
    }
    setInvPricingMap(newMap);
    setInvValuationLoading(false);
  };
  // ── Task 3.5 — Check/Register catalog DID service endpoint ──────────────
  // Called when vendor opens the Inventory tab.
  // Resolves their DID, checks if a catalog service endpoint is registered,
  // and shows status. The endpoint is auto-registered on the next profile save,
  // but the vendor can also trigger a manual re-registration here.
  const checkCatalogDIDEndpoint = async () => {
    if (!vendorProfile.classicAddress) return;
    setCatalogDIDStatus('checking');
    try {
      const didResult = await resolveDID(vendorProfile.classicAddress);
      if (!didResult.didDocument) {
        setCatalogDIDStatus('no_did');
        setCatalogDIDUri(null);
        return;
      }
      const catalogUri = getCatalogUriFromDID(didResult.didDocument);
      if (catalogUri) {
        setCatalogDIDStatus('registered');
        setCatalogDIDUri(catalogUri);
      } else {
        setCatalogDIDStatus('not_registered');
        setCatalogDIDUri(null);
      }
    } catch (err) {
      console.error('[DID 3.5] checkCatalogDIDEndpoint failed:', err);
      setCatalogDIDStatus('not_registered');
      setCatalogDIDUri(null);
    }
  };

  // ── Task 3.5 — Manually register/refresh catalog DID service endpoint ────
  // Performs a DIDSet transaction updating the DID document to include the
  // catalog service endpoint. Preserves existing profile URI and public key.
  const registerCatalogDIDEndpoint = async () => {
    if (!vendorProfile.seed || !vendorProfile.classicAddress) {
      return alert('Vendor wallet seed required. Save your profile first.');
    }
    setCatalogDIDStatus('checking');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      
      // Fetch current DID to preserve URI and Data fields
      const didResult = await resolveDID(wallet.classicAddress);
      const currentProfileUri = didResult.uri || vendorProfile.ipfsUri || '';
      if (!currentProfileUri) {
        setCatalogDIDStatus('not_registered');
        return alert('No profile URI found. Save your profile first to create a DID, then register the catalog endpoint.');
      }
      
      const catalogUri = buildCatalogUri(wallet.classicAddress);
      const newDocStr = buildDIDDocument(wallet.publicKey, currentProfileUri, catalogUri);
      
      // Preserve existing Data field if present (contains tier, version, parent).
      // Only include Data field if we have a valid non-empty value — XRPL throws
      // temMALFORMED if Data is present but empty, or if JSON.stringify produces "null".
      let currentDataStr: string | null = null;
      if (didResult.data && typeof didResult.data === 'object' && Object.keys(didResult.data).length > 0) {
        currentDataStr = JSON.stringify(didResult.data);
      } else if (vendorProfile.profileVersion) {
        currentDataStr = buildDIDData('basic', vendorProfile.profileVersion);
      }

      console.log('[DID 3.5] currentProfileUri:', currentProfileUri);
      console.log('[DID 3.5] currentProfileUri hex:', xrpl.convertStringToHex(currentProfileUri));
      console.log('[DID 3.5] newDocStr:', newDocStr);
      console.log('[DID 3.5] newDocStr hex:', xrpl.convertStringToHex(newDocStr));
      console.log('[DID 3.5] currentDataStr:', currentDataStr);
      console.log('[DID 3.5] wallet.classicAddress:', wallet.classicAddress);

      const didSet: any = {
        TransactionType: 'DIDSet',
        Account: wallet.classicAddress,
        URI: xrpl.convertStringToHex(currentProfileUri),
        DIDDocument: xrpl.convertStringToHex(newDocStr),
        ...(currentDataStr ? { Data: xrpl.convertStringToHex(currentDataStr) } : {})
      };
      console.log('[DID 3.5] didSet before autofill:', JSON.stringify(didSet, null, 2));
      const prepared = await client.autofill(didSet);
      // Ensure fee is at least 12 drops — autofill sometimes returns "1" on devnet
      if (!prepared.Fee || parseInt(prepared.Fee) < 12) {
        prepared.Fee = '12';
      }
      console.log('[DID 3.5] prepared tx:', JSON.stringify(prepared, null, 2));
      const signed = wallet.sign(prepared);
      const result = await submitBlobQueued(signed.tx_blob);
      console.log('[DID 3.5] submit result:', JSON.stringify(result.result, null, 2));
      const meta = result.result.meta as any;
      if (meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error(`DIDSet failed: ${meta.TransactionResult}`);
      }
      
      setCatalogDIDStatus('registered');
      setCatalogDIDUri(catalogUri);
      alert(`✅ Catalog endpoint registered in your DID!\nBuyers can now discover your inventory through DID resolution.\nCatalog URI: ${catalogUri}`);
    } catch (err: any) {
      setCatalogDIDStatus('not_registered');
      alert('Failed to register catalog endpoint: ' + err.message);
    }
  };
  useEffect(() => {
    const loadProfile = (key: string, setProfile: React.Dispatch<React.SetStateAction<Profile>>) => {
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setProfile({ ...parsed, walletHistory: parsed.walletHistory || [], lastOnChainHash: parsed.lastOnChainHash || '', email: parsed.email || '', phone: parsed.phone || '' });
        } catch (e) {
          const newProfile = { company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: getOrGenerateUUID(`${key}UUID`), walletHistory: [], lastOnChainHash: '' };
          setProfile(newProfile); localStorage.setItem(key, JSON.stringify(newProfile));
        }
      } else {
        const newProfile = { company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: getOrGenerateUUID(`${key}UUID`), walletHistory: [], lastOnChainHash: '' };
        setProfile(newProfile); localStorage.setItem(key, JSON.stringify(newProfile));
      }
    };

    loadProfile('customerProfile', setCustomerProfile);
    loadProfile('vendorProfile', setVendorProfile);
    const savedTab = localStorage.getItem('activeTab');
    if (savedTab) setActiveTab(savedTab as any);
    // Seed linked UUIDs from localStorage so they survive until on-chain scan completes
    const savedCustomerVendorUUIDs = localStorage.getItem('customerLinkedVendorUUIDs');
    if (savedCustomerVendorUUIDs) try { setCustomerLinkedVendorUUIDs(JSON.parse(savedCustomerVendorUUIDs)); } catch {}
    const savedVendorCustomerUUIDs = localStorage.getItem('vendorLinkedCustomerUUIDs');
    if (savedVendorCustomerUUIDs) try { setVendorLinkedCustomerUUIDs(JSON.parse(savedVendorCustomerUUIDs)); } catch {}
    const savedPublicProfiles = localStorage.getItem('publicProfiles');
    if (savedPublicProfiles) try { setPublicProfiles(JSON.parse(savedPublicProfiles)); } catch {}
    const savedItems = localStorage.getItem('createItems');
    if (savedItems) try { setItems(JSON.parse(savedItems)); } catch { setItems([]); }

    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const customerAddress = customerProfile.classicAddress;
    const vendorAddress = vendorProfile.classicAddress;
    if (!customerAddress && !vendorAddress) return;

    // Scan both wallets independently so vendor links and customer links are both found
    const addressesToScan = [customerAddress, vendorAddress].filter(Boolean) as string[];
    let isCancelled = false;

    Promise.all(addressesToScan.map(addr => scanLinkedProfiles(addr)))
      .then(async results => {
        if (isCancelled) return;
        const chainLinks = results.flat();
        if (chainLinks.length === 0) return;
        console.log(`[LinkScanner] Found ${chainLinks.length} on-chain link(s)`);

      const customerVendors = new Set<string>();
      const vendorCustomers = new Set<string>();
      const newPublicProfiles: { [uuid: string]: any } = {};
      const newProfileLinks: ProfileLink[] = [];
      for (const link of chainLinks) {
        const isCustomerLink = link.linkerAddress === customerAddress;
        const isVendorLink = link.linkerAddress === vendorAddress;

        if (link.linkeeProfileUUID) {
          if (isCustomerLink) customerVendors.add(link.linkeeProfileUUID);
          if (isVendorLink) vendorCustomers.add(link.linkeeProfileUUID);

          newProfileLinks.push({
            linkerUUID: isCustomerLink ? customerProfile.profileUUID : vendorProfile.profileUUID,
            linkeeUUID: link.linkeeProfileUUID,
            linkerAddress: link.linkerAddress,
            linkeeAddress: link.linkeeAddress,
            txHash: link.txHash,
            createdAt: link.createdAt,
          });

          // Seed publicProfiles with basic data from memo
          if (link.linkeeIpfsUri) {
            newPublicProfiles[link.linkeeProfileUUID] = {
              classicAddress: link.linkeeAddress,
              profileUUID: link.linkeeProfileUUID,
              ipfsUri: link.linkeeIpfsUri,
              timestamp: link.createdAt,
              walletHistory: [],
            };
          }
        }
      }

      // Only update if the UUIDs actually changed (prevents new array reference causing re-render loop)
      setCustomerLinkedVendorUUIDs(prev => {
        const next = Array.from(customerVendors);
        // Merge on-chain links with any locally-added links not yet on-chain
        const merged = Array.from(new Set([...prev, ...next]));
        if (merged.length === prev.length && merged.every(u => prev.includes(u))) return prev;
        return merged;
      });
      setVendorLinkedCustomerUUIDs(prev => {
        const next = Array.from(vendorCustomers);
        // Merge on-chain links with any locally-added links not yet on-chain
        const merged = Array.from(new Set([...prev, ...next]));
        if (merged.length === prev.length && merged.every(u => prev.includes(u))) return prev;
        return merged;
      });
      if (newProfileLinks.length > 0) setProfileLinks(newProfileLinks);
      if (Object.keys(newPublicProfiles).length > 0) {
        setPublicProfiles(prev => ({ ...prev, ...newPublicProfiles }));
      }

      // Step 2: Resolve full profiles via DID for each linked wallet
      for (const link of chainLinks) {
        if (!link.linkeeAddress || !link.linkeeProfileUUID) continue;
        try {
          const didResult = await resolveDID(link.linkeeAddress);
          if (!didResult.uri || !didResult.didDocument?.vm) continue;
          const theirPubKey = didResult.didDocument.vm;
          const decryptionKey = deriveSharedSecret(theirPubKey, theirPubKey);
          const profileUri = didResult.didDocument?.svc?.[0] || didResult.uri;
          const fullProfile = await fetchAndDecryptProfileFromIPFS(profileUri, decryptionKey);
          const incoming = {
            ...fullProfile,
            classicAddress: link.linkeeAddress,
            profileUUID: link.linkeeProfileUUID,
            ipfsUri: profileUri,
            linkTxHash: link.txHash,
            timestamp: link.createdAt,
            walletHistory: fullProfile.walletHistory || [],
          };
          if (!isCancelled) setPublicProfiles(prev => {
            const existing = prev[link.linkeeProfileUUID];
            if (existing?.ipfsUri === incoming.ipfsUri && existing?.timestamp === incoming.timestamp) {
              return prev;
            }
            return { ...prev, [link.linkeeProfileUUID]: incoming };
          });
          console.log(`[LinkScanner] ✅ Full profile resolved for ${link.linkeeAddress}`);
        } catch (err) {
          console.warn(`[LinkScanner] Could not resolve full profile for ${link.linkeeAddress}:`, err);
        }
      }
    // Pass resolved data directly to the next load — React hasn't synced
      // setVendorLinkedCustomerUUIDs to the ref yet at this point in the callback
      const resolvedProfiles: { [uuid: string]: PublicProfile } = { ...publicProfilesRef.current };
      for (const link of chainLinks) {
        if (link.linkeeProfileUUID && newPublicProfiles[link.linkeeProfileUUID]) {
          resolvedProfiles[link.linkeeProfileUUID] = newPublicProfiles[link.linkeeProfileUUID];
        }
      }
      pendingVendorUUIDsRef.current = Array.from(vendorCustomers);
      pendingPublicProfilesRef.current = resolvedProfiles;
    }).catch(err => {
        console.error('[LinkScanner] Failed to reconstruct linked profiles:', err);
      });
  return () => { isCancelled = true; };
  }, [hydrated, customerProfile.classicAddress, vendorProfile.classicAddress]);

  useEffect(() => {
    if (customerProfile.seed) setSeed(customerProfile.seed);
  }, [customerProfile.seed]);

  useEffect(() => {
    if (vendorProfile.seed) {
      setVendorAcceptSeed(vendorProfile.seed);
      setClaimSeed(vendorProfile.seed);
    }
  }, [vendorProfile.seed]);

  useEffect(() => { if (!hydrated) return; localStorage.setItem('activeTab', activeTab); }, [activeTab, hydrated]);

  useEffect(() => {
    if (activeTab !== 'accounting') return;
    // ── Phase 6A: Load yield positions for customer mode ──────────────────────
    if (mode === 'customer' && customerProfile.classicAddress) {
      setYieldLoading(true);
      scanYieldPositions(customerProfile.classicAddress).then(positions => {
        // Filter out positions with no principal (created before amt was added to memo)
        const validPositions = positions.filter(p => parseFloat(p.principalAmount) > 0);
        setYieldPositions(validPositions);
        setYieldSummary(computeYieldSummary(validPositions, yieldPartnerRegistry));
        setYieldLoading(false);
      }).catch((e) => { console.error('[YieldDashboard] scan error:', e); setYieldLoading(false); });
    }
    if (auditLog.length > 0) return;
    const addr = mode === 'customer' ? customerProfile.classicAddress : vendorProfile.classicAddress;
    if (!addr) return;
    setAuditLogLoading(true);

    const loadAuditLog = async () => {
      try {
        // Scan own wallet first
        const ownEntries = await scanAuditLog(addr);

        // In customer mode: CLAIM_PO memos live on vendor wallets (vendor sends the receipt)
        // In vendor mode: FUND_ESCROW memos live on buyer wallets (buyer creates the escrow)
        // Scan all linked counterparty wallets and merge their relevant entries
        const counterpartyUUIDs = mode === 'customer'
          ? customerLinkedVendorUUIDs
          : vendorLinkedCustomerUUIDs;

        const counterpartyEntries: AuditLogEntry[] = [];
        for (const uuid of counterpartyUUIDs) {
          const counterpartyAddr = publicProfiles[uuid]?.classicAddress;
          if (!counterpartyAddr) continue;
          try {
            const entries = await scanAuditLog(counterpartyAddr);
            // Only pull entries that reference POs belonging to the current user
            const ownIssuanceIds = new Set(savedPOs.map(p => p.issuanceId));
            const relevant = entries.filter(e =>
              ownIssuanceIds.has(e.ref) &&
              (e.action === 'CLAIM_PO' || e.action === 'FUND_ESCROW' || e.action === 'ACCEPT_PO')
            );
            counterpartyEntries.push(...relevant);
          } catch { /* skip unreachable wallets */ }
        }

        // Merge and deduplicate by txHash
        const seen = new Set<string>();
        const merged: AuditLogEntry[] = [];
        for (const entry of [...ownEntries, ...counterpartyEntries]) {
          const key = entry.txHash || `${entry.action}_${entry.ref}_${entry.timestamp}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(entry);
          }
        }
        merged.sort((a, b) => b.timestamp - a.timestamp);
        setAuditLog(merged);
      } catch (e) {
        console.error('Failed to load audit log:', e);
      } finally {
        setAuditLogLoading(false);
      }
    };

    loadAuditLog();
  }, [activeTab]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('createItems', JSON.stringify(items)); }, [items, hydrated]);

  // ===== ECDH KEY EXCHANGE (Task 1.5) =====
  // Derives a shared secret between two XRPL Ed25519 wallets using X25519 ECDH.
  // Both parties independently derive the SAME shared secret — no password exchange needed.
  //
  // How it works:
  // 1. XRPL Ed25519 private key → convert to X25519 private key
  // 2. Their Ed25519 public key (from DID or wallet) → convert to X25519 public key
  // 3. X25519 ECDH → 32-byte shared secret
  // 4. SHA-256 hash → use as CryptoJS AES password string
  
  const deriveSharedSecret = (myPrivateKeyHex: string, theirPublicKeyHex: string): string => {
    // XRPL Ed25519 private keys are prefixed with "00", remove it
    let privKeyClean = myPrivateKeyHex;
    if (privKeyClean.length === 66) {
      privKeyClean = privKeyClean.slice(2);
    }
    
    // XRPL Ed25519 public keys are prefixed with "ED", remove it
    let pubKeyClean = theirPublicKeyHex;
    if (pubKeyClean.length === 66) {
  pubKeyClean = pubKeyClean.slice(2);
}
    
    // Convert Ed25519 keys to X25519 (Curve25519) keys
    const myX25519Priv = edwardsToMontgomeryPriv(hexToBytes(privKeyClean));
    const theirX25519Pub = edwardsToMontgomeryPub(hexToBytes(pubKeyClean));
    
    // Perform X25519 ECDH key agreement
    const rawSharedSecret = x25519.getSharedSecret(myX25519Priv, theirX25519Pub);
    
    // Hash the shared secret to get a deterministic password string
    const hashed = sha256(rawSharedSecret);
    return bytesToHex(hashed);
  };
  
  // Helper: hex string to Uint8Array
  const hexToBytes = (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  };

  // Derive shared secret for encrypting MY OWN profile (self-encryption)
  // Uses my own private key + my own public key = deterministic self-key
  const deriveSelfEncryptionKey = (wallet: any): string => {
    return deriveSharedSecret(wallet.publicKey, wallet.publicKey);
  };

  // Derive shared secret between my wallet and another wallet's public key
  // This is the key used when I encrypt data FOR them, or decrypt data FROM them
  const deriveEncryptionKeyWithPeer = (myWallet: any, theirPublicKeyHex: string): string => {
    return deriveSharedSecret(myWallet.privateKey, theirPublicKeyHex);
  };

  // ─────────────────────────────────────────────────────────────────────────────
// Task 3.1b — Two-Tier IPFS Upload Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * uploadVendorInventoryDoc
 * Encrypts the vendor-only inventory document with the vendor's self-encryption
 * key (ECDH of own public key with own public key — only the vendor can reproduce
 * this key) and uploads the ciphertext to IPFS via Pinata.
 *
 * @param doc      - Full VendorInventoryDoc object
 * @param wallet   - Vendor's xrpl.Wallet (needs publicKey + privateKey)
 * @returns        - IPFS URI: ipfs://Qm...
 */
const uploadVendorInventoryDoc = async (
  doc: VendorInventoryDoc,
  wallet: xrpl.Wallet
): Promise<string> => {
  // Derive self-encryption key: ECDH(myPub, myPub) → deterministic key
  // Only this wallet can reproduce this key
  const encryptionKey = deriveSelfEncryptionKey(wallet);

  const ipfsUri = await uploadEncryptedToIPFS(doc, encryptionKey);

  console.log(`✅ Vendor inventory doc uploaded: ${ipfsUri}`);
  return ipfsUri;
};

/**
 * uploadSharedInventoryDoc
 * Encrypts the customer-shared inventory document with a key derived from the
 * vendor's public key alone (ECDH of vendorPubKey with vendorPubKey).
 *
 * Decryption by customer:
 *   const decryptionKey = deriveSharedSecret(vendorPubKey, vendorPubKey)
 * The vendor's public key is available from their DID document (vm field),
 * so any linked customer who has resolved the vendor's DID can decrypt.
 *
 * @param doc          - SharedInventoryDoc object (no cost/supplier data)
 * @param vendorWallet - Vendor's xrpl.Wallet (needs publicKey for key derivation)
 * @returns            - IPFS URI: ipfs://Qm...
 */
const uploadSharedInventoryDoc = async (
  doc: SharedInventoryDoc,
  vendorWallet: xrpl.Wallet
): Promise<string> => {
  // Derive shared key from vendor's own public key.
  // Any party with the vendor's public key can derive this same key:
  //   const decryptionKey = deriveSharedSecret(vendorPubKey, vendorPubKey)
  const encryptionKey = deriveSharedSecret(vendorWallet.publicKey, vendorWallet.publicKey);

  const ipfsUri = await uploadEncryptedToIPFS(doc, encryptionKey);

  console.log(`✅ Shared inventory doc uploaded: ${ipfsUri}`);
  return ipfsUri;
};

/**
 * fetchVendorInventoryDoc
 * Fetches and decrypts a VendorInventoryDoc from IPFS using the vendor's
 * self-encryption key. Only callable by the vendor (requires their wallet).
 *
 * @param uri    - IPFS URI: ipfs://Qm...
 * @param wallet - Vendor's xrpl.Wallet
 * @returns      - Decrypted VendorInventoryDoc
 */
const fetchVendorInventoryDoc = async (
  uri: string,
  wallet: xrpl.Wallet
): Promise<VendorInventoryDoc> => {
  const encryptionKey = deriveSelfEncryptionKey(wallet);
  const hash = uri.replace('ipfs://', '');
  const gateways = [
    `https://dweb.link/ipfs/${hash}`,
    `https://w3s.link/ipfs/${hash}`,
    `https://ipfs.io/ipfs/${hash}`,
  ];

  let response: Response | null = null;
  for (const url of gateways) {
    try {
      response = await fetch(url, { cache: 'no-store' });
      if (response.ok) break;
    } catch { continue; }
  }
  if (!response || !response.ok) {
    throw new Error(`Failed to fetch vendor inventory doc from IPFS after all gateways`);
  }

  const { encryptedData } = await response.json();
  if (!encryptedData) {
    throw new Error('No encryptedData field in IPFS response');
  }

  const decrypted = CryptoJS.AES.decrypt(encryptedData, encryptionKey).toString(CryptoJS.enc.Utf8);
  if (!decrypted) {
    throw new Error('Decryption failed — wrong key or corrupted data');
  }

  return JSON.parse(decrypted) as VendorInventoryDoc;
};

/**
 * fetchSharedInventoryDoc
 * Fetches and decrypts a SharedInventoryDoc from IPFS using the ECDH key
 * derived from the vendor's public key. Callable by any linked customer who
 * has the vendor's public key (available from their DID document).
 *
 * @param uri          - IPFS URI: ipfs://Qm...
 * @param vendorPubKey - Vendor's Ed25519 public key hex (from DID document vm field)
 * @returns            - Decrypted SharedInventoryDoc
 */
const fetchSharedInventoryDoc = async (
  uri: string,
  vendorPubKey: string
): Promise<SharedInventoryDoc> => {
  // Mirror of uploadSharedInventoryDoc key derivation:
  //   const decryptionKey = deriveSharedSecret(vendorPubKey, vendorPubKey)
  // The vendor's public key is deterministic — any party with it gets the same key.
  const encryptionKey = deriveSharedSecret(vendorPubKey, vendorPubKey);
  const hash = uri.replace('ipfs://', '');
  const gateways = [
    `https://dweb.link/ipfs/${hash}`,
    `https://w3s.link/ipfs/${hash}`,
    `https://ipfs.io/ipfs/${hash}`,
  ];

  let response: Response | null = null;
  for (const url of gateways) {
    try {
      response = await fetch(url, { cache: 'no-store' });
      if (response.ok) break;
    } catch { continue; }
  }
  if (!response || !response.ok) {
    throw new Error(`Failed to fetch shared inventory doc from IPFS after all gateways`);
  }

  const { encryptedData } = await response.json();
  if (!encryptedData) {
    throw new Error('No encryptedData field in IPFS response');
  }

  const decrypted = CryptoJS.AES.decrypt(encryptedData, encryptionKey).toString(CryptoJS.enc.Utf8);
  if (!decrypted) {
    throw new Error('Decryption failed — wrong key or corrupted data');
  }

  return JSON.parse(decrypted) as SharedInventoryDoc;
};

  // ===== DID HELPERS (Phase 1A) =====
  // ── Task 3.5 — Compact DID document (must stay under 256 bytes on-chain) ─
  // Format: { p: profileUri, c: catalogUri, vm: publicKey }
  // 'p' = profile IPFS URI, 'c' = catalog URI (omitted if not vendor),
  // 'vm' = Ed25519 public key hex for ECDH decryption.
  // Catalog URI is just the wallet address — "scpo:c:<addr>" prefix is 8 chars.
  const buildDIDDocument = (publicKey: string, profileUri: string, catalogUri?: string): string => {
    const doc: any = { p: profileUri, vm: publicKey };
    if (catalogUri) doc.c = catalogUri;
    return JSON.stringify(doc);
  };

  // ── Task 3.5 — Compact catalog URI: "scpo:c:<walletAddress>" ─────────────
  const buildCatalogUri = (walletAddress: string): string => {
    return `scpo:c:${walletAddress}`;
  };

  // ── Task 3.5 — Extract catalog URI from a resolved DID document ──────────
  // Handles compact format { p, c, vm }, legacy svc-array formats, and
  // the intermediate verbose service-object format — all gracefully.
  const getCatalogUriFromDID = (didDocument: any): string | null => {
    if (!didDocument) return null;
    // Compact format: { p, c, vm }
    if (didDocument.c) return didDocument.c;
    // Legacy svc-array with service objects
    if (Array.isArray(didDocument.svc)) {
      if (typeof didDocument.svc[0] === 'object') {
        const svc = didDocument.svc.find((s: any) => s.id === 'catalog' || s.type === 'SCPOInventoryCatalog');
        return svc?.uri || null;
      }
      // Legacy bare-string array: second element was catalog URI
      if (didDocument.svc.length >= 2 && typeof didDocument.svc[1] === 'string') {
        const s = didDocument.svc[1];
        if (s.startsWith('scpo:') || s.startsWith('scpo://')) return s;
      }
    }
    return null;
  };

  // ── Task 3.5 — Extract profile URI from a resolved DID document ──────────
  const getProfileUriFromDID = (didDocument: any, fallbackUri?: string | null): string | null => {
    if (!didDocument) return fallbackUri || null;
    // Compact format: { p, c, vm }
    if (didDocument.p) return didDocument.p;
    // Legacy svc-array with service objects
    if (Array.isArray(didDocument.svc)) {
      if (typeof didDocument.svc[0] === 'object') {
        const svc = didDocument.svc.find((s: any) => s.id === 'profile' || s.type === 'SCPOProfile');
        return svc?.uri || fallbackUri || null;
      }
      // Legacy bare-string array: first element was profile URI
      if (typeof didDocument.svc[0] === 'string') return didDocument.svc[0] || fallbackUri || null;
    }
    return fallbackUri || null;
  };

  const buildDIDData = (tier: string = 'basic', profileVersion: number = 1, parentUri?: string): string => {
    const data: any = {
      tier,
      pv: profileVersion
    };
    if (parentUri) data.parent = parentUri;
    return JSON.stringify(data);
  };

  const resolveDID = async (address: string): Promise<{
    uri: string | null;
    didDocument: any | null;
    data: any | null;
    raw: any | null;
  }> => {
    try {
      const client = await getXRPLClient();
      const response = await client.request({
        command: 'ledger_entry',
        did: address,
        ledger_index: 'validated'
      });
      const node = response.result.node as any;
      if (!node || node.LedgerEntryType !== 'DID') {
        return { uri: null, didDocument: null, data: null, raw: null };
      }
      let uri: string | null = null;
      let didDocument: any | null = null;
      let data: any | null = null;
      if (node.URI) {
        try { uri = xrpl.convertHexToString(node.URI); } catch (e) { console.error('Failed to decode DID URI:', e); }
      }
      if (node.DIDDocument) {
        try { didDocument = JSON.parse(xrpl.convertHexToString(node.DIDDocument)); } catch (e) { console.error('Failed to decode DID Document:', e); }
      }
      if (node.Data) {
        try { data = JSON.parse(xrpl.convertHexToString(node.Data)); } catch (e) { console.error('Failed to decode DID Data:', e); }
      }
      return { uri, didDocument, data, raw: node };
    } catch (err: any) {
      if (err?.data?.error === 'entryNotFound') {
        return { uri: null, didDocument: null, data: null, raw: null };
      }
      console.error('DID resolution failed:', err);
      return { uri: null, didDocument: null, data: null, raw: null };
    }
  };
  const saveCustomerProfile = async () => {
    try {
      let updatedProfile = { ...customerProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      const customerHasNoCred = !customerCredStatus || !customerCredStatus.valid;
      if (customerProfile.lastOnChainHash && contentHash === customerProfile.lastOnChainHash && !customerHasNoCred) { console.log('No profile changes'); localStorage.setItem('customerProfile', JSON.stringify(updatedProfile)); return; }
      if (true) {
        const publicProfile: PublicProfile = { company: updatedProfile.company, name: updatedProfile.name, email: updatedProfile.email, phone: updatedProfile.phone, address: updatedProfile.address, city: updatedProfile.city, state: updatedProfile.state, zip: updatedProfile.zip, country: updatedProfile.country, uniqueID: updatedProfile.uniqueID, classicAddress: updatedProfile.classicAddress, profileUUID: updatedProfile.profileUUID, timestamp: Date.now(), walletHistory: updatedProfile.walletHistory };
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        // Phase 1A: Use ECDH-derived key instead of manual password
        const ecdhKey = deriveSelfEncryptionKey(wallet);
        const newIpfsUri = await uploadEncryptedProfileToPinata(publicProfile, ecdhKey);
        
        // Phase 1A: Use DIDSet instead of AccountSet for profile anchoring
        const previousIpfsUri = updatedProfile.ipfsUri || undefined;
        const newVersion = (updatedProfile.profileVersion || 0) + 1;
        // Task 3.5: Register catalog URI as DID service endpoint for vendors
        const vendorCatalogUri = buildCatalogUri(wallet.classicAddress);
        const didDocStr = buildDIDDocument(wallet.publicKey, newIpfsUri, vendorCatalogUri);
        const didDataStr = buildDIDData('basic', newVersion, previousIpfsUri);
        
        const didSet: any = {
          TransactionType: 'DIDSet',
          Account: wallet.classicAddress,
          URI: xrpl.convertStringToHex(newIpfsUri),
          DIDDocument: xrpl.convertStringToHex(didDocStr),
          Data: xrpl.convertStringToHex(didDataStr)
        };
        const preparedSet = await client.autofill(didSet);
        const signedSet = wallet.sign(preparedSet);
        await submitBlobQueued(signedSet.tx_blob);
        
        // Also set Domain for backward compatibility during transition
        try {
          const accountSet: AccountSet = { TransactionType: 'AccountSet', Account: wallet.classicAddress, Domain: xrpl.convertStringToHex(newIpfsUri) };
          const preparedAccSet = await client.autofill(accountSet);
          const signedAccSet = wallet.sign(preparedAccSet);
          await submitBlobQueued(signedAccSet.tx_blob);
        } catch (e) { console.log('AccountSet Domain fallback skipped (non-critical):', e); }

        // Phase 1B: Issue, renew, or skip credential
        if (process.env.REACT_APP_DOMAIN_ID) {
          try {
            const platformWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED!);
            const credResult = await checkAndRenewCredential(client, platformWallet, wallet);
            console.log(`✅ Credential status: ${credResult}`);
          } catch (credErr: any) {
            console.log('Credential check skipped (non-critical):', credErr.message);
          }
        }

        updatedProfile.ipfsUri = newIpfsUri; updatedProfile.lastOnChainHash = contentHash; updatedProfile.profileVersion = newVersion;
        console.log('✅ Profile saved with DID on-chain! URI:', newIpfsUri);
      }
      setCustomerProfile(updatedProfile); localStorage.setItem('customerProfile', JSON.stringify(updatedProfile));
      console.log('Profile saved and posted on-chain!');
      if (updatedProfile.classicAddress && process.env.REACT_APP_DOMAIN_ID) {
        try {
          const result = await validateCredential(updatedProfile.classicAddress, process.env.REACT_APP_DOMAIN_ID);
          setCustomerCredStatus(result);
        } catch { setCustomerCredStatus(null); }
      }
    } catch (err: any) { alert('Failed to post update on-chain: ' + (err.message || String(err))); }
  };

  const saveVendorProfile = async () => {
    try {
      let updatedProfile = { ...vendorProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      const vendorHasNoCred = !vendorCredStatus || !vendorCredStatus.valid;
      if (vendorProfile.lastOnChainHash && contentHash === vendorProfile.lastOnChainHash && !vendorHasNoCred) { console.log('No profile changes'); localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile)); return; }
      if (true) {
        const publicProfile: PublicProfile = { company: updatedProfile.company, name: updatedProfile.name, email: updatedProfile.email, phone: updatedProfile.phone, address: updatedProfile.address, city: updatedProfile.city, state: updatedProfile.state, zip: updatedProfile.zip, country: updatedProfile.country, uniqueID: updatedProfile.uniqueID, classicAddress: updatedProfile.classicAddress, profileUUID: updatedProfile.profileUUID, timestamp: Date.now(), walletHistory: updatedProfile.walletHistory };
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        // Phase 1A: Use ECDH-derived key instead of manual password
        const ecdhKey = deriveSelfEncryptionKey(wallet);
        const newIpfsUri = await uploadEncryptedProfileToPinata(publicProfile, ecdhKey);
        
        // Phase 1A: Use DIDSet instead of AccountSet for profile anchoring
        const previousIpfsUri = updatedProfile.ipfsUri || undefined;
        const newVersion = (updatedProfile.profileVersion || 0) + 1;
        const didDocStr = buildDIDDocument(wallet.publicKey, newIpfsUri);
        const didDataStr = buildDIDData('basic', newVersion, previousIpfsUri);
        
        const didSet: any = {
          TransactionType: 'DIDSet',
          Account: wallet.classicAddress,
          URI: xrpl.convertStringToHex(newIpfsUri),
          DIDDocument: xrpl.convertStringToHex(didDocStr),
          Data: xrpl.convertStringToHex(didDataStr)
        };
        const preparedSet = await client.autofill(didSet);
        const signedSet = wallet.sign(preparedSet);
        await submitBlobQueued(signedSet.tx_blob);
        
        // Also set Domain for backward compatibility during transition
        try {
          const accountSet: AccountSet = { TransactionType: 'AccountSet', Account: wallet.classicAddress, Domain: xrpl.convertStringToHex(newIpfsUri) };
          const preparedAccSet = await client.autofill(accountSet);
          const signedAccSet = wallet.sign(preparedAccSet);
          await submitBlobQueued(signedAccSet.tx_blob);
        } catch (e) { console.log('AccountSet Domain fallback skipped (non-critical):', e); }

        // Phase 1B: Issue, renew, or skip credential
        if (process.env.REACT_APP_DOMAIN_ID) {
          try {
            const platformWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED!);
            const credResult = await checkAndRenewCredential(client, platformWallet, wallet);
            console.log(`✅ Credential status: ${credResult}`);
          } catch (credErr: any) {
            console.log('Credential check skipped (non-critical):', credErr.message);
          }
        }

        updatedProfile.ipfsUri = newIpfsUri; updatedProfile.lastOnChainHash = contentHash; updatedProfile.profileVersion = newVersion;
        console.log('✅ Profile saved with DID on-chain! URI:', newIpfsUri);
      }
      setVendorProfile(updatedProfile); localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile));
      console.log('Profile saved and posted on-chain!');
      if (updatedProfile.classicAddress && process.env.REACT_APP_DOMAIN_ID) {
        try {
          const result = await validateCredential(updatedProfile.classicAddress, process.env.REACT_APP_DOMAIN_ID);
          setVendorCredStatus(result);
        } catch { setVendorCredStatus(null); }
      }
    } catch (err: any) { alert('Failed to post update on-chain: ' + (err.message || String(err))); }
  };

  const uploadEncryptedProfileToPinata = async (profile: PublicProfile, password: string) => {
    if (!password) throw new Error('Password required');
    const profileData = { ...profile };
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(profileData), password).toString();
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pinataApiKey}` }, body: JSON.stringify({ encryptedData: encrypted }) });
    if (!response.ok) throw new Error('Pinata upload failed');
    const result = await response.json();
    return `ipfs://${result.IpfsHash}`;
  };

  const fetchAndDecryptProfileFromIPFS = async (uri: string, password: string): Promise<PublicProfile> => {
    const hash = uri.replace('ipfs://', '');
    const gateways = [`https://gateway.pinata.cloud/ipfs/${hash}`];
    for (const gatewayUrl of gateways) {
      for (let retry = 0; retry < 3; retry++) {
        try {
          const response = await fetch(gatewayUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
          if (response.ok) { const { encryptedData } = await response.json(); const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8); if (!decrypted) throw new Error('Decryption failed'); const profile: PublicProfile = JSON.parse(decrypted); return profile; }
        } catch (err) { console.error(`Failed with gateway ${gatewayUrl} (attempt ${retry + 1}):`, err); await new Promise(resolve => setTimeout(resolve, 2000)); }
      }
    }
    throw new Error('Failed to fetch from all IPFS gateways after retries');
  };

  const hashProfileContent = async (profile: any): Promise<string> => {
    const { ipfsUri, lastOnChainHash, ...contentOnly } = profile;
    const canonical = JSON.stringify(contentOnly, Object.keys(contentOnly).sort());
    const buffer = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

const addLinkedVendorByDID = async () => {
    if (!inputVendorWalletAddress) return alert('Enter vendor wallet address');
    try {
      // Step 1: Resolve DID
      const didResult = await resolveDID(inputVendorWalletAddress);
      if (!didResult.uri) return alert('No DID found for this wallet address. The vendor must save their profile on-chain first.');
      if (!didResult.didDocument?.vm) return alert('DID found but no public key in DID document.');
      
      // Step 2: Derive decryption key from their public key
      const theirPubKey = didResult.didDocument.vm;
      const decryptionKey = deriveSharedSecret(theirPubKey, theirPubKey);
      
      // Step 3: Decrypt profile from IPFS
      // Task 3.5: Use getProfileUriFromDID to support both v1 and v2 DID doc formats
      const ipfsUri = getProfileUriFromDID(didResult.didDocument, didResult.uri) || didResult.uri!;
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptionKey);
      decoded.ipfsUri = ipfsUri;
      decoded.classicAddress = inputVendorWalletAddress;

      // Task 3.5: Check if vendor has a catalog service endpoint registered
      const catalogUri = getCatalogUriFromDID(didResult.didDocument);
      if (catalogUri) {
        console.log(`[DID 3.5] Vendor ${inputVendorWalletAddress} has catalog endpoint: ${catalogUri}`);
      } else {
        console.log(`[DID 3.5] Vendor ${inputVendorWalletAddress} has no catalog endpoint in DID (older profile).`);
      }
            
      // Step 4: Store profile
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles); localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!customerLinkedVendorUUIDs.includes(decoded.profileUUID)) { 
        const updatedUUIDs = [...customerLinkedVendorUUIDs, decoded.profileUUID]; 
        setCustomerLinkedVendorUUIDs(updatedUUIDs); 
        localStorage.setItem('customerLinkedVendorUUIDs', JSON.stringify(updatedUUIDs)); 
      }
      
      setInputVendorWalletAddress('');
      const catalogMsg = catalogUri ? '\n📦 Catalog endpoint registered — inventory is discoverable.' : '';
      alert(`Vendor linked via DID! No password needed.${catalogMsg}`);
      await recordLinkOnChain(customerProfile, decoded, true);
    } catch (err: any) { alert('Failed to link vendor: ' + (err.message || 'DID resolution failed')); }
  };

  const addLinkedCustomerByDID = async () => {
    if (!inputCustomerWalletAddress) return alert('Enter customer wallet address');
    try {
      // Step 1: Resolve DID
      const didResult = await resolveDID(inputCustomerWalletAddress);
      if (!didResult.uri) return alert('No DID found for this wallet address. The customer must save their profile on-chain first.');
      if (!didResult.didDocument?.vm) return alert('DID found but no public key in DID document.');
      
      // Step 2: Derive decryption key from their public key
      const theirPubKey = didResult.didDocument.vm;
      const decryptionKey = deriveSharedSecret(theirPubKey, theirPubKey);
      
      // Step 3: Decrypt profile from IPFS
      const ipfsUri = didResult.uri;
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptionKey);
      decoded.ipfsUri = ipfsUri;
      decoded.classicAddress = inputCustomerWalletAddress;
            
      // Step 4: Store profile
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles); localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!vendorLinkedCustomerUUIDs.includes(decoded.profileUUID)) { 
        const updatedUUIDs = [...vendorLinkedCustomerUUIDs, decoded.profileUUID]; 
        setVendorLinkedCustomerUUIDs(updatedUUIDs); 
        localStorage.setItem('vendorLinkedCustomerUUIDs', JSON.stringify(updatedUUIDs)); 
      }
      
      setInputCustomerWalletAddress('');
      alert('Customer linked via DID! No password needed.');
      await recordLinkOnChain(vendorProfile, decoded, false);
    } catch (err: any) { alert('Failed to link customer: ' + (err.message || 'DID resolution failed')); }
  };
  const recordLinkOnChain = async (linker: Profile, linkee: PublicProfile, isVendor: boolean) => {
    if (!linker.seed) return alert('Wallet seed required');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(linker.seed);
      const payment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: linkee.classicAddress, Amount: '1', Memos: [buildMemo(SCPO_ACTIONS.LINK_PROFILE, linkee.classicAddress, { linkedAddr: linkee.classicAddress, role: linker.classicAddress === customerProfile.classicAddress ? 'customer' : 'vendor', profileUUID: linkee.profileUUID, ipfsUri: linkee.ipfsUri || '' })] };
      const prepared = await client.autofill(payment);
      const signed = wallet.sign(prepared);
      const result = await submitBlobQueued(signed.tx_blob);
      if (typeof result.result.meta === 'object' && result.result.meta.TransactionResult === 'tesSUCCESS') {
        const updatedProfile = { ...linkee, linkTxHash: result.result.hash };
        setPublicProfiles(prev => ({ ...prev, [linkee.profileUUID]: updatedProfile }));
        const newLink: ProfileLink = { linkerUUID: linker.profileUUID, linkeeUUID: linkee.profileUUID, linkerAddress: linker.classicAddress, linkeeAddress: linkee.classicAddress, txHash: result.result.hash, createdAt: Date.now() };
        const updatedLinks = [...profileLinks, newLink];
        setProfileLinks(updatedLinks); localStorage.setItem('profileLinks', JSON.stringify(updatedLinks));
        alert('Link recorded on-chain! Tx Hash: ' + result.result.hash);
      } else { alert('Failed to record link on-chain'); }
    } catch (err: any) { alert('Failed to record on-chain: ' + err.message); }
  };

  const verifyLink = async (profileA: { classicAddress: string; profileUUID: string }, profileB: { classicAddress: string; profileUUID: string }) => {
    const link = profileLinks.find(l => ((l.linkerUUID === profileA.profileUUID && l.linkeeUUID === profileB.profileUUID) || (l.linkerUUID === profileB.profileUUID && l.linkeeUUID === profileA.profileUUID)) && ((l.linkerAddress === profileA.classicAddress && l.linkeeAddress === profileB.classicAddress) || (l.linkerAddress === profileB.classicAddress && l.linkeeAddress === profileA.classicAddress)));
    if (!link) { alert('No link found to verify'); return false; }
    try {
      const client = await getXRPLClient();
      const tx = await client.request({ command: 'tx', transaction: link.txHash });
      if (tx.result.validated) { alert('Link verified on-chain!'); return true; } else { alert('Link not validated on-chain yet'); return false; }
    } catch (err: any) { alert('Verification failed: ' + (err.message || 'Connection issue')); return false; }
  };

  const manualRefreshProfile = async (uuid: string) => {
    if (!hydrated || isRefreshing) return; setIsRefreshing(true);
    const profile = publicProfiles[uuid];
    if (!profile) { setIsRefreshing(false); return; }
    let latest: PublicProfile | null = null; let latestUri = ''; let fetchFailed = false;
    const uniqueWallets = new Set([...(profile.walletHistory || []), profile.classicAddress]);
    const walletsToPoll = Array.from(uniqueWallets).filter(addr => xrpl.isValidAddress(addr));
    for (const walletAddr of walletsToPoll) {
      // Phase 1A: Try DID resolution first, fallback to AccountSet Domain
      let uri: string | null = null;
      try {
        const didResult = await resolveDID(walletAddr);
        if (didResult.uri) {
          uri = didResult.uri;
          console.log(`Profile resolved via DID for ${walletAddr}`);
        }
      } catch (e) { console.log('DID resolution failed, trying Domain fallback'); }
      if (!uri) {
        uri = await getLatestProfileHashFromChain(walletAddr);
      }
      if (uri && uri !== profile.ipfsUri) {
        let updated: PublicProfile | null = null;
        
        // Phase 1A: Try ECDH decryption first
        const myWallet = customerProfile.seed 
          ? xrpl.Wallet.fromSeed(customerProfile.seed) 
          : vendorProfile.seed 
            ? xrpl.Wallet.fromSeed(vendorProfile.seed) 
            : null;
        
        if (myWallet && !updated) {
          // Try 1: ECDH with their public key from DID
          try {
            const peerDid = await resolveDID(walletAddr);
            const theirPubKey = peerDid.didDocument?.vm || null;
            if (theirPubKey) {
              const ecdhKey = deriveSharedSecret(theirPubKey, theirPubKey);
              updated = await fetchAndDecryptProfileFromIPFS(uri, ecdhKey);
              console.log(`✅ Profile decrypted via ECDH for ${walletAddr}`);
            }
          } catch (e) { /* ECDH failed, try next method */ }
          
          // Try 2: Self-encryption key (if this is our own profile)
          if (!updated && walletAddr === myWallet.classicAddress) {
            try {
              const selfKey = deriveSelfEncryptionKey(myWallet);
              updated = await fetchAndDecryptProfileFromIPFS(uri, selfKey);
              console.log(`✅ Own profile decrypted via self-key for ${walletAddr}`);
            } catch (e) { /* self-key failed, try legacy */ }
          }
        }
        
        if (updated && updated.profileUUID === uuid && (!latest || updated.timestamp > latest.timestamp)) { latest = updated; latestUri = uri; }
      }
    }
    if (latest !== null) {
      const localHash = await hashProfileContent(profile);
      const chainHash = await hashProfileContent(latest);
      if (localHash !== chainHash) {
        const updatedProfile: PublicProfile = { ...profile, ...latest, ipfsUri: latestUri, linkTxHash: profile.linkTxHash };
        setPublicProfiles(prev => ({ ...prev, [uuid]: updatedProfile }));
        localStorage.setItem('publicProfiles', JSON.stringify({ ...publicProfiles, [uuid]: updatedProfile }));
        console.log('Profile refreshed successfully!');
      } else { console.log('Profile content unchanged.'); }
    } else if (fetchFailed) { console.log('Failed to fetch profile data from IPFS.'); } else { console.log('No profile URI found on chain.'); }
    setIsRefreshing(false);
  };

  const handleRefresh = (uuid: string) => { manualRefreshProfile(uuid); };

  const getLatestProfileHashFromChain = async (address: string): Promise<string | null> => {
    try {
      const client = await getXRPLClient();
      const response: AccountInfoResponse = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
      const domainHex = response.result.account_data.Domain;
      if (domainHex) return xrpl.convertHexToString(domainHex);
      return null;
    } catch (err) { console.error('Account info query failed:', err); return null; }
  };

  const uploadFileToIPFS = async (file: File): Promise<string> => {
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    return pinFileToBoth(file, pinataApiKey);
  };

  const uploadEncryptedToIPFS = async (data: any, password: string) => {
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), password).toString();
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    return pinEncryptedToBoth(encrypted, pinataApiKey);
  };
  const getPOEncryptionKey = (vendorUUID: string): string | null => {
    // Check linked profiles first
    const profile = publicProfiles[vendorUUID];
    if (profile?.classicAddress) return CryptoJS.SHA256(profile.classicAddress).toString();
    // Check if it's our own profile
    if (customerProfile.profileUUID === vendorUUID && customerProfile.classicAddress) return CryptoJS.SHA256(customerProfile.classicAddress).toString();
    if (vendorProfile.profileUUID === vendorUUID && vendorProfile.classicAddress) return CryptoJS.SHA256(vendorProfile.classicAddress).toString();
    return null;
  };
  const uploadToIPFS = async (data: any) => {
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    return pinJSONToBoth(data, pinataApiKey);
  };

  const fetchFromIPFS = async (uri: string): Promise<any> => {
    const hash = uri.replace('ipfs://', '');
    const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${hash}`;
    try {
      const response = await fetch(gatewayUrl, { cache: 'no-store' });
      if (response.ok) return await response.json();
    } catch (err) { console.error(`Failed to fetch from ${gatewayUrl}:`, err); }
    throw new Error('Failed to fetch from Pinata gateway');
  };

  const getXrpPriceUsd = async (): Promise<number> => {
    try { const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd'); const data = await response.json(); return data.ripple.usd; } catch { return 0.5; }
  };

  // DID Status Badge — checks on-chain DID, not just local ipfsUri
  const DIDStatusBadge = ({ address }: { address: string }) => {
    const [didStatus, setDidStatus] = React.useState<'checking' | 'active' | 'none'>('checking');
    const [didHash, setDidHash] = React.useState<string>('');
    const [didVersion, setDidVersion] = React.useState<number>(0);
    const [didParent, setDidParent] = React.useState<string>('');

    React.useEffect(() => {
      let cancelled = false;
      const check = async () => {
        try {
          const result = await resolveDID(address);
          if (cancelled) return;
          if (result.raw) {
            setDidStatus('active');
            if (result.uri) setDidHash(result.uri.replace('ipfs://', ''));
            if (result.data) {
              setDidVersion(result.data.pv || 0);
              setDidParent(result.data.parent || '');
            }
          } else {
            setDidStatus('none');
          }
        } catch {
          if (!cancelled) setDidStatus('none');
        }
      };
      check();
      return () => { cancelled = true; };
    }, [address]);

    if (didStatus === 'checking') {
      return (
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <span style={{ background: '#888', color: 'white', padding: '6px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold' }}>
            Checking DID...
          </span>
        </div>
      );
    }
    if (didStatus === 'active') {
      return (
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <span style={{ background: '#27ae60', color: 'white', padding: '6px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold' }}>
            DID Active ✓
          </span>
          {didHash && <p style={{ color: '#888', fontSize: '12px', marginTop: '8px', cursor: 'pointer' }} onClick={() => { navigator.clipboard.writeText(didHash); alert('DID hash copied!'); }}>DID Document: {didHash.substring(0, 12)}... 📋</p>}
          {didVersion > 0 && <p style={{ color: '#888', fontSize: '12px', marginTop: '4px' }}>Profile Version: {didVersion}{didParent ? <span style={{ cursor: 'pointer' }} onClick={() => { navigator.clipboard.writeText(didParent.replace('ipfs://', '')); alert('Previous profile IPFS hash copied!'); }}> · Previous: {didParent.replace('ipfs://', '').substring(0, 12)}... 📋</span> : ' · First version'}</p>}
        </div>
      );
    }
    return (
      <div style={{ textAlign: 'center', marginBottom: '20px' }}>
        <span style={{ background: '#ff9800', color: 'white', padding: '6px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold' }}>
          No DID
        </span>
        <p style={{ color: '#888', fontSize: '12px', marginTop: '8px' }}>
          Post on-chain to create your DID identity
        </p>
      </div>
    );
  };
// ── Task 3.8 — gateway-aware IPFS URL resolver ───────────────────────────
  const IPFS_GATEWAYS = [
    (h: string) => `https://dweb.link/ipfs/${h}`,
    (h: string) => `https://w3s.link/ipfs/${h}`,
    (h: string) => `https://ipfs.io/ipfs/${h}`,
  ];
  const resolveIpfsDisplayUrl = (uri: string) => {
    const hash = uri.replace('ipfs://', '');
    return IPFS_GATEWAYS[0](hash);
  };

// ── DocumentPreview component (gateway-aware) ────────────────────────────
  const DocumentPreview = ({ uri, name }: { uri: string; name: string }) => {
    const [loading, setLoading] = React.useState(true);
    const [gatewayIdx, setGatewayIdx] = React.useState(0);
    const hash = uri.replace('ipfs://', '');
    const gatewayUrl = IPFS_GATEWAYS[Math.min(gatewayIdx, IPFS_GATEWAYS.length - 1)](hash);
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const isPDF = ext === 'pdf';
    if (isPDF) {
      return (
        <div style={{ marginTop: '10px' }}>
          <p style={{ color: '#F2B04A', fontWeight: 'bold', marginBottom: '5px', fontSize: '13px' }}>{name}</p>
          {loading && <p style={{ color: '#888', fontSize: '12px' }}>Loading preview...</p>}
          <iframe src={gatewayUrl} width="100%" height="380px"
            style={{ border: '1px solid #D88F2E', borderRadius: '10px', display: loading ? 'none' : 'block' }}
            onLoad={() => setLoading(false)} title={name} />
          <a href={gatewayUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: '12px', color: '#F2B04A', display: 'block', marginTop: '5px' }}>
            Open in new tab ↗
          </a>
        </div>
      );
    }
    if (isImage) {
      return (
        <div style={{ marginTop: '10px' }}>
          <p style={{ color: '#F2B04A', fontWeight: 'bold', marginBottom: '5px', fontSize: '13px' }}>{name}</p>
          {loading && <p style={{ color: '#888', fontSize: '12px' }}>Loading preview...</p>}
          <img src={gatewayUrl} alt={name}
            style={{ maxWidth: '100%', borderRadius: '10px', display: loading ? 'none' : 'block' }}
            onLoad={() => setLoading(false)} />
        </div>
      );
    }
    return (
      <div style={{ marginTop: '8px' }}>
        <a href={gatewayUrl} target="_blank" rel="noopener noreferrer"
          style={{ background: '#F2B04A', color: 'white', padding: '6px 14px', borderRadius: '20px',
            textDecoration: 'none', fontSize: '13px', display: 'inline-block' }}>
          Download {name} ↓
        </a>
      </div>
    );
  };
  // ── Task 3.8 — ProductImage component ────────────────────────────────────
  const ProductImage = ({ uri, name, size = 56 }: { uri?: string; name: string; size?: number }) => {
    const [gatewayIdx, setGatewayIdx] = React.useState(0);
    const [errored, setErrored] = React.useState(false);
    const hash = uri ? uri.replace('ipfs://', '') : '';
    const src = uri && !errored ? IPFS_GATEWAYS[Math.min(gatewayIdx, IPFS_GATEWAYS.length - 1)](hash) : '';

    const handleError = () => {
      const next = gatewayIdx + 1;
      if (next < IPFS_GATEWAYS.length) {
        setGatewayIdx(next);
      } else {
        setErrored(true);
      }
    };

    if (!uri || errored) {
      return (
        <div style={{
          width: size, height: size, borderRadius: '8px',
          background: '#F3F4F6', display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: size * 0.55, color: '#D1D5DB',
          flexShrink: 0,
        }}>
          📦
        </div>
      );
    }

    return (
      <img
        src={src}
        alt={name}
        onError={handleError}
        style={{
          width: size, height: size, borderRadius: '8px',
          objectFit: 'cover', flexShrink: 0,
          border: '1px solid #E5E7EB',
        }}
      />
    );
  };
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f5f5f5', fontFamily: 'Helvetica, Arial, sans-serif' }}>
      {EscrowRecoveryBanner}
      
      
      {isMobile && (
        <button onClick={() => setSidebarOpen(v => !v)} style={{ display: 'block', position: 'fixed', top: '12px', left: sidebarOpen ? '232px' : '12px', zIndex: 200, background: '#D88F2E', border: 'none', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', fontSize: '20px', color: 'white', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', transition: 'left 0.3s ease' }}>☰</button>
      )}
      <div style={{ position: 'fixed', left: isMobile && !sidebarOpen ? '-220px' : '0', top: 0, width: isMobile ? '220px' : '190px', height: '100vh', background: 'linear-gradient(90deg, #D88F2E 0%, #FBC85F 55%, #FFEBB8 100%)', padding: '20px', borderTopRightRadius: '28px', borderBottomRightRadius: '28px', overflow: 'visible', zIndex: 10, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', transition: 'left 0.3s ease', boxSizing: 'border-box' }} onClick={() => { if (isMobile) setSidebarOpen(false); }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
          <span style={{ color: '#FFFFFF', fontWeight: 'bold', marginRight: '10px' }}>{mode === 'customer' ? 'Customer' : 'Vendor'}</span>
          <div style={{ position: 'relative', width: '60px', height: '30px', background: 'linear-gradient(to right, #D88F2E, #FBC85F)', borderRadius: '999px', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)', border: '1px solid rgba(255,255,255,0.55)' }}>
            <span onClick={() => setMode(mode === 'customer' ? 'vendor' : 'customer')} style={{ position: 'absolute', left: mode === 'customer' ? '0' : '30px', width: '30px', height: '30px', background: '#FFF6DC', borderRadius: '50%', transition: 'left 0.3s ease', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', cursor: 'pointer' }} />
          </div>
        </div>
        {/* Notification strip */}
        <div style={{ marginBottom: '24px', position: 'relative' }}>
          <button onClick={() => { setShowNotifications(v => !v); setNotifications(prev => prev.map(n => ({ ...n, read: true }))); }}
            style={{ width: '100%', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '10px', padding: '6px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: 'white', fontSize: '13px', fontWeight: '500' }}>🔔 Notifications</span>
            {unreadCount > 0 && (
              <span style={{ background: '#e74c3c', color: 'white', borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 'bold' }}>{unreadCount > 9 ? '9+' : unreadCount}</span>
            )}
          </button>
          {showNotifications && (
            <div style={{ position: 'fixed', left: '200px', top: '60px', width: '300px', background: 'white', borderRadius: '15px', boxShadow: '0 8px 30px rgba(0,0,0,0.15)', border: '1px solid #FFE0B2', zIndex: 9999, maxHeight: '400px', overflowY: 'auto' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #FFE0B2', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 'bold', color: '#D88F2E' }}>Notifications</span>
                <button onClick={() => setNotifications([])} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '12px' }}>Clear all</button>
              </div>
              {notifications.length === 0 ? (
                <p style={{ padding: '20px', textAlign: 'center', color: '#999', margin: 0 }}>No notifications</p>
              ) : (
                notifications.map(n => (
                  <div key={n.id} style={{ padding: '12px 16px', borderBottom: '1px solid #FFF3E0', background: n.read ? 'white' : '#FFFDF8' }}>
                    <p style={{ margin: 0, fontSize: '14px', color: n.type === 'warning' ? '#e67e22' : n.type === 'success' ? '#27ae60' : '#333' }}>{n.message}</p>
                    <p style={{ margin: '4px 0 0', fontSize: '11px', color: '#999' }}>{new Date(n.timestamp).toLocaleTimeString()}</p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '26px', marginBottom: '40px' }}>
          {tabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key as any)} style={{ height: '62px', padding: '0 28px', background: activeTab === tab.key ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', marginRight: '-20px', zIndex: 2, opacity: 1, filter: activeTab === tab.key ? 'none' : 'brightness(1.1) saturate(0.8)', boxShadow: activeTab === tab.key ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', transform: activeTab === tab.key ? 'translateX(1px)' : 'none' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 'auto', textAlign: 'center', paddingBottom: '20px' }}>
          <img src="/logo.png" alt="Your Logo" style={{ width: '100px', height: 'auto' }} />
        </div>
      </div>
      <div style={{ marginLeft: isMobile ? '0' : '190px', flex: 1, padding: isMobile ? '16px' : '40px', paddingTop: isMobile ? '56px' : '40px', background: '#FFF2D6', minHeight: '100vh', overflowY: 'auto' }}>
        <h1 style={{ color: '#F2B04A', textAlign: 'center', fontSize: '36px', marginBottom: '30px' }}>SC.PO Generator</h1>
        {activeTab === 'create' && mode === 'customer' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '40px' }}>Create / Update SC.PO (MPT)</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '40px' }}>
              <button onClick={() => { setCreateSubTab('creation'); setSelectedUpdatePO(null); }} style={{ height: '50px', padding: '0 30px', background: createSubTab === 'creation' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: createSubTab === 'creation' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Creation
              </button>
              <button onClick={() => setCreateSubTab('update')} style={{ height: '50px', padding: '0 30px', background: createSubTab === 'update' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: createSubTab === 'update' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Update
              </button>
            </div>
            {createSubTab === 'creation' && (
              <div>
                <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>PO Name (for tracking)</label>
                <input style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 50px auto', display: 'block' }} placeholder="e.g. Widget Order Dec 2025" value={poName} onChange={(e) => setPoName(e.target.value)} />
                <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Description</label>
                <textarea style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 60px auto', display: 'block', height: '120px', resize: 'vertical' }} placeholder="Enter description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '50px', maxWidth: '900px', margin: '0 auto 60px auto' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold' }}>Customer Link</label>
                    <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', background: '#f0f0f0' }} value="Linked" readOnly />
                    <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Department</label>
                    <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={department} onChange={(e) => setDepartment(e.target.value)} />
                    <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Vendor Link</label>
                    <select style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} onChange={(e) => { const selectedOption = e.target.options[e.target.selectedIndex]; setVendor(selectedOption.value); setSelectedVendorUUID(selectedOption.dataset.uuid || ''); }}>
                      <option value="">Select Linked Vendor</option>
                      {linkedVendors.map(v => <option key={v.profileUUID} value={v.classicAddress} data-uuid={v.profileUUID}>{v.uniqueID} - {v.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold' }}>RFP Link</label>
                    <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', background: '#f0f0f0' }} value="Linked" readOnly />
                    <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Payment Terms</label>
                    <select style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)}>
                      <option value="">Select Terms</option>
                      <option value="0 Days">0 Days (Immediate)</option>
                      <option value="15 Days">15 Days</option>
                      <option value="30 Days">30 Days</option>
                      <option value="60 Days">60 Days</option>
                    </select>
                    {isRLUSDConfigured() && (
                      <>
                        <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Escrow Currency</label>
                        <select style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={escrowCurrency} onChange={(e) => setEscrowCurrency(e.target.value as 'XRP' | 'RLUSD')}>
                          <option value="RLUSD">💵 RLUSD (1:1 USD — recommended)</option>
                          <option value="XRP">⚡ XRP (market rate conversion)</option>
                        </select>
                      </>
                    )}
                    <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Delivery Terms</label>
                    <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} />

                    {/* Phase 6A — Yield Opt-In */}
                    {escrowCurrency === 'RLUSD' && (
                      <div style={{ marginTop: '30px', background: '#F0FFF4', border: '1.5px solid #68D391', borderRadius: '14px', padding: '16px' }}>
                        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={yieldOptIn}
                            onChange={async (e) => {
                              const checked = e.target.checked;
                              setYieldOptIn(checked);
                              if (checked) {
                                setYieldOptInLoading(true);
                                try {
                                  const adapter = yieldPartnerRegistry.get(selectedPartnerId);
                                  if (adapter) {
                                    const { apr } = await adapter.getCurrentAPR();
                                    setYieldOptInAPR(apr);
                                    const daysParsed = parseInt(paymentTerms?.split(' ')[0]);
                                    const days = isNaN(daysParsed) ? 30 : daysParsed;
                                    const est = adapter.calculateAccrued(totalEscrowAmount || '0', apr, days);
                                    const { netToBuyer } = computeYieldDistribution(est, adapter);
                                    setYieldEstimatedReturn(netToBuyer);
                                  }
                                } catch { /* ignore */ }
                                finally { setYieldOptInLoading(false); }
                              } else {
                                setYieldOptInAPR(null);
                                setYieldEstimatedReturn(null);
                              }
                            }}
                            style={{ marginTop: '3px', accentColor: '#38A169', width: '16px', height: '16px', flexShrink: 0 }}
                          />
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#276749' }}>
                              🌱 Earn yield while this escrow is held
                            </div>
                            <div style={{ fontSize: '12px', color: '#48BB78', marginTop: '3px' }}>
                              Your RLUSD earns interest from the moment the escrow is funded until the vendor claims payment.
                            </div>
                            {yieldOptIn && !yieldOptInLoading && yieldOptInAPR !== null && (
                              <div style={{ fontSize: '12px', color: '#276749', marginTop: '6px', fontWeight: 'bold' }}>
                                Current rate: {formatAPR(yieldOptInAPR)} APY
                                {yieldEstimatedReturn && parseFloat(yieldEstimatedReturn) > 0 && totalEscrowAmount !== '0' && (
                                  <span style={{ marginLeft: '10px', color: '#2F855A', fontWeight: 'normal' }}>
                                    Est. net return: <strong>{fmtRLUSD(yieldEstimatedReturn)}</strong> over {paymentTerms || '—'}
                                  </span>
                                )}
                                {totalEscrowAmount === '0' && (
                                  <span style={{ marginLeft: '10px', color: '#999', fontWeight: 'normal' }}>Add items to see estimated return</span>
                                )}
                              </div>
                            )}
                            {yieldOptIn && yieldOptInLoading && (
                              <div style={{ fontSize: '12px', color: '#68D391', marginTop: '4px' }}>Fetching current rate...</div>
                            )}
                            {/* Risk disclosure */}
                            <div style={{ marginTop: '10px', background: '#FFFBEB', border: '1px solid #F6E05E', borderRadius: '8px', padding: '8px 12px', fontSize: '11px', color: '#92400E' }}>
                              ⚠️ <strong>Yield involves risk.</strong> Returns are not guaranteed, not FDIC insured, and depend on partner performance. Your principal (the escrow amount) is always returned to complete the PO — only the yield portion carries risk. SC.PO earns a fee on yield generated.
                            </div>
                          </div>
                        </label>
                      </div>
                    )}
                  </div>
                </div>
                <h3 style={{ color: '#F2B04A', margin: '40px 0 20px', textAlign: 'center' }}>Request</h3>
                <div style={{ maxWidth: '900px', margin: '0 auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 15px' }}>
                   <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '30px 0 0 30px' }}>Item #</th>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0' }}>Item Link</th>
                        <th style={{ padding: '15px', background: '#FFF3E0' }}>Piece Price</th>
                        <th style={{ padding: '15px', background: '#FFF3E0' }}>Qty</th>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '0 30px 30px 0' }}>Total $</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => {
                        const linkedV2Item = vendor ? (linkedVendorInventoryV2[vendor] || []).find(i => i.nftId === item.invNFTId || i.partNumber === item.num || i.name === item.num) : null;
                        return (
                        <tr key={index}>
                          <td style={{ padding: '10px 15px', background: 'white', borderRadius: '30px 0 0 30px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <ProductImage uri={linkedV2Item?.productImageUri} name={item.num} size={36} />
                              <div>
                                <div>{item.num}</div>
                                {linkedV2Item?.status === 'out_of_stock' && (
                                  <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#92400E', background: '#FFFBEB', border: '1px solid #F59E0B', borderRadius: '8px', padding: '1px 6px', display: 'inline-block', marginTop: '2px' }}>
                                    ⚠ Out of Stock
                                  </span>
                                )}
                                {linkedV2Item?.status === 'discontinued' && (
                                  <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#C62828', background: '#FFF5F5', border: '1px solid #FC8181', borderRadius: '8px', padding: '1px 6px', display: 'inline-block', marginTop: '2px' }}>
                                    ⛔ Discontinued
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: '15px', background: 'white' }}>
                            {linkedV2Item ? (
                              <button onClick={() => {
                                const fakePO = { vendorAddress: vendor, buyerAddress: customerProfile.classicAddress } as any;
                                const fakePOData = { items: [item] } as any;
                                openPOInventoryModal(fakePO, fakePOData);
                              }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px' }} title="View inventory details">🔗</button>
                            ) : <span style={{ color: '#ccc' }}>🔗</span>}
                          </td>
                          <td style={{ padding: '15px', background: 'white' }}>{item.piecePrice ? `$${item.piecePrice}` : '—'}</td>
                          <td style={{ padding: '15px', background: 'white' }}>{item.qty}</td>
                          <td style={{ padding: '15px', background: 'white' }}>${item.total}</td>
                          <td style={{ padding: '15px', background: 'white', borderRadius: '0 30px 30px 0' }}>
                            <button onClick={() => removeItem(index)} style={{ background: '#e74c3c', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer', transition: 'all 0.2s ease', border: 'none' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Remove
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <h4 style={{ color: '#F2B04A', margin: '40px 0 10px', textAlign: 'center' }}>Add New Item</h4>
                <div className="scpo-add-item-row">
                  {(() => {
                    const v2items = linkedVendorInventoryV2[vendor] || [];
                    if (!vendor) {
                      return <input placeholder="Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />;
                    }
                    if (v2items.length === 0) {
                      return <input placeholder="Loading inventory... or enter Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />;
                    }
                    return (
                      <select value={selectedInventoryItem} onChange={(e) => {
                        const val = e.target.value;
                        setSelectedInventoryItem(val);
                        if (val === 'custom') { setNewItemNum(''); setNewPiecePrice(''); setNewTotal(''); return; }
                        const v2item = v2items.find(i => i.partNumber === val || i.name === val);
                        if (v2item) { setNewItemNum(v2item.partNumber || v2item.name); setNewPiecePrice(''); setNewTotal(''); return; }
                        setNewItemNum(val); setNewPiecePrice(''); setNewTotal('');
                      }} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }}>
                        <option value="custom">Custom Item #</option>
                        {v2items.map(item => (
                          <option key={item.nftId} value={item.partNumber || item.name}>
                            {item.partNumber} — {item.name}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                  {selectedInventoryItem === 'custom' && vendor && linkedVendorInventoryV2[vendor]?.length > 0 && (
                    <input placeholder="Custom Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                  )}
                  <input placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                  <input placeholder={selectedItemPricingLoading ? 'Loading price...' : 'Piece Price $'} value={newPiecePrice} onChange={(e) => { setNewPiecePrice(e.target.value); const qty = parseFloat(newQty); const price = parseFloat(e.target.value); if (qty > 0 && price > 0) setNewTotal((qty * price).toFixed(2)); }} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1, background: selectedItemPricingLoading ? '#f5f5f5' : 'white' }} />
                  <input placeholder="Total $" value={newTotal} onChange={(e) => setNewTotal(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                  <button onClick={addItem} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 30px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    Add
                  </button>
                </div>
                {/* Task 3.10 — status warnings */}
                {(() => {
                  if (selectedInventoryItem === 'custom' || !vendor) return null;
                  const v2items = linkedVendorInventoryV2[vendor] || [];
                  const v2item = v2items.find(i => i.partNumber === selectedInventoryItem || i.name === selectedInventoryItem);
                  if (!v2item) return null;
                  if (v2item.status === 'out_of_stock') return (
                    <div style={{ maxWidth: '900px', margin: '0 auto 10px auto', background: '#FFFBEB', border: '1px solid #F59E0B', borderRadius: '12px', padding: '10px 18px', color: '#92400E', fontSize: '14px', fontWeight: '500' }}>
                      ⚠ This item is currently out of stock. Delivery times may be longer than usual.
                    </div>
                  );
                  if (v2item.status === 'discontinued') return (
                    <div style={{ maxWidth: '900px', margin: '0 auto 10px auto', background: '#FFF5F5', border: '1px solid #FC8181', borderRadius: '12px', padding: '10px 18px', color: '#C62828', fontSize: '14px', fontWeight: '500' }}>
                      ⛔ This item has been discontinued by the vendor. Contact the vendor before submitting this PO.
                    </div>
                  );
                  return null;
                })()}
                {pricingExpiryWarning && selectedInventoryItem !== 'custom' && (
                  <div style={{ maxWidth: '900px', margin: '0 auto 10px auto', background: pricingExpiryWarning.bg, border: `1px solid ${pricingExpiryWarning.color}`, borderRadius: '12px', padding: '10px 18px', color: pricingExpiryWarning.color, fontSize: '14px', fontWeight: '500' }}>
                    {pricingExpiryWarning.message}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: '900px', margin: '0 auto 60px auto' }}>
                  <div style={{ background: '#FFF3E0', padding: '20px 40px', borderRadius: '30px', fontSize: '20px', fontWeight: 'bold', color: '#F2B04A' }}>
                    Sub Total: ${totalEscrowAmount}
                  </div>
                </div>
                <h3 style={{ color: '#F2B04A', margin: '40px 0 20px', textAlign: 'center' }}>Attachments (optional)</h3>
                <p style={{ textAlign: 'center', marginBottom: '10px', color: '#666', maxWidth: '600px', marginLeft: 'auto', marginRight: 'auto' }}>Add drawings, specs, PDFs, images, etc. (uploaded to IPFS)</p>
                <input type="file" multiple onChange={(e) => setSelectedFiles(e.target.files)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 40px auto', display: 'block' }} />
                {selectedFiles && selectedFiles.length > 0 && (
                  <div style={{ maxWidth: '600px', margin: '0 auto 40px auto' }}>
                    <strong style={{ color: '#F2B04A' }}>Selected files:</strong>
                    <ul>{Array.from(selectedFiles).map((file, i) => <li key={i}>{file.name} ({(file.size / 1024).toFixed(1)} KB)</li>)}</ul>
                  </div>
                )}
                <button onClick={createSCPO} disabled={!selectedVendorUUID} style={{ display: 'block', margin: '60px auto', width: '180px', height: '180px', borderRadius: '50%', background: 'linear-gradient(145deg, #F2B04A, #FFD98F)', color: 'white', fontSize: '28px', fontWeight: 'bold', border: '1.5px solid #D88F2E', boxShadow: scpoSuccess ? '0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5)' : '0 10px 30px rgba(212,175,55,0.4), inset 0 0 20px rgba(255,255,255,0.3)', cursor: 'pointer', transition: 'all 0.3s ease', animation: scpoSuccess ? 'scpoPulse 2s infinite' : 'none', opacity: !selectedVendorUUID ? 0.5 : 1 }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  SC.PO
                </button>
                {result && (
                  <div style={{ marginTop: '40px', maxWidth: '900px', marginLeft: 'auto', marginRight: 'auto' }}>
                    <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', border: '1px solid #ddd', borderRadius: '15px' }}>{result}</pre>
                  </div>
                )}
              </div>
            )}
            {createSubTab === 'update' && (
              <div>
                <h3 style={{ color: '#F2B04A', marginBottom: '20px' }}>Select Open or Accepted PO to Update</h3>
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '10px', textAlign: 'left' }}>PO Name</th>
                        <th style={{ padding: '10px', textAlign: 'left' }}>Date Issued</th>
                        <th style={{ padding: '10px', textAlign: 'left' }}>Total $</th>
                        <th style={{ padding: '10px', textAlign: 'left' }}>Status</th>
                        <th style={{ padding: '10px' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {getUpdatablePOs().map(po => (
                          <tr key={po.issuanceId || po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>{po.status} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>
                            <button onClick={async () => { setSelectedUpdatePO(po); await prefillFromPO(po); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '20px', cursor: 'pointer', border: 'none' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Edit
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {selectedUpdatePO && (
                  <div style={{ marginTop: '40px', background: '#f9f9f9', padding: '20px', borderRadius: '20px' }}>
                    <h3 style={{ color: '#F2B04A' }}>Update PO Form (New MPT Version)</h3>
                    {isLoadingEditPO && (
                      <div style={{ textAlign: 'center', padding: '20px', color: '#F2B04A', fontWeight: 'bold' }}>
                        Loading PO details from IPFS...
                      </div>
                    )}
                    <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>PO Name</label>
                    <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={poName} onChange={(e) => setPoName(e.target.value)} />
                    <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Description</label>
                    <textarea style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', height: '120px' }} value={desc} onChange={(e) => setDesc(e.target.value)} />
                    <div style={{ display: 'flex', gap: '20px', marginTop: '20px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Department</label>
                        <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={department} onChange={(e) => setDepartment(e.target.value)} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Payment Terms</label>
                        <select style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)}>
                          <option value="">Select Terms</option>
                          <option value="0 Days">0 Days (Immediate)</option>
                          <option value="15 Days">15 Days</option>
                          <option value="30 Days">30 Days</option>
                          <option value="60 Days">60 Days</option>
                        </select>
                      </div>
                      {isRLUSDConfigured() && (
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Escrow Currency</label>
                          <select style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={escrowCurrency} onChange={(e) => setEscrowCurrency(e.target.value as 'XRP' | 'RLUSD')}>
                            <option value="RLUSD">💵 RLUSD (1:1 USD)</option>
                            <option value="XRP">⚡ XRP (market rate)</option>
                          </select>
                        </div>
                      )}
                    </div>
                    <h4 style={{ color: '#F2B04A', margin: '40px 0 20px', textAlign: 'center' }}>Request Items</h4>
                    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 15px' }}>
                        <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '30px 0 0 30px' }}>Item #</th>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0' }}>Item Link</th>
                        <th style={{ padding: '15px', background: '#FFF3E0' }}>Piece Price</th>
                        <th style={{ padding: '15px', background: '#FFF3E0' }}>Qty</th>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '0 30px 30px 0' }}>Total $</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => {
                        const linkedV2Item = selectedUpdatePO?.vendorAddress ? (linkedVendorInventoryV2[selectedUpdatePO.vendorAddress] || []).find(i => i.nftId === item.invNFTId || i.partNumber === item.num || i.name === item.num) : null;
                        return (
                        <tr key={index}>
                          <td style={{ padding: '15px', background: 'white', borderRadius: '30px 0 0 30px' }}>{item.num}</td>
                          <td style={{ padding: '15px', background: 'white' }}>
                            {linkedV2Item ? (
                              <button onClick={() => {
                                const fakePO = { vendorAddress: selectedUpdatePO?.vendorAddress, buyerAddress: customerProfile.classicAddress } as any;
                                const fakePOData = { items: [item] } as any;
                                openPOInventoryModal(fakePO, fakePOData);
                              }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px' }} title="View inventory details">🔗</button>
                            ) : <span style={{ color: '#ccc' }}>🔗</span>}
                          </td>
                          <td style={{ padding: '15px', background: 'white' }}>{item.piecePrice ? `$${item.piecePrice}` : '—'}</td>
                          <td style={{ padding: '15px', background: 'white' }}>{item.qty}</td>
                          <td style={{ padding: '15px', background: 'white' }}>${item.total}</td>
                          <td style={{ padding: '15px', background: 'white', borderRadius: '0 30px 30px 0' }}>
                            <button onClick={() => removeItem(index)} style={{ background: '#e74c3c', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer', transition: 'all 0.2s ease', border: 'none' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Remove
                            </button>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                      </table>
                    </div>
                    <h4 style={{ color: '#F2B04A', margin: '40px 0 10px', textAlign: 'center' }}>Add New Item</h4>
                    <div className="scpo-add-item-row">
                      <input placeholder="Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                      <input placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                      <input placeholder="Piece Price $" value={newPiecePrice} onChange={(e) => { setNewPiecePrice(e.target.value); const qty = parseFloat(newQty); const price = parseFloat(e.target.value); if (qty > 0 && price > 0) setNewTotal((qty * price).toFixed(2)); }} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                      <input placeholder="Total $" value={newTotal} onChange={(e) => setNewTotal(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                      <button onClick={addItem} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 30px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        Add
                      </button>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: '900px', margin: '0 auto 60px auto' }}>
                      <div style={{ background: '#FFF3E0', padding: '20px 40px', borderRadius: '30px', fontSize: '20px', fontWeight: 'bold', color: '#F2B04A' }}>
                        Sub Total: ${totalEscrowAmount}
                      </div>
                    </div>
                    <h3 style={{ color: '#F2B04A', margin: '40px 0 20px', textAlign: 'center' }}>Attachments (optional)</h3>
                    <input type="file" multiple onChange={(e) => setSelectedFiles(e.target.files)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 40px auto', display: 'block' }} />
                    <button onClick={updateSCPO} style={{ display: 'block', margin: '40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      Update PO (New Version)
                    </button>
                    {updateResult && (
                      <div style={{ marginTop: '20px', maxWidth: '900px', marginLeft: 'auto', marginRight: 'auto' }}>
                        <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', border: '1px solid #ddd', borderRadius: '15px' }}>{updateResult}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab === 'scpoAction' && mode === 'customer' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>SC.PO Action</h2>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Open SC.PO</h3>
              {getLatestActivePOs('open').length === 0 ? <p>No open POs</p> : (
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '10px', textAlign: 'left', width: '40%' }}>PO Name</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>Date Issued</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Total $</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(openExpanded ? sortPOsNewestFirst(getLatestActivePOs('open')) : sortPOsNewestFirst(getLatestActivePOs('open').slice(0, 2))).map(po => (
                          <tr key={po.issuanceId || po.id}>
                          <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={async () => { setSelectedOpenPO(po); await viewPOFromUri(po.ipfsUri, po, setCustomerScpoActionViewedPO, setCustomerScpoActionPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                            <button onClick={() => recallPO(po)} style={{ background: '#e74c3c', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Recall
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getLatestActivePOs('open').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button onClick={() => setOpenExpanded(!openExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        {openExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Accepted SC.PO (Not Funded)</h3>
              {getLatestActivePOs('accepted').filter(p => !p.escrowSequence).length === 0 ? <p>No accepted POs to fund</p> : (
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '10px', textAlign: 'left', width: '35%' }}>PO Name</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Date Issued</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Total $</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(acceptedExpanded ? sortPOsNewestFirst(getLatestActivePOs('accepted').filter(p => !p.escrowSequence)) : sortPOsNewestFirst(getLatestActivePOs('accepted').filter(p => !p.escrowSequence).slice(0, 2))).map(po => (
                          <tr key={po.issuanceId || po.id}>
                          <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => fundEscrow(po)} style={{ background: po.escrowCurrency === 'RLUSD' ? '#2e86de' : '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Fund Escrow
                            </button>
                            <button onClick={async () => { setSelectedOpenPO(po); await viewPOFromUri(po.ipfsUri, po, setCustomerScpoActionViewedPO, setCustomerScpoActionPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                            <button onClick={() => recallPO(po)} style={{ background: '#e74c3c', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Recall
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getLatestActivePOs('accepted').filter(p => !p.escrowSequence).length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button onClick={() => setAcceptedExpanded(!acceptedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        {acceptedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {customerScpoActionViewedPO && (
              <div style={{ marginTop: '40px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                <h3 style={{ color: '#F2B04A' }}>Purchase Order Details</h3>
                <p><strong style={{ color: '#F2B04A' }}>PO Name:</strong> {customerScpoActionViewedPO.poName}</p>
                <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {customerScpoActionViewedPO.description || 'N/A'}</p>
                <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {customerScpoActionViewedPO.department}</p>
                <p><strong style={{ color: '#F2B04A' }}>Payment Terms:</strong> {customerScpoActionViewedPO.paymentTerms}</p>
                <p><strong style={{ color: '#F2B04A' }}>Escrow Currency:</strong> {customerScpoActionViewedPO.escrowCurrency === 'RLUSD' ? '💵 RLUSD (1:1 USD)' : '⚡ XRP'}</p>
                <p><strong style={{ color: '#F2B04A' }}>Delivery Terms:</strong> {customerScpoActionViewedPO.deliveryTerms}</p>
                <h4 style={{ color: '#F2B04A' }}>Items</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#e0e0e0' }}>
                      <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Item #</th>
                      <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Qty</th>
                      <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Total $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customerScpoActionViewedPO.items.map((item, i) => (
                      <tr key={i}>
                        <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.num}</td>
                        <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.qty}</td>
                        <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>${item.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {customerScpoActionViewedPO.attachments && customerScpoActionViewedPO.attachments.length > 0 && (
                  <>
                    <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Attachments</h4>
                    <ul>
                      {customerScpoActionViewedPO.attachments.map((att, i) => (
                        <li key={i}>
                          <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                            {att.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
                  <button onClick={() => openProfilesModal(selectedOpenPO)} style={{ background: 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    Profiles
                  </button>
                  {getPOHistory(selectedOpenPO || customerScpoActionViewedPO as any).length > 0 && (
                    <button onClick={() => openHistoryModal(selectedOpenPO, customerScpoActionViewedPO)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      View History
                    </button>
                  )}
                  <button onClick={() => openPOInventoryModal(selectedOpenPO, customerScpoActionViewedPO)}
                    style={{ background: 'linear-gradient(90deg, #27ae60 0%, #2ecc71 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    Inventory
                  </button>
                </div>
                <button onClick={() => setCustomerScpoActionViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
        {activeTab === 'scpoAction' && mode === 'vendor' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>SC.PO Action</h2>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Open SC.PO</h3>
              {getLatestActivePOs('open').length === 0 ? <p>No open POs</p> : (
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '10px', textAlign: 'left', width: '40%' }}>PO Name</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>Date Issued</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Total $</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(openExpanded ? sortPOsNewestFirst(getLatestActivePOs('open')) : sortPOsNewestFirst(getLatestActivePOs('open').slice(0, 2))).map(po => (
                          <tr key={po.issuanceId || po.id}>
                          <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => acceptMPTOfferForPO(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Accept
                            </button>
                            <button onClick={async () => { setSelectedOpenPO(po); await viewPOFromUri(po.ipfsUri, po, setVendorScpoActionViewedPO, setVendorScpoActionPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getLatestActivePOs('open').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button onClick={() => setOpenExpanded(!openExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        {openExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Funded SC.PO</h3>
              {getLatestActivePOs('funded').length === 0 ? <p>No funded POs</p> : (
                <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>PO Name</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Date Issued</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Total $</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Time Remaining</th>
                        <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(fundedExpanded ? sortPOsNewestFirst(getLatestActivePOs('funded')) : sortPOsNewestFirst(getLatestActivePOs('funded').slice(0, 2))).map(po => (
                          <tr key={po.issuanceId || po.id}>
                          <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span><YieldBadge poIssuanceId={po.issuanceId} positions={yieldPositions} /></td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>{getTimeRemaining(po)}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
                            <button onClick={() => claimEscrowForPO(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Claim Escrow
                            </button>
                            <button onClick={async () => { setSelectedFundedPO(po); await viewPOFromUri(po.ipfsUri, po, setVendorScpoActionViewedPO, setVendorScpoActionPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                            {po.escrowCurrency === 'RLUSD' && (
                              <button
                                onClick={async () => {
                                  setFinancingModalPO(po);
                                  setFinancingAdvanceRate(0.80);
                                  setFinancingLenderAddress('');
                                  setFinancingEscrowDetails(null);
                                  setShowFinancingModal(true);
                                  // Fetch escrow details for the modal
                                  setFinancingEscrowLoading(true);
                                  try {
                                    const details = await fetchEscrowDetails(po.buyerAddress, po.escrowSequence!);
                                    setFinancingEscrowDetails(details);
                                  } catch (e) {
                                    console.warn('[FinancingModal] Could not fetch escrow details:', e);
                                  } finally {
                                    setFinancingEscrowLoading(false);
                                  }
                                }}
                                style={{ background: '#553C9A', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }}
                                onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                              >
                                💰 Get Advance
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getLatestActivePOs('funded').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button onClick={() => setFundedExpanded(!fundedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        {fundedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Phase 6B — Financing Request Modal */}
            {showFinancingModal && financingModalPO && (
              <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowFinancingModal(false)}>
                <div style={{ background: '#FFF9E6', borderRadius: '20px', padding: '30px', width: '90%', maxWidth: '600px', maxHeight: '90vh', overflowY: 'auto', position: 'relative', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
                  <button onClick={() => setShowFinancingModal(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '35px', height: '35px', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>

                  <h2 style={{ color: '#553C9A', textAlign: 'center', marginBottom: '4px' }}>💰 Request Advance</h2>
                  <p style={{ textAlign: 'center', color: '#666', fontSize: '13px', marginBottom: '20px' }}>
                    Get paid early against your funded PO. Repayment is automatic at claim time.
                  </p>

                  {/* PO Summary */}
                  <div style={{ background: '#F3F0FF', border: '1px solid #B794F4', borderRadius: '12px', padding: '14px 16px', marginBottom: '16px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#553C9A', marginBottom: '8px' }}>📋 {financingModalPO.poName}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', fontSize: '12px', color: '#666' }}>
                      <span>Escrow Amount:</span><span style={{ fontWeight: 'bold', color: '#333' }}>${financingModalPO.total} RLUSD</span>
                      <span>Payment Terms:</span><span style={{ fontWeight: 'bold', color: '#333' }}>{financingModalPO.paymentTerms}</span>
                      {financingEscrowLoading ? (
                        <><span>Days Until Expiry:</span><span style={{ color: '#999' }}>Loading...</span></>
                      ) : financingEscrowDetails ? (
                        <><span>Days Until Expiry:</span>
                        <span style={{ fontWeight: 'bold', color: financingEscrowDetails.daysUntilCancel <= MIN_DAYS_UNTIL_CANCEL ? '#e74c3c' : financingEscrowDetails.daysUntilCancel <= 7 ? '#E65100' : '#27ae60' }}>
                          {financingEscrowDetails.daysUntilCancel.toFixed(1)} days
                        </span></>
                      ) : null}
                    </div>
                  </div>

                  {/* Advance Rate Slider */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 'bold', color: '#553C9A', marginBottom: '8px' }}>
                      Advance Rate: {(financingAdvanceRate * 100).toFixed(0)}%
                      <span style={{ fontWeight: 'normal', color: '#666', marginLeft: '8px' }}>
                        = ${(parseFloat(financingModalPO.total) * financingAdvanceRate).toFixed(2)} RLUSD
                      </span>
                    </label>
                    <input
                      type="range"
                      min={0.50} max={MAX_ADVANCE_RATE} step={0.05}
                      value={financingAdvanceRate}
                      onChange={e => setFinancingAdvanceRate(parseFloat(e.target.value))}
                      style={{ width: '100%', accentColor: '#553C9A' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#999' }}>
                      <span>50%</span><span>Max {(MAX_ADVANCE_RATE * 100).toFixed(0)}%</span>
                    </div>
                  </div>

                  {/* Lender Address */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 'bold', color: '#553C9A', marginBottom: '8px' }}>
                      Lender Wallet Address
                    </label>
                    <input
                      type="text"
                      placeholder="Lender wallet address (r...)"
                      value={financingLenderAddress}
                      onChange={e => setFinancingLenderAddress(e.target.value)}
                      style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1.5px solid #B794F4', fontSize: '13px', boxSizing: 'border-box' }}
                    />
                    <p style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>
                      Must be a registered lender with an Institutional credential in the SC.PO domain.
                    </p>
                  </div>

                  {/* Lender APR (for display/estimate only) */}
                  <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'block', fontSize: '13px', fontWeight: 'bold', color: '#553C9A', marginBottom: '8px' }}>
                      Lender's Published APR (for estimate only)
                    </label>
                    <input
                      type="number"
                      min={0} max={100} step={0.1}
                      value={(financingLenderAPR * 100).toFixed(1)}
                      onChange={e => setFinancingLenderAPR(parseFloat(e.target.value) / 100)}
                      style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', border: '1.5px solid #B794F4', fontSize: '13px', boxSizing: 'border-box' }}
                    />
                  </div>

                  {/* Terms Preview */}
                  {financingEscrowDetails && financingLenderAddress && (() => {
                    const terms = formatFinancingTerms(
                      financingModalPO.total,
                      financingAdvanceRate,
                      financingLenderAPR,
                      financingEscrowDetails.daysUntilCancel
                    );
                    return (
                      <div style={{ background: terms.isEligible ? '#F3F0FF' : '#FFF5F5', border: `1px solid ${terms.isEligible ? '#B794F4' : '#FC8181'}`, borderRadius: '12px', padding: '14px 16px', marginBottom: '16px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 'bold', color: terms.isEligible ? '#553C9A' : '#C53030', marginBottom: '10px' }}>
                          {terms.isEligible ? '📊 Estimated Terms' : `⚠️ ${terms.ineligibleReason}`}
                        </div>
                        {terms.isEligible && (
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
                            {[
                              ['Advance Amount', terms.advanceAmount],
                              ['SC.PO Fee (1%)', `-${terms.scpoFee}`],
                              ['Net to You Now', terms.netToVendor],
                              ['Est. Interest', `-${terms.estimatedInterest}`],
                              ['Total Repayment', terms.totalRepayment],
                              ['Remainder at Claim', terms.remainderAtClaim],
                            ].map(([label, value]) => (
                              <React.Fragment key={label}>
                                <span style={{ color: '#666' }}>{label}:</span>
                                <span style={{ fontWeight: 'bold', color: label === 'Net to You Now' || label === 'Remainder at Claim' ? '#276749' : '#333' }}>{value}</span>
                              </React.Fragment>
                            ))}
                          </div>
                        )}
                        <p style={{ fontSize: '11px', color: '#999', margin: '10px 0 0' }}>
                          ⚠️ Estimates only. Actual terms set by lender. Interest accrues until escrow is claimed. Repayment is automatic at claim time.
                        </p>
                      </div>
                    );
                  })()}

                  {/* Risk Disclosure */}
                  <div style={{ background: '#FFFBEB', border: '1px solid #F6E05E', borderRadius: '8px', padding: '10px 14px', marginBottom: '20px', fontSize: '11px', color: '#92400E' }}>
                    ⚠️ <strong>Important:</strong> By requesting financing, you agree that the escrow proceeds at claim time will first repay the lender (advance + interest) and SC.PO fee before you receive the remainder. This is a binding on-chain commitment. Consult a financial or legal advisor before proceeding.
                  </div>

                  {/* Submit Button */}
                  <button
                    onClick={requestFinancing}
                    disabled={financingSubmitting || !financingLenderAddress || (financingEscrowDetails?.daysUntilCancel || 999) <= MIN_DAYS_UNTIL_CANCEL}
                    style={{ width: '100%', padding: '14px', background: financingSubmitting ? '#ccc' : 'linear-gradient(90deg, #553C9A, #6B46C1)', color: 'white', border: 'none', borderRadius: '12px', fontSize: '15px', fontWeight: 'bold', cursor: financingSubmitting ? 'not-allowed' : 'pointer' }}
                  >
                    {financingSubmitting ? 'Submitting Request...' : `Request $${(parseFloat(financingModalPO.total) * financingAdvanceRate).toFixed(2)} Advance`}
                  </button>
                </div>
              </div>
            )}
            {vendorScpoActionViewedPO && (
              <div style={{ marginTop: '40px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                <h3 style={{ color: '#F2B04A' }}>Purchase Order Details</h3>
                <p><strong style={{ color: '#F2B04A' }}>PO Name:</strong> {vendorScpoActionViewedPO.poName}</p>
                <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {vendorScpoActionViewedPO.description || 'N/A'}</p>
                <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {vendorScpoActionViewedPO.department}</p>
                <p><strong style={{ color: '#F2B04A' }}>Payment Terms:</strong> {vendorScpoActionViewedPO.paymentTerms}</p>
                <p><strong style={{ color: '#F2B04A' }}>Escrow Currency:</strong> {vendorScpoActionViewedPO.escrowCurrency === 'RLUSD' ? '💵 RLUSD (1:1 USD)' : '⚡ XRP'}</p>
                <p><strong style={{ color: '#F2B04A' }}>Delivery Terms:</strong> {vendorScpoActionViewedPO.deliveryTerms}</p>
                <h4 style={{ color: '#F2B04A' }}>Items</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#e0e0e0' }}>
                      <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Item #</th>
                      <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Qty</th>
                      <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Total $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendorScpoActionViewedPO.items.map((item, i) => (
                      <tr key={i}>
                        <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.num}</td>
                        <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.qty}</td>
                        <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>${item.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {vendorScpoActionViewedPO.attachments && vendorScpoActionViewedPO.attachments.length > 0 && (
                  <>
                    <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Attachments</h4>
                    <ul>
                      {vendorScpoActionViewedPO.attachments.map((att, i) => (
                        <li key={i}>
                          <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                            {att.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
                          <button onClick={() => openProfilesModal(selectedOpenPO || selectedFundedPO)} style={{ background: 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                            Profiles
                          </button>
                          {getPOHistory(selectedOpenPO || selectedFundedPO || vendorScpoActionViewedPO as any).length > 0 && (
                            <button onClick={() => openHistoryModal(selectedOpenPO || selectedFundedPO, vendorScpoActionViewedPO)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View History
                            </button>
                          )}
                          <button onClick={() => openPOInventoryModal(selectedOpenPO || selectedFundedPO, vendorScpoActionViewedPO)}
                            style={{ background: 'linear-gradient(90deg, #27ae60 0%, #2ecc71 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                            Inventory
                          </button>
                        </div>
                        <button onClick={() => setVendorScpoActionViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
        {activeTab === 'inventoryCatalog' && mode === 'vendor' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>Inventory Catalog</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '40px' }}>
              <button onClick={() => setInventorySubTab('list')} style={{ height: '50px', padding: '0 30px', background: inventorySubTab === 'list' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: inventorySubTab === 'list' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                List
              </button>
              <button onClick={() => setInventorySubTab('add')} style={{ height: '50px', padding: '0 30px', background: inventorySubTab === 'add' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: inventorySubTab === 'add' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Add
              </button>
              <button onClick={() => setInventorySubTab('import')} style={{ height: '50px', padding: '0 30px', background: inventorySubTab === 'import' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: inventorySubTab === 'import' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Import
              </button>
            </div>
            {inventorySubTab === 'list' && (
              <div>
                
                {/* ── Task 3.7 — Warehouse Wallet Banner ───────────────────── */}
                {!warehouseWalletAddress && (
                  <div style={{ background: '#FFF3CD', border: '1px solid #FFD54F', borderRadius: '12px', padding: '12px 18px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: '#856404', fontSize: '14px', fontWeight: 'bold' }}>
                      ⚠ No warehouse wallet configured
                      <span style={{ display: 'block', fontWeight: 'normal', fontSize: '12px', color: '#555', marginTop: '2px' }}>
                        A warehouse wallet is required to track on-hand inventory on-chain. Set one up to use Receive Inventory.
                      </span>
                    </span>
                    <button onClick={() => setShowWarehouseSetup(true)}
                      style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', flexShrink: 0 }}>
                      Set Up Warehouse Wallet
                    </button>
                  </div>
                )}
                {warehouseWalletAddress && (
                  <div style={{ background: '#E6F4EA', border: '1px solid #A5D6A7', borderRadius: '12px', padding: '10px 18px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: '#2E7D32', fontSize: '13px' }}>
                      🏭 Warehouse wallet: <span style={{ fontFamily: 'monospace' }}>{warehouseWalletAddress}</span>
                    </span>
                    <button onClick={() => { setWarehouseSetupInput(warehouseWalletAddress); setShowWarehouseSetup(true); }}
                      style={{ background: 'transparent', color: '#2E7D32', padding: '4px 12px', borderRadius: '20px', border: '1px solid #A5D6A7', cursor: 'pointer', fontSize: '12px' }}>
                      Change
                    </button>
                  </div>
                )}
                {/* ─────────────────────────────────────────────────────────── */}
                {/* ── Task 3.5 — DID Catalog Endpoint Status Banner ─────────── */}
                <div style={{
                  background: catalogDIDStatus === 'registered' ? '#E6F4EA' : catalogDIDStatus === 'not_registered' ? '#FFF3CD' : catalogDIDStatus === 'no_did' ? '#FDE8E8' : '#F5F5F5',
                  border: `1px solid ${catalogDIDStatus === 'registered' ? '#A5D6A7' : catalogDIDStatus === 'not_registered' ? '#FFD54F' : catalogDIDStatus === 'no_did' ? '#EF9A9A' : '#E0E0E0'}`,
                  borderRadius: '12px', padding: '12px 18px', marginBottom: '20px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px'
                }}>
                  <div>
                    {catalogDIDStatus === 'checking' && <span style={{ color: '#888', fontSize: '14px' }}>🔍 Checking DID catalog endpoint...</span>}
                    {catalogDIDStatus === 'registered' && (
                      <span style={{ color: '#2E7D32', fontSize: '14px', fontWeight: 'bold' }}>
                        📡 Catalog Endpoint Registered ✓
                        <span style={{ display: 'block', fontWeight: 'normal', color: '#555', fontSize: '12px', marginTop: '2px' }}>
                          Buyers can discover your inventory via DID resolution · {catalogDIDUri}
                        </span>
                      </span>
                    )}
                    {catalogDIDStatus === 'not_registered' && (
                      <span style={{ color: '#856404', fontSize: '14px', fontWeight: 'bold' }}>
                        ⚠ Catalog endpoint not in DID
                        <span style={{ display: 'block', fontWeight: 'normal', color: '#555', fontSize: '12px', marginTop: '2px' }}>
                          Register your catalog so buyers can discover your inventory through DID resolution.
                        </span>
                      </span>
                    )}
                    {catalogDIDStatus === 'no_did' && (
                      <span style={{ color: '#C62828', fontSize: '14px', fontWeight: 'bold' }}>
                        ❌ No DID found
                        <span style={{ display: 'block', fontWeight: 'normal', color: '#555', fontSize: '12px', marginTop: '2px' }}>
                          Save your vendor profile first to create a DID, then register the catalog endpoint.
                        </span>
                      </span>
                    )}
                    {catalogDIDStatus === null && <span style={{ color: '#888', fontSize: '14px' }}>DID catalog status not checked yet.</span>}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                    {catalogDIDStatus === 'not_registered' && (
                      <button onClick={registerCatalogDIDEndpoint}
                        style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold' }}
                        onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        Register Catalog Endpoint
                      </button>
                    )}
                    {catalogDIDStatus === 'registered' && (
                      <button onClick={registerCatalogDIDEndpoint}
                        style={{ background: 'transparent', color: '#2E7D32', padding: '6px 12px', borderRadius: '20px', border: '1px solid #A5D6A7', cursor: 'pointer', fontSize: '12px' }}
                        onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        title="Re-register if you recently updated your profile">
                        Refresh
                      </button>
                    )}
                    <button onClick={checkCatalogDIDEndpoint}
                      style={{ background: 'transparent', color: '#888', padding: '6px 12px', borderRadius: '20px', border: '1px solid #ccc', cursor: 'pointer', fontSize: '12px' }}>
                      Re-check
                    </button>
                  </div>
                </div>
                {/* ─────────────────────────────────────────────────────────── */}

                {/* ── Task 3.6 — Search & Filter Bar ───────────────────────── */}
                {vendorInventoryV2.length > 0 && !vendorInventoryV2Loading && (() => {
                  // Derive unique departments and categories for filter dropdowns
                  const uniqueDepts = Array.from(new Set(vendorInventoryV2.map(i => i.department).filter(Boolean))).sort();
                  const uniqueCats = Array.from(new Set(vendorInventoryV2.map(i => i.category).filter(Boolean))).sort();
                  const hasActiveFilters = invSearchText || invFilterDept || invFilterStatus || invFilterCategory || invFilterMinPrice || invFilterMaxPrice;
                  return (
                    <div style={{ background: '#FFF3E0', borderRadius: '14px', padding: '16px 20px', marginBottom: '20px', border: '1px solid #FFD98F' }}>
                      {/* Row 1: text search */}
                      <input
                        value={invSearchText}
                        onChange={e => setInvSearchText(e.target.value)}
                        placeholder="🔍  Search by name, part number, or description..."
                        style={{ width: '100%', padding: '10px 16px', borderRadius: '30px', border: '2px solid #D88F2E', fontSize: '14px', marginBottom: '12px', boxSizing: 'border-box' }}
                      />
                      {/* Row 2: dropdown filters */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '10px', alignItems: 'center' }}>
                        <select value={invFilterDept} onChange={e => setInvFilterDept(e.target.value)}
                          style={{ padding: '8px 12px', borderRadius: '20px', border: '1.5px solid #D88F2E', fontSize: '13px', background: 'white' }}>
                          <option value="">All Departments</option>
                          {uniqueDepts.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select value={invFilterCategory} onChange={e => setInvFilterCategory(e.target.value)}
                          style={{ padding: '8px 12px', borderRadius: '20px', border: '1.5px solid #D88F2E', fontSize: '13px', background: 'white' }}>
                          <option value="">All Categories</option>
                          {uniqueCats.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select value={invFilterStatus} onChange={e => setInvFilterStatus(e.target.value)}
                          style={{ padding: '8px 12px', borderRadius: '20px', border: '1.5px solid #D88F2E', fontSize: '13px', background: 'white' }}>
                          <option value="">All Statuses</option>
                          <option value="active">Active</option>
                          <option value="discontinued">Discontinued</option>
                          <option value="out_of_stock">Out of Stock</option>
                        </select>
                        <input value={invFilterMinPrice} onChange={e => setInvFilterMinPrice(e.target.value)}
                          placeholder="Min price $" type="number" min="0"
                          style={{ padding: '8px 12px', borderRadius: '20px', border: '1.5px solid #D88F2E', fontSize: '13px' }} />
                        <input value={invFilterMaxPrice} onChange={e => setInvFilterMaxPrice(e.target.value)}
                          placeholder="Max price $" type="number" min="0"
                          style={{ padding: '8px 12px', borderRadius: '20px', border: '1.5px solid #D88F2E', fontSize: '13px' }} />
                      </div>
                      {/* Row 3: active filter chips + clear */}
                      {hasActiveFilters && (
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' }}>
                          <span style={{ fontSize: '12px', color: '#888' }}>Active filters:</span>
                          {invSearchText && <span style={{ background: '#FFD98F', color: '#7B4F00', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>"{invSearchText}"</span>}
                          {invFilterDept && <span style={{ background: '#FFD98F', color: '#7B4F00', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>Dept: {invFilterDept}</span>}
                          {invFilterCategory && <span style={{ background: '#FFD98F', color: '#7B4F00', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>Cat: {invFilterCategory}</span>}
                          {invFilterStatus && <span style={{ background: '#FFD98F', color: '#7B4F00', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>Status: {invFilterStatus}</span>}
                          {invFilterMinPrice && <span style={{ background: '#FFD98F', color: '#7B4F00', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>Min: ${invFilterMinPrice}</span>}
                          {invFilterMaxPrice && <span style={{ background: '#FFD98F', color: '#7B4F00', padding: '2px 10px', borderRadius: '12px', fontSize: '12px' }}>Max: ${invFilterMaxPrice}</span>}
                          <button onClick={() => { setInvSearchText(''); setInvFilterDept(''); setInvFilterStatus(''); setInvFilterCategory(''); setInvFilterMinPrice(''); setInvFilterMaxPrice(''); }}
                            style={{ background: 'none', border: '1px solid #D88F2E', color: '#D88F2E', padding: '2px 10px', borderRadius: '12px', fontSize: '12px', cursor: 'pointer', marginLeft: 'auto' }}>
                            ✕ Clear all
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {/* ─────────────────────────────────────────────────────────── */}

                {/* ── Task 3.7 — Catalog Valuation Summary ─────────────────── */}
                {(vendorInventoryV2.length > 0) && (() => {
                  const activeItems = vendorInventoryV2.filter((item, idx, arr) =>
                    arr.findIndex(x => x.partNumber === item.partNumber) === idx
                  );
                  const pricedItems = activeItems.filter(i => i.listPrice > 0 || i.unitCost > 0);
                  const totalRetailValue = activeItems.reduce((sum, item) =>
                    sum + (item.listPrice * item.quantityOnHand), 0);
                  const totalCostValue = activeItems.reduce((sum, item) =>
                    sum + (item.unitCost * item.quantityOnHand), 0);
                  const totalUnits = activeItems.reduce((sum, i) => sum + i.quantityOnHand, 0);
                  const currency = pricedItems.length > 0 ? (pricedItems[0].pricingCurrency || 'USD') : 'USD';
                  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 });

                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                      <div style={{ background: '#FFF9E6', border: '1px solid #FFD98F', borderRadius: '12px', padding: '14px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>SKUs</div>
                        <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#D88F2E' }}>{activeItems.length}</div>
                      </div>
                      <div style={{ background: '#FFF9E6', border: '1px solid #FFD98F', borderRadius: '12px', padding: '14px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Total Units</div>
                        <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#D88F2E' }}>{totalUnits.toLocaleString()}</div>
                      </div>
                      <div style={{ background: '#E6F4EA', border: '1px solid #A5D6A7', borderRadius: '12px', padding: '14px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Retail Value</div>
                        <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#2E7D32' }}>
                          {invValuationLoading ? '...' : pricedItems.length > 0 ? fmt(totalRetailValue) : '—'}
                        </div>
                        {!invValuationLoading && pricedItems.length < activeItems.length && (
                          <div style={{ fontSize: '10px', color: '#888', marginTop: '2px' }}>{pricedItems.length}/{activeItems.length} priced</div>
                        )}
                      </div>
                      <div style={{ background: '#FFF3E0', border: '1px solid #FFCC80', borderRadius: '12px', padding: '14px 16px', textAlign: 'center' }}>
                        <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Cost Basis</div>
                        <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#E65100' }}>
                          {invValuationLoading ? '...' : pricedItems.length > 0 ? fmt(totalCostValue) : '—'}
                        </div>
                        {!invValuationLoading && totalCostValue > 0 && totalRetailValue > 0 && (
                          <div style={{ fontSize: '10px', color: '#888', marginTop: '2px' }}>
                            {((1 - totalCostValue / totalRetailValue) * 100).toFixed(1)}% margin
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {/* ─────────────────────────────────────────────────────────── */}

                <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Your Inventory</h3>
                {vendorInventoryV2Loading && (
                  <p style={{ color: '#F2B04A', textAlign: 'center', padding: '20px', fontStyle: 'italic' }}>
                    Loading inventory from chain...
                  </p>
                )}
                {vendorInventoryV2Loading ? null : vendorInventoryV2.length === 0 ? (
                  <p style={{ color: '#888', marginBottom: '20px' }}>No inventory items found on chain. Use Add to create your first item.</p>
                ) : (() => {
                  // ── Task 3.6 — Apply filters client-side ─────────────────
                  const minPrice = invFilterMinPrice ? parseFloat(invFilterMinPrice) : null;
                  const maxPrice = invFilterMaxPrice ? parseFloat(invFilterMaxPrice) : null;
                  const searchLower = invSearchText.toLowerCase();

                  const filtered = [...vendorInventoryV2]
                    .sort((a, b) => (b.version || 1) - (a.version || 1))
                    .filter((item, idx, arr) => arr.findIndex(x => x.partNumber === item.partNumber) === idx)
                    .filter(item => {
                      if (invFilterDept && item.department !== invFilterDept) return false;
                      if (invFilterCategory && item.category !== invFilterCategory) return false;
                      if (invFilterStatus && item.status !== invFilterStatus) return false;
                      if (searchLower && ![item.name, item.partNumber, item.shortDescription, item.category, item.department]
                        .some(f => (f || '').toLowerCase().includes(searchLower))) return false;
                      // Task 3.7: price filter — uses invPricingMap loaded from vendorUri docs
                      if (minPrice !== null || maxPrice !== null) {
                        const pricing = invPricingMap[item.nftId];
                        if (pricing) {
                          if (minPrice !== null && pricing.listPrice < minPrice) return false;
                          if (maxPrice !== null && pricing.listPrice > maxPrice) return false;
                        }
                        // If pricing not yet loaded, don't filter out the item — show it
                      }
                      return true;
                    });

                  if (filtered.length === 0) {
                    return (
                      <div style={{ textAlign: 'center', padding: '40px 20px', color: '#888' }}>
                        <div style={{ fontSize: '32px', marginBottom: '10px' }}>🔍</div>
                        <p style={{ fontWeight: 'bold', marginBottom: '6px' }}>No items match your filters.</p>
                        <p style={{ fontSize: '13px' }}>Try broadening your search or clearing filters.</p>
                      </div>
                    );
                  }

                  return (
                    <>
                      <p style={{ fontSize: '13px', color: '#888', marginBottom: '10px' }}>
                        Showing {filtered.length} of {[...vendorInventoryV2].filter((item, idx, arr) => arr.findIndex(x => x.partNumber === item.partNumber) === idx).length} item{filtered.length !== 1 ? 's' : ''}
                        {(invSearchText || invFilterDept || invFilterStatus || invFilterCategory) ? ' (filtered)' : ''}
                      </p>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#FFF3E0' }}>
                            <th style={{ padding: '10px', textAlign: 'center', width: '72px' }}>Img</th>
                            <th style={{ padding: '10px', textAlign: 'left' }}>Part #</th>
                            <th style={{ padding: '10px', textAlign: 'left' }}>Name</th>
                            <th style={{ padding: '10px', textAlign: 'left' }}>Category</th>
                            <th style={{ padding: '10px', textAlign: 'left' }}>Dept</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Qty</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Status</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Ver</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Added</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Details</th>
                            <th style={{ padding: '10px', textAlign: 'center' }}>Delete</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map(item => (
                            <tr key={item.id} style={{ borderBottom: '1px solid #FFE0A0' }}>
                              <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                                <ProductImage uri={item.productImageUri} name={item.name} size={56} />
                              </td>
                              <td style={{ padding: '10px', fontFamily: 'monospace', fontSize: '13px' }}>{item.partNumber}</td>
                              <td style={{ padding: '10px' }}>{item.name}</td>
                              <td style={{ padding: '10px' }}>{item.category}</td>
                              <td style={{ padding: '10px' }}>{item.department}</td>
                              <td style={{ padding: '10px', textAlign: 'center' }}>{item.quantityOnHand} {item.unit}</td>
                              <td style={{ padding: '10px', textAlign: 'center' }}>
                                {statusUpdatingNFTId === item.nftId ? (
                                  <span style={{ fontSize: '12px', color: '#888', fontStyle: 'italic' }}>updating...</span>
                                ) : (
                                  <select
                                    value={item.status}
                                    onChange={(e) => quickUpdateItemStatus(item, e.target.value as ItemStatus)}
                                    style={{
                                      padding: '3px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold',
                                      border: '1.5px solid',
                                      borderColor: item.status === 'active' ? '#A8D5B0' : item.status === 'discontinued' ? '#F5A8A8' : '#FFD98F',
                                      background: item.status === 'active' ? '#E6F4EA' : item.status === 'discontinued' ? '#FDE8E8' : '#FFF3CD',
                                      color: item.status === 'active' ? '#2E7D32' : item.status === 'discontinued' ? '#C62828' : '#856404',
                                      cursor: 'pointer',
                                      appearance: 'none',
                                      WebkitAppearance: 'none',
                                      paddingRight: '20px',
                                      backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath d=\'M0 0l5 6 5-6z\' fill=\'%23888\'/%3E%3C/svg%3E")',
                                      backgroundRepeat: 'no-repeat',
                                      backgroundPosition: 'right 6px center',
                                    }}
                                  >
                                    <option value="active">active</option>
                                    <option value="discontinued">discontinued</option>
                                    <option value="out_of_stock">out_of_stock</option>
                                  </select>
                                )}
                              </td>
                              <td style={{ padding: '10px', textAlign: 'center' }}>
                                <span style={{ background: '#E3F2FD', color: '#1565C0', padding: '2px 8px', borderRadius: '10px', fontSize: '12px', fontWeight: 'bold' }}>v{item.version || 1}</span>
                              </td>
                              <td style={{ padding: '10px', textAlign: 'center', fontSize: '12px', color: '#888' }}>{item.dateAdded}</td>
                              <td style={{ padding: '10px', textAlign: 'center' }}>
                                <button onClick={() => openInventoryDetail(item)}
                                  style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white',
                                    padding: '6px 14px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '13px' }}
                                  onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
                                  onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                  View Details
                                </button>
                              </td>
                              <td style={{ padding: '10px', textAlign: 'center' }}>
                                <button onClick={() => {
                                    setReceiveModalItem(item);
                                    setReceiveQty('');
                                    setReceiveLotRef('');
                                    setReceiveResult('');
                                    setShowReceiveModal(true);
                                  }}
                                  style={{ background: 'linear-gradient(90deg, #27ae60 0%, #2ecc71 100%)', color: 'white',
                                    padding: '6px 14px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', marginBottom: '4px', display: 'block', width: '100%' }}
                                  onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
                                  onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                                  title={`Receive new stock for ${item.name}`}>
                                  + Receive
                                </button>
                                <button onClick={() => burnInventoryItemV2(item)}
                                  style={{ background: 'linear-gradient(90deg, #e74c3c 0%, #ff6b6b 100%)', color: 'white',
                                    padding: '6px 14px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', display: 'block', width: '100%' }}
                                  onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
                                  onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                                  title={`Permanently delete ${item.name}`}>
                                  🗑 Delete
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  );
                })()}
          </div>
        )}
        {inventorySubTab === 'add' && (
          <div>
        {/* ── Identity ─────────────────────────────────────────── */}
                <h4 style={{ color: '#D88F2E', marginBottom: '10px' }}>Identity</h4>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Part Number *</label>
                <input value={invPartNumber} onChange={(e) => setInvPartNumber(e.target.value)} placeholder="e.g. WDG-1042" style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '15px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Name *</label>
                <input value={invName} onChange={(e) => setInvName(e.target.value)} placeholder="e.g. Steel Widget Assembly" style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '15px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Short Description <span style={{ fontWeight: 'normal', color: '#aaa' }}>(public, ≤60 chars)</span></label>
                <input value={invShortDesc} onChange={(e) => setInvShortDesc(e.target.value.substring(0, 60))} placeholder="e.g. Precision steel widget, 4mm" style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '15px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Full Description <span style={{ fontWeight: 'normal', color: '#aaa' }}>(vendor-only)</span></label>
                <textarea value={invDesc} onChange={(e) => setInvDesc(e.target.value)} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', height: '80px', marginBottom: '15px' }} />

                {/* ── Classification ───────────────────────────────────── */}
                <h4 style={{ color: '#D88F2E', marginBottom: '10px', marginTop: '10px' }}>Classification</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Category</label>
                    <input value={invCategory} onChange={(e) => setInvCategory(e.target.value)} placeholder="e.g. Fasteners" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Family Code</label>
                    <input value={invFamilyCode} onChange={(e) => setInvFamilyCode(e.target.value)} placeholder="e.g. WDG" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Brand</label>
                    <input value={invBrand} onChange={(e) => setInvBrand(e.target.value)} placeholder="e.g. AcmeParts" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Weight</label>
                    <input value={invWeight} onChange={(e) => setInvWeight(e.target.value)} placeholder="e.g. 0.25kg" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Department</label>
                    <input value={invDepartment} onChange={(e) => setInvDepartment(e.target.value)} placeholder="e.g. Manufacturing" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Production Plant</label>
                    <input value={invPlant} onChange={(e) => setInvPlant(e.target.value)} placeholder="e.g. Plant-A" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px', color: '#F2B04A', fontWeight: 'bold', cursor: 'pointer' }}>
                  <input type="checkbox" checked={invCompetitiveFlag} onChange={(e) => setInvCompetitiveFlag(e.target.checked)} style={{ width: '18px', height: '18px' }} />
                  Competitive / Restricted Item
                </label>

                {/* ── Pricing (vendor-only) ─────────────────────────────── */}
                <h4 style={{ color: '#D88F2E', marginBottom: '10px', marginTop: '10px' }}>Pricing <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '13px' }}>(stored encrypted — vendor only)</span></h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>List Price</label>
                    <input value={invUnitPrice} onChange={(e) => setInvUnitPrice(e.target.value)} placeholder="e.g. 7.50" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Currency</label>
                    <input value={invPriceCurrency} onChange={(e) => setInvPriceCurrency(e.target.value)} placeholder="USD" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Unit Cost</label>
                    <input value={invUnitCost} onChange={(e) => setInvUnitCost(e.target.value)} placeholder="e.g. 3.50" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Cost Currency</label>
                    <input value={invCostCurrency} onChange={(e) => setInvCostCurrency(e.target.value)} placeholder="USD" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Effective Date</label>
                    <input type="date" value={invEffectiveDate} onChange={(e) => setInvEffectiveDate(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Expires Date</label>
                    <input type="date" value={invExpiresDate} onChange={(e) => setInvExpiresDate(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                </div>

                {/* ── Volume Pricing (3.2c) ─────────────────────────────── */}
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', marginBottom: '15px', color: '#F2B04A', fontWeight: 'bold', cursor: 'pointer' }}>
                  <input type="checkbox" checked={invUseVolumePricing} onChange={(e) => {
                    setInvUseVolumePricing(e.target.checked);
                    if (e.target.checked && invVolumeTiers.length === 0) {
                      setInvVolumeTiers([
                        { minQty: '1', maxQty: '', price: '' },
                        { minQty: '', maxQty: '', price: '' },
                      ]);
                    }
                  }} style={{ width: '18px', height: '18px' }} />
                  Enable Volume Pricing (quantity breaks)
                </label>
                {invUseVolumePricing && (
                  <div style={{ background: '#FFF3E0', borderRadius: '15px', padding: '15px', marginBottom: '15px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '10px' }}>
                      <thead>
                        <tr style={{ background: '#FFE0A0' }}>
                          <th style={{ padding: '8px', textAlign: 'left', borderRadius: '8px 0 0 0' }}>Min Qty</th>
                          <th style={{ padding: '8px', textAlign: 'left' }}>Max Qty</th>
                          <th style={{ padding: '8px', textAlign: 'left' }}>Unit Price ($)</th>
                          <th style={{ padding: '8px', textAlign: 'center', borderRadius: '0 8px 0 0' }}>Remove</th>
                        </tr>
                      </thead>
                      <tbody>
                        {invVolumeTiers.map((tier, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #FFE0A0' }}>
                            <td style={{ padding: '6px' }}>
                              <input value={tier.minQty} onChange={(e) => {
                                const updated = [...invVolumeTiers];
                                updated[i] = { ...updated[i], minQty: e.target.value };
                                setInvVolumeTiers(updated);
                              }} placeholder="e.g. 1" style={{ width: '80px', padding: '8px', borderRadius: '20px', border: '2px solid #D88F2E' }} />
                            </td>
                            <td style={{ padding: '6px' }}>
                              {i === invVolumeTiers.length - 1
                                ? <span style={{ color: '#aaa', fontSize: '13px', paddingLeft: '8px' }}>∞ (unlimited)</span>
                                : <input value={tier.maxQty} onChange={(e) => {
                                    const updated = [...invVolumeTiers];
                                    updated[i] = { ...updated[i], maxQty: e.target.value };
                                    setInvVolumeTiers(updated);
                                  }} placeholder="e.g. 99" style={{ width: '80px', padding: '8px', borderRadius: '20px', border: '2px solid #D88F2E' }} />
                              }
                            </td>
                            <td style={{ padding: '6px' }}>
                              <input value={tier.price} onChange={(e) => {
                                const updated = [...invVolumeTiers];
                                updated[i] = { ...updated[i], price: e.target.value };
                                setInvVolumeTiers(updated);
                              }} placeholder="e.g. 6.00" style={{ width: '100px', padding: '8px', borderRadius: '20px', border: '2px solid #D88F2E' }} />
                            </td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>
                              {invVolumeTiers.length > 2 && (
                                <button onClick={() => setInvVolumeTiers(invVolumeTiers.filter((_, idx) => idx !== i))}
                                  style={{ background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '28px', height: '28px', cursor: 'pointer', fontWeight: 'bold' }}>×</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button onClick={() => setInvVolumeTiers([...invVolumeTiers, { minQty: '', maxQty: '', price: '' }])}
                      style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontSize: '13px' }}>
                      + Add Tier
                    </button>
                    <p style={{ fontSize: '12px', color: '#888', marginTop: '8px', marginBottom: 0 }}>
                      Last tier always applies to all quantities above its Min Qty. Prices should decrease as quantity increases.
                    </p>
                  </div>
                )}

                {/* ── Supplier (vendor-only) ────────────────────────────── */}
                <h4 style={{ color: '#D88F2E', marginBottom: '10px', marginTop: '10px' }}>Supplier <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '13px' }}>(stored encrypted — vendor only)</span></h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Supplier Code</label>
                    <input value={invSupplierCode} onChange={(e) => setInvSupplierCode(e.target.value)} placeholder="e.g. SUP-AX-2201" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Supplier Name</label>
                    <input value={invSupplierName} onChange={(e) => setInvSupplierName(e.target.value)} placeholder="e.g. Axion Materials" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                </div>

                {/* ── Quantity ──────────────────────────────────────────── */}
                <h4 style={{ color: '#D88F2E', marginBottom: '10px', marginTop: '10px' }}>Initial Quantity</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Quantity</label>
                    <input value={invInitialQty} onChange={(e) => setInvInitialQty(e.target.value)} placeholder="e.g. 500" type="number" min="0" style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Unit of Measure</label>
                    <select value={invUnit} onChange={(e) => setInvUnit(e.target.value as UnitOfMeasure)} style={{ width: '100%', padding: '12px', borderRadius: '30px', border: '2px solid #D88F2E', background: 'white' }}>
                      <option value="ea">ea (each)</option>
                      <option value="kg">kg</option>
                      <option value="lb">lb</option>
                      <option value="m">m (meters)</option>
                      <option value="ft">ft (feet)</option>
                      <option value="box">box</option>
                    </select>
                  </div>
                </div>

                {/* ── Documents (vendor-only) ───────────────────────────── */}
                <h4 style={{ color: '#D88F2E', marginBottom: '10px', marginTop: '10px' }}>Documents <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '13px' }}>(stored encrypted — vendor only)</span></h4>
                {/* Task 3.8 — product image */}
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Product Image <span style={{ fontWeight: 'normal', color: '#aaa' }}>(jpg, png, webp — shown in catalog)</span></label>
                {invImageFile && (
                  <div style={{ marginBottom: '8px' }}>
                    <img src={URL.createObjectURL(invImageFile)} alt="preview"
                      style={{ width: '80px', height: '80px', objectFit: 'cover', borderRadius: '8px', border: '2px solid #D88F2E' }} />
                  </div>
                )}
                <input type="file" accept="image/*" onChange={(e) => setInvImageFile(e.target.files?.[0] || null)}
                  style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '20px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Pricing Sheet</label>
                <input type="file" onChange={(e) => setInvPricingFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '12px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Design File</label>
                <input type="file" onChange={(e) => setInvDesignFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '12px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>BOM File</label>
                <input type="file" onChange={(e) => setInvBomFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '12px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Usage Guide</label>
                <input type="file" onChange={(e) => setInvUsageFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '30px' }} />

                <button onClick={generateInventoryV2} style={{ display: 'block', margin: '0 auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate Inventory Item
                </button>
                {invResult && <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', borderRadius: '15px', marginTop: '20px' }}>{invResult}</pre>}
          </div>
        )}

        {/* ── Task 3.9 — Import sub-tab ──────────────────────────────────── */}
        {inventorySubTab === 'import' && (
          <div>
            {/* Import type toggle */}
            <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
              <button
                onClick={() => setCsvImportSubTab('csv')}
                style={{ padding: '10px 24px', borderRadius: '20px', border: '2px solid #D88F2E', fontWeight: 'bold', cursor: 'pointer',
                  background: csvImportSubTab === 'csv' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'white',
                  color: csvImportSubTab === 'csv' ? 'white' : '#D88F2E' }}>
                📄 CSV Upload
              </button>
              <button
                onClick={() => setCsvImportSubTab('xrpl')}
                style={{ padding: '10px 24px', borderRadius: '20px', border: '2px solid #D88F2E', fontWeight: 'bold', cursor: 'pointer',
                  background: csvImportSubTab === 'xrpl' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'white',
                  color: csvImportSubTab === 'xrpl' ? 'white' : '#D88F2E' }}>
                🔗 From XRPL Address
              </button>
            </div>

            {/* ── XRPL Address placeholder ── */}
            {csvImportSubTab === 'xrpl' && (
              <div style={{ background: '#F9FAFB', border: '2px dashed #D1D5DB', borderRadius: '16px', padding: '40px', textAlign: 'center' }}>
                <div style={{ fontSize: '40px', marginBottom: '12px' }}>🔗</div>
                <h3 style={{ color: '#6B7280', marginBottom: '8px' }}>Import from XRPL Address</h3>
                <p style={{ color: '#9CA3AF', fontSize: '14px', maxWidth: '400px', margin: '0 auto' }}>
                  Coming soon. This will let you import inventory NFTs minted by other applications
                  by providing the vendor's XRPL address and mapping their NFT schema to your catalog format.
                </p>
              </div>
            )}

            {/* ── CSV Upload flow ── */}
            {csvImportSubTab === 'csv' && !csvImporting && !csvImportDone && (
              <div>
                {/* Step 1 — File upload */}
                {csvHeaders.length === 0 && (
                  <div>
                    <h4 style={{ color: '#D88F2E', marginBottom: '10px' }}>Step 1 — Upload CSV File</h4>
                    <p style={{ fontSize: '13px', color: '#888', marginBottom: '16px' }}>
                      Your CSV must have a header row. Only <strong>Part Number</strong> and <strong>Name</strong> columns are required — all other fields are optional.
                    </p>
                    <input
                      type="file"
                      accept=".csv"
                      onChange={(e) => {
                        const file = e.target.files?.[0] || null;
                        setCsvFile(file);
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                          const text = ev.target?.result as string;
                          const { headers, rows } = parseCSV(text);
                          setCsvHeaders(headers);
                          setCsvRows(rows);
                          // Auto-map headers that closely match known field names
                          const fieldAliases: { [key: string]: string } = {
                            'part number': 'partNumber', 'part#': 'partNumber', 'sku': 'partNumber', 'item number': 'partNumber', 'item#': 'partNumber',
                            'name': 'name', 'product name': 'name', 'item name': 'name', 'description': 'name',
                            'short description': 'shortDescription', 'short desc': 'shortDescription',
                            'category': 'category', 'dept': 'department', 'department': 'department',
                            'price': 'listPrice', 'list price': 'listPrice', 'unit price': 'listPrice',
                            'cost': 'unitCost', 'unit cost': 'unitCost',
                            'qty': 'initialQty', 'quantity': 'initialQty', 'stock': 'initialQty',
                            'unit': 'unit', 'uom': 'unit',
                            'brand': 'brand', 'supplier': 'supplierName', 'supplier name': 'supplierName',
                          };
                          const autoMap: { [h: string]: string } = {};
                          headers.forEach(h => {
                            const match = fieldAliases[h.toLowerCase().trim()];
                            autoMap[h] = match || '__ignore__';
                          });
                          setCsvMapping(autoMap);
                        };
                        reader.readAsText(file);
                      }}
                      style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '12px' }}
                    />
                  </div>
                )}

                {/* Step 2 — Column mapping */}
                {csvHeaders.length > 0 && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <h4 style={{ color: '#D88F2E', margin: 0 }}>Step 2 — Map Columns</h4>
                      <button onClick={() => { setCsvFile(null); setCsvHeaders([]); setCsvRows([]); setCsvMapping({}); setCsvPreviewRows([]); }}
                        style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '13px' }}>
                        ✕ Clear & start over
                      </button>
                    </div>
                    <p style={{ fontSize: '13px', color: '#888', marginBottom: '12px' }}>
                      {csvRows.length} rows detected. Map your CSV columns to inventory fields. Columns set to "Ignore" will not be imported.
                    </p>
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                      <thead>
                        <tr style={{ background: '#FFF3E0' }}>
                          <th style={{ padding: '10px', textAlign: 'left', fontSize: '13px' }}>Your CSV Column</th>
                          <th style={{ padding: '10px', textAlign: 'left', fontSize: '13px' }}>Maps To</th>
                          <th style={{ padding: '10px', textAlign: 'left', fontSize: '13px' }}>Sample Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {csvHeaders.map((header, idx) => (
                          <tr key={header} style={{ borderBottom: '1px solid #FFE0A0' }}>
                            <td style={{ padding: '10px', fontFamily: 'monospace', fontSize: '13px' }}>{header}</td>
                            <td style={{ padding: '10px' }}>
                              <select
                                value={csvMapping[header] || '__ignore__'}
                                onChange={(e) => setCsvMapping(prev => ({ ...prev, [header]: e.target.value }))}
                                style={{ width: '100%', padding: '6px', borderRadius: '10px', border: '1px solid #D88F2E', fontSize: '13px' }}>
                                <option value="__ignore__">— Ignore —</option>
                                <option value="partNumber">Part Number *</option>
                                <option value="name">Name *</option>
                                <option value="shortDescription">Short Description</option>
                                <option value="category">Category</option>
                                <option value="department">Department</option>
                                <option value="brand">Brand</option>
                                <option value="weight">Weight</option>
                                <option value="familyCode">Family Code</option>
                                <option value="productionPlant">Production Plant</option>
                                <option value="listPrice">List Price ($)</option>
                                <option value="unitCost">Unit Cost ($)</option>
                                <option value="initialQty">Initial Quantity</option>
                                <option value="unit">Unit of Measure</option>
                                <option value="supplierName">Supplier Name</option>
                                <option value="supplierCode">Supplier Code</option>
                              </select>
                            </td>
                            <td style={{ padding: '10px', fontSize: '12px', color: '#888' }}>
                              {csvRows[0]?.[idx] || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {/* Preview */}
                    <h4 style={{ color: '#D88F2E', marginBottom: '8px' }}>Step 3 — Preview (first 5 rows)</h4>
                    <div style={{ overflowX: 'auto', marginBottom: '20px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead>
                          <tr style={{ background: '#FFF3E0' }}>
                            {Object.entries(csvMapping)
                              .filter(([, v]) => v !== '__ignore__')
                              .map(([header, field]) => (
                                <th key={field} style={{ padding: '8px', textAlign: 'left', whiteSpace: 'nowrap' }}>{field}</th>
                              ))}
                          </tr>
                        </thead>
                        <tbody>
                          {csvRows.slice(0, 5).map((row, ri) => {
                            const fields = csvRowToFields(row, csvHeaders, csvMapping);
                            return (
                              <tr key={ri} style={{ borderBottom: '1px solid #FFE0A0' }}>
                                {Object.entries(csvMapping)
                                  .filter(([, v]) => v !== '__ignore__')
                                  .map(([, field]) => (
                                    <td key={field} style={{ padding: '8px', color: '#444' }}>{fields[field] || '—'}</td>
                                  ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Duplicate action */}
                    <div style={{ background: '#FFF9E6', border: '1px solid #FFD98F', borderRadius: '12px', padding: '14px', marginBottom: '20px' }}>
                      <p style={{ fontWeight: 'bold', color: '#D88F2E', marginBottom: '8px', fontSize: '14px' }}>If a Part Number already exists in your catalog:</p>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', cursor: 'pointer', fontSize: '14px' }}>
                        <input type="radio" name="dupAction" value="skip" checked={csvDuplicateAction === 'skip'} onChange={() => setCsvDuplicateAction('skip')} />
                        Skip the row (safe — recommended)
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '14px' }}>
                        <input type="radio" name="dupAction" value="version" checked={csvDuplicateAction === 'version'} onChange={() => setCsvDuplicateAction('version')} />
                        Mint as new item anyway (use if updating a catalog from another system)
                      </label>
                    </div>

                    <button
                      onClick={runCSVImport}
                      style={{ display: 'block', margin: '0 auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white',
                        padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer' }}
                      onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}
                      onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      Start Import ({csvRows.length} rows)
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Progress view ── */}
            {csvImporting && (
              <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                <div style={{ fontSize: '32px', marginBottom: '16px' }}>⚙️</div>
                <h4 style={{ color: '#D88F2E', marginBottom: '8px' }}>
                  Minting {csvProgress.current} of {csvProgress.total}
                </h4>
                <p style={{ color: '#888', fontSize: '14px', marginBottom: '20px' }}>{csvProgress.currentName}</p>
                <div style={{ background: '#F3F4F6', borderRadius: '999px', height: '12px', maxWidth: '400px', margin: '0 auto', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: '999px',
                    background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)',
                    width: `${csvProgress.total > 0 ? (csvProgress.current / csvProgress.total) * 100 : 0}%`,
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <p style={{ fontSize: '12px', color: '#aaa', marginTop: '8px' }}>
                  Do not close this tab. Each item is minted sequentially on-chain.
                </p>
              </div>
            )}

            {/* ── Results view ── */}
            {csvImportDone && (
              <div>
                <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                  <div style={{ fontSize: '40px', marginBottom: '8px' }}>✅</div>
                  <h4 style={{ color: '#2E7D32', marginBottom: '4px' }}>Import Complete</h4>
                  <p style={{ color: '#555', fontSize: '14px' }}>
                    <strong>{csvImportedCount}</strong> items minted &nbsp;·&nbsp;
                    <strong>{csvSkippedCount}</strong> skipped
                  </p>
                </div>
                {csvErrors.length > 0 && (
                  <div style={{ background: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: '12px', padding: '16px', marginBottom: '20px' }}>
                    <p style={{ fontWeight: 'bold', color: '#C62828', marginBottom: '10px', fontSize: '14px' }}>
                      {csvErrors.length} row{csvErrors.length !== 1 ? 's' : ''} had issues:
                    </p>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ background: '#FFEBEE' }}>
                          <th style={{ padding: '6px 10px', textAlign: 'left' }}>Row</th>
                          <th style={{ padding: '6px 10px', textAlign: 'left' }}>Part #</th>
                          <th style={{ padding: '6px 10px', textAlign: 'left' }}>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {csvErrors.map((e, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #FFCDD2' }}>
                            <td style={{ padding: '6px 10px', color: '#888' }}>{e.row}</td>
                            <td style={{ padding: '6px 10px', fontFamily: 'monospace' }}>{e.partNumber}</td>
                            <td style={{ padding: '6px 10px', color: '#C62828' }}>{e.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <button
                  onClick={() => {
                    setCsvFile(null); setCsvHeaders([]); setCsvRows([]);
                    setCsvMapping({}); setCsvImportDone(false);
                    setCsvErrors([]); setCsvImportedCount(0); setCsvSkippedCount(0);
                    setCsvProgress({ current: 0, total: 0, currentName: '' });
                  }}
                  style={{ display: 'block', margin: '0 auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white',
                    padding: '12px 40px', fontSize: '16px', border: 'none', borderRadius: '50px', cursor: 'pointer' }}>
                  Import Another File
                </button>
              </div>
            )}
          </div>
        )}

          {/* ── Task 3.7 — Warehouse Wallet Setup Modal ──────────────────── */}
          {showWarehouseSetup && (
            <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: 'white', borderRadius: '20px', padding: '30px', maxWidth: '480px', width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
                <h3 style={{ color: '#F2B04A', marginBottom: '8px' }}>🏭 Warehouse Wallet</h3>
                <p style={{ color: '#555', fontSize: '14px', marginBottom: '16px' }}>
                  Enter the XRPL address of a second wallet you control. Inventory tokens will be paid to this address to track on-hand stock. The warehouse wallet must first authorize each MPT issuance before it can receive tokens.
                </p>
                <div style={{ background: '#FFF9E6', borderRadius: '10px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#856404', border: '1px solid #FFD98F' }}>
                  <strong>Setup steps:</strong><br/>
                  1. Create a second XRPL wallet (e.g. on devnet faucet)<br/>
                  2. Enter its address below<br/>
                  3. Before receiving each SKU, the warehouse wallet must run MPTokenAuthorize for that issuance (Phase 6 will automate this)
                </div>
                <label style={{ display: 'block', marginBottom: '6px', color: '#F2B04A', fontWeight: 'bold' }}>Warehouse Wallet Address</label>
                <input
                  value={warehouseSetupInput}
                  onChange={e => setWarehouseSetupInput(e.target.value)}
                  placeholder="rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                  style={{ width: '100%', padding: '12px 16px', borderRadius: '30px', border: '2px solid #D88F2E', fontSize: '14px', marginBottom: '14px', boxSizing: 'border-box', fontFamily: 'monospace' }}
                />
                <label style={{ display: 'block', marginBottom: '6px', color: '#F2B04A', fontWeight: 'bold' }}>
                  Warehouse Wallet Seed <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '12px' }}>(stored locally — enables auto-authorization)</span>
                </label>
                <input
                  type="password"
                  value={warehouseSetupSeedInput}
                  onChange={e => setWarehouseSetupSeedInput(e.target.value)}
                  placeholder="sXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                  style={{ width: '100%', padding: '12px 16px', borderRadius: '30px', border: '2px solid #D88F2E', fontSize: '14px', marginBottom: '20px', boxSizing: 'border-box', fontFamily: 'monospace' }}
                />
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={() => {
                      if (!warehouseSetupInput.startsWith('r') || warehouseSetupInput.length < 25) {
                        return alert('Enter a valid XRPL address starting with r');
                      }
                      setWarehouseWalletAddress(warehouseSetupInput);
                      localStorage.setItem('scpo_warehouse_wallet', warehouseSetupInput);
                      if (warehouseSetupSeedInput) {
                        setWarehouseWalletSeed(warehouseSetupSeedInput);
                        localStorage.setItem('scpo_warehouse_seed', warehouseSetupSeedInput);
                      }
                      setShowWarehouseSetup(false);
                      alert(`✅ Warehouse wallet configured.\n${warehouseSetupSeedInput ? 'Auto-authorization enabled.' : 'No seed provided — add it to enable auto-authorization.'}`);
                    }}
                    style={{ flex: 1, background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '12px', borderRadius: '30px', border: 'none', cursor: 'pointer', fontSize: '15px', fontWeight: 'bold' }}
                    onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    Save Warehouse Wallet
                  </button>
                  <button onClick={() => setShowWarehouseSetup(false)}
                    style={{ padding: '12px 20px', borderRadius: '30px', border: '1.5px solid #D88F2E', background: 'white', color: '#D88F2E', cursor: 'pointer', fontSize: '15px' }}
                    onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* ── Task 3.7 — Receive Inventory Modal ───────────────────────── */}
          {showReceiveModal && receiveModalItem && (
            <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ background: 'white', borderRadius: '20px', padding: '30px', maxWidth: '460px', width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
                <h3 style={{ color: '#F2B04A', marginBottom: '6px' }}>+ Receive Inventory</h3>
                <p style={{ color: '#555', fontSize: '14px', marginBottom: '20px' }}>
                  Record a new shipment or production run arriving in your warehouse.<br/>
                  This mints tokens on-chain — <strong>OutstandingAmount = units on hand.</strong>
                </p>
                <div style={{ background: '#FFF9E6', borderRadius: '12px', padding: '12px 16px', marginBottom: '20px', border: '1px solid #FFD98F' }}>
                  <div style={{ fontWeight: 'bold', color: '#D88F2E' }}>{receiveModalItem.name}</div>
                  <div style={{ fontSize: '13px', color: '#888', fontFamily: 'monospace' }}>{receiveModalItem.partNumber}</div>
                  <div style={{ fontSize: '13px', color: '#555', marginTop: '4px' }}>
                    Current on hand: <strong>{receiveModalItem.quantityOnHand} {receiveModalItem.unit}</strong>
                  </div>
                </div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>
                  Quantity Received *
                </label>
                <input
                  type="number" min="1" value={receiveQty}
                  onChange={e => setReceiveQty(e.target.value)}
                  placeholder={`e.g. 100 ${receiveModalItem.unit}`}
                  style={{ width: '100%', padding: '12px 16px', borderRadius: '30px', border: '2px solid #D88F2E', fontSize: '15px', marginBottom: '15px', boxSizing: 'border-box' }}
                />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>
                  Lot / PO Reference <span style={{ fontWeight: 'normal', color: '#aaa' }}>(optional)</span>
                </label>
                <input
                  type="text" value={receiveLotRef}
                  onChange={e => setReceiveLotRef(e.target.value)}
                  placeholder="e.g. LOT-2026-001 or PO#4521"
                  style={{ width: '100%', padding: '12px 16px', borderRadius: '30px', border: '2px solid #D88F2E', fontSize: '15px', marginBottom: '20px', boxSizing: 'border-box' }}
                />
                {receiveResult && (
                  <pre style={{ background: receiveResult.startsWith('✅') ? '#E6F4EA' : '#FDE8E8', padding: '12px', borderRadius: '12px', fontSize: '12px', whiteSpace: 'pre-wrap', marginBottom: '15px' }}>
                    {receiveResult}
                  </pre>
                )}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={receiveInventory} disabled={receiveLoading || !receiveQty}
                    style={{ flex: 1, background: receiveLoading || !receiveQty ? '#ccc' : 'linear-gradient(90deg, #27ae60 0%, #2ecc71 100%)', color: 'white', padding: '12px', borderRadius: '30px', border: 'none', cursor: receiveLoading || !receiveLoading ? 'not-allowed' : 'pointer', fontSize: '15px', fontWeight: 'bold' }}
                    onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    {receiveLoading ? 'Processing...' : receiveQty ? `Receive ${receiveQty} ${receiveModalItem.unit}` : '+ Receive'}
                  </button>
                  <button onClick={() => { setShowReceiveModal(false); setReceiveResult(''); }}
                    style={{ padding: '12px 20px', borderRadius: '30px', border: '1.5px solid #D88F2E', background: 'white', color: '#D88F2E', cursor: 'pointer', fontSize: '15px' }}
                    onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
          </div>
        )}
        {activeTab === 'view' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>Overview</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '40px' }}>
              <button onClick={() => setOverviewSubTab('summary')} style={{ height: '50px', padding: '0 30px', background: overviewSubTab === 'summary' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: overviewSubTab === 'summary' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Summary
              </button>
              <button onClick={() => setOverviewSubTab('details')} style={{ height: '50px', padding: '0 30px', background: overviewSubTab === 'details' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: overviewSubTab === 'details' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Details
              </button>

              {/* Phase 2 Refresh Button - ONE CLEAN VERSION */}
              <button 
                               onClick={async () => {
                  setIsRefreshing(true);
                  console.log('🔄 Refreshing POs from XRPL...');
                  await loadPOsFromLedger();   // Now calls the top-level function
                  setIsRefreshing(false);
                }}                 
                style={{ 
                  background: '#F2B04A', 
                  color: 'white', 
                  padding: '12px 24px', 
                  borderRadius: '30px', 
                  border: 'none', 
                  cursor: 'pointer', 
                  fontSize: '16px',
                  alignSelf: 'center'
                }}
                disabled={isRefreshing}
              >
                {isRefreshing ? 'Refreshing...' : '🔄 Refresh from XRPL'}
              </button>
            </div>

            {overviewSubTab === 'summary' && (
              <div>
                <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>{mode === 'customer' ? 'Customer SC.PO Summary' : 'Vendor SC.PO Summary'}</h2>
                <div style={{ display: 'flex', justifyContent: 'space-around', gap: '20px' }}>
                   {['open', 'accepted', 'funded', 'claimed'].map(statusKey => {
                    const filteredPOs = getLatestActivePOs(statusKey as SavedPO['status']);
                    const status = statusKey.charAt(0).toUpperCase() + statusKey.slice(1);
                    const count = filteredPOs.length;
                    const totalValue = filteredPOs.reduce((sum, po) => sum + parseFloat(po.total || '0'), 0);
                    const formattedValue = totalValue >= 1000000 ? `$${Math.round(totalValue / 1000000)}M` : totalValue >= 1000 ? `$${Math.round(totalValue / 1000)}K` : `$${totalValue.toFixed(0)}`;
                    return (
                      <div key={statusKey} style={{ textAlign: 'center', flex: 1 }}>
                        <h4 style={{ color: '#F2B04A', marginBottom: '10px' }}>{status}</h4>
                        <div style={{ background: 'white', padding: '20px', borderRadius: '10px', border: '2px solid #FFD98F', boxShadow: '0 4px 10px rgba(0,0,0,0.1)', marginBottom: '10px', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px', fontWeight: 'bold' }}>{count}</div>
                        <div style={{ background: 'white', padding: '10px 20px', borderRadius: '999px', border: '2px solid #FFD98F', boxShadow: '0 4px 10px rgba(0,0,0,0.1)', fontSize: '20px', fontWeight: 'bold' }}>{formattedValue}</div>
                      </div>
                    );
                  })}
                </div>
                {mode === 'vendor' && getVendorUpdatedPOs().length > 0 && (
                  <div style={{ marginTop: '40px' }}>
                    <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Updated POs (Re-accept Required)</h3>
                    <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #D88F2E' }}>
                      <thead>
                        <tr style={{ background: '#FFF3E0' }}>
                          <th style={{ padding: '10px' }}>PO Name</th>
                          <th style={{ padding: '10px' }}>Updated By</th>
                          <th style={{ padding: '10px' }}>Date</th>
                          <th style={{ padding: '10px' }}>View PO</th>
                        </tr>
                      </thead>
                      <tbody>
                        {getVendorUpdatedPOs().map(po => (
                            <tr key={po.issuanceId || po.id}>
                            <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                            <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>Customer</td>
                            <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>
                              <button 
                                onClick={async () => { 
                                  setSelectedOpenPO(po); 
                                  await viewPOFromUri(po.ipfsUri, po, setVendorOverviewViewedPO, setVendorOverviewPoLoadError); 
                                }} 
                                style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }}
                              >
                                View PO
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {mode === 'vendor' && vendorOverviewViewedPO && (
                      <div style={{ marginTop: '40px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                        <h3 style={{ color: '#F2B04A' }}>Purchase Order Details (From Notification)</h3>
                        <p><strong style={{ color: '#F2B04A' }}>PO Name:</strong> {vendorOverviewViewedPO.poName}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {vendorOverviewViewedPO.description || 'N/A'}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {vendorOverviewViewedPO.department}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Payment Terms:</strong> {vendorOverviewViewedPO.paymentTerms}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Escrow Currency:</strong> {vendorOverviewViewedPO.escrowCurrency === 'RLUSD' ? '💵 RLUSD (1:1 USD)' : '⚡ XRP'}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Delivery Terms:</strong> {vendorOverviewViewedPO.deliveryTerms}</p>
                        <h4 style={{ color: '#F2B04A' }}>Items</h4>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: '#e0e0e0' }}>
                              <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Item #</th>
                              <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Qty</th>
                              <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Total $</th>
                            </tr>
                          </thead>
                          <tbody>
                            {vendorOverviewViewedPO.items.map((item, i) => (
                              <tr key={i}>
                                <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.num}</td>
                                <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.qty}</td>
                                <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>${item.total}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {vendorOverviewViewedPO.attachments && vendorOverviewViewedPO.attachments.length > 0 && (
                          <>
                            <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Attachments</h4>
                            <ul>
                              {vendorOverviewViewedPO.attachments.map((att, i) => (
                                <li key={i}>
                                  <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                                    {att.name}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
                          <button onClick={() => openProfilesModal(selectedOpenPO)} style={{ background: 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                            Profiles
                          </button>
                          {getPOHistory(selectedOpenPO || vendorOverviewViewedPO as any).length > 0 && (
                            <button onClick={() => openHistoryModal(selectedOpenPO, vendorOverviewViewedPO)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                              View History
                            </button>
                          )}
                        </div>
                        <button onClick={() => setVendorOverviewViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                          Close
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {overviewSubTab === 'details' && (
              <>
                {mode === 'customer' && (
                  <div style={{ marginBottom: '40px' }}>
                    <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Funded SC.PO</h3>
                    {getLatestActivePOs('funded').length === 0 ? <p>No funded POs</p> : (
                      <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                          <thead>
                            <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                              <th style={{ padding: '10px', textAlign: 'left', width: '40%' }}>PO Name</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>Date Issued</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Total $</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(fundedExpanded ? sortPOsNewestFirst(getLatestActivePOs('funded')) : sortPOsNewestFirst(getLatestActivePOs('funded').slice(0, 2))).map(po => (
                                <tr key={po.issuanceId || po.id}>
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span><YieldBadge poIssuanceId={po.issuanceId} positions={yieldPositions} /></td>
                                <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                                <td style={{ padding: '10px' }}>${po.total}</td>
                                <td style={{ padding: '10px' }}>
                                  <button onClick={async () => { setSelectedFundedPO(po); await viewPOFromUri(po.ipfsUri, po, setCustomerViewViewedPO, setCustomerViewPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                    View PO
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {getLatestActivePOs('funded').length > 2 && (
                          <div style={{ textAlign: 'center', marginTop: '10px' }}>
                            <button onClick={() => setFundedExpanded(!fundedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              {fundedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {mode === 'customer' && (
                  <div style={{ marginBottom: '40px' }}>
                  <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Claimed SC.PO</h3>
                  {getLatestActivePOs('claimed').length === 0 ? <p>No claimed POs</p> : (
                      <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                          <thead>
                            <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                              <th style={{ padding: '10px', textAlign: 'left', width: '40%' }}>PO Name</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>Date Issued</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Total $</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(closedExpanded ? sortPOsNewestFirst(getLatestActivePOs('claimed')) : sortPOsNewestFirst(getLatestActivePOs('claimed').slice(0, 2))).map(po => (
                                <tr key={po.issuanceId || po.id}>
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span><YieldBadge poIssuanceId={po.issuanceId} positions={yieldPositions} /></td>
                                <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                                <td style={{ padding: '10px' }}>${po.total}</td>
                                <td style={{ padding: '10px' }}>
                                  <button onClick={async () => { setSelectedFundedPO(po); await viewPOFromUri(po.ipfsUri, po, setCustomerViewViewedPO, setCustomerViewPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                    View PO
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {getLatestActivePOs('claimed').length > 2 && (
                          <div style={{ textAlign: 'center', marginTop: '10px' }}>
                            <button onClick={() => setClosedExpanded(!closedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              {closedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {mode === 'vendor' && (
                  <div style={{ marginBottom: '40px' }}>
                    <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Accepted SC.PO (Not Funded)</h3>
                    {getLatestActivePOs('accepted').filter(p => !p.escrowSequence).length === 0 ? <p>No accepted POs</p> : (
                      <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                          <thead>
                            <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                              <th style={{ padding: '10px', textAlign: 'left', width: '40%' }}>PO Name</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>Date Issued</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Total $</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(acceptedExpanded ? sortPOsNewestFirst(getLatestActivePOs('accepted').filter(p => !p.escrowSequence)) : sortPOsNewestFirst(getLatestActivePOs('accepted').filter(p => !p.escrowSequence).slice(0, 2))).map(po => (
                                <tr key={po.issuanceId || po.id}>
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                                <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                                <td style={{ padding: '10px' }}>${po.total}</td>
                                <td style={{ padding: '10px' }}>
                                  <button onClick={async () => { setSelectedOpenPO(po); await viewPOFromUri(po.ipfsUri, po, setVendorViewViewedPO, setVendorViewPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                    View PO
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {getLatestActivePOs('accepted').filter(p => !p.escrowSequence).length > 2 && (
                          <div style={{ textAlign: 'center', marginTop: '10px' }}>
                            <button onClick={() => setAcceptedExpanded(!acceptedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              {acceptedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {mode === 'vendor' && (
                  <div style={{ marginBottom: '40px' }}>
                    <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Funded SC.PO</h3>
                    {getLatestActivePOs('funded').length === 0 ? <p>No funded POs</p> : (
                      <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                          <thead>
                            <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                              <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>PO Name</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Date Issued</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Total $</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Time Remaining</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(fundedExpanded ? sortPOsNewestFirst(getLatestActivePOs('funded')) : sortPOsNewestFirst(getLatestActivePOs('funded').slice(0, 2))).map(po => (
                                <tr key={po.issuanceId || po.id}>
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                                <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                                <td style={{ padding: '10px' }}>${po.total}</td>
                                <td style={{ padding: '10px' }}>{getTimeRemaining(po)}</td>
                                <td style={{ padding: '10px' }}>
                                  <button onClick={async () => { setSelectedFundedPO(po); await viewPOFromUri(po.ipfsUri, po, setVendorViewViewedPO, setVendorViewPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                    View PO
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {getLatestActivePOs('funded').length > 2 && (
                          <div style={{ textAlign: 'center', marginTop: '10px' }}>
                            <button onClick={() => setFundedExpanded(!fundedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              {fundedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {mode === 'vendor' && (
                  <div style={{ marginBottom: '40px' }}>
                    <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Claimed SC.PO</h3>
                    {getLatestActivePOs('claimed').length === 0 ? <p>No claimed POs</p> : (
                      <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #ddd', borderRadius: '15px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                          <thead>
                            <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                              <th style={{ padding: '10px', textAlign: 'left', width: '40%' }}>PO Name</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '25%' }}>Date Issued</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Total $</th>
                              <th style={{ padding: '10px', textAlign: 'left', width: '15%' }}>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(closedExpanded ? sortPOsNewestFirst(getLatestActivePOs('claimed')) : sortPOsNewestFirst(getLatestActivePOs('claimed').slice(0, 2))).map(po => (
                                <tr key={po.issuanceId || po.id}>
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                                <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                                <td style={{ padding: '10px' }}>${po.total}</td>
                                <td style={{ padding: '10px' }}>
                                  <button onClick={async () => { setSelectedFundedPO(po); await viewPOFromUri(po.ipfsUri, po, setVendorViewViewedPO, setVendorViewPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                    View PO
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {getLatestActivePOs('claimed').length > 2 && (
                          <div style={{ textAlign: 'center', marginTop: '10px' }}>
                            <button onClick={() => setClosedExpanded(!closedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              {closedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {(mode === 'customer' ? customerViewPoLoadError : vendorViewPoLoadError) && (
                  <div style={{ marginTop: '40px', padding: '20px', background: '#ffebee', borderRadius: '15px', textAlign: 'center' }}>
                    <p style={{ color: '#c62828', marginBottom: '15px' }}>
                      <strong>Could not load PO from IPFS:</strong><br />
                      {mode === 'customer' ? customerViewPoLoadError : vendorViewPoLoadError}
                    </p>
                    <p style={{ color: '#666', marginBottom: '20px' }}>
                      IPFS gateways can be slow or temporarily unavailable.<br />
                      Please try again in a moment.
                    </p>
                  </div>
                )}
                {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO) && (
                  <div style={{ marginTop: '40px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                    <h3 style={{ color: '#F2B04A' }}>Purchase Order Details</h3>
                    <p><strong style={{ color: '#F2B04A' }}>PO Name:</strong> {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.poName}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.description || 'N/A'}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.department}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Payment Terms:</strong> {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.paymentTerms}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Escrow Currency:</strong> {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.escrowCurrency === 'RLUSD' ? '💵 RLUSD (1:1 USD)' : '⚡ XRP'}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Delivery Terms:</strong> {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.deliveryTerms}</p>
                    <h4 style={{ color: '#F2B04A' }}>Items</h4>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#e0e0e0' }}>
                          <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Item #</th>
                          <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Qty</th>
                          <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Total $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)?.items.map((item, i) => (
                          <tr key={i}>
                            <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.num}</td>
                            <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.qty}</td>
                            <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>${item.total}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
                      <button onClick={() => openProfilesModal(selectedOpenPO || selectedFundedPO)} style={{ background: 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                        Profiles
                      </button>
                      {getPOHistory(selectedOpenPO || selectedFundedPO || (mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO) as any).length > 0 && (
                        <button onClick={() => openHistoryModal(selectedOpenPO || selectedFundedPO, mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                          View History
                        </button>
                      )}
                      <button onClick={() => openPOInventoryModal(selectedOpenPO || selectedFundedPO, mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO)}
                        style={{ background: 'linear-gradient(90deg, #27ae60 0%, #2ecc71 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                        Inventory
                      </button>
                    </div>
                    {(() => {
                      const currentViewedPO = mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO;
                      const historyPOs = getPOHistory(selectedOpenPO || selectedFundedPO || currentViewedPO as any);
                      return historyPOs.length > 0 && (
                        <div style={{ marginTop: '20px' }}>
                          <h4 style={{ color: '#F2B04A', cursor: 'pointer' }} onClick={() => setShowHistory(!showHistory)}>
                            View History {showHistory ? '▲' : '▼'}
                          </h4>
                          {showHistory && (
                            <div>
                              {historyPOs.map(hist => (
                                <div key={hist.id} style={{ marginBottom: '10px', padding: '10px', border: '1px solid #ddd', borderRadius: '10px' }}>
                                  <strong>Version:</strong> {hist.poName} (Status: {hist.status})
                                  <button onClick={async () => { await viewPOFromUri(hist.ipfsUri, hist, mode === 'customer' ? setCustomerViewViewedPO : setVendorViewViewedPO, mode === 'customer' ? setCustomerViewPoLoadError : setVendorViewPoLoadError); }} style={{ marginLeft: '10px', background: '#F2B04A', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer' }}>
                                    Load This Version
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Inventory Details</h4>
                    {(() => {
                      const currentPoInventory = mode === 'customer' ? customerViewPoInventory : vendorViewPoInventory;
                      const currentViewedPO = mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO;
                      return currentViewedPO?.items.map((item, i) => {
                        const inv = currentPoInventory[item.num];
                        return inv ? (
                          <div key={i} style={{ marginBottom: '20px', border: '1px solid #D88F2E', padding: '10px', borderRadius: '10px' }}>
                            <h5 style={{ color: '#F2B04A' }}>Item: {item.num}</h5>
                            <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {inv.description}</p>
                            <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {inv.department}</p>
                            {inv.attachments.length > 0 && (
                              <>
                                <strong style={{ color: '#F2B04A' }}>Inventory Attachments:</strong>
                                <ul>
                                  {inv.attachments.map((att: Attachment, j: number) => (
                                    <li key={j}>
                                      <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                                        {att.name}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </div>
                        ) : null;
                      });
                    })()}
                    <button onClick={() => mode === 'customer' ? setCustomerViewViewedPO(null) : setVendorViewViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      Close
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {activeTab === 'customerProfile' && hydrated && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>Profile</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '40px' }}>
              <button onClick={() => setCustomerProfileSubTab('profile')} style={{ height: '50px', padding: '0 30px', background: customerProfileSubTab === 'profile' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: customerProfileSubTab === 'profile' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Profile
              </button>
              <button onClick={() => setCustomerProfileSubTab('links')} style={{ height: '50px', padding: '0 30px', background: customerProfileSubTab === 'links' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: customerProfileSubTab === 'links' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Links
              </button>
            </div>
            {customerProfileSubTab === 'profile' && (
              <div>
                <p style={{ textAlign: 'center', marginBottom: '30px', color: '#666' }}>Save your company and wallet info — seed will auto-fill when creating POs.</p>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Unique ID / Name</label>
                <input placeholder="Enter unique ID (e.g. Customer123)" value={customerProfile.uniqueID} onChange={(e) => setCustomerProfile({ ...customerProfile, uniqueID: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Company Name</label>
                <input placeholder="Enter your company name" value={customerProfile.company} onChange={(e) => setCustomerProfile({ ...customerProfile, company: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Contact Name</label>
                <input placeholder="Your full name" value={customerProfile.name} onChange={(e) => setCustomerProfile({ ...customerProfile, name: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Profile Contact Email Address</label>
                <input placeholder="Your email address" value={customerProfile.email} onChange={(e) => setCustomerProfile({ ...customerProfile, email: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Phone Number</label>
                <input placeholder="Your phone number" value={customerProfile.phone} onChange={(e) => setCustomerProfile({ ...customerProfile, phone: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Street Address</label>
                <input placeholder="Street address" value={customerProfile.address} onChange={(e) => setCustomerProfile({ ...customerProfile, address: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', maxWidth: '600px', margin: '0 auto 20px auto' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>City</label>
                    <input placeholder="City" value={customerProfile.city} onChange={(e) => setCustomerProfile({ ...customerProfile, city: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>State / Province</label>
                    <input placeholder="State or province" value={customerProfile.state} onChange={(e) => setCustomerProfile({ ...customerProfile, state: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>ZIP / Postal Code</label>
                    <input placeholder="ZIP or postal code" value={customerProfile.zip} onChange={(e) => setCustomerProfile({ ...customerProfile, zip: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                </div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Country</label>
                <input placeholder="Country" value={customerProfile.country} onChange={(e) => setCustomerProfile({ ...customerProfile, country: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Wallet Seed (secret!)</label>
                <input placeholder="Your XRPL wallet seed (keep secret)" value={customerProfile.seed} onChange={(e) => setCustomerProfile({ ...customerProfile, seed: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Wallet Address</label>
                <input placeholder="Your XRPL classic address (r...)" value={customerProfile.classicAddress} onChange={(e) => setCustomerProfile({ ...customerProfile, classicAddress: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                                
                <button onClick={saveCustomerProfile} style={{ display: 'block', margin: '20px auto 40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Save Profile
                </button>
                {customerProfile.classicAddress && (
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <DIDStatusBadge address={customerProfile.classicAddress} />
                    {customerCredStatus && (
                      <span style={{ padding: '8px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold', background: customerCredStatus.valid ? '#E8F5E9' : '#FFF3E0', color: customerCredStatus.valid ? '#2E7D32' : '#E65100', border: customerCredStatus.valid ? '2px solid #2E7D32' : '2px solid #E65100' }}>
                        {customerCredStatus.valid ? `${customerCredStatus.tier?.charAt(0).toUpperCase()}${customerCredStatus.tier?.slice(1)} ✓` : 'No Credential'}
                      </span>
                    )}
                  </div>
                )}
                <label style={{ display: 'block', textAlign: 'center', color: '#666' }}>
                  <input type="checkbox" checked={autoRefreshEnabled} onChange={(e) => setAutoRefreshEnabled(e.target.checked)} />
                  Enable Auto-Refresh
                </label>
              </div>
            )}
            {customerProfileSubTab === 'links' && (
              <div>
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Link Vendor by Wallet Address</h3>
                <input placeholder="Enter Vendor Wallet Address (r...)" value={inputVendorWalletAddress} onChange={(e) => setInputVendorWalletAddress(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={addLinkedVendorByDID} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Link Vendor
                </button>
                <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Linked Vendors</h3>
                {linkedVendors.length === 0 ? (
                  <p>No linked vendors</p>
                ) : (
                  <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #D88F2E', borderRadius: '15px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                      <thead>
                        <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                          <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>Unique ID</th>
                          <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>Company Name</th>
                          <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Status</th>
                          <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(vendorsExpanded ? linkedVendors : linkedVendors.slice(0, 2)).map(v => (
                          <tr key={v.profileUUID}>
                            <td style={{ padding: '10px' }}>{v.uniqueID}</td>
                            <td style={{ padding: '10px' }}>{v.company}</td>
                            <td style={{ padding: '10px' }}>{isOutdated(v) ? 'Outdated' : 'Current'}</td>
                            <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                              <button onClick={() => setSelectedLinkedVendor(v)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View
                              </button>
                              <button onClick={() => handleRefresh(v.profileUUID)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                Refresh
                              </button>
                              <button onClick={() => unlinkProfile(v.profileUUID)} style={{ background: '#e74c3c', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                Unlink
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {linkedVendors.length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button onClick={() => setVendorsExpanded(!vendorsExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                          {vendorsExpanded ? 'Show Less ▲' : 'Show More ▼'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {selectedLinkedVendor && (
                  <div style={{ marginTop: '40px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                    <h3 style={{ color: '#F2B04A' }}>Vendor Details</h3>
                    <p><strong style={{ color: '#F2B04A' }}>Unique ID:</strong> {selectedLinkedVendor.uniqueID}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Company Name:</strong> {selectedLinkedVendor.company}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Contact Name:</strong> {selectedLinkedVendor.name}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Email:</strong> {selectedLinkedVendor.email}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Phone:</strong> {selectedLinkedVendor.phone}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Address:</strong> {selectedLinkedVendor.address}</p>
                    <p><strong style={{ color: '#F2B04A' }}>City:</strong> {selectedLinkedVendor.city}</p>
                    <p><strong style={{ color: '#F2B04A' }}>State:</strong> {selectedLinkedVendor.state}</p>
                    <p><strong style={{ color: '#F2B04A' }}>ZIP:</strong> {selectedLinkedVendor.zip}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Country:</strong> {selectedLinkedVendor.country}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Wallet Address:</strong> {selectedLinkedVendor.classicAddress}</p>
                    {selectedLinkedVendor.linkTxHash && (
                      <p><strong style={{ color: '#F2B04A' }}>On-chain Link Tx:</strong> <a href={`https://devnet.xrpl.org/transactions/${selectedLinkedVendor.linkTxHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                        {selectedLinkedVendor.linkTxHash.substring(0, 10)}...
                      </a></p>
                    )}
                    <button onClick={() => setSelectedLinkedVendor(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      Close
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab === 'vendorProfile' && hydrated && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>Profile</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '40px' }}>
              <button onClick={() => setVendorProfileSubTab('profile')} style={{ height: '50px', padding: '0 30px', background: vendorProfileSubTab === 'profile' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: vendorProfileSubTab === 'profile' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Profile
              </button>
              <button onClick={() => setVendorProfileSubTab('links')} style={{ height: '50px', padding: '0 30px', background: vendorProfileSubTab === 'links' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)', color: '#FFFFFF', border: '1.5px solid #D88F2E', borderRadius: '999px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: vendorProfileSubTab === 'links' ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)' : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Links
              </button>
            </div>
            {vendorProfileSubTab === 'profile' && (
              <div>
                <p style={{ textAlign: 'center', marginBottom: '30px', color: '#666' }}>Save your company and wallet info — seed will auto-fill when claiming POs.</p>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Unique ID / Name</label>
                <input placeholder="Enter unique ID (e.g. Vendor123)" value={vendorProfile.uniqueID} onChange={(e) => setVendorProfile({ ...vendorProfile, uniqueID: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Company Name</label>
                <input placeholder="Enter your company name" value={vendorProfile.company} onChange={(e) => setVendorProfile({ ...vendorProfile, company: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Contact Name</label>
                <input placeholder="Your full name" value={vendorProfile.name} onChange={(e) => setVendorProfile({ ...vendorProfile, name: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Profile Contact Email Address</label>
                <input placeholder="Your email address" value={vendorProfile.email} onChange={(e) => setVendorProfile({ ...vendorProfile, email: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Phone Number</label>
                <input placeholder="Your phone number" value={vendorProfile.phone} onChange={(e) => setVendorProfile({ ...vendorProfile, phone: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Street Address</label>
                <input placeholder="Street address" value={vendorProfile.address} onChange={(e) => setVendorProfile({ ...vendorProfile, address: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', maxWidth: '600px', margin: '0 auto 20px auto' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>City</label>
                    <input placeholder="City" value={vendorProfile.city} onChange={(e) => setVendorProfile({ ...vendorProfile, city: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>State / Province</label>
                    <input placeholder="State or province" value={vendorProfile.state} onChange={(e) => setVendorProfile({ ...vendorProfile, state: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>ZIP / Postal Code</label>
                    <input placeholder="ZIP or postal code" value={vendorProfile.zip} onChange={(e) => setVendorProfile({ ...vendorProfile, zip: e.target.value })} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E' }} />
                  </div>
                </div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Country</label>
                <input placeholder="Country" value={vendorProfile.country} onChange={(e) => setVendorProfile({ ...vendorProfile, country: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Wallet Seed (secret!)</label>
                <input placeholder="Your XRPL wallet seed (keep secret)" value={vendorProfile.seed} onChange={(e) => setVendorProfile({ ...vendorProfile, seed: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Wallet Address</label>
                <input placeholder="Your XRPL classic address (r...)" value={vendorProfile.classicAddress} onChange={(e) => setVendorProfile({ ...vendorProfile, classicAddress: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                                
                <button onClick={saveVendorProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Save Profile
                </button>
                {vendorProfile.classicAddress && (
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <DIDStatusBadge address={vendorProfile.classicAddress} />
                    {vendorCredStatus && (
                      <span style={{ padding: '8px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold', background: vendorCredStatus.valid ? '#E8F5E9' : '#FFF3E0', color: vendorCredStatus.valid ? '#2E7D32' : '#E65100', border: vendorCredStatus.valid ? '2px solid #2E7D32' : '2px solid #E65100' }}>
                        {vendorCredStatus.valid ? `${vendorCredStatus.tier?.charAt(0).toUpperCase()}${vendorCredStatus.tier?.slice(1)} ✓` : 'No Credential'}
                      </span>
                    )}
                  </div>
                )}
                <label style={{ display: 'block', textAlign: 'center', color: '#666' }}>
                  <input type="checkbox" checked={autoRefreshEnabled} onChange={(e) => setAutoRefreshEnabled(e.target.checked)} />
                  Enable Auto-Refresh
                </label>
              </div>
            )}
            {vendorProfileSubTab === 'links' && (
              <div>
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Link Customer by Wallet Address</h3>
                <input placeholder="Enter Customer Wallet Address (r...)" value={inputCustomerWalletAddress} onChange={(e) => setInputCustomerWalletAddress(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={addLinkedCustomerByDID} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Link Customer
                </button>
                <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Linked Customers</h3>
                {linkedCustomers.length === 0 ? (
                  <p>No linked customers</p>
                ) : (
                  <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid #D88F2E', borderRadius: '15px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                      <thead>
                        <tr style={{ background: '#FFF3E0', position: 'sticky', top: 0, zIndex: 1 }}>
                          <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>Unique ID</th>
                          <th style={{ padding: '10px', textAlign: 'left', width: '30%' }}>Company Name</th>
                          <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Status</th>
                          <th style={{ padding: '10px', textAlign: 'left', width: '20%' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(customersExpanded ? linkedCustomers : linkedCustomers.slice(0, 2)).map(c => (
                          <tr key={c.profileUUID}>
                            <td style={{ padding: '10px' }}>{c.uniqueID}</td>
                            <td style={{ padding: '10px' }}>{c.company}</td>
                            <td style={{ padding: '10px' }}>{isOutdated(c) ? 'Outdated' : 'Current'}</td>
                            <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                              <button onClick={() => setSelectedLinkedCustomer(c)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View
                              </button>
                              <button onClick={() => handleRefresh(c.profileUUID)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                Refresh
                              </button>
                              <button onClick={() => unlinkProfile(c.profileUUID)} style={{ background: '#e74c3c', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                Unlink
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {linkedCustomers.length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button onClick={() => setCustomersExpanded(!customersExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                          {customersExpanded ? 'Show Less ▲' : 'Show More ▼'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {selectedLinkedCustomer && (
                  <div style={{ marginTop: '40px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                    <h3 style={{ color: '#F2B04A' }}>Customer Details</h3>
                    <p><strong style={{ color: '#F2B04A' }}>Unique ID:</strong> {selectedLinkedCustomer.uniqueID}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Company Name:</strong> {selectedLinkedCustomer.company}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Contact Name:</strong> {selectedLinkedCustomer.name}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Email:</strong> {selectedLinkedCustomer.email}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Phone:</strong> {selectedLinkedCustomer.phone}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Address:</strong> {selectedLinkedCustomer.address}</p>
                    <p><strong style={{ color: '#F2B04A' }}>City:</strong> {selectedLinkedCustomer.city}</p>
                    <p><strong style={{ color: '#F2B04A' }}>State:</strong> {selectedLinkedCustomer.state}</p>
                    <p><strong style={{ color: '#F2B04A' }}>ZIP:</strong> {selectedLinkedCustomer.zip}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Country:</strong> {selectedLinkedCustomer.country}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Wallet Address:</strong> {selectedLinkedCustomer.classicAddress}</p>
                    {selectedLinkedCustomer.linkTxHash && (
                      <p><strong style={{ color: '#F2B04A' }}>On-chain Link Tx:</strong> <a href={`https://devnet.xrpl.org/transactions/${selectedLinkedCustomer.linkTxHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                        {selectedLinkedCustomer.linkTxHash.substring(0, 10)}...
                      </a></p>
                    )}
                    <button onClick={() => setSelectedLinkedCustomer(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      Close
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab === 'accounting' && (
          <div id="scpo-accounting-print" style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '8px' }}>Accounting</h2>
            <p style={{ textAlign: 'center', color: '#999', marginBottom: '24px', fontSize: '14px' }}>
              {mode === 'customer' ? 'Financial reports for your purchase orders and escrow activity.' : 'Financial reports for your receivables and escrow activity.'}
            </p>

            {/* 5.6 — Global Tax Period Filter */}
            {(() => {
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth();
              const currentQuarter = Math.floor(currentMonth / 3);

              const periodOptions = [
                { label: 'This Month', value: 'month' },
                { label: 'This Quarter', value: 'quarter' },
                { label: 'This Year', value: 'year' },
                { label: 'Custom Range', value: 'custom' },
              ];

              const getPeriodLabel = () => {
                if (taxPeriod === 'month') return `${now.toLocaleString('default', { month: 'long' })} ${currentYear}`;
                if (taxPeriod === 'quarter') return `Q${currentQuarter + 1} ${currentYear}`;
                if (taxPeriod === 'year') return `FY ${currentYear}`;
                if (taxCustomStart && taxCustomEnd) return `${taxCustomStart} → ${taxCustomEnd}`;
                return 'Custom Range';
              };

              return (
                <div style={{ background: 'white', border: '1.5px solid #D88F2E', borderRadius: '14px', padding: '16px 20px', marginBottom: '24px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#D88F2E', whiteSpace: 'nowrap' }}>📅 Tax Period:</span>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {periodOptions.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => setTaxPeriod(opt.value as any)}
                          style={{ padding: '5px 14px', borderRadius: '20px', border: '1.5px solid #D88F2E', background: taxPeriod === opt.value ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'white', color: taxPeriod === opt.value ? 'white' : '#D88F2E', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <span style={{ fontSize: '12px', color: '#999', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                      Showing: <strong style={{ color: '#D88F2E' }}>{getPeriodLabel()}</strong>
                    </span>
                  </div>
                  {taxPeriod === 'custom' && (
                    <div style={{ display: 'flex', gap: '12px', marginTop: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ fontSize: '12px', color: '#666', whiteSpace: 'nowrap' }}>From:</label>
                        <input
                          type="date"
                          value={taxCustomStart}
                          onChange={e => setTaxCustomStart(e.target.value)}
                          style={{ padding: '5px 10px', borderRadius: '8px', border: '1.5px solid #D88F2E', fontSize: '12px', color: '#333' }}
                        />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <label style={{ fontSize: '12px', color: '#666', whiteSpace: 'nowrap' }}>To:</label>
                        <input
                          type="date"
                          value={taxCustomEnd}
                          onChange={e => setTaxCustomEnd(e.target.value)}
                          style={{ padding: '5px 10px', borderRadius: '8px', border: '1.5px solid #D88F2E', fontSize: '12px', color: '#333' }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 5.2 / 5.3 — AP / AR Aging Report */}
            {(() => {
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth();
              const currentQuarter = Math.floor(currentMonth / 3);

              // Compute tax period window
              const getTaxWindow = (): { start: Date; end: Date } => {
                if (taxPeriod === 'month') return { start: new Date(currentYear, currentMonth, 1), end: new Date(currentYear, currentMonth + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(currentYear, currentQuarter * 3, 1), end: new Date(currentYear, currentQuarter * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
              };

              const { start: periodStart, end: periodEnd } = getTaxWindow();

              const inTaxPeriod = (dateStr: string) => {
                const d = new Date(dateStr);
                return d >= periodStart && d <= periodEnd;
              };

              // Separate POs by status category — filtered by tax period
              const fundedPOs = savedPOs.filter(po => po.status === 'funded' && inTaxPeriod(po.dateIssued));
              const pendingAcceptancePOs = mode === 'customer'
                ? savedPOs.filter(po => po.status === 'open' && inTaxPeriod(po.dateIssued))
                : [];
              const unfundedAcceptedPOs = mode === 'customer'
                ? savedPOs.filter(po => po.status === 'accepted' && inTaxPeriod(po.dateIssued))
                : savedPOs.filter(po => (po.status === 'accepted' || po.status === 'open') && inTaxPeriod(po.dateIssued));

              // Only unfunded accepted POs go into aging buckets
              const withAging = unfundedAcceptedPOs.map(po => {
                const issueDate = new Date(po.dateIssued);
                const days = parseInt((po.paymentTerms || '0').split(' ')[0]) || 0;
                const dueDate = new Date(issueDate.getTime() + days * 86400000);
                const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
                const daysPastDue = -daysUntilDue;

                let bucket: 'current' | '30' | '60' | '90+';
                if (daysUntilDue >= 0) bucket = 'current';
                else if (daysPastDue <= 30) bucket = '30';
                else if (daysPastDue <= 60) bucket = '60';
                else bucket = '90+';

                return { ...po, dueDate, daysUntilDue, bucket };
              });

              const bucketTotals = {
                current: withAging.filter(p => p.bucket === 'current').reduce((s, p) => s + parseFloat(p.total || '0'), 0),
                '30': withAging.filter(p => p.bucket === '30').reduce((s, p) => s + parseFloat(p.total || '0'), 0),
                '60': withAging.filter(p => p.bucket === '60').reduce((s, p) => s + parseFloat(p.total || '0'), 0),
                '90+': withAging.filter(p => p.bucket === '90+').reduce((s, p) => s + parseFloat(p.total || '0'), 0),
              };

              const agingTotal = Object.values(bucketTotals).reduce((s, v) => s + v, 0);
              const fundedTotal = fundedPOs.reduce((s, p) => s + parseFloat(p.total || '0'), 0);
              const grandTotal = agingTotal + fundedTotal;

              const bucketColor = (bucket: string) => {
                if (bucket === 'current') return '#27ae60';
                if (bucket === '30') return '#f39c12';
                if (bucket === '60') return '#e67e22';
                return '#e74c3c';
              };

              const bucketLabel = (bucket: string) => {
                if (bucket === 'current') return 'Current';
                if (bucket === '30') return '1–30 Days Past Due';
                if (bucket === '60') return '31–60 Days Past Due';
                return '61+ Days Past Due';
              };

              const renderTable = (
                rows: any[],
                showAging: boolean,
                emptyMsg: string
              ) => rows.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#999', fontSize: '13px', margin: '8px 0 0' }}>{emptyMsg}</p>
              ) : (
                <div style={{ overflowX: 'auto', marginTop: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', borderBottom: '2px solid #FFE0B2' }}>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>PO Name</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>{mode === 'customer' ? 'Vendor' : 'Buyer'}</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Issued</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Due Date</th>
                        <th style={{ padding: '10px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Terms</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Amount</th>
                        <th style={{ padding: '10px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>Status</th>
                        {showAging && <th style={{ padding: '10px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>Aging</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((po, idx) => {
                        const counterparty = mode === 'customer' ? po.vendorAddress : po.buyerAddress;
                        const shortAddr = counterparty ? `${counterparty.slice(0, 6)}...${counterparty.slice(-4)}` : '—';
                        const dueDateStr = po.dueDate
                          ? `${po.dueDate.getMonth() + 1}/${po.dueDate.getDate()}/${po.dueDate.getFullYear()}`
                          : '—';
                        return (
                          <tr key={po.issuanceId} style={{ borderBottom: '1px solid #FFE0B2', background: idx % 2 === 0 ? 'white' : '#FFFDF8' }}>
                            <td style={{ padding: '10px 12px', color: '#333', fontWeight: 'bold' }}>{po.poName}</td>
                            <td style={{ padding: '10px 12px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <span
                                  style={{ color: '#2196F3', fontFamily: 'monospace', fontSize: '12px', cursor: 'pointer', textDecoration: 'underline' }}
                                  onClick={() => {
                                    setProfilesModalPO(po);
                                    setProfilesModalIndex(mode === 'customer' ? 1 : 0);
                                    setShowProfilesModal(true);
                                  }}
                                >
                                  {shortAddr}
                                </span>
                                <span
                                  style={{ color: '#999', fontSize: '11px', cursor: 'pointer' }}
                                  onClick={() => copyToClipboard(counterparty, 'Wallet address')}
                                  title="Copy full address"
                                >
                                  📋
                                </span>
                              </div>
                            </td>
                            <td style={{ padding: '10px 12px', color: '#666' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px 12px', color: '#666' }}>{dueDateStr}</td>
                            <td style={{ padding: '10px 12px', color: '#666' }}>{po.paymentTerms || '—'}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'right', color: '#333', fontWeight: 'bold' }}>${parseFloat(po.total || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                              <span style={{ background: '#FFF3E0', color: '#D88F2E', borderRadius: '999px', padding: '2px 10px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>{po.status}</span>
                            </td>
                            {showAging && po.bucket && (
                              <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                <span style={{ background: bucketColor(po.bucket) + '22', color: bucketColor(po.bucket), borderRadius: '999px', padding: '2px 10px', fontSize: '11px', fontWeight: 'bold' }}>
                                  {po.daysUntilDue !== undefined && po.daysUntilDue >= 0 ? `Due in ${po.daysUntilDue}d` : `${po.daysUntilDue !== undefined ? -po.daysUntilDue : '?'}d overdue`}
                                </span>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <h3 style={{ color: '#D88F2E', margin: '0 0 16px' }}>
                    {mode === 'customer' ? '📋 Accounts Payable' : '📋 Accounts Receivable'}
                  </h3>

                  {/* Section 1: Aging buckets — unfunded accepted POs only */}
                  <div style={{ marginBottom: '24px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '10px' }}>
                      {mode === 'customer' ? 'Accepted — Awaiting Escrow Funding' : 'Accepted — Awaiting Escrow Funding by Buyer'}
                    </div>
                    <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
                      {(['current', '30', '60', '90+'] as const).map(bucket => (
                        <div key={bucket} style={{ flex: 1, minWidth: '110px', background: 'white', border: `2px solid ${bucketColor(bucket)}`, borderRadius: '10px', padding: '10px', textAlign: 'center' }}>
                          <div style={{ fontSize: '10px', fontWeight: 'bold', color: bucketColor(bucket), marginBottom: '4px', textTransform: 'uppercase' }}>
                            {bucketLabel(bucket)}
                          </div>
                          <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#333' }}>
                            ${bucketTotals[bucket].toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                          <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>
                            {withAging.filter(p => p.bucket === bucket).length} PO{withAging.filter(p => p.bucket === bucket).length !== 1 ? 's' : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                    {renderTable(withAging.sort((a, b) => new Date(b.dateIssued).getTime() - new Date(a.dateIssued).getTime()), true, 'No accepted unfunded POs.')}
                  </div>

                  {/* Section 2: Funded — Awaiting Claim */}
                  <div style={{ marginBottom: mode === 'customer' && pendingAcceptancePOs.length > 0 ? '24px' : '0' }}>
                    <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '10px' }}>
                      💵 Funded — Awaiting Claim
                      <span style={{ marginLeft: '10px', fontSize: '12px', color: '#27ae60', fontWeight: 'normal' }}>
                        Payment secured in escrow
                      </span>
                    </div>
                    {renderTable(
                      fundedPOs.map(po => {
                        const issueDate = new Date(po.dateIssued);
                        const days = parseInt((po.paymentTerms || '0').split(' ')[0]) || 0;
                        const dueDate = new Date(issueDate.getTime() + days * 86400000);
                        return { ...po, dueDate };
                      }),
                      false,
                      'No funded POs awaiting claim.'
                    )}
                  </div>

                  {/* Section 3: Customer only — Pending Acceptance */}
                  {mode === 'customer' && (
                    <div style={{ marginTop: '24px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#555', marginBottom: '10px' }}>
                        ⏳ Open — Pending Vendor Acceptance
                      </div>
                      {renderTable(
                        pendingAcceptancePOs.map(po => {
                          const issueDate = new Date(po.dateIssued);
                          const days = parseInt((po.paymentTerms || '0').split(' ')[0]) || 0;
                          const dueDate = new Date(issueDate.getTime() + days * 86400000);
                          return { ...po, dueDate };
                        }),
                        false,
                        'No POs pending vendor acceptance.'
                      )}
                    </div>
                  )}

                  {/* Grand Total */}
                  <div style={{ textAlign: 'right', fontSize: '14px', fontWeight: 'bold', color: '#D88F2E', marginTop: '20px', borderTop: '1px solid #FFE0B2', paddingTop: '12px' }}>
                    Total Outstanding: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>
              );
            })()}

            {/* 5.4 — Cash Flow Summary */}
            {(() => {
              const now = Date.now();
              const periodMs: Record<string, number> = {
                '30':  30  * 86400000,
                '90':  90  * 86400000,
                '180': 180 * 86400000,
                '365': 365 * 86400000,
                'all': Infinity,
              };
             // Apply tax period window to cash flow if set
              const getTaxCutoffs = () => {
                const n = new Date();
                const yr = n.getFullYear();
                const mo = n.getMonth();
                const qtr = Math.floor(mo / 3);
                if (taxPeriod === 'month') return { start: new Date(yr, mo, 1).getTime(), end: new Date(yr, mo + 1, 0).getTime() };
                if (taxPeriod === 'quarter') return { start: new Date(yr, qtr * 3, 1).getTime(), end: new Date(yr, qtr * 3 + 3, 0).getTime() };
                if (taxPeriod === 'year') return { start: new Date(yr, 0, 1).getTime(), end: new Date(yr, 11, 31).getTime() };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart).getTime(), end: new Date(taxCustomEnd).getTime() };
                return { start: cfPeriod === 'all' ? 0 : now - periodMs[cfPeriod], end: Infinity };
              };
              const { start: cfStart, end: cfEnd } = getTaxCutoffs();
              const cutoff = cfStart;
              const periodEntries = auditLog.filter(e => e.timestamp >= cutoff && e.timestamp <= cfEnd);

              // Outflows — FUND_ESCROW entries, amount in payload
              const outflowEntries = periodEntries
                .filter(e => e.action === 'FUND_ESCROW')
                .map(e => ({
                  date: e.date,
                  timestamp: e.timestamp,
                  poName: e.payload?.poName || e.ref.slice(0, 8),
                  amount: parseFloat(e.payload?.amount || '0'),
                  currency: (e.payload?.currency || 'RLUSD') as string,
                  txHash: e.txHash,
                  ref: e.ref,
                }));

              // Inflows — CLAIM_PO entries, match amount from savedPOs
              const inflowEntries = periodEntries
                .filter(e => e.action === 'CLAIM_PO')
                .map(e => {
                  const matchedPO = savedPOs.find(p => p.issuanceId === e.ref);
                  return {
                    date: e.date,
                    timestamp: e.timestamp,
                    poName: matchedPO?.poName || e.ref.slice(0, 8),
                    amount: parseFloat(matchedPO?.total || '0'),
                    currency: matchedPO?.escrowCurrency || 'RLUSD',
                    txHash: e.txHash,
                    ref: e.ref,
                    isYield: false,
                  };
                });

              // ── Phase 6A: Yield inflows (customer mode only) ──────────────────
              // Add net yield received as separate inflow entries
              const yieldInflowEntries = mode === 'customer'
                ? yieldPositions
                    .filter(p =>
                      p.status === 'withdrawn' &&
                      parseFloat(p.netYieldToBuyer || '0') > 0 &&
                      p.withdrawTimestamp &&
                      p.withdrawTimestamp * 1000 >= cfStart &&
                      p.withdrawTimestamp * 1000 <= cfEnd
                    )
                    .map(p => {
                      const matchedPO = savedPOs.find(po => po.issuanceId === p.poIssuanceId);
                      return {
                        date: new Date(p.withdrawTimestamp! * 1000).toLocaleDateString(),
                        timestamp: p.withdrawTimestamp! * 1000,
                        poName: `${matchedPO?.poName || p.poIssuanceId.slice(0, 8)} (Yield)`,
                        amount: parseFloat(p.netYieldToBuyer || '0'),
                        currency: 'RLUSD',
                        txHash: p.withdrawTxHash || '',
                        ref: p.poIssuanceId,
                        isYield: true,
                      };
                    })
                : [];

              const allInflowEntries = [...inflowEntries, ...yieldInflowEntries];
              const totalOutflows = outflowEntries.reduce((s, e) => s + e.amount, 0);
              const totalInflows = allInflowEntries.reduce((s, e) => s + e.amount, 0);
              const totalYieldInflows = yieldInflowEntries.reduce((s, e) => s + e.amount, 0);
              const netFlow = totalInflows - totalOutflows;

              const periodLabel: Record<string, string> = {
                '30': 'Last 30 Days', '90': 'Last 90 Days',
                '180': 'Last 180 Days', '365': 'Last 12 Months', 'all': 'All Time'
              };

              const fmtUSD = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

              const renderCFTable = (entries: typeof outflowEntries, type: 'inflow' | 'outflow') =>
                entries.length === 0 ? (
                  <p style={{ textAlign: 'center', color: '#999', fontSize: '13px', margin: '8px 0' }}>
                    No {type === 'inflow' ? 'claims' : 'escrow fundings'} in this period.
                  </p>
                ) : (
                  <div style={{ overflowX: 'auto', marginTop: '8px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead>
                        <tr style={{ background: '#FFF3E0', borderBottom: '2px solid #FFE0B2' }}>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Date</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>PO</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Amount</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Currency</th>
                          <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Tx Hash</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.sort((a, b) => b.timestamp - a.timestamp).map((e, idx) => (
                          <tr key={e.txHash || idx} style={{ borderBottom: '1px solid #FFE0B2', background: idx % 2 === 0 ? 'white' : '#FFFDF8' }}>
                            <td style={{ padding: '8px 12px', color: '#666' }}>{e.date}</td>
                            <td style={{ padding: '8px 12px', color: '#333', fontWeight: 'bold' }}>{e.poName}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: type === 'inflow' ? '#27ae60' : '#e74c3c', fontWeight: 'bold' }}>
                              {type === 'inflow' ? '+' : '-'}{fmtUSD(e.amount)}
                            </td>
                            <td style={{ padding: '8px 12px', color: '#666' }}>{e.currency}</td>
                            <td style={{ padding: '8px 12px', color: '#666', fontFamily: 'monospace', fontSize: '11px' }}>
                              {e.txHash ? `${e.txHash.slice(0, 8)}...${e.txHash.slice(-6)}` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                    <h3 style={{ color: '#D88F2E', margin: 0 }}>💵 Cash Flow Summary</h3>
                    <select
                      value={cfPeriod}
                      onChange={e => setCfPeriod(e.target.value as any)}
                      style={{ padding: '6px 14px', borderRadius: '20px', border: '1.5px solid #D88F2E', background: 'white', color: '#D88F2E', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
                    >
                      <option value="30">Last 30 Days</option>
                      <option value="90">Last 90 Days</option>
                      <option value="180">Last 180 Days</option>
                      <option value="365">Last 12 Months</option>
                      <option value="all">All Time</option>
                    </select>
                  </div>

                  {auditLogLoading ? (
                    <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>Loading transactions...</p>
                  ) : (
                    <>
                      {/* Summary Cards — order by mode priority */}
                      <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
                        {mode === 'customer' ? (
                          <>
                            <div style={{ flex: 2, minWidth: '160px', background: 'white', border: '2px solid #e74c3c', borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
                              <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#e74c3c', marginBottom: '4px', textTransform: 'uppercase' }}>Escrow Outflows</div>
                              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#e74c3c' }}>-{fmtUSD(totalOutflows)}</div>
                              <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{outflowEntries.length} escrow{outflowEntries.length !== 1 ? 's' : ''} funded</div>
                            </div>
                            <div style={{ flex: 1, minWidth: '130px', background: 'white', border: '2px solid #27ae60', borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
                              <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#27ae60', marginBottom: '4px', textTransform: 'uppercase' }}>Escrow Inflows</div>
                              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#27ae60' }}>+{fmtUSD(totalInflows)}</div>
                              <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{inflowEntries.length} claim{inflowEntries.length !== 1 ? 's' : ''} received{totalYieldInflows > 0 ? ` · ${fmtUSD(totalYieldInflows)} yield` : ''}</div>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ flex: 2, minWidth: '160px', background: 'white', border: '2px solid #27ae60', borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
                              <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#27ae60', marginBottom: '4px', textTransform: 'uppercase' }}>Escrow Inflows</div>
                              <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#27ae60' }}>+{fmtUSD(totalInflows)}</div>
                              <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{inflowEntries.length} claim{inflowEntries.length !== 1 ? 's' : ''} received{totalYieldInflows > 0 ? ` · ${fmtUSD(totalYieldInflows)} yield` : ''}</div>
                            </div>
                            <div style={{ flex: 1, minWidth: '130px', background: 'white', border: '2px solid #e74c3c', borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
                              <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#e74c3c', marginBottom: '4px', textTransform: 'uppercase' }}>Escrow Outflows</div>
                              <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#e74c3c' }}>-{fmtUSD(totalOutflows)}</div>
                              <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{outflowEntries.length} escrow{outflowEntries.length !== 1 ? 's' : ''} funded</div>
                            </div>
                          </>
                        )}
                        <div style={{ flex: 1, minWidth: '130px', background: 'white', border: `2px solid ${netFlow >= 0 ? '#27ae60' : '#e74c3c'}`, borderRadius: '10px', padding: '14px', textAlign: 'center' }}>
                          <div style={{ fontSize: '11px', fontWeight: 'bold', color: netFlow >= 0 ? '#27ae60' : '#e74c3c', marginBottom: '4px', textTransform: 'uppercase' }}>Net Flow</div>
                          <div style={{ fontSize: '20px', fontWeight: 'bold', color: netFlow >= 0 ? '#27ae60' : '#e74c3c' }}>
                            {netFlow >= 0 ? '+' : '-'}{fmtUSD(netFlow)}
                          </div>
                          <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{periodLabel[cfPeriod]}</div>
                        </div>
                      </div>

                      {/* Tables — order by mode priority */}
                      {mode === 'customer' ? (
                        <>
                          <div style={{ marginBottom: '20px' }}>
                            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#e74c3c', marginBottom: '6px' }}>⬆️ Escrow Fundings (Outflows)</div>
                            {renderCFTable(outflowEntries, 'outflow')}
                          </div>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#27ae60', marginBottom: '6px' }}>⬇️ Escrow Claims (Inflows)</div>
                            {renderCFTable(allInflowEntries, 'inflow')}
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ marginBottom: '20px' }}>
                            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#27ae60', marginBottom: '6px' }}>⬇️ Escrow Claims (Inflows)</div>
                            {renderCFTable(allInflowEntries, 'inflow')}
                          </div>
                          <div>
                            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#e74c3c', marginBottom: '6px' }}>⬆️ Escrow Fundings (Outflows)</div>
                            {renderCFTable(outflowEntries, 'outflow')}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* 5.5 — Journal Entries */}
            {(() => {
              const buildJournalEntries = (po: SavedPO) => {
                const amt = parseFloat(po.total || '0');
                const cur = po.escrowCurrency || 'RLUSD';
                const fmtAmt = `$${amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
                const entries: { date: string; event: string; debit: string; credit: string; amount: string; txHash: string; isMemo: boolean }[] = [];
                const poAuditEntries = auditLog.filter(e => e.ref === po.issuanceId);
                entries.push({ date: po.dateIssued, event: 'PO Created', debit: 'Purchase Commitment (Memo)', credit: 'Accounts Payable (Memo)', amount: fmtAmt, txHash: po.txHash || '', isMemo: true });
                const acceptEntry = poAuditEntries.find(e => e.action === 'ACCEPT_PO');
                if (acceptEntry || po.status === 'accepted' || po.status === 'funded' || po.status === 'claimed') {
                  entries.push({ date: acceptEntry?.date || po.dateIssued, event: 'PO Accepted by Vendor', debit: 'Accounts Payable Confirmed (Memo)', credit: 'Purchase Obligation (Memo)', amount: fmtAmt, txHash: acceptEntry?.txHash || '', isMemo: true });
                }
                if (po.status === 'superseded') {
                  const updateEntry = auditLog.find(e => e.action === 'UPDATE_PO' && e.payload?.oldRef === po.issuanceId);
                  entries.push({ date: updateEntry?.date || po.dateIssued, event: 'PO Superseded — Version Voided', debit: 'Purchase Commitment Reversal (Memo)', credit: 'Accounts Payable Reversal (Memo)', amount: fmtAmt, txHash: updateEntry?.txHash || '', isMemo: true });
                }
                const fundEntry = poAuditEntries.find(e => e.action === 'FUND_ESCROW');
                if (fundEntry || po.status === 'funded' || po.status === 'claimed') {
                  entries.push({ date: fundEntry?.date || po.dateIssued, event: 'Escrow Funded', debit: mode === 'customer' ? 'Escrow Asset' : 'Accounts Receivable', credit: mode === 'customer' ? `Cash / ${cur}` : 'Deferred Revenue', amount: fmtAmt, txHash: fundEntry?.txHash || '', isMemo: false });
                }
                const claimEntry = poAuditEntries.find(e => e.action === 'CLAIM_PO');
                if (claimEntry || po.status === 'claimed') {
                  entries.push({ date: claimEntry?.date || po.dateIssued, event: 'Escrow Claimed — Payment Settled', debit: mode === 'customer' ? 'Accounts Payable' : `Cash / ${cur}`, credit: mode === 'customer' ? 'Escrow Asset' : 'Accounts Receivable', amount: fmtAmt, txHash: claimEntry?.txHash || '', isMemo: false });
                }
                const recallEntry = poAuditEntries.find(e => e.action === 'RECALL_PO');
                if (recallEntry || po.status === 'recalled') {
                  entries.push({ date: recallEntry?.date || po.dateIssued, event: 'PO Recalled — Commitment Reversed', debit: 'Accounts Payable', credit: 'Purchase Commitment Reversal', amount: fmtAmt, txHash: recallEntry?.txHash || '', isMemo: false });
                }

                // ── Phase 6A: Yield income entry (customer mode only) ──────────
                // If this PO had an active yield position that was withdrawn,
                // add a yield income journal entry showing net yield received.
                if (mode === 'customer' && po.status === 'claimed') {
                  const yieldPosition = yieldPositions.find(
                    p => p.poIssuanceId === po.issuanceId && p.status === 'withdrawn'
                  );
                  if (yieldPosition && parseFloat(yieldPosition.netYieldToBuyer || '0') > 0) {
                    const netYield = parseFloat(yieldPosition.netYieldToBuyer || '0');
                    const fmtYield = `$${netYield.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 })} RLUSD`;
                    entries.push({
                      date: yieldPosition.withdrawTimestamp
                        ? new Date(yieldPosition.withdrawTimestamp * 1000).toLocaleDateString()
                        : po.dateIssued,
                      event: 'Yield Income Received',
                      debit: 'Cash / RLUSD',
                      credit: 'Interest Income',
                      amount: fmtYield,
                      txHash: yieldPosition.withdrawTxHash || '',
                      isMemo: false,
                    });
                  }
                }

                return entries;
              };

              const currentYear = new Date().getFullYear();
              const currentMonth = new Date().getMonth();
              const currentQuarter = Math.floor(currentMonth / 3);
              const getTaxWindowJ = (): { start: Date; end: Date } => {
                if (taxPeriod === 'month') return { start: new Date(currentYear, currentMonth, 1), end: new Date(currentYear, currentMonth + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(currentYear, currentQuarter * 3, 1), end: new Date(currentYear, currentQuarter * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
              };
              const { start: jStart, end: jEnd } = getTaxWindowJ();
              const journalPOs = savedPOs
                .filter(po => po.status !== 'superseded' || showSuperseded)
                .filter(po => po.status !== 'updated')
                .filter(po => { const d = new Date(po.dateIssued); return d >= jStart && d <= jEnd; })
                .sort((a, b) => new Date(b.dateIssued).getTime() - new Date(a.dateIssued).getTime());
              const supersededCount = savedPOs.filter(po => po.status === 'superseded').length;

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                    <h3 style={{ color: '#D88F2E', margin: 0 }}>📒 Journal Entries</h3>
                    {supersededCount > 0 && (
                      <button onClick={() => setShowSuperseded(!showSuperseded)} style={{ padding: '6px 14px', borderRadius: '20px', border: '1.5px solid #D88F2E', background: showSuperseded ? '#FFF3E0' : 'white', color: '#D88F2E', fontSize: '12px', cursor: 'pointer', fontWeight: 'bold' }}>
                        {showSuperseded ? '🔽 Hide' : '🔼 Show'} Superseded ({supersededCount})
                      </button>
                    )}
                  </div>
                  <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px' }}>
                    GAAP double-entry journal entries derived from on-chain events. <span style={{ background: '#f0f0f0', padding: '1px 6px', borderRadius: '4px' }}>Memo</span> entries record commitments with no cash movement. Hard entries record actual transfers.
                  </p>
                  {journalPOs.length === 0
                    ? <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>No POs found.</p>
                    : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ background: '#FFF3E0' }}>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>PO Name</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold', whiteSpace: 'nowrap' }}>Date</th>
                            <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold', whiteSpace: 'nowrap' }}>Amount</th>
                            <th style={{ padding: '8px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>Status</th>
                            <th style={{ padding: '8px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {journalPOs.map(po => {
                            const isExpanded = expandedJournal === po.issuanceId;
                            const entries = isExpanded ? buildJournalEntries(po) : [];
                            const isSuperseded = po.status === 'superseded';
                            const hasHistory = getPOHistory(po).length > 0;
                            return (
                              <React.Fragment key={po.issuanceId}>
                                <tr style={{ borderBottom: '1px solid #FFE0B2', background: isSuperseded ? '#fff8f0' : 'white' }}>
                                  <td style={{ padding: '10px 12px', fontWeight: 'bold', color: isSuperseded ? '#999' : '#333', textDecoration: isSuperseded ? 'line-through' : 'none' }}>
                                    {po.poName}
                                    {isSuperseded && <span style={{ marginLeft: '6px', fontSize: '10px', background: '#ff9800', color: 'white', borderRadius: '4px', padding: '1px 5px', textDecoration: 'none', display: 'inline-block' }}>SUPERSEDED</span>}
                                  </td>
                                  <td style={{ padding: '10px 12px', color: '#666', whiteSpace: 'nowrap' }}>{po.dateIssued}</td>
                                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 'bold', color: '#333', whiteSpace: 'nowrap' }}>${parseFloat(po.total || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                    <span style={{ background: '#FFF3E0', color: '#D88F2E', borderRadius: '999px', padding: '2px 8px', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>{po.status}</span>
                                  </td>
                                  <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                                      {hasHistory && (
                                        <button onClick={() => openHistoryModal(po, null)} style={{ padding: '4px 10px', borderRadius: '12px', border: '1.5px solid #F2B04A', background: 'white', color: '#F2B04A', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>
                                          History
                                        </button>
                                      )}
                                      <button onClick={() => setExpandedJournal(isExpanded ? null : po.issuanceId)} style={{ padding: '4px 10px', borderRadius: '12px', border: '1.5px solid #D88F2E', background: isExpanded ? '#FFF3E0' : 'white', color: '#D88F2E', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>
                                        {isExpanded ? 'Hide ▲' : 'Entries ▼'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr>
                                    <td colSpan={5} style={{ padding: 0, borderBottom: '1px solid #FFE0B2' }}>
                                      <div style={{ background: '#FFFDF8', padding: '12px' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                          <thead>
                                            <tr style={{ background: '#FFF3E0' }}>
                                              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#D88F2E' }}>Date</th>
                                              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#D88F2E' }}>Event</th>
                                              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#D88F2E' }}>Debit</th>
                                              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#D88F2E' }}>Credit</th>
                                              <th style={{ padding: '6px 10px', textAlign: 'right', color: '#D88F2E' }}>Amount</th>
                                              <th style={{ padding: '6px 10px', textAlign: 'left', color: '#D88F2E' }}>Tx Hash</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {entries.map((entry, idx) => (
                                              <tr key={idx} style={{ borderBottom: '1px solid #FFE0B2', background: entry.isMemo ? '#fafafa' : 'white', opacity: entry.isMemo ? 0.8 : 1 }}>
                                                <td style={{ padding: '6px 10px', color: '#666', whiteSpace: 'nowrap' }}>{entry.date}</td>
                                                <td style={{ padding: '6px 10px', color: '#333', fontWeight: entry.isMemo ? 'normal' : 'bold' }}>
                                                  {entry.isMemo && <span style={{ background: '#f0f0f0', color: '#999', fontSize: '10px', borderRadius: '3px', padding: '1px 4px', marginRight: '4px' }}>memo</span>}
                                                  {entry.event}
                                                </td>
                                                <td style={{ padding: '6px 10px', color: '#2563eb', whiteSpace: 'nowrap' }}>{entry.debit}</td>
                                                <td style={{ padding: '6px 10px', color: '#059669', whiteSpace: 'nowrap' }}>{entry.credit}</td>
                                                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#333', fontWeight: 'bold', whiteSpace: 'nowrap' }}>{entry.amount}</td>
                                                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                                                  {entry.txHash
                                                    ? <span style={{ color: '#999', fontFamily: 'monospace', fontSize: '10px', cursor: 'pointer' }} onClick={() => copyToClipboard(entry.txHash, 'Tx Hash')}>{entry.txHash.slice(0, 8)}...{entry.txHash.slice(-6)} 📋</span>
                                                    : <span style={{ color: '#ccc' }}>—</span>
                                                  }
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                  }
                </div>
              );
            })()}

            {/* 5.8 — Escrow Reconciliation */}
            {(() => {
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth();
              const currentQuarter = Math.floor(currentMonth / 3);
              const getTaxWindowRecon = (): { start: Date; end: Date } => {
                if (taxPeriod === 'month') return { start: new Date(currentYear, currentMonth, 1), end: new Date(currentYear, currentMonth + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(currentYear, currentQuarter * 3, 1), end: new Date(currentYear, currentQuarter * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
              };
              const { start: reconStart, end: reconEnd } = getTaxWindowRecon();
              const inPeriod = (dateStr: string) => { const d = new Date(dateStr); return d >= reconStart && d <= reconEnd; };

              // Build reconciliation rows from all non-open, non-superseded, non-updated POs in period
              const reconPOs = savedPOs.filter(po =>
                !['open', 'superseded', 'updated', 'recalled'].includes(po.status) && inPeriod(po.dateIssued)
              );

              type ReconStatus = 'matched' | 'funded_unclaimed' | 'claimed_no_audit' | 'accepted_unfunded';
              interface ReconRow {
                po: SavedPO;
                fundTx: string;
                claimTx: string;
                status: ReconStatus;
                flag: string;
              }

              const rows: ReconRow[] = reconPOs.map(po => {
                const poAudit = auditLog.filter(e => e.ref === po.issuanceId);
                const fundEntry = poAudit.find(e => e.action === 'FUND_ESCROW');
                const claimEntry = poAudit.find(e => e.action === 'CLAIM_PO');
                const fundTx = fundEntry?.txHash || '';
                const claimTx = claimEntry?.txHash || '';

                let status: ReconStatus;
                let flag: string;

                if (po.status === 'claimed') {
                  if (fundEntry && claimEntry) {
                    status = 'matched'; flag = '✅ Fully reconciled';
                  } else {
                    status = 'claimed_no_audit'; flag = '⚠️ Claimed — audit trail incomplete';
                  }
                } else if (po.status === 'funded') {
                  status = 'funded_unclaimed'; flag = '🕐 Funded — awaiting claim';
                } else if (po.status === 'accepted') {
                  status = 'accepted_unfunded'; flag = '📋 Accepted — escrow not funded';
                } else {
                  status = 'matched'; flag = '—';
                }

                return { po, fundTx, claimTx, status, flag };
              });

              const matched = rows.filter(r => r.status === 'matched');
              const fundedUnclaimed = rows.filter(r => r.status === 'funded_unclaimed');
              const claimedNoAudit = rows.filter(r => r.status === 'claimed_no_audit');
              const acceptedUnfunded = rows.filter(r => r.status === 'accepted_unfunded');

              const totalFunded = rows
                .filter(r => r.status === 'funded_unclaimed' || r.status === 'matched')
                .reduce((s, r) => s + parseFloat(r.po.total || '0'), 0);
              const totalClaimed = matched.reduce((s, r) => s + parseFloat(r.po.total || '0'), 0);
              const totalPending = fundedUnclaimed.reduce((s, r) => s + parseFloat(r.po.total || '0'), 0);

              const flagColor = (s: ReconStatus) => {
                if (s === 'matched') return '#27ae60';
                if (s === 'funded_unclaimed') return '#f39c12';
                if (s === 'claimed_no_audit') return '#e74c3c';
                return '#999';
              };

              const renderReconTable = (rows: ReconRow[]) => (
                <div style={{ overflowX: 'auto', marginTop: '8px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0', borderBottom: '2px solid #FFE0B2' }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>PO Name</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Amount</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Fund Tx</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Claim Tx</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, idx) => (
                        <tr key={r.po.issuanceId} style={{ borderBottom: '1px solid #FFE0B2', background: idx % 2 === 0 ? 'white' : '#FFFDF8' }}>
                          <td style={{ padding: '8px 12px', fontWeight: 'bold', color: '#333' }}>{r.po.poName}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: '#333', fontWeight: 'bold' }}>
                            ${parseFloat(r.po.total || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '11px', color: r.fundTx ? '#666' : '#ccc' }}>
                            {r.fundTx
                              ? <span style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(r.fundTx, 'Fund Tx')}>{r.fundTx.slice(0, 8)}...{r.fundTx.slice(-6)} 📋</span>
                              : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '11px', color: r.claimTx ? '#666' : '#ccc' }}>
                            {r.claimTx
                              ? <span style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(r.claimTx, 'Claim Tx')}>{r.claimTx.slice(0, 8)}...{r.claimTx.slice(-6)} 📋</span>
                              : '—'}
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={{ color: flagColor(r.status), fontSize: '12px', fontWeight: 'bold' }}>{r.flag}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <h3 style={{ color: '#D88F2E', margin: '0 0 16px' }}>🔍 Escrow Reconciliation</h3>

                  {/* Summary cards */}
                  <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '120px', background: 'white', border: '2px solid #27ae60', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#27ae60', marginBottom: '4px', textTransform: 'uppercase' }}>Fully Reconciled</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{matched.length}</div>
                      <div style={{ fontSize: '11px', color: '#999' }}>${totalClaimed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: '120px', background: 'white', border: '2px solid #f39c12', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#f39c12', marginBottom: '4px', textTransform: 'uppercase' }}>Funded — Pending Claim</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{fundedUnclaimed.length}</div>
                      <div style={{ fontSize: '11px', color: '#999' }}>${totalPending.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: '120px', background: 'white', border: '2px solid #e74c3c', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#e74c3c', marginBottom: '4px', textTransform: 'uppercase' }}>Audit Gap</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{claimedNoAudit.length}</div>
                      <div style={{ fontSize: '11px', color: '#999' }}>Claimed, trail missing</div>
                    </div>
                    <div style={{ flex: 1, minWidth: '120px', background: 'white', border: '2px solid #999', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#999', marginBottom: '4px', textTransform: 'uppercase' }}>Accepted Unfunded</div>
                      <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#333' }}>{acceptedUnfunded.length}</div>
                      <div style={{ fontSize: '11px', color: '#999' }}>Escrow not yet created</div>
                    </div>
                  </div>

                  {rows.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>No POs to reconcile in this period.</p>
                  ) : (
                    <>
                      {claimedNoAudit.length > 0 && (
                        <div style={{ marginBottom: '20px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#e74c3c', marginBottom: '6px' }}>⚠️ Discrepancies — Claimed With Incomplete Audit Trail</div>
                          {renderReconTable(claimedNoAudit)}
                        </div>
                      )}
                      {fundedUnclaimed.length > 0 && (
                        <div style={{ marginBottom: '20px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#f39c12', marginBottom: '6px' }}>🕐 Funded — Awaiting Claim</div>
                          {renderReconTable(fundedUnclaimed)}
                        </div>
                      )}
                      {acceptedUnfunded.length > 0 && (
                        <div style={{ marginBottom: '20px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#999', marginBottom: '6px' }}>📋 Accepted — Escrow Not Funded</div>
                          {renderReconTable(acceptedUnfunded)}
                        </div>
                      )}
                      {matched.length > 0 && (
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#27ae60', marginBottom: '6px' }}>✅ Fully Reconciled</div>
                          {renderReconTable(matched)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* 5.9 — Fee Deduction Tracking */}
            {(() => {
              const now = new Date();
              const currentYear = now.getFullYear();
              const currentMonth = now.getMonth();
              const currentQuarter = Math.floor(currentMonth / 3);

              // Reuse tax period window
              const getTaxWindowFee = (): { start: Date; end: Date } => {
                if (taxPeriod === 'month') return { start: new Date(currentYear, currentMonth, 1), end: new Date(currentYear, currentMonth + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(currentYear, currentQuarter * 3, 1), end: new Date(currentYear, currentQuarter * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(currentYear, 0, 1), end: new Date(currentYear, 11, 31) };
              };
              const { start: feeStart, end: feeEnd } = getTaxWindowFee();

              // Parse numeric USD value from amount strings like "$0.01 RLUSD" or "$0.01 USD (0.003 XRP)"
              const parseFeeUSD = (amount: string): number =>
                parseFloat((amount || '').split(' ')[0].replace('$', '') || '0');

              // Filter fee entries to tax period
              const periodFees = feeEntries.filter(fee => {
                const d = new Date(fee.date);
                return d >= feeStart && d <= feeEnd;
              }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

              const totalFeesUSD = periodFees.reduce((s, f) => s + parseFeeUSD(f.amount), 0);
              const rlusdFees = periodFees.filter(f => f.amount.includes('RLUSD'));
              const xrpFees = periodFees.filter(f => !f.amount.includes('RLUSD'));
              const totalRLUSD = rlusdFees.reduce((s, f) => s + parseFeeUSD(f.amount), 0);
              const totalXRP = xrpFees.reduce((s, f) => s + parseFeeUSD(f.amount), 0);

              const exportFeeCSV = () => {
                if (periodFees.length === 0) return;
                const headers = ['date', 'po_name', 'amount', 'currency', 'tx_hash'];
                const rows = periodFees.map(f => {
                  const currency = f.amount.includes('RLUSD') ? 'RLUSD' : 'XRP';
                  return [
                    `"${f.date}"`,
                    `"${f.poName}"`,
                    `"${parseFeeUSD(f.amount).toFixed(4)}"`,
                    `"${currency}"`,
                    `"${f.txHash}"`,
                  ].join(',');
                });
                const csv = [headers.join(','), ...rows].join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const walletAddr = (mode === 'customer' ? customerProfile.classicAddress : vendorProfile.classicAddress) || 'wallet';
                a.download = `scpo-fees-${walletAddr.slice(0, 8)}-${currentYear}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              };

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                    <h3 style={{ color: '#D88F2E', margin: 0 }}>🧾 Fee Deduction Tracking</h3>
                    {periodFees.length > 0 && (
                      <button
                        onClick={exportFeeCSV}
                        style={{ padding: '6px 16px', borderRadius: '20px', border: 'none', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                      >
                        ⬇️ Export CSV
                      </button>
                    )}
                  </div>

                  <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px' }}>
                    Platform fees paid to SC.PO per PO creation, with transaction hashes for expense reporting and tax deduction documentation.
                  </p>

                  {/* Summary cards */}
                  <div style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '130px', background: 'white', border: '2px solid #D88F2E', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#D88F2E', marginBottom: '4px', textTransform: 'uppercase' }}>Total Fees Paid</div>
                      <div style={{ fontSize: '22px', fontWeight: 'bold', color: '#333' }}>${totalFeesUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                      <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{periodFees.length} transaction{periodFees.length !== 1 ? 's' : ''}</div>
                    </div>
                    {totalRLUSD > 0 && (
                      <div style={{ flex: 1, minWidth: '120px', background: 'white', border: '2px solid #2e86de', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#2e86de', marginBottom: '4px', textTransform: 'uppercase' }}>Paid in RLUSD</div>
                        <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#333' }}>${totalRLUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{rlusdFees.length} tx</div>
                      </div>
                    )}
                    {totalXRP > 0 && (
                      <div style={{ flex: 1, minWidth: '120px', background: 'white', border: '2px solid #27ae60', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#27ae60', marginBottom: '4px', textTransform: 'uppercase' }}>Paid in XRP</div>
                        <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#333' }}>${totalXRP.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</div>
                        <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{xrpFees.length} tx</div>
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: '130px', background: 'white', border: '2px solid #999', borderRadius: '10px', padding: '12px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#999', marginBottom: '4px', textTransform: 'uppercase' }}>Avg Fee / PO</div>
                      <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#333' }}>
                        ${periodFees.length > 0 ? (totalFeesUSD / periodFees.length).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '0.00'}
                      </div>
                      <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>per PO created</div>
                    </div>
                  </div>

                  {periodFees.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>No fees paid in this period.</p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                        <thead>
                          <tr style={{ background: '#FFF3E0', borderBottom: '2px solid #FFE0B2' }}>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Date</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>PO Name</th>
                            <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Fee Paid</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Currency</th>
                            <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Tx Hash</th>
                          </tr>
                        </thead>
                        <tbody>
                          {periodFees.map((fee, idx) => {
                            const currency = fee.amount.includes('RLUSD') ? 'RLUSD' : 'XRP';
                            const usdVal = parseFeeUSD(fee.amount);
                            return (
                              <tr key={fee.txHash || idx} style={{ borderBottom: '1px solid #FFE0B2', background: idx % 2 === 0 ? 'white' : '#FFFDF8' }}>
                                <td style={{ padding: '8px 12px', color: '#666', whiteSpace: 'nowrap' }}>{fee.date}</td>
                                <td style={{ padding: '8px 12px', fontWeight: 'bold', color: '#333' }}>{fee.poName}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right', color: '#e74c3c', fontWeight: 'bold' }}>
                                  -${usdVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                                </td>
                                <td style={{ padding: '8px 12px' }}>
                                  <span style={{ background: currency === 'RLUSD' ? '#e8f0fe' : '#e8f8f0', color: currency === 'RLUSD' ? '#2e86de' : '#27ae60', borderRadius: '999px', padding: '2px 8px', fontSize: '11px', fontWeight: 'bold' }}>
                                    {currency}
                                  </span>
                                </td>
                                <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '11px', color: fee.txHash ? '#666' : '#ccc' }}>
                                  {fee.txHash
                                    ? <span style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(fee.txHash, 'Tx Hash')}>{fee.txHash.slice(0, 8)}...{fee.txHash.slice(-6)} 📋</span>
                                    : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      <div style={{ textAlign: 'right', fontSize: '13px', fontWeight: 'bold', color: '#D88F2E', marginTop: '12px', borderTop: '1px solid #FFE0B2', paddingTop: '10px' }}>
                        Total Deductible: -${totalFeesUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                        <span style={{ fontSize: '11px', color: '#999', fontWeight: 'normal', marginLeft: '8px' }}>Consult a tax professional for deductibility.</span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 5.7 — 1099 Data Export (Vendor only) */}
            {mode === 'vendor' && (() => {
              const taxYear = new Date().getFullYear();

              // Get all claimed POs for this vendor in the current tax year
              const claimedPOs = savedPOs.filter(po => {
                if (po.status !== 'claimed') return false;
                const d = new Date(po.dateIssued);
                return d.getFullYear() === taxYear;
              });

              // Group by buyer wallet address
              const byBuyer: Record<string, { total: number; pos: SavedPO[]; profile: PublicProfile | null }> = {};
              for (const po of claimedPOs) {
                const addr = po.buyerAddress;
                if (!byBuyer[addr]) {
                  const profile = [...customerLinkedVendorUUIDs, ...vendorLinkedCustomerUUIDs]
                    .map(uuid => publicProfiles[uuid])
                    .find(p => p?.classicAddress === addr) || null;
                  byBuyer[addr] = { total: 0, pos: [], profile };
                }
                byBuyer[addr].total += parseFloat(po.total || '0');
                byBuyer[addr].pos.push(po);
              }

              const rows: NinetyNineRow[] = Object.entries(byBuyer).map(([addr, data]) => ({
                tax_year: taxYear,
                buyer_company: data.profile?.company || 'Unknown',
                buyer_wallet: addr,
                buyer_name: data.profile?.name || 'Unknown',
                buyer_email: data.profile?.email || '',
                buyer_address: data.profile ? `${data.profile.address}, ${data.profile.city}, ${data.profile.state} ${data.profile.zip}` : '',
                total_payments_usd: data.total.toFixed(2),
                po_count: data.pos.length,
                po_issuance_ids: data.pos.map(p => p.issuanceId).join(' | '),
              }));

              const grandTotal = rows.reduce((s, r) => s + parseFloat(r.total_payments_usd), 0);
              const threshold = 600; // IRS 1099-NEC threshold

              const vendorWallet = vendorProfile.classicAddress;

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
                    <h3 style={{ color: '#D88F2E', margin: 0 }}>🇺🇸 1099 Data Export</h3>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      <span style={{ fontSize: '12px', color: '#999' }}>Tax Year: <strong style={{ color: '#D88F2E' }}>{taxYear}</strong></span>
                      {rows.length > 0 && (
                        <button
                          onClick={() => export1099CSV(rows, taxYear, vendorWallet)}
                          style={{ padding: '6px 16px', borderRadius: '20px', border: 'none', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                        >
                          ⬇️ Export CSV
                        </button>
                      )}
                    </div>
                  </div>

                  <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px' }}>
                    Total payments received per buyer for tax year {taxYear}. Buyers exceeding the ${threshold} IRS threshold are flagged. Export as CSV for your tax preparer.
                  </p>

                  {rows.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>No claimed POs found for {taxYear}.</p>
                  ) : (
                    <>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                          <thead>
                            <tr style={{ background: '#FFF3E0' }}>
                              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Buyer</th>
                              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#D88F2E', fontWeight: 'bold' }}>Wallet</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>POs</th>
                              <th style={{ padding: '8px 12px', textAlign: 'right', color: '#D88F2E', fontWeight: 'bold' }}>Total Received</th>
                              <th style={{ padding: '8px 12px', textAlign: 'center', color: '#D88F2E', fontWeight: 'bold' }}>1099 Required</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.sort((a, b) => parseFloat(b.total_payments_usd) - parseFloat(a.total_payments_usd)).map((row, idx) => {
                              const needsForm = parseFloat(row.total_payments_usd) >= threshold;
                              return (
                                <tr key={row.buyer_wallet} style={{ borderBottom: '1px solid #FFE0B2', background: idx % 2 === 0 ? 'white' : '#FFFDF8' }}>
                                  <td style={{ padding: '10px 12px' }}>
                                    <div style={{ fontWeight: 'bold', color: '#333' }}>{row.buyer_company}</div>
                                    {row.buyer_name !== 'Unknown' && <div style={{ fontSize: '11px', color: '#999' }}>{row.buyer_name}</div>}
                                    {row.buyer_email && <div style={{ fontSize: '11px', color: '#999' }}>{row.buyer_email}</div>}
                                  </td>
                                  <td style={{ padding: '10px 12px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      <span style={{ color: '#666', fontFamily: 'monospace', fontSize: '11px' }}>{row.buyer_wallet.slice(0, 8)}...{row.buyer_wallet.slice(-4)}</span>
                                      <span style={{ cursor: 'pointer', fontSize: '11px' }} onClick={() => copyToClipboard(row.buyer_wallet, 'Wallet address')}>📋</span>
                                    </div>
                                  </td>
                                  <td style={{ padding: '10px 12px', textAlign: 'center', color: '#666' }}>{row.po_count}</td>
                                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 'bold', color: needsForm ? '#e74c3c' : '#27ae60' }}>
                                    ${parseFloat(row.total_payments_usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                                    {needsForm
                                      ? <span style={{ background: '#fde8e8', color: '#e74c3c', borderRadius: '999px', padding: '2px 10px', fontSize: '11px', fontWeight: 'bold' }}>⚠️ Yes</span>
                                      : <span style={{ background: '#e8f8f0', color: '#27ae60', borderRadius: '999px', padding: '2px 10px', fontSize: '11px', fontWeight: 'bold' }}>No</span>
                                    }
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div style={{ textAlign: 'right', fontSize: '13px', fontWeight: 'bold', color: '#D88F2E', marginTop: '12px', borderTop: '1px solid #FFE0B2', paddingTop: '10px' }}>
                        Total Received {taxYear}: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                      <p style={{ fontSize: '11px', color: '#bbb', margin: '8px 0 0', textAlign: 'center' }}>
                        SC.PO provides payment data only. Consult a tax professional for filing requirements.
                      </p>
                    </>
                  )}
                </div>
              );
            })()}

            {/* Phase 6A — Yield Dashboard (customer mode only) */}
            {mode === 'customer' && (
              <div style={{ background: '#FFFDF8', border: '1.5px solid #68D391', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <h3 style={{ color: '#276749', margin: 0 }}>🌱 Escrow Yield</h3>
                  <span style={{ fontSize: '12px', color: '#48BB78', background: '#F0FFF4', padding: '4px 10px', borderRadius: '999px', border: '1px solid #C6F6D5' }}>Verified+ feature</span>
                </div>
                <YieldDashboard
                  positions={yieldPositions}
                  summary={yieldSummary}
                  loading={yieldLoading}
                  partnerRegistry={yieldPartnerRegistry}
                  onRefresh={async () => {
                    if (!customerProfile.classicAddress) return;
                    setYieldLoading(true);
                    const positions = await scanYieldPositions(customerProfile.classicAddress);
                    setYieldPositions(positions);
                    setYieldSummary(computeYieldSummary(positions, yieldPartnerRegistry));
                    setYieldLoading(false);
                  }}
                />
              </div>
            )}

            {/* 5.10 — Currency Gain/Loss (XRP Escrows) */}
            {(() => {
              const xrpPOs = savedPOs.filter(po =>
                (po.escrowCurrency === 'XRP' || (!po.escrowCurrency && po.status !== 'open')) &&
                (po.status === 'funded' || po.status === 'claimed')
              );

              // Tax period filter
              const now2 = new Date();
              const cy = now2.getFullYear(); const cm = now2.getMonth(); const cq = Math.floor(cm / 3);
              const getTaxWindowGL = (): { start: Date; end: Date } => {
                if (taxPeriod === 'month') return { start: new Date(cy, cm, 1), end: new Date(cy, cm + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(cy, cq * 3, 1), end: new Date(cy, cq * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(cy, 0, 1), end: new Date(cy, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(cy, 0, 1), end: new Date(cy, 11, 31) };
              };
              const { start: glStart, end: glEnd } = getTaxWindowGL();
              const periodXrpPOs = xrpPOs.filter(po => { const d = new Date(po.dateIssued); return d >= glStart && d <= glEnd; });

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                  <h3 style={{ color: '#D88F2E', margin: '0 0 8px' }}>📈 Currency Gain / Loss</h3>
                  <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px' }}>
                    XRP-denominated escrows only. Shows original USD value vs. current USD value based on live XRP price.
                    For funded escrows the XRP quantity is fetched live from the ledger. For claimed escrows the XRP quantity is back-calculated from the original PO total.
                  </p>

                  {periodXrpPOs.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>
                      No XRP-denominated escrows in this period. All your escrows use RLUSD — no currency risk to report.
                    </p>
                  ) : (
                    <XRPGainLossTable
                      pos={periodXrpPOs}
                      copyToClipboard={copyToClipboard}
                      getXRPLClient={getXRPLClient}
                    />
                  )}
                </div>
              );
            })()}

            {/* 5.11 — Export Reports */}
            {(() => {
              // ── Shared helpers ──
              const dlCSV = (rows: Record<string, any>[], filename: string) => {
                if (rows.length === 0) return alert('No data to export for this report in the selected period.');
                const headers = Object.keys(rows[0]).join(',');
                const body = rows.map(r =>
                  Object.values(r).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
                ).join('\n');
                const blob = new Blob([headers + '\n' + body], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = filename; a.click();
                URL.revokeObjectURL(url);
              };

              const walletShort = (mode === 'customer'
                ? customerProfile.classicAddress
                : vendorProfile.classicAddress
              )?.slice(0, 8) || 'wallet';

              const periodTag = taxPeriod === 'custom'
                ? `${taxCustomStart}_${taxCustomEnd}`
                : taxPeriod;

              // ── Tax period window ──
              const n = new Date(); const yr = n.getFullYear(); const mo = n.getMonth(); const qtr = Math.floor(mo / 3);
              const getPeriodBounds = () => {
                if (taxPeriod === 'month') return { start: new Date(yr, mo, 1), end: new Date(yr, mo + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(yr, qtr * 3, 1), end: new Date(yr, qtr * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(yr, 0, 1), end: new Date(yr, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(yr, 0, 1), end: new Date(yr, 11, 31) };
              };
              const { start: pStart, end: pEnd } = getPeriodBounds();
              const inPeriod = (dateStr: string) => { const d = new Date(dateStr); return d >= pStart && d <= pEnd; };

              // ── Counterparty name resolver — uses vendorUUID directly (same pattern as rest of app) ──
              const resolveCounterparty = (po: SavedPO): string => {
                // For customer mode: vendor is stored in po.vendorUUID → publicProfiles
                // For vendor mode: buyer wallet → scan linked customers
                if (mode === 'customer' && po.vendorUUID) {
                  return publicProfiles[po.vendorUUID]?.company || po.vendorAddress;
                }
                // Vendor mode: scan linked customers by wallet address
                const buyerProfile = vendorLinkedCustomerUUIDs
                  .map(uuid => publicProfiles[uuid])
                  .find(p => p?.classicAddress === po.buyerAddress);
                return buyerProfile?.company || po.buyerAddress;
              };

              // ── Export: AP / AR ──
              const exportAPAR = () => {
                const pos = savedPOs.filter(po =>
                  !['superseded', 'updated'].includes(po.status) && inPeriod(po.dateIssued)
                );
                if (pos.length === 0) return alert('No POs found in the selected period.');
                const rows = pos.map(po => {
                  const issueDate = new Date(po.dateIssued);
                  const days = parseInt((po.paymentTerms || '0').split(' ')[0]) || 0;
                  const dueDate = new Date(issueDate.getTime() + days * 86400000);
                  return {
                    po_name: po.poName,
                    status: po.status,
                    date_issued: po.dateIssued,
                    due_date: dueDate.toLocaleDateString(),
                    payment_terms: po.paymentTerms || '',
                    amount_usd: parseFloat(po.total || '0').toFixed(2),
                    currency: po.escrowCurrency || 'XRP',
                    counterparty_company: resolveCounterparty(po),
                    counterparty_wallet: mode === 'customer' ? po.vendorAddress : po.buyerAddress,
                    escrow_sequence: po.escrowSequence || '',
                    issuance_id: po.issuanceId,
                    tx_hash: po.txHash || '',
                  };
                });
                dlCSV(rows, `scpo-${mode === 'customer' ? 'ap' : 'ar'}-${walletShort}-${periodTag}.csv`);
              };

              // ── Export: Cash Flow ──
              const exportCashFlow = () => {
                const cf = auditLog.filter(e =>
                  (e.action === 'FUND_ESCROW' || e.action === 'CLAIM_PO') &&
                  e.timestamp >= pStart.getTime() && e.timestamp <= pEnd.getTime()
                );
                const rows = cf.map(e => {
                  const matchedPO = savedPOs.find(p => p.issuanceId === e.ref);
                  const amount = e.action === 'FUND_ESCROW'
                    ? parseFloat(e.payload?.amount || '0')
                    : parseFloat(matchedPO?.total || '0');
                  return {
                    date: e.date,
                    type: e.action === 'FUND_ESCROW' ? 'Outflow' : 'Inflow',
                    po_name: matchedPO?.poName || e.ref.slice(0, 12),
                    amount_usd: amount.toFixed(2),
                    currency: e.payload?.currency || matchedPO?.escrowCurrency || 'RLUSD',
                    counterparty_company: matchedPO ? resolveCounterparty(matchedPO) : '',
                    tx_hash: e.txHash || '',
                    issuance_id: e.ref,
                  };
                });

                // ── Phase 6A: Add yield inflows to cash flow export ───────────
                if (mode === 'customer') {
                  yieldPositions
                    .filter(p =>
                      p.status === 'withdrawn' &&
                      parseFloat(p.netYieldToBuyer || '0') > 0 &&
                      p.withdrawTimestamp &&
                      p.withdrawTimestamp * 1000 >= pStart.getTime() &&
                      p.withdrawTimestamp * 1000 <= pEnd.getTime()
                    )
                    .forEach(p => {
                      const matchedPO = savedPOs.find(po => po.issuanceId === p.poIssuanceId);
                      rows.push({
                        date: new Date(p.withdrawTimestamp! * 1000).toLocaleDateString(),
                        type: 'Yield Inflow',
                        po_name: `${matchedPO?.poName || p.poIssuanceId.slice(0, 12)} (Yield Income)`,
                        amount_usd: parseFloat(p.netYieldToBuyer || '0').toFixed(6),
                        currency: 'RLUSD',
                        counterparty_company: 'SC.PO Yield Partner',
                        tx_hash: p.withdrawTxHash || '',
                        issuance_id: p.poIssuanceId,
                      });
                    });
                }

                if (rows.length === 0) return alert('No cash flow entries found in the selected period.');
                rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                dlCSV(rows, `scpo-cashflow-${walletShort}-${periodTag}.csv`);
              };

              // ── Export: Journal Entries ──
              const exportJournalEntries = () => {
                const journalPOs = savedPOs.filter(po =>
                  !['superseded', 'updated'].includes(po.status) && inPeriod(po.dateIssued)
                );
                if (journalPOs.length === 0) return alert('No journal entries found in the selected period.');
                const rows: Record<string, any>[] = [];
                for (const po of journalPOs) {
                  const amt = parseFloat(po.total || '0').toFixed(2);
                  const cur = po.escrowCurrency || 'RLUSD';
                  const poAudit = auditLog.filter(e => e.ref === po.issuanceId);
                  const counterparty = resolveCounterparty(po);
                  const push = (event: string, debit: string, credit: string, txHash: string, entryType: string) =>
                    rows.push({ po_name: po.poName, date: po.dateIssued, counterparty_company: counterparty, event, debit, credit, amount_usd: amt, currency: cur, entry_type: entryType, tx_hash: txHash });
                  push('PO Created', 'Purchase Commitment (Memo)', 'Accounts Payable (Memo)', po.txHash || '', 'memo');
                  const accept = poAudit.find(e => e.action === 'ACCEPT_PO');
                  if (accept || ['accepted','funded','claimed'].includes(po.status))
                    push('PO Accepted', 'AP Confirmed (Memo)', 'Purchase Obligation (Memo)', accept?.txHash || '', 'memo');
                  const fund = poAudit.find(e => e.action === 'FUND_ESCROW');
                  if (fund || ['funded','claimed'].includes(po.status))
                    push('Escrow Funded', mode === 'customer' ? 'Escrow Asset' : 'Accounts Receivable', mode === 'customer' ? `Cash / ${cur}` : 'Deferred Revenue', fund?.txHash || '', 'hard');
                  const claim = poAudit.find(e => e.action === 'CLAIM_PO');
                  if (claim || po.status === 'claimed')
                    push('Escrow Claimed', mode === 'customer' ? 'Accounts Payable' : `Cash / ${cur}`, mode === 'customer' ? 'Escrow Asset' : 'Accounts Receivable', claim?.txHash || '', 'hard');

                  // ── Phase 6A: Yield income export (customer mode only) ────────
                  if (mode === 'customer' && po.status === 'claimed') {
                    const yieldPos = yieldPositions.find(
                      p => p.poIssuanceId === po.issuanceId && p.status === 'withdrawn'
                    );
                    if (yieldPos && parseFloat(yieldPos.netYieldToBuyer || '0') > 0) {
                      rows.push({
                        po_name:            po.poName,
                        date:               yieldPos.withdrawTimestamp
                                              ? new Date(yieldPos.withdrawTimestamp * 1000).toLocaleDateString()
                                              : po.dateIssued,
                        counterparty_company: 'SC.PO Yield Partner',
                        event:              'Yield Income Received',
                        debit:              'Cash / RLUSD',
                        credit:             'Interest Income',
                        amount_usd:         parseFloat(yieldPos.netYieldToBuyer || '0').toFixed(6),
                        currency:           'RLUSD',
                        entry_type:         'hard',
                        tx_hash:            yieldPos.withdrawTxHash || '',
                      });
                    }
                  }
                }
                dlCSV(rows, `scpo-journal-${walletShort}-${periodTag}.csv`);
              };

              // ── Export: Fees ──
              const exportFees = () => {
                const fees = feeEntries.filter(f => { const d = new Date(f.date); return d >= pStart && d <= pEnd; });
                if (fees.length === 0) return alert('No fees found in the selected period.');
                const rows = fees.map(f => ({
                  date: f.date,
                  po_name: f.poName,
                  amount_usd: parseFloat((f.amount || '').split(' ')[0].replace('$', '') || '0').toFixed(4),
                  currency: f.amount.includes('RLUSD') ? 'RLUSD' : 'XRP',
                  fee_type: 'PO_CREATION',
                  tx_hash: f.txHash || '',
                }));
                dlCSV(rows, `scpo-fees-${walletShort}-${periodTag}.csv`);
              };

              const exportAll = () => {
                exportAPAR();
                setTimeout(exportCashFlow, 400);
                setTimeout(exportJournalEntries, 800);
                setTimeout(exportFees, 1200);
              };

              return (
                <>
            
                  <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px', marginBottom: '16px' }}>
                    <h3 style={{ color: '#D88F2E', margin: '0 0 8px' }}>⬇️ Export Reports</h3>
                    <p style={{ fontSize: '12px', color: '#999', margin: '0 0 20px' }}>
                      Export any report as CSV for QuickBooks / Xero import, or print all reports to PDF via your browser.
                      All exports reflect the currently selected tax period above.
                    </p>

                    {/* Individual CSV buttons */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                      {([
                        { label: mode === 'customer' ? '📋 Accounts Payable' : '📋 Accounts Receivable', sub: 'POs with aging & counterparty', fn: exportAPAR },
                        { label: '💵 Cash Flow', sub: 'Escrow inflows & outflows', fn: exportCashFlow },
                        { label: '📒 Journal Entries', sub: 'GAAP double-entry per PO', fn: exportJournalEntries },
                        { label: '🧾 Platform Fees', sub: 'Deductible PO creation fees', fn: exportFees },
                      ] as { label: string; sub: string; fn: () => void }[]).map(({ label, sub, fn }) => (
                        <button
                          key={label}
                          onClick={fn}
                          style={{ background: 'white', border: '1.5px solid #D88F2E', borderRadius: '12px', padding: '14px 16px', cursor: 'pointer', textAlign: 'left' }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#FFF3E0')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                        >
                          <div style={{ fontWeight: 'bold', color: '#D88F2E', fontSize: '13px', marginBottom: '3px' }}>{label}</div>
                          <div style={{ fontSize: '11px', color: '#999' }}>{sub}</div>
                          <div style={{ fontSize: '11px', color: '#2e86de', marginTop: '6px', fontWeight: 'bold' }}>⬇️ Download CSV</div>
                        </button>
                      ))}
                    </div>

                    {/* Export All + Print */}
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                      <button
                        onClick={exportAll}
                        style={{ flex: 1, minWidth: '160px', padding: '12px 20px', borderRadius: '20px', border: 'none', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
                        onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                      >
                        ⬇️ Export All Reports (4 CSV files)
                      </button>
                      <button
                        onClick={() => {
                          const el = document.getElementById('scpo-accounting-print');
                          if (!el) return alert('Could not find accounting content to print.');
                          const printWindow = window.open('', '_blank', 'width=1100,height=800');
                          if (!printWindow) return alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
                          printWindow.document.write(`
                            <!DOCTYPE html>
                            <html>
                              <head>
                                <title>SC.PO Accounting Report</title>
                                <style>
                                  body { font-family: Helvetica, Arial, sans-serif; background: white; margin: 0; padding: 20px; font-size: 11px; color: #333; }
                                  h2 { color: #D88F2E; text-align: center; margin-bottom: 6px; }
                                  h3 { color: #D88F2E; margin: 0 0 12px; }
                                  p { color: #666; font-size: 11px; }
                                  table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 8px; }
                                  thead tr { background: #FFF3E0; }
                                  th { padding: 6px 8px; text-align: left; color: #D88F2E; font-weight: bold; border-bottom: 2px solid #FFE0B2; }
                                  td { padding: 6px 8px; border-bottom: 1px solid #FFE0B2; }
                                  tr:nth-child(even) td { background: #FFFDF8; }
                                  .card-row { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
                                  .card { border: 2px solid #FFE0B2; border-radius: 8px; padding: 10px; text-align: center; min-width: 100px; flex: 1; }
                                  .section { border: 1.5px solid #FFE0B2; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; background: #FFFDF8; page-break-inside: avoid; }
                                  button, select, input, .no-print { display: none !important; }
                                  span[style*="cursor: pointer"] { cursor: default; }
                                  @page { margin: 15mm; size: landscape; }
                                </style>
                              </head>
                              <body>
                                ${el.innerHTML}
                              </body>
                            </html>
                          `);
                          printWindow.document.close();
                          printWindow.focus();
                          setTimeout(() => {
                            printWindow.print();
                            printWindow.close();
                          }, 500);
                        }}
                        style={{ flex: 1, minWidth: '160px', padding: '12px 20px', borderRadius: '20px', border: '1.5px solid #D88F2E', background: 'white', color: '#D88F2E', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#FFF3E0')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'white')}
                      >
                        🖨️ Print / Save as PDF
                      </button>
                    </div>

                    <p style={{ fontSize: '11px', color: '#bbb', margin: '12px 0 0', textAlign: 'center' }}>
                      CSV files include counterparty names and are formatted for QuickBooks / Xero import. PDF: click Print → "Save as PDF" in your browser's print dialog. Prints landscape for best table formatting.
                    </p>
                  </div>
                </>
              );
            })()}

            {/* 5.12 — On-Chain Proof of Payment */}
            {(() => {
              // Tax period window
              const n = new Date(); const yr = n.getFullYear(); const mo = n.getMonth(); const qtr = Math.floor(mo / 3);
              const getPeriodBounds512 = () => {
                if (taxPeriod === 'month') return { start: new Date(yr, mo, 1), end: new Date(yr, mo + 1, 0) };
                if (taxPeriod === 'quarter') return { start: new Date(yr, qtr * 3, 1), end: new Date(yr, qtr * 3 + 3, 0) };
                if (taxPeriod === 'year') return { start: new Date(yr, 0, 1), end: new Date(yr, 11, 31) };
                if (taxPeriod === 'custom' && taxCustomStart && taxCustomEnd) return { start: new Date(taxCustomStart), end: new Date(taxCustomEnd) };
                return { start: new Date(yr, 0, 1), end: new Date(yr, 11, 31) };
              };
              const { start: p512Start, end: p512End } = getPeriodBounds512();

              const claimedPOs = savedPOs.filter(po =>
                po.status === 'claimed' &&
                (() => { const d = new Date(po.dateIssued); return d >= p512Start && d <= p512End; })()
              );

              const explorerUrl = (txHash: string) => `https://devnet.xrpl.org/transactions/${txHash}`;

              const buildReceipt = (po: SavedPO) => {
                const poAudit = auditLog.filter(e => e.ref === po.issuanceId);
                const acceptEntry  = poAudit.find(e => e.action === 'ACCEPT_PO');
                const fundEntry    = poAudit.find(e => e.action === 'FUND_ESCROW');
                const claimEntry   = poAudit.find(e => e.action === 'CLAIM_PO');
                return {
                  po_name:          po.poName,
                  issuance_id:      po.issuanceId,
                  amount_usd:       parseFloat(po.total || '0').toFixed(2),
                  currency:         po.escrowCurrency || 'XRP',
                  payment_terms:    po.paymentTerms || '',
                  date_issued:      po.dateIssued,
                  date_accepted:    acceptEntry?.date  || '',
                  date_funded:      fundEntry?.date    || '',
                  date_claimed:     claimEntry?.date   || '',
                  buyer_wallet:     po.buyerAddress,
                  vendor_wallet:    po.vendorAddress,
                  escrow_sequence:  po.escrowSequence  || '',
                  ipfs_document:    po.ipfsUri         || '',
                  tx_create:        po.txHash          || '',
                  tx_accept:        acceptEntry?.txHash  || '',
                  tx_fund:          fundEntry?.txHash    || '',
                  tx_claim:         claimEntry?.txHash   || '',
                  generated_at:     new Date().toISOString(),
                  network:          'XRPL Devnet',
                };
              };

              const renderTxLink = (hash: string) =>
                hash
                  ? <a href={explorerUrl(hash)} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#2e86de', fontFamily: 'monospace', fontSize: '11px', wordBreak: 'break-all' }}>
                      {hash.slice(0, 10)}...{hash.slice(-8)} ↗
                    </a>
                  : <span style={{ color: '#ccc', fontSize: '11px' }}>Not recorded</span>;

              return (
                <div style={{ background: '#FFFDF8', border: '1.5px solid #FFE0B2', borderRadius: '14px', padding: '20px 24px' }}>
                  <h3 style={{ color: '#D88F2E', margin: '0 0 8px' }}>✅ On-Chain Proof of Payment</h3>
                  <p style={{ fontSize: '12px', color: '#999', margin: '0 0 16px' }}>
                    Verifiable receipt for each settled PO — links the MPT issuance, escrow sequence, and all transaction hashes in one document.
                    Share with auditors, lenders, or counterparties as proof of completed payment.
                  </p>

                  {claimedPOs.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#999', fontSize: '13px' }}>No claimed POs in this period.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {claimedPOs
                        .sort((a, b) => new Date(b.dateIssued).getTime() - new Date(a.dateIssued).getTime())
                        .map(po => {
                          const receipt = buildReceipt(po);
                          const isExpanded = expandedJournal === `proof_${po.issuanceId}`;
                          const completeness = [receipt.tx_create, receipt.tx_accept, receipt.tx_fund, receipt.tx_claim].filter(Boolean).length;

                          return (
                            <div key={po.issuanceId} style={{ border: '1.5px solid #FFE0B2', borderRadius: '12px', overflow: 'hidden' }}>

                              {/* Receipt header row */}
                              <div
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'white', cursor: 'pointer', flexWrap: 'wrap', gap: '8px' }}
                                onClick={() => setExpandedJournal(isExpanded ? null : `proof_${po.issuanceId}`)}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '16px' }}>🧾</span>
                                  <div>
                                    <div style={{ fontWeight: 'bold', color: '#333', fontSize: '14px' }}>{po.poName}</div>
                                    <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>Issued {po.dateIssued} · {receipt.issuance_id.slice(0, 12)}...</div>
                                  </div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '15px', fontWeight: 'bold', color: '#27ae60' }}>
                                    ${parseFloat(po.total || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {receipt.currency}
                                  </span>
                                  {/* Completeness indicator */}
                                  <div style={{ display: 'flex', gap: '4px' }}>
                                    {(['Create', 'Accept', 'Fund', 'Claim'] as const).map((step, i) => {
                                      const hashes = [receipt.tx_create, receipt.tx_accept, receipt.tx_fund, receipt.tx_claim];
                                      return (
                                        <div key={step} title={`${step} tx: ${hashes[i] ? 'recorded' : 'missing'}`}
                                          style={{ width: '10px', height: '10px', borderRadius: '50%', background: hashes[i] ? '#27ae60' : '#ddd' }} />
                                      );
                                    })}
                                  </div>
                                  <span style={{ fontSize: '12px', color: '#999' }}>{completeness}/4 txs</span>
                                  <span style={{ fontSize: '12px', color: '#D88F2E', fontWeight: 'bold' }}>{isExpanded ? '▲' : '▼'}</span>
                                </div>
                              </div>

                              {/* Expanded receipt body */}
                              {isExpanded && (
                                <div style={{ background: '#FFFDF8', padding: '16px 18px', borderTop: '1px solid #FFE0B2' }}>

                                  {/* Chain of custody timeline */}
                                  <div style={{ marginBottom: '16px' }}>
                                    <div style={{ fontSize: '12px', fontWeight: 'bold', color: '#555', marginBottom: '10px' }}>Chain of Custody</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                      {[
                                        { step: '1', event: 'PO Created', date: receipt.date_issued,  txHash: receipt.tx_create, color: '#2e86de' },
                                        { step: '2', event: 'Accepted by Vendor', date: receipt.date_accepted, txHash: receipt.tx_accept, color: '#8e44ad' },
                                        { step: '3', event: 'Escrow Funded', date: receipt.date_funded,  txHash: receipt.tx_fund,   color: '#e67e22' },
                                        { step: '4', event: 'Payment Claimed', date: receipt.date_claimed, txHash: receipt.tx_claim,  color: '#27ae60' },
                                      ].map(({ step, event, date, txHash, color }) => (
                                        <div key={step} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                                          <div style={{ width: '22px', height: '22px', borderRadius: '50%', background: txHash ? color : '#ddd', color: 'white', fontSize: '11px', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: '1px' }}>
                                            {txHash ? step : '—'}
                                          </div>
                                          <div style={{ flex: 1 }}>
                                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                                              <span style={{ fontSize: '12px', fontWeight: 'bold', color: txHash ? '#333' : '#bbb' }}>{event}</span>
                                              {date && <span style={{ fontSize: '11px', color: '#999' }}>{date}</span>}
                                            </div>
                                            {renderTxLink(txHash)}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>

                                  {/* Details grid */}
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 20px', fontSize: '12px', marginBottom: '16px' }}>
                                    {[
                                      { label: 'Amount', value: `$${receipt.amount_usd} ${receipt.currency}` },
                                      { label: 'Payment Terms', value: receipt.payment_terms || '—' },
                                      { label: 'Escrow Sequence', value: receipt.escrow_sequence ? String(receipt.escrow_sequence) : '—' },
                                      { label: 'Network', value: receipt.network },
                                      { label: 'Buyer Wallet', value: receipt.buyer_wallet },
                                      { label: 'Vendor Wallet', value: receipt.vendor_wallet },
                                      { label: 'MPT Issuance ID', value: receipt.issuance_id },
                                      { label: 'IPFS Document', value: receipt.ipfs_document ? receipt.ipfs_document.replace('ipfs://', '') : '—' },
                                    ].map(({ label, value }) => (
                                      <div key={label}>
                                        <div style={{ color: '#999', fontSize: '10px', textTransform: 'uppercase', fontWeight: 'bold', marginBottom: '2px' }}>{label}</div>
                                        <div style={{ color: '#333', fontFamily: ['Buyer Wallet','Vendor Wallet','MPT Issuance ID','IPFS Document'].includes(label) ? 'monospace' : 'inherit', fontSize: ['Buyer Wallet','Vendor Wallet','MPT Issuance ID','IPFS Document'].includes(label) ? '10px' : '12px', wordBreak: 'break-all' }}>
                                          {value.length > 50 ? (
                                            <span style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(value, label)} title="Click to copy">
                                              {value.slice(0, 18)}...{value.slice(-10)} 📋
                                            </span>
                                          ) : value}
                                        </div>
                                      </div>
                                    ))}
                                  </div>

                                  {/* Action buttons */}
                                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                    <button
                                      onClick={() => {
                                        navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
                                        alert('Receipt JSON copied to clipboard.');
                                      }}
                                      style={{ padding: '7px 16px', borderRadius: '20px', border: '1.5px solid #D88F2E', background: 'white', color: '#D88F2E', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                                    >
                                      📋 Copy Receipt JSON
                                    </button>
                                    <button
                                      onClick={() => {
                                        const json = JSON.stringify(receipt, null, 2);
                                        const blob = new Blob([json], { type: 'application/json' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `scpo-proof-${po.issuanceId.slice(0, 12)}-${po.dateIssued.replace(/\//g, '-')}.json`;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                      }}
                                      style={{ padding: '7px 16px', borderRadius: '20px', border: 'none', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer' }}
                                    >
                                      ⬇️ Download JSON
                                    </button>
                                    {receipt.ipfs_document && (
                                      <a
                                        href={`https://ipfs.io/ipfs/${receipt.ipfs_document.replace('ipfs://', '')}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        style={{ padding: '7px 16px', borderRadius: '20px', border: '1.5px solid #8e44ad', color: '#8e44ad', fontSize: '12px', fontWeight: 'bold', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                                      >
                                        📄 View PO Document ↗
                                      </a>
                                    )}
                                  </div>
                                  <div style={{ fontSize: '10px', color: '#ccc', marginTop: '12px', textAlign: 'right' }}>
                                    Generated {receipt.generated_at}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })()}

          </div>
        )}
        {activeTab === 'admin' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '20px' }}>Admin</h2>
            {!adminLoggedIn ? (
              <div>
                <p style={{ textAlign: 'center', marginBottom: '20px', color: '#666' }}>Enter your company seed to access admin features</p>
                <input type="password" placeholder="Company Seed (password)" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={() => { if (adminPassword === process.env.REACT_APP_COMPANY_SEED) { setAdminLoggedIn(true); alert('Admin access granted'); } else { alert('Incorrect seed'); } }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Login
                </button>
              </div>
            ) : (
              <div>
                {/* Admin Sub-Tabs */}
                <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginBottom: '30px' }}>
                  <button onClick={() => setAdminSubTab('fees')} style={{ padding: '10px 30px', borderRadius: '20px', border: '2px solid #D88F2E', background: adminSubTab === 'fees' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'white', color: adminSubTab === 'fees' ? 'white' : '#D88F2E', cursor: 'pointer', fontWeight: 'bold' }}>
                    Fee Dashboard
                  </button>
                  <button onClick={() => setAdminSubTab('credentials')} style={{ padding: '10px 30px', borderRadius: '20px', border: '2px solid #D88F2E', background: adminSubTab === 'credentials' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'white', color: adminSubTab === 'credentials' ? 'white' : '#D88F2E', cursor: 'pointer', fontWeight: 'bold' }}>
                    Domain & Credentials
                  </button>
                  <button onClick={() => {
                    setAdminSubTab('auditLog');
                    if (auditLog.length === 0) {
                      const addr = customerProfile.classicAddress || vendorProfile.classicAddress;
                      if (addr) {
                        setAuditLogLoading(true);
                        scanAuditLog(addr).then(entries => { setAuditLog(entries); setAuditLogLoading(false); }).catch(() => setAuditLogLoading(false));
                      }
                    }
                  }} style={{ padding: '10px 30px', borderRadius: '20px', border: '2px solid #D88F2E', background: adminSubTab === 'auditLog' ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)' : 'white', color: adminSubTab === 'auditLog' ? 'white' : '#D88F2E', cursor: 'pointer', fontWeight: 'bold' }}>
                    Audit Log
                  </button>
                </div>

                {/* Fee Dashboard Sub-Tab */}
                {adminSubTab === 'fees' && (
                  <div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '20px', marginBottom: '40px' }}>
                      <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center' }}>
                        <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Total SC.PO Created</h4>
                        <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>{savedPOs.length}</p>
                      </div>
                      <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center' }}>
                        <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Total Fees Collected</h4>
                        <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>${feeEntries.reduce((sum, fee) => sum + parseFloat(fee.amount.split(' ')[0].replace('$', '') || '0'), 0).toFixed(2)}</p>
                      </div>
                      <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center' }}>
                        <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Unique Customers</h4>
                        <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>{new Set(savedPOs.map(po => po.buyerAddress)).size}</p>
                      </div>
                      <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center' }}>
                        <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Unique Vendors</h4>
                        <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>{new Set(savedPOs.map(po => po.vendorAddress)).size}</p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                      <h3 style={{ color: '#F2B04A', margin: 0 }}>Collected Fees</h3>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <input type="text" placeholder="Search by PO Name or Date" value={feeSearchTerm} onChange={(e) => setFeeSearchTerm(e.target.value)} style={{ padding: '10px', borderRadius: '20px', border: '2px solid #D88F2E', width: '240px' }} />
                        <button disabled={exportLoading} onClick={async () => {
                          const addr = customerProfile.classicAddress || vendorProfile.classicAddress;
                          if (!addr) return alert('No wallet address found');
                          setExportLoading(true);
                          try { const bundle = await buildExportBundle(addr); exportAsJSON(bundle); } catch (e: any) { alert('Export failed: ' + e.message); } finally { setExportLoading(false); }
                        }} style={{ padding: '10px 20px', borderRadius: '20px', border: '2px solid #D88F2E', background: 'white', color: '#D88F2E', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                          {exportLoading ? 'Exporting...' : '⬇ JSON'}
                        </button>
                        <button disabled={exportLoading} onClick={async () => {
                          const addr = customerProfile.classicAddress || vendorProfile.classicAddress;
                          if (!addr) return alert('No wallet address found');
                          setExportLoading(true);
                          try { const bundle = await buildExportBundle(addr); exportAsCSV(bundle); } catch (e: any) { alert('Export failed: ' + e.message); } finally { setExportLoading(false); }
                        }} style={{ padding: '10px 20px', borderRadius: '20px', border: '2px solid #D88F2E', background: 'white', color: '#D88F2E', cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                          {exportLoading ? 'Exporting...' : '⬇ CSV'}
                        </button>
                      </div>
                    </div>
                    {filteredFees.length === 0 ? <p>No fees collected yet</p> : (
                      <div className="scpo-table-wrap"><table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #D88F2E' }}>
                        <thead>
                          <tr style={{ background: '#FFF3E0' }}>
                            <th style={{ padding: '10px' }}>Date</th>
                            <th style={{ padding: '10px' }}>PO Name</th>
                            <th style={{ padding: '10px' }}>Amount</th>
                            <th style={{ padding: '10px' }}>Tx Hash</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredFees.map((entry, i) => (
                            <tr key={i}>
                              <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>{entry.date}</td>
                              <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>{entry.poName}</td>
                              <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>{entry.amount}</td>
                              <td style={{ padding: '10px', border: '1px solid #D88F2E' }}>
                                <a href={`https://devnet.xrpl.org/transactions/${entry.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>{entry.txHash.substring(0, 10)}...</a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table></div>
                    )}
                  </div>
                )}

                {/* Domain & Credentials Sub-Tab */}
                {adminSubTab === 'auditLog' && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                      <h3 style={{ color: '#F2B04A', margin: 0 }}>On-Chain Audit Log</h3>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <select value={auditLogFilter} onChange={e => setAuditLogFilter(e.target.value)} style={{ padding: '10px', borderRadius: '20px', border: '2px solid #D88F2E', minWidth: '180px' }}>
                          <option value=''>All Actions</option>
                          <option value='CREATE_PO'>Create PO</option>
                          <option value='ACCEPT_PO'>Accept PO</option>
                          <option value='FUND_ESCROW'>Fund Escrow</option>
                          <option value='CLAIM_PO'>Claim PO</option>
                          <option value='RECALL_PO'>Recall PO</option>
                          <option value='UPDATE_PO'>Update PO</option>
                          <option value='FEE_PAYMENT'>Fee Payment</option>
                          <option value='LINK_PROFILE'>Link Profile</option>
                        </select>
                        <button onClick={() => {
                          const addr = customerProfile.classicAddress || vendorProfile.classicAddress;
                          if (addr) {
                            setAuditLogLoading(true);
                            scanAuditLog(addr).then(entries => { setAuditLog(entries); setAuditLogLoading(false); }).catch(() => setAuditLogLoading(false));
                          }
                        }} style={{ padding: '10px 20px', borderRadius: '20px', border: '2px solid #D88F2E', background: 'white', color: '#D88F2E', cursor: 'pointer', fontWeight: 'bold' }}>↻ Refresh</button>
                      </div>
                    </div>
                    {auditLogLoading ? <p style={{ textAlign: 'center', color: '#999' }}>Scanning chain...</p> : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #D88F2E' }}>
                        <thead>
                          <tr style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white' }}>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Date</th>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Action</th>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Ref</th>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Account</th>
                            <th style={{ padding: '12px', textAlign: 'left' }}>Tx Hash</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditLog.filter(e => !auditLogFilter || e.action === auditLogFilter).reverse().map((entry, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #FFE0B2', background: i % 2 === 0 ? '#FFFDF8' : 'white' }}>
                              <td style={{ padding: '10px 12px', fontSize: '13px' }}>{entry.date}</td>
                              <td style={{ padding: '10px 12px' }}><span style={{ background: '#FFF3E0', color: '#D88F2E', padding: '3px 10px', borderRadius: '10px', fontSize: '12px', fontWeight: 'bold' }}>{entry.action}</span></td>
                              <td style={{ padding: '10px 12px', fontSize: '12px', fontFamily: 'monospace', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.ref}</td>
                              <td style={{ padding: '10px 12px', fontSize: '12px', fontFamily: 'monospace' }}>{entry.account.slice(0, 8)}...{entry.account.slice(-4)}</td>
                              <td style={{ padding: '10px 12px', fontSize: '12px', fontFamily: 'monospace' }}><a href={`https://devnet.xrpl.org/transactions/${entry.txHash}`} target='_blank' rel='noreferrer' style={{ color: '#D88F2E' }}>{entry.txHash.slice(0, 8)}...</a></td>
                            </tr>
                          ))}
                          {auditLog.filter(e => !auditLogFilter || e.action === auditLogFilter).length === 0 && (
                            <tr><td colSpan={5} style={{ padding: '20px', textAlign: 'center', color: '#999' }}>No audit entries found</td></tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {adminSubTab === 'credentials' && (
                  <div>
                    {/* Permissioned Domain Section */}
                    <h3 style={{ color: '#F2B04A', marginBottom: '20px' }}>Permissioned Domain</h3>
                    {process.env.REACT_APP_DOMAIN_ID ? (
                      <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', marginBottom: '30px' }}>
                        <p style={{ margin: '0 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Domain Active ✓</p>
                        <p style={{ margin: 0, fontSize: '13px', wordBreak: 'break-all', color: '#666' }}>ID: {process.env.REACT_APP_DOMAIN_ID}</p>
                      </div>
                    ) : (
                      <div style={{ marginBottom: '30px' }}>
                        <p style={{ color: '#666', marginBottom: '15px' }}>No Permissioned Domain deployed yet. Deploy one to enable credential-based access control.</p>
                        <button
                          onClick={async () => {
                            try {
                              setDeploying(true);
                              const client = await getXRPLClient();
                              const platformWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED!);
                              const id = await deployPermissionedDomain(client, platformWallet);
                              setDomainID(id);
                              alert(`Domain created! Copy this Domain ID to your .env file as REACT_APP_DOMAIN_ID:\n\n${id}`);
                            } catch (err: any) {
                              console.error('Deploy failed:', err);
                              alert(`Error: ${err.message}`);
                            } finally {
                              setDeploying(false);
                            }
                          }}
                          disabled={deploying}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', borderRadius: '30px', cursor: deploying ? 'not-allowed' : 'pointer', opacity: deploying ? 0.6 : 1 }}
                        >
                          {deploying ? 'Deploying...' : 'Deploy Permissioned Domain'}
                        </button>
                        {domainID && (
                          <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', marginTop: '15px' }}>
                            <p style={{ margin: '0 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Domain Created ✓</p>
                            <p style={{ margin: 0, fontSize: '13px', wordBreak: 'break-all', color: '#666' }}>ID: {domainID}</p>
                            <p style={{ margin: '10px 0 0', fontSize: '12px', color: '#999' }}>Copy the ID above into your .env file as REACT_APP_DOMAIN_ID, then restart the dev server.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Credential Revocation Section */}
                    <div style={{ borderTop: '2px solid #D88F2E', paddingTop: '30px' }}>
                      <h3 style={{ color: '#F2B04A', marginBottom: '20px' }}>Credential Management</h3>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '15px' }}>
                        <input
                          type="text"
                          placeholder="Wallet address to revoke (rXXX...)"
                          value={revokeAddress}
                          onChange={(e) => setRevokeAddress(e.target.value)}
                          style={{ flex: 1, padding: '12px', borderRadius: '20px', border: '2px solid #D88F2E' }}
                        />
                        <button
                          onClick={async () => {
                            if (!revokeAddress) return alert('Enter a wallet address');
                            if (!window.confirm(`Revoke credential for ${revokeAddress}? This will block them from creating or receiving POs.`)) return;
                            try {
                              setRevoking(true);
                              const client = await getXRPLClient();
                              const platformWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED!);
                              await revokeCredential(client, platformWallet, revokeAddress);
                              alert(`Credential revoked for ${revokeAddress}`);
                              setRevokeAddress('');
                            } catch (err: any) {
                              alert(`Revocation failed: ${err.message}`);
                            } finally {
                              setRevoking(false);
                            }
                          }}
                          disabled={revoking}
                          style={{ background: '#E53935', color: 'white', padding: '12px 30px', borderRadius: '20px', cursor: revoking ? 'not-allowed' : 'pointer', opacity: revoking ? 0.6 : 1, border: 'none' }}
                        >
                          {revoking ? 'Revoking...' : 'Revoke Credential'}
                        </button>
                      </div>
                      <p style={{ fontSize: '12px', color: '#999', margin: 0 }}>Revoked wallets will be blocked from issuing or receiving POs. The user can regain access by saving their profile again (which re-issues the credential).</p>
                    </div>

                    {/* Phase 6.0b — Institutional Credential */}
                    <div style={{ borderTop: '2px solid #68D391', paddingTop: '24px', marginTop: '24px' }}>
                      <h3 style={{ color: '#276749', marginBottom: '8px' }}>🏦 Issue Institutional Credential</h3>
                      <p style={{ fontSize: '12px', color: '#666', marginBottom: '14px' }}>
                        Issue to licensed lenders and yield partners only. Grants access to Phase 6 financing features. Complete off-platform identity verification before issuing.
                      </p>
                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '8px' }}>
                        <input
                          type="text"
                          placeholder="Lender / partner wallet address (r...)"
                          value={institutionalCredAddress}
                          onChange={e => setInstitutionalCredAddress(e.target.value)}
                          style={{ flex: 1, padding: '12px', borderRadius: '20px', border: '2px solid #68D391' }}
                        />
                        <button
                          onClick={async () => {
                            if (!institutionalCredAddress) return alert('Enter a wallet address');
                            if (!window.confirm(`Issue Institutional credential to ${institutionalCredAddress}?\n\nOnly proceed after verifying this entity off-platform.`)) return;
                            setInstitutionalCredLoading(true);
                            setInstitutionalCredResult('');
                            try {
                              const client = await getXRPLClient();
                              const platformWallet = xrpl.Wallet.fromSeed(process.env.REACT_APP_COMPANY_SEED!);
                              const result = await issueInstitutionalCredential(client, platformWallet, institutionalCredAddress);
                              setInstitutionalCredResult(`✅ Issued. Tx: ${result.txHash}`);
                              setInstitutionalCredAddress('');
                            } catch (err: any) {
                              setInstitutionalCredResult(`❌ Failed: ${err.message}`);
                            } finally {
                              setInstitutionalCredLoading(false);
                            }
                          }}
                          disabled={institutionalCredLoading}
                          style={{ background: '#276749', color: 'white', padding: '12px 24px', borderRadius: '20px', cursor: institutionalCredLoading ? 'not-allowed' : 'pointer', opacity: institutionalCredLoading ? 0.6 : 1, border: 'none', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                        >
                          {institutionalCredLoading ? 'Issuing...' : 'Issue Credential'}
                        </button>
                      </div>
                      {institutionalCredResult && (
                        <p style={{ fontSize: '12px', color: institutionalCredResult.startsWith('✅') ? '#276749' : '#E53E3E', margin: 0 }}>{institutionalCredResult}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* ===== INVENTORY VERSION HISTORY MODAL (3.4) ===== */}
      {showVersionHistoryModal && versionHistoryItems.length > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowVersionHistoryModal(false)}>
          <div style={{ background: '#FFF9E6', borderRadius: '20px', padding: '30px', width: '90%', maxWidth: '800px', maxHeight: '85vh', overflowY: 'auto', position: 'relative', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowVersionHistoryModal(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '35px', height: '35px', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '5px' }}>Inventory Version History</h2>
            <p style={{ textAlign: 'center', color: '#888', marginBottom: '20px' }}>Part # {versionHistoryPartNumber} — Superseded Version {versionHistoryIndex + 1} of {versionHistoryItems.length}</p>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
              <button onClick={() => setVersionHistoryIndex(Math.max(0, versionHistoryIndex - 1))} disabled={versionHistoryIndex === 0}
                style={{ background: versionHistoryIndex === 0 ? '#ccc' : 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: versionHistoryIndex === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0, marginTop: '4px' }}>◀</button>
              <div style={{ flex: 1 }}>
                {(() => {
                  const item = versionHistoryItems[versionHistoryIndex];
                  if (!item) return null;
                  return (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h3 style={{ color: '#F2B04A', margin: 0 }}>{item.name}</h3>
                        <span style={{ background: '#FF9800', color: 'white', padding: '4px 14px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold' }}>v{item.version || 1} — Superseded</span>
                      </div>
                      <p style={{ textAlign: 'center', color: '#888', marginBottom: '15px', fontSize: '13px' }}>
                        NFT: {item.nftId.substring(0, 16)}...
                        <span style={{ marginLeft: '8px', cursor: 'pointer', color: '#F2B04A' }} onClick={() => { navigator.clipboard.writeText(item.nftId); alert('NFT ID copied!'); }}>📋</span>
                      </p>
                      <div style={{ background: '#FFF3E0', padding: '15px', borderRadius: '15px', marginBottom: '16px' }}>
                        <h3 style={{ color: '#D88F2E', marginTop: 0, marginBottom: '10px' }}>Identity</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Part #:</strong> {item.partNumber}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Name:</strong> {item.name}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Category:</strong> {item.category}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Family Code:</strong> {item.familyCode}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Brand:</strong> {item.productBrand}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Weight:</strong> {item.weight}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Department:</strong> {item.department}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Plant:</strong> {item.productionPlant}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Status:</strong> {item.status}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Qty on Hand:</strong> {item.quantityOnHand} {item.unit}</p>
                          <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Competitive:</strong> {item.competitiveFlag ? 'Yes' : 'No'}</p>
                          <p style={{ margin: 0, fontSize: '12px' }}><strong style={{ color: '#F2B04A' }}>MPT ID:</strong> <span style={{ fontFamily: 'monospace' }}>{item.mptIssuanceId?.substring(0, 16)}...</span></p>
                        </div>
                        <p style={{ margin: '8px 0 0' }}><strong style={{ color: '#F2B04A' }}>Description:</strong> {item.shortDescription}</p>
                      </div>
                      {versionHistoryDocLoading && <p style={{ color: '#F2B04A', textAlign: 'center', padding: '20px', fontStyle: 'italic' }}>Loading full details from IPFS...</p>}
                      {versionHistoryDoc && (
                        <>
                          <div style={{ background: '#F0FFF4', padding: '15px', borderRadius: '15px', marginBottom: '16px', border: '1px solid #C8E6C9' }}>
                            <h3 style={{ color: '#2E7D32', marginTop: 0, marginBottom: '10px' }}>Pricing & Cost</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                              <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>List Price:</strong> ${versionHistoryDoc.pricing.listPrice} {versionHistoryDoc.pricing.currency}</p>
                              <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>Unit Cost:</strong> ${versionHistoryDoc.cost.unitCost} {versionHistoryDoc.cost.currency}</p>
                              <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>Effective:</strong> {versionHistoryDoc.pricing.effectiveDate}</p>
                              <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>Expires:</strong> {versionHistoryDoc.pricing.expiresDate || 'No expiry'}</p>
                            </div>
                            {versionHistoryDoc.pricing.volumeTiers?.length > 0 && (
                              <><p style={{ margin: '10px 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Volume Tiers:</p>
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                                <thead><tr style={{ background: '#C8E6C9' }}><th style={{ padding: '6px', textAlign: 'left' }}>Min Qty</th><th style={{ padding: '6px', textAlign: 'left' }}>Price</th></tr></thead>
                                <tbody>{versionHistoryDoc.pricing.volumeTiers.map((tier, i) => <tr key={i}><td style={{ padding: '6px', borderBottom: '1px solid #E8F5E9' }}>{tier.minQty}+</td><td style={{ padding: '6px', borderBottom: '1px solid #E8F5E9' }}>${tier.price}</td></tr>)}</tbody>
                              </table></>
                            )}
                          </div>
                          <div style={{ background: '#FFF3E0', padding: '15px', borderRadius: '15px', marginBottom: '16px' }}>
                            <h3 style={{ color: '#E65100', marginTop: 0, marginBottom: '5px' }}>Supplier</h3>
                            <p style={{ margin: 0 }}><strong style={{ color: '#E65100' }}>Code:</strong> {versionHistoryDoc.supplierCode || 'N/A'}</p>
                            <p style={{ margin: '5px 0 0' }}><strong style={{ color: '#E65100' }}>Name:</strong> {versionHistoryDoc.supplierName || 'N/A'}</p>
                          </div>
                          {(versionHistoryDoc.attachments?.pricingSheet || versionHistoryDoc.attachments?.designFile || versionHistoryDoc.attachments?.bom || versionHistoryDoc.attachments?.usageGuide) && (
                            <div style={{ background: '#F3E5F5', padding: '15px', borderRadius: '15px', marginBottom: '16px' }}>
                              <h3 style={{ color: '#6A1B9A', marginTop: 0, marginBottom: '10px' }}>Documents</h3>
                              {versionHistoryDoc.attachments.pricingSheet && <DocumentPreview uri={versionHistoryDoc.attachments.pricingSheet.uri} name={versionHistoryDoc.attachments.pricingSheet.name} />}
                              {versionHistoryDoc.attachments.designFile && <DocumentPreview uri={versionHistoryDoc.attachments.designFile.uri} name={versionHistoryDoc.attachments.designFile.name} />}
                              {versionHistoryDoc.attachments.bom && <DocumentPreview uri={versionHistoryDoc.attachments.bom.uri} name={versionHistoryDoc.attachments.bom.name} />}
                              {versionHistoryDoc.attachments.usageGuide && <DocumentPreview uri={versionHistoryDoc.attachments.usageGuide.uri} name={versionHistoryDoc.attachments.usageGuide.name} />}
                            </div>
                          )}
                        </>
                      )}
                      <div style={{ borderTop: '1px solid #D88F2E', paddingTop: '10px', marginTop: '5px' }}>
                        <p style={{ margin: '4px 0', fontSize: '12px', color: '#888' }}><strong style={{ color: '#F2B04A' }}>Superseded by:</strong> next version (see current)</p>
                        <a href={`https://devnet.xrpl.org/nft/${item.nftId}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A', fontSize: '12px' }}>View NFT on XRPL Explorer ↗</a>
                      </div>
                    </>
                  );
                })()}
              </div>
              <button onClick={() => setVersionHistoryIndex(Math.min(versionHistoryItems.length - 1, versionHistoryIndex + 1))} disabled={versionHistoryIndex === versionHistoryItems.length - 1}
                style={{ background: versionHistoryIndex === versionHistoryItems.length - 1 ? '#ccc' : 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: versionHistoryIndex === versionHistoryItems.length - 1 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0, marginTop: '4px' }}>▶</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '15px' }}>
              {versionHistoryItems.map((_, i) => (
                <button key={i} onClick={() => setVersionHistoryIndex(i)}
                  style={{ width: i === versionHistoryIndex ? '24px' : '10px', height: '10px', borderRadius: '5px', border: 'none', background: i === versionHistoryIndex ? '#F2B04A' : '#ddd', cursor: 'pointer', transition: 'all 0.2s', padding: 0 }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== INVENTORY DETAIL MODAL (3.1f) ===== */}
      {showInventoryDetailModal && inventoryDetailItem && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowInventoryDetailModal(false)}>
          <div style={{ background: '#FFF9E6', borderRadius: '20px', padding: '30px', width: '90%', maxWidth: '800px', maxHeight: '85vh', overflowY: 'auto', position: 'relative', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowInventoryDetailModal(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '35px', height: '35px', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '5px' }}>Inventory Details</h2>
            <p style={{ textAlign: 'center', color: '#888', marginBottom: '20px', fontSize: '13px' }}>
              NFT: {inventoryDetailItem.nftId.substring(0, 16)}...
              <span style={{ marginLeft: '8px', cursor: 'pointer', color: '#F2B04A' }} onClick={() => { navigator.clipboard.writeText(inventoryDetailItem.nftId); alert('NFT ID copied!'); }}>📋</span>
            </p>
            {/* Identity */}
            <div style={{ background: '#FFF3E0', padding: '15px', borderRadius: '15px', marginBottom: '20px' }}>
              <h3 style={{ color: '#D88F2E', marginTop: 0, marginBottom: '10px' }}>Identity</h3>
              {/* Task 3.8 — hero image */}
              {inventoryDetailItem.productImageUri && (
                <div style={{ textAlign: 'center', marginBottom: '16px' }}>
                  <ProductImage uri={inventoryDetailItem.productImageUri}
                    name={inventoryDetailItem.name} size={200} />
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '15px' }}>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Part #:</strong> {inventoryDetailItem.partNumber}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Name:</strong> {inventoryDetailItem.name}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Category:</strong> {inventoryDetailItem.category}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Family Code:</strong> {inventoryDetailItem.familyCode}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Brand:</strong> {inventoryDetailItem.productBrand}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Weight:</strong> {inventoryDetailItem.weight}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Department:</strong> {inventoryDetailItem.department}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Plant:</strong> {inventoryDetailItem.productionPlant}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Status:</strong> {inventoryDetailItem.status}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Qty on Hand:</strong> {inventoryDetailItem.quantityOnHand} {inventoryDetailItem.unit}</p>
                <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Competitive:</strong> {inventoryDetailItem.competitiveFlag ? 'Yes' : 'No'}</p>
                <p style={{ margin: 0, fontSize: '12px' }}><strong style={{ color: '#F2B04A' }}>MPT ID:</strong> <span style={{ fontFamily: 'monospace' }}>{inventoryDetailItem.mptIssuanceId.substring(0, 16)}...</span></p>
              </div>
              <p style={{ margin: '8px 0 0' }}><strong style={{ color: '#F2B04A' }}>Description:</strong> {inventoryDetailItem.shortDescription}</p>
            </div>
            {inventoryDetailLoading && <p style={{ color: '#F2B04A', textAlign: 'center', padding: '20px', fontStyle: 'italic' }}>Loading full details from IPFS...</p>}
            {inventoryDetailDoc && (
              <>
                {/* Pricing */}
                <div style={{ background: '#F0FFF4', padding: '15px', borderRadius: '15px', marginBottom: '20px', border: '1px solid #C8E6C9' }}>
                  <h3 style={{ color: '#2E7D32', marginTop: 0, marginBottom: '10px' }}>Pricing & Cost</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>List Price:</strong> ${inventoryDetailDoc.pricing.listPrice} {inventoryDetailDoc.pricing.currency}</p>
                    <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>Unit Cost:</strong> ${inventoryDetailDoc.cost.unitCost} {inventoryDetailDoc.cost.currency}</p>
                    <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>Effective:</strong> {inventoryDetailDoc.pricing.effectiveDate}</p>
                    <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>Expires:</strong> {inventoryDetailDoc.pricing.expiresDate || 'No expiry'}</p>
                  </div>
                  {inventoryDetailDoc.pricing.volumeTiers?.length > 0 && (
                    <><p style={{ margin: '10px 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Volume Tiers:</p>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                      <thead><tr style={{ background: '#C8E6C9' }}><th style={{ padding: '6px', textAlign: 'left' }}>Min Qty</th><th style={{ padding: '6px', textAlign: 'left' }}>Price</th></tr></thead>
                      <tbody>{inventoryDetailDoc.pricing.volumeTiers.map((tier, i) => <tr key={i}><td style={{ padding: '6px', borderBottom: '1px solid #E8F5E9' }}>{tier.minQty}+</td><td style={{ padding: '6px', borderBottom: '1px solid #E8F5E9' }}>${tier.price}</td></tr>)}</tbody>
                    </table></>
                  )}
                </div>
                {/* Supplier */}
                <div style={{ background: '#FFF3E0', padding: '15px', borderRadius: '15px', marginBottom: '20px' }}>
                  <h3 style={{ color: '#E65100', marginTop: 0, marginBottom: '5px' }}>Supplier</h3>
                  <p style={{ margin: 0 }}><strong style={{ color: '#E65100' }}>Code:</strong> {inventoryDetailDoc.supplierCode || 'N/A'}</p>
                  <p style={{ margin: '5px 0 0' }}><strong style={{ color: '#E65100' }}>Name:</strong> {inventoryDetailDoc.supplierName || 'N/A'}</p>
                </div>
                {/* Documents */}
                {(inventoryDetailDoc.attachments?.pricingSheet || inventoryDetailDoc.attachments?.designFile || inventoryDetailDoc.attachments?.bom || inventoryDetailDoc.attachments?.usageGuide) && (
                  <div style={{ background: '#F3E5F5', padding: '15px', borderRadius: '15px', marginBottom: '20px' }}>
                    <h3 style={{ color: '#6A1B9A', marginTop: 0, marginBottom: '10px' }}>Documents</h3>
                    {inventoryDetailDoc.attachments.pricingSheet && <DocumentPreview uri={inventoryDetailDoc.attachments.pricingSheet.uri} name={inventoryDetailDoc.attachments.pricingSheet.name} />}
                    {inventoryDetailDoc.attachments.designFile && <DocumentPreview uri={inventoryDetailDoc.attachments.designFile.uri} name={inventoryDetailDoc.attachments.designFile.name} />}
                    {inventoryDetailDoc.attachments.bom && <DocumentPreview uri={inventoryDetailDoc.attachments.bom.uri} name={inventoryDetailDoc.attachments.bom.name} />}
                    {inventoryDetailDoc.attachments.usageGuide && <DocumentPreview uri={inventoryDetailDoc.attachments.usageGuide.uri} name={inventoryDetailDoc.attachments.usageGuide.name} />}
                  </div>
                )}
              </>
            )}
            {/* ── 3.4 — Full Edit Item section ────────────────────────────── */}
            {inventoryDetailDoc && (
              <div style={{ marginTop: '20px', borderTop: '2px solid #D88F2E', paddingTop: '15px' }}>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '15px' }}>
                  {(() => {
                    // Walk the parent chain from current item to collect all ancestors
                    const historyItems: typeof vendorInventorySuperseded = [];
                    let searchId = inventoryDetailItem?.parentNFTId;
                    while (searchId) {
                      const found = vendorInventorySuperseded.find(s => s.nftId === searchId);
                      if (!found) break;
                      historyItems.push(found);
                      searchId = found.parentNFTId;
                    }
                    const hasHistory = historyItems.length > 0;
                    return (
                      <button
                        disabled={!hasHistory}
                        onClick={() => {
                          if (!hasHistory) return;
                          const history = [...historyItems].sort((a, b) => (a.version || 1) - (b.version || 1));
                          setVersionHistoryItems(history);
                          setVersionHistoryPartNumber(inventoryDetailItem?.partNumber || '');
                          setVersionHistoryIndex(0);
                          setShowVersionHistoryModal(true);
                        }}
                        style={{
                          background: hasHistory ? 'linear-gradient(90deg, #1565C0 0%, #42A5F5 100%)' : '#ccc',
                          color: 'white',
                          padding: '10px 25px',
                          borderRadius: '20px',
                          border: 'none',
                          cursor: hasHistory ? 'pointer' : 'not-allowed',
                          fontWeight: 'bold',
                          opacity: inventoryDetailLoading ? 0.6 : 1,
                        }}
                        title={hasHistory ? `${historyItems.length} previous version(s)` : inventoryDetailLoading ? 'Loading...' : 'No previous versions'}
                      >
                        📋 Version History{hasHistory ? ` (${historyItems.length})` : ''}
                      </button>
                    );
                  })()}
                  <button onClick={() => {
                    setShowEditPricing(!showEditPricing);
                    if (!showEditPricing) {
                      // Populate all fields from current item + doc
                      setEditName(inventoryDetailItem?.name || '');
                    setEditName(inventoryDetailItem?.name || '');
                    setEditPartNumber(inventoryDetailItem?.partNumber || '');
                    setEditShortDesc(inventoryDetailItem?.shortDescription || '');
                    setEditFullDesc(inventoryDetailDoc.fullDescription || '');
                    setEditCategory(inventoryDetailItem?.category || '');
                    setEditFamilyCode(inventoryDetailItem?.familyCode || '');
                    setEditBrand(inventoryDetailItem?.productBrand || '');
                    setEditWeight(inventoryDetailItem?.weight || '');
                    setEditDepartment(inventoryDetailItem?.department || '');
                    setEditPlant(inventoryDetailItem?.productionPlant || '');
                    setEditCompetitiveFlag(inventoryDetailItem?.competitiveFlag || false);
                    setEditStatus(inventoryDetailItem?.status || 'active');
                    setEditUnitPrice(inventoryDetailDoc.pricing.listPrice || '');
                    setEditPriceCurrency(inventoryDetailDoc.pricing.currency || 'USD');
                    setEditEffectiveDate(inventoryDetailDoc.pricing.effectiveDate || '');
                    setEditExpiresDate(inventoryDetailDoc.pricing.expiresDate || '');
                    const tiers = inventoryDetailDoc.pricing.volumeTiers || [];
                    setEditUseVolumeTiers(tiers.length > 0);
                    setEditVolumeTiers(tiers.length > 0
                      ? tiers.map((t, i) => ({ minQty: String(t.minQty), maxQty: i < tiers.length - 1 ? '' : '', price: t.price }))
                      : [{ minQty: '1', maxQty: '', price: '' }, { minQty: '', maxQty: '', price: '' }]
                    );
                    setEditUnitCost(inventoryDetailDoc.cost.unitCost || '');
                    setEditCostCurrency(inventoryDetailDoc.cost.currency || 'USD');
                    setEditSupplierCode(inventoryDetailDoc.supplierCode || '');
                    setEditSupplierName(inventoryDetailDoc.supplierName || '');
                    setEditPricingResult('');
                  }
                }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 25px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold', display: 'block', margin: '0 auto 15px auto' }}>
                    {showEditPricing ? '▲ Cancel Edit' : '✏ Edit Item'}
                  </button>
                </div>
                {showEditPricing && (
                  <div style={{ background: '#F0FFF4', border: '1px solid #C8E6C9', borderRadius: '15px', padding: '20px' }}>
                    <h4 style={{ color: '#2E7D32', marginTop: 0 }}>Edit Inventory Item</h4>
                    <p style={{ fontSize: '12px', color: '#888', marginTop: 0 }}>All changes mint a new NFT version on-chain. Old version preserved as history.</p>

                    {/* Task 3.8 — edit product image */}
                    <h5 style={{ color: '#2E7D32', marginBottom: '8px', marginTop: '0' }}>Product Image</h5>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
                      <ProductImage
                        uri={editImageFile ? undefined : inventoryDetailItem?.productImageUri}
                        name={inventoryDetailItem?.name || ''}
                        size={72}
                      />
                      {editImageFile && (
                        <img src={URL.createObjectURL(editImageFile)} alt="new preview"
                          style={{ width: '72px', height: '72px', objectFit: 'cover',
                            borderRadius: '8px', border: '2px solid #4CAF50' }} />
                      )}
                      <div style={{ flex: 1 }}>
                        <label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>
                          {inventoryDetailItem?.productImageUri ? 'Replace Image' : 'Upload Image'}
                        </label>
                        <input type="file" accept="image/*"
                          onChange={(e) => setEditImageFile(e.target.files?.[0] || null)}
                          style={{ fontSize: '12px' }} />
                      </div>
                    </div>
                    <h5 style={{ color: '#2E7D32', marginBottom: '8px', marginTop: '12px' }}>Identity</h5>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Part Number</label><input value={editPartNumber} onChange={e => setEditPartNumber(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Name</label><input value={editName} onChange={e => setEditName(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Short Description</label><input value={editShortDesc} onChange={e => setEditShortDesc(e.target.value.substring(0, 60))} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Status</label><select value={editStatus} onChange={e => setEditStatus(e.target.value as ItemStatus)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9', background: 'white' }}><option value="active">Active</option><option value="discontinued">Discontinued</option><option value="out_of_stock">Out of Stock</option></select></div>
                    </div>
                    <div style={{ marginBottom: '10px' }}><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Full Description</label><textarea value={editFullDesc} onChange={e => setEditFullDesc(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9', height: '60px' }} /></div>

                    <h5 style={{ color: '#2E7D32', marginBottom: '8px', marginTop: '12px' }}>Classification</h5>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Category</label><input value={editCategory} onChange={e => setEditCategory(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Family Code</label><input value={editFamilyCode} onChange={e => setEditFamilyCode(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Brand</label><input value={editBrand} onChange={e => setEditBrand(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Weight</label><input value={editWeight} onChange={e => setEditWeight(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Department</label><input value={editDepartment} onChange={e => setEditDepartment(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Production Plant</label><input value={editPlant} onChange={e => setEditPlant(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32', cursor: 'pointer' }}>
                      <input type="checkbox" checked={editCompetitiveFlag} onChange={e => setEditCompetitiveFlag(e.target.checked)} style={{ width: '15px', height: '15px' }} />
                      Competitive / Restricted Item
                    </label>

                    <h5 style={{ color: '#2E7D32', marginBottom: '8px', marginTop: '12px' }}>Pricing <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '11px' }}>(customer-visible)</span></h5>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>List Price ($)</label><input value={editUnitPrice} onChange={e => setEditUnitPrice(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Currency</label><input value={editPriceCurrency} onChange={e => setEditPriceCurrency(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Effective Date</label><input type="date" value={editEffectiveDate} onChange={e => setEditEffectiveDate(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Expires Date</label><input type="date" value={editExpiresDate} onChange={e => setEditExpiresDate(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32', cursor: 'pointer' }}>
                      <input type="checkbox" checked={editUseVolumeTiers} onChange={e => setEditUseVolumeTiers(e.target.checked)} style={{ width: '15px', height: '15px' }} />
                      Enable Volume Pricing
                    </label>
                    {editUseVolumeTiers && (
                      <div style={{ marginBottom: '10px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginBottom: '6px' }}>
                          <thead><tr style={{ background: '#C8E6C9' }}><th style={{ padding: '5px', textAlign: 'left' }}>Min Qty</th><th style={{ padding: '5px', textAlign: 'left' }}>Max Qty</th><th style={{ padding: '5px', textAlign: 'left' }}>Price ($)</th><th style={{ padding: '5px', textAlign: 'center' }}>✕</th></tr></thead>
                          <tbody>
                            {editVolumeTiers.map((tier, i) => (
                              <tr key={i} style={{ borderBottom: '1px solid #E8F5E9' }}>
                                <td style={{ padding: '3px' }}><input value={tier.minQty} onChange={e => { const u = [...editVolumeTiers]; u[i] = { ...u[i], minQty: e.target.value }; setEditVolumeTiers(u); }} style={{ width: '65px', padding: '5px', borderRadius: '12px', border: '1px solid #C8E6C9' }} /></td>
                                <td style={{ padding: '3px' }}>{i === editVolumeTiers.length - 1 ? <span style={{ color: '#aaa', fontSize: '11px', paddingLeft: '6px' }}>∞</span> : <input value={tier.maxQty} onChange={e => { const u = [...editVolumeTiers]; u[i] = { ...u[i], maxQty: e.target.value }; setEditVolumeTiers(u); }} style={{ width: '65px', padding: '5px', borderRadius: '12px', border: '1px solid #C8E6C9' }} />}</td>
                                <td style={{ padding: '3px' }}><input value={tier.price} onChange={e => { const u = [...editVolumeTiers]; u[i] = { ...u[i], price: e.target.value }; setEditVolumeTiers(u); }} style={{ width: '80px', padding: '5px', borderRadius: '12px', border: '1px solid #C8E6C9' }} /></td>
                                <td style={{ padding: '3px', textAlign: 'center' }}>{editVolumeTiers.length > 2 && <button onClick={() => setEditVolumeTiers(editVolumeTiers.filter((_, idx) => idx !== i))} style={{ background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '22px', height: '22px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>×</button>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <button onClick={() => setEditVolumeTiers([...editVolumeTiers, { minQty: '', maxQty: '', price: '' }])} style={{ background: '#2E7D32', color: 'white', padding: '4px 14px', borderRadius: '12px', border: 'none', cursor: 'pointer', fontSize: '11px' }}>+ Add Tier</button>
                      </div>
                    )}

                    <h5 style={{ color: '#2E7D32', marginBottom: '8px', marginTop: '12px' }}>Cost <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '11px' }}>(vendor-only)</span></h5>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Unit Cost ($)</label><input value={editUnitCost} onChange={e => setEditUnitCost(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Cost Currency</label><input value={editCostCurrency} onChange={e => setEditCostCurrency(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                    </div>

                    <h5 style={{ color: '#2E7D32', marginBottom: '8px', marginTop: '12px' }}>Supplier <span style={{ fontWeight: 'normal', color: '#aaa', fontSize: '11px' }}>(vendor-only)</span></h5>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Supplier Code</label><input value={editSupplierCode} onChange={e => setEditSupplierCode(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                      <div><label style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 'bold', color: '#2E7D32' }}>Supplier Name</label><input value={editSupplierName} onChange={e => setEditSupplierName(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '15px', border: '1px solid #C8E6C9' }} /></div>
                    </div>

                    <button disabled={editPricingSaving} onClick={async () => {
                      if (!editName) return alert('Name is required');
                      if (!editUnitPrice || parseFloat(editUnitPrice) <= 0) return alert('List price must be greater than 0');
                      if (editUseVolumeTiers) {
                        const filled = editVolumeTiers.filter(t => t.minQty && t.price);
                        if (filled.length < 2) return alert('Volume pricing requires at least 2 tiers.');
                        if (parseInt(filled[0].minQty) !== 1) return alert('First tier must start at Min Qty = 1.');
                      }
                      if (!window.confirm('This will mint a new NFT version on-chain with all changes. The old NFT remains as version history. Continue?')) return;
                      setEditPricingSaving(true);
                      try {
                        const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
                        const client = await getXRPLClient();
                        const todayStr = new Date().toISOString().split('T')[0];
                        const now = Math.floor(Date.now() / 1000);
                        const newVersion = (inventoryDetailDoc!.version || 1) + 1;
                        const newTiers = editUseVolumeTiers
                          ? editVolumeTiers.filter(t => t.minQty && t.price).map(t => ({ minQty: parseInt(t.minQty), price: t.price }))
                          : [];
                        setEditPricingResult('Step 1/3: Uploading updated data to IPFS...');
                        // Task 3.8 — upload replacement image if provided, otherwise keep existing
                        const editedImageAttachment = editImageFile
                          ? { name: editImageFile.name, uri: await uploadFileToIPFS(editImageFile) }
                          : inventoryDetailDoc!.attachments?.productImage;
                        const updatedVendorDoc: VendorInventoryDoc = {
                          ...inventoryDetailDoc!,
                          partNumber: editPartNumber,
                          partName: editName,
                          fullDescription: editFullDesc,
                          category: editCategory,
                          familyCode: editFamilyCode,
                          productBrand: editBrand,
                          department: editDepartment,
                          productionPlant: editPlant,
                          weight: editWeight,
                          competitiveFlag: editCompetitiveFlag,
                          status: editStatus,
                          cost: { unitCost: editUnitCost, currency: editCostCurrency, costBreaks: inventoryDetailDoc!.cost.costBreaks || [] },
                          pricing: { listPrice: editUnitPrice, currency: editPriceCurrency, volumeTiers: newTiers, effectiveDate: editEffectiveDate, expiresDate: editExpiresDate },
                          supplierCode: editSupplierCode,
                          supplierName: editSupplierName,
                          attachments: {
                            ...inventoryDetailDoc!.attachments,
                            productImage: editedImageAttachment, // Task 3.8
                          },
                          updatedAt: now,
                          lastUpdated: todayStr,
                          version: newVersion,
                          nftId: '',
                        };
                        const updatedSharedDoc: SharedInventoryDoc = {
                          partNumber: editPartNumber,
                          partName: editName,
                          description: editShortDesc,
                          category: editCategory,
                          productBrand: editBrand,
                          weight: editWeight,
                          productImageUri: editedImageAttachment?.uri, // Task 3.8
                          pricing: { unitPrice: editUnitPrice, currency: editPriceCurrency, volumeTiers: newTiers, effectiveDate: editEffectiveDate, expiresDate: editExpiresDate },
                          usageDocuments: inventoryDetailDoc!.attachments?.usageGuide ? [inventoryDetailDoc!.attachments.usageGuide] : [],
                          nftId: '',
                          version: newVersion,
                        };
                        const newVendorUri = await uploadVendorInventoryDoc(updatedVendorDoc, wallet);
                        const newSharedUri = await uploadSharedInventoryDoc(updatedSharedDoc, wallet);
                        setEditPricingResult('Step 2/3: Minting updated NFT on XRPL...');
                        const oldNFTId = inventoryDetailItem!.nftId;
                        const newNFTMeta: InventoryNFTMeta = {
                          t: INV_META_TYPE,
                          pn: editPartNumber,
                          nm: editName,
                          desc: editShortDesc,
                          cat: editCategory,
                          fc: editFamilyCode,
                          brand: editBrand,
                          cf: editCompetitiveFlag,
                          wt: editWeight,
                          dept: editDepartment,
                          plant: editPlant,
                          st: editStatus,
                          tm: inventoryDetailItem!.trackingMode,
                          parent: oldNFTId,
                          v: newVersion,
                          vu: newVendorUri,
                          su: newSharedUri,
                        };
                        // Preserve the existing MPT issuance ID and qty from the old item
                        // The MPT issuance is not re-created on version updates — same token tracks qty
                        const preservedMptIssuanceId = inventoryDetailItem!.mptIssuanceId;
                        const preservedQty = inventoryDetailItem!.quantityOnHand;
                        const preservedUnit = inventoryDetailItem!.unit;
                        const mintTx: any = {
                          TransactionType: 'NFTokenMint',
                          Account: wallet.classicAddress,
                          URI: xrpl.convertStringToHex(newVendorUri),
                          Flags: 8,
                          NFTokenTaxon: INV_NFT_TAXON,
                          Memos: [{ Memo: { MemoType: xrpl.convertStringToHex(INV_MEMO_TYPE), MemoData: xrpl.convertStringToHex(JSON.stringify(newNFTMeta)) } }],
                        };
                        const prepared = await client.autofill(mintTx);
                        const signed = wallet.sign(prepared);
                        const mintResult = await submitBlobQueued(signed.tx_blob);
                        if (typeof mintResult.result.meta === 'object' && mintResult.result.meta.TransactionResult !== 'tesSUCCESS') {
                          setEditPricingResult(`❌ NFT mint failed: ${mintResult.result.meta.TransactionResult}`);
                          return;
                        }
                        const newNFTId = extractNFTokenID(mintResult.result.meta) || 'unknown';
                        setEditPricingResult('Step 3/3: Finalizing on IPFS...');
                        updatedVendorDoc.nftId = newNFTId;
                        updatedSharedDoc.nftId = newNFTId;
                        await uploadVendorInventoryDoc(updatedVendorDoc, wallet);
                        await uploadSharedInventoryDoc(updatedSharedDoc, wallet);
                       // Wait for devnet to index the new NFT memo before fetching
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        const refreshedItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, wallet);
                        const allItems = await fetchVendorInventoryV2(vendorProfile.classicAddress, wallet, true);
                        // Patch the new item with preserved qty and pricing in case IPFS
                        // propagation is slow and vendorDoc came back null during refresh
                        const patchedItems = refreshedItems.map(i => {
                          if (i.nftId !== newNFTId) return i;
                          return {
                            ...i,
                            mptIssuanceId: i.mptIssuanceId || preservedMptIssuanceId,
                            quantityOnHand: i.quantityOnHand > 0 ? i.quantityOnHand : preservedQty,
                            unit: i.unit || preservedUnit,
                            listPrice: i.listPrice > 0 ? i.listPrice : parseFloat(editUnitPrice) || 0,
                            unitCost: i.unitCost > 0 ? i.unitCost : parseFloat(editUnitCost) || 0,
                            pricingCurrency: i.pricingCurrency || editPriceCurrency || 'USD',
                            productImageUri: i.productImageUri || editedImageAttachment?.uri, // Task 3.8
                          };
                        });
                        setVendorInventoryV2(patchedItems);
                        setVendorInventorySuperseded(allItems.filter(i => !patchedItems.find(a => a.nftId === i.nftId)));
                        const refreshed = patchedItems.find(i => i.nftId === newNFTId);
                        if (refreshed) setInventoryDetailItem(refreshed);
                        setInventoryDetailDoc({ ...updatedVendorDoc, nftId: newNFTId });
                        setEditPricingResult(`✅ Version ${newVersion} minted!\nNew NFT: ${newNFTId}\nParent: ${oldNFTId}`);
                        setShowEditPricing(false);
                        setEditImageFile(null); // Task 3.8
                      } catch (err: any) {
                        setEditPricingResult(`❌ Failed: ${err.message}`);
                      } finally {
                        setEditPricingSaving(false);
                      }
                    }} style={{ background: editPricingSaving ? '#aaa' : 'linear-gradient(90deg, #2E7D32 0%, #4CAF50 100%)', color: 'white', padding: '10px 30px', borderRadius: '20px', border: 'none', cursor: editPricingSaving ? 'not-allowed' : 'pointer', fontWeight: 'bold', display: 'block', margin: '10px auto 0 auto' }}>
                      {editPricingSaving ? 'Minting new version...' : 'Save Changes (Mint New Version)'}
                    </button>
                    {editPricingResult && <pre style={{ background: '#f0f0f0', padding: '10px', borderRadius: '10px', fontSize: '12px', whiteSpace: 'pre-wrap', marginTop: '10px' }}>{editPricingResult}</pre>}
                  </div>
                )}
              </div>
            )}
            <div style={{ textAlign: 'center', marginTop: '10px' }}>
              <a href={`https://devnet.xrpl.org/nft/${inventoryDetailItem?.nftId}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A', fontSize: '13px' }}>View NFT on XRPL Explorer ↗</a>
            </div>
          </div>
        </div>
      )}

      {/* ===== PO INVENTORY MODAL (3.1g) ===== */}
      {showPOInventoryModal && poInventoryModalItems.length > 0 && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowPOInventoryModal(false)}>
          <div style={{ background: '#FFF9E6', borderRadius: '20px', padding: '30px', width: '90%', maxWidth: '800px', maxHeight: '85vh', overflowY: 'auto', position: 'relative', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowPOInventoryModal(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '35px', height: '35px', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '5px' }}>PO Inventory</h2>
            <p style={{ textAlign: 'center', color: '#888', marginBottom: '20px' }}>Item {poInventoryModalIndex + 1} of {poInventoryModalItems.length}</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button onClick={() => setPoInventoryModalIndex(Math.max(0, poInventoryModalIndex - 1))} disabled={poInventoryModalIndex === 0}
                style={{ background: poInventoryModalIndex === 0 ? '#ccc' : 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: poInventoryModalIndex === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0 }}>◀</button>
              <div style={{ flex: 1, margin: '0 20px' }}>
                {(() => {
                  const slot = poInventoryModalItems[poInventoryModalIndex];
                  if (!slot) return null;
                  const { item, invItem, vendorDoc, sharedDoc, loading } = slot;
                  return (
                    <div style={{ border: '2px solid #D88F2E', borderRadius: '15px', padding: '20px', background: '#f9f9f9' }}>
                      <h3 style={{ color: '#F2B04A', marginTop: 0 }}>{item.num}</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                        <div style={{ background: '#FFF3E0', padding: '10px', borderRadius: '10px', textAlign: 'center' }}>
                          <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>Qty Ordered</p>
                          <p style={{ margin: 0, fontSize: '20px', fontWeight: 'bold', color: '#F2B04A' }}>{item.qty}</p>
                        </div>
                        <div style={{ background: '#FFF3E0', padding: '10px', borderRadius: '10px', textAlign: 'center' }}>
                          <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>Unit Price</p>
                          <p style={{ margin: 0, fontSize: '20px', fontWeight: 'bold', color: '#F2B04A' }}>
                            ${item.qty && item.total ? (parseFloat(item.total) / parseFloat(item.qty)).toFixed(2) : 'N/A'}
                          </p>
                        </div>
                        <div style={{ background: '#FFF3E0', padding: '10px', borderRadius: '10px', textAlign: 'center' }}>
                          <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>Total Value</p>
                          <p style={{ margin: 0, fontSize: '20px', fontWeight: 'bold', color: '#F2B04A' }}>${item.total}</p>
                        </div>
                      </div>
                      {loading && <p style={{ color: '#F2B04A', textAlign: 'center', fontStyle: 'italic' }}>Loading inventory details...</p>}
                      {!loading && !invItem && <p style={{ color: '#888', textAlign: 'center', fontStyle: 'italic' }}>No catalog entry found for this item</p>}
                      {!loading && invItem && (
                        <>
                          <div style={{ background: '#FFF3E0', padding: '12px', borderRadius: '10px', marginBottom: '12px' }}>
                            <p style={{ margin: 0 }}><strong style={{ color: '#F2B04A' }}>Part #:</strong> {invItem.partNumber}</p>
                            <p style={{ margin: '4px 0 0' }}><strong style={{ color: '#F2B04A' }}>Description:</strong> {invItem.shortDescription}</p>
                            <p style={{ margin: '4px 0 0' }}><strong style={{ color: '#F2B04A' }}>Category:</strong> {invItem.category}</p>
                            <p style={{ margin: '4px 0 0' }}><strong style={{ color: '#F2B04A' }}>Brand:</strong> {invItem.productBrand}</p>
                          </div>
                          {mode === 'customer' && sharedDoc && (
                            <div style={{ background: '#F0FFF4', padding: '12px', borderRadius: '10px', marginBottom: '12px', border: '1px solid #C8E6C9' }}>
                              <p style={{ margin: '0 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Catalog Pricing</p>
                              <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>List Price:</strong> ${sharedDoc.pricing?.unitPrice} {sharedDoc.pricing?.currency}</p>
                              {sharedDoc.usageDocuments?.length > 0 && (
                                <><p style={{ margin: '10px 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Documents:</p>
                                {sharedDoc.usageDocuments.map((doc, di) => <DocumentPreview key={di} uri={doc.uri} name={doc.name} />)}</>
                              )}
                            </div>
                          )}
                          {mode === 'vendor' && vendorDoc && (
                            <>
                              <div style={{ background: '#F0FFF4', padding: '12px', borderRadius: '10px', marginBottom: '12px', border: '1px solid #C8E6C9' }}>
                                <p style={{ margin: '0 0 5px', fontWeight: 'bold', color: '#2E7D32' }}>Pricing & Cost</p>
                                <p style={{ margin: 0 }}><strong style={{ color: '#2E7D32' }}>List Price:</strong> ${vendorDoc.pricing.listPrice} {vendorDoc.pricing.currency}</p>
                                <p style={{ margin: '4px 0 0' }}><strong style={{ color: '#2E7D32' }}>Unit Cost:</strong> ${vendorDoc.cost.unitCost} — Margin: ${(parseFloat(vendorDoc.pricing.listPrice) - parseFloat(vendorDoc.cost.unitCost)).toFixed(2)} ({(((parseFloat(vendorDoc.pricing.listPrice) - parseFloat(vendorDoc.cost.unitCost)) / parseFloat(vendorDoc.pricing.listPrice)) * 100).toFixed(1)}%)</p>
                              </div>
                              <div style={{ background: '#FFF3E0', padding: '12px', borderRadius: '10px', marginBottom: '12px' }}>
                                <p style={{ margin: 0, fontWeight: 'bold', color: '#E65100' }}>Supplier: {vendorDoc.supplierName || 'N/A'} <span style={{ fontWeight: 'normal', fontSize: '13px' }}>({vendorDoc.supplierCode || 'N/A'})</span></p>
                              </div>
                              {(vendorDoc.attachments?.usageGuide || vendorDoc.attachments?.designFile || vendorDoc.attachments?.bom) && (
                                <div style={{ background: '#F3E5F5', padding: '12px', borderRadius: '10px', marginBottom: '12px' }}>
                                  <p style={{ margin: '0 0 8px', fontWeight: 'bold', color: '#6A1B9A' }}>Documents:</p>
                                  {vendorDoc.attachments.usageGuide && <DocumentPreview uri={vendorDoc.attachments.usageGuide.uri} name={vendorDoc.attachments.usageGuide.name} />}
                                  {vendorDoc.attachments.designFile && <DocumentPreview uri={vendorDoc.attachments.designFile.uri} name={vendorDoc.attachments.designFile.name} />}
                                  {vendorDoc.attachments.bom && <DocumentPreview uri={vendorDoc.attachments.bom.uri} name={vendorDoc.attachments.bom.name} />}
                                </div>
                              )}
                            </>
                          )}
                          </>
                      )}
                    </div>
                  );
                })()}
              </div>
              <button onClick={() => setPoInventoryModalIndex(Math.min(poInventoryModalItems.length - 1, poInventoryModalIndex + 1))} disabled={poInventoryModalIndex === poInventoryModalItems.length - 1}
                style={{ background: poInventoryModalIndex === poInventoryModalItems.length - 1 ? '#ccc' : 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: poInventoryModalIndex === poInventoryModalItems.length - 1 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0 }}>▶</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '15px' }}>
              {poInventoryModalItems.map((_, i) => (
                <button key={i} onClick={() => setPoInventoryModalIndex(i)}
                  style={{ width: i === poInventoryModalIndex ? '24px' : '10px', height: '10px', borderRadius: '5px', border: 'none', background: i === poInventoryModalIndex ? '#F2B04A' : '#ddd', cursor: 'pointer', transition: 'all 0.2s', padding: 0 }} />
              ))}
            </div>
          </div>
        </div>
      )}
      {/* ===== HISTORY MODAL ===== */}
        {showHistoryModal && historyModalVersions.length > 0 && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowHistoryModal(false)}>
            <div style={{ background: '#FFF9E6', borderRadius: '20px', padding: '30px', width: '90%', maxWidth: '800px', maxHeight: '85vh', overflowY: 'auto', position: 'relative', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setShowHistoryModal(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '35px', height: '35px', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
              <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '5px' }}>PO Version History</h2>
              <p style={{ textAlign: 'center', color: '#888', marginBottom: '20px' }}>Version {historyModalIndex + 1} of {historyModalVersions.length}</p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                <button onClick={() => setHistoryModalIndex(Math.max(0, historyModalIndex - 1))} disabled={historyModalIndex === 0} style={{ background: historyModalIndex === 0 ? '#ccc' : 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: historyModalIndex === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0 }}>◀</button>
                <div style={{ flex: 1, margin: '0 20px' }}>
                  {(() => {
                    const version = historyModalVersions[historyModalIndex];
                    if (!version) return null;
                    const isLatest = historyModalIndex === historyModalVersions.length - 1;
                    return (
                      <div style={{ border: '2px solid #D88F2E', borderRadius: '15px', padding: '20px', background: isLatest ? '#f0fff0' : '#f9f9f9' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                          <h3 style={{ color: '#F2B04A', margin: 0 }}>{version.po.poName}</h3>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            {isLatest && <span style={{ background: '#4CAF50', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px' }}>Current</span>}
                            <span style={{ background: version.po.status === 'superseded' ? '#ff9800' : '#2196F3', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px' }}>{version.po.status}</span>
                          </div>
                        </div>
                        <p style={{ color: '#666', fontSize: '13px', margin: '0 0 10px' }}>Issuance: {version.po.issuanceId?.substring(0, 16)}...</p>
                        <p><strong style={{ color: '#F2B04A' }}>Total:</strong> ${version.po.total}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Payment Terms:</strong> {version.po.paymentTerms || 'N/A'}</p>
                        <p><strong style={{ color: '#F2B04A' }}>Escrow Currency:</strong> {(version.po.escrowCurrency || version.poData?.escrowCurrency) === 'RLUSD' ? '💵 RLUSD (1:1 USD)' : '⚡ XRP'}</p>
                        {version.loading ? (
                          <p style={{ color: '#F2B04A', fontStyle: 'italic', textAlign: 'center', padding: '20px' }}>Loading PO details from IPFS...</p>
                        ) : version.poData ? (
                          <>
                            <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {version.poData.description || 'N/A'}</p>
                            <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {version.poData.department}</p>
                            <p><strong style={{ color: '#F2B04A' }}>Delivery Terms:</strong> {version.poData.deliveryTerms}</p>
                            <h4 style={{ color: '#F2B04A', marginTop: '15px' }}>Items</h4>
                            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                              <thead>
                                <tr style={{ background: '#e0e0e0' }}>
                                  <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Item #</th>
                                  <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Qty</th>
                                  <th style={{ padding: '8px', border: '1px solid #D88F2E' }}>Total $</th>
                                </tr>
                              </thead>
                              <tbody>
                                {version.poData.items.map((item, i) => (
                                  <tr key={i}>
                                    <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.num}</td>
                                    <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>{item.qty}</td>
                                    <td style={{ padding: '8px', border: '1px solid #D88F2E' }}>${item.total}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {version.poData.attachments && version.poData.attachments.length > 0 && (
                              <>
                                <h4 style={{ marginTop: '15px', color: '#F2B04A' }}>Attachments</h4>
                                <ul>
                                  {version.poData.attachments.map((att, i) => (
                                    <li key={i}>
                                      <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                                        {att.name}
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </>
                        ) : (
                          <p style={{ color: '#999', fontStyle: 'italic' }}>PO details unavailable</p>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <button onClick={() => setHistoryModalIndex(Math.min(historyModalVersions.length - 1, historyModalIndex + 1))} disabled={historyModalIndex === historyModalVersions.length - 1} style={{ background: historyModalIndex === historyModalVersions.length - 1 ? '#ccc' : 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: historyModalIndex === historyModalVersions.length - 1 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0 }}>▶</button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '10px' }}>
                {historyModalVersions.map((_, i) => (
                  <button key={i} onClick={() => setHistoryModalIndex(i)} style={{ width: i === historyModalIndex ? '24px' : '10px', height: '10px', borderRadius: '5px', border: 'none', background: i === historyModalIndex ? '#F2B04A' : '#ddd', cursor: 'pointer', transition: 'all 0.2s', padding: 0 }} />
                ))}
              </div>
            </div>
          </div>
        )}
        {/* ===== PROFILES MODAL (Arrow Navigation) ===== */}
        {showProfilesModal && profilesModalPO && (() => {
          const profiles = [
            { label: 'Customer (Buyer)', address: profilesModalPO.buyerAddress, profile: getProfileForAddress(profilesModalPO.buyerAddress) },
            { label: 'Vendor', address: profilesModalPO.vendorAddress, profile: getProfileForAddress(profilesModalPO.vendorAddress) }
          ];
          const current = profiles[profilesModalIndex] || profiles[0];
          return (
            <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowProfilesModal(false)}>
              <div style={{ background: '#FFF9E6', borderRadius: '20px', padding: '30px', width: '90%', maxWidth: '800px', maxHeight: '85vh', overflowY: 'auto', position: 'relative', boxShadow: '0 10px 40px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setShowProfilesModal(false)} style={{ position: 'absolute', top: '15px', right: '15px', background: '#e74c3c', color: 'white', border: 'none', borderRadius: '50%', width: '35px', height: '35px', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
                <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '5px' }}>PO Profile Details</h2>
                <p style={{ textAlign: 'center', color: '#888', marginBottom: '20px' }}>{current.label} — {profilesModalIndex + 1} of {profiles.length}</p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                  <button onClick={() => setProfilesModalIndex(Math.max(0, profilesModalIndex - 1))} disabled={profilesModalIndex === 0} style={{ background: profilesModalIndex === 0 ? '#ccc' : 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: profilesModalIndex === 0 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0 }}>◀</button>
                  <div style={{ flex: 1, margin: '0 20px' }}>
                    <div style={{ border: '2px solid #D88F2E', borderRadius: '15px', padding: '20px', background: profilesModalIndex === 0 ? '#f0fff0' : '#fff0f0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                        <h3 style={{ color: '#F2B04A', margin: 0 }}>{current.label}</h3>
                        <span style={{ background: profilesModalIndex === 0 ? '#4CAF50' : '#2196F3', color: 'white', padding: '4px 12px', borderRadius: '12px', fontSize: '12px' }}>{profilesModalIndex === 0 ? 'Buyer' : 'Seller'}</span>
                      </div>
                      {current.profile ? (
                        <>
                          <p><strong style={{ color: '#F2B04A' }}>Company:</strong> {current.profile.company || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>Unique ID:</strong> {current.profile.uniqueID || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>Contact:</strong> {current.profile.name || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>Email:</strong> {current.profile.email || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>Phone:</strong> {current.profile.phone || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>Address:</strong> {current.profile.address || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>City:</strong> {current.profile.city || 'N/A'}, {current.profile.state || 'N/A'} {current.profile.zip || 'N/A'}</p>
                          <p><strong style={{ color: '#F2B04A' }}>Country:</strong> {current.profile.country || 'N/A'}</p>
                          <p style={{ fontSize: '13px', wordBreak: 'break-all', marginTop: '10px' }}><strong style={{ color: '#F2B04A' }}>Wallet:</strong> {current.profile.classicAddress}</p>
                        </>
                      ) : (
                        <>
                          <p style={{ color: '#999', fontStyle: 'italic' }}>Profile not linked</p>
                          <p style={{ fontSize: '13px', wordBreak: 'break-all' }}><strong style={{ color: '#F2B04A' }}>Wallet:</strong> {current.address}</p>
                        </>
                      )}
                    </div>
                  </div>
                  <button onClick={() => setProfilesModalIndex(Math.min(profiles.length - 1, profilesModalIndex + 1))} disabled={profilesModalIndex === profiles.length - 1} style={{ background: profilesModalIndex === profiles.length - 1 ? '#ccc' : 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', border: 'none', borderRadius: '50%', width: '50px', height: '50px', fontSize: '24px', cursor: profilesModalIndex === profiles.length - 1 ? 'not-allowed' : 'pointer', fontWeight: 'bold', flexShrink: 0 }}>▶</button>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', marginTop: '10px' }}>
                  {profiles.map((_, i) => (
                    <button key={i} onClick={() => setProfilesModalIndex(i)} style={{ width: i === profilesModalIndex ? '24px' : '10px', height: '10px', borderRadius: '5px', border: 'none', background: i === profilesModalIndex ? '#2196F3' : '#ddd', cursor: 'pointer', transition: 'all 0.2s', padding: 0 }} />
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
