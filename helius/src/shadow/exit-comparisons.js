'use strict';
const { exitReason } = require('../strategy');
// Fixed research arms. They share the baseline entry and never submit orders.
const ARMS = [{ name: 'exit_250ms', delay: 250 }, { name: 'exit_1000ms', delay: 1000 }, { name: 'net_take5', netTake: 5 }];
class ExitComparisons {
  constructor(c, emit) { this.c = c; this.emit = emit; }
  states(s) {
    return s.exitComparisons ||= ARMS.map(a => ({ ...a, position: { ...s.entry }, pending: null, done: false }));
  }
  write(s, a, fields, at) {
    a.done = true;
    this.emit({ type: 'exit_comparison', comparisonVersion: 1, id: s.id, key: s.key, at,
      variant: a.name, assumptions: { exitDelayMs: a.delay ?? this.c.exitDelayMs, netTakePct: a.netTake ?? null,
        sameEntryAsBaseline: true, baselinePolicy: 'envelope_policyId', maxHoldMs: this.c.maxHoldMs }, ...fields });
  }
  observe(s, swap, net, at) {
    const pnl = (net / s.entry.cost - 1) * 100;
    for (const a of this.states(s)) {
      if (a.done) continue;
      if (a.pending && at >= a.pending.dueAt) {
        this.write(s, a, { status: 'observed_proxy', reason: a.pending.reason, netPnlSol: net - s.entry.cost,
          netPnlPct: pnl, entryAt: s.entry.at, exitAt: at, triggerAt: a.pending.at,
          actualExitDelayMs: at - a.pending.at }, at);
      } else if (!a.pending) {
        a.position.high = Math.max(a.position.high, swap.price);
        const reason = a.netTake && pnl >= a.netTake ? 'net_take_profit' : exitReason(a.position, swap.price, this.c, at);
        if (reason) a.pending = { reason, at, dueAt: at + (a.delay ?? this.c.exitDelayMs) };
      }
    }
  }
  tick(s, at) {
    if (!s.entry) return;
    for (const a of this.states(s)) if (!a.done && !a.pending && at - s.entry.at >= this.c.maxHoldMs)
      a.pending = { reason: 'max_hold', at, dueAt: at + (a.delay ?? this.c.exitDelayMs) };
  }
  censor(s, reason, at) {
    for (const a of s.exitComparisons || ARMS.map(a => ({ ...a, done: false })))
      if (!a.done) this.write(s, a, { status: 'censored', reason, netPnlSol: null }, at);
  }
  done(s) { return !!s.exitComparisons && s.exitComparisons.every(a => a.done); }
}
module.exports = { ExitComparisons, ARMS };
