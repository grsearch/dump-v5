'use strict';
const crypto = require('node:crypto');
// Predeclared research thresholds, never optimized on the evaluation window.
const RULES = Object.freeze({ version: 1, maxLoss25Probability: 0.25, minExpectedNetReturn: 0 });
const ID = crypto.createHash('sha256').update(JSON.stringify(RULES)).digest('hex').slice(0, 16);
function selection(experiments, predictions, fresh) {
  const risk = predictions?.loss25, net = predictions?.netReturn;
  const riskKnown = risk?.status === 'experimental_calibrated_model' && risk.target === 'loss_25' && risk.modelId
    && Number.isFinite(risk.probability) && risk.probability >= 0 && risk.probability <= 1;
  const netKnown = net?.status === 'experimental_calibrated_model' && net.target === 'net_return' && net.modelId && Number.isFinite(net.expectedNetReturn);
  const checks = {
    fresh: { pass: !!fresh, reason: fresh ? 'fresh' : 'stale_candidate' },
    size: { pass: experiments.belowMaxSell, reason: 'sell_size_limit' },
    flow: { pass: experiments.avoidPriorSellPressure, reason: 'prior_sell_pressure_or_unknown_history' },
    risk: { pass: riskKnown ? risk.probability < RULES.maxLoss25Probability : null, reason: riskKnown ? 'loss25_probability_limit' : risk?.status || 'missing_risk_prediction' },
    net: { pass: netKnown ? net.expectedNetReturn > RULES.minExpectedNetReturn : null, reason: netKnown ? 'expected_net_return_not_positive' : net?.status || 'missing_return_prediction' },
  };
  const arms = {};
  for (const [name, keys] of Object.entries({ baseline: ['fresh'], market: ['fresh', 'size', 'flow'], risk: ['fresh', 'risk'], net: ['fresh', 'net'], combined: ['fresh', 'size', 'flow', 'risk', 'net'] })) {
    const rejected = keys.filter(k => checks[k].pass === false), unknown = keys.filter(k => checks[k].pass !== true && checks[k].pass !== false);
    arms[name] = { status: rejected.length ? 'reject' : unknown.length ? 'unknown' : 'pass',
      rejected: rejected.map(k => ({ check: k, reason: checks[k].reason })), unknown: unknown.map(k => ({ check: k, reason: checks[k].reason })) };
  }
  return { version: 1, selectionId: ID, rules: RULES, marketExperimentId: experiments.experimentId,
    modelIds: { risk: risk?.modelId || null, net: net?.modelId || null }, scope: 'observation_only_candidate_filter', checks, arms };
}
module.exports = { selection };
