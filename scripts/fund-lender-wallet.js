#!/usr/bin/env node

const xrpl = require('xrpl');

const LENDER_SEED = process.env.LENDER_SEED;
const ISSUER_SEED = process.env.ISSUER_SEED;
if (!LENDER_SEED || !ISSUER_SEED) { console.error('Set LENDER_SEED and ISSUER_SEED env vars'); process.exit(1); }
const RLUSD_AMOUNT   = '10000';
const TRUST_LIMIT    = '1000000';
const CURRENCY_CODE  = 'USD';
const DEVNET_URL     = 'wss://s.devnet.rippletest.net:51233';

async function main() {
  console.log('Connecting to devnet...');
  const client = new xrpl.Client(DEVNET_URL);
  await client.connect();
  console.log('✅ Connected');

  const lenderWallet = xrpl.Wallet.fromSeed(LENDER_SEED);
  const issuerWallet = xrpl.Wallet.fromSeed(ISSUER_SEED);
  console.log('Lender:', lenderWallet.classicAddress);
  console.log('Issuer:', issuerWallet.classicAddress);

  console.log('\nStep 1: Setting trust line...');
  const trustResult = await client.submitAndWait({
    TransactionType: 'TrustSet',
    Account: lenderWallet.classicAddress,
    LimitAmount: { currency: CURRENCY_CODE, issuer: issuerWallet.classicAddress, value: TRUST_LIMIT }
  }, { autofill: true, wallet: lenderWallet });
  console.log('Trust line result:', trustResult.result.meta.TransactionResult);

  console.log('\nStep 2: Sending RLUSD...');
  const payResult = await client.submitAndWait({
    TransactionType: 'Payment',
    Account: issuerWallet.classicAddress,
    Destination: lenderWallet.classicAddress,
    Amount: { currency: CURRENCY_CODE, issuer: issuerWallet.classicAddress, value: RLUSD_AMOUNT }
  }, { autofill: true, wallet: issuerWallet });
  console.log('Payment result:', payResult.result.meta.TransactionResult);

  console.log('\nStep 3: Checking balance...');
  const lines = await client.request({ command: 'account_lines', account: lenderWallet.classicAddress, ledger_index: 'validated' });
  const line = lines.result.lines.find(l => l.currency === CURRENCY_CODE && l.account === issuerWallet.classicAddress);
  console.log('Lender RLUSD balance:', line ? line.balance : '0');

  await client.disconnect();
  console.log('\n✅ Done!');
}

main().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
