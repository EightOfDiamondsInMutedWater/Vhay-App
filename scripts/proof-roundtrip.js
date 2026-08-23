// Round-trip self-test for the credential-proof contract.
// Run before any commit touching src/shared/credentialProof.js, the client
// call sites, or api/. Offline, disposable keys, nothing submitted.
const xrpl = require('xrpl');
const codec = require('ripple-binary-codec');
const { verifySignature } = require('verify-xrpl-signature');
const proof = require('../src/shared/credentialProof');

let failures = 0;
const check = (name, pass, detail) => {
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''));
  if (!pass) failures++;
};

const w = xrpl.Wallet.generate();
const signed = w.sign(proof.buildProofTx(w.classicAddress));
let r, d;
try { r = verifySignature(signed.tx_blob); d = codec.decode(signed.tx_blob); }
catch (e) { console.log('FATAL: happy path threw -> ' + e.message); process.exit(1); }

check('signature valid', r.signatureValid === true);
check('signedBy is the signer', r.signedBy === w.classicAddress, r.signedBy);
check('memo readable', proof.readProofMemo(d) === proof.PROOF_MEMO);
check('tx type is AccountSet', d.TransactionType === 'AccountSet', d.TransactionType);

// no memo at all
const bare = w.sign({ TransactionType:'AccountSet', Account:w.classicAddress, Sequence:0, Fee:'0', LastLedgerSequence:1 });
check('bare AccountSet rejected', proof.readProofMemo(codec.decode(bare.tx_blob)) === null);

// wrong memo text
const wrong = w.sign({ ...proof.buildProofTx(w.classicAddress),
  Memos:[{ Memo:{ MemoData: Buffer.from('something-else','utf8').toString('hex').toUpperCase() } }] });
check('wrong memo rejected', proof.readProofMemo(codec.decode(wrong.tx_blob)) === null);

// impersonation
const atk = xrpl.Wallet.generate(), vic = xrpl.Wallet.generate();
const imp = atk.sign(proof.buildProofTx(vic.classicAddress));
check('impersonation names attacker', verifySignature(imp.tx_blob).signedBy === atk.classicAddress);

// lowercase hex memo still readable
const lower = w.sign({ ...proof.buildProofTx(w.classicAddress),
  Memos:[{ Memo:{ MemoData: Buffer.from(proof.PROOF_MEMO,'utf8').toString('hex') } }] });
check('lowercase hex memo readable', proof.readProofMemo(codec.decode(lower.tx_blob)) === proof.PROOF_MEMO);


// --- drift guard: the tier hex must match every other copy in the repo ---
const fs = require('fs');
const grab = (f, re) => { const m = fs.readFileSync(f, 'utf8').match(re); return m && m[1]; };
const inHelpers = grab('src/utils/xrplHelpers.ts', /SCPO_BASIC_HEX\s*=\s*'([0-9A-Fa-f]+)'/);
const inScript  = grab('scripts/issue-credentials.cjs', /SCPO_BASIC_HEX\s*=\s*'([0-9A-Fa-f]+)'/);
check('hex matches xrplHelpers.ts', inHelpers === proof.SCPO_BASIC_HEX, inHelpers);
check('hex matches issue-credentials.cjs', inScript === proof.SCPO_BASIC_HEX, inScript);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
