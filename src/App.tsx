import React, { useState } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, NFTokenMint, EscrowFinish, NFTokenCreateOffer, NFTokenAcceptOffer } from 'xrpl';
import { Buffer } from 'buffer';

interface POData {
  description: string;
  department: string;
  paymentTerms: string;
  deliveryTerms: string;
  item: { num: string; qty: string; total: string };
  escrowCondition: string;
}

export default function App() {
  const [seed, setSeed] = useState('');
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState('');
  const [desc, setDesc] = useState('');
  const [department, setDepartment] = useState('1');
  const [paymentTerms, setPaymentTerms] = useState('30 Days');
  const [deliveryTerms, setDeliveryTerms] = useState('FOB');
  const [itemNum, setItemNum] = useState('T345');
  const [qty, setQty] = useState('4');
  const [total, setTotal] = useState('400');
  const [result, setResult] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [condition, setCondition] = useState('');
  const [claimSeed, setClaimSeed] = useState('');
  const [claimFulfillment, setClaimFulfillment] = useState('');
  const [claimCondition, setClaimCondition] = useState('');
  const [claimOwner, setClaimOwner] = useState('');
  const [claimOfferSequence, setClaimOfferSequence] = useState('');
  const [claimResult, setClaimResult] = useState('');

  // Vendor Accept NFT states
  const [vendorAcceptSeed, setVendorAcceptSeed] = useState('');
  const [offerIndex, setOfferIndex] = useState('');
  const [acceptResult, setAcceptResult] = useState('');

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
    if (!seed) return alert('Wallet seed required');
    if (!vendor) return alert('Vendor address required');
    const parsedAmount = parseFloat(amount);
    if (!amount || isNaN(parsedAmount)) return alert('Amount must be a number');
    const drops = xrpl.xrpToDrops(parsedAmount.toString());
    const { condition, fulfillment } = await generateConditionFulfillment();
    const poData: POData = {
      description: desc,
      department,
      paymentTerms,
      deliveryTerms,
      item: { num: itemNum, qty, total },
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

      // ESCROW CREATE
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
      const escrowSequence = escrowResult.result.tx_json.Sequence;

      // NFT MINT
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

      // Get minted NFT ID
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

      // 0 XRP SELL OFFER
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

      // Primary: from metadata (correct field name)
      let offerIndex = 'unknown';
      if (typeof offerResult.result.meta === 'object' && offerResult.result.meta.TransactionResult === 'tesSUCCESS') {
        const created = (offerResult.result.meta as any).AffectedNodes
          .find((node: any) => node.CreatedNode && node.CreatedNode.LedgerEntryType === 'NFTokenOffer');
        if (created?.CreatedNode?.NewFields?.nft_offer_index) {
          offerIndex = created.CreatedNode.NewFields.nft_offer_index;
        }
      }

      // Permanent fix: query nft_sell_offers (most reliable on Testnet)
      if (offerIndex === 'unknown') {
        try {
          const offersResp = await client.request({
            command: 'nft_sell_offers',
            nft_id: justMintedNFT
          });
          const offers = offersResp.result.offers || [];
          const ourOffer = offers.find((o: any) => o.owner === wallet.classicAddress && o.amount === '0');
          if (ourOffer && ourOffer.nft_offer_index) {
            offerIndex = ourOffer.nft_offer_index;
          }
        } catch (e) {
          console.warn('nft_sell_offers fallback failed', e);
        }
      }

      setResult(
        `SC.PO Created Successfully!\n` +
        `NFT ID: ${justMintedNFT}\n` +
        `NFT Tx Hash: ${nftResult.result.hash}\n` +
        `Escrow Tx Hash: ${escrowResult.result.hash}\n` +
        `Escrow Sequence: ${escrowSequence}\n` +
        `Condition: ${condition}\n` +
        `Fulfillment (base64 - give to vendor): ${fulfillment}\n` +
        `IPFS URI: ${ipfsUri}\n` +
        `0 XRP OfferIndex (give to vendor): ${offerIndex}\n` +
        `Vendor can paste OfferIndex below to accept the NFT.`
      );

      client.disconnect();
    } catch (err: any) {
      alert('Operation failed: ' + err.message);
      setResult('Error: ' + err.message);
    }
  };

  const claimEscrow = async () => {
    if (!claimSeed) return alert('Claim seed required');
    if (!claimFulfillment) return alert('Fulfillment code required');
    if (!claimCondition) return alert('Condition required');
    if (!claimOwner) return alert('Owner address required');
    if (!claimOfferSequence || isNaN(Number(claimOfferSequence))) return alert('Escrow sequence must be a number');
    try {
      const fulfillmentStr = claimFulfillment.trim();
      const conditionStr = claimCondition.trim().toUpperCase();
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(claimSeed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const fulfillmentHex = Buffer.from(fulfillmentStr, 'base64').toString('hex');
      const escrowFinish: EscrowFinish = {
        TransactionType: 'EscrowFinish',
        Account: wallet.classicAddress,
        Owner: claimOwner,
        OfferSequence: Number(claimOfferSequence),
        Condition: conditionStr,
        Fulfillment: fulfillmentHex,
      };
      const prepared = await client.autofill(escrowFinish);
      prepared.LastLedgerSequence = currentLedger + 20;
      const signed = wallet.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);
      client.disconnect();
      setClaimResult(`Escrow claimed! Tx Hash: ${result.result.hash}`);
    } catch (err: any) {
      alert('Claim failed: ' + err.message);
    }
  };

  const acceptNFT = async () => {
    if (!vendorAcceptSeed) return alert('Vendor wallet seed required');
    if (!offerIndex) return alert('Paste the OfferIndex from buyer result');

    try {
      const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(vendorAcceptSeed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;

      const acceptTx: NFTokenAcceptOffer = {
        TransactionType: 'NFTokenAcceptOffer',
        Account: wallet.classicAddress,
        NFTokenSellOffer: offerIndex.trim(),
      };
      const prepared = await client.autofill(acceptTx);
      prepared.LastLedgerSequence = currentLedger + 20;
      const signed = wallet.sign(prepared);
      const acceptResultTx = await client.submitAndWait(signed.tx_blob);
      client.disconnect();

      const meta = typeof acceptResultTx.result.meta === 'object' ? acceptResultTx.result.meta : null;
      if (meta && meta.TransactionResult === 'tesSUCCESS') {
        setAcceptResult(`NFT Accepted! Vendor now owns the SC.PO token.\nTx Hash: ${acceptResultTx.result.hash}`);
      } else {
        setAcceptResult(`Accept failed: ${meta?.TransactionResult || 'unknown error'}`);
      }
    } catch (err: any) {
      alert('Accept failed: ' + err.message);
      setAcceptResult('Error: ' + err.message);
    }
  };

  return (
    <div style={{ padding: '30px', fontFamily: 'Helvetica', maxWidth: '800px', margin: 'auto' }}>
      <h1 style={{ color: '#D4AF37' }}>SC.PO Generator</h1>

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
          <h3>Amount & Items</h3>
          <input placeholder="Amount (XRP to escrow)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input placeholder="Item #" value={itemNum} onChange={(e) => setItemNum(e.target.value)} />
          <input placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} />
          <input placeholder="Total ($)" value={total} onChange={(e) => setTotal(e.target.value)} />
        </div>
      </div>

      <button onClick={createSCPO} style={{ background: '#D4AF37', color: 'white', padding: '15px', marginTop: '20px', width: '100%', fontSize: '18px' }}>
        Make SC.PO Token
      </button>

      {result && <pre style={{ background: '#f0f0f0', padding: '15px', marginTop: '20px', whiteSpace: 'pre-wrap' }}>{result}</pre>}

      <h2 style={{ marginTop: '40px' }}>Claim Escrow</h2>
      <input placeholder="Claim Wallet Seed" value={claimSeed} onChange={(e) => setClaimSeed(e.target.value)} />
      <input placeholder="Fulfillment Code (base64)" value={claimFulfillment} onChange={(e) => setClaimFulfillment(e.target.value)} />
      <input placeholder="Condition" value={claimCondition} onChange={(e) => setClaimCondition(e.target.value)} />
      <input placeholder="Owner Address" value={claimOwner} onChange={(e) => setClaimOwner(e.target.value)} />
      <input placeholder="Escrow Sequence" value={claimOfferSequence} onChange={(e) => setClaimOfferSequence(e.target.value)} />
      <button onClick={claimEscrow} style={{ background: 'green', padding: '15px', color: 'white', marginTop: '10px' }}>
        Claim Escrow
      </button>
      {claimResult && <pre style={{ background: '#e0ffe0', padding: '15px' }}>{claimResult}</pre>}

      <h2 style={{ marginTop: '40px', color: '#D4AF37' }}>Vendor: Accept SC.PO NFT Token</h2>
      <p>Vendor accepts the free NFT offer to own the PO token.</p>
      <input placeholder="Vendor Wallet Seed (secret!)" value={vendorAcceptSeed} onChange={(e) => setVendorAcceptSeed(e.target.value)} />
      <input placeholder="OfferIndex (from buyer result)" value={offerIndex} onChange={(e) => setOfferIndex(e.target.value)} />
      <button onClick={acceptNFT} style={{ background: '#228B22', color: 'white', padding: '15px', marginTop: '10px' }}>
        Accept SC.PO NFT
      </button>
      {acceptResult && <pre style={{ background: '#e0ffe0', padding: '15px', marginTop: '10px' }}>{acceptResult}</pre>}
    </div>
  );
}
