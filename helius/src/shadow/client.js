'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class ShadowClient {
  constructor(c, { workerFactory = (file, options) => new Worker(file, options) } = {}) {
    this.status = { status: 'disabled' }; this.enabled = !!c.shadow?.enabled;
    this.queue = []; this.inFlight = false; this.scheduled = false; this.dropped = 0; this.needsGap = false;
    this.accepting = true; this.exited = false; this.drain = null;
    if (!this.enabled) return;
    // Never serialize the wallet secret or the API URL/key into a learning event or workerData.
    const config = { ...c.shadow, sizeSol: c.sizeSol, takeProfit: c.takeProfit, stopLoss: c.stopLoss,
      trailArm: c.trailArm, trailDrop: c.trailDrop, maxHoldMs: c.maxHoldMs,
      minSellSol: c.minSellSol, minImpact: c.minImpact, maxImpact: c.maxImpact, minLiquidity: c.minLiquidity,
      maxSourceLagMs: c.maxSignalAgeMs + 1000,
      networkFeeSol: (5000 + c.priorityLamports + c.tipLamports) / 1e9 };
    try {
      this.worker = workerFactory(path.join(__dirname, 'worker.js'), { workerData: config,
        resourceLimits: { maxOldGenerationSizeMb: 256 }, env: {} });
      this.status = { status: 'starting' };
      this.worker.on('message', msg => {
        if (msg.type === 'ack') { this.inFlight = false; this.pump(); }
        if (msg.type === 'status') this.status = msg.value;
      });
      this.worker.on('error', () => { this.enabled = false; this.status = { status: 'worker_error' }; this.queue = []; });
      this.worker.on('exit', code => { this.exited = true; this.enabled = false; this.queue = []; this.status = { ...this.status, workerExitCode: code }; this.resolveClose?.(); });
      this.worker.unref();
    } catch (_) { this.enabled = false; this.status = { status: 'worker_unavailable' }; }
  }
  enqueue(message) {
    if (!this.enabled || !this.accepting) return;
    if (this.queue.length >= 4096) { this.dropped += this.queue.length; this.queue = []; this.needsGap = true; }
    this.queue.push(message);
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; this.pump(); }); }
  }
  pump() {
    if (!this.enabled || this.inFlight) return;
    if (!this.queue.length && !this.needsGap) { this.drain?.(); return; }
    const events = this.queue.splice(0, 128);
    if (this.needsGap) { events.unshift({ type: 'gap', reason: 'main_queue_overflow', at: Date.now() }); this.needsGap = false; }
    this.inFlight = true;
    try { this.worker.postMessage({ type: 'batch', events }); }
    catch (_) { this.enabled = false; this.status = { status: 'worker_send_error' }; }
  }
  observe(swap, candidate, fresh) { this.enqueue({ type: 'swap', swap: { ...swap }, candidate, fresh }); }
  connection(connected) { this.enqueue({ type: 'connection', connected, at: Date.now() }); }
  decision(swap, status, extra = {}) {
    this.enqueue({ type: 'decision', key: `${swap.signature}:${swap.pool}`, status, at: Date.now(), extra });
  }
  stats() { return { ...this.status, queueDepth: this.queue.length, dropped: this.dropped }; }
  async close() {
    this.accepting = false;
    if (!this.worker || this.exited) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.worker.terminate().finally(resolve); }, 4000);
      this.resolveClose = () => { clearTimeout(timer); resolve(); };
      this.drain = () => { this.drain = null; this.worker.postMessage({ type: 'close', at: Date.now() }); };
      if (this.enabled) this.pump(); else { clearTimeout(timer); this.worker.terminate().finally(resolve); }
    });
  }
}
module.exports = ShadowClient;
