import React, { useState, useEffect } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, NFTokenMint, EscrowFinish, NFTokenCreateOffer, NFTokenAcceptOffer, Payment } from 'xrpl';
import { Buffer } from 'buffer';
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
  escrowCondition: string;
  attachments?: Attachment[];
}
interface SavedPO {
  id: string;
  poName: string;
  dateIssued: string;
  total: string;
  ipfsUri: string;
  status: 'Open' | 'Accepted' | 'Closed';
  nftId: string;
  escrowSequence: number;
  condition: string;
  fulfillment: string;
  offerIndex: string;
  buyerAddress: string;
  vendorAddress: string;
}
interface Profile {
  company: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  seed: string;
  classicAddress: string;
  uniqueID: string;
}
interface PublicProfile {
  company: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  uniqueID: string;
  classicAddress: string;
}
interface FeeEntry {
  date: string;
  poName: string;
  amount: string;
  txHash: string;
}
export default function App() {
  const [activeTab, setActiveTab] = useState<'create' | 'view' | 'vendor' | 'customerProfile' | 'vendorProfile' | 'admin'>('create');
  // Create Tab States
  const [poName, setPoName] = useState('');
  const [seed, setSeed] = useState('');
  const [vendor, setVendor] = useState('');
  const [desc, setDesc] = useState('');
  const [department, setDepartment] = useState('1');
  const [paymentTerms, setPaymentTerms] = useState('30 Days');
  const [deliveryTerms, setDeliveryTerms] = useState('FOB');
  const [result, setResult] = useState('');
  // Items
  const [items, setItems] = useState<Item[]>([{ num: 'T345', qty: '4', total: '400' }]);
  const [newItemNum, setNewItemNum] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newTotal, setNewTotal] = useState('');
  const [totalEscrowAmount, setTotalEscrowAmount] = useState('400');
  // Attachments
  const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null);
  // For SC.PO coin glow on success
  const [scpoSuccess, setScpoSuccess] = useState(false);
  // Admin tab state
  const [adminLoggedIn, setAdminLoggedIn] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [feeEntries, setFeeEntries] = useState<FeeEntry[]>([]);
  // View SC.PO state for "Show More"
  const [openExpanded, setOpenExpanded] = useState(false);
  const [acceptedExpanded, setAcceptedExpanded] = useState(false);
  const [closedExpanded, setClosedExpanded] = useState(false);
  useEffect(() => {
    const total = items.reduce((sum, item) => sum + parseFloat(item.total || '0'), 0);
    setTotalEscrowAmount(total.toString());
  }, [items]);
  useEffect(() => {
    const savedFees = localStorage.getItem('feeEntries');
    if (savedFees) setFeeEntries(JSON.parse(savedFees));
  }, []);
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
  const [claimFulfillment, setClaimFulfillment] = useState('');
  const [claimCondition, setClaimCondition] = useState('');
  const [claimOwner, setClaimOwner] = useState('');
  const [claimOfferSequence, setClaimOfferSequence] = useState('');
  const [claimResult, setClaimResult] = useState('');
  const [vendorAcceptSeed, setVendorAcceptSeed] = useState('');
  const [offerIndex, setOfferIndex] = useState('');
  const [acceptResult, setAcceptResult] = useState('');
  const [selectedOpenPO, setSelectedOpenPO] = useState<SavedPO | null>(null);
  const [selectedAcceptedPO, setSelectedAcceptedPO] = useState<SavedPO | null>(null);
  // View Tab States
  const [ipfsUri, setIpfsUri] = useState('');
  const [viewedPO, setViewedPO] = useState<POData | null>(null);
  const [poLoadError, setPoLoadError] = useState<string | null>(null);
  // Saved POs
  const [savedPOs, setSavedPOs] = useState<SavedPO[]>([]);
  useEffect(() => {
    const saved = localStorage.getItem('savedPOs');
    if (saved) setSavedPOs(JSON.parse(saved));
  }, []);
  const saveNewPO = (po: SavedPO) => {
    const updated = [...savedPOs, po];
    setSavedPOs(updated);
    localStorage.setItem('savedPOs', JSON.stringify(updated));
  };
  const updatePOStatus = (id: string, status: 'Accepted' | 'Closed') => {
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
  const viewPOFromUri = async (uri: string) => {
    setIpfsUri(uri);
    setViewedPO(null);
    setPoLoadError(null);
    try {
      const hash = uri.replace('ipfs://', '');
      const response = await fetch(`https://ipfs.io/ipfs/${hash}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}: Failed to fetch from IPFS gateway`);
      const data = await response.json();
      setViewedPO(data as POData);
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';
      setPoLoadError(errorMsg);
      console.error('IPFS load error:', err);
    }
  };
  // Profiles
  const [customerProfile, setCustomerProfile] = useState<Profile>({
    company: '', name: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: ''
  });
  const [vendorProfile, setVendorProfile] = useState<Profile>({
    company: '', name: '', address: '', city: '', state: '', zip: '', country: '', seed: '', classicAddress: '', uniqueID: ''
  });
  // Linked accounts
  const [linkedVendors, setLinkedVendors] = useState<PublicProfile[]>([]);
  const [linkedCustomers, setLinkedCustomers] = useState<PublicProfile[]>([]);
  // Share codes
  const [customerShareCode, setCustomerShareCode] = useState('');
  const [vendorShareCode, setVendorShareCode] = useState('');
  // Input codes
  const [inputVendorCode, setInputVendorCode] = useState('');
  const [inputCustomerCode, setInputCustomerCode] = useState('');
  useEffect(() => {
    const savedCustomer = localStorage.getItem('customerProfile');
    const savedVendor = localStorage.getItem('vendorProfile');
    const savedLinkedVendors = localStorage.getItem('linkedVendors');
    const savedLinkedCustomers = localStorage.getItem('linkedCustomers');
    if (savedCustomer) setCustomerProfile(JSON.parse(savedCustomer));
    if (savedVendor) setVendorProfile(JSON.parse(savedVendor));
    if (savedLinkedVendors) setLinkedVendors(JSON.parse(savedLinkedVendors));
    if (savedLinkedCustomers) setLinkedCustomers(JSON.parse(savedLinkedCustomers));
  }, []);
  useEffect(() => {
    if (customerProfile.seed) setSeed(customerProfile.seed);
    if (vendorProfile.seed) {
      setVendorAcceptSeed(vendorProfile.seed);
      setClaimSeed(vendorProfile.seed);
    }
  }, [customerProfile, vendorProfile]);
  useEffect(() => {
    localStorage.setItem('linkedVendors', JSON.stringify(linkedVendors));
  }, [linkedVendors]);
  useEffect(() => {
    localStorage.setItem('linkedCustomers', JSON.stringify(linkedCustomers));
  }, [linkedCustomers]);
  const saveCustomerProfile = () => {
    localStorage.setItem('customerProfile', JSON.stringify(customerProfile));
    alert('Customer profile saved!');
  };
  const saveVendorProfile = () => {
    localStorage.setItem('vendorProfile', JSON.stringify(vendorProfile));
    alert('Vendor profile saved!');
  };
  const generateCustomerShareCode = () => {
    const publicProfile: PublicProfile = {
      company: customerProfile.company,
      name: customerProfile.name,
      address: customerProfile.address,
      city: customerProfile.city,
      state: customerProfile.state,
      zip: customerProfile.zip,
      country: customerProfile.country,
      uniqueID: customerProfile.uniqueID,
      classicAddress: customerProfile.classicAddress
    };
    setCustomerShareCode(btoa(JSON.stringify(publicProfile)));
  };
  const generateVendorShareCode = () => {
    const publicProfile: PublicProfile = {
      company: vendorProfile.company,
      name: vendorProfile.name,
      address: vendorProfile.address,
      city: vendorProfile.city,
      state: vendorProfile.state,
      zip: vendorProfile.zip,
      country: vendorProfile.country,
      uniqueID: vendorProfile.uniqueID,
      classicAddress: vendorProfile.classicAddress
    };
    setVendorShareCode(btoa(JSON.stringify(publicProfile)));
  };
  const addLinkedVendor = () => {
    try {
      const decoded = JSON.parse(atob(inputVendorCode)) as PublicProfile;
      if (!linkedVendors.some(v => v.uniqueID === decoded.uniqueID)) {
        setLinkedVendors([...linkedVendors, decoded]);
        setInputVendorCode('');
        alert('Vendor linked!');
      } else {
        alert('Vendor already linked');
      }
    } catch {
      alert('Invalid code');
    }
  };
  const addLinkedCustomer = () => {
    try {
      const decoded = JSON.parse(atob(inputCustomerCode)) as PublicProfile;
      if (!linkedCustomers.some(c => c.uniqueID === decoded.uniqueID)) {
        setLinkedCustomers([...linkedCustomers, decoded]);
        setInputCustomerCode('');
        alert('Customer linked!');
      } else {
        alert('Customer already linked');
      }
    } catch {
      alert('Invalid code');
    }
  };
  const generateConditionFulfillment = async () => {
    const preimageData = new Uint8Array(32);
    window.crypto.getRandomValues(preimageData);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', preimageData);
    const hash = Buffer.from(hashBuffer);
    const conditionBin = Buffer.concat([
      Buffer.from('a0258020', 'hex'),
      hash,
      Buffer.from('8101', 'hex'),
      Buffer.from([preimageData.length])
    ]);
    const conditionHex = conditionBin.toString('hex').toUpperCase();
    const fulfillmentBase64 = Buffer.from(preimageData).toString('base64');
    return { condition: conditionHex, fulfillment: fulfillmentBase64 };
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
  const uploadToIPFS = async (data: POData) => {
    const pinataApiKey = process.env.REACT_APP_PINATA_API_KEY;
    if (!pinataApiKey) throw new Error('Pinata API key missing – check .env file');
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
      throw new Error(`Pinata upload failed: ${errorText || response.statusText}`);
    }
    const result = await response.json();
    return `ipfs://${result.IpfsHash}`;
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
    if (items.length === 0) return alert('Add at least one item');
    if (parseFloat(totalEscrowAmount) <= 0) return alert('Total amount must be greater than 0');
    const drops = xrpl.xrpToDrops(totalEscrowAmount);
    // Dynamic fee: always $0.01 USD
    const xrpPriceUsd = await getXrpPriceUsd();
    const feeUsd = 0.01; // $0.01
    const feeXrp = feeUsd / xrpPriceUsd;
    const feeDrops = xrpl.xrpToDrops(feeXrp.toFixed(6)); // round to 6 decimals for safety
    const { condition, fulfillment } = await generateConditionFulfillment();
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
      escrowCondition: condition,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    try {
      setResult('Uploading PO data to IPFS...');
      const ipfsUri = await uploadToIPFS(poData);
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233', { connectionTimeout: 20000 });
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(seed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      // Step 1: Send dynamic $0.01 fee to company wallet
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
        client.disconnect();
        throw new Error('Fee payment failed');
      }
      // Step 2: Create Escrow
      const escrow: EscrowCreate = {
        TransactionType: 'EscrowCreate',
        Account: wallet.classicAddress,
        Destination: vendor,
        Amount: drops,
        Condition: condition,
        CancelAfter: Math.floor(Date.now() / 1000) + 86400 * 7,
        Memos: [{ Memo: { MemoData: xrpl.convertStringToHex(JSON.stringify(poData)) } }]
      };
      const preparedEscrow = await client.autofill(escrow);
      preparedEscrow.LastLedgerSequence = currentLedger + 20;
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await client.submitAndWait(signedEscrow.tx_blob);
      if (typeof escrowResult.result.meta !== 'object' || escrowResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        client.disconnect();
        throw new Error('Escrow failed');
      }
      const escrowSequence = escrowResult.result.tx_json.Sequence as number;
      // Step 3: Mint NFT
      const nft: NFTokenMint = {
        TransactionType: 'NFTokenMint',
        Account: wallet.classicAddress,
        URI: xrpl.convertStringToHex(ipfsUri),
        Flags: 8,
        NFTokenTaxon: 0,
        Memos: [{ Memo: { MemoData: xrpl.convertStringToHex(`Escrow Sequence: ${escrowSequence}`) } }]
      };
      const preparedNFT = await client.autofill(nft);
      preparedNFT.LastLedgerSequence = currentLedger + 20;
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await client.submitAndWait(signedNFT.tx_blob);
      if (typeof nftResult.result.meta !== 'object' || nftResult.result.meta.TransactionResult !== 'tesSUCCESS') {
        client.disconnect();
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
      // Step 4: Create Offer
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
        escrowSequence,
        condition,
        fulfillment,
        offerIndex,
        buyerAddress: wallet.classicAddress,
        vendorAddress: vendor
      };
      saveNewPO(newPO);
      // Log fee in Admin dashboard
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
        `SC.PO Created Successfully!\n` +
        `Fee of $0.01 USD sent to company wallet.\n` +
        `PO Name: ${poName}\n` +
        `Total Escrow Amount: $${totalEscrowAmount}\n` +
        `NFT ID: ${justMintedNFT}\n` +
        `Escrow Sequence: ${escrowSequence}\n` +
        `Fulfillment: ${fulfillment}\n` +
        `IPFS URI: ${ipfsUri}\n` +
        `OfferIndex: ${offerIndex}\n` +
        `Check View SC.PO tab for status.` +
        (attachments.length > 0 ? `\n${attachments.length} attachment(s) uploaded.` : '')
      );
      // Trigger coin glow
      setScpoSuccess(true);
      setTimeout(() => setScpoSuccess(false), 3000);
      client.disconnect();
    } catch (err: any) {
      alert('Operation failed: ' + err.message);
      setResult('Error: ' + err.message);
    }
  };
  const acceptNFT = async () => {
    if (!selectedOpenPO) return alert('Select an Open PO first');
    if (!vendorAcceptSeed) return alert('Vendor wallet seed required');
    try {
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233', { connectionTimeout: 20000 });
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(vendorAcceptSeed);
      const acceptTx: NFTokenAcceptOffer = {
        TransactionType: 'NFTokenAcceptOffer',
        Account: wallet.classicAddress,
        NFTokenSellOffer: selectedOpenPO.offerIndex,
      };
      const prepared = await client.autofill(acceptTx);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const acceptResultTx = await client.submitAndWait(signed.tx_blob);
      client.disconnect();
      const meta = acceptResultTx.result.meta as any;
      if (meta && meta.TransactionResult === 'tesSUCCESS') {
        setAcceptResult(`"${selectedOpenPO.poName}" NFT Accepted! Tx Hash: ${acceptResultTx.result.hash}`);
        updatePOStatus(selectedOpenPO.id, 'Accepted');
      } else {
        setAcceptResult(`Accept failed: ${meta?.TransactionResult || 'unknown error'}`);
      }
    } catch (err: any) {
      alert('Accept failed: ' + err.message);
      setAcceptResult('Error: ' + err.message);
    }
  };
  const claimEscrow = async () => {
    if (!selectedAcceptedPO) return alert('Select an Accepted PO first');
    if (!claimSeed) return alert('Claim seed required');
    try {
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233', { connectionTimeout: 20000 });
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(claimSeed);
      const escrowFinish: EscrowFinish = {
        TransactionType: 'EscrowFinish',
        Account: wallet.classicAddress,
        Owner: claimOwner,
        OfferSequence: selectedAcceptedPO.escrowSequence,
        Condition: selectedAcceptedPO.condition,
        Fulfillment: Buffer.from(selectedAcceptedPO.fulfillment, 'base64').toString('hex'),
      };
      const prepared = await client.autofill(escrowFinish);
      prepared.LastLedgerSequence = (await client.request({ command: 'ledger_current' })).result.ledger_current_index + 20;
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      client.disconnect();
      setClaimResult(`"${selectedAcceptedPO.poName}" Escrow claimed! Tx Hash: ${result.result.hash}`);
      updatePOStatus(selectedAcceptedPO.id, 'Closed');
    } catch (err: any) {
      alert('Claim failed: ' + err.message);
    }
  };
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    alert(`${label} copied to clipboard!`);
  };
  const getFulfillmentFromResult = () => result.match(/Fulfillment: (.*)/)?.[1] || '';
  const getOfferIndexFromResult = () => result.match(/OfferIndex: (.*)/)?.[1] || '';
  const getConditionFromResult = () => result.match(/Condition: (.*)/)?.[1] || '';
  const getEscrowSequenceFromResult = () => result.match(/Escrow Sequence: (.*)/)?.[1] || '';
  // Button feedback helpers
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
  // Pulse animation for coin glow
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
      if (document.head.contains(style)) document.head.removeChild(style);
    };
  }, []);
  const sortPOsNewestFirst = (pos: SavedPO[]) => pos.sort((a, b) => parseInt(b.id) - parseInt(a.id));
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f5f5f5', fontFamily: 'Helvetica, Arial, sans-serif' }}>
      {/* Fixed Left Sidebar */}
      <div style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: '250px',
        height: '100vh',
        background: 'linear-gradient(to bottom, #FFD700, #DAA520)',
        padding: '20px',
        boxShadow: '5px 0 15px rgba(0,0,0,0.1)',
        overflowY: 'auto',
        zIndex: 10
      }}>
        <h2 style={{ color: 'white', textAlign: 'center', marginBottom: '40px' }}>Customer</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          <button onClick={() => setActiveTab('create')} style={{
            padding: '15px',
            background: activeTab === 'create' ? '#FFA500' : 'rgba(255,255,255,0.2)',
            color: 'white',
            border: 'none',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
            Create SC.PO
          </button>
          <button onClick={() => setActiveTab('view')} style={{
            padding: '15px',
            background: activeTab === 'view' ? '#FFA500' : 'rgba(255,255,255,0.2)',
            color: 'white',
            border: 'none',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
            View SC.PO
          </button>
          <button onClick={() => setActiveTab('customerProfile')} style={{
            padding: '15px',
            background: activeTab === 'customerProfile' ? '#FFA500' : 'rgba(255,255,255,0.2)',
            color: 'white',
            border: 'none',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
            Customer Profile
          </button>
          <button onClick={() => setActiveTab('vendorProfile')} style={{
            padding: '15px',
            background: activeTab === 'vendorProfile' ? '#FFA500' : 'rgba(255,255,255,0.2)',
            color: 'white',
            border: 'none',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
            Vendor Profile
          </button>
          <button onClick={() => setActiveTab('vendor')} style={{
            padding: '15px',
            background: activeTab === 'vendor' ? '#FFA500' : 'rgba(255,255,255,0.2)',
            color: 'white',
            border: 'none',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
            Vendor Claim
          </button>
          <button onClick={() => setActiveTab('admin')} style={{
            padding: '15px',
            background: activeTab === 'admin' ? '#FFA500' : 'rgba(255,255,255,0.2)',
            color: 'white',
            border: 'none',
            borderRadius: '30px',
            fontSize: '18px',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
            Admin
          </button>
        </div>
      </div>
      {/* Main Content */}
      <div style={{ marginLeft: '250px', flex: 1, padding: '40px', background: 'white', minHeight: '100vh', overflowY: 'auto' }}>
        <h1 style={{ color: '#D4AF37', textAlign: 'center', fontSize: '36px', marginBottom: '30px' }}>SC.PO Generator</h1>
        {activeTab === 'create' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '40px' }}>Create SC.PO</h2>
            <label style={{ display: 'block', marginBottom: '10px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>PO Name (for tracking)</label>
            <input
              style={{
                width: '100%',
                maxWidth: '600px',
                padding: '15px',
                borderRadius: '30px',
                border: '2px solid #D4AF37',
                margin: '0 auto 50px auto',
                display: 'block'
              }}
              placeholder="e.g. Widget Order Dec 2025"
              value={poName}
              onChange={(e) => setPoName(e.target.value)}
            />
            <label style={{ display: 'block', marginBottom: '10px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Description</label>
            <textarea
              style={{
                width: '100%',
                maxWidth: '600px',
                padding: '15px',
                borderRadius: '30px',
                border: '2px solid #D4AF37',
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
                <label style={{ display: 'block', marginBottom: '10px', color: '#D4AF37', fontWeight: 'bold' }}>Customer Link</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', background: '#f0f0f0' }} value="Linked" readOnly />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#D4AF37', fontWeight: 'bold' }}>Department</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} value={department} onChange={(e) => setDepartment(e.target.value)} />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#D4AF37', fontWeight: 'bold' }}>Vendor Link</label>
                <select
                  style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }}
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                >
                  <option value="">Select Linked Vendor</option>
                  {linkedVendors.map(v => (
                    <option key={v.uniqueID} value={v.classicAddress}>{v.uniqueID}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '10px', color: '#D4AF37', fontWeight: 'bold' }}>RFP Link</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', background: '#f0f0f0' }} value="Linked" readOnly />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#D4AF37', fontWeight: 'bold' }}>Payment Terms</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
                <label style={{ display: 'block', margin: '40px 0 10px', color: '#D4AF37', fontWeight: 'bold' }}>Delivery Terms</label>
                <input style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} />
              </div>
            </div>
            <h3 style={{ color: '#D4AF37', margin: '40px 0 20px', textAlign: 'center' }}>Request</h3>
            <div style={{ maxWidth: '900px', margin: '0 auto' }}>
              <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 15px' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0', borderRadius: '30px 0 0 30px' }}>Item #</th>
                    <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0' }}>Item Link</th>
                    <th style={{ textAlign: 'left', padding: '15px', background: '#FFF3E0' }}>Qty</th>
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
                        <button onClick={() => removeItem(index)} style={{ background: '#e74c3c', color: 'white', padding: '5px 10px', borderRadius: '15px', border: '2px solid #c0392b', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h4 style={{ color: '#D4AF37', margin: '40px 0 10px', textAlign: 'center' }}>Add New Item</h4>
            <div style={{ display: 'flex', gap: '10px', maxWidth: '900px', margin: '0 auto 40px auto' }}>
              <input placeholder="Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', flex: 1 }} />
              <input placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', flex: 1 }} />
              <input placeholder="Total $" value={newTotal} onChange={(e) => setNewTotal(e.target.value)} style={{ padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', flex: 1 }} />
              <button onClick={addItem} style={{ background: '#D4AF37', color: 'white', padding: '15px 30px', borderRadius: '30px', border: 'none', boxShadow: '0 4px 10px rgba(212,175,55,0.3)', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                Add
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', maxWidth: '900px', margin: '0 auto 60px auto' }}>
              <div style={{ background: '#FFF3E0', padding: '20px 40px', borderRadius: '30px', fontSize: '20px', fontWeight: 'bold', color: '#D4AF37' }}>
                Sub Total: ${totalEscrowAmount}
              </div>
            </div>
            <h3 style={{ color: '#D4AF37', margin: '40px 0 20px', textAlign: 'center' }}>Attachments (optional)</h3>
            <p style={{ textAlign: 'center', marginBottom: '10px', color: '#666', maxWidth: '600px', marginLeft: 'auto', marginRight: 'auto' }}>Add drawings, specs, PDFs, images, etc. (uploaded to IPFS)</p>
            <input type="file" multiple onChange={(e) => setSelectedFiles(e.target.files)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 40px auto', display: 'block' }} />
            {selectedFiles && selectedFiles.length > 0 && (
              <div style={{ maxWidth: '600px', margin: '0 auto 40px auto' }}>
                <strong>Selected files:</strong>
                <ul>
                  {Array.from(selectedFiles).map((file, i) => (
                    <li key={i}>{file.name} ({(file.size / 1024).toFixed(1)} KB)</li>
                  ))}
                </ul>
              </div>
            )}
            <button
              onClick={createSCPO}
              style={{
                display: 'block',
                margin: '60px auto',
                width: '180px',
                height: '180px',
                borderRadius: '50%',
                background: 'linear-gradient(145deg, #f0d878, #b8972e)',
                color: 'white',
                fontSize: '28px',
                fontWeight: 'bold',
                border: '8px solid #D4AF37',
                boxShadow: scpoSuccess
                  ? '0 0 30px #FFD700, 0 0 60px #FFA500, inset 0 0 20px rgba(255,255,255,0.5)'
                  : '0 10px 30px rgba(212,175,55,0.4), inset 0 0 20px rgba(255,255,255,0.3)',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                animation: scpoSuccess ? 'scpoPulse 2s infinite' : 'none',
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
                  <button onClick={() => copyToClipboard(getFulfillmentFromResult(), 'Fulfillment')} style={{ background: '#0066cc', color: 'white', padding: '8px 15px', fontSize: '14px', border: 'none', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    📋 Fulfillment
                  </button>
                  <button onClick={() => copyToClipboard(getOfferIndexFromResult(), 'OfferIndex')} style={{ background: '#0066cc', color: 'white', padding: '8px 15px', fontSize: '14px', border: 'none', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    📋 OfferIndex
                  </button>
                  <button onClick={() => copyToClipboard(getConditionFromResult(), 'Condition')} style={{ background: '#0066cc', color: 'white', padding: '8px 15px', fontSize: '14px', border: 'none', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    📋 Condition
                  </button>
                  <button onClick={() => copyToClipboard(getEscrowSequenceFromResult(), 'Escrow Sequence')} style={{ background: '#0066cc', color: 'white', padding: '8px 15px', fontSize: '14px', border: 'none', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                    📋 Escrow Sequence
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {activeTab === 'view' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)' }}>
            <h2 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '30px' }}>SC.PO Status Dashboard</h2>
            {/* Open SC.PO Bucket */}
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#D4AF37', marginBottom: '10px' }}>Open SC.PO</h3>
              {savedPOs.filter(p => p.status === 'Open').length === 0 ? (
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
                      {(openExpanded ? sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Open')) : sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Open')).slice(0, 2)).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>
                            <button onClick={() => viewPOFromUri(po.ipfsUri)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', border: '2px solid #1e8449', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {savedPOs.filter(p => p.status === 'Open').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setOpenExpanded(!openExpanded)}
                        style={{ background: '#D4AF37', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', fontSize: '14px' }}
                      >
                        {openExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Accepted SC.PO Bucket */}
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#D4AF37', marginBottom: '10px' }}>Accepted SC.PO</h3>
              {savedPOs.filter(p => p.status === 'Accepted').length === 0 ? (
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
                      {(acceptedExpanded ? sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Accepted')) : sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Accepted')).slice(0, 2)).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>
                            <button onClick={() => viewPOFromUri(po.ipfsUri)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', border: '2px solid #1e8449', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {savedPOs.filter(p => p.status === 'Accepted').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setAcceptedExpanded(!acceptedExpanded)}
                        style={{ background: '#D4AF37', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', fontSize: '14px' }}
                      >
                        {acceptedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* Closed SC.PO Bucket */}
            <div style={{ marginBottom: '40px' }}>
              <h3 style={{ color: '#D4AF37', marginBottom: '10px' }}>Closed SC.PO</h3>
              {savedPOs.filter(p => p.status === 'Closed').length === 0 ? (
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
                      {(closedExpanded ? sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Closed')) : sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Closed')).slice(0, 2)).map(po => (
                        <tr key={po.id}>
                          <td style={{ padding: '10px' }}>{po.poName}</td>
                          <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                          <td style={{ padding: '10px' }}>${po.total}</td>
                          <td style={{ padding: '10px' }}>
                            <button onClick={() => viewPOFromUri(po.ipfsUri)} style={{ background: '#27ae60', color: 'white', padding: '8px', borderRadius: '20px', border: '2px solid #1e8449', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                              View PO
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {savedPOs.filter(p => p.status === 'Closed').length > 2 && (
                    <div style={{ textAlign: 'center', marginTop: '10px' }}>
                      <button
                        onClick={() => setClosedExpanded(!closedExpanded)}
                        style={{ background: '#D4AF37', color: 'white', padding: '8px 16px', borderRadius: '30px', border: 'none', cursor: 'pointer', fontSize: '14px' }}
                      >
                        {closedExpanded ? 'Show Less ▲' : 'Show More ▼'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {poLoadError && (
              <div style={{ marginTop: '40px', padding: '20px', background: '#ffebee', borderRadius: '15px', textAlign: 'center' }}>
                <p style={{ color: '#c62828', marginBottom: '15px' }}>
                  <strong>Could not load PO from IPFS:</strong><br />
                  {poLoadError}
                </p>
                <p style={{ color: '#666', marginBottom: '20px' }}>
                  IPFS gateways can be slow or temporarily unavailable.<br />
                  Please try again in a moment.
                </p>
                <button onClick={() => viewPOFromUri(ipfsUri)} style={{ background: '#D4AF37', color: 'white', padding: '12px 30px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  🔄 Retry Loading PO
                </button>
              </div>
            )}
            {viewedPO && (
              <div style={{ marginTop: '40px', border: '1px solid #ddd', padding: '15px', background: '#f9f9f9', borderRadius: '20px' }}>
                <h3>Purchase Order Details</h3>
                <p><strong>PO Name:</strong> {viewedPO.poName}</p>
                <p><strong>Description:</strong> {viewedPO.description || 'N/A'}</p>
                <p><strong>Department:</strong> {viewedPO.department}</p>
                <p><strong>Payment Terms:</strong> {viewedPO.paymentTerms}</p>
                <p><strong>Delivery Terms:</strong> {viewedPO.deliveryTerms}</p>
                <h4>Items</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#e0e0e0' }}>
                      <th style={{ padding: '8px', border: '1px solid #ddd' }}>Item #</th>
                      <th style={{ padding: '8px', border: '1px solid #ddd' }}>Qty</th>
                      <th style={{ padding: '8px', border: '1px solid #ddd' }}>Total $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewedPO.items.map((item, i) => (
                      <tr key={i}>
                        <td style={{ padding: '8px', border: '1px solid #ddd' }}>{item.num}</td>
                        <td style={{ padding: '8px', border: '1px solid #ddd' }}>{item.qty}</td>
                        <td style={{ padding: '8px', border: '1px solid #ddd' }}>${item.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {viewedPO.attachments && viewedPO.attachments.length > 0 && (
                  <>
                    <h4 style={{ marginTop: '20px' }}>Attachments</h4>
                    <ul>
                      {viewedPO.attachments.map((att, i) => (
                        <li key={i}>
                          <a href={`https://ipfs.io/ipfs/${att.uri.replace('ipfs://', '')}`} target="_blank" rel="noopener noreferrer" style={{ color: '#D4AF37' }}>
                            {att.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {activeTab === 'vendor' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '40px' }}>Vendor Actions</h2>
            <h3 style={{ color: '#D4AF37', marginBottom: '20px', textAlign: 'center' }}>Select Open SC.PO for Acceptance</h3>
            <select
              onChange={(e) => {
                const po = savedPOs.find(p => p.id === e.target.value);
                setSelectedOpenPO(po || null);
                if (po) {
                  setOfferIndex(po.offerIndex);
                }
              }}
              style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 40px auto', display: 'block' }}>
              <option value="">-- Select Open PO --</option>
              {sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Open')).map(po => (
                <option key={po.id} value={po.id}>{po.poName} ({po.dateIssued} - ${po.total})</option>
              ))}
            </select>
            <h3 style={{ color: '#D4AF37', marginBottom: '20px', textAlign: 'center' }}>Accept SC.PO NFT Token</h3>
            <input
              placeholder="Vendor Wallet Seed (auto-filled)"
              value={vendorAcceptSeed}
              onChange={(e) => setVendorAcceptSeed(e.target.value)}
              style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }}
            />
            <input
              placeholder="OfferIndex"
              value={offerIndex}
              onChange={(e) => setOfferIndex(e.target.value)}
              style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 40px auto', display: 'block' }}
            />
            <button onClick={acceptNFT} style={{ background: '#27ae60', color: 'white', padding: '15px', width: '100%', maxWidth: '600px', borderRadius: '30px', border: '2px solid #1e8449', cursor: 'pointer', transition: 'all 0.2s ease', margin: '0 auto 40px auto', display: 'block' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Accept SC.PO NFT
            </button>
            {acceptResult && (
              <pre style={{
                background: '#e0ffe0',
                padding: '15px',
                margin: '0 auto 40px auto',
                maxWidth: '600px',
                borderRadius: '15px',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word'
              }}>
                {acceptResult}
              </pre>
            )}
            <h3 style={{ color: '#D4AF37', marginBottom: '20px', textAlign: 'center' }}>Select Accepted SC.PO for Claim</h3>
            <select
              onChange={(e) => {
                const po = savedPOs.find(p => p.id === e.target.value);
                setSelectedAcceptedPO(po || null);
                if (po) {
                  setClaimFulfillment(po.fulfillment);
                  setClaimCondition(po.condition);
                  setClaimOfferSequence(po.escrowSequence.toString());
                  setClaimOwner(po.buyerAddress);
                }
              }}
              style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 40px auto', display: 'block' }}>
              <option value="">-- Select Accepted PO --</option>
              {sortPOsNewestFirst(savedPOs.filter(p => p.status === 'Accepted')).map(po => (
                <option key={po.id} value={po.id}>{po.poName} ({po.dateIssued} - ${po.total})</option>
              ))}
            </select>
            <h3 style={{ color: '#D4AF37', marginBottom: '20px', textAlign: 'center' }}>Claim Escrow</h3>
            <input placeholder="Claim Wallet Seed (auto-filled)" value={claimSeed} onChange={(e) => setClaimSeed(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <input placeholder="Fulfillment Code (base64)" value={claimFulfillment} onChange={(e) => setClaimFulfillment(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <input placeholder="Condition" value={claimCondition} onChange={(e) => setClaimCondition(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <input placeholder="Owner Address (auto-filled)" value={claimOwner} onChange={(e) => setClaimOwner(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <input placeholder="Escrow Sequence" value={claimOfferSequence} onChange={(e) => setClaimOfferSequence(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 40px auto', display: 'block' }} />
            <button onClick={claimEscrow} style={{ background: '#27ae60', color: 'white', padding: '15px', width: '100%', maxWidth: '600px', borderRadius: '30px', border: '2px solid #1e8449', cursor: 'pointer', transition: 'all 0.2s ease', margin: '0 auto 40px auto', display: 'block' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Claim Escrow
            </button>
            {claimResult && (
              <pre style={{
                background: '#e0ffe0',
                padding: '15px',
                margin: '0 auto 40px auto',
                maxWidth: '600px',
                borderRadius: '15px',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word'
              }}>
                {claimResult}
              </pre>
            )}
          </div>
        )}
        {activeTab === 'customerProfile' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '30px' }}>Customer Profile</h2>
            <p style={{ textAlign: 'center', marginBottom: '30px' }}>Save your company and wallet info — seed will auto-fill when creating POs.</p>
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Unique ID / Name</label>
            <input placeholder="Enter unique ID (e.g. Customer123)" value={customerProfile.uniqueID} onChange={(e) => setCustomerProfile({ ...customerProfile, uniqueID: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Company Name</label>
            <input placeholder="Enter your company name" value={customerProfile.company} onChange={(e) => setCustomerProfile({ ...customerProfile, company: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Contact Name</label>
            <input placeholder="Your full name" value={customerProfile.name} onChange={(e) => setCustomerProfile({ ...customerProfile, name: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Street Address</label>
            <input placeholder="Street address" value={customerProfile.address} onChange={(e) => setCustomerProfile({ ...customerProfile, address: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', maxWidth: '600px', margin: '0 auto 20px auto' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold' }}>City</label>
                <input placeholder="City" value={customerProfile.city} onChange={(e) => setCustomerProfile({ ...customerProfile, city: e.target.value })} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold' }}>State / Province</label>
                <input placeholder="State or province" value={customerProfile.state} onChange={(e) => setCustomerProfile({ ...customerProfile, state: e.target.value })} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold' }}>ZIP / Postal Code</label>
                <input placeholder="ZIP or postal code" value={customerProfile.zip} onChange={(e) => setCustomerProfile({ ...customerProfile, zip: e.target.value })} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} />
              </div>
            </div>
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Country</label>
            <input placeholder="Country" value={customerProfile.country} onChange={(e) => setCustomerProfile({ ...customerProfile, country: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Wallet Seed (secret!)</label>
            <input placeholder="Your XRPL wallet seed (keep secret)" value={customerProfile.seed} onChange={(e) => setCustomerProfile({ ...customerProfile, seed: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Wallet Address</label>
            <input placeholder="Your XRPL classic address (r...)" value={customerProfile.classicAddress} onChange={(e) => setCustomerProfile({ ...customerProfile, classicAddress: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <button onClick={saveCustomerProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: '#D4AF37', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', boxShadow: '0 8px 20px rgba(212,175,55,0.3)', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Save Customer Profile
            </button>
            <h3 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '20px' }}>Generate Share Code</h3>
            <button onClick={generateCustomerShareCode} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Generate Code
            </button>
            {customerShareCode && (
              <div style={{ textAlign: 'center' }}>
                <pre style={{ background: '#f0f0f0', padding: '15px', display: 'inline-block', borderRadius: '15px', maxWidth: '600px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{customerShareCode}</pre>
                <button onClick={() => copyToClipboard(customerShareCode, 'Share Code')} style={{ background: '#0066cc', color: 'white', padding: '8px 15px', fontSize: '14px', border: 'none', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s ease', marginLeft: '10px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  📋 Copy
                </button>
              </div>
            )}
            <h3 style={{ color: '#D4AF37', textAlign: 'center', margin: '40px 0 20px' }}>Add Linked Vendor</h3>
            <input placeholder="Enter Vendor Share Code" value={inputVendorCode} onChange={(e) => setInputVendorCode(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <button onClick={addLinkedVendor} style={{ display: 'block', margin: '0 auto 40px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Add Vendor
            </button>
            <h3 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '20px' }}>Linked Vendors</h3>
            <select style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto', display: 'block' }}>
              <option value="">-- Linked Vendors --</option>
              {linkedVendors.map(v => (
                <option key={v.uniqueID} value={v.uniqueID}>{v.uniqueID}</option>
              ))}
            </select>
          </div>
        )}
        {activeTab === 'vendorProfile' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '30px' }}>Vendor Profile</h2>
            <p style={{ textAlign: 'center', marginBottom: '30px' }}>Save vendor company and wallet info — address will auto-fill when creating POs.</p>
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Unique ID / Name</label>
            <input placeholder="Enter unique ID (e.g. VendorABC)" value={vendorProfile.uniqueID} onChange={(e) => setVendorProfile({ ...vendorProfile, uniqueID: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Company Name</label>
            <input placeholder="Vendor company name" value={vendorProfile.company} onChange={(e) => setVendorProfile({ ...vendorProfile, company: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Contact Name</label>
            <input placeholder="Vendor contact name" value={vendorProfile.name} onChange={(e) => setVendorProfile({ ...vendorProfile, name: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Street Address</label>
            <input placeholder="Vendor street address" value={vendorProfile.address} onChange={(e) => setVendorProfile({ ...vendorProfile, address: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', maxWidth: '600px', margin: '0 auto 20px auto' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold' }}>City</label>
                <input placeholder="City" value={vendorProfile.city} onChange={(e) => setVendorProfile({ ...vendorProfile, city: e.target.value })} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold' }}>State / Province</label>
                <input placeholder="State or province" value={vendorProfile.state} onChange={(e) => setVendorProfile({ ...vendorProfile, state: e.target.value })} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold' }}>ZIP / Postal Code</label>
                <input placeholder="ZIP or postal code" value={vendorProfile.zip} onChange={(e) => setVendorProfile({ ...vendorProfile, zip: e.target.value })} style={{ width: '100%', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37' }} />
              </div>
            </div>
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Country</label>
            <input placeholder="Country" value={vendorProfile.country} onChange={(e) => setVendorProfile({ ...vendorProfile, country: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Wallet Seed (secret!)</label>
            <input placeholder="Vendor XRPL wallet seed (keep secret)" value={vendorProfile.seed} onChange={(e) => setVendorProfile({ ...vendorProfile, seed: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <label style={{ display: 'block', marginBottom: '5px', color: '#D4AF37', fontWeight: 'bold', textAlign: 'center' }}>Wallet Address</label>
            <input placeholder="Vendor XRPL classic address (r...)" value={vendorProfile.classicAddress} onChange={(e) => setVendorProfile({ ...vendorProfile, classicAddress: e.target.value })} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <button onClick={saveVendorProfile} style={{ display: 'block', margin: '0 auto 40px auto', background: '#D4AF37', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', boxShadow: '0 8px 20px rgba(212,175,55,0.3)', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Save Vendor Profile
            </button>
            <h3 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '20px' }}>Generate Share Code</h3>
            <button onClick={generateVendorShareCode} style={{ display: 'block', margin: '0 auto 20px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Generate Code
            </button>
            {vendorShareCode && (
              <div style={{ textAlign: 'center' }}>
                <pre style={{ background: '#f0f0f0', padding: '15px', display: 'inline-block', borderRadius: '15px', maxWidth: '600px', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{vendorShareCode}</pre>
                <button onClick={() => copyToClipboard(vendorShareCode, 'Share Code')} style={{ background: '#0066cc', color: 'white', padding: '8px 15px', fontSize: '14px', border: 'none', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s ease', marginLeft: '10px' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
                  📋 Copy
                </button>
              </div>
            )}
            <h3 style={{ color: '#D4AF37', textAlign: 'center', margin: '40px 0 20px' }}>Add Linked Customer</h3>
            <input placeholder="Enter Customer Share Code" value={inputCustomerCode} onChange={(e) => setInputCustomerCode(e.target.value)} style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }} />
            <button onClick={addLinkedCustomer} style={{ display: 'block', margin: '0 auto 40px auto', background: '#27ae60', color: 'white', padding: '15px 50px', fontSize: '18px', border: 'none', borderRadius: '50px', cursor: 'pointer', transition: 'all 0.2s ease' }} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
              Add Customer
            </button>
            <h3 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '20px' }}>Linked Customers</h3>
            <select style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto', display: 'block' }}>
              <option value="">-- Linked Customers --</option>
              {linkedCustomers.map(c => (
                <option key={c.uniqueID} value={c.uniqueID}>{c.uniqueID}</option>
              ))}
            </select>
          </div>
        )}
        {activeTab === 'admin' && (
          <div style={{ background: '#FFF9E6', padding: '30px', borderRadius: '20px', boxShadow: '0 4px 15px rgba(212,175,55,0.1)', maxWidth: '900px', margin: '0 auto' }}>
            <h2 style={{ color: '#D4AF37', textAlign: 'center', marginBottom: '40px' }}>Admin - Fee Dashboard</h2>
            {!adminLoggedIn ? (
              <div>
                <p style={{ textAlign: 'center', marginBottom: '20px' }}>Enter your company seed to access admin features</p>
                <input
                  type="password"
                  placeholder="Company Seed (password)"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  style={{ width: '100%', maxWidth: '600px', padding: '15px', borderRadius: '30px', border: '2px solid #D4AF37', margin: '0 auto 20px auto', display: 'block' }}
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
                  style={{ background: '#D4AF37', color: 'white', padding: '15px 50px', borderRadius: '30px', border: 'none', cursor: 'pointer', transition: 'all 0.2s ease', margin: '0 auto', display: 'block' }}
                >
                  Login
                </button>
              </div>
            ) : (
              <div>
                {/* High-level Stats */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '20px', marginBottom: '40px' }}>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#D4AF37', margin: '0 0 10px' }}>Total SC.PO Created</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>{savedPOs.length}</p>
                  </div>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#D4AF37', margin: '0 0 10px' }}>Total Fees Collected</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                      ${feeEntries.reduce((sum, fee) => sum + parseFloat(fee.amount.split(' ')[0].replace('$', '')), 0).toFixed(2)}
                    </p>
                  </div>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#D4AF37', margin: '0 0 10px' }}>Unique Customers</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                      {new Set(savedPOs.map(po => po.buyerAddress)).size}
                    </p>
                  </div>
                  <div style={{ background: '#FFF3E0', padding: '20px', borderRadius: '20px', textAlign: 'center', height: '120px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h4 style={{ color: '#D4AF37', margin: '0 0 10px' }}>Unique Vendors</h4>
                    <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                      {new Set(savedPOs.map(po => po.vendorAddress)).size}
                    </p>
                  </div>
                </div>
                {/* Line Item Fee Table */}
                <h3 style={{ color: '#D4AF37', marginBottom: '20px' }}>Collected Fees</h3>
                {feeEntries.length === 0 ? (
                  <p>No fees collected yet</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#FFF3E0' }}>
                        <th style={{ padding: '10px' }}>Date</th>
                        <th style={{ padding: '10px' }}>PO Name</th>
                        <th style={{ padding: '10px' }}>Amount</th>
                        <th style={{ padding: '10px' }}>Tx Hash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feeEntries.map((entry, i) => (
                        <tr key={i}>
                          <td style={{ padding: '10px' }}>{entry.date}</td>
                          <td style={{ padding: '10px' }}>{entry.poName}</td>
                          <td style={{ padding: '10px' }}>{entry.amount}</td>
                          <td style={{ padding: '10px' }}>
                            <a href={`https://testnet.xrpl.org/transactions/${entry.txHash}`} target="_blank" rel="noopener noreferrer" style={{ color: '#D4AF37' }}>
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
