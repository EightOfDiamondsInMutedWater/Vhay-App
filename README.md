# Vhay

**B2B procurement on the XRP Ledger** — purchase orders, escrow-backed settlement, permissioned credentials, and tokenized inventory in a single on-chain workflow.

🔗 **Live demo:** [vhay.app](https://vhay.app)

## What it is

Vhay turns the procure-to-pay cycle into native ledger instruments. A buyer issues a purchase order as a token, locks settlement into a conditional escrow, and the vendor claims payment on fulfillment — with both counterparties gated by verifiable credentials inside a permissioned domain. Purchase orders, inventory, identity, credentials, and settlement all live on the XRP Ledger; supporting documents are pinned to IPFS.

## How it works

- **Purchase orders as tokens.** Each PO is minted as a Multi-Purpose Token carrying its terms and delivered to the vendor by direct Payment.
- **Escrow-backed settlement.** The buyer locks payment — a USD-pegged trust-line token (currently a mainnet test stablecoin, RLUSD-ready) or XRP — into an escrow whose release is bound by a crypto-condition derived from the PO's token ID. Funds unlock to the vendor only against that fulfillment.
- **Permissioned counterparties.** Participants hold tiered credentials (Basic / Verified / Institutional) issued by the platform and are admitted to a permissioned domain; uncredentialed accounts can't transact.
- **On-ledger identity.** Each profile is anchored by a DID.
- **Supplier marketplace.** Buyers browse listed products across suppliers and raise a purchase order directly from a listing.
- **Tokenized inventory.** Vendors mint inventory as Multi-Purpose Tokens, custodied in a dedicated warehouse account kept separate from their transacting wallet.

## XRPL standards leveraged

| Capability | Standard |
|---|---|
| Tokenized POs & inventory (Multi-Purpose Tokens) | XLS-33 |
| On-ledger identity (DIDs) | XLS-40 |
| Verifiable credentials | XLS-70 |
| Permissioned domains | XLS-80 |
| Token escrow (issued-token settlement) | XLS-85 |

## Make Waves Challenge — Source Tag

On-chain activity is attributed via **XRPL Source Tag `2606160012`**, assigned by XRPL Commons for the Make Waves Challenge (T&Cs sections 5 and 7).

Every transaction the app submits carries this Source Tag. It is injected at the transaction-building chokepoint (`autofillTagged` in `src/utils/xrplHelpers.ts`) before signing, so it attaches to 100% of on-chain activity — PO creation, recall, and update; escrow create/finish; inventory minting and burns; MPT authorize/destroy; DID and credential operations; and platform fee payments.

## Tech stack

- **Frontend:** React + TypeScript single-page app
- **Ledger:** [xrpl.js](https://github.com/XRPLF/xrpl.js) against the XRP Ledger
- **Document storage:** IPFS, dual-pinned to Pinata and Filebase via a server-side endpoint
- **Backend:** two Vercel Functions (credential issuance, IPFS pinning) holding all server-side secrets; ledger transactions are signed and submitted client-side

## Deployment

Vhay runs as a static single-page app on Vercel, configured entirely through environment variables at build time. Two Vercel Functions handle credential issuance and IPFS pinning, keeping those credentials server-side and out of the client bundle. All XRP Ledger transactions are signed and submitted by the client.

## Status

**Live on XRPL Mainnet** at [vhay.app](https://vhay.app). Under active development.

## License

Released under the [PolyForm Shield License 1.0.0](./LICENSE). You may read, evaluate, and use this software for any purpose except to build a product that competes with Vhay.
