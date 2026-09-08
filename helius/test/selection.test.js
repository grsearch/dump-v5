'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selection } = require('../src/shadow/selection');
const { selectionValidation } = require('../src/reporting/selection-validation');
const market = { experimentId: 'e', belowMaxSell: true, avoidPriorSellPressure: true };
const predictions = { loss25: { modelId: 'risk', target: 'loss_25', status: 'experimental_calibrated_model', probability: .2 },
  netReturn: { modelId: 'net', target: 'net_return', status: 'experimental_calibrated_model', expectedNetReturn: .02 } };
test('fixed selection distinguishes absent models, strict boundaries and explicit rejection', () => {
  assert.equal(selection(market, {}, true).arms.combined.status, 'unknown');
  assert.equal(selection(market, predictions, true).arms.combined.status, 'pass');
  const p = structuredClone(predictions); p.loss25.probability = .25;
  assert.equal(selection(market, p, true).arms.risk.status, 'reject');
  p.loss25.probability = .2; p.netReturn.expectedNetReturn = 0;
  assert.equal(selection(market, p, true).arms.net.status, 'reject');
  assert.equal(selection({ ...market, belowMaxSell: false }, {}, true).arms.combined.status, 'reject');
  assert.equal(selection(market, predictions, false).arms.baseline.status, 'reject');
});
test('validation isolates runs and model versions; missing outcomes never become profitable zeros', () => {
  const samples = new Map(), outcomes = new Map();
  for (let i = 0; i < 5; i++) {
    const se = selection(i === 1 ? { ...market, belowMaxSell: false } : market, predictions, true);
    if (i === 4) se.modelIds.net = 'other';
    const s = { id: String(i), key: String(i), runId: i === 3 ? 'new-run' : 'run', runStartedAt: 0, at: 1000, policyId: 'p', selection: se };
    samples.set(s.id, s);
    if (i !== 2) outcomes.set(`${s.id}:strategy_proxy`, { policyId: 'p', at: 2000, status: 'observed_proxy', netPnlSol: i === 1 ? -.5 : .1, entryCostSol: 1 });
  }
  const r = selectionValidation(samples, outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  assert.equal(r.groups.length, 3); const b = r.groups[0].arms.combined;
  assert.equal(b.selectedKnown, 1); assert.equal(b.selectedPending, 1); assert.equal(b.selectedMissingRate, .5);
  assert.equal(b.pairedCandidates, 2); assert.equal(b.filteredPairedSol, .1); assert.equal(b.baselinePairedSol, -.4); assert.equal(b.pairedDifferenceSol, .5);
  assert.equal(r.groups[0].arms.baseline.severeLossRate, .5);
});
test('validation excludes old-window candidates and conflicting duplicate chain keys', () => {
  const s = { id: 'a', key: 'chain', runId: 'r', at: 1000, policyId: 'p', selection: selection(market, predictions, true) };
  const samples = new Map([['a', s], ['b', { ...s, id: 'b', selection: selection(market, {}, true) }], ['old', { ...s, id: 'old', key: 'old', at: -1 }]]);
  const r = selectionValidation(samples, new Map(), { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  assert.equal(r.conflicts, 1); assert.equal(r.groups.length, 0);
});
