# SC.PO - Smart Contract Purchase Order on XRPL

MVP for creating NFT-backed purchase orders with conditional escrow on the XRP Ledger.

### Goal
Create shared PO tokens for inventory distributors, suppliers, and manufacturers using XRPL escrow and NFTs — supporting real-world assets.

### Features
- Buyer locks funds in conditional escrow
- PO details uploaded to IPFS
- NFT minted as shared PO token
- Free offer to vendor (0 XRP)
- Vendor claims escrow with fulfillment code
- Vendor accepts NFT to own the PO token

### How to Run
1. Clone repo
2. `npm install`
3. Add Pinata API key to `.env` file: `REACT_APP_PINATA_API_KEY=your_key`
4. `npm start`
5. Fund buyer wallet on Testnet faucet
6. Fill fields → Make SC.PO Token
7. Vendor pastes OfferIndex → Accept NFT

### Testnet
Use https://xrpl.org/xrp-testnet-faucet.html to fund wallets.

### Next Features
- Multi-line items
- Display PO details from IPFS in nice table
- Vendor approval workflow

Made by EightOfDiamondsInMutedWater — open for review and contributions!

<img width="1858" height="1336" alt="image" src="https://github.com/user-attachments/assets/b6101702-3c21-48d3-98b6-e708791a3bb7" />
<img width="1754" height="1080" alt="image" src="https://github.com/user-attachments/assets/1282f45f-38e4-40ca-bde5-9ed434f93a52" />
