# Vhay

**B2B procurement on the XRP Ledger** — purchase orders, escrow-backed settlement, permissioned credentials, and tokenized inventory in a single on-chain workflow.

🔗 **Live demo:** [vhay.app](https://vhay.app)

## What it is

Vhay turns the procure-to-pay cycle into native ledger instruments. A buyer issues a purchase order as a token, locks settlement into a conditional escrow, and the vendor claims payment on fulfillment — with both counterparties gated by verifiable credentials inside a permissioned domain. Purchase orders, inventory, identity, credentials, and settlement all live on the XRP Ledger; supporting documents are pinned to IPFS.

## How it works

- **Purchase orders as tokens.** Each PO is minted as a Multi-Purpose Token carrying its terms and delivered to the vendor by direct Payment.
- **Escrow-backed settlement.** The buyer locks payment — a USD-pegged trust-line token (RLUSD or a demo stablecoin) or XRP — into an escrow whose release is bound by a crypto-condition derived from the PO's token ID. Funds unlock to the vendor only against that fulfillment.
- **Permissioned counterparties.** Participants hold tiered credentials (Basic / Verified / Institutional) issued by the platform and are admitted to a permissioned domain; uncredentialed accounts can't transact.
- **On-ledger identity.** Each profile is anchored by a DID.
- **Tokenized inventory.** Vendors mint inventory as Multi-Purpose Tokens, custodied in a dedicated warehouse account kept separate from their transacting wallet.

## XRPL standards leveraged

| Capability | Standard |
|---|---|
| Tokenized POs & inventory (Multi-Purpose Tokens) | XLS-33 |
| On-ledger identity (DIDs) | XLS-40 |
| Verifiable credentials | XLS-70 |
| Permissioned domains | XLS-80 |
| Token escrow (issued-token settlement) | XLS-85 |

## Tech stack

- **Frontend:** React + TypeScript single-page app
- **Ledger:** [xrpl.js](https://github.com/XRPLF/xrpl.js) against the XRP Ledger (devnet for development, mainnet for production)
- **Document storage:** IPFS via Pinata / Filebase
- No application backend — the client interacts with the ledger directly

## Quickstart

```bash
git clone https://github.com/EightOfDiamondsInMutedWater/SC.PO_MVP_11.25.25.git
cd SC.PO_MVP_11.25.25
npm install
cp .env.example .env    # fill in your values — use devnet for local development
npm start
```

### Environment variables

Create a `.env` (never commit it). Variable names:

```
REACT_APP_XRPL_NODES=           # XRPL endpoint, e.g. wss://s.devnet.rippletest.net:51233
REACT_APP_COMPANY_WALLET=       # platform/company wallet address (r...)
REACT_APP_COMPANY_SEED=         # platform wallet seed — DEVNET throwaway for local dev only
REACT_APP_RLUSD_ISSUER=         # settlement-token issuer address (r...)
REACT_APP_DOMAIN_ID=            # permissioned domain ID
REACT_APP_PINATA_API_KEY=       # Pinata IPFS key
REACT_APP_FILEBASE_RPC_TOKEN=   # Filebase token
REACT_APP_FILEBASE_BUCKET=      # Filebase bucket
```

> Use devnet, throwaway values for local development. Never commit real seeds or API keys.

## Status

Active development. Currently running on XRPL devnet; mainnet deployment in progress.

## License

Released under the [MIT License](./LICENSE).


