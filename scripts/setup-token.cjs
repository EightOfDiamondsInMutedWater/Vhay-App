// Mints the Vhay demo USD stablecoin (trust-line IOU). Run locally; pass seeds via env.
//   ISSUER_SEED=.. BUYER_SEED=.. VENDOR_SEED=.. node scripts/setup-token.cjs           (mainnet)
//   ...same... XRPL_ENDPOINT=wss://s.devnet.rippletest.net:51233 node scripts/setup-token.cjs  (devnet)
const xrpl = require('xrpl');

const { ISSUER_SEED, BUYER_SEED, VENDOR_SEED } = process.env;
if (!ISSUER_SEED || !BUYER_SEED || !VENDOR_SEED) {
  console.error('Set ISSUER_SEED, BUYER_SEED, and VENDOR_SEED env vars'); process.exit(1);
}
const ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const SOURCE_TAG = 2606160012;
const CURRENCY = 'USD';          // must match getRLUSDCurrency() in xrplHelpers.ts
const TRUST_LIMIT = '1000000';
const FUND_AMOUNT = '10000';

async function send(client, wallet, tx, label) {
  tx.SourceTag = SOURCE_TAG;
  const r = await client.submitAndWait(await client.autofill(tx), { wallet });
  const code = r.result.meta.TransactionResult;
  console.log(`  ${label}: ${code}  (${r.result.hash})`);
  if (code !== 'tesSUCCESS') throw new Error(`${label} failed: ${code}`);
}

(async () => {
  const client = new xrpl.Client(ENDPOINT);
  await client.connect();
  const issuer = xrpl.Wallet.fromSeed(ISSUER_SEED);
  const buyer  = xrpl.Wallet.fromSeed(BUYER_SEED);
  const vendor = xrpl.Wallet.fromSeed(VENDOR_SEED);
  console.log('Network :', ENDPOINT);
  console.log('Issuer  :', issuer.classicAddress);
  console.log('Buyer   :', buyer.classicAddress);
  console.log('Vendor  :', vendor.classicAddress);
  console.log('Currency:', CURRENCY, '\n');

  console.log('1) Issuer flags');
  await send(client, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple }, 'asfDefaultRipple');
  await send(client, issuer, { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: xrpl.AccountSetAsfFlags.asfAllowTrustLineLocking }, 'asfAllowTrustLineLocking');

  console.log('2) Trust lines');
  const trust = (w) => ({ TransactionType: 'TrustSet', Account: w.classicAddress, LimitAmount: { currency: CURRENCY, issuer: issuer.classicAddress, value: TRUST_LIMIT } });
  await send(client, buyer,  trust(buyer),  'buyer TrustSet');
  await send(client, vendor, trust(vendor), 'vendor TrustSet');

  console.log('3) Fund test wallets (10,000 each)');
  const pay = (dest) => ({ TransactionType: 'Payment', Account: issuer.classicAddress, Destination: dest, Amount: { currency: CURRENCY, issuer: issuer.classicAddress, value: FUND_AMOUNT } });
  await send(client, issuer, pay(buyer.classicAddress),  'fund buyer');
  await send(client, issuer, pay(vendor.classicAddress), 'fund vendor');

  console.log('\n4) Verify balances');
  for (const [name, addr] of [['buyer', buyer.classicAddress], ['vendor', vendor.classicAddress]]) {
    const lines = await client.request({ command: 'account_lines', account: addr, peer: issuer.classicAddress });
    const usd = lines.result.lines.find(l => l.currency === CURRENCY);
    console.log(`  ${name}: ${usd ? usd.balance + ' ' + CURRENCY : 'NO TRUST LINE'}`);
  }

  console.log('\n=== Issuer address -> set as mainnet REACT_APP_RLUSD_ISSUER ===');
  console.log(issuer.classicAddress);
  console.log('Verify: https://xrpscan.com/account/' + issuer.classicAddress);
  await client.disconnect();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
