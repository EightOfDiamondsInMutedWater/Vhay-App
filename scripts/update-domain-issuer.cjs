// Adds the dedicated issuer to the Vhay Permissioned Domain for SCPO_BASIC only.
// MODIFIES the existing domain via DomainID — it does NOT create a new one.
// ⚠ COMPANY_SEED here means the DOMAIN OWNER seed (raqWMfK3…), NOT the Vercel
//   COMPANY_SEED, which holds the dedicated issuer. The guard below aborts on a
//   mismatch before connecting.
// ⚠ Never pass the seed on the command line — it lands in shell history. Use:
//   read -rs COMPANY_SEED
//   export COMPANY_SEED
//   node scripts/update-domain-issuer.cjs
//   unset COMPANY_SEED
const xrpl = require("xrpl");
const OWNER = "raqWMfK3FcPVXd5Q468WgthvpvorEmCJV3";
const DOMAIN_ID = "5749AA20543F13F0F219846561FA6F9D2E28BDEF6675D073DB9128F2B39BC959";
const NEW_ISSUER = "rhUaQmNPjsX52773rzFeApXA6vpjgiLkPJ";
const BASIC = "5343504F5F4241534943";
const VERIFIED = "5343504F5F564552494649";
const INST = "5343504F5F494E5354";
const SOURCE_TAG = 2606160012;
const seed = process.env.COMPANY_SEED;
if (!seed) { console.error("ABORT: set COMPANY_SEED"); process.exit(2); }
let wallet;
try { wallet = xrpl.Wallet.fromSeed(seed); } catch (e) { console.error("ABORT: seed will not decode"); process.exit(2); }
if (wallet.classicAddress !== OWNER) { console.error("ABORT: seed is " + wallet.classicAddress + ", not the domain owner"); process.exit(1); }
console.log("guard    = PASS " + wallet.classicAddress);
(async () => {
  const c = new xrpl.Client(process.env.XRPL_ENDPOINT || "wss://xrplcluster.com");
  await c.connect();
  const tx = {
    TransactionType: "PermissionedDomainSet",
    Account: OWNER,
    DomainID: DOMAIN_ID,
    SourceTag: SOURCE_TAG,
    AcceptedCredentials: [
      { Credential: { Issuer: OWNER, CredentialType: BASIC } },
      { Credential: { Issuer: OWNER, CredentialType: VERIFIED } },
      { Credential: { Issuer: OWNER, CredentialType: INST } },
      { Credential: { Issuer: NEW_ISSUER, CredentialType: BASIC } }
    ]
  };
  const r = await c.submitAndWait(await c.autofill(tx), { wallet });
  console.log("result   = " + r.result.meta.TransactionResult);
  console.log("hash     = " + r.result.hash);
  const created = r.result.meta.AffectedNodes.find(n => n.CreatedNode && n.CreatedNode.LedgerEntryType === "PermissionedDomain");
  console.log(created ? "WARNING  = CREATED A NEW DOMAIN " + created.CreatedNode.LedgerIndex : "modified = existing domain, no new object created");
  await c.disconnect();
})();
