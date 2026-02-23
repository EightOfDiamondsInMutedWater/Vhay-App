import * as xrpl from 'xrpl';

// Constants — Credential tier hex values
export const SCPO_BASIC_HEX = '5343504F5F4241534943'; // hex("SCPO_BASIC")
export const SCPO_VERIFIED_HEX = '5343504F5F564552494649'; // hex("SCPO_VERIFIED")
export const SCPO_INSTITUTIONAL_HEX = '5343504F5F494E5354'; // hex("SCPO_INSTITUTIONAL")

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
    Account: platformWallet.address,
    AcceptedCredentials: [
      {
        Credential: {
          Issuer: platformWallet.address,
          CredentialType: SCPO_BASIC_HEX
        }
      }
    ]
  };

 const tx = await client.submitAndWait(transaction as any, {
    autofill: true,
    wallet: platformWallet
  });

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
    Account: platformWallet.address,
    Subject: subjectAddress,
    CredentialType: credentialType,
    Expiration: expirationTime
  };

  const tx = await client.submitAndWait(transaction as any, {
    autofill: true,
    wallet: platformWallet
  });

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

  const tx = await client.submitAndWait(transaction as any, {
    autofill: true,
    wallet: userWallet
  });

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
    Account: platformWallet.address,
    Subject: subjectAddress,
    CredentialType: credentialType
  };

  const tx = await client.submitAndWait(transaction as any, {
    autofill: true,
    wallet: platformWallet
  });

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
      if (cred.Issuer === platformWallet.address && cred.CredentialType === credentialType) {
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
            await acceptCredential(client, userWallet, platformWallet.address, credentialType);
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
  await acceptCredential(client, userWallet, platformWallet.address, credentialType);
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

let xrplClient: xrpl.Client | null = null;
let connectingPromise: Promise<xrpl.Client> | null = null;

export const getXRPLClient = async (): Promise<xrpl.Client> => {
  if (xrplClient?.isConnected()) return xrplClient;
  if (!connectingPromise) {
    connectingPromise = (async () => {
      const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233', { connectionTimeout: 20000 });
      await client.connect();
      xrplClient = client;
      connectingPromise = null;
      return client;
    })();
  }
  return connectingPromise;
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

export const getEscrowsForPO = async (buyerAddress: string, issuanceId: string) => {
  const client = await getXRPLClient();
  const escrows = await getMyEscrows(buyerAddress);
  return escrows.filter((escrow: any) => {
    const memo = escrow.Memos?.[0]?.Memo?.MemoData || '';
    return memo.includes(issuanceId);
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

    const result = await client.submitAndWait(trustSetTx as any, {
      autofill: true,
      wallet: userWallet
    });

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