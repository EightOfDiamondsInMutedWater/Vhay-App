// Pre-issues + accepts SCPO_BASIC credentials for the demo buyer & vendor (Option A).
// Mirrors checkAndRenewCredential's issue->accept flow so the deployed app finds them
// already 'valid' and never needs the company seed at runtime.
//   COMPANY_SEED=.. BUYER_SEED=.. VENDOR_SEED=.. node scripts/issue-credentials.cjs           (mainnet)
//   ...same... XRPL_ENDPOINT=wss://s.devnet.rippletest.net:51233 node scripts/issue-credentials.cjs  (devnet)
const xrpl = require('xrpl');

const { COMPANY_SEED, BUYER_SEED, VENDOR_SEED } = process.env;
if (!COMPANY_SEED || !BUYER_SEED || !VENDOR_SEED) {
  console.error('Set COMPANY_SEED, BUYER_SEED, and VENDOR_SEED env vars'); process.exit(1);
}
const ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const SOURCE_TAG = 2606160012;
const SCPO_BASIC_HEX = '5343504F5F4241534943';   // must match xrplHelpers.ts
const EXPIRATION_DAYS = 365;

async function send(client, wallet, tx, label) {
  tx.SourceTag = SOURCE_TAG;
  const r = await client.submitAndWait(await client.autofill(tx), { wallet });
  const code = r.result.meta.TransactionResult;
  console.log(`  ${label}: ${code}  (${r.result.hash})`);
  if (code !== 'tesSUCCESS') throw new Error(`${label} failed: ${code}`);
}

async function credentialExists(client, subject, issuer) {
  try {
    const resp = await client.request({ command: 'account_objects', account: subject, type: 'credential', ledger_index: 'validated' });
    return (resp.result.account_objects || []).some(
      c => c.Issuer === issuer && c.CredentialType === SCPO_BASIC_HEX
    );
  } catch { return false; }
}

(async () => {
  const client = new xrpl.Client(ENDPOINT);
  await client.connect();
  const company = xrpl.Wallet.fromSeed(COMPANY_SEED);
  const buyer   = xrpl.Wallet.fromSeed(BUYER_SEED);
  const vendor  = xrpl.Wallet.fromSeed(VENDOR_SEED);
  console.log('Network :', ENDPOINT);
  console.log('Issuer (company):', company.classicAddress);

  const rippleEpoch = 946684800;
  const expiration = Math.floor(Date.now() / 1000) - rippleEpoch + (EXPIRATION_DAYS * 24 * 60 * 60);

  for (const [name, w] of [['buyer', buyer], ['vendor', vendor]]) {
    console.log(`\n${name} (${w.classicAddress})`);
    if (await credentialExists(client, w.classicAddress, company.classicAddress)) {
      console.log('  already credentialed — skipping'); continue;
    }
    await send(client, company, {
      TransactionType: 'CredentialCreate',
      Account: company.classicAddress,
      Subject: w.classicAddress,
      CredentialType: SCPO_BASIC_HEX,
      Expiration: expiration,
    }, 'issue (CredentialCreate)');
    await send(client, w, {
      TransactionType: 'CredentialAccept',
      Account: w.classicAddress,
      Issuer: company.classicAddress,
      CredentialType: SCPO_BASIC_HEX,
    }, 'accept (CredentialAccept)');
  }

  console.log('\n=== Verify accepted credentials ===');
  for (const [name, w] of [['buyer', buyer], ['vendor', vendor]]) {
    const ok = await credentialExists(client, w.classicAddress, company.classicAddress);
    console.log(`  ${name}: ${ok ? 'SCPO_BASIC present' : 'MISSING'}`);
  }
  await client.disconnect();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
