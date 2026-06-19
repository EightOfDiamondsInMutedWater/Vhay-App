// One-off mainnet wallet generator for Vhay. Run locally, never log/commit the seeds.
// Produces ed25519 (sEd...) seeds to match the app's fromSeed (no explicit algorithm).
const xrpl = require('xrpl');

const ROLES = [
  ['COMPANY / PLATFORM', 'corporate + fees, issues credentials, owns Permissioned Domain',
   'REACT_APP_COMPANY_WALLET = address  |  REACT_APP_COMPANY_SEED = seed (hosting secret manager)'],
  ['DEMO TOKEN ISSUER', 'mints your custom USD stablecoin',
   'REACT_APP_RLUSD_ISSUER = address  |  seed -> password manager (used only in Task 3.1)'],
  ['TEST BUYER', 'creates POs, funds escrows',
   'seed -> password manager, pasted into the app UI for testing'],
  ['TEST VENDOR', 'mints inventory, claims escrows',
   'seed -> password manager, pasted into the app UI for testing'],
  ['WAREHOUSE', 'vendor-controlled, holds inventory MPTs',
   'seed -> password manager, entered in the app warehouse setup'],
];

console.log('\n=== Vhay mainnet wallets (ed25519 / sEd) ===\n');
for (let i = 0; i < ROLES.length; i++) {
  const [name, purpose, dest] = ROLES[i];
  const w = xrpl.Wallet.generate('ed25519');
  if (!w.seed.startsWith('sEd')) throw new Error('Not an ed25519 seed — aborting');
  console.log(`[${i + 1}] ${name}  (${purpose})`);
  console.log(`    Address: ${w.classicAddress}`);
  console.log(`    Seed:    ${w.seed}`);
  console.log(`    -> ${dest}\n`);
}
console.log('Save every seed to a password manager NOW, then clear your terminal. Do not commit the output.\n');
