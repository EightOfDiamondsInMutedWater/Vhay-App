import React, { useState } from 'react';
import * as xrpl from 'xrpl';
import type { EscrowCreate, NFTokenMint } from 'xrpl';
import cc from 'five-bells-condition';
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

  const generateConditionFulfillment = () => {
    const preimageData = new Uint8Array(32);
    window.crypto.getRandomValues(preimageData);
    const myFulfillment = new cc.PreimageSha256();
    myFulfillment.setPreimage(Buffer.from(preimageData));
    const condition = myFulfillment.getConditionBinary().toString('hex').toUpperCase();
    const fulfillmentHex = myFulfillment.serializeBinary().toString('hex').toUpperCase();
    return { condition, fulfillment: fulfillmentHex };
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
    if (!seed) return alert('Wallet seed required (use testnet only!)');
    if (!vendor) return alert('Vendor address required');
    const parsedAmount = parseFloat(amount);
    if (!amount || isNaN(parsedAmount)) return alert('Amount must be a number');
    const drops = xrpl.xrpToDrops(parsedAmount.toString());

    const { condition, fulfillment } = generateConditionFulfillment();
    setFulfillment(fulfillment);

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
      try {
        client = new xrpl.Client('wss://s.altnet.rippletest.net:51234', { connectionTimeout: 20000 });
        await client.connect();
        console.log('XRPL connection successful');
      } catch (connErr) {
        console.error('XRPL connection error details:', connErr);
        throw new Error('XRPL connection failed: ' + (connErr as Error).message);
      }

      const wallet = xrpl.Wallet.fromSeed(seed);

      // Check if account exists
      try {
        await client.request({
          command: 'account_info',
          account: wallet.classicAddress,
          ledger_index: 'validated'
        });
        console.log('Account found and funded');
      } catch (accErr) {
        client.disconnect();
        throw new Error('Account not found – fund it with the testnet faucet: ' + (accErr as Error).message);
      }

      // Get current ledger for LastLedgerSequence
      const ledgerResponse = await client.request({ command: 'ledger_current' });
      const currentLedger = ledgerResponse.result.ledger_current_index;

      // Create conditional escrow
      const escrow: EscrowCreate = {
        TransactionType: 'EscrowCreate',
        Account: wallet.classicAddress,
        Destination: vendor,
        Amount: drops,
        Condition: condition,
        CancelAfter: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days
        Memos: [{ Memo: { MemoData: xrpl.convertStringToHex(JSON.stringify(poData)) } }],
      };
      const preparedEscrow = await client.autofill(escrow);
      preparedEscrow.LastLedgerSequence = currentLedger + 20; // Increase to 20 ledgers for safety
      const signedEscrow = wallet.sign(preparedEscrow);
      const escrowResult = await client.submitAndWait(signedEscrow.tx_blob);

      const isSuccessfulMeta = (meta: unknown): boolean => {
        return typeof meta === 'object' && meta !== null && 'TransactionResult' in meta && (meta as any).TransactionResult === 'tesSUCCESS';
      };

      if (!isSuccessfulMeta(escrowResult.result.meta)) {
        client.disconnect();
        const errorMsg = typeof escrowResult.result.meta === 'string' ? escrowResult.result.meta : 
          (typeof escrowResult.result.meta === 'object' && escrowResult.result.meta !== null && 'TransactionResult' in escrowResult.result.meta 
            ? (escrowResult.result.meta as any).TransactionResult : 'Unknown error');
        throw new Error('Escrow failed: ' + errorMsg);
      }
      const escrowSequence = escrowResult.result.tx_json.Sequence;

      // Mint NFT with IPFS URI and escrow link
      const nft: NFTokenMint = {
        TransactionType: 'NFTokenMint',
        Account: wallet.classicAddress,
        URI: xrpl.convertStringToHex(ipfsUri),
        Flags: 8, // Transferable
        NFTokenTaxon: 0,
        Memos: [{ Memo: { MemoData: xrpl.convertStringToHex(`Escrow Sequence: ${escrowSequence}`) } }],
      };
      const preparedNFT = await client.autofill(nft);
      preparedNFT.LastLedgerSequence = currentLedger + 20; // Increase for safety
      const signedNFT = wallet.sign(preparedNFT);
      const nftResult = await client.submitAndWait(signedNFT.tx_blob);
      client.disconnect();

      if (isSuccessfulMeta(nftResult.result.meta)) {
        setResult(`SC.PO Created! NFT Tx Hash: ${nftResult.result.hash}\nEscrow Tx Hash: ${escrowResult.result.hash}\nFulfillment (save for release): ${fulfillment}\nIPFS URI: ${ipfsUri}`);
      } else {
        const errorMsg = typeof nftResult.result.meta === 'string' ? nftResult.result.meta : 
          (typeof nftResult.result.meta === 'object' && nftResult.result.meta !== null && 'TransactionResult' in nftResult.result.meta 
            ? (nftResult.result.meta as any).TransactionResult : 'Unknown error');
        setResult('NFT Mint failed: ' + errorMsg);
      }
    } catch (err: any) {
      alert('Operation failed: ' + (err as Error).message);
    }
  };

  return (
    <div style={{ padding: '30px', fontFamily: 'Helvetica', maxWidth: '600px', margin: 'auto' }}>
      <h2>Generate SC.PO Token</h2>
      <input placeholder="Your Wallet Seed (TESTNET ONLY!)" value={seed} onChange={(e) => setSeed(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Vendor XRPL address" value={vendor} onChange={(e) => setVendor(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Amount (XRP)" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Department" value={department} onChange={(e) => setDepartment(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Payment Terms" value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Delivery Terms" value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Item #" value={itemNum} onChange={(e) => setItemNum(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <input placeholder="Total ($)" value={total} onChange={(e) => setTotal(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%' }} />
      <textarea placeholder="Goods / description" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ margin: '5px', padding: '10px', width: '100%', height: '80px' }} />
      <button onClick={createSCPO} style={{ background: 'gold', color: 'black', border: 'none', padding: '15px 30px', fontSize: '16px', marginTop: '20px', cursor: 'pointer', width: '100%' }}>
        Make SC.PO Token
      </button>
      {result && <pre style={{ marginTop: '20px', background: '#f0f0f0', padding: '10px' }}>{result}</pre>}
    </div>
  );
}
