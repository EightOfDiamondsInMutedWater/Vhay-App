// Phase 6 feature toggles for the demo. The code stays in the repo (roadmap visible to
// judges) — these flags only control whether each feature's UI entry point is reachable.
export const FEATURES = {
  // Active in the demo:
  poCreation: true,
  escrowLockClaim: true,
  credentialing: true,
  inventory: true,
  inviteOnly: true,
  // ▼▼▼ MARKETPLACE ▼▼▼ Task 5.2 Tier 3 — dark-launched; flip to true when the tab ships
  marketplace: false,
  // ▲▲▲ MARKETPLACE ▲▲▲
  // Phase 6 — gated off for the demo:
  escrowYield: false,
  poFinancing: false,
  inventoryFinancing: false,
} as const;

export const COMING_SOON_LABEL = 'Advanced Feature Coming Soon';
