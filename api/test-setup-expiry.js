// POST /api/test-setup-expiry
// ⚠ DELETE before public. Test scaffolding for item 16a only. Must never reach main.
// Revokes the allowlisted subject's SCPO_BASIC and reissues it with a SHORT expiry so that
// /api/issue-credential's renewal branch (30-day window) can be exercised against mainnet.
// Body: { proof: "<signed tx blob hex>", days: <1..29> }
const xrpl = require('xrpl');
const codec = require('ripple-binary-codec');
const { verifySignature } = require('verify-xrpl-signature');
const proofLib = require('../src/shared/credentialProof');

const ENDPOINT = process.env.XRPL_ENDPOINT || 'wss://xrplcluster.com';
const SOURCE_TAG = 2606160012;
const RIPPLE_EPOCH = 946684800;
const ALLOWED_TX_TYPES = new Set(['AccountSet', 'SignIn']);
// GUARD 1: only this disposable test wallet can ever be affected.
const ALLOWED_SUBJECTS = new Set(['rKdCEyJ5DHXBBtnZg75ECNPfBnxdmMYz12']);

const fail = (res, status, code, extra) =>
  res.status(status).json({ ok: false, code, ...(extra || {}) });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED');

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const blob = body && body.proof;
  if (typeof blob !== 'string' || blob.length < 32) return fail(res, 400, 'PROOF_MISSING');

  // GUARD 2: same proof contract as the real endpoint. Subject is derived, never sent.
  let sig, decoded;
  try { sig = verifySignature(blob); decoded = codec.decode(blob); }
  catch (e) { return fail(res, 400, 'PROOF_UNDECODABLE'); }
  if (sig.signatureValid !== true) return fail(res, 400, 'PROOF_SIGNATURE_INVALID');
  if (!ALLOWED_TX_TYPES.has(decoded.TransactionType)) return fail(res, 400, 'PROOF_WRONG_TX_TYPE');
  if (proofLib.readProofMemo(decoded) === null) return fail(res, 400, 'PROOF_MEMO_MISSING');

  const subject = sig.signedBy;
  if (!subject) return fail(res, 400, 'PROOF_NO_SIGNER');
  if (!ALLOWED_SUBJECTS.has(subject)) return fail(res, 403, 'SUBJECT_NOT_ALLOWLISTED', { subject });

  // GUARD 3: clamp expiry so this can never mint a long-lived credential.
  const days = Number(body && body.days);
  if (!Number.isInteger(days) || days < 1 || days > 29) return fail(res, 400, 'DAYS_OUT_OF_RANGE');

  const seed = process.env.COMPANY_SEED;
  if (!seed) return fail(res, 500, 'ISSUER_NOT_CONFIGURED');
  let company;
  try { company = xrpl.Wallet.fromSeed(seed); }
  catch (e) { return fail(res, 500, 'ISSUER_SEED_INVALID'); }

  let client;
  try {
    client = new xrpl.Client(ENDPOINT, { connectionTimeout: 15000 });
    await client.connect();

    const r = await client.request({
      command: 'account_objects', account: subject,
      type: 'credential', ledger_index: 'validated',
    });
    const existing = (r.result.account_objects || []).find(
      (c) => c.Issuer === company.classicAddress && c.CredentialType === proofLib.SCPO_BASIC_HEX
    );

    let deleteHash = null;
    if (existing) {
      const del = await client.submitAndWait(await client.autofill({
        TransactionType: 'CredentialDelete',
        Account: company.classicAddress,
        Subject: subject,
        CredentialType: proofLib.SCPO_BASIC_HEX,
        SourceTag: SOURCE_TAG,
      }), { wallet: company });
      const dc = del.result.meta && del.result.meta.TransactionResult;
      if (dc !== 'tesSUCCESS') return fail(res, 502, 'DELETE_FAILED', { txResult: dc });
      deleteHash = del.result.hash;
    }

    const expiration = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + days * 86400;
    const iss = await client.submitAndWait(await client.autofill({
      TransactionType: 'CredentialCreate',
      Account: company.classicAddress,
      Subject: subject,
      CredentialType: proofLib.SCPO_BASIC_HEX,
      Expiration: expiration,
      SourceTag: SOURCE_TAG,
    }), { wallet: company });
    const ic = iss.result.meta && iss.result.meta.TransactionResult;
    if (ic !== 'tesSUCCESS') return fail(res, 502, 'REISSUE_FAILED_NO_CREDENTIAL', { txResult: ic });

    return res.status(200).json({
      ok: true, subject, days, deleteHash, issueHash: iss.result.hash,
      expiresAt: new Date((expiration + RIPPLE_EPOCH) * 1000).toISOString(),
    });
  } catch (e) {
    return fail(res, 500, 'UNEXPECTED', { error: String(e && e.message) });
  } finally {
    try { if (client && client.isConnected()) await client.disconnect(); } catch (e) {}
  }
};

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
