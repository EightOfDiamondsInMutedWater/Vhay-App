import React, { useState, useEffect, useRef } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, EscrowFinish, Payment, AccountSet, Transaction, Memo, AccountTxResponse, AccountInfoResponse, AccountNFTsResponse, AccountNFToken } from 'xrpl';
import CryptoJS from 'crypto-js';
import { x25519 } from '@noble/curves/ed25519';
import { edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/curves/abstract/utils';
import { v4 as uuidv4 } from 'uuid';
import { QRCodeSVG } from 'qrcode.react';
import { 
  getMyMPTs, getMyEscrows, getAccountNFTs, getLatestProfileFromAddress, 
  getXRPLClient, getBuyerPOs, getVendorAuthorizedPOs, getEscrowsForPO,
  deployPermissionedDomain, issueCredential, acceptCredential,
  validateCredential, canCreatePO, revokeCredential, checkAndRenewCredential , isRLUSDConfigured, canUseRLUSDEscrow, setupRLUSDTrustLine, getRLUSDBalance, getRLUSDCurrency,
} from './utils/xrplHelpers';
console.log('xrpl version loaded:', require('xrpl/package.json').version);

const getOrGenerateUUID = (key: string): string => {
  let uuid = localStorage.getItem(key);
  if (!uuid) {
    uuid = uuidv4();
    localStorage.setItem(key, uuid);
  }
  return uuid;
};

interface Item { num: string; qty: string; total: string; invNFTId?: string; }
interface Attachment { name: string; uri: string; }
interface POData { poName: string; description: string; department: string; paymentTerms: string; deliveryTerms: string; escrowCurrency?: 'XRP' | 'RLUSD'; items: Item[]; attachments?: Attachment[]; parentIssuanceId?: string; }
interface SavedPO { id: string; poName: string; dateIssued: string; total: string; ipfsUri: string; status: 'open' | 'accepted' | 'funded' | 'claimed' | 'updated' | 'recalled' | 'superseded'; issuanceId: string; escrowSequence?: number; txHash: string; buyerAddress: string; vendorAddress: string; paymentTerms: string; escrowCurrency?: 'XRP' | 'RLUSD'; vendorUUID?: string; clawbackEnabled?: boolean; parentIssuanceId?: string; metadata: any; }
interface Profile { company: string; name: string; email: string; phone: string; address: string; city: string; state: string; zip: string; country: string; seed: string; classicAddress: string; uniqueID: string; profileUUID: string; walletHistory: string[]; lastUpdateSource?: { postedBy: string; timestamp: number }; lastOnChainHash?: string; ipfsUri?: string; profileVersion?: number; }
interface PublicProfile { company: string; name: string; email: string; phone: string; address: string; city: string; state: string; zip: string; country: string; uniqueID: string; classicAddress: string; profileUUID: string; timestamp: number; expiresAt?: number; ipfsUri?: string; linkTxHash?: string; walletHistory: string[]; lastUpdateSource?: { postedBy: string; timestamp: number }; }
interface FeeEntry { date: string; poName: string; amount: string; txHash: string; }
interface ProfileLink { linkerUUID: string; linkeeUUID: string; linkerAddress: string; linkeeAddress: string; txHash: string; createdAt: number; }
interface InventoryItem { id: string; name: string; department: string; description: string; attachments: Attachment[]; nftId: string; ipfsUri: string; dateAdded: string; }

const buildLedgerMetadata = (poName: string, ipfsUri: string, status: string, buyerAddress?: string, vendorAddress?: string, total?: string, payTerms?: string, parentIssuanceId?: string, escrowCur?: string) => ({
  t: "SCPO",
  n: poName,
  ac: "rwa",
  as: "other",
  in: "SC.PO",
  i: "https://example.com/scpo.png",
  uri: ipfsUri,
  ext: JSON.stringify({ s: status, b: buyerAddress || '', v: vendorAddress || '', amt: total || '0', pt: payTerms || '', pid: parentIssuanceId || '', ec: escrowCur || 'XRP' })
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
            const decodedType = xrpl.convertHexToString(memoType);
            if (decodedType === 'SCPO_CLAIM') {
              const decoded = JSON.parse(xrpl.convertHexToString(memoData));
              if (decoded.mpt) {
                claimedIds.add(decoded.mpt);
              }
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
            const decodedType = xrpl.convertHexToString(memoType);
            if (decodedType === 'SCPO_RECALL') {
              const decoded = JSON.parse(xrpl.convertHexToString(memoData));
              if (decoded.mpt) {
                recalledIds.add(decoded.mpt);
              }
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
  
  const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { condition: toHex(conditionBytes), fulfillment: toHex(fulfillmentBytes) };
};

export default function App() {
  const [mode, setMode] = useState<'customer' | 'vendor'>('customer');
  const [activeTab, setActiveTab] = useState<'create' | 'view' | 'scpoAction' | 'inventoryCatalog' | 'customerProfile' | 'vendorProfile' | 'admin'>('create');
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
  const [adminSubTab, setAdminSubTab] = useState<'fees' | 'credentials'>('fees');
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
  const [selectedLinkedVendor, setSelectedLinkedVendor] = useState<PublicProfile | null>(null);
  const [selectedLinkedCustomer, setSelectedLinkedCustomer] = useState<PublicProfile | null>(null);
  const [vendorsExpanded, setVendorsExpanded] = useState(false);
  const [customersExpanded, setCustomersExpanded] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [customerScpoActionViewedPO, setCustomerScpoActionViewedPO] = useState<POData | null>(null);
  const [customerScpoActionPoLoadError, setCustomerScpoActionPoLoadError] = useState<string | null>(null);
  const [vendorScpoActionViewedPO, setVendorScpoActionViewedPO] = useState<POData | null>(null);
  const [vendorScpoActionPoLoadError, setVendorScpoActionPoLoadError] = useState<string | null>(null);
  const [customerViewViewedPO, setCustomerViewViewedPO] = useState<POData | null>(null);
  const [customerViewPoLoadError, setCustomerViewPoLoadError] = useState<string | null>(null);
  const [vendorViewViewedPO, setVendorViewViewedPO] = useState<POData | null>(null);
  const [vendorViewPoLoadError, setVendorViewPoLoadError] = useState<string | null>(null);
  const [inventorySubTab, setInventorySubTab] = useState<'list' | 'add'>('list');
  const [savedInventory, setSavedInventory] = useState<InventoryItem[]>([]);
  const [invName, setInvName] = useState('');
  const [invDepartment, setInvDepartment] = useState('');
  const [invDesc, setInvDesc] = useState('');
  const [invPricingFile, setInvPricingFile] = useState<File | null>(null);
  const [invDesignFile, setInvDesignFile] = useState<File | null>(null);
  const [invBomFile, setInvBomFile] = useState<File | null>(null);
  const [invUsageFile, setInvUsageFile] = useState<File | null>(null);
  const [invResult, setInvResult] = useState('');
  const [selectedItem, setSelectedItem] = useState<any | null>(null);
  const [vendorInventories, setVendorInventories] = useState<{ [vendorAddress: string]: InventoryItem[] }>({});
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<string>('custom');
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

  useEffect(() => {
    const total = items.reduce((sum, item) => sum + parseFloat(item.total || '0'), 0);
    setTotalEscrowAmount(total.toString());
  }, [items]);

  useEffect(() => {
    const savedFees = localStorage.getItem('feeEntries');
    if (savedFees) try { setFeeEntries(JSON.parse(savedFees)); } catch { setFeeEntries([]); }
    const savedLinks = localStorage.getItem('profileLinks');
    if (savedLinks) try { setProfileLinks(JSON.parse(savedLinks)); } catch { setProfileLinks([]); }
    const savedMode = localStorage.getItem('mode');
    if (savedMode) setMode(savedMode as 'customer' | 'vendor');
  }, []);

  useEffect(() => { localStorage.setItem('mode', mode); }, [mode]);

  const addItem = () => {
    if (newItemNum && newQty && newTotal) {
      let invNFTId: string | undefined = undefined;
      if (selectedInventoryItem !== 'custom' && vendor && vendorInventories[vendor]) {
        const invItem = vendorInventories[vendor].find(i => i.name === newItemNum);
        invNFTId = invItem?.nftId;
      }
      setItems([...items, { num: newItemNum, qty: newQty, total: newTotal, invNFTId }]);
      setNewItemNum(''); setNewQty(''); setNewTotal('');
    }
  };

  const removeItem = (index: number) => setItems(items.filter((_, i) => i !== index));

// Phase 5: Load POs live from XRPL (now a reusable function)
const loadPOsFromLedger = async () => {
  // Ensure fresh connection
  try {
    const client = await getXRPLClient();
    if (!client.isConnected()) {
      await client.connect();
    }
  } catch (e) {
    console.error('Failed to connect to XRPL:', e);
    return;
  }
  const currentMode = mode;
  if (currentMode === 'customer' && !customerProfile.classicAddress) return;
  if (currentMode === 'vendor' && !vendorProfile.classicAddress) return;  
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
                customerEscrowSequence = undefined;
              }
            }
          } catch (e) {}
        }

        // Skip recalled POs
        if (recalledPOIds.has(issuanceId)) continue;

        livePOs.push({
          id: issuanceId || Date.now().toString(),
          poName: meta.n || 'PO #' + issuanceId.slice(0, 8),
          dateIssued: new Date().toLocaleDateString(),
          total: meta.amt || meta.total || meta.amount || '0',
          ipfsUri: meta.uri || '',
          status: poStatus,
          escrowSequence: customerEscrowSequence,
          issuanceId,
          txHash: '',
          buyerAddress: customerProfile.classicAddress,
          vendorAddress: vendorAddr,
          vendorUUID: customerLinkedVendorUUIDs.find(uuid => publicProfiles[uuid]?.classicAddress === vendorAddr) || '',
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
            vendorEscrowSequence = undefined;
          }
          // Check if this PO was recalled by the buyer
          if (issuanceId && posBuyerAddr) {
            try {
              const buyerRecalls = await getRecalledPOIds(posBuyerAddr);
              if (buyerRecalls.has(issuanceId)) continue;
            } catch (e) { /* skip */ }
          }
          vendorPOList.push({
            id: issuanceId || Date.now().toString(),
            poName: meta.n || 'PO #' + issuanceId.slice(0, 8),
            dateIssued: new Date().toLocaleDateString(),
            total: meta.amt || meta.total || meta.amount || '0',
            ipfsUri: meta.uri || '',
            status: vendorPoStatus,
            escrowSequence: vendorEscrowSequence,
            issuanceId,          
            txHash: '',
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
      for (const uuid of vendorLinkedCustomerUUIDs) {
        await new Promise(r => setTimeout(r, 500)); // throttle to avoid XRPL timeouts      
        const customerAddr = publicProfiles[uuid]?.classicAddress;
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
            vendorPOList.push({
              id: issuanceId || Date.now().toString(),
              poName: meta.n || 'PO #' + issuanceId.slice(0, 8),
              dateIssued: new Date().toLocaleDateString(),
              total: meta.amt || meta.total || meta.amount || '0',
              ipfsUri: meta.uri || '',
              status: 'open',
              issuanceId,
              txHash: '',
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
    setSavedPOs(livePOs);
    console.log(`✅ Loaded ${livePOs.length} POs from XRPL ledger (Mode: ${currentMode})`);    
  } catch (err: any) {
    console.error('Failed to load POs from XRPL:', err.message);
  }
};

// Auto-refresh POs every 30 seconds (ledger is the source of truth)
useEffect(() => {
  if (!autoRefreshEnabled) return;
  const interval = setInterval(() => {
    loadPOsFromLedger();
  }, 45000);
  return () => clearInterval(interval);
}, [autoRefreshEnabled, mode, customerProfile.classicAddress, vendorProfile.classicAddress]);

// Auto-refresh linked profiles every 60 seconds via DID resolution
useEffect(() => {
  if (!autoRefreshEnabled) return;
  const interval = setInterval(async () => {
    const allUUIDs = mode === 'customer' ? customerLinkedVendorUUIDs : vendorLinkedCustomerUUIDs;
    for (const uuid of allUUIDs) {
      try {
        await manualRefreshProfile(uuid);
      } catch (e) { /* silent fail on auto-refresh */ }
    }
  }, 60000);
  return () => clearInterval(interval);
}, [autoRefreshEnabled, mode, customerLinkedVendorUUIDs, vendorLinkedCustomerUUIDs]);

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
    loadPOsFromLedger();
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
          await client.submitAndWait(signedDestroy.tx_blob);
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
              Memos: [{
                Memo: {
                  MemoType: xrpl.convertStringToHex('SCPO_RECALL'),
                  MemoData: xrpl.convertStringToHex(JSON.stringify({
                    type: 'SCPO_RECALL',
                    mpt: po.issuanceId,
                    recalledAt: Date.now()
                  }))
                }
              }]
            };
            const preparedRecall = await client.autofill(recallReceipt);
            preparedRecall.LastLedgerSequence = currentLedger + 20;
            const signedRecall = wallet.sign(preparedRecall);
            await client.submitAndWait(signedRecall.tx_blob);
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
        await client.submitAndWait(signedClaw.tx_blob);
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
          Memos: [{
            Memo: {
              MemoType: xrpl.convertStringToHex('SCPO_RECALL'),
              MemoData: xrpl.convertStringToHex(JSON.stringify({
                type: 'SCPO_RECALL',
                mpt: po.issuanceId,
                recalledAt: Date.now()
              }))
            }
          }]
        };
        const preparedRecall = await client.autofill(recallReceipt);
        preparedRecall.LastLedgerSequence = currentLedger + 20;
        const signedRecall = wallet.sign(preparedRecall);
        await client.submitAndWait(signedRecall.tx_blob);
        console.log('Recall receipt memo sent on-chain');
      } catch (e) {
        console.error('Failed to send recall receipt:', e);
      }
      updatePO({ ...po, status: 'recalled', escrowSequence: undefined });
      alert('PO recalled on-chain.');
      setTimeout(() => loadPOsFromLedger(), 2000);
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
        console.log('DEBUG PO decrypt:', { mode, vendorUUID: po.vendorUUID, password: password?.substring(0, 10), vendorProfileUUID: vendorProfile.profileUUID, customerProfileUUID: customerProfile.profileUUID });
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
      const feePayment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: process.env.REACT_APP_COMPANY_WALLET || '', Amount: feeAmount };
      const preparedFee = await client.autofill(feePayment); preparedFee.LastLedgerSequence = currentLedger + 20;
      const signedFee = wallet.sign(preparedFee);
      const feeResult = await client.submitAndWait(signedFee.tx_blob);
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
      const createResult = await client.submitAndWait(signedCreate.tx_blob);
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
      console.log("Captured Issuance ID:", issuanceId);
      console.log("Issuance ID length:", issuanceId.length);
      const txHash = createResult.result.hash;
      console.log('DEBUG createSCPO:', { selectedVendorUUID, vendorAddress: vendor, customerUUID: customerProfile.profileUUID, vendorUUID: vendorProfile.profileUUID });
      const newPO: SavedPO = { id: Date.now().toString(), poName, dateIssued: new Date().toLocaleDateString(), total: totalEscrowAmount, ipfsUri, status: 'open', issuanceId, txHash, buyerAddress: wallet.classicAddress, vendorAddress: vendor, paymentTerms, escrowCurrency, vendorUUID: selectedVendorUUID, clawbackEnabled: true, metadata: fullMetadata };
      saveNewPO(newPO);
      const newFee: FeeEntry = { date: new Date().toLocaleString(), poName, amount: feeLabel, txHash: feeResult.result.hash };
      const updatedFees = [...feeEntries, newFee]; setFeeEntries(updatedFees); localStorage.setItem('feeEntries', JSON.stringify(updatedFees));
      setResult(`SC.PO Created Successfully!\nIssuance ID: ${issuanceId}\nTx Hash: ${txHash}\nIPFS URI: ${ipfsUri}\n\nVendor must now ACCEPT to authorize.`);
      setScpoSuccess(true); setTimeout(() => setScpoSuccess(false), 3000);
      setItems([]); localStorage.removeItem('createItems');
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
          await client.submitAndWait(signedClaw.tx_blob);
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
            Memos: [{ Memo: { MemoType: xrpl.convertStringToHex('SCPO_RECALL'), MemoData: xrpl.convertStringToHex(JSON.stringify({ type: 'SCPO_RECALL', mpt: selectedUpdatePO.issuanceId, recalledAt: Date.now() })) } }]
          };
          const preparedRecall = await client.autofill(recallReceipt);
          preparedRecall.LastLedgerSequence = currentLedger + 20;
          const signedRecall = wallet.sign(preparedRecall);
          await client.submitAndWait(signedRecall.tx_blob);
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
      const createResult = await client.submitAndWait(signedCreate.tx_blob);
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
      console.log("Captured Issuance ID:", issuanceId);
      console.log("Issuance ID length:", issuanceId.length);
      const txHash = createResult.result.hash;
      const newPO: SavedPO = { id: Date.now().toString(), poName, dateIssued: new Date().toLocaleDateString(), total: totalEscrowAmount, ipfsUri, status: 'open', issuanceId, txHash, buyerAddress: wallet.classicAddress, vendorAddress: selectedUpdatePO.vendorAddress, paymentTerms, escrowCurrency, vendorUUID: selectedUpdatePO.vendorUUID, clawbackEnabled: true, parentIssuanceId: selectedUpdatePO.issuanceId, metadata: fullMetadata };
      saveNewPO(newPO);
      const memoData = xrpl.convertStringToHex(`PO Updated: ${poName} (v2) - Please re-accept.`);
      const memoPayment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: selectedUpdatePO.vendorAddress, Amount: '1', Memos: [{ Memo: { MemoData: memoData, MemoType: xrpl.convertStringToHex('PO_UPDATE') } }] };
      const preparedMemo = await client.autofill(memoPayment); preparedMemo.LastLedgerSequence = currentLedger + 20;
      const signedMemo = wallet.sign(preparedMemo);
      await client.submitAndWait(signedMemo.tx_blob);
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
        MPTokenIssuanceID: po.issuanceId
      };
      console.log('Vendor Authorize Tx payload:', JSON.stringify(authorizeTx, null, 2));
      const prepared = await client.autofill(authorizeTx);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const acceptResultTx = await client.submitAndWait(signed.tx_blob);
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
        value: totalNum.toString()
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
      const escrowMemo = JSON.stringify({ type: 'SCPO_ESCROW', po: po.poName, mpt: po.issuanceId, ipfs: po.ipfsUri, total: po.total, currency: currency, items: po.metadata?.items?.length || 0, terms: po.paymentTerms, created: Date.now() });
      const escrow: any = { TransactionType: 'EscrowCreate', Account: wallet.classicAddress, Destination: po.vendorAddress, Amount: escrowAmount, FinishAfter: finishRipple, CancelAfter: cancelRipple, Condition: condition, Memos: [{ Memo: { MemoType: xrpl.convertStringToHex('SCPO_ESCROW'), MemoData: xrpl.convertStringToHex(escrowMemo) } }] };
      const preparedEscrow = await client.autofill(escrow); preparedEscrow.LastLedgerSequence = currentLedger + 20;
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await client.submitAndWait(signedEscrow.tx_blob);
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
      const paymentResult = await client.submitAndWait(signedPayment.tx_blob);
      if (typeof paymentResult.result.meta === 'object' && paymentResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error('MPT Delivery failed: ' + paymentResult.result.meta.TransactionResult);
      }
      updatePO({ ...po, escrowSequence, status: 'funded' });
      const currencyLabel = currency === 'RLUSD' ? `$${totalNum} RLUSD` : `${xrpl.dropsToXrp(escrowAmount)} XRP`;
      alert(`Escrow funded (${currencyLabel}) & PO delivered! Sequence: ${escrowSequence}`);
    } catch (err: any) { alert('Failed to fund escrow: ' + err.message); }
  };

  // ── Task 2.4: Claim Escrow (supports both XRP and RLUSD) ──
  const claimEscrowForPO = async (po: SavedPO) => {
    if (po.status === 'superseded') return alert('This PO version is superseded. Use the latest version.');
    if (!vendorProfile.seed) return alert('Claim seed required');
    if (!po.escrowSequence) return alert('No escrow sequence');
    try {
      await fetchEscrowInfo(po.buyerAddress, po.escrowSequence);
      if (!isClaimable) { alert('Not yet claimable'); return; }
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const { condition, fulfillment } = await generateEscrowCondition(po.issuanceId);
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
          Memos: [{
            Memo: {
              MemoType: xrpl.convertStringToHex('SCPO_CLAIM'),
              MemoData: xrpl.convertStringToHex(JSON.stringify({
                type: 'SCPO_CLAIM',
                mpt: po.issuanceId,
                escrowTx: result.result.hash,
                claimedAt: Date.now()
              }))
            }
          }]
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
      updatePOStatus(po.id, 'claimed');      
    } catch (err: any) { alert('Claim failed: ' + err.message); }
  };

  const fetchEscrowInfo = async (owner: string, sequence: number) => {
    try {
      const client = await getXRPLClient();
      const response: any = await client.request({ command: 'ledger_entry', escrow: { owner, seq: sequence }, ledger_index: 'validated' });
      if (response.result.node && response.result.node.LedgerEntryType === 'Escrow') {
        const escrowObj = response.result.node;
        const rippleEpochStart = 946684800;
        const finishTime = new Date(((escrowObj as any).FinishAfter + rippleEpochStart) * 1000);
        setClaimableAfter(finishTime); setIsClaimable(new Date() >= finishTime);
        // Detect escrow currency — if Amount is an object, it's a token escrow
        if (typeof escrowObj.Amount === 'object' && escrowObj.Amount.currency) {
          console.log(`Escrow holds ${escrowObj.Amount.value} ${escrowObj.Amount.currency} (token escrow)`);
        } else {
          console.log(`Escrow holds ${xrpl.dropsToXrp(escrowObj.Amount)} XRP`);
        }
      } else { setClaimableAfter(null); setIsClaimable(false); }
    } catch (err: any) { if (err.data?.error === 'entryNotFound') { setClaimableAfter(null); setIsClaimable(false); } }
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

  const sortPOsNewestFirst = (pos: SavedPO[]) => pos.sort((a, b) => parseInt(b.id) - parseInt(a.id));
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

  const tabs = mode === 'customer' ? [{ label: 'Create', key: 'create' }, { label: 'Action', key: 'scpoAction' }, { label: 'Overview', key: 'view' }, { label: 'Profile', key: 'customerProfile' }, { label: 'Admin', key: 'admin' }] : [{ label: 'Overview', key: 'view' }, { label: 'Action', key: 'scpoAction' }, { label: 'Inventory', key: 'inventoryCatalog' }, { label: 'Profile', key: 'vendorProfile' }, { label: 'Admin', key: 'admin' }];

  const saveNewInventory = (item: InventoryItem) => { const updated = [...savedInventory, item]; setSavedInventory(updated); localStorage.setItem('savedInventory', JSON.stringify(updated)); };
  const viewInventoryFromUri = async (uri: string, localItem: InventoryItem) => { try { const data = await fetchFromIPFS(uri); setSelectedItem({ ...data, nftId: localItem.nftId }); } catch (err: any) { alert('Failed to load inventory: ' + err.message); } };
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

  useEffect(() => { if (mode === 'customer' && activeTab === 'create' && vendor) { (async () => { const inv = await fetchVendorInventory(vendor); setVendorInventories(prev => ({ ...prev, [vendor]: inv })); })(); } }, [vendor, mode, activeTab]);

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

  const generateInventory = async () => {
    if (!invName) return alert('Name required');
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    let attachments: Attachment[] = [];
    const files = [{ file: invPricingFile, name: 'Pricing' }, { file: invDesignFile, name: 'Design' }, { file: invBomFile, name: 'BOM' }, { file: invUsageFile, name: 'Usage' }];
    for (const { file, name } of files) {
      if (file) { try { const uri = await uploadFileToIPFS(file); attachments.push({ name: `${name}_${file.name}`, uri }); } catch (err: any) { alert(`Failed to upload ${name} file: ` + err.message); return; } }
    }
    const invData = { name: invName, department: invDepartment, description: invDesc, attachments };
    try {
      setInvResult('Uploading inventory data to IPFS...');
      const ipfsUri = await uploadToIPFS(invData);
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const nft: any = { TransactionType: 'NFTokenMint', Account: wallet.classicAddress, URI: xrpl.convertStringToHex(ipfsUri), Flags: 8, NFTokenTaxon: 1 };
      const preparedNFT = await client.autofill(nft); preparedNFT.LastLedgerSequence = currentLedger + 20;
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await client.submitAndWait(signedNFT.tx_blob);
      if (typeof nftResult.result.meta === 'object' && nftResult.result.meta.TransactionResult !== 'tesSUCCESS') { setInvResult('NFT Mint failed'); return; }
      let nftId = 'unknown';
      const mintedNode = (nftResult.result.meta as any)?.AffectedNodes?.find((node: any) => node.CreatedNode?.LedgerEntryType === 'NFTokenPage');
      if (mintedNode) { const tokens = mintedNode.CreatedNode.NewFields.NFTokens || []; nftId = tokens[tokens.length - 1]?.NFToken?.NFTokenID || 'unknown'; }
      const newItem: InventoryItem = { id: Date.now().toString(), name: invName, department: invDepartment, description: invDesc, attachments, nftId, ipfsUri, dateAdded: new Date().toLocaleDateString() };
      saveNewInventory(newItem);
      setInvResult(`Inventory Item Created! NFT ID: ${nftId}\nIPFS URI: ${ipfsUri}`);
      setInvName(''); setInvDepartment(''); setInvDesc(''); setInvPricingFile(null); setInvDesignFile(null); setInvBomFile(null); setInvUsageFile(null);
    } catch (err: any) { setInvResult('Error: ' + err.message); }
  };

  const sortInventoryNewestFirst = (items: InventoryItem[]) => items.sort((a, b) => parseInt(b.id) - parseInt(a.id));

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
    const loadObject = (key: string, setState: React.Dispatch<React.SetStateAction<any>>) => {
      const saved = localStorage.getItem(key);
      if (saved) try { setState(JSON.parse(saved)); } catch { setState({}); }
    };
    const loadArray = (key: string, setState: React.Dispatch<React.SetStateAction<string[]>>) => {
      const saved = localStorage.getItem(key);
      if (saved) try { setState(JSON.parse(saved)); } catch { setState([]); }
    };
    loadProfile('customerProfile', setCustomerProfile);
    loadProfile('vendorProfile', setVendorProfile);
    loadObject('publicProfiles', setPublicProfiles);
    loadArray('customerLinkedVendorUUIDs', setCustomerLinkedVendorUUIDs);
    loadArray('vendorLinkedCustomerUUIDs', setVendorLinkedCustomerUUIDs);
    const savedLinks = localStorage.getItem('profileLinks');
    if (savedLinks) try { setProfileLinks(JSON.parse(savedLinks)); } catch { setProfileLinks([]); }
    const savedTab = localStorage.getItem('activeTab');
    if (savedTab) setActiveTab(savedTab as any);
    const savedItems = localStorage.getItem('createItems');
    if (savedItems) try { setItems(JSON.parse(savedItems)); } catch { setItems([]); }
        const savedInventoryData = localStorage.getItem('savedInventory');
    if (savedInventoryData) try { setSavedInventory(JSON.parse(savedInventoryData)); } catch { setSavedInventory([]); }
    
    setHydrated(true);

    // Phase 1 test - remove after we finish all phases
    const runXRPLTest = async () => {
      if (customerProfile.classicAddress) {
        try {
          console.log('✅ Phase 1 Test: Fetching MPTs from XRPL...');
          const mpts = await getMyMPTs(customerProfile.classicAddress);
          console.log('✅ Phase 1 Test: Your MPTs from XRPL:', mpts);

          console.log('✅ Phase 1 Test: Fetching Escrows from XRPL...');
          const escrows = await getMyEscrows(customerProfile.classicAddress);
          console.log('✅ Phase 1 Test: Your Escrows from XRPL:', escrows);
        } catch (err: any) {
          console.error('❌ Phase 1 Test Error:', err.message);
        }
      }
    };

    runXRPLTest();
  }, []);


  useEffect(() => {
    if (!hydrated) return;
    const links = JSON.parse(localStorage.getItem('profileLinks') || '[]');
    const customerVendors = new Set<string>();
    const vendorCustomers = new Set<string>();
    links.forEach((l: ProfileLink) => {
      if (l.linkerUUID === customerProfile.profileUUID) customerVendors.add(l.linkeeUUID);
      if (l.linkerUUID === vendorProfile.profileUUID) vendorCustomers.add(l.linkeeUUID);
    });
    setCustomerLinkedVendorUUIDs(Array.from(customerVendors));
    setVendorLinkedCustomerUUIDs(Array.from(vendorCustomers));
  }, [hydrated, profileLinks, customerProfile.profileUUID, vendorProfile.profileUUID]);

  useEffect(() => {
    if (customerProfile.seed) setSeed(customerProfile.seed);
    if (vendorProfile.seed) { setVendorAcceptSeed(vendorProfile.seed); setClaimSeed(vendorProfile.seed); }
  }, [customerProfile, vendorProfile]);

  useEffect(() => { if (!hydrated) return; localStorage.setItem('publicProfiles', JSON.stringify(publicProfiles)); }, [publicProfiles, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('customerLinkedVendorUUIDs', JSON.stringify(customerLinkedVendorUUIDs)); }, [customerLinkedVendorUUIDs, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('vendorLinkedCustomerUUIDs', JSON.stringify(vendorLinkedCustomerUUIDs)); }, [vendorLinkedCustomerUUIDs, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('profileLinks', JSON.stringify(profileLinks)); }, [profileLinks, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('activeTab', activeTab); }, [activeTab, hydrated]);
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
  // ===== DID HELPERS (Phase 1A) =====
  const buildDIDDocument = (publicKey: string, profileUri: string, catalogUri?: string): string => {
    const doc: any = {
      svc: [profileUri],
      vm: publicKey,
      v: 1
    };
    if (catalogUri) doc.svc.push(catalogUri);
    return JSON.stringify(doc);
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
      if (customerProfile.lastOnChainHash && contentHash === customerProfile.lastOnChainHash) { console.log('No profile changes'); localStorage.setItem('customerProfile', JSON.stringify(updatedProfile)); return; }
      if (true) {
        const publicProfile: PublicProfile = { company: updatedProfile.company, name: updatedProfile.name, email: updatedProfile.email, phone: updatedProfile.phone, address: updatedProfile.address, city: updatedProfile.city, state: updatedProfile.state, zip: updatedProfile.zip, country: updatedProfile.country, uniqueID: updatedProfile.uniqueID, classicAddress: updatedProfile.classicAddress, profileUUID: updatedProfile.profileUUID, timestamp: Date.now(), walletHistory: updatedProfile.walletHistory };
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        // Phase 1A: Use ECDH-derived key instead of manual password
        console.log('DEBUG wallet privateKey:', wallet.privateKey.length, wallet.privateKey.substring(0, 6));
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
        await client.submitAndWait(signedSet.tx_blob);
        
        // Also set Domain for backward compatibility during transition
        try {
          const accountSet: AccountSet = { TransactionType: 'AccountSet', Account: wallet.classicAddress, Domain: xrpl.convertStringToHex(newIpfsUri) };
          const preparedAccSet = await client.autofill(accountSet);
          const signedAccSet = wallet.sign(preparedAccSet);
          await client.submitAndWait(signedAccSet.tx_blob);
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
    } catch (err: any) { alert('Failed to post update on-chain: ' + (err.message || String(err))); }
  };

  const saveVendorProfile = async () => {
    try {
      let updatedProfile = { ...vendorProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      if (vendorProfile.lastOnChainHash && contentHash === vendorProfile.lastOnChainHash) { console.log('No profile changes'); localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile)); return; }
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
        await client.submitAndWait(signedSet.tx_blob);
        
        // Also set Domain for backward compatibility during transition
        try {
          const accountSet: AccountSet = { TransactionType: 'AccountSet', Account: wallet.classicAddress, Domain: xrpl.convertStringToHex(newIpfsUri) };
          const preparedAccSet = await client.autofill(accountSet);
          const signedAccSet = wallet.sign(preparedAccSet);
          await client.submitAndWait(signedAccSet.tx_blob);
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
      const ipfsUri = didResult.uri;
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptionKey);
      decoded.ipfsUri = ipfsUri;
      decoded.classicAddress = inputVendorWalletAddress;
            
      // Step 4: Store profile
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles); localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!customerLinkedVendorUUIDs.includes(decoded.profileUUID)) { 
        const updatedUUIDs = [...customerLinkedVendorUUIDs, decoded.profileUUID]; 
        setCustomerLinkedVendorUUIDs(updatedUUIDs); 
        localStorage.setItem('customerLinkedVendorUUIDs', JSON.stringify(updatedUUIDs)); 
      }
      
      setInputVendorWalletAddress('');
      alert('Vendor linked via DID! No password needed.');
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
      const memoData = xrpl.convertStringToHex(JSON.stringify({ type: 'link', profileUUID: linkee.profileUUID, ipfsUri: linkee.ipfsUri }));
      const payment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: linkee.classicAddress, Amount: '1', Memos: [{ Memo: { MemoData: memoData, MemoType: xrpl.convertStringToHex('link') } }] };
      const prepared = await client.autofill(payment);
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
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
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY; if (!pinataApiKey) throw new Error('Pinata API key missing');
    const formData = new FormData(); formData.append('file', file);
    const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${pinataApiKey}` }, body: formData });
    if (!response.ok) { const errorText = await response.text(); throw new Error(`File upload failed: ${errorText}`); }
    const result = await response.json(); return `ipfs://${result.IpfsHash}`;
  };

  const uploadEncryptedToIPFS = async (data: any, password: string) => {
    if (!password) throw new Error('Password required');
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), password).toString();
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY; if (!pinataApiKey) throw new Error('Pinata API key missing');
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pinataApiKey}` }, body: JSON.stringify({ encryptedData: encrypted }) });
    if (!response.ok) { const errorText = await response.text(); throw new Error(`Pinata upload failed: ${errorText}`); }
    const result = await response.json(); return `ipfs://${result.IpfsHash}`;
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
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY; if (!pinataApiKey) throw new Error('Pinata API key missing');
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pinataApiKey}` }, body: JSON.stringify(data) });
    if (!response.ok) { const errorText = await response.text(); throw new Error(`Pinata upload failed: ${errorText}`); }
    const result = await response.json(); return `ipfs://${result.IpfsHash}`;
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

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f5f5f5', fontFamily: 'Helvetica, Arial, sans-serif' }}>
      <div style={{ position: 'fixed', left: 0, top: 0, width: '190px', height: '100vh', background: 'linear-gradient(90deg, #D88F2E 0%, #FBC85F 55%, #FFEBB8 100%)', padding: '20px', borderTopRightRadius: '28px', borderBottomRightRadius: '28px', overflow: 'visible', zIndex: 10, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '40px' }}>
          <span style={{ color: '#FFFFFF', fontWeight: 'bold', marginRight: '10px' }}>{mode === 'customer' ? 'Customer' : 'Vendor'}</span>
          <div style={{ position: 'relative', width: '60px', height: '30px', background: 'linear-gradient(to right, #D88F2E, #FBC85F)', borderRadius: '999px', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)', border: '1px solid rgba(255,255,255,0.55)' }}>
            <span onClick={() => setMode(mode === 'customer' ? 'vendor' : 'customer')} style={{ position: 'absolute', left: mode === 'customer' ? '0' : '30px', width: '30px', height: '30px', background: '#FFF6DC', borderRadius: '50%', transition: 'left 0.3s ease', boxShadow: '0 2px 4px rgba(0,0,0,0.1)', cursor: 'pointer' }} />
          </div>
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
      <div style={{ marginLeft: '190px', flex: 1, padding: '40px', background: '#FFF2D6', minHeight: '100vh', overflowY: 'auto' }}>
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
                  </div>
                </div>
                <h3 style={{ color: '#F2B04A', margin: '40px 0 20px', textAlign: 'center' }}>Request</h3>
                <div style={{ maxWidth: '900px', margin: '0 auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 15px' }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '30px 0 0 30px' }}>Item #</th>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0' }}>Item Link</th>
                        <th style={{ padding: '15px', background: '#FFF3E0' }}>Qty</th>
                        <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '0 30px 30px 0' }}>Total $</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => (
                        <tr key={index}>
                          <td style={{ padding: '15px', background: 'white', borderRadius: '30px 0 0 30px' }}>{item.num}</td>
                          <td style={{ padding: '15px', background: 'white' }}>🔗</td>
                          <td style={{ padding: '15px', background: 'white' }}>{item.qty}</td>
                          <td style={{ padding: '15px', background: 'white' }}>${item.total}</td>
                          <td style={{ padding: '15px', background: 'white', borderRadius: '0 30px 30px 0' }}>
                            <button onClick={() => removeItem(index)} style={{ background: '#e74c3c', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer', transition: 'all 0.2s ease', border: 'none' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h4 style={{ color: '#F2B04A', margin: '40px 0 10px', textAlign: 'center' }}>Add New Item</h4>
                <div style={{ display: 'flex', gap: '10px', maxWidth: '900px', margin: '0 auto 40px auto' }}>
                  {vendor && vendorInventories[vendor]?.length > 0 ? (
                    <select value={selectedInventoryItem} onChange={(e) => { setSelectedInventoryItem(e.target.value); setNewItemNum(e.target.value === 'custom' ? '' : e.target.value); }} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }}>
                      <option value="custom">Custom Item #</option>
                      {vendorInventories[vendor].map(item => <option key={item.nftId} value={item.name}>{item.name}</option>)}
                    </select>
                  ) : (
                    <input placeholder="Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                  )}
                  {selectedInventoryItem === 'custom' && vendor && vendorInventories[vendor]?.length > 0 && (
                    <input placeholder="Custom Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                  )}
                  <input placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
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
                            <th style={{ padding: '15px', background: '#FFF3E0' }}>Qty</th>
                            <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '0 30px 30px 0' }}>Total $</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((item, index) => (
                            <tr key={index}>
                              <td style={{ padding: '15px', background: 'white', borderRadius: '30px 0 0 30px' }}>{item.num}</td>
                              <td style={{ padding: '15px', background: 'white' }}>🔗</td>
                              <td style={{ padding: '15px', background: 'white' }}>{item.qty}</td>
                              <td style={{ padding: '15px', background: 'white' }}>${item.total}</td>
                              <td style={{ padding: '15px', background: 'white', borderRadius: '0 30px 30px 0' }}>
                                <button onClick={() => removeItem(index)} style={{ background: '#e74c3c', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer', transition: 'all 0.2s ease', border: 'none' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                  Remove
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <h4 style={{ color: '#F2B04A', margin: '40px 0 10px', textAlign: 'center' }}>Add New Item</h4>
                    <div style={{ display: 'flex', gap: '10px', maxWidth: '900px', margin: '0 auto 40px auto' }}>
                      <input placeholder="Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
                      <input placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }} />
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
                  <button onClick={() => openProfilesModal(selectedOpenPO)} style={{ background: 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                    Profiles
                  </button>
                  {getPOHistory(selectedOpenPO || customerScpoActionViewedPO as any).length > 0 && (
                    <button onClick={() => openHistoryModal(selectedOpenPO, customerScpoActionViewedPO)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                      View History
                    </button>
                  )}
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
              {getLatestActivePOs('funded').filter(isWithin24HoursOfClaimable).length === 0 ? <p>No funded POs ready to claim</p> : (
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
                      {(fundedExpanded ? sortPOsNewestFirst(getLatestActivePOs('funded').filter(isWithin24HoursOfClaimable)) : sortPOsNewestFirst(getLatestActivePOs('funded').filter(isWithin24HoursOfClaimable).slice(0, 2))).map(po => (
                          <tr key={po.issuanceId || po.id}>
                          <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>{getTimeRemaining(po)}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => claimEscrowForPO(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Claim Escrow
                            </button>
                            <button onClick={async () => { setSelectedFundedPO(po); await viewPOFromUri(po.ipfsUri, po, setVendorScpoActionViewedPO, setVendorScpoActionPoLoadError); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getLatestActivePOs('funded').filter(isWithin24HoursOfClaimable).length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button onClick={() => setFundedExpanded(!fundedExpanded)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        {fundedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
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
                  <button onClick={() => openProfilesModal(selectedOpenPO)} style={{ background: 'linear-gradient(90deg, #2196F3 0%, #64B5F6 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                    Profiles
                  </button>
                  {getPOHistory(selectedOpenPO || vendorScpoActionViewedPO as any).length > 0 && (
                    <button onClick={() => openHistoryModal(selectedOpenPO, vendorScpoActionViewedPO)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '20px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                      View History
                    </button>
                  )}
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
            </div>
            {inventorySubTab === 'list' && (
              <div>
                <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Your Inventory</h3>
                {savedInventory.length === 0 ? <p>No inventory items added yet.</p> : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0' }}>
                        <th style={{ padding: '10px' }}>Link</th>
                        <th style={{ padding: '10px' }}>Name</th>
                        <th style={{ padding: '10px' }}>Description</th>
                        <th style={{ padding: '10px' }}>Department</th>
                        <th style={{ padding: '10px' }}>Date Added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortInventoryNewestFirst(savedInventory).map(item => (
                        <tr key={item.id}>
                          <td style={{ padding: '10px' }}>
                            <button onClick={() => viewInventoryFromUri(item.ipfsUri, item)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              🔗 View
                            </button>
                          </td>
                          <td style={{ padding: '10px' }}>{item.name}</td>
                          <td style={{ padding: '10px' }}>{item.description.substring(0, 50)}...</td>
                          <td style={{ padding: '10px' }}>{item.department}</td>
                          <td style={{ padding: '10px' }}>{item.dateAdded}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {selectedItem && (
                  <div style={{ marginTop: '20px', border: '1px solid #D88F2E', padding: '15px', background: '#f9f9f9', borderRadius: '15px' }}>
                    <h4 style={{ color: '#F2B04A' }}>Item Details</h4>
                    <p><strong style={{ color: '#F2B04A' }}>Name:</strong> {selectedItem.name}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Department:</strong> {selectedItem.department}</p>
                    <p><strong style={{ color: '#F2B04A' }}>Description:</strong> {selectedItem.description}</p>
                    <h5 style={{ color: '#F2B04A' }}>Documents</h5>
                    <ul>{selectedItem.attachments.map((att: Attachment, i: number) => <li key={i}><a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>{att.name}</a></li>)}</ul>
                    <p><strong style={{ color: '#F2B04A' }}>NFT ID:</strong> {selectedItem.nftId}</p>
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <QRCodeSVG value={`https://devnet.xrpl.org/nft/${selectedItem.nftId}`} size={128} />
                      <p style={{ color: '#F2B04A' }}>QR Code for NFT (scan to view on XRPL Testnet)</p>
                    </div>
                    <button onClick={() => setSelectedItem(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      Close
                    </button>
                  </div>
                )}
              </div>
            )}
            {inventorySubTab === 'add' && (
              <div>
                <h3 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '20px' }}>Add New Inventory Item</h3>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Name</label>
                <input value={invName} onChange={(e) => setInvName(e.target.value)} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '20px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Department</label>
                <input value={invDepartment} onChange={(e) => setInvDepartment(e.target.value)} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '20px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Description</label>
                <textarea value={invDesc} onChange={(e) => setInvDesc(e.target.value)} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', height: '100px', marginBottom: '20px' }} />
                <h4 style={{ color: '#F2B04A', marginBottom: '10px' }}>Documents</h4>
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Pricing File</label>
                <input type="file" onChange={(e) => setInvPricingFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '15px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Design File</label>
                <input type="file" onChange={(e) => setInvDesignFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '15px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>BOM File</label>
                <input type="file" onChange={(e) => setInvBomFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '15px' }} />
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold' }}>Usage File</label>
                <input type="file" onChange={(e) => setInvUsageFile(e.target.files?.[0] || null)} style={{ width: '100%', padding: '10px', borderRadius: '30px', border: '2px solid #D88F2E', marginBottom: '30px' }} />
                <button onClick={generateInventory} style={{ display: 'block', margin: '0 auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate
                </button>
                {invResult && <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', borderRadius: '15px', marginTop: '20px' }}>{invResult}</pre>}
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
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
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
                                <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
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
                                  {inv.attachments.map((att, j) => (
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
                      <input type="text" placeholder="Search by PO Name or Date" value={feeSearchTerm} onChange={(e) => setFeeSearchTerm(e.target.value)} style={{ padding: '10px', borderRadius: '20px', border: '2px solid #D88F2E', width: '300px' }} />
                    </div>
                    {filteredFees.length === 0 ? <p>No fees collected yet</p> : (
                      <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid #D88F2E' }}>
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
                      </table>
                    )}
                  </div>
                )}

                {/* Domain & Credentials Sub-Tab */}
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
                  </div>
                )}
              </div>
            )}
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
