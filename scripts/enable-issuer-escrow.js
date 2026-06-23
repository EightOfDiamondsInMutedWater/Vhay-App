#!/usr/bin/env node

/**
 * SC.PO — Task 2.2: Enable Token Escrow Flag on RLUSD Issuer
 * 
 * Run once: node scripts/enable-issuer-escrow.js
 * 
 * What this does:
 * The Token Escrow amendment (XLS-85) requires the issuer to enable
 * the "Allow Trust Line Locking" flag before their tokens can be escrowed.
 * Without this flag, EscrowCreate with RLUSD will fail.
 * 
 * This is a ONE-TIME setup step. Run it after setup-rlusd.js.
 * 
 * Prerequisites:
 * - setup-rlusd.js has been run (issuer wallet exists)
 * - You saved the RLUSD_ISSUER_SEED from the setup output
 */

const xrpl = require('xrpl');

// ============================================================
// CONFIGURATION — Paste your RLUSD issuer seed here
// ============================================================
const RLUSD_ISSUER_SEED = process.env.RLUSD_ISSUER_SEED;
if (!RLUSD_ISSUER_SEED) { console.error('Set RLUSD_ISSUER_SEED env var'); process.exit(1); }

const DEVNET_URL = 'wss://s.devnet.rippletest.net:51233';

// asfAllowTrustLineLocking flag value
const ASF_ALLOW_TRUST_LINE_LOCKING = 16;
// ============================================================

async function main() {
  console.log('='.repeat(60));
  console.log('SC.PO — Task 2.2: Enable Escrow Flag on RLUSD Issuer');
  console.log('='.repeat(60));
  console.log('');

  if (RLUSD_ISSUER_SEED === 'PASTE_YOUR_RLUSD_ISSUER_SEED_HERE') {
    console.error('❌ ERROR: Paste your RLUSD issuer seed into this script first.');
    console.error('   This is the RLUSD_ISSUER_SEED that setup-rlusd.js printed.');
    process.exit(1);
  }

  const client = new xrpl.Client(DEVNET_URL);

  try {
    console.log('Connecting to devnet...');
    await client.connect();
    console.log('✅ Connected');
    console.log('');

    const issuerWallet = xrpl.Wallet.fromSeed(RLUSD_ISSUER_SEED);
    console.log('Issuer address:', issuerWallet.classicAddress);
    console.log('');

    // Check if flag is already set
    const accountInfo = await client.request({
      command: 'account_info',
      account: issuerWallet.classicAddress,
      ledger_index: 'validated'
    });

    const flags = accountInfo.result.account_data.Flags || 0;
    // lsfAllowTrustLineLocking = 0x00001000 = 4096
    if (flags & 0x00001000) {
      console.log('✅ AllowTrustLineLocking flag is ALREADY enabled. Nothing to do.');
      return;
    }

    console.log('Setting AllowTrustLineLocking flag on issuer...');
    const accountSetTx = {
      TransactionType: 'AccountSet',
      Account: issuerWallet.classicAddress,
      SetFlag: ASF_ALLOW_TRUST_LINE_LOCKING
    };

    const result = await client.submitAndWait(accountSetTx, {
      autofill: true,
      wallet: issuerWallet
    });

    const meta = result.result.meta;
    if (typeof meta === 'object' && meta.TransactionResult === 'tesSUCCESS') {
      console.log('✅ AllowTrustLineLocking flag enabled!');
      console.log('   Tx Hash:', result.result.hash);
      console.log('');
      console.log('Your RLUSD token can now be used in escrows.');
      console.log('Proceed to Task 2.3 (trust line setup UI).');
    } else {
      throw new Error('AccountSet failed: ' + (typeof meta === 'object' ? meta.TransactionResult : meta));
    }

  } catch (err) {
    console.error('');
    console.error('❌ Error:', err.message || err);
    process.exit(1);
  } finally {
    await client.disconnect();
    console.log('');
    console.log('Disconnected from devnet.');
  }
}

main();
