// ─────────────────────────────────────────────────────────────────────────────
// SC.PO IPFS Helpers — Dual Pinning (Pinata + Filebase)
//
// Strategy:
//   1. Upload to Pinata (primary) — get CID
//   2. Upload to Filebase RPC (secondary) — get CID
//   3. Verify CIDs match (content-addressed — they always will)
//   4. Return ipfs:// URI using Pinata CID
//   5. If Filebase fails — log warning, continue with Pinata only (non-fatal)
//
// All existing upload functions route through pinJSONToBoth or pinFileToBoth.
// Callers receive the same ipfs:// URI as before — dual pinning is invisible.
// ─────────────────────────────────────────────────────────────────────────────

const PINATA_API = 'https://api.pinata.cloud/pinning';
const FILEBASE_RPC = 'https://rpc.filebase.io/api/v0/add';

// ── Internal: pin JSON to Filebase via RPC API ────────────────────────────────

const pinJSONToFilebase = async (data: object): Promise<string | null> => {
  const token = process.env.REACT_APP_FILEBASE_RPC_TOKEN;
  if (!token) {
    console.warn('[IPFS] Filebase RPC token not configured — skipping secondary pin');
    return null;
  }
  try {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const formData = new FormData();
    formData.append('file', blob, 'data.json');
    const response = await fetch(FILEBASE_RPC, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[IPFS] Filebase pin failed (${response.status}): ${errText}`);
      return null;
    }
    const result = await response.json();
    return result.Hash ? `ipfs://${result.Hash}` : null;
  } catch (err) {
    console.warn('[IPFS] Filebase pin exception (non-fatal):', err);
    return null;
  }
};

// ── Internal: pin File to Filebase via RPC API ────────────────────────────────

const pinFileToFilebase = async (file: File): Promise<string | null> => {
  const token = process.env.REACT_APP_FILEBASE_RPC_TOKEN;
  if (!token) {
    console.warn('[IPFS] Filebase RPC token not configured — skipping secondary pin');
    return null;
  }
  try {
    const formData = new FormData();
    formData.append('file', file, file.name);
    const response = await fetch(FILEBASE_RPC, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[IPFS] Filebase file pin failed (${response.status}): ${errText}`);
      return null;
    }
    const result = await response.json();
    return result.Hash ? `ipfs://${result.Hash}` : null;
  } catch (err) {
    console.warn('[IPFS] Filebase file pin exception (non-fatal):', err);
    return null;
  }
};

// ── Public: pin JSON to both services ────────────────────────────────────────

export const pinJSONToBoth = async (
  data: object,
  pinataApiKey: string
): Promise<string> => {
  // Primary: Pinata
  const pinataResponse = await fetch(`${PINATA_API}/pinJSONToIPFS`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${pinataApiKey}`,
    },
    body: JSON.stringify(data),
  });
  if (!pinataResponse.ok) {
    const errText = await pinataResponse.text();
    throw new Error(`Pinata upload failed: ${errText}`);
  }
  const pinataResult = await pinataResponse.json();
  const primaryUri = `ipfs://${pinataResult.IpfsHash}`;

  // Secondary: Filebase (non-fatal)
  const secondaryUri = await pinJSONToFilebase(data);
  if (secondaryUri) {
    if (secondaryUri === primaryUri) {
      console.log('[IPFS] ✅ Dual pin confirmed — CIDs match:', pinataResult.IpfsHash);
    } else {
      // This should never happen with identical content — log if it does
      console.warn('[IPFS] ⚠️ CID mismatch between Pinata and Filebase:', {
        pinata: primaryUri,
        filebase: secondaryUri,
      });
    }
  }

  return primaryUri;
};

// ── Public: pin encrypted JSON to both services ───────────────────────────────

export const pinEncryptedToBoth = async (
  encryptedData: string,
  pinataApiKey: string
): Promise<string> => {
  return pinJSONToBoth({ encryptedData }, pinataApiKey);
};

// ── Public: pin File to both services ────────────────────────────────────────

export const pinFileToBoth = async (
  file: File,
  pinataApiKey: string
): Promise<string> => {
  // Primary: Pinata
  const formData = new FormData();
  formData.append('file', file);
  const pinataResponse = await fetch(`${PINATA_API}/pinFileToIPFS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pinataApiKey}` },
    body: formData,
  });
  if (!pinataResponse.ok) {
    const errText = await pinataResponse.text();
    throw new Error(`Pinata file upload failed: ${errText}`);
  }
  const pinataResult = await pinataResponse.json();
  const primaryUri = `ipfs://${pinataResult.IpfsHash}`;

  // Secondary: Filebase (non-fatal)
  const secondaryUri = await pinFileToFilebase(file);
  if (secondaryUri) {
    if (secondaryUri === primaryUri) {
      console.log('[IPFS] ✅ Dual file pin confirmed — CIDs match:', pinataResult.IpfsHash);
    } else {
      console.warn('[IPFS] ⚠️ File CID mismatch:', {
        pinata: primaryUri,
        filebase: secondaryUri,
      });
    }
  }

  return primaryUri;
};
