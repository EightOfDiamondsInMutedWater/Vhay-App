# Vhay

**B2B procurement on the XRP Ledger** — purchase orders, escrow-backed settlement, permissioned credentials, and tokenized inventory in a single on-chain workflow.

🔗 **Live demo:** [vhay.app](https://vhay.app)

🎥 **Video demo:** [youtu.be/vTVqX0YAa2A](https://youtu.be/vTVqX0YAa2A)

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

Every transaction the app submits carries this Source Tag. It is injected at the transaction-building chokepoint (`autofillTagged` in `src/utils/xrplHelpers.ts`) before signing, so it attaches to 100% of on-chain activity — PO acceptance, funding, claim, recall, and update; escrow create/finish; inventory minting and burns; MPT authorize/destroy; DID and credential operations; and platform fee payments.

## Make Waves Challenge — Metrics summary

Measured 17 September 2026 from public XRPL mainnet data. Basis: tesSUCCESS transactions carrying Source Tag `2606160012`, deduplicated by transaction hash. Counting runs from the tag's first deployment (30 June 2026) rather than from the Mainnet Gate (15 July 2026), so a small number of pre-gate development transactions are included. Settlement volume is derived from on-chain memo payloads on escrow-lock events.

| Metric | Value |
| --- | --- |
| Transactions | 445 |
| Unique accounts | 8 |
| Settlement volume | 209.40 units of a project-issued demo USD token |
| Purchase orders | 27 (10 settled, 8 in flight) |
| Inventory items | 11, covering 60 units tokenized |
| Profile links | 9 |

Settlement volume is denominated in a mainnet-issued test stablecoin created by this project, not a market-priced asset. At least one purchase order has been settled end to end in native XRP.

Transaction mix: 144 Payment, 81 DIDSet, 66 AccountSet, 55 MPTokenIssuanceCreate, 26 MPTokenAuthorize, 16 EscrowCreate, 12 CredentialCreate, 11 NFTokenMint, 10 CredentialAccept, 10 EscrowFinish, 7 MPTokenIssuanceDestroy, 3 TrustSet, 2 PermissionedDomainSet, 2 CredentialDelete.

**RLUSD:** Ripple's mainnet RLUSD issuer returns `allowTrustLineLocking: false`, so RLUSD cannot currently be escrowed by any party. Vhay escrows issued tokens and is a small change away when that flag is enabled.

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
