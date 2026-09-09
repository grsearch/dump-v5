'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selection } = require('../src/shadow/selection');
const { selectionValidation } = require('../src/reporting/selection-validation');
const { recoveryAudit } = require('../src/reporting/recovery-audit');
const snapshot = () => ({ ready: true, values: { buyFraction15: .2, buySol15: 2, sellSol15: 8, return60Pct: -20, trades60: 10, sellSol: 39.99 } });
const select = s => selection({}, {}, true, null, s);
test('prebuy filters use fixed boundaries and do not depend on models', () => {
  const s = snapshot(), before = JSON.stringify(s);
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
  assert.equal(JSON.stringify(s), before);
  s.values.buyFraction15 = .199; assert.equal(select(s).arms.avoidWeakBuy.status, 'reject');
  s.values.buyFraction15 = .2; s.values.return60Pct = -20.01;
  assert.equal(select(s).arms.avoidPriorFall.status, 'reject');
  s.values.return60Pct = -20; s.values.sellSol = 40;
  assert.equal(select(s).arms.avoidLargeDump.status, 'reject');
  assert.equal(select(s).arms.prebuyCombined.status, 'reject');
});
test('missing history and no prior trades remain unknown, not fabricated passes', () => {
  const s = snapshot(); s.ready = false;
  assert.equal(select(s).arms.avoidWeakBuy.status, 'unknown');
  assert.equal(select(s).arms.avoidPriorFall.status, 'unknown');
  s.ready = true; s.values.buySol15 = s.values.sellSol15 = 0; s.values.trades60 = 1;
  assert.equal(select(s).arms.prebuyCombined.status, 'unknown');
  assert.equal(select().arms.avoidLargeDump.status, 'unknown');
});
test('new selection groups reach export and independent recovery without inventing missing returns', () => {
  const se = select(snapshot()), sample = { id: 'a', key: 'a', at: 1000, policyId: 'p', runId: 'r', selection: se };
  const result = selectionValidation(new Map([['a', sample]]), new Map(), { start: new Date(0).toISOString(), endExclusive: new Date(2000).toISOString() });
  assert.equal(result.legacySamples, 0);
  assert.equal(result.groups[0].arms.prebuyCombined.selectedPending, 1);
  assert.equal(result.groups[0].arms.prebuyCombined.selectedNetSol, null);
  const audit = recoveryAudit(new Map([['a', { ...sample, type: 'state_exit_recovery', variant: 'no_fixed_stop', phase: 'finished', status: 'unknown', reason: 'no_exit_quote_by_deadline' }]]), new Map());
  assert.equal(audit.groups[0].prebuyCombined.unknown, 1);
  assert.equal(audit.groups[0].prebuyCombined.estimatedNetSol, undefined);
});
