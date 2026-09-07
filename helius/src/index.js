'use strict';
const { readConfig } = require('./config');
const Store = require('./store');
const Executor = require('./executor');
const Stream = require('./stream');
const { Engine } = require('./engine');
const ShadowClient = require('./shadow/client');
const { publicConfig } = require('./reporting/archive');

async function main() {
  const config = readConfig();
  const executor = new Executor(config);
  const store = new Store(config.stateFile, config.dryRun ? 'paper' : 'live', executor.wallet?.publicKey.toBase58() || 'paper');
  executor.store = store;
  const stream = new Stream(config, store);
  const shadow = new ShadowClient(config);
  const engine = new Engine(config, store, executor, stream, shadow);
  store.log('starting', { mode: config.dryRun ? 'paper' : 'live', minSellSol: config.minSellSol, closeAfterMs: config.closeAfterMs,
    strategyConfig: publicConfig(config) });
  try {
    await executor.start();
    await engine.reconcile();
  } catch (err) {
    engine.error('startup', err); executor.stop(); await shadow.close(); store.close(); throw err;
  }
  stream.on('transaction', tx => engine.onTransaction(tx));
  stream.on('connection', connected => shadow.connection(connected));
  stream.start();
  const tick = setInterval(() => engine.tick(), 1000);
  const report = setInterval(() => engine.report(), 60000);
  let shuttingDown = false;
  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true; engine.stopped = true; stream.stop(); executor.stop(); clearInterval(tick); clearInterval(report);
    // Let any signed transaction finish journaling before releasing the process lock.
    const deadline = Date.now() + 25000;
    while ((engine.busy || engine.ticking || engine.reconciling) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    await shadow.close(); engine.report(); store.close(); process.exit(0);
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
main().catch(() => { console.error('Startup failed. Check Helius configuration, wallet, dependency versions and state lock; secrets omitted.'); process.exitCode = 1; });
