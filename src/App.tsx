import React, { useState } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, NFTokenMint, EscrowFinish } from 'xrpl';
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
    const conditionHex = conditionBin.toString('hex');
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
      let client;
      client = new xrpl.Client('wss://testnet.xrpl-labs.com');
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(seed);
      // Account check
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
        Memos: [{
          Memo: {
            MemoData: xrpl.convertStringToHex(JSON.stringify(poData))
          }
        }]
      };
      const preparedEscrow = await client.autofill(escrow);
      preparedEscrow.LastLedgerSequence = currentLedger + 20;
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await client.submitAndWait(signedEscrow.tx_blob);
      // FIX 1 — SAFE META CHECK
      if (
        typeof escrowResult.result.meta !== 'object' ||
        escrowResult.result.meta.TransactionResult !== 'tesSUCCESS'
      ) {
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
        Memos: [{
          Memo: { MemoData: xrpl.convertStringToHex(`Escrow Sequence: ${escrowSequence}`) }
        }]
      };
      const preparedNFT = await client.autofill(nft);
      preparedNFT.LastLedgerSequence = currentLedger + 20;
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await client.submitAndWait(signedNFT.tx_blob);
      client.disconnect();
      // FIX 2 — SAFE META CHECK
      if (
        typeof nftResult.result.meta === 'object' &&
        nftResult.result.meta.TransactionResult === 'tesSUCCESS'
      ) {
        setResult(
          `SC.PO Created! NFT Tx Hash: ${nftResult.result.hash}
Escrow Tx Hash: ${escrowResult.result.hash}
Fulfillment (save for release): ${fulfillment}
Condition: ${condition}
IPFS URI: ${ipfsUri}`
        );
      } else {
        setResult('NFT Mint failed');
      }
    } catch (err: any) {
      alert('Operation failed: ' + err.message);
    }
  };
  const claimEscrow = async () => {
    if (!claimSeed) return alert('Claim seed required');
    if (!claimFulfillment) return alert('Fulfillment code required');
    if (!claimCondition) return alert('Condition required');
    if (!claimOwner) return alert('Owner address required');
    if (!claimOfferSequence || isNaN(Number(claimOfferSequence)))
      return alert('Escrow sequence must be a number');
    try {
      const fulfillmentStr = claimFulfillment.trim();
      const conditionStr = claimCondition.trim().toLowerCase();
      const client = new xrpl.Client('wss://testnet.xrpl-labs.com');
      await client.connect();
      const wallet = xrpl.Wallet.fromSeed(claimSeed);
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;
      const escrowFinish: EscrowFinish = {
        TransactionType: 'EscrowFinish',
        Account: wallet.classicAddress,
        Owner: claimOwner,
        OfferSequence: Number(claimOfferSequence),
        Condition: conditionStr,
        Fulfillment: fulfillmentStr,
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
  return (
    <div style={{ padding: '30px', fontFamily: 'Helvetica', maxWidth: '600px', margin: 'auto' }}>
      <h2>Generate SC.PO Token</h2>
      <input placeholder="Your Wallet Seed" value={seed} onChange={(e) => setSeed(e.target.value)} />
      <input placeholder="Vendor XRPL address" value={vendor} onChange={(e) => setVendor(e.target.value)} />
      <input placeholder="Amount (XRP)" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} />
      <input placeholder="Payment Terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
      <input placeholder="Delivery Terms" value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} />
      <input placeholder="Item #" value={itemNum} onChange={(e) => setItemNum(e.target.value)} />
      <input placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input placeholder="Total ($)" value={total} onChange={(e) => setTotal(e.target.value)} />
      <textarea placeholder="Goods / description" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <button onClick={createSCPO} style={{ background: 'gold', padding: '15px' }}>
        Make SC.PO Token
      </button>
      {result && <pre>{result}</pre>}
      <h2>Claim Escrow</h2>
      <input placeholder="Claim Wallet Seed" value={claimSeed} onChange={(e) => setClaimSeed(e.target.value)} />
      <input placeholder="Fulfillment Code" value={claimFulfillment} onChange={(e) => setClaimFulfillment(e.target.value)} />
      <input placeholder="Condition" value={claimCondition} onChange={(e) => setClaimCondition(e.target.value)} />
      <input placeholder="Owner Address" value={claimOwner} onChange={(e) => setClaimOwner(e.target.value)} />
      <input placeholder="Escrow Sequence" value={claimOfferSequence} onChange={(e) => setClaimOfferSequence(e.target.value)} />
      <button onClick={claimEscrow} style={{ background: 'green', padding: '15px', color: 'white' }}>
        Claim Escrow
      </button>
      {claimResult && <pre>{claimResult}</pre>}
    </div>
  );
}
