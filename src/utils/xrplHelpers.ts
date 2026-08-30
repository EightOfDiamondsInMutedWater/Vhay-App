import * as xrpl from 'xrpl';

// ── Source Tag (Make Waves Challenge attribution, T&Cs §5/§7) ──────────────
// Read from env so hosted can set REACT_APP_SOURCE_TAG (Task 4.3); falls back
// to the registered tag. Tagged pre-sign at TWO chokepoints: autofillTagged (for
// direct client.autofill callers) and submitQueued (which uses submitAndWait's own
// autofill and therefore never passed through autofillTagged).
// ⚠ The previous version of this comment claimed "Covers ALL submit paths" and was
// FALSE — submitQueued's 7 call sites went out untagged. Measured on mainnet 8/30/26:
// CredentialAccept 1F7F7128… SourceTag=ABSENT while DIDSet/AccountSet from the same
// save carried 2606160012. Do not add a third submit path without tagging it here.
export const SOURCE_TAG = Number(process.env.REACT_APP_SOURCE_TAG ?? 2606160012) || 0;
export const withSourceTag = <T extends Record<string, any>>(tx: T): T =>
  SOURCE_TAG ? ({ ...tx, SourceTag: SOURCE_TAG } as T) : tx;
// Inject SourceTag then autofill. Replaces every `client.autofill(tx)` call.
export const autofillTagged = (client: any, tx: any) => client.autofill(withSourceTag(tx));

// Constants — Credential tier hex values
export const SCPO_BASIC_HEX = '5343504F5F4241534943'; // hex("SCPO_BASIC")
export const SCPO_VERIFIED_HEX = '5343504F5F564552494649'; // hex("SCPO_VERIFIED")
export const SCPO_INSTITUTIONAL_HEX = '5343504F5F494E5354'; // bytes for "SCPO_INST" — institutional-tier credential type in the Permissioned Domain's AcceptedCredentials. MUST stay byte-identical to SCPO_INST_HEX (~L1037), which is what institutional credentials are actually issued under (~L1049). Name is legacy; do NOT change the value — mainnet credentials were issued under these exact bytes.

export const decodeTier = (hexType: string): string => {
  try {
    let decoded = '';
    for (let i = 0; i < hexType.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hexType.substring(i, i + 2), 16));
    }
    if (decoded === 'SCPO_BASIC') return 'basic';
    if (decoded === 'SCPO_VERIFIED') return 'verified';
    if (decoded === 'SCPO_INSTITUTIONAL') return 'institutional';
    return 'unknown';
  } catch {
    return 'unknown';
  }
};
export const deployPermissionedDomain = async (client: xrpl.Client, platformWallet: xrpl.Wallet) => {
  const transaction = {
    TransactionType: 'PermissionedDomainSet',
    Account: platformWallet.classicAddress,
    AcceptedCredentials: [
      {
        Credential: {
          Issuer: platformWallet.classicAddress,
          CredentialType: SCPO_BASIC_HEX
        }
      }
    ]
  };

 const tx = await submitQueued(transaction, platformWallet);

  const meta = tx.result.meta as any;

  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Domain creation failed: ${meta.TransactionResult}`);
  }

  const affectedNodes = meta.AffectedNodes || [];
  const domainNode = affectedNodes.find(
    (node: any) => node.CreatedNode &&
            node.CreatedNode.LedgerEntryType === 'PermissionedDomain'
  );

  if (!domainNode) {
    throw new Error('Domain created but could not extract Domain ID');
  }

  const domainID = domainNode.CreatedNode.LedgerIndex;
  return domainID;
};
export const issueCredential = async (
  client: xrpl.Client,
  platformWallet: xrpl.Wallet,
  subjectAddress: string,
  credentialType: string = SCPO_BASIC_HEX,
  expirationDays: number = 365
) => {
  // Calculate expiration in Ripple Epoch seconds
  const rippleEpoch = 946684800;
  const expirationTime = Math.floor(Date.now() / 1000) - rippleEpoch + (expirationDays * 24 * 60 * 60);

  const transaction = {
    TransactionType: 'CredentialCreate',
    Account: platformWallet.classicAddress,
    Subject: subjectAddress,
    CredentialType: credentialType,
    Expiration: expirationTime
  };

  const tx = await submitQueued(transaction, platformWallet);

  const meta = tx.result.meta as any;
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Credential issuance failed: ${meta.TransactionResult}`);
  }

  return { success: true, txHash: tx.result.hash };
};

export const acceptCredential = async (
  client: xrpl.Client,
  userWallet: xrpl.Wallet,
  issuerAddress: string,
  credentialType: string = SCPO_BASIC_HEX
) => {
  const transaction = {
    TransactionType: 'CredentialAccept',
    Account: userWallet.address,
    Issuer: issuerAddress,
    CredentialType: credentialType
  };

  const tx = await submitQueued(transaction, userWallet);

  const meta = tx.result.meta as any;
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Credential accept failed: ${meta.TransactionResult}`);
  }

  return { success: true, txHash: tx.result.hash };
};
export const revokeCredential = async (
  client: xrpl.Client,
  platformWallet: xrpl.Wallet,
  subjectAddress: string,
  credentialType: string = SCPO_BASIC_HEX
) => {
  const transaction = {
    TransactionType: 'CredentialDelete',
    Account: platformWallet.classicAddress,
    Subject: subjectAddress,
    CredentialType: credentialType
  };

  const tx = await submitQueued(transaction, platformWallet);

  const meta = tx.result.meta as any;
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Credential revocation failed: ${meta.TransactionResult}`);
  }

  return { success: true, txHash: tx.result.hash };
};
export const checkAndRenewCredential = async (
  client: xrpl.Client,
  platformWallet: xrpl.Wallet,
  userWallet: xrpl.Wallet,
  credentialType: string = SCPO_BASIC_HEX
) => {
  // Check if credential already exists
  try {
    const credsResp = await client.request({
      command: 'account_objects',
      account: userWallet.classicAddress,
      type: 'credential',
      ledger_index: 'validated'
    } as any);
    const credentials = (credsResp.result as any).account_objects || [];

    for (const cred of credentials) {
      if (cred.Issuer === platformWallet.classicAddress && cred.CredentialType === credentialType) {
        // Credential exists — check if near expiry (within 30 days)
        if (cred.Expiration) {
          const rippleEpoch = 946684800;
          const expiresAt = (cred.Expiration + rippleEpoch) * 1000;
          const thirtyDays = 30 * 24 * 60 * 60 * 1000;

          if (Date.now() > expiresAt - thirtyDays) {
            // Near expiry or expired — delete and re-issue
            console.log('Credential near expiry, renewing...');
            await revokeCredential(client, platformWallet, userWallet.classicAddress, credentialType);
            await issueCredential(client, platformWallet, userWallet.classicAddress, credentialType);
            await acceptCredential(client, userWallet, platformWallet.classicAddress, credentialType);
            console.log('✅ Credential renewed');
            return 'renewed';
          }
        }
        // Credential exists and not near expiry
        return 'valid';
      }
    }
  } catch {
    // No credentials found — fall through to issue new one
  }

  // No matching credential — issue new one
  await issueCredential(client, platformWallet, userWallet.classicAddress, credentialType);
  await acceptCredential(client, userWallet, platformWallet.classicAddress, credentialType);
  console.log('✅ New credential issued');
  return 'issued';
};
export const validateCredential = async (
  walletAddress: string,
  domainID: string
): Promise<{ valid: boolean; tier?: string; expiration?: number; issuer?: string; reason?: string }> => {
  const client = await getXRPLClient();

  // 1. Get the domain's accepted credentials
  let domain: any;
  try {
    const domainResp = await client.request({
      command: 'ledger_entry',
      index: domainID,
      ledger_index: 'validated'
    } as any);
    domain = (domainResp.result as any).node;
  } catch {
    return { valid: false, reason: 'Domain not found' };
  }

  if (!domain || domain.LedgerEntryType !== 'PermissionedDomain') {
    return { valid: false, reason: 'Domain not found' };
  }

  // 2. Get all credentials held by this wallet
  let credentials: any[] = [];
  try {
    const credsResp = await client.request({
      command: 'account_objects',
      account: walletAddress,
      type: 'credential',
      ledger_index: 'validated'
    } as any);
    credentials = (credsResp.result as any).account_objects || [];
  } catch {
    return { valid: false, reason: 'Could not fetch credentials' };
  }

  // 3. Check if any credential matches the domain's accepted list
  for (const cred of credentials) {
    // Must be accepted (Flags & 0x10000)
    console.log('[validateCredential] checking cred Flags:', cred.Flags, 'hex:', cred.Flags?.toString(16), 'accepted?', !!(cred.Flags & 0x00010000));
    if (!(cred.Flags & 0x00010000)) continue;

    // Check expiration
    if (cred.Expiration) {
      const rippleEpoch = 946684800;
      const expiresAt = (cred.Expiration + rippleEpoch) * 1000;
      if (Date.now() > expiresAt) continue;
    }

    // Match against domain's accepted credentials
    for (const accepted of domain.AcceptedCredentials) {
      const ac = accepted.AcceptedCredential || accepted.Credential;
      if (cred.Issuer === ac.Issuer && cred.CredentialType === ac.CredentialType) {
        return {
          valid: true,
          tier: decodeTier(cred.CredentialType),
          expiration: cred.Expiration,
          issuer: cred.Issuer
        };
      }
    }
  }

  console.log('[validateCredential] credentials found:', JSON.stringify(credentials));
  console.log('[validateCredential] domain AcceptedCredentials:', JSON.stringify(domain.AcceptedCredentials));
  return { valid: false, reason: 'No matching credential found' };
};

export const canCreatePO = async (
  buyerAddress: string,
  vendorAddress: string
): Promise<{ allowed: boolean; buyerTier?: string; vendorTier?: string; reason?: string }> => {
  const domainID = process.env.REACT_APP_DOMAIN_ID;
  if (!domainID) {
    return { allowed: true, reason: 'No domain configured (skipping check)' };
  }

  const buyerCred = await validateCredential(buyerAddress, domainID);
  if (!buyerCred.valid) {
    return { allowed: false, reason: `Buyer: ${buyerCred.reason}` };
  }

  const vendorCred = await validateCredential(vendorAddress, domainID);
  if (!vendorCred.valid) {
    return { allowed: false, reason: `Vendor: ${vendorCred.reason}` };
  }

  return {
    allowed: true,
    buyerTier: buyerCred.tier,
    vendorTier: vendorCred.tier
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Task 4.3 — XRPL Connection Resilience
// Multi-endpoint failover with exponential backoff and health monitoring
// ─────────────────────────────────────────────────────────────────────────────

const XRPL_ENDPOINTS: string[] = process.env.REACT_APP_XRPL_NODES
  ? process.env.REACT_APP_XRPL_NODES.split(',').map(s => s.trim()).filter(Boolean)
  : ['wss://s.devnet.rippletest.net:51233'];

const CONNECTION_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

let xrplClient: xrpl.Client | null = null;
let connectingPromise: Promise<xrpl.Client> | null = null;
let currentEndpointIndex = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const connectToEndpoint = async (endpoint: string): Promise<xrpl.Client> => {
  const client = new xrpl.Client(endpoint, { connectionTimeout: CONNECTION_TIMEOUT_MS });
  await client.connect();
  client.on('disconnected', () => {
    console.warn(`[XRPL] Disconnected from ${endpoint} — will reconnect on next request`);
    if (xrplClient === client) {
      xrplClient = null;
      connectingPromise = null;
    }
  });
  return client;
};

export const getXRPLClient = async (): Promise<xrpl.Client> => {
  if (xrplClient?.isConnected()) return xrplClient;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const endpoint = XRPL_ENDPOINTS[currentEndpointIndex % XRPL_ENDPOINTS.length];
      try {
        if (attempt > 0) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`[XRPL] Retry ${attempt}/${MAX_RETRIES - 1} on ${endpoint} after ${delay}ms`);
          await sleep(delay);
        }
        const client = await connectToEndpoint(endpoint);
        console.log(`[XRPL] ✅ Connected to ${endpoint}`);
        xrplClient = client;
        connectingPromise = null;
        return client;
      } catch (err: any) {
        lastError = err;
        console.warn(`[XRPL] Failed to connect to ${endpoint}: ${err.message}`);
        currentEndpointIndex = (currentEndpointIndex + 1) % XRPL_ENDPOINTS.length;
      }
    }

    connectingPromise = null;
    throw new Error(`[XRPL] All connection attempts failed. Last error: ${lastError?.message}`);
  })();

  return connectingPromise;
};

export const resetXRPLClient = () => {
  xrplClient = null;
  connectingPromise = null;
  currentEndpointIndex = 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Task 4.4 — Transaction Queue
// Serializes XRPL submissions to prevent sequence number conflicts
// Retries on transient failures with exponential backoff
// ─────────────────────────────────────────────────────────────────────────────

const TX_MAX_RETRIES = 3;
const TX_RETRY_BASE_DELAY_MS = 1000;

// Transient error codes that are safe to retry
const RETRYABLE_ERRORS = new Set([
  'tefPAST_SEQ',
  'terPRE_SEQ',
  'terQUEUED',
  'telINSUF_FEE_P',
  'tooBusy',
  'slowDown',
  'noNetwork',
]);

let txQueuePromise: Promise<any> = Promise.resolve();

export const submitQueued = async (
  transaction: any,
  wallet: xrpl.Wallet
): Promise<any> => {
  // Chain onto the existing queue — each submission waits for the previous to complete
  const result = txQueuePromise.then(async () => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < TX_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = TX_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`[TxQueue] Retry ${attempt}/${TX_MAX_RETRIES - 1} after ${delay}ms`);
          await sleep(delay);
        }
        const client = await getXRPLClient();
        const tx = await client.submitAndWait(withSourceTag(transaction) as any, {
          autofill: true,
          wallet,
        });
        const meta = tx.result.meta as any;
        const resultCode: string = meta?.TransactionResult || '';
        if (resultCode !== 'tesSUCCESS') {
          if (RETRYABLE_ERRORS.has(resultCode)) {
            console.warn(`[TxQueue] Retryable error ${resultCode} on attempt ${attempt + 1}`);
            lastError = new Error(resultCode);
            continue;
          }
          throw new Error(`Transaction failed: ${resultCode}`);
        }
        console.log(`[TxQueue] ✅ ${resultCode} — ${tx.result.hash}`);
        return tx;
      } catch (err: any) {
        const isRetryable = RETRYABLE_ERRORS.has(err.message) ||
          err.message?.includes('noNetwork') ||
          err.message?.includes('slowDown') ||
          err.message?.includes('tooBusy');
        if (isRetryable && attempt < TX_MAX_RETRIES - 1) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('[TxQueue] Max retries exceeded');
  });

  // Update the queue tail — next submission will wait for this one
  txQueuePromise = result.catch(() => {});
  return result;
};

export const submitBlobQueued = async (
  txBlob: string
): Promise<any> => {
  const result = txQueuePromise.then(async () => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < TX_MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = TX_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`[TxQueue] Blob retry ${attempt}/${TX_MAX_RETRIES - 1} after ${delay}ms`);
          await sleep(delay);
        }
        const client = await getXRPLClient();
        const tx = await client.submitAndWait(txBlob);
        const meta = (tx.result.meta as any);
        const resultCode: string = meta?.TransactionResult || '';
        if (resultCode !== 'tesSUCCESS') {
          if (RETRYABLE_ERRORS.has(resultCode)) {
            console.warn(`[TxQueue] Retryable error ${resultCode} on attempt ${attempt + 1}`);
            lastError = new Error(resultCode);
            continue;
          }
          throw new Error(`Transaction failed: ${resultCode}`);
        }
        console.log(`[TxQueue] ✅ ${resultCode} — ${tx.result.hash}`);
        return tx;
      } catch (err: any) {
        const isRetryable = RETRYABLE_ERRORS.has(err.message) ||
          err.message?.includes('noNetwork') ||
          err.message?.includes('slowDown') ||
          err.message?.includes('tooBusy');
        if (isRetryable && attempt < TX_MAX_RETRIES - 1) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError || new Error('[TxQueue] Max retries exceeded');
  });

  txQueuePromise = result.catch(() => {});
  return result;
};


// Helper 1: Get all MPTs you created (your purchase orders)
export const getMyMPTs = async (address: string) => {
  const client = await getXRPLClient();
  const response = await client.request({
    command: 'account_objects',
    account: address,
    type: 'mpt_issuance',
    ledger_index: 'validated'
  });
  return response.result.account_objects;
};

// Helper 2: Get all escrows for your address
export const getMyEscrows = async (address: string) => {
  const client = await getXRPLClient();
  const response = await client.request({
    command: 'account_objects',
    account: address,
    type: 'escrow',
    ledger_index: 'validated'
  });
  return response.result.account_objects;
};

// Helper 3: Get all NFTs (for inventory)
export const getAccountNFTs = async (address: string) => {
  const client = await getXRPLClient();
  const response = await client.request({
    command: 'account_nfts',
    account: address,
    ledger_index: 'validated'
  });
  return response.result.account_nfts;
};

// Helper 4: Get latest profile from Domain field
export const getLatestProfileFromAddress = async (address: string) => {
  const client = await getXRPLClient();
  try {
    const info = await client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'validated'
    });
    const domainHex = info.result.account_data.Domain;
    return domainHex ? xrpl.convertHexToString(domainHex) : null;
  } catch {
    return null;
  }
};
// Phase 2 Helpers - Get POs from ledger
export const getBuyerPOs = async (buyerAddress: string) => {
  const client = await getXRPLClient();
  const mpts = await getMyMPTs(buyerAddress);
  return mpts.filter((mpt: any) => {
    try {
      const metadata = JSON.parse(xrpl.convertHexToString(mpt.MPTokenMetadata || ''));
      return metadata.t === 'SCPO';
    } catch {
      return false;
    }
  });
};

export const getVendorAuthorizedPOs = async (vendorAddress: string) => {
  const client = await getXRPLClient();
  const response = await client.request({
    command: 'account_objects',
    account: vendorAddress,
    type: 'mptoken',
    ledger_index: 'validated'
  });
  return response.result.account_objects;
};
// ─────────────────────────────────────────────────────────────────────────────
// PO Creation Date Lookup
// For a given issuanceId, looks up the MPTokenIssuance ledger entry to get
// the PreviousTxnID, then fetches that transaction to get the close_time_iso.
// This is the same reliable pattern used by the working scanFeeEntries function.
// ─────────────────────────────────────────────────────────────────────────────
export const getPOCreationDate = async (issuanceId: string): Promise<string> => {
  const info = await getPOCreationInfo(issuanceId);
  return info.date;
};

export const getPOCreationTxHash = async (issuanceId: string): Promise<string> => {
  try {
    const client = await getXRPLClient();
    const issuanceResp = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
      ledger_index: 'validated'
    } as any);
    return (issuanceResp.result as any).node?.PreviousTxnID || '';
  } catch {
    return '';
  }
};
export const getPOCreationInfo = async (issuanceId: string): Promise<{ date: string; txHash: string }> => {
  const ledgerSequence = parseInt(issuanceId.slice(0, 8), 16);
  const rippleEpoch = 946684800;

  // Helper: derive date from Ripple close_time or close_time_iso
  const parseDate = (ledgerData: any): Date | null => {
    if (ledgerData?.close_time_iso) return new Date(ledgerData.close_time_iso);
    if (ledgerData?.close_time != null) return new Date((ledgerData.close_time + rippleEpoch) * 1000);
    return null;
  };

  // Attempt 1: use existing WebSocket client
  try {
    const client = await getXRPLClient();
    const ledgerResp = await client.request({
      command: 'ledger',
      ledger_index: ledgerSequence,
      transactions: false,
      expand: false,
    } as any);
    const ledgerData = (ledgerResp.result as any).ledger || (ledgerResp.result as any).closed?.ledger;
    const d = parseDate(ledgerData);
    if (d) {
      return {
        date: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
        txHash: '',
      };
    }
  } catch (e: any) {
    // WS client returned ledgerNotFound — try HTTP fallback without resetting the client
    // resetXRPLClient() was previously here but was too aggressive — it killed the shared
    // client mid-flight causing fetchVendorInventoryV2 to fail on concurrent calls
    console.warn('[getPOCreationInfo] WS ledger lookup failed for', issuanceId.slice(0, 8), '— trying HTTP fallback');
  }

  // Attempt 2: HTTP fallback — bypasses the WebSocket entirely
  try {
    const httpEndpoint = (process.env.REACT_APP_XRPL_NODES || 'wss://s.devnet.rippletest.net:51233')
      .split(',')[0]
      .trim()
      .replace('wss://', 'https://')
      .replace(':51233', ':51234');

    const resp = await fetch(httpEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'ledger',
        params: [{ ledger_index: ledgerSequence, transactions: false, expand: false }],
      }),
    });
    const json = await resp.json();
    const ledgerData = json?.result?.ledger || json?.result?.closed?.ledger;
    const d = parseDate(ledgerData);
    if (d) {
      return {
        date: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
        txHash: '',
      };
    }
  } catch (httpErr: any) {
    console.warn('[getPOCreationInfo] HTTP fallback also failed for', issuanceId.slice(0, 8), ':', httpErr?.message);
  }

  // Attempt 3: derive approximate date from Ripple epoch + ledger sequence.
  // Devnet closes ~1 ledger/second. Use sequence as a rough offset from a
  // known anchor (devnet genesis close_time = 825,878,070 Ripple epoch seconds).
  try {
    const DEVNET_GENESIS_RIPPLE = 825878070;
    const approxRippleTime = DEVNET_GENESIS_RIPPLE + ledgerSequence;
    const d = new Date((approxRippleTime + rippleEpoch) * 1000);
    const year = d.getFullYear();
    // Sanity check — if year is unreasonable, fall through to unknown
    if (year >= 2024 && year <= 2030) {
      return {
        date: `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`,
        txHash: '',
      };
    }
  } catch { /* fall through */ }

  return { date: 'Unknown', txHash: '' };
};

export const getEscrowsForPO = async (buyerAddress: string, issuanceId: string) => {
  const client = await getXRPLClient();
  const escrows = await getMyEscrows(buyerAddress);
  return escrows.filter((escrow: any) => {
    const memoObj = escrow.Memos?.[0]?.Memo || {};
    // Try v1 standard envelope first
    try {
      const memoType = xrpl.convertHexToString(memoObj.MemoType || '');
      if (memoType === 'SCPO') {
        const envelope = JSON.parse(xrpl.convertHexToString(memoObj.MemoData || ''));
        return envelope?.r === issuanceId;
      }
    } catch { /* fall through to legacy */ }
    // Legacy fallback — pre-standardization SCPO_ESCROW memos
    const rawData = xrpl.convertHexToString(memoObj.MemoData || '');
    return rawData.includes(issuanceId);
  });
};
// ============================================================
// PHASE 2 — RLUSD Token Escrow Utilities (Tasks 2.2–2.3)
// Add these functions to the bottom of src/utils/xrplHelpers.ts
// ============================================================

// Task 2.2: Check if RLUSD is configured for this environment
export const isRLUSDConfigured = (): boolean => {
  return !!process.env.REACT_APP_RLUSD_ISSUER;
};

// Task 2.2: Get the RLUSD currency/issuer pair
export const getRLUSDCurrency = () => {
  return {
    currency: 'USD',
    issuer: process.env.REACT_APP_RLUSD_ISSUER || ''
  };
};

// Task 2.3: Check if a wallet has a trust line to the RLUSD issuer
export const checkRLUSDTrustLine = async (address: string): Promise<{
  hasTrustLine: boolean;
  balance: string;
  limit: string;
}> => {
  if (!isRLUSDConfigured()) {
    return { hasTrustLine: false, balance: '0', limit: '0' };
  }

  const client = await getXRPLClient();
  try {
    const response = await client.request({
      command: 'account_lines',
      account: address,
      peer: process.env.REACT_APP_RLUSD_ISSUER,
      ledger_index: 'validated'
    });

    const rlusdLine = (response.result as any).lines?.find(
      (line: any) => line.currency === 'USD' && line.account === process.env.REACT_APP_RLUSD_ISSUER
    );

    if (rlusdLine) {
      return {
        hasTrustLine: true,
        balance: rlusdLine.balance || '0',
        limit: rlusdLine.limit || '0'
      };
    }

    return { hasTrustLine: false, balance: '0', limit: '0' };
  } catch {
    return { hasTrustLine: false, balance: '0', limit: '0' };
  }
};

// Task 2.3: Get RLUSD balance for a wallet
export const getRLUSDBalance = async (address: string): Promise<string> => {
  const result = await checkRLUSDTrustLine(address);
  return result.balance;
};

// Task 2.3: Set up a trust line from a wallet to the RLUSD issuer
export const setupRLUSDTrustLine = async (
  client: xrpl.Client,
  userWallet: xrpl.Wallet,
  limit: string = '1000000'
): Promise<{ success: boolean; txHash?: string; error?: string }> => {
  if (!isRLUSDConfigured()) {
    return { success: false, error: 'RLUSD issuer not configured' };
  }

  try {
    // Check if trust line already exists
    const existing = await checkRLUSDTrustLine(userWallet.classicAddress);
    if (existing.hasTrustLine) {
      return { success: true, txHash: 'already_exists' };
    }

    const trustSetTx = {
      TransactionType: 'TrustSet',
      Account: userWallet.classicAddress,
      LimitAmount: {
        currency: 'USD',
        issuer: process.env.REACT_APP_RLUSD_ISSUER!,
        value: limit
      }
    };

    const result = await submitQueued(trustSetTx, userWallet);

    const meta = result.result.meta as any;
    if (meta.TransactionResult === 'tesSUCCESS') {
      return { success: true, txHash: result.result.hash };
    } else {
      return { success: false, error: `TrustSet failed: ${meta.TransactionResult}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message || 'Trust line setup failed' };
  }
};

// Task 2.2: Check if both parties are ready for RLUSD escrow
export const canUseRLUSDEscrow = async (
  buyerAddress: string,
  vendorAddress: string
): Promise<{
  ready: boolean;
  buyerTrustLine: boolean;
  vendorTrustLine: boolean;
  buyerBalance: string;
  reason?: string;
}> => {
  if (!isRLUSDConfigured()) {
    return {
      ready: false,
      buyerTrustLine: false,
      vendorTrustLine: false,
      buyerBalance: '0',
      reason: 'RLUSD not configured'
    };
  }

  const buyerCheck = await checkRLUSDTrustLine(buyerAddress);
  const vendorCheck = await checkRLUSDTrustLine(vendorAddress);

  if (!buyerCheck.hasTrustLine) {
    return {
      ready: false,
      buyerTrustLine: false,
      vendorTrustLine: vendorCheck.hasTrustLine,
      buyerBalance: '0',
      reason: 'Buyer needs RLUSD trust line'
    };
  }

  if (!vendorCheck.hasTrustLine) {
    return {
      ready: false,
      buyerTrustLine: true,
      vendorTrustLine: false,
      buyerBalance: buyerCheck.balance,
      reason: 'Vendor needs RLUSD trust line'
    };
  }

  return {
    ready: true,
    buyerTrustLine: true,
    vendorTrustLine: true,
    buyerBalance: buyerCheck.balance
  };
};
// ─────────────────────────────────────────────────────────────────────────────
// Task 4.1 — Fee Scanner
// Reconstructs FeeEntry[] from on-chain FEE_PAYMENT memos on the company wallet
// Replaces localStorage.getItem('feeEntries') as the source of truth
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeEntry { date: string; poName: string; amount: string; txHash: string; feeType: string; account: string; v?: string; }

export const scanFeeEntries = async (companyWallet: string): Promise<FeeEntry[]> => {
  if (!companyWallet) return [];
  const entries: FeeEntry[] = [];
  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: companyWallet,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 400,
    });
    for (const tx of resp.result.transactions || []) {
      try {
        const txObj = (tx as any).tx_json || (tx as any).tx || {};
        if (txObj.TransactionType !== 'Payment') continue;
        const memos = txObj.Memos || [];
        for (const m of memos) {
          const memo = m.Memo || {};
          if (!memo.MemoType || !memo.MemoData) continue;
          try {
            const memoType = xrpl.convertHexToString(memo.MemoType);
            if (memoType !== 'SCPO') continue;
            const envelope = JSON.parse(xrpl.convertHexToString(memo.MemoData));
            if (envelope?.a !== 'FEE_PAYMENT') continue;
            // Reconstruct FeeEntry from envelope
            const p = envelope.p || {};
            const txMeta = (tx as any).tx_json || (tx as any).tx || {};
            const hash = txMeta.hash || (tx as any).hash || '';
            // Convert ledger close time to readable date
            const closeTime = (tx as any).close_time_iso
              || (tx as any).tx?.date
              || null;
            const date = closeTime
              ? new Date(closeTime).toLocaleString()
              : new Date().toLocaleString();
            entries.push({
              date,
              poName: p.poName || 'Unknown PO',
              amount: p.amount || '0',
              txHash: hash,
              feeType: p.feeType || 'UNKNOWN',
              account: txObj.Account || '',
              v: p.v || undefined,
            });
          } catch { continue; }
        }
      } catch { continue; }
    }
  } catch (e) {
    console.error('[FeeScanner] Failed to scan fee entries:', e);
  }
  return entries;
};
// ─────────────────────────────────────────────────────────────────────────────
// Task 4.1 — Linked Profile Scanner
// Reconstructs ProfileLink[] from on-chain LINK_PROFILE memos
// Replaces localStorage as the source of truth for linked profiles
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileLinkOnChain {
  linkerAddress: string;
  linkeeAddress: string;
  linkeeProfileUUID: string;
  linkeeIpfsUri: string;
  role: 'vendor' | 'customer';
  txHash: string;
  createdAt: number;
}

export const scanLinkedProfiles = async (
  walletAddress: string
): Promise<ProfileLinkOnChain[]> => {
  if (!walletAddress) return [];
  const links: ProfileLinkOnChain[] = [];
  const unlinkedAddresses = new Set<string>(); // tracks unlinked linkeeAddresses
  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: walletAddress,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 400,
    });
    for (const tx of resp.result.transactions || []) {
      try {
        const txObj = (tx as any).tx_json || (tx as any).tx || {};
        if (txObj.TransactionType !== 'Payment') continue;
        const memos = txObj.Memos || [];
        for (const m of memos) {
          const memo = m.Memo || {};
          if (!memo.MemoType || !memo.MemoData) continue;
          try {
            const memoType = xrpl.convertHexToString(memo.MemoType);
            if (memoType !== 'SCPO') continue;
            const envelope = JSON.parse(xrpl.convertHexToString(memo.MemoData));
            const p = envelope.p || {};
            const hash = txObj.hash || (tx as any).hash || '';
            const closeTime = (tx as any).close_time_iso || null;
            const createdAt = closeTime ? new Date(closeTime).getTime() : Date.now();

            // Track UNLINK_PROFILE memos — these cancel out LINK_PROFILE memos
            if (envelope?.a === 'UNLINK_PROFILE') {
              const unlinkedAddr = envelope.r || p.linkedAddr || '';
              if (unlinkedAddr) unlinkedAddresses.add(unlinkedAddr);
              continue;
            }

            if (envelope?.a !== 'LINK_PROFILE') continue;
            links.push({
              linkerAddress: txObj.Account || walletAddress,
              linkeeAddress: envelope.r || p.linkedAddr || '',
              linkeeProfileUUID: p.profileUUID || '',
              linkeeIpfsUri: p.ipfsUri || '',
              role: p.role || 'vendor',
              txHash: hash,
              createdAt,
            });
          } catch { continue; }
        }
      } catch { continue; }
    }
  } catch (e) {
    console.error('[LinkScanner] Failed to scan linked profiles:', e);
  }

  // Filter out any links that have been subsequently unlinked
  return links.filter(link => !unlinkedAddresses.has(link.linkeeAddress));
};
// ─────────────────────────────────────────────────────────────────────────────
// Task 4.6 — On-Chain Audit Log Scanner
// Reads all SCPO memos from a wallet's transaction history
// Returns a structured, chronological audit log queryable by action or PO ref
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  action: string;       // SCPO_ACTIONS value e.g. 'CREATE_PO'
  ref: string;          // issuanceId or wallet address
  payload: any;         // action-specific payload
  txHash: string;
  account: string;      // wallet that submitted the tx
  date: string;         // human-readable ISO date
  timestamp: number;    // ms since epoch for sorting
}

export const scanAuditLog = async (
  walletAddress: string,
  filterAction?: string
): Promise<AuditLogEntry[]> => {
  if (!walletAddress) return [];
  const entries: AuditLogEntry[] = [];
  try {
    const client = await getXRPLClient();
    const resp = await client.request({
      command: 'account_tx',
      account: walletAddress,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 400,
    });
    for (const tx of resp.result.transactions || []) {
      try {
        const txObj = (tx as any).tx_json || (tx as any).tx || {};
        const memos = txObj.Memos || [];
        for (const m of memos) {
          const memo = m.Memo || {};
          if (!memo.MemoType || !memo.MemoData) continue;
          try {
            const memoType = xrpl.convertHexToString(memo.MemoType);
            if (memoType !== 'SCPO') continue;
            const envelope = JSON.parse(xrpl.convertHexToString(memo.MemoData));
            if (!envelope?.a) continue;
            if (filterAction && envelope.a !== filterAction) continue;
            const hash = txObj.hash || (tx as any).hash || '';
            const closeTime = (tx as any).close_time_iso || null;
            const timestamp = closeTime ? new Date(closeTime).getTime() : Date.now();
            entries.push({
              action: envelope.a,
              ref: envelope.r || '',
              payload: envelope.p || {},
              txHash: hash,
              account: txObj.Account || walletAddress,
              date: closeTime ? new Date(closeTime).toLocaleString() : 'Unknown',
              timestamp,
            });
          } catch { continue; }
        }
      } catch { continue; }
    }
  } catch (e) {
    console.error('[AuditLog] Failed to scan audit log:', e);
  }
  // Return chronological order, oldest first
  return entries.sort((a, b) => a.timestamp - b.timestamp);
};

// ── Phase 6.0b — Institutional Credential (Lender / Partner tier) ─────────────
// Hex of "SCPO_INST" — shorter than SCPO_INSTITUTIONAL for on-chain efficiency
export const SCPO_INST_HEX = xrpl.convertStringToHex('SCPO_INST');

/**
 * Issue an Institutional-tier credential to a lender or yield partner wallet.
 * Admin-only. Call after completing off-platform identity verification.
 */
export const issueInstitutionalCredential = async (
  client: xrpl.Client,
  platformWallet: xrpl.Wallet,
  lenderAddress: string,
  expirationDays: number = 365
) => {
  return issueCredential(client, platformWallet, lenderAddress, SCPO_INST_HEX, expirationDays);
};

/**
 * Update the Permissioned Domain to accept Institutional credentials.
 * Call once after first institutional lender is onboarded.
 * Adds SCPO_INST_HEX to the AcceptedCredentials list alongside existing tiers.
 */
export const addInstitutionalToPermissionedDomain = async (
  client: xrpl.Client,
  platformWallet: xrpl.Wallet,
  domainId: string
) => {
  const transaction: any = {
    TransactionType: 'PermissionedDomainSet',
    Account: platformWallet.classicAddress,
    DomainID: domainId,
    AcceptedCredentials: [
      { Credential: { Issuer: platformWallet.classicAddress, CredentialType: SCPO_BASIC_HEX } },
      { Credential: { Issuer: platformWallet.classicAddress, CredentialType: SCPO_VERIFIED_HEX } },
      { Credential: { Issuer: platformWallet.classicAddress, CredentialType: SCPO_INSTITUTIONAL_HEX } },
    ]
  };
  const tx = await submitQueued(transaction, platformWallet);
  const meta = tx.result.meta as any;
  if (meta.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`Domain update failed: ${meta.TransactionResult}`);
  }
  return { success: true, txHash: tx.result.hash };
};