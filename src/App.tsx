import React, { useState, useEffect, useRef } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, EscrowFinish, Payment, AccountSet, Transaction, Memo, AccountTxResponse, AccountInfoResponse, AccountNFTsResponse, AccountNFToken } from 'xrpl';
import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';
import { QRCodeSVG } from 'qrcode.react';

console.log('xrpl version loaded:', require('xrpl/package.json').version);

const getOrGenerateUUID = (key: string): string => {
  let uuid = localStorage.getItem(key);
  if (!uuid) {
    uuid = uuidv4();
    localStorage.setItem(key, uuid);
  }
  return uuid;
};

let xrplClient: xrpl.Client | null = null;
let connectingPromise: Promise<xrpl.Client> | null = null;

const getXRPLClient = async (): Promise<xrpl.Client> => {
  if (xrplClient?.isConnected()) return xrplClient;
  if (!connectingPromise) {
    connectingPromise = (async () => {
      const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233', { connectionTimeout: 20000 });
      await client.connect();
      xrplClient = client;
      connectingPromise = null;
      return client;
    })();
  }
  return connectingPromise;
};

interface Item { num: string; qty: string; total: string; invNFTId?: string; }
interface Attachment { name: string; uri: string; }
interface POData { poName: string; description: string; department: string; paymentTerms: string; deliveryTerms: string; items: Item[]; attachments?: Attachment[]; parentIssuanceId?: string; }
interface SavedPO { id: string; poName: string; dateIssued: string; total: string; ipfsUri: string; status: 'open' | 'accepted' | 'funded' | 'claimed' | 'updated' | 'recalled' | 'superseded'; issuanceId: string; escrowSequence?: number; txHash: string; buyerAddress: string; vendorAddress: string; paymentTerms: string; vendorUUID?: string; clawbackEnabled?: boolean; parentIssuanceId?: string; metadata: any; }
interface Profile { company: string; name: string; email: string; phone: string; address: string; city: string; state: string; zip: string; country: string; seed: string; classicAddress: string; uniqueID: string; profileUUID: string; walletHistory: string[]; lastUpdateSource?: { postedBy: string; timestamp: number }; lastOnChainHash?: string; ipfsUri?: string; }
interface PublicProfile { company: string; name: string; email: string; phone: string; address: string; city: string; state: string; zip: string; country: string; uniqueID: string; classicAddress: string; profileUUID: string; timestamp: number; expiresAt?: number; ipfsUri?: string; linkTxHash?: string; walletHistory: string[]; lastUpdateSource?: { postedBy: string; timestamp: number }; }
interface FeeEntry { date: string; poName: string; amount: string; txHash: string; }
interface ProfileLink { linkerUUID: string; linkeeUUID: string; linkerAddress: string; linkeeAddress: string; txHash: string; createdAt: number; }
interface InventoryItem { id: string; name: string; department: string; description: string; attachments: Attachment[]; nftId: string; ipfsUri: string; dateAdded: string; }

const buildLedgerMetadata = (poName: string, ipfsUri: string, status: string) => ({
  t: "SCPO",
  n: poName,
  d: `Purchase Order: ${poName}`,
  ac: "rwa",
  as: "other",
  in: "SC.PO Generator",
  i: "https://example.com/scpo-icon.png",
  uri: ipfsUri,
  s: status
});

const buildPOMetadata = (poName: string, description: string, department: string, paymentTerms: string, deliveryTerms: string, items: Item[], attachments: Attachment[] | undefined, buyerAddress: string, vendorAddress: string, status: string, parentIssuanceId?: string, clawbackEnabled: boolean = true, history: Array<{ts: number; status: string; by: string}> = []) => ({
  poName, description, department, paymentTerms, deliveryTerms, items: items.map(i => ({ ...i })), attachments: attachments || [], buyerAddress, vendorAddress, issued: Date.now(), lastUpdated: Date.now(), status, parentIssuanceId, clawbackEnabled, history: [...history, { ts: Date.now(), status, by: 'buyer' }]
});

export default function App() {
  const [mode, setMode] = useState<'customer' | 'vendor'>('customer');
  const [activeTab, setActiveTab] = useState<'create' | 'view' | 'scpoAction' | 'inventoryCatalog' | 'customerProfile' | 'vendorProfile' | 'admin'>('create');
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
  const [customerShareCode, setCustomerShareCode] = useState('');
  const [vendorShareCode, setVendorShareCode] = useState('');
  const [inputVendorCode, setInputVendorCode] = useState('');
  const [inputCustomerCode, setInputCustomerCode] = useState('');
  const [customerOnChainPassword, setCustomerOnChainPassword] = useState('');
  const [vendorOnChainPassword, setVendorOnChainPassword] = useState('');
  const [customerSharePassword, setCustomerSharePassword] = useState('');
  const [vendorSharePassword, setVendorSharePassword] = useState('');
  const [decryptVendorPassword, setDecryptVendorPassword] = useState('');
  const [decryptCustomerPassword, setDecryptCustomerPassword] = useState('');
  const [storedPasswords, setStoredPasswords] = useState<{ [uuid: string]: string }>({});
  const [selectedLinkedVendor, setSelectedLinkedVendor] = useState<PublicProfile | null>(null);
  const [selectedLinkedCustomer, setSelectedLinkedCustomer] = useState<PublicProfile | null>(null);
  const [vendorsExpanded, setVendorsExpanded] = useState(false);
  const [customersExpanded, setCustomersExpanded] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [postCustomerOnChain, setPostCustomerOnChain] = useState(false);
  const [postVendorOnChain, setPostVendorOnChain] = useState(false);
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
  const [updateResult, setUpdateResult] = useState('');

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

  useEffect(() => {
    const saved = localStorage.getItem('savedPOs');
    if (saved) try { setSavedPOs(JSON.parse(saved)); } catch { setSavedPOs([]); }
  }, []);

  const saveNewPO = (po: SavedPO) => {
    const updated = [...savedPOs, po];
    setSavedPOs(updated);
    localStorage.setItem('savedPOs', JSON.stringify(updated));
  };

  const updatePO = (updatedPO: SavedPO) => {
    const updated = savedPOs.map(p => p.id === updatedPO.id ? updatedPO : p);
    setSavedPOs(updated);
    localStorage.setItem('savedPOs', JSON.stringify(updated));
  };

  const updatePOStatus = (id: string, status: SavedPO['status']) => {
    const updated = savedPOs.map(p => p.id === id ? { ...p, status } : p);
    setSavedPOs(updated);
    localStorage.setItem('savedPOs', JSON.stringify(updated));
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
      if (po.status === 'accepted') {
        const password = storedPasswords[po.vendorUUID || ''];
        const poData: POData = { poName: po.poName, description: '', department: '', paymentTerms: '', deliveryTerms: '', items: [] };
        const ipfsUri = await uploadEncryptedToIPFS(poData, password);
        const fullMetadata = buildPOMetadata(po.poName, '', '', '', '', [], [], po.buyerAddress, po.vendorAddress, 'recalled', po.issuanceId, true, po.metadata?.history || []);
        const ledgerMetadata = buildLedgerMetadata(po.poName, ipfsUri, 'recalled');
        const mptCreate: any = {
          TransactionType: 'MPTokenIssuanceCreate',
          Account: wallet.classicAddress,
          MPTokenMetadata: xrpl.convertStringToHex(JSON.stringify(ledgerMetadata)),
          MaximumAmount: '1',
          AssetScale: 0,
          TransferFee: 0,
          Flags: xrpl.MPTokenIssuanceCreateFlags.tfMPTCanClawback
        };
        const preparedCreate = await client.autofill(mptCreate);
        preparedCreate.LastLedgerSequence = currentLedger + 20;
        const signedCreate = wallet.sign(preparedCreate);
        const createResult = await client.submitAndWait(signedCreate.tx_blob);
        const meta = createResult.result.meta as any;
        newIssuanceId = meta.mpt_issuance_id || po.issuanceId;
      }
      updatePO({ ...po, status: 'recalled', issuanceId: newIssuanceId, escrowSequence: undefined });
      alert('PO recalled on-chain.');
    } catch (err: any) { alert('Recall failed: ' + err.message); }
  };

  const deleteOpenPO = (id: string) => {
    if (window.confirm('Delete this Open SC.PO from your dashboard? (Local only)')) {
      const updated = savedPOs.filter(p => p.id !== id);
      setSavedPOs(updated);
      localStorage.setItem('savedPOs', JSON.stringify(updated));
    }
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
        if (mode === 'vendor') { const buyerUUID = vendorLinkedCustomerUUIDs.find(uuid => publicProfiles[uuid]?.classicAddress === po.buyerAddress); password = buyerUUID ? storedPasswords[buyerUUID] : null; } else { password = po.vendorUUID ? storedPasswords[po.vendorUUID] : null; }
        if (!password) throw new Error('No shared password found');
        const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
        if (!decrypted) throw new Error('Decryption failed');
        const poData: POData = JSON.parse(decrypted);
        setViewedPO(poData);
      }
    } catch (err: any) { setPoLoadError('Decryption failed: ' + err.message); }
  };

  const prefillFromPO = (po: SavedPO) => {
    setPoName(po.metadata.poName || po.poName);
    setDesc(po.metadata.description || '');
    setDepartment(po.metadata.department || '1');
    setPaymentTerms(po.metadata.paymentTerms || '');
    setDeliveryTerms(po.metadata.deliveryTerms || 'FOB');
    setItems(po.metadata.items || []);
  };

  const createSCPO = async () => {
    if (!poName) return alert('PO Name is required');
    if (!seed) return alert('Wallet seed required');
    if (!vendor) return alert('Vendor address required');
    if (!selectedVendorUUID || !storedPasswords[selectedVendorUUID]) return alert('Link vendor first');
    if (items.length === 0) return alert('Add at least one item');
    if (parseFloat(totalEscrowAmount) <= 0) return alert('Total > 0');
    if (!paymentTerms) return alert('Select Payment Terms');
    const xrpPriceUsd = await getXrpPriceUsd();
    const feeUsd = 0.01; const feeXrp = feeUsd / xrpPriceUsd; const feeDrops = xrpl.xrpToDrops(feeXrp.toFixed(6));
    let attachments: Attachment[] = [];
    if (selectedFiles && selectedFiles.length > 0) {
      setResult('Uploading attachments...');
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        try { const uri = await uploadFileToIPFS(file); attachments.push({ name: file.name, uri }); } catch (err: any) { alert('Failed to upload attachment: ' + err.message); return; }
      }
    }
    const poData: POData = { poName, description: desc, department, paymentTerms, deliveryTerms, items, attachments: attachments.length > 0 ? attachments : undefined };
    try {
      setResult('Encrypting and uploading PO data to IPFS...');
      const password = storedPasswords[selectedVendorUUID];
      const ipfsUri = await uploadEncryptedToIPFS(poData, password);
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      setResult(`Sending $0.01 creation fee...`);
      const feePayment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: process.env.REACT_APP_COMPANY_WALLET || '', Amount: feeDrops };
      const preparedFee = await client.autofill(feePayment); preparedFee.LastLedgerSequence = currentLedger + 20;
      const signedFee = wallet.sign(preparedFee);
      const feeResult = await client.submitAndWait(signedFee.tx_blob);
      if (typeof feeResult.result.meta === 'object' && feeResult.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Fee failed');
      setResult('Creating MPToken Issuance...');
      const fullMetadata = buildPOMetadata(poName, desc, department, paymentTerms, deliveryTerms, items, attachments, wallet.classicAddress, vendor, 'open', undefined, true);
      const ledgerMetadata = buildLedgerMetadata(poName, ipfsUri, 'open');
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
      const newPO: SavedPO = { id: Date.now().toString(), poName, dateIssued: new Date().toLocaleDateString(), total: totalEscrowAmount, ipfsUri, status: 'open', issuanceId, txHash, buyerAddress: wallet.classicAddress, vendorAddress: vendor, paymentTerms, vendorUUID: selectedVendorUUID, clawbackEnabled: true, metadata: fullMetadata };
      saveNewPO(newPO);
      const newFee: FeeEntry = { date: new Date().toLocaleString(), poName, amount: `$${feeUsd.toFixed(2)} USD (${feeXrp.toFixed(6)} XRP)`, txHash: feeResult.result.hash };
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
    const password = storedPasswords[selectedUpdatePO.vendorUUID || ''];
    if (!password) return alert('Vendor password missing');
    let attachments: Attachment[] = [];
    if (selectedFiles && selectedFiles.length > 0) {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        try { const uri = await uploadFileToIPFS(file); attachments.push({ name: file.name, uri }); } catch (err: any) { alert('Failed to upload attachment: ' + err.message); return; }
      }
    }
    const poData: POData = { poName, description: desc, department, paymentTerms, deliveryTerms, items, attachments: attachments.length > 0 ? attachments : undefined };
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
        await recallPO(selectedUpdatePO);
      }
      const fullMetadata = buildPOMetadata(poName, desc, department, paymentTerms, deliveryTerms, items, attachments, wallet.classicAddress, selectedUpdatePO.vendorAddress, 'open', selectedUpdatePO.issuanceId, true, selectedUpdatePO.metadata?.history || []);
      const ledgerMetadata = buildLedgerMetadata(poName, ipfsUri, 'open');
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
      const newPO: SavedPO = { id: Date.now().toString(), poName, dateIssued: new Date().toLocaleDateString(), total: totalEscrowAmount, ipfsUri, status: 'open', issuanceId, txHash, buyerAddress: wallet.classicAddress, vendorAddress: selectedUpdatePO.vendorAddress, paymentTerms, vendorUUID: selectedUpdatePO.vendorUUID, clawbackEnabled: true, parentIssuanceId: selectedUpdatePO.issuanceId, metadata: fullMetadata };
      saveNewPO(newPO);
      const memoData = xrpl.convertStringToHex(`PO Updated: ${poName} (v2) - Please re-accept.`);
      const memoPayment: Payment = { TransactionType: 'Payment', Account: wallet.classicAddress, Destination: selectedUpdatePO.vendorAddress, Amount: '1', Memos: [{ Memo: { MemoData: memoData, MemoType: xrpl.convertStringToHex('PO_UPDATE') } }] };
      const preparedMemo = await client.autofill(memoPayment); preparedMemo.LastLedgerSequence = currentLedger + 20;
      const signedMemo = wallet.sign(preparedMemo);
      await client.submitAndWait(signedMemo.tx_blob);
      setUpdateResult(`PO Updated and Sent Successfully! New Issuance: ${issuanceId}\nTx Hash: ${txHash}\n\nVendor notified to re-accept. Old version hidden.`);
      setSelectedUpdatePO(null);
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

  const fundEscrow = async (po: SavedPO) => {
    if (po.status === 'superseded') return alert('This PO version is superseded. Use the latest version.');
    const isHeld = await isMPTHeldByVendor(po.issuanceId, po.vendorAddress);
    if (!isHeld) return alert('Vendor has not accepted the MPT yet');
    if (!seed) return alert('Wallet seed required');
    const drops = xrpl.xrpToDrops(po.total);
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const closedLedgerResponse = await client.request({ command: 'ledger', ledger_index: 'closed' });
      const currentRippleTime = closedLedgerResponse.result.ledger.close_time;
      const days = parseInt(po.paymentTerms.split(' ')[0]);
      const buffer = 60; const finishRipple = currentRippleTime + (days * 86400) + buffer; const cancelRipple = finishRipple + (7 * 86400);
      const escrow: EscrowCreate = { TransactionType: 'EscrowCreate', Account: wallet.classicAddress, Destination: po.vendorAddress, Amount: drops, FinishAfter: finishRipple, CancelAfter: cancelRipple, Memos: [{ Memo: { MemoData: xrpl.convertStringToHex(`PO: ${po.poName}, MPT: ${po.issuanceId}`) } }] };
      const preparedEscrow = await client.autofill(escrow); preparedEscrow.LastLedgerSequence = currentLedger + 20;
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await client.submitAndWait(signedEscrow.tx_blob);
      if (typeof escrowResult.result.meta === 'object' && escrowResult.result.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Escrow creation failed');
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
      alert('Escrow funded & PO delivered! Sequence: ' + escrowSequence);
    } catch (err: any) { alert('Failed to fund escrow: ' + err.message); }
  };

  const claimEscrowForPO = async (po: SavedPO) => {
    if (po.status === 'superseded') return alert('This PO version is superseded. Use the latest version.');
    if (!vendorProfile.seed) return alert('Claim seed required');
    if (!po.escrowSequence) return alert('No escrow sequence');
    try {
      await fetchEscrowInfo(po.buyerAddress, po.escrowSequence);
      if (!isClaimable) { alert('Not yet claimable'); return; }
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const escrowFinish: EscrowFinish = { TransactionType: 'EscrowFinish', Account: wallet.classicAddress, Owner: po.buyerAddress, OfferSequence: po.escrowSequence };
      const prepared = await client.autofill(escrowFinish);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      alert(`Escrow claimed! Tx: ${result.result.hash}`);
      updatePOStatus(po.id, 'claimed');
    } catch (err: any) { alert('Claim failed: ' + err.message); }
  };

  const fetchEscrowInfo = async (owner: string, sequence: number) => {
    try {
      const client = await getXRPLClient();
      const response: any = await client.request({ command: 'ledger_entry', escrow: { owner, seq: sequence }, ledger_index: 'validated' });
      if (response.result.node && response.result.node.LedgerEntryType === 'Escrow') {
        const escrowObj = response.result.node; const rippleEpochStart = 946684800; const finishTime = new Date(((escrowObj as any).FinishAfter + rippleEpochStart) * 1000);
        setClaimableAfter(finishTime); setIsClaimable(new Date() >= finishTime);
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
    let candidates = savedPOs.filter(p => p.status !== 'superseded');

    const parentToChildren = new Map<string, SavedPO[]>();
    candidates.forEach(po => {
      if (po.parentIssuanceId) {
        if (!parentToChildren.has(po.parentIssuanceId)) parentToChildren.set(po.parentIssuanceId, []);
        parentToChildren.get(po.parentIssuanceId)!.push(po);
      }
    });

    const chainEnds = new Set<string>();
    candidates.forEach(startPo => {
      let current = startPo;
      const seen = new Set<string>();
      while (parentToChildren.has(current.issuanceId) && !seen.has(current.issuanceId)) {
        seen.add(current.issuanceId);
        const children = parentToChildren.get(current.issuanceId)!;
        if (children.length === 0) break;
        current = children.reduce((latest, child) => 
          (parseInt(child.id) > parseInt(latest.id) || new Date(child.dateIssued) > new Date(latest.dateIssued)) ? child : latest
        );
      }
      chainEnds.add(current.issuanceId);
    });

    const latest = candidates.filter(po => 
      chainEnds.has(po.issuanceId) && 
      po.status === status &&
      ((mode === 'customer' && po.buyerAddress === customerProfile.classicAddress) ||
       (mode === 'vendor' && po.vendorAddress === vendorProfile.classicAddress))
    );

    return sortPOsNewestFirst(latest);
  };

  const getUpdatablePOs = () => {
    const open = getLatestActivePOs('open');
    const accepted = getLatestActivePOs('accepted');
    return sortPOsNewestFirst([...open, ...accepted]);
  };

  const getVendorUpdatedPOs = () => {
    return sortPOsNewestFirst(getLatestActivePOs('open').filter(p => 
      p.vendorAddress === vendorProfile.classicAddress && p.parentIssuanceId
    ));
  };

  const getPOHistory = (po: SavedPO | null): SavedPO[] => {
    if (!po) return [];
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
    loadObject('storedPasswords', setStoredPasswords);
    loadArray('customerLinkedVendorUUIDs', setCustomerLinkedVendorUUIDs);
    loadArray('vendorLinkedCustomerUUIDs', setVendorLinkedCustomerUUIDs);
    const savedLinks = localStorage.getItem('profileLinks');
    if (savedLinks) try { setProfileLinks(JSON.parse(savedLinks)); } catch { setProfileLinks([]); }
    setCustomerOnChainPassword(localStorage.getItem('customerOnChainPassword') || '');
    setVendorOnChainPassword(localStorage.getItem('vendorOnChainPassword') || '');
    setCustomerSharePassword(localStorage.getItem('customerSharePassword') || '');
    setVendorSharePassword(localStorage.getItem('vendorSharePassword') || '');
    const savedTab = localStorage.getItem('activeTab');
    if (savedTab) setActiveTab(savedTab as any);
    const savedItems = localStorage.getItem('createItems');
    if (savedItems) try { setItems(JSON.parse(savedItems)); } catch { setItems([]); }
    const savedInventoryData = localStorage.getItem('savedInventory');
    if (savedInventoryData) try { setSavedInventory(JSON.parse(savedInventoryData)); } catch { setSavedInventory([]); }
    setHydrated(true);
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
  useEffect(() => { if (!hydrated) return; localStorage.setItem('storedPasswords', JSON.stringify(storedPasswords)); }, [storedPasswords, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('customerOnChainPassword', customerOnChainPassword); }, [customerOnChainPassword, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('vendorOnChainPassword', vendorOnChainPassword); }, [vendorOnChainPassword, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('customerSharePassword', customerSharePassword); }, [customerSharePassword, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('vendorSharePassword', vendorSharePassword); }, [vendorSharePassword, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('activeTab', activeTab); }, [activeTab, hydrated]);
  useEffect(() => { if (!hydrated) return; localStorage.setItem('createItems', JSON.stringify(items)); }, [items, hydrated]);

  const saveCustomerProfile = async () => {
    try {
      let updatedProfile = { ...customerProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      if (customerProfile.lastOnChainHash && contentHash === customerProfile.lastOnChainHash && !postCustomerOnChain) { console.log('No profile changes'); localStorage.setItem('customerProfile', JSON.stringify(updatedProfile)); return; }
      if (postCustomerOnChain) {
        const publicProfile: PublicProfile = { company: updatedProfile.company, name: updatedProfile.name, email: updatedProfile.email, phone: updatedProfile.phone, address: updatedProfile.address, city: updatedProfile.city, state: updatedProfile.state, zip: updatedProfile.zip, country: updatedProfile.country, uniqueID: updatedProfile.uniqueID, classicAddress: updatedProfile.classicAddress, profileUUID: updatedProfile.profileUUID, timestamp: Date.now(), walletHistory: updatedProfile.walletHistory };
        const newIpfsUri = await uploadEncryptedProfileToPinata(publicProfile, customerOnChainPassword);
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        const accountSet: AccountSet = { TransactionType: 'AccountSet', Account: wallet.classicAddress, Domain: xrpl.convertStringToHex(newIpfsUri) };
        const preparedSet = await client.autofill(accountSet);
        const signedSet = wallet.sign(preparedSet);
        await client.submitAndWait(signedSet.tx_blob);
        updatedProfile.ipfsUri = newIpfsUri; updatedProfile.lastOnChainHash = contentHash;
      }
      setCustomerProfile(updatedProfile); localStorage.setItem('customerProfile', JSON.stringify(updatedProfile));
      console.log('Profile saved' + (postCustomerOnChain ? ' and posted on-chain!' : ' locally!'));
    } catch (err: any) { alert('Failed to post update on-chain: ' + (err.message || String(err))); }
  };

  const saveVendorProfile = async () => {
    try {
      let updatedProfile = { ...vendorProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      if (vendorProfile.lastOnChainHash && contentHash === vendorProfile.lastOnChainHash && !postVendorOnChain) { console.log('No profile changes'); localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile)); return; }
      if (postVendorOnChain) {
        const publicProfile: PublicProfile = { company: updatedProfile.company, name: updatedProfile.name, email: updatedProfile.email, phone: updatedProfile.phone, address: updatedProfile.address, city: updatedProfile.city, state: updatedProfile.state, zip: updatedProfile.zip, country: updatedProfile.country, uniqueID: updatedProfile.uniqueID, classicAddress: updatedProfile.classicAddress, profileUUID: updatedProfile.profileUUID, timestamp: Date.now(), walletHistory: updatedProfile.walletHistory };
        const newIpfsUri = await uploadEncryptedProfileToPinata(publicProfile, vendorOnChainPassword);
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        const accountSet: AccountSet = { TransactionType: 'AccountSet', Account: wallet.classicAddress, Domain: xrpl.convertStringToHex(newIpfsUri) };
        const preparedSet = await client.autofill(accountSet);
        const signedSet = wallet.sign(preparedSet);
        await client.submitAndWait(signedSet.tx_blob);
        updatedProfile.ipfsUri = newIpfsUri; updatedProfile.lastOnChainHash = contentHash;
      }
      setVendorProfile(updatedProfile); localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile));
      console.log('Profile saved' + (postVendorOnChain ? ' and posted on-chain!' : ' locally!'));
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

  const generateCustomerShareCode = async () => {
    if (!customerSharePassword) return alert('Enter a password for encryption');
    const publicProfile: PublicProfile = { company: customerProfile.company, name: customerProfile.name, email: customerProfile.email, phone: customerProfile.phone, address: customerProfile.address, city: customerProfile.city, state: customerProfile.state, zip: customerProfile.zip, country: customerProfile.country, uniqueID: customerProfile.uniqueID, classicAddress: customerProfile.classicAddress, profileUUID: customerProfile.profileUUID, timestamp: Date.now(), walletHistory: customerProfile.walletHistory };
    try {
      const ipfsUri = await uploadEncryptedProfileToPinata(publicProfile, customerSharePassword);
      setCustomerShareCode(btoa(ipfsUri));
      alert('Share code generated!');
    } catch (err: any) { alert('Failed to generate code: ' + err.message); }
  };

  const generateVendorShareCode = async () => {
    if (!vendorSharePassword) return alert('Enter a password for encryption');
    const publicProfile: PublicProfile = { company: vendorProfile.company, name: vendorProfile.name, email: vendorProfile.email, phone: vendorProfile.phone, address: vendorProfile.address, city: vendorProfile.city, state: vendorProfile.state, zip: vendorProfile.zip, country: vendorProfile.country, uniqueID: vendorProfile.uniqueID, classicAddress: vendorProfile.classicAddress, profileUUID: vendorProfile.profileUUID, timestamp: Date.now(), walletHistory: vendorProfile.walletHistory };
    try {
      const ipfsUri = await uploadEncryptedProfileToPinata(publicProfile, vendorSharePassword);
      setVendorShareCode(btoa(ipfsUri));
      alert('Share code generated!');
    } catch (err: any) { alert('Failed to generate code: ' + err.message); }
  };

  const addLinkedVendor = async () => {
    if (!decryptVendorPassword) return alert('Enter decryption password');
    try {
      const ipfsUri = atob(inputVendorCode);
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptVendorPassword);
      decoded.ipfsUri = ipfsUri;
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles); localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!customerLinkedVendorUUIDs.includes(decoded.profileUUID)) { const updatedUUIDs = [...customerLinkedVendorUUIDs, decoded.profileUUID]; setCustomerLinkedVendorUUIDs(updatedUUIDs); localStorage.setItem('customerLinkedVendorUUIDs', JSON.stringify(updatedUUIDs)); }
      setStoredPasswords(prev => ({ ...prev, [decoded.profileUUID]: decryptVendorPassword }));
      setInputVendorCode(''); setDecryptVendorPassword('');
      alert('Vendor linked/updated! Password stored for auto-refreshes.');
      await recordLinkOnChain(customerProfile, decoded, true);
    } catch (err: any) { alert('Invalid code: ' + (err.message || 'Failed to fetch')); }
  };

  const addLinkedCustomer = async () => {
    if (!decryptCustomerPassword) return alert('Enter decryption password');
    try {
      const ipfsUri = atob(inputCustomerCode);
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptCustomerPassword);
      decoded.ipfsUri = ipfsUri;
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles); localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!vendorLinkedCustomerUUIDs.includes(decoded.profileUUID)) { const updatedUUIDs = [...vendorLinkedCustomerUUIDs, decoded.profileUUID]; setVendorLinkedCustomerUUIDs(updatedUUIDs); localStorage.setItem('vendorLinkedCustomerUUIDs', JSON.stringify(updatedUUIDs)); }
      setStoredPasswords(prev => ({ ...prev, [decoded.profileUUID]: decryptCustomerPassword }));
      setInputCustomerCode(''); setDecryptCustomerPassword('');
      alert('Customer linked/updated! Password stored for auto-refreshes.');
      await recordLinkOnChain(vendorProfile, decoded, false);
    } catch (err: any) { alert('Invalid code: ' + (err.message || 'Failed to fetch')); }
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
    if (!storedPasswords[uuid]) { setIsRefreshing(false); return; }
    const profile = publicProfiles[uuid];
    if (!profile) { setIsRefreshing(false); return; }
    let latest: PublicProfile | null = null; let latestUri = ''; let fetchFailed = false;
    const uniqueWallets = new Set([...(profile.walletHistory || []), profile.classicAddress]);
    const walletsToPoll = Array.from(uniqueWallets).filter(addr => xrpl.isValidAddress(addr));
    for (const walletAddr of walletsToPoll) {
      const uri = await getLatestProfileHashFromChain(walletAddr);
      if (uri && uri !== profile.ipfsUri) {
        try {
          const updated = await fetchAndDecryptProfileFromIPFS(uri, storedPasswords[uuid]);
          if (updated.profileUUID === uuid && (!latest || updated.timestamp > latest.timestamp)) { latest = updated; latestUri = uri; }
        } catch (err) { console.error('IPFS fetch failed during manual refresh:', err); fetchFailed = true; }
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
                <button onClick={createSCPO} disabled={!storedPasswords[selectedVendorUUID]} style={{ display: 'block', margin: '60px auto', width: '180px', height: '180px', borderRadius: '50%', background: 'linear-gradient(145deg, #F2B04A, #FFD98F)', color: 'white', fontSize: '28px', fontWeight: 'bold', border: '1.5px solid #D88F2E', boxShadow: scpoSuccess ? '0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5)' : '0 10px 30px rgba(212,175,55,0.4), inset 0 0 20px rgba(255,255,255,0.3)', cursor: 'pointer', transition: 'all 0.3s ease', animation: scpoSuccess ? 'scpoPulse 2s infinite' : 'none', opacity: !storedPasswords[selectedVendorUUID] ? 0.5 : 1 }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>{po.status} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>
                            <button onClick={() => { setSelectedUpdatePO(po); prefillFromPO(po); }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                        <tr key={po.id}>
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
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName} <span style={{ background: '#4CAF50', color: 'white', padding: '2px 8px', borderRadius: '12px', fontSize: '11px', marginLeft: '8px' }}>Latest</span></td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => fundEscrow(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                {(() => {
                  const currentViewedPO = customerScpoActionViewedPO;
                  const historyPOs = getPOHistory(selectedOpenPO || currentViewedPO as any);
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
                              <button onClick={async () => { await viewPOFromUri(hist.ipfsUri, hist, setCustomerScpoActionViewedPO, setCustomerScpoActionPoLoadError); }} style={{ marginLeft: '10px', background: '#F2B04A', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer' }}>
                                Load This Version
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
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
                        <tr key={po.id}>
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
                        <tr key={po.id}>
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
                {(() => {
                  const currentViewedPO = vendorScpoActionViewedPO;
                  const historyPOs = getPOHistory(selectedOpenPO || currentViewedPO as any);
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
                              <button onClick={async () => { await viewPOFromUri(hist.ipfsUri, hist, setVendorScpoActionViewedPO, setVendorScpoActionPoLoadError); }} style={{ marginLeft: '10px', background: '#F2B04A', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer' }}>
                                Load This Version
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
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
                      <QRCodeSVG value={`https://testnet.xrpl.org/nft/${selectedItem.nftId}`} size={128} />
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
            </div>

            {overviewSubTab === 'summary' && (
              <div>
                <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>{mode === 'customer' ? 'Customer SC.PO Summary' : 'Vendor SC.PO Summary'}</h2>
                <div style={{ display: 'flex', justifyContent: 'space-around', gap: '20px' }}>
                  {['Open', 'Accepted', 'Funded', 'Claimed'].map(status => {
                    const filteredPOs = getLatestActivePOs(status as SavedPO['status']);
                    const count = filteredPOs.length;
                    const totalValue = filteredPOs.reduce((sum, po) => sum + parseFloat(po.total || '0'), 0);
                    const formattedValue = totalValue >= 1000000 ? `$${Math.round(totalValue / 1000000)}M` : totalValue >= 1000 ? `$${Math.round(totalValue / 1000)}K` : `$${totalValue.toFixed(0)}`;
                    return (
                      <div key={status} style={{ textAlign: 'center', flex: 1 }}>
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
                          <tr key={po.id}>
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
                        {(() => {
                          const currentViewedPO = vendorOverviewViewedPO;
                          const historyPOs = getPOHistory(selectedOpenPO || currentViewedPO as any);
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
                                      <button onClick={async () => { await viewPOFromUri(hist.ipfsUri, hist, setVendorOverviewViewedPO, setVendorOverviewPoLoadError); }} style={{ marginLeft: '10px', background: '#F2B04A', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer' }}>
                                        Load This Version
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })()}
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
                              <tr key={po.id}>
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
                    <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Closed SC.PO</h3>
                    {getLatestActivePOs('claimed').length === 0 ? <p>No closed POs</p> : (
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
                              <tr key={po.id}>
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
                              <tr key={po.id}>
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
                              <tr key={po.id}>
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
                              <tr key={po.id}>
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
                    {(() => {
                      const currentViewedPO = mode === 'customer' ? customerViewViewedPO : vendorViewViewedPO;
                      return currentViewedPO?.attachments && currentViewedPO.attachments.length > 0 && (
                        <>
                          <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Attachments</h4>
                          <ul>
                            {currentViewedPO.attachments.map((att, i) => (
                              <li key={i}>
                                <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                                  {att.name}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </>
                      );
                    })()}
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
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Encryption Password for On-Chain Post (keep secret)</label>
                <input type="password" placeholder="Encryption Password for On-Chain Post (keep secret)" value={customerOnChainPassword} onChange={(e) => setCustomerOnChainPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 10px auto', display: 'block' }} />
                <label style={{ display: 'block', textAlign: 'center', marginBottom: '10px', color: '#666' }}>
                  <input type="checkbox" checked={postCustomerOnChain} onChange={(e) => setPostCustomerOnChain(e.target.checked)} />
                  Post update on-chain? (Requires password and funded wallet)
                </label>
                <button onClick={saveCustomerProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Save Profile
                </button>
                <label style={{ display: 'block', textAlign: 'center', color: '#666' }}>
                  <input type="checkbox" checked={autoRefreshEnabled} onChange={(e) => setAutoRefreshEnabled(e.target.checked)} />
                  Enable Auto-Refresh
                </label>
              </div>
            )}
            {customerProfileSubTab === 'links' && (
              <div>
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Generate Share Code</h3>
                <input type="password" placeholder="Encryption Password for Share Code (keep secret, share separately)" value={customerSharePassword} onChange={(e) => setCustomerSharePassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={generateCustomerShareCode} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate Code
                </button>
                {customerShareCode && (
                  <div style={{ textAlign: 'center' }}>
                    <pre style={{ background: '#f0f0f0', padding: '15px', display: 'inline-block', borderRadius: '15px', maxWidth: '600px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{customerShareCode}</pre>
                    <button onClick={() => copyToClipboard(customerShareCode, 'Share Code')} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      📋 Copy
                    </button>
                  </div>
                )}
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Add Linked Vendor</h3>
                <input placeholder="Enter Vendor Share Code" value={inputVendorCode} onChange={(e) => setInputVendorCode(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <input type="password" placeholder="Decryption Password" value={decryptVendorPassword} onChange={(e) => setDecryptVendorPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={addLinkedVendor} style={{ display: 'block', margin: '0 auto 40px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Add Vendor
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
                      <p><strong style={{ color: '#F2B04A' }}>On-chain Link Tx:</strong> <a href={`https://testnet.xrpl.org/transactions/${selectedLinkedVendor.linkTxHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
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
                <label style={{ display: 'block', marginBottom: '5px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Encryption Password for On-Chain Post (keep secret)</label>
                <input type="password" placeholder="Encryption Password for On-Chain Post (keep secret)" value={vendorOnChainPassword} onChange={(e) => setVendorOnChainPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 10px auto', display: 'block' }} />
                <label style={{ display: 'block', textAlign: 'center', marginBottom: '10px', color: '#666' }}>
                  <input type="checkbox" checked={postVendorOnChain} onChange={(e) => setPostVendorOnChain(e.target.checked)} />
                  Post update on-chain? (Requires password and funded wallet)
                </label>
                <button onClick={saveVendorProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Save Profile
                </button>
                <label style={{ display: 'block', textAlign: 'center', color: '#666' }}>
                  <input type="checkbox" checked={autoRefreshEnabled} onChange={(e) => setAutoRefreshEnabled(e.target.checked)} />
                  Enable Auto-Refresh
                </label>
              </div>
            )}
            {vendorProfileSubTab === 'links' && (
              <div>
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Generate Share Code</h3>
                <input type="password" placeholder="Encryption Password for Share Code (keep secret, share separately)" value={vendorSharePassword} onChange={(e) => setVendorSharePassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={generateVendorShareCode} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate Code
                </button>
                {vendorShareCode && (
                  <div style={{ textAlign: 'center' }}>
                    <pre style={{ background: '#f0f0f0', padding: '15px', display: 'inline-block', borderRadius: '15px', maxWidth: '600px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{vendorShareCode}</pre>
                    <button onClick={() => copyToClipboard(vendorShareCode, 'Share Code')} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      📋 Copy
                    </button>
                  </div>
                )}
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Add Linked Customer</h3>
                <input placeholder="Enter Customer Share Code" value={inputCustomerCode} onChange={(e) => setInputCustomerCode(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <input type="password" placeholder="Decryption Password" value={decryptCustomerPassword} onChange={(e) => setDecryptCustomerPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={addLinkedCustomer} style={{ display: 'block', margin: '0 auto 40px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Add Customer
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
                      <p><strong style={{ color: '#F2B04A' }}>On-chain Link Tx:</strong> <a href={`https://testnet.xrpl.org/transactions/${selectedLinkedCustomer.linkTxHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
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
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '40px' }}>Admin - Fee Dashboard</h2>
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
                            <a href={`https://testnet.xrpl.org/transactions/${entry.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>{entry.txHash.substring(0, 10)}...</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
