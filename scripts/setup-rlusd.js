#!/usr/bin/env node

/**
 * SC.PO — Task 2.1: Mint Test RLUSD on Devnet
 * 
 * Run once: node scripts/setup-rlusd.js
 * 
 * What this does:
 * 1. Creates a dedicated RLUSD issuer wallet via devnet faucet
 * 2. Enables DefaultRipple on the issuer (required for token transfers between third parties)
 * 3. Sets up trust lines from your existing buyer + vendor wallets to the issuer
 * 4. Sends test RLUSD ($10,000 each) to both wallets
 * 5. Prints the env variable you need to add to .env
 *
 * Prerequisites:
 * - Your buyer and vendor wallets must already exist and be funded on devnet
 * - npm install xrpl (already in your project)
 * 
 * Re-run safe: If devnet resets, just run this again to bootstrap a fresh issuer.
 */

const xrpl = require('xrpl');

// ============================================================
// CONFIGURATION — Update these with your existing wallet seeds
// ============================================================
const BUYER_SEED = process.env.REACT_APP_BUYER_SEED ||'sEdSjPzCe4LGkGuJ7xVEt1EsAvHUCmd';
const VENDOR_SEED = process.env.REACT_APP_VENDOR_SEED ||'sEdTNzxUVqnj7mEVeigwA3iz21pHEgw';

// How much test RLUSD to send to each wallet
const RLUSD_AMOUNT_PER_WALLET = '10000';

// Trust line limit (max RLUSD a wallet can hold)
const TRUST_LINE_LIMIT = '1000000';

// Currency code — use 'USD' to match real RLUSD on mainnet
// On XRPL, a token is identified by currency + issuer together
// So 'USD' issued by your test issuer ≠ 'USD' issued by Ripple
// When you move to mainnet, you just swap the issuer address
const CURRENCY_CODE = 'USD';

const DEVNET_URL = 'wss://s.devnet.rippletest.net:51233';
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('SC.PO — Task 2.1: Mint Test RLUSD on Devnet');
  console.log('='.repeat(60));
  console.log('');

  // Validate seeds
  if (BUYER_SEED === 'PASTE_YOUR_BUYER_SEED_HERE' || VENDOR_SEED === 'PASTE_YOUR_VENDOR_SEED_HERE') {
    console.error('❌ ERROR: Update BUYER_SEED and VENDOR_SEED in this script first.');
    console.error('   Open scripts/setup-rlusd.js and paste your existing devnet wallet seeds.');
    process.exit(1);
  }

  const client = new xrpl.Client(DEVNET_URL);
  
  try {
    console.log('Connecting to devnet...');
    await client.connect();
    console.log('✅ Connected to', DEVNET_URL);
    console.log('');

    // Derive existing wallets from seeds
    const buyerWallet = xrpl.Wallet.fromSeed(BUYER_SEED);
    const vendorWallet = xrpl.Wallet.fromSeed(VENDOR_SEED);
    console.log('Buyer wallet:  ', buyerWallet.classicAddress);
    console.log('Vendor wallet: ', vendorWallet.classicAddress);
    console.log('');

    // ── Step 1: Create RLUSD Issuer Wallet ─────────────────────
    console.log('Step 1: Creating RLUSD issuer wallet via devnet faucet...');
    const fundResult = await client.fundWallet();
    const issuerWallet = fundResult.wallet;
    console.log('✅ Issuer wallet created');
    console.log('   Address: ', issuerWallet.classicAddress);
    console.log('   Seed:    ', issuerWallet.seed);
    console.log('   Balance: ', fundResult.balance, 'XRP');
    console.log('');

    // ── Step 2: Enable DefaultRipple on Issuer ─────────────────
    // This flag allows tokens issued by this wallet to be transferred
    // between third parties (buyer → escrow → vendor). Without it,
    // only direct transfers to/from the issuer would work.
    console.log('Step 2: Enabling DefaultRipple on issuer...');
    const accountSetTx = {
      TransactionType: 'AccountSet',
      Account: issuerWallet.classicAddress,
      SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple
    };
    const accountSetResult = await client.submitAndWait(accountSetTx, {
      autofill: true,
      wallet: issuerWallet
    });
    const accountSetMeta = accountSetResult.result.meta;
    if (typeof accountSetMeta === 'object' && accountSetMeta.TransactionResult === 'tesSUCCESS') {
      console.log('✅ DefaultRipple enabled');
    } else {
      throw new Error('AccountSet failed: ' + (typeof accountSetMeta === 'object' ? accountSetMeta.TransactionResult : accountSetMeta));
    }
    console.log('');

    // ── Step 3: Set Up Trust Lines ─────────────────────────────
    // Each wallet needs a trust line to the issuer before it can hold RLUSD
    console.log('Step 3: Setting up trust lines...');

    for (const [label, wallet] of [['Buyer', buyerWallet], ['Vendor', vendorWallet]]) {
      console.log(`   Setting trust line for ${label} (${wallet.classicAddress})...`);
      const trustSetTx = {
        TransactionType: 'TrustSet',
        Account: wallet.classicAddress,
        LimitAmount: {
          currency: CURRENCY_CODE,
          issuer: issuerWallet.classicAddress,
          value: TRUST_LINE_LIMIT
        }
      };
      const trustResult = await client.submitAndWait(trustSetTx, {
        autofill: true,
        wallet: wallet
      });
      const trustMeta = trustResult.result.meta;
      if (typeof trustMeta === 'object' && trustMeta.TransactionResult === 'tesSUCCESS') {
        console.log(`   ✅ ${label} trust line set (limit: ${TRUST_LINE_LIMIT} ${CURRENCY_CODE})`);
      } else {
        throw new Error(`TrustSet failed for ${label}: ` + (typeof trustMeta === 'object' ? trustMeta.TransactionResult : trustMeta));
      }
    }
    console.log('');

    // ── Step 4: Send Test RLUSD ────────────────────────────────
    console.log('Step 4: Distributing test RLUSD...');

    for (const [label, wallet] of [['Buyer', buyerWallet], ['Vendor', vendorWallet]]) {
      console.log(`   Sending ${RLUSD_AMOUNT_PER_WALLET} ${CURRENCY_CODE} to ${label}...`);
      const paymentTx = {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: wallet.classicAddress,
        Amount: {
          currency: CURRENCY_CODE,
          issuer: issuerWallet.classicAddress,
          value: RLUSD_AMOUNT_PER_WALLET
        }
      };
      const payResult = await client.submitAndWait(paymentTx, {
        autofill: true,
        wallet: issuerWallet
      });
      const payMeta = payResult.result.meta;
      if (typeof payMeta === 'object' && payMeta.TransactionResult === 'tesSUCCESS') {
        console.log(`   ✅ ${label} received ${RLUSD_AMOUNT_PER_WALLET} ${CURRENCY_CODE}`);
      } else {
        throw new Error(`Payment failed for ${label}: ` + (typeof payMeta === 'object' ? payMeta.TransactionResult : payMeta));
      }
    }
    console.log('');

    // ── Step 5: Verify Balances ────────────────────────────────
    console.log('Step 5: Verifying balances...');
    for (const [label, wallet] of [['Buyer', buyerWallet], ['Vendor', vendorWallet]]) {
      const balances = await client.request({
        command: 'account_lines',
        account: wallet.classicAddress,
        ledger_index: 'validated'
      });
      const rlusdLine = balances.result.lines.find(
        line => line.currency === CURRENCY_CODE && line.account === issuerWallet.classicAddress
      );
      if (rlusdLine) {
        console.log(`   ${label}: ${rlusdLine.balance} ${CURRENCY_CODE} ✅`);
      } else {
        console.log(`   ${label}: No ${CURRENCY_CODE} balance found ❌`);
      }
    }
    console.log('');

    // ── Done! ──────────────────────────────────────────────────
    console.log('='.repeat(60));
    console.log('✅ SETUP COMPLETE');
    console.log('='.repeat(60));
    console.log('');
    console.log('Add this to your .env file:');
    console.log('');
    console.log(`  REACT_APP_RLUSD_ISSUER=${issuerWallet.classicAddress}`);
    console.log('');
    console.log('Save the issuer seed somewhere safe (needed if devnet resets):');
    console.log('');
    console.log(`  RLUSD_ISSUER_SEED=${issuerWallet.seed}`);
    console.log('');
    console.log('Token details:');
    console.log(`  Currency:  ${CURRENCY_CODE}`);
    console.log(`  Issuer:    ${issuerWallet.classicAddress}`);
    console.log(`  Per wallet: ${RLUSD_AMOUNT_PER_WALLET} ${CURRENCY_CODE}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Paste REACT_APP_RLUSD_ISSUER into your .env');
    console.log('  2. Restart your dev server');
    console.log('  3. Proceed to Task 2.2 (Token Escrow amendment detection)');
    console.log('');

  } catch (err) {
    console.error('');
    console.error('❌ Error:', err.message || err);
    if (err.data) console.error('   Details:', JSON.stringify(err.data, null, 2));
    process.exit(1);
  } finally {
    await client.disconnect();
    console.log('Disconnected from devnet.');
  }
}

main();
