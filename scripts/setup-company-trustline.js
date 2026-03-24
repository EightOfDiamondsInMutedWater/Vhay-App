const xrpl = require('xrpl');

const COMPANY_SEED = 'sEdV5ad8yQaTEAsxUNiczZ8QJMDaP3g';
const RLUSD_ISSUER = 'rMERWtUb1ReN5t3iQ4S9H1yQBMvWzGKVDT';
const DEVNET_URL = 'wss://s.devnet.rippletest.net:51233';

async function main() {
  const client = new xrpl.Client(DEVNET_URL);
  await client.connect();
  console.log('Connected');

  const wallet = xrpl.Wallet.fromSeed(COMPANY_SEED);
  console.log('Company wallet:', wallet.classicAddress);

  const trustSetTx = {
    TransactionType: 'TrustSet',
    Account: wallet.classicAddress,
    LimitAmount: {
      currency: 'USD',
      issuer: RLUSD_ISSUER,
      value: '1000000'
    }
  };

  const result = await client.submitAndWait(trustSetTx, { autofill: true, wallet });
  const meta = result.result.meta;
  if (typeof meta === 'object' && meta.TransactionResult === 'tesSUCCESS') {
    console.log('✅ Company wallet trust line set!');
  } else {
    console.log('❌ Failed:', meta?.TransactionResult);
  }

  await client.disconnect();
}

main();
