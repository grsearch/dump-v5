'use strict';
const HISTORY = new Set(['priorBuy', 'priorReturn', 'consecutivePressure', 'priorBuyBurst']);
function historyUnavailable(arm) {
  return !arm || !['pass', 'unknown', 'reject'].includes(arm.status)
    || (arm.status === 'unknown' && (!Array.isArray(arm.unknown) || !arm.unknown.length))
    || (arm.unknown || []).some(x => HISTORY.has(x.check));
}
class EntryGuard {
  constructor(swap) { this.swap = swap; this.rejected = null; }
  observe(s) {
    if (s.pool !== this.swap.pool || s.mint !== this.swap.mint || s.slot < this.swap.slot || s.receivedAt < this.swap.receivedAt) return;
    this.check(s.price, 'stream', s.slot);
  }
  check(price, source, slot) {
    if (this.rejected) return this.rejected;
    if (!(Number.isFinite(price) && price > 0 && Number.isFinite(this.swap.price) && this.swap.price > 0)) {
      this.rejected = { reason: 'pre_send_price_unavailable', source }; return this.rejected;
    }
    const dropPct = (1 - price / this.swap.price) * 100;
    if (dropPct >= 20 - 1e-10) this.rejected = { reason: 'pre_send_further_drop_20pct', source, slot, dropPct, price, signalPrice: this.swap.price };
    return this.rejected;
  }
}
module.exports = { historyUnavailable, EntryGuard };
