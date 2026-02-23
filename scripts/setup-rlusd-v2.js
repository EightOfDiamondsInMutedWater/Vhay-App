#!/usr/bin/env node

/**
 * SC.PO — Task 2.1 + 2.2 Combined: Fresh RLUSD Setup with Escrow Support
 * 
 * Run once: node scripts/setup-rlusd-v2.js
 * 
 * This creates a FRESH issuer with the escrow flag enabled BEFORE
 * trust lines are created (the correct order). Replaces the old
 * setup-rlusd.js and enable-issuer-escrow.js scripts.
 * 
 * Steps:
 * 1. Create fresh RLUSD issuer wallet via devnet faucet
 * 2. Enable DefaultRipple (required for token transfers)
 * 3. Enable AllowTrustLineLocking (required for token escrows) — flag 17
 * 4. Set up trust lines from buyer + vendor to the new issuer
 * 5. Send test RLUSD ($10,000 each)
 * 6. Print new env variables
 */

const xrpl = require('xrpl');

// ============================================================
// CONFIGURATION — Your existing wallet seeds
// ============================================================
const BUYER_SEED = 'sEdSjPzCe4LGkGuJ7xVEt1EsAvHUCmd';
const VENDOR_SEED = 'sEdTNzxUVqnj7mEVeigwA3iz21pHEgw';

const RLUSD_AMOUNT_PER_WALLET = '10000';
const TRUST_LINE_LIMIT = '1000000';
const CURRENCY_CODE = 'USD';
const DEVNET_URL = 'wss://s.devnet.rippletest.net:51233';

// asfAllowTrustLineLocking = 17 (NOT 16)
const ASF_ALLOW_TRUST_LINE_LOCKING = 17;
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('SC.PO — Fresh RLUSD Setup with Escrow Support');
  console.log('='.repeat(60));
  console.log('');

  if (BUYER_SEED === 'PASTE_YOUR_BUYER_SEED_HERE' || VENDOR_SEED === 'PASTE_YOUR_VENDOR_SEED_HERE') {
    console.error('❌ ERROR: Update BUYER_SEED and VENDOR_SEED in this script first.');
    process.exit(1);
  }

  const client = new xrpl.Client(DEVNET_URL);

  try {
    console.log('Connecting to devnet...');
    await client.connect();
    console.log('✅ Connected');
    console.log('');

    const buyerWallet = xrpl.Wallet.fromSeed(BUYER_SEED);
    const vendorWallet = xrpl.Wallet.fromSeed(VENDOR_SEED);
    console.log('Buyer wallet:  ', buyerWallet.classicAddress);
    console.log('Vendor wallet: ', vendorWallet.classicAddress);
    console.log('');

    // ── Step 1: Create fresh RLUSD issuer ──────────────────────
    console.log('Step 1: Creating fresh RLUSD issuer wallet...');
    const fundResult = await client.fundWallet();
    const issuerWallet = fundResult.wallet;
    console.log('✅ Issuer created:', issuerWallet.classicAddress);
    console.log('   Seed:', issuerWallet.seed);
    console.log('');

    // ── Step 2: Enable DefaultRipple ───────────────────────────
    console.log('Step 2: Enabling DefaultRipple...');
    const defaultRippleTx = {
      TransactionType: 'AccountSet',
      Account: issuerWallet.classicAddress,
      SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple
    };
    const drResult = await client.submitAndWait(defaultRippleTx, {
      autofill: true,
      wallet: issuerWallet
    });
    if (typeof drResult.result.meta === 'object' && drResult.result.meta.TransactionResult === 'tesSUCCESS') {
      console.log('✅ DefaultRipple enabled');
    } else {
      throw new Error('DefaultRipple failed: ' + drResult.result.meta?.TransactionResult);
    }
    console.log('');

    // ── Step 3: Enable AllowTrustLineLocking (for escrow) ──────
    // MUST be done BEFORE any trust lines are created
    console.log('Step 3: Enabling AllowTrustLineLocking (escrow support)...');
    const escrowFlagTx = {
      TransactionType: 'AccountSet',
      Account: issuerWallet.classicAddress,
      SetFlag: ASF_ALLOW_TRUST_LINE_LOCKING
    };
    const efResult = await client.submitAndWait(escrowFlagTx, {
      autofill: true,
      wallet: issuerWallet
    });
    if (typeof efResult.result.meta === 'object' && efResult.result.meta.TransactionResult === 'tesSUCCESS') {
      console.log('✅ AllowTrustLineLocking enabled (token escrows supported)');
    } else {
      throw new Error('AllowTrustLineLocking failed: ' + efResult.result.meta?.TransactionResult);
    }
    console.log('');

    // ── Step 4: Set up trust lines ─────────────────────────────
    console.log('Step 4: Setting up trust lines...');
    for (const [label, wallet] of [['Buyer', buyerWallet], ['Vendor', vendorWallet]]) {
      console.log(`   ${label} (${wallet.classicAddress})...`);
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
      if (typeof trustResult.result.meta === 'object' && trustResult.result.meta.TransactionResult === 'tesSUCCESS') {
        console.log(`   ✅ ${label} trust line set`);
      } else {
        throw new Error(`TrustSet failed for ${label}: ` + trustResult.result.meta?.TransactionResult);
      }
    }
    console.log('');

    // ── Step 5: Send test RLUSD ────────────────────────────────
    console.log('Step 5: Distributing test RLUSD...');
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
      if (typeof payResult.result.meta === 'object' && payResult.result.meta.TransactionResult === 'tesSUCCESS') {
        console.log(`   ✅ ${label} received ${RLUSD_AMOUNT_PER_WALLET} ${CURRENCY_CODE}`);
      } else {
        throw new Error(`Payment failed for ${label}: ` + payResult.result.meta?.TransactionResult);
      }
    }
    console.log('');

    // ── Step 6: Verify ─────────────────────────────────────────
    console.log('Step 6: Verifying balances...');
    for (const [label, wallet] of [['Buyer', buyerWallet], ['Vendor', vendorWallet]]) {
      const balances = await client.request({
        command: 'account_lines',
        account: wallet.classicAddress,
        ledger_index: 'validated'
      });
      const rlusdLine = balances.result.lines.find(
        line => line.currency === CURRENCY_CODE && line.account === issuerWallet.classicAddress
      );
      console.log(`   ${label}: ${rlusdLine ? rlusdLine.balance : '0'} ${CURRENCY_CODE} ${rlusdLine ? '✅' : '❌'}`);
    }

    // Verify issuer flags
    const issuerInfo = await client.request({
      command: 'account_info',
      account: issuerWallet.classicAddress,
      ledger_index: 'validated'
    });
    const flags = issuerInfo.result.account_data.Flags || 0;
    const hasDefaultRipple = !!(flags & 0x00800000);
    const hasEscrowLocking = !!(flags & 0x00002000);
    console.log(`   Issuer DefaultRipple: ${hasDefaultRipple ? '✅' : '❌'}`);
    console.log(`   Issuer AllowTrustLineLocking: ${hasEscrowLocking ? '✅' : '❌'}`);
    console.log('');

    // ── Done! ──────────────────────────────────────────────────
    console.log('='.repeat(60));
    console.log('✅ SETUP COMPLETE — RLUSD with Escrow Support');
    console.log('='.repeat(60));
    console.log('');
    console.log('UPDATE your .env file — replace the old REACT_APP_RLUSD_ISSUER:');
    console.log('');
    console.log(`  REACT_APP_RLUSD_ISSUER=${issuerWallet.classicAddress}`);
    console.log('');
    console.log('Save the issuer seed (needed if devnet resets):');
    console.log('');
    console.log(`  RLUSD_ISSUER_SEED=${issuerWallet.seed}`);
    console.log('');
    console.log('Then restart your dev server: npm start');
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
