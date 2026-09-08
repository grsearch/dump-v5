'use strict';
const { exitReason } = require('../strategy');
// Discontinuous research only. Never produces training labels or normal exit_comparison results.
class Recovery {
  constructor(c, emit, quote) { this.c = c; this.emit = emit; this.quote = quote; this.active = new Map(); this.byPool = new Map(); this.counts = { started: 0, completed: 0, expired: 0, capacity: 0 }; }
  write(r, fields, at) { this.emit({ type: 'no_stop_recovery', recoveryVersion: 1, id: r.id, key: r.key, at,
    selection: r.selection, entryAt: r.entry.at, entryCostSol: r.entry.cost, coverage: 'discontinuous',
    gapReason: r.gapReason, gapAt: r.gapAt, deadlineAt: r.deadlineAt, firstQuoteAt: r.firstQuoteAt,
    minObservedNetPct: r.min, maxObservedNetPct: r.max, ...fields }); }
  add(s, reason, at) {
    const a = s.exitComparisons?.find(a => a.name === 'no_fixed_stop');
    if (!s.entry || !a || a.done || this.active.has(s.id)) return;
    const r = { id: s.id, key: s.key, selection: s.selection, pool: s.source.pool, entry: { ...s.entry },
      position: { ...a.position }, pending: a.pending && { ...a.pending }, gapReason: reason, gapAt: at,
      deadlineAt: s.entry.at + this.c.maxHoldMs, firstQuoteAt: null, min: null, max: null, lastSignature: s.last?.signature, lastSlot: s.last?.slot ?? s.entry.slot, lastAt: at };
    if (at > r.deadlineAt + this.c.exitDelayMs + this.c.maxGapMs) return;
    if (this.active.size >= this.c.maxActive || (this.byPool.get(r.pool)?.size || 0) >= this.c.maxActivePerPool) {
      this.counts.capacity++; this.write(r, { phase: 'finished', status: 'unknown', reason: 'recovery_capacity', netPnlSol: null }, at); return;
    }
    this.active.set(r.id, r); if (!this.byPool.has(r.pool)) this.byPool.set(r.pool, new Set()); this.byPool.get(r.pool).add(r.id);
    this.counts.started++; this.write(r, { phase: 'started', status: 'pending', netPnlSol: null }, at);
  }
  finish(r, fields, at) { this.write(r, { phase: 'finished', ...fields }, at); this.active.delete(r.id);
    const ids = this.byPool.get(r.pool); ids.delete(r.id); if (!ids.size) this.byPool.delete(r.pool); }
  observe(swap, at) {
    for (const id of [...(this.byPool.get(swap.pool) || [])]) {
      const r = this.active.get(id); if ((swap.signature && swap.signature === r.lastSignature) || at < r.lastAt || swap.slot < r.lastSlot) continue;
      if (at > r.deadlineAt + this.c.exitDelayMs + this.c.maxGapMs) { this.expire(r, at); continue; }
      const net = this.quote(swap, r.entry.amount, this.c); if (!Number.isFinite(net)) continue;
      r.lastSignature = swap.signature; r.lastAt = at; r.lastSlot = swap.slot; const pnl = (net / r.entry.cost - 1) * 100;
      r.min = r.min === null ? pnl : Math.min(r.min, pnl); r.max = r.max === null ? pnl : Math.max(r.max, pnl);
      if (r.firstQuoteAt === null) { r.firstQuoteAt = at; this.write(r, { phase: 'first_quote', status: 'quote_only', quoteNetSol: net, sinceGapMs: at - r.gapAt }, at); }
      if (!r.pending && at >= r.deadlineAt) r.pending = { reason: 'max_hold', at: r.deadlineAt, dueAt: r.deadlineAt + this.c.exitDelayMs };
      if (r.pending && at >= r.pending.dueAt) {
        this.counts.completed++; this.finish(r, { status: 'discontinuous_proxy', reason: r.pending.reason,
          netPnlSol: net - r.entry.cost, exitAt: at, triggerAt: r.pending.at, netPnlPct: pnl }, at);
      } else if (!r.pending) {
        r.position.high = Math.max(r.position.high, swap.price);
        const reason = exitReason(r.position, swap.price, { ...this.c, stopLoss: Infinity }, at);
        if (reason) r.pending = { reason, at, dueAt: at + this.c.exitDelayMs };
      }
    }
  }
  expire(r, at) { this.counts.expired++; this.finish(r, { status: 'unknown', reason: 'no_exit_quote_by_deadline', netPnlSol: null }, at); }
  tick(at) { for (const r of [...this.active.values()]) if (at > r.deadlineAt + this.c.exitDelayMs + this.c.maxGapMs) this.expire(r, at); }
  close(reason, at) { for (const r of [...this.active.values()]) this.finish(r, { status: 'unknown', reason, netPnlSol: null }, at); }
  stats() { return { ...this.counts, active: this.active.size }; }
}
module.exports = { Recovery };
