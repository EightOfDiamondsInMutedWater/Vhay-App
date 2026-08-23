// Temporary probe. DELETE with this branch.
// Measures XRPL connect + read latency from a Vercel function.
// READ-ONLY: no signing, no submission, no seed use.
const xrpl = require('xrpl');

module.exports = async (req, res) => {
  const t0 = Date.now();
  const marks = {};
  let client;
  try {
    client = new xrpl.Client('wss://xrplcluster.com', { connectionTimeout: 20000 });
    await client.connect();
    marks.connectMs = Date.now() - t0;

    const t1 = Date.now();
    const si = await client.request({ command: 'server_info' });
    marks.serverInfoMs = Date.now() - t1;

    const t2 = Date.now();
    const ai = await client.request({
      command: 'account_info',
      account: 'raqWMfK3FcPVXd5Q468WgthvpvorEmCJV3',
      ledger_index: 'validated',
    });
    marks.accountInfoMs = Date.now() - t2;

    const t3 = Date.now();
    await client.disconnect();
    marks.disconnectMs = Date.now() - t3;

    res.status(200).json({
      ok: true,
      region: process.env.VERCEL_REGION || 'local',
      totalMs: Date.now() - t0,
      ...marks,
      ledgerIndex: si.result.info.validated_ledger.seq,
      ownerCount: ai.result.account_data.OwnerCount,
      xrplVersion: require('xrpl/package.json').version,
    });
  } catch (err) {
    try { if (client && client.isConnected()) await client.disconnect(); } catch {}
    res.status(500).json({ ok: false, totalMs: Date.now() - t0, ...marks, error: String(err && err.message) });
  }
};
