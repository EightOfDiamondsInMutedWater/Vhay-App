// Lists every credential issued by the given addresses. Read-only, no seed.
//   node scripts/list-credentials.cjs rISSUER1 rISSUER2
const xrpl = require("xrpl");
const args = process.argv.slice(2);
if (!args.length) { console.error("usage: node scripts/list-credentials.cjs <issuer> [issuer2...]"); process.exit(2); }
const hex = h => { try { return Buffer.from(h, "hex").toString("utf8"); } catch { return h; } };
const when = r => r ? new Date((r + 946684800) * 1000).toISOString().slice(0, 10) : "none";
(async () => {
  const c = new xrpl.Client(process.env.XRPL_ENDPOINT || "wss://xrplcluster.com");
  await c.connect();
  for (const a of args) {
    console.log("\n=== issuer " + a + " ===");
    let info;
    try { info = await c.request({ command: "account_info", account: a, ledger_index: "validated" }); }
    catch (e) { console.log("  NOT FUNDED or not found"); continue; }
    console.log("  balance=" + info.result.account_data.Balance + " drops  ownerCount=" + info.result.account_data.OwnerCount);
    const o = await c.request({ command: "account_objects", account: a, ledger_index: "validated" });
    const creds = (o.result.account_objects || []).filter(v => v.LedgerEntryType === "Credential");
    console.log("  credentials=" + creds.length);
    creds.forEach(v => {
      const acc = ((v.Flags || 0) & 65536) !== 0;
      console.log("   subject=" + v.Subject + " type=" + hex(v.CredentialType) + " accepted=" + acc + " expires=" + when(v.Expiration));
    });
  }
  await c.disconnect();
})();
