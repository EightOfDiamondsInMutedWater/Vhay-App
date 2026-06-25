# Environment Configuration

Single source of truth for every `REACT_APP_*` variable across environments.
All `REACT_APP_*` vars are compiled into the public JS bundle at build time — they are
**not** secret. Anything truly secret must never be a `REACT_APP_*` var (see Option A below).

| Variable | Purpose | Local (devnet) | Hosted devnet (current) | Hosted mainnet (flip target) |
|---|---|---|---|---|
| `REACT_APP_XRPL_NODES` | XRPL endpoint(s), comma-separated | `wss://s.devnet.rippletest.net:51233` | same (devnet) | `wss://xrplcluster.com` |
| `REACT_APP_COMPANY_WALLET` | Platform/company wallet **address** (fees, domain owner) — public | devnet `r4RYRV…` | same | mainnet `raqWMfK3FcPVXd5Q468WgthvpvorEmCJV3` |
| `REACT_APP_COMPANY_SEED` | Company signing **seed** | devnet seed (local only) | devnet seed | **NOT SET — Option A: seed never deployed to mainnet** |
| `REACT_APP_RLUSD_ISSUER` | Demo USD token issuer address | devnet issuer | same | mainnet `rBdRWMcSyWMPpk5HfYq9HBzw92wxKFpx2v` |
| `REACT_APP_DOMAIN_ID` | Permissioned Domain ID | devnet domain | same | mainnet `5749AA20543F13F0F219846561FA6F9D2E28BDEF6675D073DB9128F2B39BC959` |
| `REACT_APP_ADMIN_PASSWORD` | Admin-panel login (NOT the seed) | your local value | your value | a distinct production value |
| `REACT_APP_PINATA_API_KEY` | Pinata IPFS pinning | set | set | same (or prod key) |
| `REACT_APP_FILEBASE_RPC_TOKEN` | Filebase IPFS auth | set | set | same (or prod token) |
| `REACT_APP_FILEBASE_BUCKET` | Filebase bucket (IPFS) | set | set | same |

## Mainnet flip checklist (Task 3.5 → hosted flip)
In **Vercel → Project → Settings → Environment Variables (Production)**, set the mainnet column above, then redeploy. Critical points:
1. **`REACT_APP_XRPL_NODES` → `wss://xrplcluster.com`.** This is the switch that makes the app mainnet. If unset, code falls back to **devnet** (`xrplHelpers.ts:280`) — the app would silently stay on devnet. Must be set explicitly.
2. **Do NOT set `REACT_APP_COMPANY_SEED`** (Option A). Demo wallets are pre-credentialed on-chain; admin actions run locally via `scripts/*`. The app guards every company-signing path to skip when the seed is absent.
3. `REACT_APP_COMPANY_WALLET`, `REACT_APP_RLUSD_ISSUER`, `REACT_APP_DOMAIN_ID` → the mainnet values above (from Tasks 2.4 / 3.1).
4. `REACT_APP_ADMIN_PASSWORD` → a production value (not the seed, not the devnet value).
5. CRA bakes env vars at **build** time → any change requires a **redeploy** to take effect.
6. Explorer links auto-switch to `livenet.xrpl.org` once `REACT_APP_XRPL_NODES` is mainnet (no code change).

## Security note
`REACT_APP_COMPANY_SEED` and `REACT_APP_ADMIN_PASSWORD` ship in the bundle when set. The seed is therefore **never** set on mainnet (Option A). The admin password is low-stakes (the panel can't sign without the seed) but should still differ from devnet. True server-side signing/auth (serverless `/api/issue-credential`) is deferred to Task 5+ (Option B) for live onboarding.
