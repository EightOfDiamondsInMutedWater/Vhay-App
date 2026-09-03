// ─────────────────────────────────────────────────────────────────────────────
// Vhay IPFS Helpers — server-proxied dual pinning via /api/pin
//
// Rewritten 9/3/26 (item 4 step 1). Previously this file read
// REACT_APP_FILEBASE_RPC_TOKEN directly and callers passed in a Pinata JWT, so
// both credentials were inlined into the public bundle at vhay.app.
//
// Now:
//   1. Sign a proof of wallet control with the caller's wallet
//   2. POST it to /api/pin together with the payload
//   3. The SERVER holds both tokens: Pinata (fatal) + Filebase (non-fatal)
//   4. Return the ipfs:// URI the server reports
//
// ⚠ NO PINNING CREDENTIAL IS READ IN THIS FILE ANY MORE, and none may ever be
// reintroduced. Anything named REACT_APP_* is publicly readable in the bundle.
//
// ⚠ `kind` defaults to 'document' — the STRICTER gate (valid proof AND an
// accepted, unexpired SCPO_BASIC). A forgotten argument therefore fails CLOSED
// with NOT_CREDENTIALED, rather than silently opening an uncredentialed path.
// ─────────────────────────────────────────────────────────────────────────────

import type { Wallet } from 'xrpl';
import { buildProofTx } from '../shared/credentialProof';

const PIN_API = '/api/pin';

// Mirrors MAX_BYTES in api/pin.js. The endpoint returns 413 PAYLOAD_TOO_LARGE
// above this; enforcing it here gives the user a clear rejection before paying
// for a base64 encode and an upload. Largest object ever pinned is 1.9 MB.
export const MAX_PIN_BYTES = 3 * 1024 * 1024;

export type PinKind = 'profile' | 'document';

const signProof = (wallet: Wallet): string => {
  const signed = wallet.sign(buildProofTx(wallet.classicAddress) as any);
  return signed.tx_blob;
};

// ── Internal: the single POST every public helper routes through ─────────────

const postToPin = async (
  wallet: Wallet,
  kind: PinKind,
  payload: { json?: object; base64?: string; filename?: string },
  label: string
): Promise<string> => {
  if (!wallet || !wallet.classicAddress) {
    throw new Error(`${label} failed: no wallet available to sign the pin request`);
  }

  let resp: Response | null = null;
  try {
    resp = await fetch(PIN_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proof: signProof(wallet), kind, ...payload }),
    });
  } catch (netErr: any) {
    throw new Error(`${label} failed: network error — ${netErr && netErr.message}`);
  }
  if (!resp) throw new Error(`${label} failed: no response`);

  // The rate limit is enforced at the Vercel edge and does NOT return JSON.
  // Check it BEFORE parsing, or the parse throws and masks the real cause.
  if (resp.status === 429) {
    throw new Error(`${label} failed: rate limited (429). Wait a moment and try again.`);
  }

  let data: any = null;
  try { data = await resp.json(); } catch (parseErr) { data = null; }

  if (!resp.ok || !data || data.ok !== true) {
    const code = (data && data.code) || 'HTTP_' + resp.status;
    throw new Error(`${label} failed: ${code}`);
  }
  if (!data.uri) throw new Error(`${label} failed: PIN_NO_URI`);

  // The endpoint reports per-backend status, so a Filebase failure is no longer
  // invisible. A Pinata failure is fatal server-side and never reaches here.
  if (data.filebase === 'ok') {
    console.log('[IPFS] ✅ Dual pin confirmed — CIDs match:', data.cid);
  } else if (data.filebase === 'mismatch') {
    console.warn('[IPFS] ⚠️ CID mismatch between Pinata and Filebase:', {
      pinata: data.cid,
      filebase: data.filebaseCid,
    });
  } else {
    console.warn(
      `[IPFS] ⚠️ Filebase pin ${data.filebase} — pinned to Pinata only, redundancy lost for ${data.cid}`
    );
  }

  return data.uri;
};

// ── Public: pin JSON ─────────────────────────────────────────────────────────

export const pinJSONToBoth = async (
  data: object,
  wallet: Wallet,
  kind: PinKind = 'document'
): Promise<string> => postToPin(wallet, kind, { json: data }, 'IPFS pin');

// ── Public: pin encrypted profile JSON ───────────────────────────────────────
// Always kind 'profile' — this runs on first save, BEFORE the wallet has a
// credential. Gating it on a credential would deadlock first-run onboarding.

export const pinEncryptedToBoth = async (
  encryptedData: string,
  wallet: Wallet
): Promise<string> =>
  postToPin(wallet, 'profile', { json: { encryptedData } }, 'Encrypted profile pin');

// ── Public: pin a File ───────────────────────────────────────────────────────

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = String(reader.result || '');
      const comma = r.indexOf(',');
      if (comma === -1) { reject(new Error('could not read file')); return; }
      resolve(r.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('could not read file'));
    reader.readAsDataURL(file);
  });

export const pinFileToBoth = async (
  file: File,
  wallet: Wallet,
  kind: PinKind = 'document'
): Promise<string> => {
  if (file.size > MAX_PIN_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(
      `File is too large to upload. The limit is 3 MB — "${file.name}" is ${mb} MB.`
    );
  }
  const base64 = await fileToBase64(file);
  return postToPin(wallet, kind, { base64, filename: file.name }, 'File pin');
};