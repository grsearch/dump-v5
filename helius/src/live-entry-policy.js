'use strict';
function reason(c, data, swap, now = Date.now()) {
  if (c.dryRun || !c.liveEntryPolicy) return null;
  if (!Number.isFinite(swap.liquidity)) return 'live_reserve_unknown';
  if (swap.liquidity <= c.liveEntryPolicy.reserveExclusiveSol) return 'live_reserve_at_most_100_sol';
  if ((data.lossCooldowns?.[swap.mint] || 0) > now) return 'live_loss_cooldown';
  return null;
}
function recordLoss(c, data, receipt) {
  if (c.dryRun || !c.liveEntryPolicy || receipt?.side !== 'sell' || receipt.status !== 'confirmed'
    || !Number.isFinite(receipt.netPnlSol) || receipt.netPnlSol >= 0 || !Number.isFinite(receipt.receiptObservedAt)) return;
  data.lossCooldowns ||= {};
  data.lossCooldowns[receipt.mint] = Math.max(data.lossCooldowns[receipt.mint] || 0,
    receipt.receiptObservedAt + c.liveEntryPolicy.lossCooldownMs);
}
function migrateCooldown(c, store, now = Date.now()) {
  if (c.dryRun || !c.liveEntryPolicy) return;
  const data = store.data, previousMs = data.lossCooldownDurationMs ?? 600000, durationMs = c.liveEntryPolicy.lossCooldownMs;
  if (previousMs === durationMs) return;
  let changed = 0;
  for (const [mint, until] of Object.entries(data.lossCooldowns || {})) {
    if (!Number.isFinite(until)) continue;
    const adjusted = Math.min(until, until - previousMs + durationMs);
    if (adjusted <= now) delete data.lossCooldowns[mint]; else data.lossCooldowns[mint] = adjusted;
    if (adjusted !== until) changed++;
  }
  data.lossCooldownDurationMs = durationMs; store.save();
  if (changed) store.log('live_loss_cooldown_migrated', { previousMs, durationMs, changed });
}
module.exports = { reason, recordLoss, migrateCooldown };
