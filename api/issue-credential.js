// POST /api/issue-credential
// Body: { proof: "<signed tx blob hex>" }
// Issues a BASIC (SCPO_BASIC) credential to whoever signed the proof.
// The subject address is DERIVED from the signature. It is never read from the request.
const xrpl = require('xrpl');
const codec = require('ripple-binary-codec');
const { verifySignature } = require('verify-xrpl-signature');
const proofLib = require('../src/shared/credentialProof');

const ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const SOURCE_TAG = 2606160012;
const EXPIRATION_DAYS = 365;
const RENEWAL_WINDOW_MS = 30 * 86400 * 1000; // item 16a — renew within 30 days of expiry
const RIPPLE_EPOCH = 946684800;
const ALLOWED_TX_TYPES = new Set(['AccountSet', 'SignIn']);

const fail = (res, status, code, extra) =>
  res.status(status).json({ ok: false, code, ...(extra || {}) });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED');

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const blob = body && body.proof;
  if (typeof blob !== 'string' || blob.length < 32) return fail(res, 400, 'PROOF_MISSING');

  // 1. Verify the proof and derive the subject.
  let sig, decoded;
  try {
    sig = verifySignature(blob);
    decoded = codec.decode(blob);
  } catch (e) {
    return fail(res, 400, 'PROOF_UNDECODABLE');
  }
  if (sig.signatureValid !== true) return fail(res, 400, 'PROOF_SIGNATURE_INVALID');
  if (!ALLOWED_TX_TYPES.has(decoded.TransactionType)) return fail(res, 400, 'PROOF_WRONG_TX_TYPE');
  if (proofLib.readProofMemo(decoded) === null)
    return fail(res, 400, 'PROOF_MEMO_MISSING', { expected: proofLib.PROOF_MEMO });

  const subject = sig.signedBy;
  if (!subject || typeof subject !== 'string') return fail(res, 400, 'PROOF_NO_SIGNER');

  // 2. Load the issuer. Never REACT_APP_ prefixed.
  const seed = process.env.COMPANY_SEED;
  if (!seed) return fail(res, 500, 'ISSUER_NOT_CONFIGURED');
  let company;
  try { company = xrpl.Wallet.fromSeed(seed); }
  catch (e) { return fail(res, 500, 'ISSUER_SEED_INVALID'); }
  if (subject === company.classicAddress) return fail(res, 400, 'SUBJECT_IS_ISSUER');

  let client;
  try {
    client = new xrpl.Client(ENDPOINT, { connectionTimeout: 15000 });
    await client.connect();

    // 3. Subject must exist on the ledger. Distinguish this from "no credential".
    let objects;
    try {
      const r = await client.request({
        command: 'account_objects', account: subject,
        type: 'credential', ledger_index: 'validated',
      });
      objects = r.result.account_objects || [];
    } catch (e) {
      if (String(e.message).includes('actNotFound') || (e.data && e.data.error === 'actNotFound')) {
        return fail(res, 400, 'SUBJECT_NOT_FUNDED', { subject });
      }
      throw e;
    }

    // 4. Idempotent: already credentialed is success, accepted or not —
    //    UNLESS the credential is at or near expiry, in which case revoke and reissue (item 16a).
    const existing = objects.find(
      (c) => c.Issuer === company.classicAddress && c.CredentialType === proofLib.SCPO_BASIC_HEX
    );
    let renewing = false;
    if (existing) {
      const expSec = typeof existing.Expiration === 'number' ? existing.Expiration : null;
      const expiresAtMs = expSec === null ? null : (expSec + RIPPLE_EPOCH) * 1000;
      const dueForRenewal = expiresAtMs !== null && Date.now() > expiresAtMs - RENEWAL_WINDOW_MS;
      if (!dueForRenewal) {
        return res.status(200).json({
          ok: true, subject, alreadyCredentialed: true,
          accepted: Boolean(existing.Flags & 0x00010000),
        });
      }
      console.log('[issue-credential] RENEWING ' + subject +
        ' expires=' + new Date(expiresAtMs).toISOString());
      const del = await client.submitAndWait(await client.autofill({
        TransactionType: 'CredentialDelete',
        Account: company.classicAddress,
        Subject: subject,
        CredentialType: proofLib.SCPO_BASIC_HEX,
        SourceTag: SOURCE_TAG,
      }), { wallet: company });
      const delCode = del.result.meta && del.result.meta.TransactionResult;
      if (delCode !== 'tesSUCCESS') {
        return fail(res, 502, 'RENEW_REVOKE_FAILED', { txResult: delCode });
      }
      renewing = true;
    }

    // 5. Issue.
    const tx = {
      TransactionType: 'CredentialCreate',
      Account: company.classicAddress,
      Subject: subject,
      CredentialType: proofLib.SCPO_BASIC_HEX,
      Expiration: Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + EXPIRATION_DAYS * 86400,
      SourceTag: SOURCE_TAG,
    };
    const result = await client.submitAndWait(await client.autofill(tx), { wallet: company });
    const code = result.result.meta && result.result.meta.TransactionResult;
    if (code !== 'tesSUCCESS') {
      return fail(res, 502, renewing ? 'RENEW_REVOKED_NOT_REISSUED' : 'ISSUE_FAILED', { txResult: code });
    }
    return res.status(200).json({
      ok: true, subject, alreadyCredentialed: false, accepted: false,
      txHash: result.result.hash,
    });
  } catch (e) {
    return fail(res, 500, 'UNEXPECTED', { error: String(e && e.message) });
  } finally {
    try { if (client && client.isConnected()) await client.disconnect(); } catch (e) {}
  }
};

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
