import * as xrpl from 'xrpl';

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