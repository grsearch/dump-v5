'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { train, loadDataset } = require('../src/shadow/training');
const { Model, score } = require('../src/shadow/model');
const { FEATURE_NAMES } = require('../src/shadow/features');
const { ExitComparisons } = require('../src/shadow/exit-comparisons');
function rows() { return Array.from({ length: 1000 }, (_, i) => ({ at: i * 120000, endAt: i * 120000 + 60000, y: i % 2,
  values: Object.fromEntries(FEATURE_NAMES.map(k => [k, k === 'sellSol' ? i % 2 : 0])) })); }
test('holdout range rejection matches runtime and cannot pass with too few scored samples', () => {
  const rs = rows(); for (let i = 850; i < 1000; i++) rs[i].values.sellSol = 10000;
  const r = train(rs, 'loss_25', 'p');
  assert.equal(r.model, null); assert.equal(r.report.status, 'insufficient_scored_data');
  assert.equal(r.report.coverage.testRejected, 150); assert.equal(r.report.coverage.testScored, 50);
});
test('return regression uses net return units, shared score and future-only observation', () => {
  const rs = rows().map(r => ({ ...r, y: r.y ? 0.1 : -0.4 })), r = train(rs, 'net_return', 'p');
  assert.ok(r.model.validation.passed); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'return-model-')), file = path.join(dir, 'model.json');
  fs.writeFileSync(file, JSON.stringify(r.model)); const model = new Model(file, 'p');
  const p = model.predict({ ready: true, values: rs[1].values }, r.model.evaluationAfter + 1);
  assert.equal(p.probability, null); assert.equal(p.expectedNetReturn, score(r.model, rs[1].values)); assert.ok(Math.abs(p.expectedNetReturn - 0.1) < 0.02);
  assert.equal(model.predict({ ready: true, values: rs[1].values }, r.model.evaluationAfter).status, 'before_forward_evaluation_window');
});
test('risk and return labels require known net costs; censored and legacy amounts are not fabricated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-data-')), records = [];
  for (let i = 0; i < 4; i++) {
    records.push({ type: 'sample', schema: 1, id: String(i), key: String(i), policyId: 'p', at: i * 1000, sequence: 2, decisionFresh: true,
      features: { ready: true, lastHistorySequence: 1, values: rows()[0].values } });
    records.push({ type: 'outcome', id: String(i), target: 'strategy_proxy', policyId: 'p', at: i * 1000 + 500,
      status: i === 2 ? 'censored' : 'observed_proxy', label: 0, ...(i === 3 ? {} : { netPnlSol: i === 0 ? -0.5 : -0.2, entryCostSol: 2 }) });
  }
  fs.writeFileSync(path.join(dir, 'samples-test.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual((await loadDataset(dir, 'loss_25', 'p')).rows.map(r => r.y), [1, 0]);
  assert.deepEqual((await loadDataset(dir, 'net_return', 'p')).rows.map(r => r.y), [-0.25, -0.1]);
});
test('exit arms await observed delayed ticks, retain unknown gaps and never mutate baseline entry', () => {
  const events = [], c = { exitDelayMs: 500, takeProfit: 20, stopLoss: 25, trailArm: 10, trailDrop: 3, maxHoldMs: 30000 };
  const comparisons = new ExitComparisons(c, r => events.push(r)), sample = { id: 'a', key: 'a', entry: { cost: 1, amount: 1, at: 0, openedAt: 0, high: 1, entryPrice: 1 } };
  comparisons.observe(sample, { price: 1.3 }, 1.25, 1000);
  assert.equal(events.length, 0); assert.equal(sample.entry.high, 1);
  comparisons.observe(sample, { price: 1.1 }, 1.05, 1249); assert.equal(events.length, 0);
  comparisons.observe(sample, { price: 0.9 }, 0.85, 1250); assert.equal(events.length, 1);
  assert.equal(events[0].variant, 'exit_250ms'); assert.ok(Math.abs(events[0].netPnlSol + 0.15) < 1e-9);
  comparisons.censor(sample, 'pool_observation_gap', 1300);
  assert.equal(events.length, 3); assert.equal(events.filter(r => r.status === 'censored').length, 2);
  assert.ok(events.filter(r => r.status === 'censored').every(r => r.netPnlSol === null));
});
