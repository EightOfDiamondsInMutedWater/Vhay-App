// Creates the Vhay Permissioned Domain. Run locally; pass COMPANY_SEED at call time.
//   COMPANY_SEED=sEd... node scripts/create-domain.cjs            (mainnet, default)
//   COMPANY_SEED=sEd... XRPL_ENDPOINT=wss://s.devnet.rippletest.net:51233 node scripts/create-domain.cjs   (devnet)
const xrpl = require('xrpl');

const COMPANY_SEED = process.env.COMPANY_SEED;
if (!COMPANY_SEED) { console.error('Set COMPANY_SEED env var'); process.exit(1); }
const ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const SOURCE_TAG = 2606160012;

const SCPO_BASIC_HEX         = '5343504F5F4241534943';
const SCPO_VERIFIED_HEX      = '5343504F5F564552494649';
const SCPO_INSTITUTIONAL_HEX = '5343504F5F494E5354';

(async () => {
  const client = new xrpl.Client(ENDPOINT);
  await client.connect();
  const wallet = xrpl.Wallet.fromSeed(COMPANY_SEED);
  console.log('Company wallet:', wallet.classicAddress, '| network:', ENDPOINT);

  const tx = {
    TransactionType: 'PermissionedDomainSet',
    Account: wallet.classicAddress,
    SourceTag: SOURCE_TAG,
    AcceptedCredentials: [
      { Credential: { Issuer: wallet.classicAddress, CredentialType: SCPO_BASIC_HEX } },
      { Credential: { Issuer: wallet.classicAddress, CredentialType: SCPO_VERIFIED_HEX } },
      { Credential: { Issuer: wallet.classicAddress, CredentialType: SCPO_INSTITUTIONAL_HEX } },
    ],
  };

  const result = await client.submitAndWait(await client.autofill(tx), { wallet });
  const meta = result.result.meta;
  console.log('Result:', meta.TransactionResult, '| tx:', result.result.hash);
  if (meta.TransactionResult !== 'tesSUCCESS') { await client.disconnect(); process.exit(1); }

  const created = meta.AffectedNodes.find(
    n => n.CreatedNode && n.CreatedNode.LedgerEntryType === 'PermissionedDomain'
  );
  console.log('\n=== DOMAIN ID  -> set as mainnet REACT_APP_DOMAIN_ID ===');
  console.log(created ? created.CreatedNode.LedgerIndex : '(not found - check xrpscan)');
  console.log('\nVerify: https://xrpscan.com/account/' + wallet.classicAddress + '  -> Objects');

  await client.disconnect();
})();
