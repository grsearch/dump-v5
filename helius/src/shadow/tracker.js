'use strict';
const crypto = require('node:crypto');
const { Features } = require('./features');
const { Model } = require('./model');
const { exitReason } = require('../strategy');

function assumptions(c) {
  return { version: 1, sizeSol: c.sizeSol, takeProfit: c.takeProfit, stopLoss: c.stopLoss, trailArm: c.trailArm,
    trailDrop: c.trailDrop, maxHoldMs: c.maxHoldMs, entryDelayMs: c.entryDelayMs, entryDeadlineMs: c.entryDeadlineMs,
    exitDelayMs: c.exitDelayMs, feeBps: c.feeBps, slippageBps: c.slippageBps, networkFeeSol: c.networkFeeSol,
    reboundPct: c.reboundPct, maxGapMs: c.maxGapMs, horizons: [30000, 60000],
    candidateFilter: { minSellSol: c.minSellSol, minImpact: c.minImpact, maxImpact: c.maxImpact, minLiquidity: c.minLiquidity } };
}
function policyId(policy) { return crypto.createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16); }
function buyQuote(s, c) {
  const x = Number(s.postBase), y = Number(s.postQuote) / 1e9 + Number(s.virtual || '0') / 1e9;
  const input = c.sizeSol * (1 - c.feeBps / 10000);
  const amount = Math.floor(x * input / (y + input) * (1 - c.slippageBps / 10000));
  return x > 0 && y > 0 && Number.isSafeInteger(amount) && amount > 0 ? { amount, cost: c.sizeSol + c.networkFeeSol } : null;
}
function liquidation(s, amount, c) {
  const x = Number(s.postBase), realQuote = Number(s.postQuote) / 1e9, effective = realQuote + Number(s.virtual || '0') / 1e9;
  const out = effective * amount / (x + amount) * (1 - c.feeBps / 10000) * (1 - c.slippageBps / 10000);
  if (!(x > 0 && effective > 0 && out >= 0 && out <= realQuote)) return null;
  return out - c.networkFeeSol;
}
class Tracker {
  constructor(c, write, { runId = crypto.randomUUID(), now = Date.now } = {}) {
    this.c = c; this.write = write; this.runId = runId; this.now = now;
    this.policy = assumptions(c); this.policyId = policyId(this.policy);
    this.features = new Features(c); this.model = new Model(c.modelFile, this.policyId);
    this.active = new Map(); this.byPool = new Map(); this.lastOrder = new Map(); this.seen = new Map();
    this.sequence = 0; this.connected = false; this.lastGlobalAt = 0; this.samples = 0; this.outcomes = 0; this.censored = 0;
    this.write({ type: 'session', schema: 1, runId, at: this.now(), policy: this.policy, policyId: this.policyId,
      modelStatus: this.model.status, source: 'processed_pumpswap_swaps', observationalOnly: true });
  }
  emit(record) { this.write({ schema: 1, runId: this.runId, policyId: this.policyId, ...record }); }
  connection(connected, at) {
    if (!connected) this.gap('stream_disconnected', at);
    else { this.connected = true; this.lastGlobalAt = at; this.emit({ type: 'connection', connected, at }); }
  }
  gap(reason, at = this.now()) {
    for (const sample of [...this.active.values()]) this.finishIncomplete(sample, reason, at);
    this.features.reset(); this.lastOrder.clear(); this.connected = false;
    this.emit({ type: 'coverage_gap', reason, at });
  }
  onSwap(s, candidate, fresh, at = s.receivedAt) {
    this.sequence++;
    const key = `${s.signature}:${s.pool}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, at); if (this.seen.size > 100000) this.seen.delete(this.seen.keys().next().value);
    if (this.lastGlobalAt && (at - this.lastGlobalAt > this.c.maxGapMs || at < this.lastGlobalAt)) {
      this.gap(at < this.lastGlobalAt ? 'clock_moved_backwards' : 'global_delivery_gap', at); this.connected = true;
    }
    this.lastGlobalAt = at;
    if (!Number.isFinite(s.eventTime) || at - s.eventTime > this.c.maxSourceLagMs || s.eventTime > at + 2000) {
      for (const id of [...(this.byPool.get(s.pool) || [])]) this.finishIncomplete(this.active.get(id), 'stale_source_observation', at);
      this.features.invalidate(s.pool);
      if (candidate) this.emit({ type: 'excluded_candidate', key, at, reason: 'stale_source_observation' });
      return;
    }
    const previous = this.lastOrder.get(s.pool);
    if (previous && s.slot < previous.slot) {
      if (candidate) this.emit({ type: 'excluded_candidate', key, at, reason: 'out_of_order_slot' });
      return;
    }
    this.lastOrder.delete(s.pool); this.lastOrder.set(s.pool, { slot: s.slot, at });
    if (this.lastOrder.size > this.c.maxPools) this.lastOrder.delete(this.lastOrder.keys().next().value);
    // One pool observation per swap, shared by overlapping samples; no additional RPC.
    if (candidate || this.byPool.has(s.pool)) this.emit({ type: 'pool_observation', key, at, pool: s.pool, mint: s.mint,
      signature: s.signature, slot: s.slot, side: s.side, eventTime: s.eventTime, price: s.price,
      postBase: s.postBase, postQuote: s.postQuote, virtual: s.virtual, quoteSol: s.quoteSol, sellSol: s.sellSol });
    // Older candidates see this event as a future observation; the new candidate snapshot excludes it.
    for (const id of [...(this.byPool.get(s.pool) || [])]) {
      const sample = this.active.get(id); if (sample) this.observe(sample, s, at);
    }
    if (candidate) {
      const id = `${this.runId}:${key}`, snapshot = this.features.snapshot(s, at);
      const sample = { id, key, at, source: { signature: s.signature, pool: s.pool, mint: s.mint, slot: s.slot },
        features: snapshot, prediction: this.model.predict(snapshot), lastAt: at, last: s, entry: null,
        horizons: { rebound_30s: { ms: 30000, hit: false, maxNetPct: null, minNetPct: null },
          rebound_60s: { ms: 60000, hit: false, maxNetPct: null, minNetPct: null } }, strategyDone: false, exitPending: null };
      this.samples++;
      this.emit({ type: 'sample', id, key, at, source: sample.source, sequence: this.sequence,
        features: snapshot, prediction: sample.prediction, decisionFresh: fresh, policy: this.policy });
      if (!fresh || !this.connected) this.finishIncomplete(sample, !fresh ? 'stale_candidate' : 'stream_not_continuous', at);
      else if (this.active.size >= this.c.maxActive) this.finishIncomplete(sample, 'active_capacity', at);
      else if ((this.byPool.get(s.pool)?.size || 0) >= this.c.maxActivePerPool) this.finishIncomplete(sample, 'pool_active_capacity', at);
      else {
        this.active.set(id, sample);
        if (!this.byPool.has(s.pool)) this.byPool.set(s.pool, new Set());
        this.byPool.get(s.pool).add(id);
      }
    }
    this.features.add(s, at, this.sequence);
  }
  label(sample, target, fields, at) {
    this.outcomes++; if (fields.status === 'censored') this.censored++;
    this.emit({ type: 'outcome', id: sample.id, key: sample.key, target, at, ...fields });
  }
  finishIncomplete(sample, reason, at) {
    for (const [name, h] of Object.entries(sample.horizons)) {
      if (!h.done) { h.done = true; this.label(sample, name, { status: 'censored', label: null, reason }, at); }
    }
    if (!sample.strategyDone) { sample.strategyDone = true; this.label(sample, 'strategy_proxy', { status: 'censored', label: null, reason }, at); }
    this.remove(sample);
  }
  remove(sample) {
    this.active.delete(sample.id); const set = this.byPool.get(sample.source.pool);
    set?.delete(sample.id); if (!set?.size) this.byPool.delete(sample.source.pool);
  }
  observe(sample, s, at) {
    if (at < sample.lastAt) return;
    if (at - sample.lastAt > this.c.maxGapMs) { this.finishIncomplete(sample, 'pool_observation_gap', at); return; }
    if (!sample.entry) {
      if (at > sample.at + this.c.entryDeadlineMs) { this.finishIncomplete(sample, 'no_timely_entry_observation', at); return; }
      if (at < sample.at + this.c.entryDelayMs) { sample.lastAt = at; sample.last = s; return; }
      const quote = buyQuote(s, this.c);
      if (!quote) { this.finishIncomplete(sample, 'unquotable_entry', at); return; }
      sample.entry = { ...quote, at, slot: s.slot, entryPrice: quote.cost / quote.amount, openedAt: at, high: quote.cost / quote.amount };
      this.emit({ type: 'proxy_entry', id: sample.id, at, slot: s.slot, amount: String(quote.amount), costSol: quote.cost,
        actualEntryDelayMs: at - sample.at });
    }
    const net = liquidation(s, sample.entry.amount, this.c);
    if (net === null) { this.finishIncomplete(sample, 'unquotable_exit', at); return; }
    const pnl = (net / sample.entry.cost - 1) * 100;
    for (const [target, h] of Object.entries(sample.horizons)) {
      if (h.done) continue;
      // Never allow a tick received after the horizon to become its successful rebound.
      if (at <= sample.at + h.ms) {
        h.maxNetPct = h.maxNetPct === null ? pnl : Math.max(h.maxNetPct, pnl);
        h.minNetPct = h.minNetPct === null ? pnl : Math.min(h.minNetPct, pnl);
        if (pnl >= this.c.reboundPct) h.hit = true;
      }
      if (at >= sample.at + h.ms) {
        h.done = true;
        this.label(sample, target, { status: 'observed_proxy', label: h.hit ? 1 : 0, maxNetPct: h.maxNetPct,
          minNetPct: h.minNetPct, entryAt: sample.entry.at, observationEnd: at }, at);
      }
    }
    if (!sample.strategyDone) {
      if (sample.exitPending && at >= sample.exitPending.dueAt) {
        sample.strategyDone = true;
        this.label(sample, 'strategy_proxy', { status: 'observed_proxy', label: pnl > 0 ? 1 : 0, netPnlPct: pnl,
          entryAt: sample.entry.at, exitAt: at, reason: sample.exitPending.reason,
          actualExitDelayMs: at - sample.exitPending.triggerAt }, at);
      } else if (!sample.exitPending) {
        sample.entry.high = Math.max(sample.entry.high, s.price);
        const reason = exitReason(sample.entry, s.price, this.c, at);
        if (reason) sample.exitPending = { reason, triggerAt: at, dueAt: at + this.c.exitDelayMs };
      }
    }
    sample.last = s; sample.lastAt = at;
    if (sample.strategyDone && Object.values(sample.horizons).every(h => h.done)) this.remove(sample);
  }
  tick(at) {
    for (const sample of [...this.active.values()]) {
      if (!sample.entry && at > sample.at + this.c.entryDeadlineMs) this.finishIncomplete(sample, 'no_timely_entry_observation', at);
      else if (at - sample.lastAt > this.c.maxGapMs) this.finishIncomplete(sample, 'pool_observation_gap', at);
      else if (sample.entry && !sample.strategyDone && !sample.exitPending && at - sample.entry.at >= this.c.maxHoldMs) {
        sample.exitPending = { reason: 'max_hold', triggerAt: at, dueAt: at + this.c.exitDelayMs };
      }
    }
  }
  decision(key, status, at, extra = {}) { this.emit({ type: 'decision', key, status, at, ...extra }); }
  stats() { return { samples: this.samples, outcomes: this.outcomes, censored: this.censored, active: this.active.size,
    historyPools: this.features.pools.size, historyEvents: this.features.total, historyEvictions: this.features.evictions, model: this.model.status }; }
}
module.exports = { Tracker, assumptions, policyId, buyQuote, liquidation };
