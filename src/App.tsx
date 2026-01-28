import React, { useState, useEffect, useRef } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, NFTokenMint, EscrowFinish, NFTokenCreateOffer, NFTokenAcceptOffer, Payment, AccountSet, Transaction, Memo, AccountTxResponse, AccountInfoResponse, AccountNFTsResponse, AccountNFToken } from 'xrpl';
import { Buffer } from 'buffer';
import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';
import { QRCodeSVG } from 'qrcode.react';

const getOrGenerateUUID = (key: string): string => {
  let uuid = localStorage.getItem(key);
  if (!uuid) {
    uuid = uuidv4();
    localStorage.setItem(key, uuid);
  }
  return uuid;
};

// Singleton XRPL Client
let xrplClient: xrpl.Client | null = null;
let connectingPromise: Promise<xrpl.Client> | null = null;
const getXRPLClient = async (): Promise<xrpl.Client> => {
  if (xrplClient?.isConnected()) return xrplClient;
  if (!connectingPromise) {
    connectingPromise = (async () => {
      const client = new xrpl.Client(
        'wss://s.altnet.rippletest.net:51233', // ✅ more stable than devnet
        { connectionTimeout: 20000 }
      );
      await client.connect();
      xrplClient = client;
      connectingPromise = null;
      return client;
    })();
  }
  return connectingPromise;
};

interface Item {
  num: string;
  qty: string;
  total: string;
}

interface Attachment {
  name: string;
  uri: string;
}

interface POData {
  poName: string;
  description: string;
  department: string;
  paymentTerms: string;
  deliveryTerms: string;
  items: Item[];
  attachments?: Attachment[];
}

interface SavedPO {
  id: string;
  poName: string;
  dateIssued: string;
  total: string;
  ipfsUri: string;
  status: 'Open' | 'Accepted' | 'Closed' | 'Funded';
  nftId: string;
  escrowSequence?: number; // Optional now, set after funding
  offerIndex: string;
  buyerAddress: string;
  vendorAddress: string;
  paymentTerms: string; // Added
  vendorUUID?: string; // Added for privacy
}

interface Profile {
  company: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  seed: string;
  classicAddress: string;
  uniqueID: string;
  profileUUID: string;
  walletHistory: string[];
  lastUpdateSource?: { postedBy: string; timestamp: number };
  lastOnChainHash?: string;
  ipfsUri?: string;
}

interface PublicProfile {
  company: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  uniqueID: string;
  classicAddress: string;
  profileUUID: string;
  timestamp: number;
  expiresAt?: number;
  ipfsUri?: string;
  linkTxHash?: string;
  walletHistory: string[];
  lastUpdateSource?: { postedBy: string; timestamp: number };
}

interface FeeEntry {
  date: string;
  poName: string;
  amount: string;
  txHash: string;
}

interface ProfileLink {
  linkerUUID: string;
  linkeeUUID: string;
  linkerAddress: string;
  linkeeAddress: string;
  txHash: string;
  createdAt: number;
}

// New interface for inventory items
interface InventoryItem {
  id: string;
  name: string;
  department: string;
  description: string;
  attachments: Attachment[]; // {name: 'Pricing', uri: 'ipfs://...'}, etc.
  nftId: string;
  ipfsUri: string;
  dateAdded: string;
}

export default function App() {
  const [mode, setMode] = useState<'customer' | 'vendor'>('customer');
  const [activeTab, setActiveTab] = useState<'create' | 'view' | 'scpoAction' | 'inventoryCatalog' | 'customerProfile' | 'vendorProfile' | 'admin'>('create');
  const [customerProfileSubTab, setCustomerProfileSubTab] = useState<'profile' | 'links'>('profile');
  const [vendorProfileSubTab, setVendorProfileSubTab] = useState<'profile' | 'links'>('profile');
  // Create Tab States
  const [poName, setPoName] = useState('');
  const [seed, setSeed] = useState('');
  const [vendor, setVendor] = useState('');
  const [selectedVendorUUID, setSelectedVendorUUID] = useState('');
  const [desc, setDesc] = useState('');
  const [department, setDepartment] = useState('1');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryTerms, setDeliveryTerms] = useState('FOB');
  const [result, setResult] = useState('');
  // Items
  const [items, setItems] = useState<Item[]>([]);
  const [newItemNum, setNewItemNum] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newTotal, setNewTotal] = useState('');
  const [totalEscrowAmount, setTotalEscrowAmount] = useState('0');
  // Attachments
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  // For SC.PO coin glow on success
  const [scpoSuccess, setScpoSuccess] = useState(false);
  // Admin tab state
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [feeEntries, setFeeEntries] = useState<FeeEntry[]>([]);
  const [feeSearchTerm, setFeeSearchTerm] = useState('');
  // View SC.PO state for "Show More"
  const [openExpanded, setOpenExpanded] = useState(false);
  const [acceptedExpanded, setAcceptedExpanded] = useState(false);
  const [fundedExpanded, setFundedExpanded] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);
  // Profile Links
  const [profileLinks, setProfileLinks] = useState<ProfileLink[]>([]);
  useEffect(() => {
    const total = items.reduce((sum, item) => sum + parseFloat(item.total || '0'), 0);
    setTotalEscrowAmount(total.toString());
  }, [items]);
  useEffect(() => {
    const savedFees = localStorage.getItem('feeEntries');
    if (savedFees) {
      try {
        setFeeEntries(JSON.parse(savedFees));
      } catch (e) {
        console.error('Failed to parse feeEntries:', e);
        setFeeEntries([]);
      }
    }
    const savedLinks = localStorage.getItem('profileLinks');
    if (savedLinks) {
      try {
        setProfileLinks(JSON.parse(savedLinks));
      } catch (e) {
        console.error('Failed to parse profileLinks:', e);
        setProfileLinks([]);
      }
    }
    const savedMode = localStorage.getItem('mode');
    if (savedMode) {
      setMode(savedMode as 'customer' | 'vendor');
    }
  }, []);
  useEffect(() => {
    localStorage.setItem('mode', mode);
  }, [mode]);
  const addItem = () => {
    if (newItemNum && newQty && newTotal) {
      setItems([...items, { num: newItemNum, qty: newQty, total: newTotal }]);
      setNewItemNum('');
      setNewQty('');
      setNewTotal('');
    }
  };
  const removeItem = (index: number) => setItems(items.filter((_, i) => i !== index));
  // Vendor Tab States
  const [claimSeed, setClaimSeed] = useState('');
  const [claimOwner, setClaimOwner] = useState('');
  const [claimOfferSequence, setClaimOfferSequence] = useState('');
  const [claimResult, setClaimResult] = useState('');
  const [vendorAcceptSeed, setVendorAcceptSeed] = useState('');
  const [offerIndex, setOfferIndex] = useState('');
  const [acceptResult, setAcceptResult] = useState('');
  const [selectedOpenPO, setSelectedOpenPO] = useState<SavedPO | null>(null);
  const [selectedFundedPO, setSelectedFundedPO] = useState<SavedPO | null>(null); // Changed from selectedAcceptedPO
  const [claimableAfter, setClaimableAfter] = useState<Date | null>(null);
  const [isClaimable, setIsClaimable] = useState(false);
  const [countdown, setCountdown] = useState('');
  // View Tab States
  const [ipfsUri, setIpfsUri] = useState('');
  // Saved POs
  const [savedPOs, setSavedPOs] = useState<SavedPO[]>([]);
  useEffect(() => {
    const saved = localStorage.getItem('savedPOs');
    if (saved) {
      try {
        setSavedPOs(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse savedPOs:', e);
        setSavedPOs([]);
      }
    }
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
  const updatePOStatus = (id: string, status: 'Accepted' | 'Closed' | 'Funded') => {
    const updated = savedPOs.map(p => p.id === id ? { ...p, status } : p);
    setSavedPOs(updated);
    localStorage.setItem('savedPOs', JSON.stringify(updated));
  };
  const deleteOpenPO = (id: string) => {
    if (window.confirm('Delete this Open SC.PO from your dashboard? (Local only – on-chain escrow and NFT remain unchanged)')) {
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
    const gateways = [
      `https://cloudflare-ipfs.com/ipfs/${hash}`,
      `https://ipfs.io/ipfs/${hash}`,
      `https://dweb.link/ipfs/${hash}`,
      `https://gateway.pinata.cloud/ipfs/${hash}`,
      `https://infura-ipfs.io/ipfs/${hash}`
    ];
    let encryptedData;
    for (const gatewayUrl of gateways) {
      try {
        console.log(`Trying IPFS gateway: ${gatewayUrl}`);
        const response = await fetch(gatewayUrl, { cache: 'no-store' });
        if (response.ok) {
          const data = await response.json();
          encryptedData = data.encryptedData;
          break;
        } else {
          console.warn(`Gateway ${gatewayUrl} returned status ${response.status}`);
        }
      } catch (err: any) {
        console.error(`Failed to fetch from ${gatewayUrl}:`, err.message);
      }
    }
    if (!encryptedData) {
      setPoLoadError('Failed to fetch from all IPFS gateways. Check your network/DNS or try later.');
      return;
    }
    try {
      let password;
      if (po) {
        if (mode === 'vendor') {
          const buyerUUID = vendorLinkedCustomerUUIDs.find(uuid => publicProfiles[uuid]?.classicAddress === po.buyerAddress);
          password = buyerUUID ? storedPasswords[buyerUUID] : null;
        } else {
          password = po.vendorUUID ? storedPasswords[po.vendorUUID] : null;
        }
        if (!password) throw new Error('No shared password found for this partner');
        const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
        if (!decrypted) throw new Error('Decryption failed - wrong password?');
        const poData: POData = JSON.parse(decrypted);
        setViewedPO(poData);
      } else {
        setPoLoadError('Retry failed - PO details not available');
      }
    } catch (err: any) {
      setPoLoadError('This PO is encrypted. You need the shared decryption password from when you linked this trading partner. Error: ' + err.message);
    }
  };
  const [customerProfile, setCustomerProfile] = useState<Profile>({
    company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: '', walletHistory: [], lastOnChainHash: ''
  });
  const [vendorProfile, setVendorProfile] = useState<Profile>({
    company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: '', walletHistory: [], lastOnChainHash: ''
  });
  const [publicProfiles, setPublicProfiles] = useState<{ [uuid: string]: PublicProfile }>({});
  const [customerLinkedVendorUUIDs, setCustomerLinkedVendorUUIDs] = useState<string[]>([]);
  const [vendorLinkedCustomerUUIDs, setVendorLinkedCustomerUUIDs] = useState<string[]>([]);
  const linkedVendors = customerLinkedVendorUUIDs.map(uuid => publicProfiles[uuid]).filter(Boolean);
  const linkedCustomers = vendorLinkedCustomerUUIDs.map(uuid => publicProfiles[uuid]).filter(Boolean);
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
  // New states for Inventory Catalog
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
  const [selectedItem, setSelectedItem] = useState<any | null>(null); // Changed to any for fetched data
  // New states for vendor inventories in customer mode
  const [vendorInventories, setVendorInventories] = useState<{ [vendorAddress: string]: InventoryItem[] }>({});
  const [selectedInventoryItem, setSelectedInventoryItem] = useState<string>('custom');
  // New states for PO inventory details
  const [customerScpoActionPoInventory, setCustomerScpoActionPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [vendorScpoActionPoInventory, setVendorScpoActionPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [customerViewPoInventory, setCustomerViewPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  const [vendorViewPoInventory, setVendorViewPoInventory] = useState<{[itemNum: string]: InventoryItem}>({});
  useEffect(() => {
    const loadProfile = (key: string, setProfile: React.Dispatch<React.SetStateAction<Profile>>) => {
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setProfile({...parsed, walletHistory: parsed.walletHistory || [], lastOnChainHash: parsed.lastOnChainHash || '', email: parsed.email || '', phone: parsed.phone || ''});
        } catch (e) {
          console.error(`Failed to parse ${key}:`, e);
          const newProfile = { company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: getOrGenerateUUID(`${key}UUID`), walletHistory: [], lastOnChainHash: '' };
          setProfile(newProfile);
          localStorage.setItem(key, JSON.stringify(newProfile));
        }
      } else {
        const newProfile = { company: '', name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: '', profileUUID: getOrGenerateUUID(`${key}UUID`), walletHistory: [], lastOnChainHash: '' };
        setProfile(newProfile);
        localStorage.setItem(key, JSON.stringify(newProfile));
      }
    };
    const loadObject = (key: string, setState: React.Dispatch<React.SetStateAction<any>>) => {
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setState(parsed);
        } catch (e) {
          console.error(`Failed to parse ${key}:`, e);
          setState({});
        }
      }
    };
    const loadArray = (key: string, setState: React.Dispatch<React.SetStateAction<string[]>>) => {
      const saved = localStorage.getItem(key);
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setState(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          console.error(`Failed to parse ${key}:`, e);
          setState([]);
        }
      }
    };
    loadProfile('customerProfile', setCustomerProfile);
    loadProfile('vendorProfile', setVendorProfile);
    loadObject('publicProfiles', setPublicProfiles);
    loadObject('storedPasswords', setStoredPasswords);
    loadArray('customerLinkedVendorUUIDs', setCustomerLinkedVendorUUIDs);
    loadArray('vendorLinkedCustomerUUIDs', setVendorLinkedCustomerUUIDs);
    const savedLinks = localStorage.getItem('profileLinks');
    if (savedLinks) {
      try {
        setProfileLinks(JSON.parse(savedLinks));
      } catch (e) {
        console.error('Failed to parse profileLinks:', e);
        setProfileLinks([]);
      }
    }
    setCustomerOnChainPassword(localStorage.getItem('customerOnChainPassword') || '');
    setVendorOnChainPassword(localStorage.getItem('vendorOnChainPassword') || '');
    setCustomerSharePassword(localStorage.getItem('customerSharePassword') || '');
    setVendorSharePassword(localStorage.getItem('vendorSharePassword') || '');
    const savedTab = localStorage.getItem('activeTab');
    if (savedTab) {
      setActiveTab(savedTab as any);
    }
    const savedItems = localStorage.getItem('createItems');
    if (savedItems) {
      try {
        setItems(JSON.parse(savedItems));
      } catch (e) {
        console.error('Failed to parse createItems:', e);
        setItems([]);
      }
    }
    // Load saved inventory
    const savedInventory = localStorage.getItem('savedInventory');
    if (savedInventory) {
      try {
        setSavedInventory(JSON.parse(savedInventory));
      } catch (e) {
        console.error('Failed to parse savedInventory:', e);
        setSavedInventory([]);
      }
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const links = JSON.parse(localStorage.getItem('profileLinks') || '[]');
    const customerVendors = new Set<string>();
    const vendorCustomers = new Set<string>();
    links.forEach((l: ProfileLink) => {
      if (l.linkerUUID === customerProfile.profileUUID) {
        customerVendors.add(l.linkeeUUID);
      }
      if (l.linkerUUID === vendorProfile.profileUUID) {
        vendorCustomers.add(l.linkeeUUID);
      }
    });
    setCustomerLinkedVendorUUIDs(Array.from(customerVendors));
    setVendorLinkedCustomerUUIDs(Array.from(vendorCustomers));
  }, [hydrated, profileLinks, customerProfile.profileUUID, vendorProfile.profileUUID]);
  useEffect(() => {
    if (customerProfile.seed) setSeed(customerProfile.seed);
    if (vendorProfile.seed) {
      setVendorAcceptSeed(vendorProfile.seed);
      setClaimSeed(vendorProfile.seed);
    }
  }, [customerProfile, vendorProfile]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('publicProfiles', JSON.stringify(publicProfiles));
  }, [publicProfiles, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('customerLinkedVendorUUIDs', JSON.stringify(customerLinkedVendorUUIDs));
  }, [customerLinkedVendorUUIDs, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('vendorLinkedCustomerUUIDs', JSON.stringify(vendorLinkedCustomerUUIDs));
  }, [vendorLinkedCustomerUUIDs, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('profileLinks', JSON.stringify(profileLinks));
  }, [profileLinks, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('storedPasswords', JSON.stringify(storedPasswords));
  }, [storedPasswords, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('customerOnChainPassword', customerOnChainPassword);
  }, [customerOnChainPassword, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('vendorOnChainPassword', vendorOnChainPassword);
  }, [vendorOnChainPassword, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('customerSharePassword', customerSharePassword);
  }, [customerSharePassword, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('vendorSharePassword', vendorSharePassword);
  }, [vendorSharePassword, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab, hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem('createItems', JSON.stringify(items));
  }, [items, hydrated]);
  useEffect(() => {
    if (!hydrated || !autoRefreshEnabled || (activeTab !== 'customerProfile' && activeTab !== 'vendorProfile')) return;
    const refreshAllFn = async () => {
      if (isRefreshing) return;
      setIsRefreshing(true);
      try {
        for (const uuid of customerLinkedVendorUUIDs) {
          if (!storedPasswords[uuid]) continue;
          const profile = publicProfiles[uuid];
          if (profile) {
            let latest: PublicProfile | null = null;
            let latestUri = '';
            let fetchFailed = false;
            const uniqueWallets = new Set([...(profile.walletHistory || []), profile.classicAddress]);
            const walletsToPoll = Array.from(uniqueWallets).filter(addr => xrpl.isValidAddress(addr));
            for (const walletAddr of walletsToPoll) {
              const uri = await getLatestProfileHashFromChain(walletAddr);
              if (uri && uri !== profile.ipfsUri) {
                try {
                  const updated = await fetchAndDecryptProfileFromIPFS(uri, storedPasswords[uuid]);
                  if (updated.profileUUID === uuid && (!latest || updated.timestamp > latest.timestamp)) {
                    latest = updated;
                    latestUri = uri;
                  }
                } catch (err) {
                  console.error('IPFS fetch failed during auto-refresh:', err);
                  fetchFailed = true;
                }
              }
            }
            if (latest !== null) {
              const localHash = await hashProfileContent(profile);
              const chainHash = await hashProfileContent(latest);
              if (localHash !== chainHash) {
                const updatedProfile: PublicProfile = {
                  ...profile,
                  ...latest,
                  ipfsUri: latestUri,
                  linkTxHash: profile.linkTxHash
                };
                setPublicProfiles(prev => ({ ...prev, [uuid]: updatedProfile }));
                localStorage.setItem('publicProfiles', JSON.stringify({ ...publicProfiles, [uuid]: updatedProfile }));
                console.log(`Auto-updated profile for UUID ${uuid}`);
              }
            } else if (fetchFailed) {
              console.log(`Profile update found on-chain for UUID ${uuid}, but failed to fetch data.`);
            }
          }
        }
        for (const uuid of vendorLinkedCustomerUUIDs) {
          if (!storedPasswords[uuid]) continue;
          const profile = publicProfiles[uuid];
          if (profile) {
            let latest: PublicProfile | null = null;
            let latestUri = '';
            let fetchFailed = false;
            const uniqueWallets = new Set([...(profile.walletHistory || []), profile.classicAddress]);
            const walletsToPoll = Array.from(uniqueWallets).filter(addr => xrpl.isValidAddress(addr));
            for (const walletAddr of walletsToPoll) {
              const uri = await getLatestProfileHashFromChain(walletAddr);
              if (uri && uri !== profile.ipfsUri) {
                try {
                  const updated = await fetchAndDecryptProfileFromIPFS(uri, storedPasswords[uuid]);
                  if (updated.profileUUID === uuid && (!latest || updated.timestamp > latest.timestamp)) {
                    latest = updated;
                    latestUri = uri;
                  }
                } catch (err) {
                  console.error('IPFS fetch failed during auto-refresh:', err);
                  fetchFailed = true;
                }
              }
            }
            if (latest !== null) {
              const localHash = await hashProfileContent(profile);
              const chainHash = await hashProfileContent(latest);
              if (localHash !== chainHash) {
                const updatedProfile: PublicProfile = {
                  ...profile,
                  ...latest,
                  ipfsUri: latestUri,
                  linkTxHash: profile.linkTxHash
                };
                setPublicProfiles(prev => ({ ...prev, [uuid]: updatedProfile }));
                localStorage.setItem('publicProfiles', JSON.stringify({ ...publicProfiles, [uuid]: updatedProfile }));
                console.log(`Auto-updated profile for UUID ${uuid}`);
              }
            } else if (fetchFailed) {
              console.log(`Profile update found on-chain for UUID ${uuid}, but failed to fetch data.`);
            }
          }
        }
      } catch (err) {
        console.error('Refresh all error:', err);
      } finally {
        setIsRefreshing(false);
      }
    };
    refreshAllFn();
    refreshIntervalRef.current = setInterval(refreshAllFn, 30000);
    return () => {
      if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current);
    };
  }, [hydrated, activeTab, autoRefreshEnabled, customerLinkedVendorUUIDs, vendorLinkedCustomerUUIDs, publicProfiles, storedPasswords]);
  const getLatestProfileHashFromChain = async (address: string): Promise<string | null> => {
    try {
      const client = await getXRPLClient();
      const response: AccountInfoResponse = await client.request({
        command: 'account_info',
        account: address,
        ledger_index: 'validated'
      });
      const domainHex = response.result.account_data.Domain;
      if (domainHex) {
        return xrpl.convertHexToString(domainHex);
      }
      return null;
    } catch (err) {
      console.error('Account info query failed:', err);
      return null;
    }
  };
  const hashProfileContent = async (profile: any): Promise<string> => {
    const { ipfsUri, lastOnChainHash, ...contentOnly } = profile;
    const canonical = JSON.stringify(
      contentOnly,
      Object.keys(contentOnly).sort()
    );
    const buffer = new TextEncoder().encode(canonical);
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };
  const saveCustomerProfile = async () => {
    try {
      let updatedProfile = { ...customerProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      if (customerProfile.lastOnChainHash && contentHash === customerProfile.lastOnChainHash && !postCustomerOnChain) {
        console.log('No profile changes detected — skipping on-chain update');
        localStorage.setItem('customerProfile', JSON.stringify(updatedProfile));
        return;
      }
      if (postCustomerOnChain) {
        const publicProfile: PublicProfile = {
          company: updatedProfile.company,
          name: updatedProfile.name,
          email: updatedProfile.email,
          phone: updatedProfile.phone,
          address: updatedProfile.address,
          city: updatedProfile.city,
          state: updatedProfile.state,
          zip: updatedProfile.zip,
          country: updatedProfile.country,
          uniqueID: updatedProfile.uniqueID,
          classicAddress: updatedProfile.classicAddress,
          profileUUID: updatedProfile.profileUUID,
          timestamp: Date.now(),
          walletHistory: updatedProfile.walletHistory
        };
        const newIpfsUri = await uploadEncryptedProfileToPinata(publicProfile, customerOnChainPassword);
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        const accountSet: AccountSet = {
          TransactionType: 'AccountSet',
          Account: wallet.classicAddress,
          Domain: xrpl.convertStringToHex(newIpfsUri)
        };
        const preparedSet = await client.autofill(accountSet);
        const signedSet = wallet.sign(preparedSet);
        await client.submitAndWait(signedSet.tx_blob);
        updatedProfile.ipfsUri = newIpfsUri;
        updatedProfile.lastOnChainHash = contentHash;
      }
      setCustomerProfile(updatedProfile);
      localStorage.setItem('customerProfile', JSON.stringify(updatedProfile));
      console.log('Profile saved' + (postCustomerOnChain ? ' and posted on-chain!' : ' locally!'));
    } catch (err: any) {
      console.error('Save profile error:', err);
      alert('Failed to post update on-chain: ' + (err.message || String(err)));
    }
  };
  const saveVendorProfile = async () => {
    try {
      let updatedProfile = { ...vendorProfile };
      const contentHash = await hashProfileContent(updatedProfile);
      if (vendorProfile.lastOnChainHash && contentHash === vendorProfile.lastOnChainHash && !postVendorOnChain) {
        console.log('No profile changes detected — skipping on-chain update');
        localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile));
        return;
      }
      if (postVendorOnChain) {
        const publicProfile: PublicProfile = {
          company: updatedProfile.company,
          name: updatedProfile.name,
          email: updatedProfile.email,
          phone: updatedProfile.phone,
          address: updatedProfile.address,
          city: updatedProfile.city,
          state: updatedProfile.state,
          zip: updatedProfile.zip,
          country: updatedProfile.country,
          uniqueID: updatedProfile.uniqueID,
          classicAddress: updatedProfile.classicAddress,
          profileUUID: updatedProfile.profileUUID,
          timestamp: Date.now(),
          walletHistory: updatedProfile.walletHistory
        };
        const newIpfsUri = await uploadEncryptedProfileToPinata(publicProfile, vendorOnChainPassword);
        const client = await getXRPLClient();
        const wallet = xrpl.Wallet.fromSeed(updatedProfile.seed);
        const accountSet: AccountSet = {
          TransactionType: 'AccountSet',
          Account: wallet.classicAddress,
          Domain: xrpl.convertStringToHex(newIpfsUri)
        };
        const preparedSet = await client.autofill(accountSet);
        const signedSet = wallet.sign(preparedSet);
        await client.submitAndWait(signedSet.tx_blob);
        updatedProfile.ipfsUri = newIpfsUri;
        updatedProfile.lastOnChainHash = contentHash;
      }
      setVendorProfile(updatedProfile);
      localStorage.setItem('vendorProfile', JSON.stringify(updatedProfile));
      console.log('Profile saved' + (postVendorOnChain ? ' and posted on-chain!' : ' locally!'));
    } catch (err: any) {
      console.error('Save profile error:', err);
      alert('Failed to post update on-chain: ' + (err.message || String(err)));
    }
  };
  const uploadEncryptedProfileToPinata = async (profile: PublicProfile, password: string) => {
    if (!password) throw new Error('Password required for encryption');
    const profileData = { ...profile }; // No expiresAt for permanent links
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(profileData), password).toString();
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pinataApiKey}`,
      },
      body: JSON.stringify({ encryptedData: encrypted }),
    });
    if (!response.ok) throw new Error('Pinata upload failed');
    const result = await response.json();
    return `ipfs://${result.IpfsHash}`;
  };
  const fetchAndDecryptProfileFromIPFS = async (uri: string, password: string): Promise<PublicProfile> => {
    const hash = uri.replace('ipfs://', '');
    const gateways = [
      `https://ipfs.io/ipfs/${hash}`,
      `https://gateway.pinata.cloud/ipfs/${hash}`,
      `https://dweb.link/ipfs/${hash}`,
      `https://cloudflare-ipfs.com/ipfs/${hash}`,
      `https://infura-ipfs.io/ipfs/${hash}`
    ];
    let response;
    for (const gatewayUrl of gateways) {
      for (let retry = 0; retry < 3; retry++) {
        try {
          response = await fetch(gatewayUrl, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
          if (response.ok) {
            const { encryptedData } = await response.json();
            const decrypted = CryptoJS.AES.decrypt(encryptedData, password).toString(CryptoJS.enc.Utf8);
            if (!decrypted) throw new Error('Decryption failed - wrong password?');
            const profile: PublicProfile = JSON.parse(decrypted);
            return profile;
          }
        } catch (err) {
          console.error(`Failed with gateway ${gatewayUrl} (attempt ${retry + 1}):`, err);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    throw new Error('Failed to fetch from all IPFS gateways after retries');
  };
  const generateCustomerShareCode = async () => {
    if (!customerSharePassword) return alert('Enter a password for encryption');
    const publicProfile: PublicProfile = {
      company: customerProfile.company,
      name: customerProfile.name,
      email: customerProfile.email,
      phone: customerProfile.phone,
      address: customerProfile.address,
      city: customerProfile.city,
      state: customerProfile.state,
      zip: customerProfile.zip,
      country: customerProfile.country,
      uniqueID: customerProfile.uniqueID,
      classicAddress: customerProfile.classicAddress,
      profileUUID: customerProfile.profileUUID,
      timestamp: Date.now(),
      walletHistory: customerProfile.walletHistory
    };
    try {
      const ipfsUri = await uploadEncryptedProfileToPinata(publicProfile, customerSharePassword);
      setCustomerShareCode(btoa(ipfsUri));
      alert('Share code generated!');
    } catch (err: any) {
      console.error('Generate share code error:', err);
      alert('Failed to generate code: ' + err.message);
    }
  };
  const generateVendorShareCode = async () => {
    if (!vendorSharePassword) return alert('Enter a password for encryption');
    const publicProfile: PublicProfile = {
      company: vendorProfile.company,
      name: vendorProfile.name,
      email: vendorProfile.email,
      phone: vendorProfile.phone,
      address: vendorProfile.address,
      city: vendorProfile.city,
      state: vendorProfile.state,
      zip: vendorProfile.zip,
      country: vendorProfile.country,
      uniqueID: vendorProfile.uniqueID,
      classicAddress: vendorProfile.classicAddress,
      profileUUID: vendorProfile.profileUUID,
      timestamp: Date.now(),
      walletHistory: vendorProfile.walletHistory
    };
    try {
      const ipfsUri = await uploadEncryptedProfileToPinata(publicProfile, vendorSharePassword);
      setVendorShareCode(btoa(ipfsUri));
      alert('Share code generated!');
    } catch (err: any) {
      console.error('Generate share code error:', err);
      alert('Failed to generate code: ' + err.message);
    }
  };
  const addLinkedVendor = async () => {
    if (!decryptVendorPassword) return alert('Enter decryption password');
    try {
      const ipfsUri = atob(inputVendorCode);
      if (!ipfsUri) throw new Error('Invalid share code');
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptVendorPassword);
      decoded.ipfsUri = ipfsUri;
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles);
      localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!customerLinkedVendorUUIDs.includes(decoded.profileUUID)) {
        const updatedUUIDs = [...customerLinkedVendorUUIDs, decoded.profileUUID];
        setCustomerLinkedVendorUUIDs(updatedUUIDs);
        localStorage.setItem('customerLinkedVendorUUIDs', JSON.stringify(updatedUUIDs));
      }
      setStoredPasswords(prev => ({ ...prev, [decoded.profileUUID]: decryptVendorPassword }));
      setInputVendorCode('');
      setDecryptVendorPassword('');
      alert('Vendor linked/updated! Password stored for auto-refreshes.');
      await recordLinkOnChain(customerProfile, decoded, true);
    } catch (err: any) {
      console.error('Linking error:', err);
      alert('Invalid code: ' + (err.message || 'Failed to fetch'));
    }
  };
  const addLinkedCustomer = async () => {
    if (!decryptCustomerPassword) return alert('Enter decryption password');
    try {
      const ipfsUri = atob(inputCustomerCode);
      if (!ipfsUri) throw new Error('Invalid share code');
      let decoded = await fetchAndDecryptProfileFromIPFS(ipfsUri, decryptCustomerPassword);
      decoded.ipfsUri = ipfsUri;
      const newProfiles = { ...publicProfiles, [decoded.profileUUID]: decoded };
      setPublicProfiles(newProfiles);
      localStorage.setItem('publicProfiles', JSON.stringify(newProfiles));
      if (!vendorLinkedCustomerUUIDs.includes(decoded.profileUUID)) {
        const updatedUUIDs = [...vendorLinkedCustomerUUIDs, decoded.profileUUID];
        setVendorLinkedCustomerUUIDs(updatedUUIDs);
        localStorage.setItem('vendorLinkedCustomerUUIDs', JSON.stringify(updatedUUIDs));
      }
      setStoredPasswords(prev => ({ ...prev, [decoded.profileUUID]: decryptCustomerPassword }));
      setInputCustomerCode('');
      setDecryptCustomerPassword('');
      alert('Customer linked/updated! Password stored for auto-refreshes.');
      await recordLinkOnChain(vendorProfile, decoded, false);
    } catch (err: any) {
      console.error('Linking error:', err);
      alert('Invalid code: ' + (err.message || 'Failed to fetch'));
    }
  };
  useEffect(() => {
    if (customerLinkedVendorUUIDs.length > 0) {
      const latestUUID = customerLinkedVendorUUIDs[customerLinkedVendorUUIDs.length - 1];
      if (publicProfiles[latestUUID]) manualRefreshProfile(latestUUID);
    }
  }, [customerLinkedVendorUUIDs, publicProfiles]);
  useEffect(() => {
    if (vendorLinkedCustomerUUIDs.length > 0) {
      const latestUUID = vendorLinkedCustomerUUIDs[vendorLinkedCustomerUUIDs.length - 1];
      if (publicProfiles[latestUUID]) manualRefreshProfile(latestUUID);
    }
  }, [vendorLinkedCustomerUUIDs, publicProfiles]);
  const recordLinkOnChain = async (linker: Profile, linkee: PublicProfile, isVendor: boolean) => {
    if (!linker.seed) return alert('Wallet seed required for on-chain record');
    if (!linker.classicAddress) return alert('Linker wallet address required');
    if (!linkee.classicAddress || !xrpl.isValidAddress(linkee.classicAddress)) return alert('Invalid linkee wallet address - must be a valid r-address');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(linker.seed);
      const memoData = xrpl.convertStringToHex(JSON.stringify({ type: 'link', profileUUID: linkee.profileUUID, ipfsUri: linkee.ipfsUri }));
      const payment: Payment = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: linkee.classicAddress,
        Amount: '1', // 1 drop
        Memos: [{ Memo: { MemoData: memoData, MemoType: xrpl.convertStringToHex('link') } }]
      };
      const prepared = await client.autofill(payment);
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      if (typeof result.result.meta === 'object' && result.result.meta.TransactionResult === 'tesSUCCESS') {
        const updatedProfile = { ...linkee, linkTxHash: result.result.hash };
        const newProfiles = { ...publicProfiles, [linkee.profileUUID]: updatedProfile };
        setPublicProfiles(newProfiles);
        const newLink: ProfileLink = {
          linkerUUID: linker.profileUUID,
          linkeeUUID: linkee.profileUUID,
          linkerAddress: linker.classicAddress,
          linkeeAddress: linkee.classicAddress,
          txHash: result.result.hash,
          createdAt: Date.now()
        };
        const updatedLinks = [...profileLinks, newLink];
        setProfileLinks(updatedLinks);
        localStorage.setItem('profileLinks', JSON.stringify(updatedLinks));
        alert('Link recorded on-chain! Tx Hash: ' + result.result.hash);
      } else {
        alert('Failed to record link on-chain');
      }
    } catch (err: any) {
      console.error('Record link error:', err);
      alert('Failed to record on-chain: ' + err.message);
    }
  };
  const verifyLink = async (profileA: { classicAddress: string; profileUUID: string }, profileB: { classicAddress: string; profileUUID: string }) => {
    const link = profileLinks.find(l =>
      ((l.linkerUUID === profileA.profileUUID && l.linkeeUUID === profileB.profileUUID) ||
       (l.linkerUUID === profileB.profileUUID && l.linkeeUUID === profileA.profileUUID)) &&
      ((l.linkerAddress === profileA.classicAddress && l.linkeeAddress === profileB.classicAddress) ||
       (l.linkerAddress === profileB.classicAddress && l.linkeeAddress === profileA.classicAddress))
    );
    if (!link) {
      alert('No link found to verify');
      return false;
    }
    try {
      const client = await getXRPLClient();
      const tx = await client.request({ command: 'tx', transaction: link.txHash });
      if (tx.result.validated) {
        alert('Link verified on-chain!');
        return true;
      } else {
        alert('Link not validated on-chain yet – try again later');
        return false;
      }
    } catch (err: any) {
      console.error('Verify failed:', err);
      alert('Verification failed: ' + (err.message || 'Connection issue – try again'));
      return false;
    }
  };
  const manualRefreshProfile = async (uuid: string) => {
    if (!hydrated || isRefreshing) return;
    setIsRefreshing(true);
    if (!storedPasswords[uuid]) {
      setIsRefreshing(false);
      return;
    }
    const profile = publicProfiles[uuid];
    if (!profile) {
      setIsRefreshing(false);
      return;
    }
    let latest: PublicProfile | null = null;
    let latestUri = '';
    let fetchFailed = false;
    const uniqueWallets = new Set([...(profile.walletHistory || []), profile.classicAddress]);
    const walletsToPoll = Array.from(uniqueWallets).filter(addr => xrpl.isValidAddress(addr));
    for (const walletAddr of walletsToPoll) {
      const uri = await getLatestProfileHashFromChain(walletAddr);
      if (uri && uri !== profile.ipfsUri) {
        try {
          const updated = await fetchAndDecryptProfileFromIPFS(uri, storedPasswords[uuid]);
          if (updated.profileUUID === uuid && (!latest || updated.timestamp > latest.timestamp)) {
            latest = updated;
            latestUri = uri;
          }
        } catch (err) {
          console.error('IPFS fetch failed during manual refresh:', err);
          fetchFailed = true;
        }
      }
    }
    if (latest !== null) {
      const localHash = await hashProfileContent(profile);
      const chainHash = await hashProfileContent(latest);
      if (localHash !== chainHash) {
        const updatedProfile: PublicProfile = {
          ...profile,
          ...latest,
          ipfsUri: latestUri,
          linkTxHash: profile.linkTxHash
        };
        setPublicProfiles(prev => ({ ...prev, [uuid]: updatedProfile }));
        localStorage.setItem('publicProfiles', JSON.stringify({ ...publicProfiles, [uuid]: updatedProfile }));
        console.log('Profile refreshed successfully!');
      } else {
        console.log('Profile content unchanged.');
      }
    } else {
      if (fetchFailed) {
        console.log('Failed to fetch profile data from IPFS.');
      } else {
        console.log('No profile URI found on chain.');
      }
    }
    setIsRefreshing(false);
  };
  const handleRefresh = (uuid: string) => {
    manualRefreshProfile(uuid);
  };
  const uploadFileToIPFS = async (file: File): Promise<string> => {
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pinataApiKey}`,
      },
      body: formData,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`File upload failed: ${errorText}`);
    }
    const result = await response.json();
    return `ipfs://${result.IpfsHash}`;
  };
  const uploadEncryptedToIPFS = async (data: any, password: string) => {
    if (!password) throw new Error('Password required for encryption');
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), password).toString();
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing – check .env file');
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pinataApiKey}`,
      },
      body: JSON.stringify({ encryptedData: encrypted }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinata upload failed: ${errorText || response.statusText}`);
    }
    const result = await response.json();
    return `ipfs://${result.IpfsHash}`;
  };
  // New: Upload unencrypted JSON to IPFS for inventory (public catalog)
  const uploadToIPFS = async (data: any) => {
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing');
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pinataApiKey}`,
      },
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinata upload failed: ${errorText}`);
    }
    const result = await response.json();
    return `ipfs://${result.IpfsHash}`;
  };
  // New: Fetch unencrypted inventory from IPFS
  const fetchFromIPFS = async (uri: string): Promise<any> => {
    const hash = uri.replace('ipfs://', '');
    const gateways = [
      `https://cloudflare-ipfs.com/ipfs/${hash}`,
      `https://ipfs.io/ipfs/${hash}`,
      `https://dweb.link/ipfs/${hash}`,
      `https://gateway.pinata.cloud/ipfs/${hash}`,
      `https://infura-ipfs.io/ipfs/${hash}`
    ];
    for (const gatewayUrl of gateways) {
      try {
        const response = await fetch(gatewayUrl, { cache: 'no-store' });
        if (response.ok) {
          return await response.json();
        }
      } catch (err) {
        console.error(`Failed to fetch from ${gatewayUrl}:`, err);
      }
    }
    throw new Error('Failed to fetch from all IPFS gateways');
  };
  const getXrpPriceUsd = async (): Promise<number> => {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd');
      const data = await response.json();
      return data.ripple.usd;
    } catch (err) {
      console.error('Failed to fetch XRP price:', err);
      return 0.5; // fallback price if API fails
    }
  };
  const createSCPO = async () => {
    if (!poName) return alert('PO Name is required');
    if (!seed) return alert('Wallet seed required');
    if (!vendor) return alert('Vendor address required');
    if (!selectedVendorUUID || !storedPasswords[selectedVendorUUID]) return alert('You must first link this vendor with a decryption password to create secure POs. Go to Profile → Links.');
    if (items.length === 0) return alert('Add at least one item');
    if (parseFloat(totalEscrowAmount) <= 0) return alert('Total amount must be greater than 0');
    if (!paymentTerms) return alert('Select Payment Terms');
    const xrpPriceUsd = await getXrpPriceUsd();
    const feeUsd = 0.01;
    const feeXrp = feeUsd / xrpPriceUsd;
    const feeDrops = xrpl.xrpToDrops(feeXrp.toFixed(6));
    let attachments: Attachment[] = [];
    if (selectedFiles && selectedFiles.length > 0) {
      setResult('Uploading attachments...');
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        try {
          const uri = await uploadFileToIPFS(file);
          attachments.push({ name: file.name, uri });
        } catch (err: any) {
          alert('Failed to upload attachment: ' + err.message);
          return;
        }
      }
    }
    const poData: POData = {
      poName,
      description: desc,
      department,
      paymentTerms,
      deliveryTerms,
      items,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    try {
      setResult('Encrypting and uploading PO data to IPFS...');
      const password = storedPasswords[selectedVendorUUID];
      const ipfsUri = await uploadEncryptedToIPFS(poData, password);
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      setResult(`Sending $0.01 creation fee (${feeXrp.toFixed(6)} XRP)...`);
      const feePayment: Payment = {
        TransactionType: 'Payment',
        Account: wallet.classicAddress,
        Destination: process.env.REACT_APP_COMPANY_WALLET || '',
        Amount: feeDrops,
      };
      const preparedFee = await client.autofill(feePayment);
      preparedFee.LastLedgerSequence = currentLedger + 20;
      const signedFee = wallet.sign(preparedFee);
      const feeResult = await client.submitAndWait(signedFee.tx_blob);
      if (typeof feeResult.result.meta !== 'object' || feeResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error('Fee payment failed');
      }
      const nft: NFTokenMint = {
        TransactionType: 'NFTokenMint',
        Account: wallet.classicAddress,
        URI: xrpl.convertStringToHex(ipfsUri),
        Flags: 8,
        NFTokenTaxon: 0,
      };
      const preparedNFT = await client.autofill(nft);
      preparedNFT.LastLedgerSequence = currentLedger + 20;
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await client.submitAndWait(signedNFT.tx_blob);
      if (typeof nftResult.result.meta !== 'object' || nftResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        setResult('NFT Mint failed');
        return;
      }
      let justMintedNFT = 'unknown';
      const mintedNode = (nftResult.result.meta as any).AffectedNodes.find((node: any) => node.CreatedNode?.LedgerEntryType === 'NFTokenPage');
      if (mintedNode) {
        const tokens = mintedNode.CreatedNode.NewFields.NFTokens || [];
        justMintedNFT = tokens[tokens.length - 1]?.NFToken?.NFTokenID || 'unknown';
      }
      if (justMintedNFT === 'unknown') {
        const nftsResp = await client.request({ command: 'account_nfts', account: wallet.classicAddress });
        justMintedNFT = nftsResp.result.account_nfts[nftsResp.result.account_nfts.length - 1]?.NFTokenID || 'unknown';
      }
      const offerTx: NFTokenCreateOffer = {
        TransactionType: 'NFTokenCreateOffer',
        Account: wallet.classicAddress,
        NFTokenID: justMintedNFT,
        Amount: '0',
        Flags: 1,
        Destination: vendor
      };
      const preparedOffer = await client.autofill(offerTx);
      preparedOffer.LastLedgerSequence = currentLedger + 20;
      const signedOffer = wallet.sign(preparedOffer);
      const offerResult = await client.submitAndWait(signedOffer.tx_blob);
      let offerIndex = 'unknown';
      if (typeof offerResult.result.meta === 'object' && offerResult.result.meta.TransactionResult === 'tesSUCCESS') {
        const created = (offerResult.result.meta as any).AffectedNodes.find((node: any) => node.CreatedNode && node.CreatedNode.LedgerEntryType === 'NFTokenOffer');
        if (created?.CreatedNode?.NewFields?.nft_offer_index) {
          offerIndex = created.CreatedNode.NewFields.nft_offer_index;
        }
      }
      if (offerIndex === 'unknown') {
        try {
          const offersResp = await client.request({ command: 'nft_sell_offers', nft_id: justMintedNFT });
          const offers = offersResp.result.offers || [];
          const ourOffer = offers.find((o: any) => o.owner === wallet.classicAddress && o.amount === '0');
          if (ourOffer && ourOffer.nft_offer_index) {
            offerIndex = ourOffer.nft_offer_index;
          }
        } catch (e) { /* ignore */ }
      }
      const newPO: SavedPO = {
        id: Date.now().toString(),
        poName,
        dateIssued: new Date().toLocaleDateString(),
        total: totalEscrowAmount,
        ipfsUri,
        status: 'Open',
        nftId: justMintedNFT,
        offerIndex,
        buyerAddress: wallet.classicAddress,
        vendorAddress: vendor,
        paymentTerms,
        vendorUUID: selectedVendorUUID
      };
      saveNewPO(newPO);
      const newFee: FeeEntry = {
        date: new Date().toLocaleString(),
        poName,
        amount: `$${feeUsd.toFixed(2)} USD (${feeXrp.toFixed(6)} XRP)`,
        txHash: feeResult.result.hash
      };
      const updatedFees = [...feeEntries, newFee];
      setFeeEntries(updatedFees);
      localStorage.setItem('feeEntries', JSON.stringify(updatedFees));
      setResult(
        `SC.PO Offer Created Successfully! (Escrow not funded yet - wait for vendor acceptance)\n` +
        `PO details are encrypted and private — only you and the linked vendor can read them.\n` +
        `Fee of $0.01 USD sent to company wallet.\n` +
        `PO Name: ${poName}\n` +
        `Total Amount (to fund later): $${totalEscrowAmount}\n` +
        `NFT ID: ${justMintedNFT}\n` +
        `IPFS URI: ${ipfsUri}\n` +
        `OfferIndex: ${offerIndex}\n` +
        `Once vendor accepts, fund the escrow in View tab.` +
        (attachments.length > 0 ? `\n${attachments.length} attachment(s) uploaded.` : '')
      );
      setScpoSuccess(true);
      setTimeout(() => setScpoSuccess(false), 3000);
      setItems([]);
      localStorage.removeItem('createItems');
    } catch (err: any) {
      console.error('Create SCPO error:', err);
      alert('Operation failed: ' + err.message);
      setResult('Error: ' + err.message);
    }
  };
  const isNFTOwnedByVendor = async (nftId: string, vendorAddress: string) => {
    try {
      const client = await getXRPLClient();
      const response = await client.request({
        command: 'account_nfts',
        account: vendorAddress,
        ledger_index: 'validated'
      });
      return response.result.account_nfts.some((nft: any) => nft.NFTokenID === nftId);
    } catch (err) {
      console.error('Check NFT ownership error:', err);
      return false;
    }
  };
  const fundEscrow = async (po: SavedPO) => {
    if (!po.nftId) return alert('No NFT ID found');
    const isOwned = await isNFTOwnedByVendor(po.nftId, po.vendorAddress);
    if (!isOwned) return alert('Vendor has not accepted the NFT yet');
    if (!seed) return alert('Wallet seed required');
    const drops = xrpl.xrpToDrops(po.total);
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const closedLedgerResponse = await client.request({
        command: 'ledger',
        ledger_index: 'closed'
      });
      const currentRippleTime = closedLedgerResponse.result.ledger.close_time;
      const days = parseInt(po.paymentTerms.split(' ')[0]);
      const buffer = 60; // 1 min buffer
      const finishRipple = currentRippleTime + (days * 86400) + buffer;
      const cancelRipple = finishRipple + (7 * 86400); // 7 days after finish
      const escrow: EscrowCreate = {
        TransactionType: 'EscrowCreate',
        Account: wallet.classicAddress,
        Destination: po.vendorAddress,
        Amount: drops,
        FinishAfter: finishRipple,
        CancelAfter: cancelRipple,
        Memos: [{ Memo: { MemoData: xrpl.convertStringToHex(`PO: ${po.poName}, NFT: ${po.nftId}`) } }]
      };
      const preparedEscrow = await client.autofill(escrow);
      preparedEscrow.LastLedgerSequence = currentLedger + 20;
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await client.submitAndWait(signedEscrow.tx_blob);
      if (typeof escrowResult.result.meta !== 'object' || escrowResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        throw new Error('Escrow creation failed');
      }
      const escrowSequence = escrowResult.result.tx_json.Sequence as number;
      const updatedPO: SavedPO = { ...po, escrowSequence, status: 'Funded' };
      updatePO(updatedPO);
      alert('Escrow funded successfully! Sequence: ' + escrowSequence);
    } catch (err: any) {
      console.error('Fund escrow error:', err);
      alert('Failed to fund escrow: ' + err.message);
    }
  };
  const acceptNFTForPO = async (po: SavedPO) => {
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    try {
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const acceptTx: NFTokenAcceptOffer = {
        TransactionType: 'NFTokenAcceptOffer',
        Account: wallet.classicAddress,
        NFTokenSellOffer: po.offerIndex,
      };
      const prepared = await client.autofill(acceptTx);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const acceptResultTx = await client.submitAndWait(signed.tx_blob);
      const meta = acceptResultTx.result.meta as any;
      if (meta && meta.TransactionResult === 'tesSUCCESS') {
        alert(`"${po.poName}" NFT Accepted! Tx Hash: ${acceptResultTx.result.hash}`);
        updatePOStatus(po.id, 'Accepted');
      } else {
        alert(`Accept failed: ${meta?.TransactionResult || 'unknown error'}`);
      }
    } catch (err: any) {
      console.error('Accept NFT error:', err);
      alert('Accept failed: ' + err.message);
    }
  };
  const claimEscrowForPO = async (po: SavedPO) => {
    if (!vendorProfile.seed) return alert('Claim seed required');
    if (!po.escrowSequence) return alert('No escrow sequence - PO not funded');
    try {
      await fetchEscrowInfo(po.buyerAddress, po.escrowSequence);
      if (!isClaimable) {
        alert('Not yet claimable');
        return;
      }
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const escrowFinish: EscrowFinish = {
        TransactionType: 'EscrowFinish',
        Account: wallet.classicAddress,
        Owner: po.buyerAddress,
        OfferSequence: po.escrowSequence,
      };
      const prepared = await client.autofill(escrowFinish);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      alert(`"${po.poName}" Escrow claimed! Tx Hash: ${result.result.hash}`);
      updatePOStatus(po.id, 'Closed');
    } catch (err: any) {
      console.error('Claim escrow error:', err);
      alert('Claim failed: ' + err.message);
    }
  };
  const fetchEscrowInfo = async (owner: string, sequence: number) => {
    try {
      const client = await getXRPLClient();
      const response: any = await client.request({
        command: 'ledger_entry',
        escrow: {
          owner: owner,
          seq: sequence
        },
        ledger_index: 'validated'
      });
      if (response.result.node && response.result.node.LedgerEntryType === 'Escrow') {
        const escrowObj = response.result.node;
        const rippleEpochStart = 946684800;
        const finishTime = new Date(((escrowObj as any).FinishAfter + rippleEpochStart) * 1000);
        setClaimableAfter(finishTime);
        setIsClaimable(new Date() >= finishTime);
      } else {
        setClaimableAfter(null);
        setIsClaimable(false);
        alert('Escrow not found - may be already claimed or canceled.');
      }
    } catch (err: any) {
      console.error('Fetch escrow error:', err);
      if (err.data?.error === 'entryNotFound') {
        setClaimableAfter(null);
        setIsClaimable(false);
        alert('Escrow not found - may be already claimed or canceled.');
      } else {
        alert('Failed to fetch escrow info.');
      }
    }
  };
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (claimableAfter && !isClaimable) {
      interval = setInterval(() => {
        const now = new Date();
        const diff = claimableAfter.getTime() - now.getTime();
        if (diff <= 0) {
          setIsClaimable(true);
          setCountdown('Claimable now');
          if (interval) clearInterval(interval);
        } else {
          const days = Math.floor(diff / (1000 * 60 * 60 * 24));
          const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          const seconds = Math.floor((diff % (1000 * 60)) / 1000);
          setCountdown(`${days}d ${hours}h ${minutes}m ${seconds}s`);
        }
      }, 1000);
    } else if (isClaimable) {
      setCountdown('Claimable now');
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [claimableAfter, isClaimable]);
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    alert(`${label} copied to clipboard!`);
  };
  const getOfferIndexFromResult = () => result.match(/OfferIndex: (.*)/)?.[1] || '';
  const getEscrowSequenceFromResult = () => result.match(/Escrow Sequence: (.*)/)?.[1] || '';
  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'scale(1.05)';
    e.currentTarget.style.boxShadow = '0 8px 20px rgba(0,0,0,0.2)';
  };
  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'scale(1)';
    e.currentTarget.style.boxShadow = e.currentTarget.dataset.originalShadow || '0 4px 10px rgba(0,0,0,0.1)';
  };
  const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'scale(0.98)';
  };
  const handleMouseUp = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.transform = 'scale(1.05)';
  };
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      @keyframes scpoPulse {
        0% { box-shadow: 0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5); }
        50% { box-shadow: 0 0 50px #FFD700, 0 0 80px #FFA500, inset 0 0 30px rgba(255,255,255,0.7); }
        100% { box-shadow: 0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5); }
      }
    `;
    document.head.appendChild(style);
    return () => {
      if (document.head.contains(style)) {
        document.head.removeChild(style);
      }
    };
  }, []);
  const sortPOsNewestFirst = (pos: SavedPO[]) => pos.sort((a, b) => parseInt(b.id) - parseInt(a.id));
  const sortFeesNewestFirst = (fees: FeeEntry[]) => fees.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const filteredFees = sortFeesNewestFirst(feeEntries.filter(entry =>
    entry.poName.toLowerCase().includes(feeSearchTerm.toLowerCase()) ||
    entry.date.toLowerCase().includes(feeSearchTerm.toLowerCase())
  ));
  const isOutdated = (profile: PublicProfile) => profile.expiresAt && Date.now() > profile.expiresAt + (30 * 24 * 60 * 60 * 1000); // >30 days after expiration
  const getFilteredPOs = (status: string) => {
    return sortPOsNewestFirst(savedPOs.filter(p => {
      if (mode === 'customer') {
        return p.status === status && p.buyerAddress === customerProfile.classicAddress;
      } else {
        return p.status === status && p.vendorAddress === vendorProfile.classicAddress;
      }
    }));
  };
  const getTimeRemaining = (po: SavedPO) => {
    const issueDate = new Date(po.dateIssued);
    const days = parseInt(po.paymentTerms.split(' ')[0]);
    const claimDate = new Date(issueDate.getTime() + days * 86400000);
    const now = new Date();
    const diff = claimDate.getTime() - now.getTime();
    if (diff <= 0) {
      return <span style={{ color: 'green' }}>Claimable</span>;
    }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return `${d}d ${h}h ${m}m`;
  };
  const isWithin24HoursOfClaimable = (po: SavedPO) => {
    const issueDate = new Date(po.dateIssued);
    const days = parseInt(po.paymentTerms.split(' ')[0]);
    const claimDate = new Date(issueDate.getTime() + days * 86400000);
    const now = new Date();
    return now >= new Date(claimDate.getTime() - 24 * 3600000);
  };
  const isPOClaimableOrOverdue = (po: SavedPO) => {
    const issueDate = new Date(po.dateIssued);
    const days = parseInt(po.paymentTerms.split(' ')[0]);
    const claimDate = new Date(issueDate.getTime() + days * 86400000);
    const now = new Date();
    const overdueDate = new Date(claimDate.getTime() + 24 * 3600000);
    return now >= claimDate || now >= overdueDate;
  };
  const tabs = mode === 'customer' ? [
    { label: 'Create', key: 'create' },
    { label: 'Action', key: 'scpoAction' },
    { label: 'View', key: 'view' },
    { label: 'Profile', key: 'customerProfile' },
    { label: 'Admin', key: 'admin' }
  ] : [
    { label: 'View', key: 'view' },
    { label: 'Action', key: 'scpoAction' },
    { label: 'Inventory', key: 'inventoryCatalog' },
    { label: 'Profile', key: 'vendorProfile' },
    { label: 'Admin', key: 'admin' }
  ];
  // New: Save inventory to localStorage
  const saveNewInventory = (item: InventoryItem) => {
    const updated = [...savedInventory, item];
    setSavedInventory(updated);
    localStorage.setItem('savedInventory', JSON.stringify(updated));
  };
  // New: View inventory details from IPFS, merging with local nftId
  const viewInventoryFromUri = async (uri: string, localItem: InventoryItem) => {
    try {
      const data = await fetchFromIPFS(uri);
      setSelectedItem({ ...data, nftId: localItem.nftId }); // Merge to include nftId
    } catch (err: any) {
      alert('Failed to load inventory: ' + err.message);
    }
  };
  // New: Fetch vendor's inventory NFTs from XRPL
  const fetchVendorInventory = async (vendorAddress: string): Promise<InventoryItem[]> => {
    try {
      const client = await getXRPLClient();
      const response = await client.request({
        command: 'account_nfts',
        account: vendorAddress,
        ledger_index: 'validated'
      }) as AccountNFTsResponse;
      const inventoryNFTs: xrpl.AccountNFToken[] = response.result.account_nfts.filter((nft: xrpl.AccountNFToken) => nft.NFTokenTaxon === 1);
      const items: InventoryItem[] = [];
      for (const nft of inventoryNFTs) {
        if (nft.URI) {
          const ipfsUri = xrpl.convertHexToString(nft.URI);
          const data = await fetchFromIPFS(ipfsUri);
          items.push({
            id: nft.NFTokenID,
            nftId: nft.NFTokenID,
            ipfsUri,
            dateAdded: 'Unknown', // Not stored on-chain; could add memo in future
            ...data
          });
        }
      }
      return items;
    } catch (err) {
      console.error('Fetch vendor inventory error:', err);
      return [];
    }
  };
  // New: Load vendor inventory when selecting vendor in create tab
  useEffect(() => {
    if (mode === 'customer' && activeTab === 'create' && vendor) {
      (async () => {
        const inv = await fetchVendorInventory(vendor);
        setVendorInventories(prev => ({ ...prev, [vendor]: inv }));
      })();
    }
  }, [vendor, mode, activeTab]);
  // Load inventory for viewed PO
  const loadPoInventory = async (viewedPO: POData, savedPO: SavedPO, setPoInventory: React.Dispatch<React.SetStateAction<{[itemNum: string]: InventoryItem}>>) => {
    if (!vendorInventories[savedPO.vendorAddress]) {
      const inv = await fetchVendorInventory(savedPO.vendorAddress);
      setVendorInventories(prev => ({ ...prev, [savedPO.vendorAddress]: inv }));
    }
    const inventory = vendorInventories[savedPO.vendorAddress] || [];
    const poInv: {[itemNum: string]: InventoryItem} = {};
    viewedPO.items.forEach(item => {
      const matchingInv = inventory.find(invItem => invItem.name === item.num);
      if (matchingInv) {
        poInv[item.num] = matchingInv;
      }
    });
    setPoInventory(poInv);
  };
  useEffect(() => {
    if (customerScpoActionViewedPO && selectedOpenPO) {
      loadPoInventory(customerScpoActionViewedPO, selectedOpenPO, setCustomerScpoActionPoInventory);
    }
  }, [customerScpoActionViewedPO, selectedOpenPO]);
  useEffect(() => {
    if (vendorScpoActionViewedPO && selectedOpenPO) {
      loadPoInventory(vendorScpoActionViewedPO, selectedOpenPO, setVendorScpoActionPoInventory);
    }
  }, [vendorScpoActionViewedPO, selectedOpenPO]);
  useEffect(() => {
    if (customerViewViewedPO && selectedFundedPO) {
      loadPoInventory(customerViewViewedPO, selectedFundedPO, setCustomerViewPoInventory);
    }
  }, [customerViewViewedPO, selectedFundedPO]);
  useEffect(() => {
    if (vendorViewViewedPO && selectedFundedPO) {
      loadPoInventory(vendorViewViewedPO, selectedFundedPO, setVendorViewPoInventory);
    }
  }, [vendorViewViewedPO, selectedFundedPO]);
  // New: Generate inventory token
  const generateInventory = async () => {
    if (!invName) return alert('Name required');
    if (!vendorProfile.seed) return alert('Vendor wallet seed required');
    if (!vendorProfile.classicAddress) return alert('Vendor wallet address required');
    let attachments: Attachment[] = [];
    const files = [
      { file: invPricingFile, name: 'Pricing' },
      { file: invDesignFile, name: 'Design' },
      { file: invBomFile, name: 'BOM' },
      { file: invUsageFile, name: 'Usage' }
    ];
    for (const { file, name } of files) {
      if (file) {
        try {
          const uri = await uploadFileToIPFS(file);
          attachments.push({ name: `${name}_${file.name}`, uri });
        } catch (err: any) {
          alert(`Failed to upload ${name} file: ` + err.message);
          return;
        }
      }
    }
    const invData = {
      name: invName,
      department: invDepartment,
      description: invDesc,
      attachments
    };
    try {
      setInvResult('Uploading inventory data to IPFS...');
      const ipfsUri = await uploadToIPFS(invData); // Unencrypted for public catalog
      const client = await getXRPLClient();
      const wallet = xrpl.Wallet.fromSeed(vendorProfile.seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const nft: NFTokenMint = {
        TransactionType: 'NFTokenMint',
        Account: wallet.classicAddress,
        URI: xrpl.convertStringToHex(ipfsUri),
        Flags: 8, // Transferable
        NFTokenTaxon: 1 // Differentiate from PO NFTs
      };
      const preparedNFT = await client.autofill(nft);
      preparedNFT.LastLedgerSequence = currentLedger + 20;
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await client.submitAndWait(signedNFT.tx_blob);
      if (typeof nftResult.result.meta !== 'object' || nftResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        setInvResult('NFT Mint failed');
        return;
      }
      let nftId = 'unknown';
      const mintedNode = (nftResult.result.meta as any).AffectedNodes.find((node: any) => node.CreatedNode?.LedgerEntryType === 'NFTokenPage');
      if (mintedNode) {
        const tokens = mintedNode.CreatedNode.NewFields.NFTokens || [];
        nftId = tokens[tokens.length - 1]?.NFToken?.NFTokenID || 'unknown';
      }
      if (nftId === 'unknown') {
        const nftsResp = await client.request({ command: 'account_nfts', account: wallet.classicAddress });
        nftId = nftsResp.result.account_nfts[nftsResp.result.account_nfts.length - 1]?.NFTokenID || 'unknown';
      }
      const newItem: InventoryItem = {
        id: Date.now().toString(),
        name: invName,
        department: invDepartment,
        description: invDesc,
        attachments,
        nftId,
        ipfsUri,
        dateAdded: new Date().toLocaleDateString()
      };
      saveNewInventory(newItem);
      setInvResult(`Inventory Item Created! NFT ID: ${nftId}\nIPFS URI: ${ipfsUri}`);
      // Reset form
      setInvName('');
      setInvDepartment('');
      setInvDesc('');
      setInvPricingFile(null);
      setInvDesignFile(null);
      setInvBomFile(null);
      setInvUsageFile(null);
    } catch (err: any) {
      console.error('Generate inventory error:', err);
      setInvResult('Error: ' + err.message);
    }
  };
  // New: Sort inventory newest first
  const sortInventoryNewestFirst = (items: InventoryItem[]) => items.sort((a, b) => parseInt(b.id) - parseInt(a.id));
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f5f5f5', fontFamily: 'Helvetica, Arial, sans-serif' }}>
      {/* Fixed Left Sidebar */}
      <div style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: '190px',
        height: '100vh',
        background: 'linear-gradient(90deg, #D88F2E 0%, #FBC85F 55%, #FFEBB8 100%)',
        padding: '20px',
        borderTopRightRadius: '28px',
        borderBottomRightRadius: '28px',
        overflow: 'visible',
        zIndex: 10
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '40px' }}>
          <span style={{ color: '#FFFFFF', fontWeight: 'bold', marginRight: '10px' }}>{mode === 'customer' ? 'Customer' : 'Vendor'}</span>
          <div style={{ position: 'relative', width: '60px', height: '30px', background: 'linear-gradient(to right, #D88F2E, #FBC85F)', borderRadius: '999px', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)', border: '1px solid rgba(255,255,255,0.55)' }}>
            <span
              onClick={() => setMode(mode === 'customer' ? 'vendor' : 'customer')}
              style={{
                position: 'absolute',
                left: mode === 'customer' ? '0' : '30px',
                width: '30px',
                height: '30px',
                background: '#FFF6DC',
                borderRadius: '50%',
                transition: 'left 0.3s ease',
                boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                cursor: 'pointer'
              }}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              style={{
                height: '62px',
                padding: '0 28px',
                background: activeTab === tab.key
                  ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                  : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                color: '#FFFFFF',
                border: '1.5px solid #D88F2E',
                borderRadius: '999px',
                fontSize: '18px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.18s ease-out',
                marginRight: '-20px',
                zIndex: 2,
                opacity: 1,
                filter: activeTab === tab.key ? 'none' : 'brightness(1.1) saturate(0.8)',
                boxShadow: activeTab === tab.key
                  ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                  : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
                transform: activeTab === tab.key ? 'translateX(1px)' : 'none'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.filter = activeTab === tab.key ? 'brightness(1.05)' : 'brightness(1.15) saturate(0.8)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.filter = activeTab === tab.key ? 'none' : 'brightness(1.1) saturate(0.8)';
              }}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      {/* Main Content */}
      <div style={{ marginLeft: '190px', flex: 1, padding: '40px', background: '#FFF2D6', minHeight: '100vh', overflowY: 'auto' }}>
        <h1 style={{ color: '#F2B04A', textAlign: 'center', fontSize: '36px', marginBottom: '30px' }}>SC.PO Generator</h1>
        {activeTab === 'create' && mode === 'customer' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '40px' }}>Create SC.PO Offer (Fund after Acceptance)</h2>
            <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>PO Name (for tracking)</label>
            <input
              style={{
                width: '100%',
                maxWidth: '600px',
                padding: '15px',
                borderRadius: '30px',
                border: '2px solid #D88F2E',
                margin: '0 auto 50px auto',
                display: 'block'
              }}
              placeholder="e.g. Widget Order Dec 2025"
              value={poName}
              onChange={(e) => setPoName(e.target.value)}
            />
            <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold', textAlign: 'center' }}>Description</label>
            <textarea
              style={{
                width: '100%',
                maxWidth: '600px',
                padding: '15px',
                borderRadius: '30px',
                border: '2px solid #D88F2E',
                margin: '0 auto 60px auto',
                display: 'block',
                height: '120px',
                resize: 'vertical'
              }}
              placeholder="Enter description (optional)"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '50px', maxWidth: '900px', margin: '0 auto 60px auto' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold' }}>Customer Link</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', background: '#f0f0f0' }} value="Linked" readOnly />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Department</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }} value={department} onChange={(e) => setDepartment(e.target.value)} />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Vendor Link</label>
                <select
                  style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }}
                  onChange={(e) => {
                    const selectedOption = e.target.options[e.target.selectedIndex];
                    setVendor(selectedOption.value);
                    setSelectedVendorUUID(selectedOption.dataset.uuid || '');
                  }}
                >
                  <option value="">Select Linked Vendor</option>
                  {linkedVendors.map(v => (
                    <option key={v.profileUUID} value={v.classicAddress} data-uuid={v.profileUUID}>{v.uniqueID} - {v.name}</option>
                  ))}
                </select>
                {!storedPasswords[selectedVendorUUID] && selectedVendorUUID && (
                  <p style={{ color: '#e74c3c', textAlign: 'center', marginTop: '10px' }}>
                    You must first link this vendor with a decryption password to create secure POs. Go to Profile → Links.
                  </p>
                )}
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '10px', color: '#F2B04A', fontWeight: 'bold' }}>RFP Link</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', background: '#f0f0f0' }} value="Linked" readOnly />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#F2B04A', fontWeight: 'bold' }}>Payment Terms</label>
                <select
                  style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E' }}
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                >
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
                <select
                  value={selectedInventoryItem}
                  onChange={(e) => {
                    setSelectedInventoryItem(e.target.value);
                    setNewItemNum(e.target.value === 'custom' ? '' : e.target.value);
                  }}
                  style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', flex: 1 }}
                >
                  <option value="custom">Custom Item #</option>
                  {vendorInventories[vendor].map(item => (
                    <option key={item.nftId} value={item.name}>{item.name}</option>
                  ))}
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
                <ul>
                  {Array.from(selectedFiles).map((file, i) => (
                    <li key={i}>{file.name} ({(file.size / 1024).toFixed(1)} KB)</li>
                  ))}
                </ul>
              </div>
            )}
            <button
              onClick={createSCPO}
              disabled={!storedPasswords[selectedVendorUUID]}
              style={{
                display: 'block',
                margin: '60px auto',
                width: '180px',
                height: '180px',
                borderRadius: '50%',
                background: 'linear-gradient(145deg, #F2B04A, #FFD98F)',
                color: 'white',
                fontSize: '28px',
                fontWeight: 'bold',
                border: '1.5px solid #D88F2E',
                boxShadow: scpoSuccess
                  ? '0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5)'
                  : '0 10px 30px rgba(212,175,55,0.4), inset 0 0 20px rgba(255,255,255,0.3)',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                animation: scpoSuccess ? 'scpoPulse 2s infinite' : 'none',
                opacity: !storedPasswords[selectedVendorUUID] ? 0.5 : 1
              }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
            >
              SC.PO
            </button>
            {result && (
              <div style={{ marginTop: '40px', maxWidth: '900px', marginLeft: 'auto', marginRight: 'auto' }}>
                <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', border: '1px solid #ddd', borderRadius: '15px' }}>
                  {result}
                </pre>
                <div style={{ marginTop: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
                  <button onClick={() => copyToClipboard(getOfferIndexFromResult(), 'OfferIndex')} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    📋 OfferIndex
                  </button>
                  <button onClick={() => copyToClipboard(getEscrowSequenceFromResult(), 'Escrow Sequence')} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    📋 Escrow Sequence
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {activeTab === 'scpoAction' && mode === 'customer' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>SC.PO Action</h2>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Open SC.PO</h3>
              {getFilteredPOs('Open').length === 0 ? (
                <p>No open POs</p>
              ) : (
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
                      {(openExpanded ? sortPOsNewestFirst(getFilteredPOs('Open')) : sortPOsNewestFirst(getFilteredPOs('Open').slice(0, 2))).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={async () => {
                              setSelectedOpenPO(po); // Set the selected PO for inventory loading
                              await viewPOFromUri(po.ipfsUri, po, setCustomerScpoActionViewedPO, setCustomerScpoActionPoLoadError);
                            }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                            <button onClick={() => deleteOpenPO(po.id)} style={{ background: '#e74c3c', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getFilteredPOs('Open').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setOpenExpanded(!openExpanded)}
                        style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                      >
                        {openExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Accepted SC.PO (Not Funded)</h3>
              {getFilteredPOs('Accepted').filter(p => !p.escrowSequence).length === 0 ? (
                <p>No accepted POs to fund</p>
              ) : (
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
                      {(acceptedExpanded ? sortPOsNewestFirst(getFilteredPOs('Accepted').filter(p => !p.escrowSequence)) : sortPOsNewestFirst(getFilteredPOs('Accepted').filter(p => !p.escrowSequence).slice(0, 2))).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => fundEscrow(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Fund Escrow
                            </button>
                            <button onClick={async () => {
                              setSelectedOpenPO(po); // Set for inventory
                              await viewPOFromUri(po.ipfsUri, po, setCustomerScpoActionViewedPO, setCustomerScpoActionPoLoadError);
                            }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getFilteredPOs('Accepted').filter(p => !p.escrowSequence).length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setAcceptedExpanded(!acceptedExpanded)}
                        style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                      >
                        {acceptedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {customerScpoActionPoLoadError && (
              <div style={{ marginTop: '40px', padding: '20px', background: '#ffebee', borderRadius: '15px', textAlign: 'center' }}>
                <p style={{ color: '#c62828', marginBottom: '15px' }}>
                  <strong>Could not load PO from IPFS:</strong><br />
                  {customerScpoActionPoLoadError}
                </p>
                <p style={{ color: '#666', marginBottom: '20px' }}>
                  IPFS gateways can be slow or temporarily unavailable.<br />
                  Please try again in a moment.
                </p>
              </div>
            )}
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
                <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Inventory Details</h4>
                {customerScpoActionViewedPO.items.map((item, i) => {
                  const inv = customerScpoActionPoInventory[item.num];
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
                })}
                <button onClick={() => setCustomerScpoActionViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginTop: '20px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
              <button
                onClick={() => setInventorySubTab('list')}
                style={{
                  height: '50px',
                  padding: '0 30px',
                  background: inventorySubTab === 'list'
                    ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                    : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                  color: '#FFFFFF',
                  border: '1.5px solid #D88F2E',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                  boxShadow: inventorySubTab === 'list'
                    ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                    : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)'
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
              >
                List
              </button>
              <button
                onClick={() => setInventorySubTab('add')}
                style={{
                  height: '50px',
                  padding: '0 30px',
                  background: inventorySubTab === 'add'
                    ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                    : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                  color: '#FFFFFF',
                  border: '1.5px solid #D88F2E',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                  boxShadow: inventorySubTab === 'add'
                    ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                    : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)'
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
              >
                Add
              </button>
            </div>
            {inventorySubTab === 'list' && (
              <div>
                <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Your Inventory</h3>
                {savedInventory.length === 0 ? (
                  <p>No inventory items added yet.</p>
                ) : (
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
                            <button onClick={() => viewInventoryFromUri(item.ipfsUri, item)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '5px 10px', borderRadius: '15px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                    <ul>
                      {selectedItem.attachments.map((att: Attachment, i: number) => (
                        <li key={i}>
                          <a href={`https://gateway.pinata.cloud/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                            {att.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p><strong style={{ color: '#F2B04A' }}>NFT ID:</strong> {selectedItem.nftId}</p>
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <QRCodeSVG value={`https://testnet.xrpl.org/nft/${selectedItem.nftId}`} size={128} /> {/* Links to XRPL explorer for proof */}
                      <p style={{ color: '#F2B04A' }}>QR Code for NFT (scan to view on XRPL Testnet)</p>
                    </div>
                    <button onClick={() => setSelectedItem(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginTop: '20px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                <button onClick={generateInventory} style={{ display: 'block', margin: '0 auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate
                </button>
                {invResult && (
                  <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', border: '1px solid #ddd', borderRadius: '15px', marginTop: '20px' }}>
                    {invResult}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab === 'view' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>View SC.PO</h2>
            {mode === 'customer' && (
              <div style={{ marginBottom: '40px' }}>
                <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Funded SC.PO</h3>
                {getFilteredPOs('Funded').length === 0 ? (
                  <p>No funded POs</p>
                ) : (
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
                        {(fundedExpanded ? sortPOsNewestFirst(getFilteredPOs('Funded')) : sortPOsNewestFirst(getFilteredPOs('Funded').slice(0, 2))).map(po => (
                          <tr key={po.id}>
                            <td style={{ padding: '10px' }}>{po.poName}</td>
                            <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px' }}>${po.total}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={async () => {
                                setSelectedFundedPO(po); // Set for inventory
                                await viewPOFromUri(po.ipfsUri, po, setCustomerViewViewedPO, setCustomerViewPoLoadError);
                              }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View PO
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {getFilteredPOs('Funded').length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setFundedExpanded(!fundedExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                {getFilteredPOs('Closed').length === 0 ? (
                  <p>No closed POs</p>
                ) : (
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
                        {(closedExpanded ? sortPOsNewestFirst(getFilteredPOs('Closed')) : sortPOsNewestFirst(getFilteredPOs('Closed').slice(0, 2))).map(po => (
                          <tr key={po.id}>
                            <td style={{ padding: '10px' }}>{po.poName}</td>
                            <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px' }}>${po.total}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={async () => {
                                setSelectedFundedPO(po); // Reuse for closed as well
                                await viewPOFromUri(po.ipfsUri, po, setCustomerViewViewedPO, setCustomerViewPoLoadError);
                              }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View PO
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {getFilteredPOs('Closed').length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setClosedExpanded(!closedExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                {getFilteredPOs('Accepted').filter(p => !p.escrowSequence).length === 0 ? (
                  <p>No accepted POs</p>
                ) : (
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
                        {(acceptedExpanded ? sortPOsNewestFirst(getFilteredPOs('Accepted').filter(p => !p.escrowSequence)) : sortPOsNewestFirst(getFilteredPOs('Accepted').filter(p => !p.escrowSequence).slice(0, 2))).map(po => (
                          <tr key={po.id}>
                            <td style={{ padding: '10px' }}>{po.poName}</td>
                            <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px' }}>${po.total}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={async () => {
                                setSelectedOpenPO(po); // Set for inventory
                                await viewPOFromUri(po.ipfsUri, po, setVendorViewViewedPO, setVendorViewPoLoadError);
                              }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View PO
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {getFilteredPOs('Accepted').filter(p => !p.escrowSequence).length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setAcceptedExpanded(!acceptedExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                {getFilteredPOs('Funded').length === 0 ? (
                  <p>No funded POs</p>
                ) : (
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
                        {(fundedExpanded ? sortPOsNewestFirst(getFilteredPOs('Funded')) : sortPOsNewestFirst(getFilteredPOs('Funded').slice(0, 2))).map(po => (
                          <tr key={po.id}>
                            <td style={{ padding: '10px' }}>{po.poName}</td>
                            <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px' }}>${po.total}</td>
                            <td style={{ padding: '10px' }}>{getTimeRemaining(po)}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={async () => {
                                setSelectedFundedPO(po); // Set for inventory
                                await viewPOFromUri(po.ipfsUri, po, setVendorViewViewedPO, setVendorViewPoLoadError);
                              }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View PO
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {getFilteredPOs('Funded').length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setFundedExpanded(!fundedExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                {getFilteredPOs('Closed').length === 0 ? (
                  <p>No claimed POs</p>
                ) : (
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
                        {(closedExpanded ? sortPOsNewestFirst(getFilteredPOs('Closed')) : sortPOsNewestFirst(getFilteredPOs('Closed').slice(0, 2))).map(po => (
                          <tr key={po.id}>
                            <td style={{ padding: '10px' }}>{po.poName}</td>
                            <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                            <td style={{ padding: '10px' }}>${po.total}</td>
                            <td style={{ padding: '10px' }}>
                              <button onClick={async () => {
                                setSelectedFundedPO(po); // Reuse for closed
                                await viewPOFromUri(po.ipfsUri, po, setVendorViewViewedPO, setVendorViewPoLoadError);
                              }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View PO
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {getFilteredPOs('Closed').length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setClosedExpanded(!closedExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                <button onClick={() => mode === 'customer' ? setCustomerViewViewedPO(null) : setVendorViewViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginTop: '20px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
              {getFilteredPOs('Open').length === 0 ? (
                <p>No open POs</p>
              ) : (
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
                      {(openExpanded ? sortPOsNewestFirst(getFilteredPOs('Open')) : sortPOsNewestFirst(getFilteredPOs('Open').slice(0, 2))).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => acceptNFTForPO(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Accept
                            </button>
                            <button onClick={async () => {
                              setSelectedOpenPO(po); // Set for inventory
                              await viewPOFromUri(po.ipfsUri, po, setVendorScpoActionViewedPO, setVendorScpoActionPoLoadError);
                            }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getFilteredPOs('Open').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setOpenExpanded(!openExpanded)}
                        style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                      >
                        {openExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#F2B04A', marginBottom: '10px' }}>Funded SC.PO</h3>
              {getFilteredPOs('Funded').filter(isWithin24HoursOfClaimable).length === 0 ? (
                <p>No funded POs ready to claim</p>
              ) : (
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
                      {(fundedExpanded ? sortPOsNewestFirst(getFilteredPOs('Funded').filter(isWithin24HoursOfClaimable)) : sortPOsNewestFirst(getFilteredPOs('Funded').filter(isWithin24HoursOfClaimable).slice(0, 2))).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>{getTimeRemaining(po)}</td>
                          <td style={{ padding: '10px', display: 'flex', gap: '5px' }}>
                            <button onClick={() => claimEscrowForPO(po)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              Claim Escrow
                            </button>
                            <button onClick={async () => {
                              setSelectedFundedPO(po); // Set for inventory
                              await viewPOFromUri(po.ipfsUri, po, setVendorScpoActionViewedPO, setVendorScpoActionPoLoadError);
                            }} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {getFilteredPOs('Funded').filter(isWithin24HoursOfClaimable).length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setFundedExpanded(!fundedExpanded)}
                        style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                      >
                        {fundedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {vendorScpoActionPoLoadError && (
              <div style={{ marginTop: '40px', padding: '20px', background: '#ffebee', borderRadius: '15px', textAlign: 'center' }}>
                <p style={{ color: '#c62828', marginBottom: '15px' }}>
                  <strong>Could not load PO from IPFS:</strong><br />
                  {vendorScpoActionPoLoadError}
                </p>
                <p style={{ color: '#666', marginBottom: '20px' }}>
                  IPFS gateways can be slow or temporarily unavailable.<br />
                  Please try again in a moment.
                </p>
              </div>
            )}
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
                <h4 style={{ marginTop: '20px', color: '#F2B04A' }}>Inventory Details</h4>
                {vendorScpoActionViewedPO.items.map((item, i) => {
                  const inv = vendorScpoActionPoInventory[item.num];
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
                })}
                <button onClick={() => setVendorScpoActionViewedPO(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginTop: '20px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Close
                </button>
              </div>
            )}
          </div>
        )}
        {activeTab === 'customerProfile' && hydrated && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#F2B04A', textAlign: 'center', marginBottom: '30px' }}>Profile</h2>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginBottom: '40px' }}>
              <button
                onClick={() => setCustomerProfileSubTab('profile')}
                style={{
                  height: '50px',
                  padding: '0 30px',
                  background: customerProfileSubTab === 'profile'
                    ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                    : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                  color: '#FFFFFF',
                  border: '1.5px solid #D88F2E',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                  boxShadow: customerProfileSubTab === 'profile'
                    ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                    : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)'
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
              >
                Profile
              </button>
              <button
                onClick={() => setCustomerProfileSubTab('links')}
                style={{
                  height: '50px',
                  padding: '0 30px',
                  background: customerProfileSubTab === 'links'
                    ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                    : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                  color: '#FFFFFF',
                  border: '1.5px solid #D88F2E',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                  boxShadow: customerProfileSubTab === 'links'
                    ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                    : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)'
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
              >
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
                <button onClick={saveCustomerProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                <button onClick={generateCustomerShareCode} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate Code
                </button>
                {customerShareCode && (
                  <div style={{ textAlign: 'center' }}>
                    <pre style={{ background: '#f0f0f0', padding: '15px', display: 'inline-block', borderRadius: '15px', maxWidth: '600px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{customerShareCode}</pre>
                    <button onClick={() => copyToClipboard(customerShareCode, 'Share Code')} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginLeft: '10px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      📋 Copy
                    </button>
                  </div>
                )}
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Add Linked Vendor</h3>
                <input placeholder="Enter Vendor Share Code" value={inputVendorCode} onChange={(e) => setInputVendorCode(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <input type="password" placeholder="Decryption Password" value={decryptVendorPassword} onChange={(e) => setDecryptVendorPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={addLinkedVendor} style={{ display: 'block', margin: '0 auto 40px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                              <button onClick={() => setSelectedLinkedVendor(v)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View
                              </button>
                              <button onClick={() => handleRefresh(v.profileUUID)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginLeft: '5px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                Refresh
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {linkedVendors.length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setVendorsExpanded(!vendorsExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                    {selectedLinkedVendor.lastUpdateSource && (
                      <p><strong style={{ color: '#F2B04A' }}>Last Updated By:</strong> {selectedLinkedVendor.lastUpdateSource.postedBy} at {new Date(selectedLinkedVendor.lastUpdateSource.timestamp).toLocaleString()}</p>
                    )}
                    {selectedLinkedVendor.linkTxHash && (
                      <button onClick={async () => {
                        const verified = await verifyLink(customerProfile, selectedLinkedVendor);
                      }} style={{ background: '#0066cc', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        Verify Link
                      </button>
                    )}
                    <button onClick={() => setSelectedLinkedVendor(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginTop: '20px', marginLeft: '10px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
              <button
                onClick={() => setVendorProfileSubTab('profile')}
                style={{
                  height: '50px',
                  padding: '0 30px',
                  background: vendorProfileSubTab === 'profile'
                    ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                    : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                  color: '#FFFFFF',
                  border: '1.5px solid #D88F2E',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                  boxShadow: vendorProfileSubTab === 'profile'
                    ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                    : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)'
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
              >
                Profile
              </button>
              <button
                onClick={() => setVendorProfileSubTab('links')}
                style={{
                  height: '50px',
                  padding: '0 30px',
                  background: vendorProfileSubTab === 'links'
                    ? 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)'
                    : 'linear-gradient(90deg, rgba(242,176,74,0.85) 0%, rgba(255,217,143,0.85) 100%)',
                  color: '#FFFFFF',
                  border: '1.5px solid #D88F2E',
                  borderRadius: '999px',
                  fontSize: '18px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  transition: 'all 0.18s ease-out',
                  boxShadow: vendorProfileSubTab === 'links'
                    ? 'inset 4px 6px 12px rgba(201,122,42,0.45), inset -1px -1px 2px rgba(255,255,255,0.4)'
                    : '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)'
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
              >
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
                <button onClick={saveVendorProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                <button onClick={generateVendorShareCode} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  Generate Code
                </button>
                {vendorShareCode && (
                  <div style={{ textAlign: 'center' }}>
                    <pre style={{ background: '#f0f0f0', padding: '15px', display: 'inline-block', borderRadius: '15px', maxWidth: '600px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{vendorShareCode}</pre>
                    <button onClick={() => copyToClipboard(vendorShareCode, 'Share Code')} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 15px', fontSize: '14px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginLeft: '10px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                      📋 Copy
                    </button>
                  </div>
                )}
                <h3 style={{ color: '#F2B04A', textAlign: 'center', margin: '40px 0 20px' }}>Add Linked Customer</h3>
                <input placeholder="Enter Customer Share Code" value={inputCustomerCode} onChange={(e) => setInputCustomerCode(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <input type="password" placeholder="Decryption Password" value={decryptCustomerPassword} onChange={(e) => setDecryptCustomerPassword(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }} />
                <button onClick={addLinkedCustomer} style={{ display: 'block', margin: '0 auto 40px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                              <button onClick={() => setSelectedLinkedCustomer(c)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                View
                              </button>
                              <button onClick={() => handleRefresh(c.profileUUID)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginLeft: '5px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                                Refresh
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {linkedCustomers.length > 2 && (
                      <div style={{ textAlign: 'center', marginTop: '10px' }}>
                        <button
                          onClick={() => setCustomersExpanded(!customersExpanded)}
                          style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.18s ease-out', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', fontSize: '14px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                        >
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
                    {selectedLinkedCustomer.lastUpdateSource && (
                      <p><strong style={{ color: '#F2B04A' }}>Last Updated By:</strong> {selectedLinkedCustomer.lastUpdateSource.postedBy} at {new Date(selectedLinkedCustomer.lastUpdateSource.timestamp).toLocaleString()}</p>
                    )}
                    {selectedLinkedCustomer.linkTxHash && (
                      <button onClick={async () => {
                        const verified = await verifyLink(vendorProfile, selectedLinkedCustomer);
                      }} style={{ background: '#0066cc', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                        Verify Link
                      </button>
                    )}
                    <button onClick={() => setSelectedLinkedCustomer(null)} style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '10px 20px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', marginTop: '20px', marginLeft: '10px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
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
                <input
                  type="password"
                  placeholder="Company Seed (password)"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D88F2E', margin: '0 auto 20px auto', display: 'block' }}
                />
                <button
                  onClick={() => {
                    if (adminPassword === process.env.REACT_APP_COMPANY_SEED) {
                      setAdminLoggedIn(true);
                      alert('Admin access granted');
                    } else {
                      alert('Incorrect seed');
                    }
                  }}
                  style={{ background: 'linear-gradient(90deg, #F2B04A 0%, #FFD98F 100%)', color: 'white', padding: '15px 50px', borderRadius: '30px', cursor: 'pointer', transition: 'all 0.18s ease-out', border: 'none', boxShadow: '6px 10px 18px rgba(201,122,42,0.45), inset 0 1px 0 rgba(255,255,255,0.35)', margin: '0 auto', display: 'block' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}
                >
                  Login
                </button>
              </div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '20px', marginBottom: '40px' }}>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Total SC.PO Created</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>{savedPOs.length}</p>
                  </div>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Total Fees Collected</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                      ${feeEntries.reduce((sum, fee) => sum + parseFloat(fee.amount.split(' ')[0].replace('$', '') || '0'), 0).toFixed(2)}
                    </p>
                  </div>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Unique Customers</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                      {new Set(savedPOs.map(po => po.buyerAddress)).size}
                    </p>
                  </div>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#F2B04A', margin: '0 0 10px' }}>Unique Vendors</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                      {new Set(savedPOs.map(po => po.vendorAddress)).size}
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <h3 style={{ color: '#F2B04A', margin: 0 }}>Collected Fees</h3>
                  <input
                    type="text"
                    placeholder="Search by PO Name or Date"
                    value={feeSearchTerm}
                    onChange={(e) => setFeeSearchTerm(e.target.value)}
                    style={{ padding: '10px', borderRadius: '20px', border: '2px solid #D88F2E', width: '300px' }}
                  />
                </div>
                {filteredFees.length === 0 ? (
                  <p>No fees collected yet</p>
                ) : (
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
                            <a href={`https://testnet.xrpl.org/transactions/${entry.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#F2B04A' }}>
                              {entry.txHash.substring(0, 10)}...
                            </a>
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
