import React, { useState, useEffect } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, NFTokenMint, EscrowFinish, NFTokenCreateOffer, NFTokenAcceptOffer } from 'xrpl';
import { Buffer } from 'buffer';

interface Item {
  num: string;
  qty: string;
  total: string;
}

interface POData {
  poName: string;
  description: string;
  department: string;
  paymentTerms: string;
  deliveryTerms: string;
  items: Item[];
  escrowCondition: string;
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
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'create' | 'view' | 'vendor' | 'customerProfile' | 'vendorProfile'>('create');

  // Create Tab States
  const [poName, setPoName] = useState('');
  const [seed, setSeed] = useState('');
  const [vendor, setVendor] = useState('');
  const [desc, setDesc] = useState('');
  const [department, setDepartment] = useState('1');
  const [paymentTerms, setPaymentTerms] = useState('30 Days');
  const [deliveryTerms, setDeliveryTerms] = useState('FOB');
  const [result, setResult] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [condition, setCondition] = useState('');

  // Multi-line items
  const [items, setItems] = useState<Item[]>([{ num: 'T345', qty: '4', total: '400' }]);
  const [newItemNum, setNewItemNum] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newTotal, setNewTotal] = useState('');

  // Auto-calculate total escrow amount
  const [totalEscrowAmount, setTotalEscrowAmount] = useState('400');
  useEffect(() => {
    const total = items.reduce((sum, item) => sum + parseFloat(item.total || '0'), 0);
    setTotalEscrowAmount(total.toString());
  }, [items]);

  const addItem = () => {
    if (newItemNum && newQty && newTotal) {
      setItems([...items, { num: newItemNum, qty: newQty, total: newTotal }]);
      setNewItemNum('');
      setNewQty('');
      setNewTotal('');
    }
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

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

  // Selected POs
  const [selectedOpenPO, setSelectedOpenPO] = useState<SavedPO | null>(null);
  const [selectedAcceptedPO, setSelectedAcceptedPO] = useState<SavedPO | null>(null);

  // View Tab States
  const [ipfsUri, setIpfsUri] = useState('');
  const [viewedPO, setViewedPO] = useState<POData | null>(null);
  const [viewError, setViewError] = useState('');

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

  const viewPOFromUri = async (uri: string) => {
    setIpfsUri(uri);
    setViewError('');
    setViewedPO(null);
    try {
      const hash = uri.replace('ipfs://', '');
      const response = await fetch(`https://ipfs.io/ipfs/${hash}`);
      if (!response.ok) throw new Error('Failed to fetch from IPFS');
      const data = await response.json();
      setViewedPO(data as POData);
    } catch (err: any) {
      setViewError('Error loading PO: ' + err.message);
    }
  };

  // Profile States
  const [customerProfile, setCustomerProfile] = useState<Profile>({
    company: '',
    name: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    country: '',
    seed: '',
    classicAddress: ''
  });

  const [vendorProfile, setVendorProfile] = useState<Profile>({
    company: '',
    name: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    country: '',
    seed: '',
    classicAddress: ''
  });

  useEffect(() => {
    const savedCustomer = localStorage.getItem('customerProfile');
    const savedVendor = localStorage.getItem('vendorProfile');
    if (savedCustomer) setCustomerProfile(JSON.parse(savedCustomer));
    if (savedVendor) setVendorProfile(JSON.parse(savedVendor));
  }, []);

  useEffect(() => {
    if (customerProfile.seed) setSeed(customerProfile.seed);
    if (vendorProfile.classicAddress) setVendor(vendorProfile.classicAddress);
    if (vendorProfile.seed) {
      setVendorAcceptSeed(vendorProfile.seed);
      setClaimSeed(vendorProfile.seed);
    }
    if (customerProfile.classicAddress) setClaimOwner(customerProfile.classicAddress);
  }, [customerProfile, vendorProfile]);

  const saveCustomerProfile = () => {
    localStorage.setItem('customerProfile', JSON.stringify(customerProfile));
    alert('Customer profile saved!');
  };

  const saveVendorProfile = () => {
    localStorage.setItem('vendorProfile', JSON.stringify(vendorProfile));
    alert('Vendor profile saved!');
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
    setCondition(conditionHex);
    setFulfillment(fulfillmentBase64);
    return { condition: conditionHex, fulfillment: fulfillmentBase64 };
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

  const createSCPO = async () => {
    if (!poName) return alert('PO Name is required');
    if (!seed) return alert('Wallet seed required');
    if (!vendor) return alert('Vendor address required');
    if (items.length === 0) return alert('Add at least one item');
    if (parseFloat(totalEscrowAmount) <= 0) return alert('Total amount must be greater than 0');

    const drops = xrpl.xrpToDrops(totalEscrowAmount);
    const { condition, fulfillment } = await generateConditionFulfillment();
    const poData: POData = {
      poName,
      description: desc,
      department,
      paymentTerms,
      deliveryTerms,
      items,
      escrowCondition: condition,
    };
    try {
      const ipfsUri = await uploadToIPFS(poData);
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(seed);
      await client.request({
        command: 'account_info',
        account: wallet.classicAddress,
        ledger_index: 'validated'
      });
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;

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
        const created = (offerResult.result.meta as any).AffectedNodes
          .find((node: any) => node.CreatedNode && node.CreatedNode.LedgerEntryType === 'NFTokenOffer');
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

      // Save to localStorage
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
        offerIndex
      };
      saveNewPO(newPO);

      setResult(
        `SC.PO Created Successfully!\n` +
        `PO Name: ${poName}\n` +
        `Total Escrow Amount: $${totalEscrowAmount}\n` +
        `NFT ID: ${justMintedNFT}\n` +
        `Escrow Sequence: ${escrowSequence}\n` +
        `Fulfillment: ${fulfillment}\n` +
        `IPFS URI: ${ipfsUri}\n` +
        `OfferIndex: ${offerIndex}\n` +
        `Check View SC.PO tab for status.`
      );

      client.disconnect();
    } catch (err: any) {
      alert('Operation failed: ' + err.message);
      setResult('Error: ' + err.message);
    }
  };

  const claimEscrow = async () => {
    if (!selectedAcceptedPO) return alert('Select an Accepted PO first');
    if (!claimSeed) return alert('Claim seed required');
    try {
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
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
      setClaimResult(`Escrow claimed! Tx Hash: ${result.result.hash}`);
      updatePOStatus(selectedAcceptedPO.id, 'Closed');
    } catch (err: any) {
      alert('Claim failed: ' + err.message);
    }
  };

  const acceptNFT = async () => {
    if (!selectedOpenPO) return alert('Select an Open PO first');
    if (!vendorAcceptSeed) return alert('Vendor wallet seed required');
    try {
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
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
        setAcceptResult(`NFT Accepted! Tx Hash: ${acceptResultTx.result.hash}`);
        updatePOStatus(selectedOpenPO.id, 'Accepted');
      } else {
        setAcceptResult(`Accept failed: ${meta?.TransactionResult || 'unknown error'}`);
      }
    } catch (err: any) {
      alert('Accept failed: ' + err.message);
      setAcceptResult('Error: ' + err.message);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    alert(`${label} copied to clipboard!`);
  };

  const getFulfillmentFromResult = () => result.match(/Fulfillment \(base64 - give to vendor\): (.*)/)?.[1] || '';
  const getOfferIndexFromResult = () => result.match(/0 XRP OfferIndex \(give to vendor\): (.*)/)?.[1].trim() || '';
  const getConditionFromResult = () => result.match(/Condition: (.*)/)?.[1] || '';
  const getEscrowSequenceFromResult = () => result.match(/Escrow Sequence: (.*)/)?.[1] || '';

  return (
    <div style={{ padding: '30px', fontFamily: 'Helvetica', maxWidth: '900px', margin: 'auto' }}>
      <h1 style={{ color: '#D4AF37', textAlign: 'center' }}>SC.PO Generator</h1>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
        <button onClick={() => setActiveTab('create')} style={{ padding: '10px 20px', background: activeTab === 'create' ? '#D4AF37' : '#ccc', color: 'white', border: 'none', cursor: 'pointer' }}>
          Create SC.PO
        </button>
        <button onClick={() => setActiveTab('view')} style={{ padding: '10px 20px', background: activeTab === 'view' ? '#D4AF37' : '#ccc', color: 'white', border: 'none', cursor: 'pointer', marginLeft: '10px' }}>
          View SC.PO
        </button>
        <button onClick={() => setActiveTab('vendor')} style={{ padding: '10px 20px', background: activeTab === 'vendor' ? '#D4AF37' : '#ccc', color: 'white', border: 'none', cursor: 'pointer', marginLeft: '10px' }}>
          Vendor
        </button>
        <button onClick={() => setActiveTab('customerProfile')} style={{ padding: '10px 20px', background: activeTab === 'customerProfile' ? '#D4AF37' : '#ccc', color: 'white', border: 'none', cursor: 'pointer', marginLeft: '10px' }}>
          Customer Profile
        </button>
        <button onClick={() => setActiveTab('vendorProfile')} style={{ padding: '10px 20px', background: activeTab === 'vendorProfile' ? '#D4AF37' : '#ccc', color: 'white', border: 'none', cursor: 'pointer', marginLeft: '10px' }}>
          Vendor Profile
        </button>
      </div>

      {activeTab === 'create' ? (
        <div>
          <h3>PO Name (for tracking)</h3>
          <input style={{ width: '100%' }} placeholder="e.g. Widget Order Dec 2025" value={poName} onChange={(e) => setPoName(e.target.value)} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>
            <div>
              <h3>Buyer Wallet Seed</h3>
              <input style={{ width: '100%' }} placeholder="Your Wallet Seed (secret!)" value={seed} onChange={(e) => setSeed(e.target.value)} />
              <h3>PO Details</h3>
              <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} />
              <input placeholder="Payment Terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
              <input placeholder="Delivery Terms" value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} />
              <textarea placeholder="Description / Goods" value={desc} onChange={(e) => setDesc(e.target.value)} />
            </div>
            <div>
              <h3>Vendor XRPL Address</h3>
              <input style={{ width: '100%' }} placeholder="Vendor Address" value={vendor} onChange={(e) => setVendor(e.target.value)} />
              <h3>Total Escrow Amount (auto-calculated)</h3>
              <input style={{ width: '100%', background: '#f0f0f0' }} value={`$${totalEscrowAmount}`} disabled />
            </div>
          </div>

          <h3 style={{ marginTop: '20px' }}>Items</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f0f0f0' }}>
                <th style={{ padding: '8px', border: '1px solid #ddd' }}>Item #</th>
                <th style={{ padding: '8px', border: '1px solid #ddd' }}>Qty</th>
                <th style={{ padding: '8px', border: '1px solid #ddd' }}>Total $</th>
                <th style={{ padding: '8px', border: '1px solid #ddd' }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index}>
                  <td style={{ padding: '8px', border: '1px solid #ddd' }}>{item.num}</td>
                  <td style={{ padding: '8px', border: '1px solid #ddd' }}>{item.qty}</td>
                  <td style={{ padding: '8px', border: '1px solid #ddd' }}>${item.total}</td>
                  <td style={{ padding: '8px', border: '1px solid #ddd' }}>
                    <button onClick={() => removeItem(index)} style={{ background: 'red', color: 'white', padding: '5px 10px' }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={{ marginTop: '10px' }}>Add New Item</h4>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
            <input placeholder="Item #" value={newItemNum} onChange={(e) => setNewItemNum(e.target.value)} />
            <input placeholder="Quantity" value={newQty} onChange={(e) => setNewQty(e.target.value)} />
            <input placeholder="Total $" value={newTotal} onChange={(e) => setNewTotal(e.target.value)} />
            <button onClick={addItem} style={{ background: '#D4AF37', color: 'white', padding: '10px' }}>Add Item</button>
          </div>

          <button onClick={createSCPO} style={{ background: '#D4AF37', color: 'white', padding: '15px', marginTop: '20px', width: '100%', fontSize: '18px' }}>
            Make SC.PO Token
          </button>

          {result && (
            <div style={{ marginTop: '30px' }}>
              <pre style={{ background: '#f0f0f0', padding: '15px', whiteSpace: 'pre-wrap', border: '1px solid #ddd' }}>
                {result}
              </pre>

              <div style={{ marginTop: '20px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                <button onClick={() => copyToClipboard(getFulfillmentFromResult(), 'Fulfillment')} style={{ background: '#0066cc', color: 'white', padding: '15px 30px', fontSize: '18px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                  📋 Copy Fulfillment Code
                </button>
                <button onClick={() => copyToClipboard(getOfferIndexFromResult(), 'OfferIndex')} style={{ background: '#0066cc', color: 'white', padding: '15px 30px', fontSize: '18px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                  📋 Copy OfferIndex
                </button>
                <button onClick={() => copyToClipboard(getConditionFromResult(), 'Condition')} style={{ background: '#0066cc', color: 'white', padding: '15px 30px', fontSize: '18px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                  📋 Copy Condition
                </button>
                <button onClick={() => copyToClipboard(getEscrowSequenceFromResult(), 'Escrow Sequence')} style={{ background: '#0066cc', color: 'white', padding: '15px 30px', fontSize: '18px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                  📋 Copy Escrow Sequence
                </button>
              </div>
            </div>
          )}
        </div>
      ) : activeTab === 'view' ? (
        <div>
          <h2 style={{ color: '#D4AF37' }}>SC.PO Status Dashboard</h2>

          <h3 style={{ marginTop: '30px' }}>Open SC.PO</h3>
          {savedPOs.filter(p => p.status === 'Open').length === 0 ? <p>No open POs</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f0f0f0' }}>
                  <th style={{ padding: '10px', textAlign: 'left' }}>PO Name</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Date Issued</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Total $</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>View Details</th>
                </tr>
              </thead>
              <tbody>
                {savedPOs.filter(p => p.status === 'Open').map(po => (
                  <tr key={po.id}>
                    <td style={{ padding: '10px' }}>{po.poName}</td>
                    <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                    <td style={{ padding: '10px' }}>${po.total}</td>
                    <td style={{ padding: '10px' }}>
                      <button onClick={() => viewPOFromUri(po.ipfsUri)} style={{ background: '#228B22', color: 'white', padding: '8px' }}>View PO</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 style={{ marginTop: '40px' }}>Accepted SC.PO</h3>
          {savedPOs.filter(p => p.status === 'Accepted').length === 0 ? <p>No accepted POs</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f0f0f0' }}>
                  <th style={{ padding: '10px', textAlign: 'left' }}>PO Name</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Date Issued</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Total $</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>View Details</th>
                </tr>
              </thead>
              <tbody>
                {savedPOs.filter(p => p.status === 'Accepted').map(po => (
                  <tr key={po.id}>
                    <td style={{ padding: '10px' }}>{po.poName}</td>
                    <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                    <td style={{ padding: '10px' }}>${po.total}</td>
                    <td style={{ padding: '10px' }}>
                      <button onClick={() => viewPOFromUri(po.ipfsUri)} style={{ background: '#228B22', color: 'white', padding: '8px' }}>View PO</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3 style={{ marginTop: '40px' }}>Closed SC.PO</h3>
          {savedPOs.filter(p => p.status === 'Closed').length === 0 ? <p>No closed POs</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f0f0f0' }}>
                  <th style={{ padding: '10px', textAlign: 'left' }}>PO Name</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Date Issued</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>Total $</th>
                  <th style={{ padding: '10px', textAlign: 'left' }}>View Details</th>
                </tr>
              </thead>
              <tbody>
                {savedPOs.filter(p => p.status === 'Closed').map(po => (
                  <tr key={po.id}>
                    <td style={{ padding: '10px' }}>{po.poName}</td>
                    <td style={{ padding: '10px' }}>{po.dateIssued}</td>
                    <td style={{ padding: '10px' }}>${po.total}</td>
                    <td style={{ padding: '10px' }}>
                      <button onClick={() => viewPOFromUri(po.ipfsUri)} style={{ background: '#228B22', color: 'white', padding: '8px' }}>View PO</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {viewedPO && (
            <div style={{ marginTop: '40px', border: '1px solid #ddd', padding: '15px', background: '#f9f9f9' }}>
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
            </div>
          )}
        </div>
      ) : activeTab === 'vendor' ? (
        <div>
          <h2 style={{ color: '#D4AF37' }}>Vendor Actions</h2>

          {/* Dropdown for Open POs */}
          <h3>Select Open SC.PO for Acceptance</h3>
          <select onChange={(e) => {
            const po = savedPOs.find(p => p.id === e.target.value);
            setSelectedOpenPO(po || null);
            if (po) {
              setOfferIndex(po.offerIndex);
            }
          }} style={{ width: '100%', padding: '10px', marginBottom: '20px' }}>
            <option value="">-- Select Open PO --</option>
            {savedPOs.filter(p => p.status === 'Open').map(po => (
              <option key={po.id} value={po.id}>{po.poName} ({po.dateIssued} - ${po.total})</option>
            ))}
          </select>

          <h3>Accept SC.PO NFT Token</h3>
          <p>Vendor accepts the free NFT offer to own the PO token.</p>
          <input placeholder="Vendor Wallet Seed (auto-filled)" value={vendorAcceptSeed} onChange={(e) => setVendorAcceptSeed(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="OfferIndex" value={offerIndex} onChange={(e) => setOfferIndex(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <button onClick={acceptNFT} style={{ background: '#228B22', color: 'white', padding: '15px', width: '100%' }}>
            Accept SC.PO NFT
          </button>
          {acceptResult && <pre style={{ background: '#e0ffe0', padding: '15px', marginTop: '20px' }}>{acceptResult}</pre>}

          {/* Dropdown for Accepted POs */}
          <h3 style={{ marginTop: '40px' }}>Select Accepted SC.PO for Claim</h3>
          <select onChange={(e) => {
            const po = savedPOs.find(p => p.id === e.target.value);
            setSelectedAcceptedPO(po || null);
            if (po) {
              setClaimFulfillment(po.fulfillment);
              setClaimCondition(po.condition);
              setClaimOfferSequence(po.escrowSequence.toString());
            }
          }} style={{ width: '100%', padding: '10px', marginBottom: '20px' }}>
            <option value="">-- Select Accepted PO --</option>
            {savedPOs.filter(p => p.status === 'Accepted').map(po => (
              <option key={po.id} value={po.id}>{po.poName} ({po.dateIssued} - ${po.total})</option>
            ))}
          </select>

          <h3>Claim Escrow</h3>
          <input placeholder="Claim Wallet Seed (auto-filled)" value={claimSeed} onChange={(e) => setClaimSeed(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Fulfillment Code (base64)" value={claimFulfillment} onChange={(e) => setClaimFulfillment(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Condition" value={claimCondition} onChange={(e) => setClaimCondition(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Owner Address (auto-filled)" value={claimOwner} onChange={(e) => setClaimOwner(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Escrow Sequence" value={claimOfferSequence} onChange={(e) => setClaimOfferSequence(e.target.value)} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <button onClick={claimEscrow} style={{ background: 'green', color: 'white', padding: '15px', width: '100%' }}>
            Claim Escrow
          </button>
          {claimResult && <pre style={{ background: '#e0ffe0', padding: '15px', marginTop: '20px' }}>{claimResult}</pre>}
        </div>
      ) : activeTab === 'customerProfile' ? (
        <div>
          <h2 style={{ color: '#D4AF37' }}>Customer Profile</h2>
          <p>Save your company and wallet info — seed will auto-fill when creating POs.</p>
          <input placeholder="Company Name" value={customerProfile.company} onChange={(e) => setCustomerProfile({ ...customerProfile, company: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Contact Name" value={customerProfile.name} onChange={(e) => setCustomerProfile({ ...customerProfile, name: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Address" value={customerProfile.address} onChange={(e) => setCustomerProfile({ ...customerProfile, address: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="City" value={customerProfile.city} onChange={(e) => setCustomerProfile({ ...customerProfile, city: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="State" value={customerProfile.state} onChange={(e) => setCustomerProfile({ ...customerProfile, state: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="ZIP" value={customerProfile.zip} onChange={(e) => setCustomerProfile({ ...customerProfile, zip: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Country" value={customerProfile.country} onChange={(e) => setCustomerProfile({ ...customerProfile, country: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Wallet Seed (secret!)" value={customerProfile.seed} onChange={(e) => setCustomerProfile({ ...customerProfile, seed: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Wallet Address" value={customerProfile.classicAddress} onChange={(e) => setCustomerProfile({ ...customerProfile, classicAddress: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '20px' }} />
          <button onClick={saveCustomerProfile} style={{ background: '#D4AF37', color: 'white', padding: '15px', width: '100%' }}>
            Save Customer Profile
          </button>
        </div>
      ) : (
        <div>
          <h2 style={{ color: '#D4AF37' }}>Vendor Profile</h2>
          <p>Save vendor company and wallet info — address will auto-fill when creating POs.</p>
          <input placeholder="Company Name" value={vendorProfile.company} onChange={(e) => setVendorProfile({ ...vendorProfile, company: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Contact Name" value={vendorProfile.name} onChange={(e) => setVendorProfile({ ...vendorProfile, name: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Address" value={vendorProfile.address} onChange={(e) => setVendorProfile({ ...vendorProfile, address: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="City" value={vendorProfile.city} onChange={(e) => setVendorProfile({ ...vendorProfile, city: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="State" value={vendorProfile.state} onChange={(e) => setVendorProfile({ ...vendorProfile, state: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="ZIP" value={vendorProfile.zip} onChange={(e) => setVendorProfile({ ...vendorProfile, zip: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Country" value={vendorProfile.country} onChange={(e) => setVendorProfile({ ...vendorProfile, country: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Wallet Seed (secret!)" value={vendorProfile.seed} onChange={(e) => setVendorProfile({ ...vendorProfile, seed: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '10px' }} />
          <input placeholder="Wallet Address" value={vendorProfile.classicAddress} onChange={(e) => setVendorProfile({ ...vendorProfile, classicAddress: e.target.value })} style={{ width: '100%', padding: '10px', marginBottom: '20px' }} />
          <button onClick={saveVendorProfile} style={{ background: '#D4AF37', color: 'white', padding: '15px', width: '100%' }}>
            Save Vendor Profile
          </button>
        </div>
      )}
    </div>
  );
}
