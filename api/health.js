// Temporary probe endpoint. DELETE before the repo goes public.
// Purpose: prove api/ routing works alongside react-app-rewired, and
// measure the real function timeout ceiling on Vercel Pro.
module.exports = async (req, res) => {
  const started = Date.now();
  const raw = parseInt((req.query && req.query.sleep) || '0', 10);
  const sleepMs = Math.min(Math.max(isNaN(raw) ? 0 : raw, 0), 120000);
  if (sleepMs > 0) {
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  res.status(200).json({
    ok: true,
    node: process.version,
    region: process.env.VERCEL_REGION || 'local',
    env: process.env.VERCEL_ENV || 'local',
    requestedSleepMs: sleepMs,
    actualElapsedMs: Date.now() - started,
    seedPresent: typeof process.env.COMPANY_SEED === 'string' && process.env.COMPANY_SEED.length > 0,
  });
};
