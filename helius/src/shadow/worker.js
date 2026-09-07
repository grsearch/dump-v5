'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parentPort, workerData: config } = require('node:worker_threads');
const { Tracker } = require('./tracker');

const runId = crypto.randomUUID();
fs.mkdirSync(config.directory, { recursive: true });
const name = `samples-${new Date().toISOString().replace(/[:.]/g, '-')}-${runId}.jsonl`;
const fd = fs.openSync(path.join(config.directory, name), 'wx', 0o600);
let lines = [], bytes = 0, closing = false;
function flush() {
  if (!lines.length) return;
  const data = lines.join(''); lines = []; bytes = 0;
  fs.writeFileSync(fd, data); fs.fsyncSync(fd);
}
function write(record) {
  const line = JSON.stringify(record) + '\n'; lines.push(line); bytes += Buffer.byteLength(line);
  if (bytes >= 1024 * 1024) flush();
}
const tracker = new Tracker(config, write, { runId });
function publish(status = 'running') { parentPort.postMessage({ type: 'status', value: { status, ...tracker.stats(), file: name } }); }
const timer = setInterval(() => { tracker.tick(Date.now()); flush(); publish(); }, 1000);
parentPort.on('message', msg => {
  if (closing) return;
  if (msg.type === 'close') {
    closing = true; clearInterval(timer); tracker.gap('process_shutdown', msg.at); flush(); fs.closeSync(fd); publish('closed'); parentPort.close(); return;
  }
  if (msg.type !== 'batch') return;
  for (const event of msg.events) {
    if (event.type === 'swap') tracker.onSwap(event.swap, event.candidate, event.fresh);
    if (event.type === 'connection') tracker.connection(event.connected, event.at);
    if (event.type === 'gap') { tracker.gap(event.reason, event.at); tracker.connection(true, event.at); }
    if (event.type === 'decision') tracker.decision(event.key, event.status, event.at, event.extra);
  }
  // A delayed queue may conservatively censor samples; it must never invent coverage.
  parentPort.postMessage({ type: 'ack' });
});
publish();
