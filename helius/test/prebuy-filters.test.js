'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selection } = require('../src/shadow/selection');
const { selectionValidation } = require('../src/reporting/selection-validation');
const { recoveryAudit } = require('../src/reporting/recovery-audit');
const snapshot = () => ({ ready: true, values: { buyFraction15: .2, buySol15: 2, sellSol15: 8, return60Pct: -20, trades60: 10, sellSol: 39.99, consecutiveSells: 2, buySol5: 1, sellSol5: 2 } });
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

test('unknown history policy arms distinguish explicit history rejection from risk rejection', () => {
  const s = snapshot(); s.ready = false;
  const unknown = select(s);
  assert.equal(unknown.arms.prebuyAllowUnknown.status, 'pass');
  assert.equal(unknown.arms.prebuyRequireKnown.status, 'reject');
  assert.equal(unknown.arms.prebuyUnknownOnly.status, 'pass');
  assert.equal(unknown.arms.prebuyCombined.status, 'unknown');
  s.values.sellSol = 40;
  const risk = select(s);
  for (const name of ['prebuyAllowUnknown', 'prebuyRequireKnown', 'prebuyUnknownOnly']) assert.equal(risk.arms[name].status, 'reject');
  const good = select(snapshot());
  assert.equal(good.arms.prebuyRequireKnown.status, 'pass');
  assert.equal(good.arms.prebuyUnknownOnly.status, 'reject');
  assert.equal(selection({}, {}, false, null, s).arms.prebuyAllowUnknown.status, 'reject');
});

test('strict history comparison exports the missed outcome without turning missing labels into losses', () => {
  const s = snapshot(); s.ready = false;
  const sample = { id: 'a', key: 'a', at: 1000, runId: 'r', policyId: 'p', selection: select(s) };
  const outcomes = new Map([['a:strategy_proxy', { at: 2000, status: 'observed_proxy', policyId: 'p', netPnlSol: -.4, entryCostSol: 1 }]]);
  const report = selectionValidation(new Map([['a', sample]]), outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() });
  const g = report.groups[0];
  assert.equal(g.arms.prebuyAllowUnknown.selectedNetSol, -.4);
  assert.equal(g.arms.prebuyRequireKnown.pairedDifferenceSol, .4);
  assert.equal(g.arms.prebuyRequireKnown.selectedNetSol, null);
  assert.equal(g.reboundBySelection.prebuyUnknownOnly.unknown, 1);
});

test('consecutive sell pressure rejects only the joint condition and preserves legacy observation', () => {
  const s = snapshot(); s.values.consecutiveSells = 3;
  let result = select(s);
  assert.equal(result.version, 5);
  assert.equal(result.arms.prebuyCombined.status, 'reject');
  assert.equal(result.arms.prebuyLegacy.status, 'pass');
  assert.equal(result.arms.prebuyCombined.rejected[0].check, 'consecutivePressure');
  s.values.sellSol5 = s.values.buySol5;
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
  s.values.sellSol5 = 2; s.values.consecutiveSells = 2;
  assert.equal(select(s).arms.prebuyCombined.status, 'pass');
});
test('missing or invalid pressure history stays unknown, never a dangerous zero', () => {
  for (const values of [{ consecutiveSells: undefined }, { consecutiveSells: -1 }, { consecutiveSells: 3.5 }, { buySol5: NaN }, { sellSol5: -1 }]) {
    const s = snapshot(); Object.assign(s.values, values);
    assert.equal(select(s).arms.prebuyCombined.status, 'unknown');
    assert.equal(select(s).arms.prebuyAllowUnknown.status, 'pass');
    s.values.sellSol = 40;
    assert.equal(select(s).arms.prebuyCombined.status, 'reject');
  }
});
test('blocked pressure samples retain counterfactual losses in export and replay uses current rules', () => {
  const { eligible } = require('../scripts/replay-entry-research');
  const s = snapshot(); s.values.consecutiveSells = 3;
  assert.equal(eligible({ decisionFresh: true, features: s }), false);
  const sample = { id: 'pressure', at: 1000, runId: 'r', policyId: 'p', selection: select(s) };
  const outcomes = new Map([['pressure:strategy_proxy', { at: 2000, status: 'observed_proxy', policyId: 'p', netPnlSol: -.4, entryCostSol: 1 }]]);
  const g = selectionValidation(new Map([['pressure', sample]]), outcomes, { start: new Date(0).toISOString(), endExclusive: new Date(3000).toISOString() }).groups[0];
  assert.equal(g.arms.prebuyLegacy.selectedNetSol, -.4);
  assert.equal(g.arms.prebuyCombined.pairedDifferenceSol, .4);
  s.values.consecutiveSells = 2;
  assert.equal(eligible({ decisionFresh: true, features: s }), true);
});
