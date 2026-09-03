// Shared by the browser client and the /api serverless function.
// Single source of truth for the credential-proof contract.
const PROOF_MEMO = 'vhay-credential-request';

// hex('SCPO_BASIC'). MUST stay byte-identical to SCPO_BASIC_HEX in src/utils/xrplHelpers.ts
// and scripts/issue-credentials.cjs. Asserted by scripts/proof-roundtrip.js.
const SCPO_BASIC_HEX = '5343504F5F4241534943';

function buildProofTx(address) {
  return {
    TransactionType: 'AccountSet',
    Account: address,
    Sequence: 0,
    Fee: '0',
    LastLedgerSequence: 1,
    Memos: [{ Memo: { MemoData: Buffer.from(PROOF_MEMO, 'utf8').toString('hex').toUpperCase() } }],
  };
}

function readProofMemo(decodedTx) {
  const memos = decodedTx && decodedTx.Memos;
  if (!Array.isArray(memos)) return null;
  for (const m of memos) {
    const data = m && m.Memo && m.Memo.MemoData;
    if (typeof data !== 'string') continue;
    try {
      const s = Buffer.from(data, 'hex').toString('utf8').trim();
      if (s === PROOF_MEMO) return s;
    } catch (e) { /* skip malformed memo */ }
  }
  return null;
}

// Issuers whose SCPO_BASIC credentials are accepted as proof of standing.
// COMPANY owns the permissioned domain and issues all three tiers; its seed is
// deployed nowhere. DEDICATED_ISSUER is accepted by the domain for SCPO_BASIC
// only and is the value of COMPANY_SEED in Vercel.
// ⚠ Addresses are public. Asserted by scripts/proof-roundtrip.js.
const COMPANY_ISSUER = 'raqWMfK3FcPVXd5Q468WgthvpvorEmCJV3';
const DEDICATED_ISSUER = 'rhUaQmNPjsX52773rzFeApXA6vpjgiLkPJ';
const ACCEPTED_ISSUERS = [COMPANY_ISSUER, DEDICATED_ISSUER];

module.exports = {
  PROOF_MEMO, SCPO_BASIC_HEX, buildProofTx, readProofMemo,
  COMPANY_ISSUER, DEDICATED_ISSUER, ACCEPTED_ISSUERS,
};
