// One-time: company/platform wallet trusts the demo-USD issuer so it can RECEIVE fee payments.
// Fixes tecPATH_DRY on PO/inventory fee legs. Run locally; seed never leaves this machine.
const xrpl = require('xrpl');

const COMPANY_SEED = process.env.COMPANY_SEED;          // ed25519 sEd... for raqWMf...
const ISSUER       = 'rBdRWMcSyWMPpk5HfYq9HBzw92wxKFpx2v';
const CURRENCY     = 'USD';
const LIMIT        = '1000000';
const SOURCE_TAG   = 2606160012;
const ENDPOINT     = 'wss://xrplcluster.com';

(async () => {
  if (!COMPANY_SEED) { console.error('Set COMPANY_SEED env var first.'); process.exit(1); }
  const wallet = xrpl.Wallet.fromSeed(COMPANY_SEED);
  console.log('Company wallet:', wallet.classicAddress);
  if (wallet.classicAddress !== 'raqWMfK3FcPVXd5Q468WgthvpvorEmCJV3') {
    console.error('ABORT: derived address is not the expected company wallet. Wrong seed?'); process.exit(1);
  }
  const client = new xrpl.Client(ENDPOINT);
  await client.connect();
  const tx = {
    TransactionType: 'TrustSet',
    Account: wallet.classicAddress,
    LimitAmount: { currency: CURRENCY, issuer: ISSUER, value: LIMIT },
    SourceTag: SOURCE_TAG,
  };
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  console.log('Submitting TrustSet...');
  const res = await client.submitAndWait(signed.tx_blob);
  console.log('Result:', res.result.meta.TransactionResult, '| hash:', res.result.hash);
  await client.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
