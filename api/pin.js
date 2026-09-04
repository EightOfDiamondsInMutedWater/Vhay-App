// POST /api/pin
// Body: { proof: "<signed tx blob hex>", kind: "profile"|"document",
//         json?: <object>, base64?: "<b64>", filename?: "<name>" }
// Pins to Pinata (primary) and Filebase (secondary) using SERVER-HELD tokens.
// The pinner address is DERIVED from the signature. It is never read from the request.
const xrpl = require('xrpl');
const codec = require('ripple-binary-codec');
const { verifySignature } = require('verify-xrpl-signature');
const proofLib = require('../src/shared/credentialProof');

// A single public node behind Vercel's shared egress IPs stalls under contention:
// 500 TimeoutError on server_info during connect(), production 9/3/26 20:27:44.
// XRPL_ENDPOINT (a dedicated node) takes priority when set; otherwise rotate.
// ⚠ Never default to devnet here — a wrong-network fallback fails silently.
const ENDPOINTS = process.env.XRPL_ENDPOINT
  ? [process.env.XRPL_ENDPOINT]
  : ['wss://xrplcluster.com', 'wss://s1.ripple.com', 'wss://s2.ripple.com'];
const CONNECT_TIMEOUT_MS = 8000;
const CONNECT_BACKOFF_MS = 1000;

// Connect with per-node failover. Worst case ~27s, inside the function ceiling.
// Serverless containers freeze between invocations, so NO client is cached here.
const connectWithFailover = async () => {
  let lastError = null;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const url = ENDPOINTS[i];
    const c = new xrpl.Client(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
    try {
      if (i > 0) await new Promise((r) => setTimeout(r, CONNECT_BACKOFF_MS * i));
      await c.connect();
      return c;
    } catch (e) {
      lastError = e;
      console.warn('[pin] connect failed on ' + url + ': ' + (e && e.message));
      try { if (c.isConnected()) await c.disconnect(); } catch (e2) {}
    }
  }
  throw new Error('all XRPL endpoints failed: ' + (lastError && lastError.message));
};
const PINATA_FILE = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const FILEBASE_RPC = 'https://rpc.filebase.io/api/v0/add';
const ALLOWED_TX_TYPES = new Set(['AccountSet', 'SignIn']);
const ACCEPTED = new Set(proofLib.ACCEPTED_ISSUERS);
const RIPPLE_EPOCH = 946684800;
const ACCEPTED_FLAG = 0x00010000;
const MAX_BYTES = 3 * 1024 * 1024;

const fail = (res, status, code, extra) =>
  res.status(status).json({ ok: false, code, ...(extra || {}) });

module.exports = async (req, res) => {
  if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED');

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const blob = body && body.proof;
  if (typeof blob !== 'string' || blob.length < 32) return fail(res, 400, 'PROOF_MISSING');

  const kind = body && body.kind;
  if (kind !== 'profile' && kind !== 'document') return fail(res, 400, 'KIND_INVALID');

  // 1. Build the exact bytes. Both backends receive these same bytes.
  let bytes, filename;
  if (body.json !== undefined && body.json !== null) {
    try { bytes = Buffer.from(JSON.stringify(body.json), 'utf8'); }
    catch (e) { return fail(res, 400, 'PAYLOAD_UNSERIALIZABLE'); }
    filename = 'data.json';
  } else if (typeof body.base64 === 'string' && body.base64.length > 0) {
    try { bytes = Buffer.from(body.base64, 'base64'); }
    catch (e) { return fail(res, 400, 'PAYLOAD_UNDECODABLE'); }
    if (bytes.length === 0) return fail(res, 400, 'PAYLOAD_UNDECODABLE');
    filename = sanitize(body.filename) || 'upload.bin';
  } else {
    return fail(res, 400, 'PAYLOAD_MISSING');
  }
  if (bytes.length > MAX_BYTES)
    return fail(res, 413, 'PAYLOAD_TOO_LARGE', { bytes: bytes.length, max: MAX_BYTES });

  // 2. Verify the proof and derive the pinner.
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

  const pinner = sig.signedBy;
  if (!pinner || typeof pinner !== 'string') return fail(res, 400, 'PROOF_NO_SIGNER');

  // 3. Tokens. Never REACT_APP_ prefixed.
  const pinataJwt = process.env.PINATA_JWT;
  if (!pinataJwt) return fail(res, 500, 'PINNER_NOT_CONFIGURED');
  const filebaseToken = process.env.FILEBASE_RPC_TOKEN || null;

  let client;
  try {
    client = await connectWithFailover();

    if (kind === 'document') {
      // Document pins require an accepted, unexpired SCPO_BASIC from a trusted issuer.
      let objects;
      try {
        const r = await client.request({
          command: 'account_objects', account: pinner,
          type: 'credential', ledger_index: 'validated',
        });
        objects = r.result.account_objects || [];
      } catch (e) {
        if (String(e.message).includes('actNotFound') || (e.data && e.data.error === 'actNotFound'))
          return fail(res, 403, 'PINNER_NOT_FUNDED', { pinner });
        throw e;
      }
      const cred = objects.find(
        (c) => ACCEPTED.has(c.Issuer) && c.CredentialType === proofLib.SCPO_BASIC_HEX
      );
      if (!cred) return fail(res, 403, 'NOT_CREDENTIALED', { pinner });
      if (!(cred.Flags & ACCEPTED_FLAG)) return fail(res, 403, 'CREDENTIAL_NOT_ACCEPTED', { pinner });
      if (typeof cred.Expiration === 'number' &&
          Math.floor(Date.now() / 1000) - RIPPLE_EPOCH >= cred.Expiration)
        return fail(res, 403, 'CREDENTIAL_EXPIRED', { pinner });
    } else {
      // Profile pins run before the credential exists. Require only a funded wallet.
      try {
        await client.request({
          command: 'account_info', account: pinner, ledger_index: 'validated',
        });
      } catch (e) {
        if (String(e.message).includes('actNotFound') || (e.data && e.data.error === 'actNotFound'))
          return fail(res, 403, 'PINNER_NOT_FUNDED', { pinner });
        throw e;
      }
    }
  } catch (e) {
    return fail(res, 500, 'UNEXPECTED', { error: String(e && e.message) });
  } finally {
    try { if (client && client.isConnected()) await client.disconnect(); } catch (e) {}
  }

  // 4. Pin. Pinata is primary and fatal; Filebase is secondary and non-fatal.
  let primaryCid;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([bytes]), filename);
    const r = await fetch(PINATA_FILE, {
      method: 'POST', headers: { Authorization: 'Bearer ' + pinataJwt }, body: fd,
    });
    if (!r.ok) return fail(res, 502, 'PIN_FAILED', { status: r.status });
    const j = await r.json();
    primaryCid = j.IpfsHash;
    if (!primaryCid) return fail(res, 502, 'PIN_NO_CID');
  } catch (e) {
    return fail(res, 502, 'PIN_FAILED', { error: String(e && e.message) });
  }

  let filebase = 'skipped';
  let secondaryCid = null;
  if (filebaseToken) {
    try {
      const fd2 = new FormData();
      fd2.append('file', new Blob([bytes]), filename);
      const r2 = await fetch(FILEBASE_RPC, {
        method: 'POST', headers: { Authorization: 'Bearer ' + filebaseToken }, body: fd2,
      });
      if (r2.ok) {
        const j2 = await r2.json();
        secondaryCid = j2.Hash || null;
        filebase = secondaryCid ? (secondaryCid === primaryCid ? 'ok' : 'mismatch') : 'failed';
      } else {
        filebase = 'failed';
      }
    } catch (e) {
      filebase = 'failed';
    }
  }

  return res.status(200).json({
    ok: true, pinner, kind, uri: 'ipfs://' + primaryCid, cid: primaryCid,
    bytes: bytes.length, pinata: 'ok', filebase, filebaseCid: secondaryCid,
  });
};

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function sanitize(n) {
  if (typeof n !== 'string') return null;
  const c = n.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  return c.length ? c : null;
}
