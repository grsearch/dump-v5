'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { FEATURE_NAMES } = require('./features');
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
function rawLogit(model, values) {
  return model.intercept + model.features.reduce((sum, name, i) => sum + model.weights[i] * ((values[name] - model.means[i]) / model.scales[i]), 0);
}
class Model {
  constructor(file, policyId) {
    this.status = 'no_model'; this.model = null; this.id = null;
    if (!file) return;
    try {
      if (fs.statSync(file).size > 1000000) throw new Error('oversized model');
      const text = fs.readFileSync(file, 'utf8'); const m = JSON.parse(text);
      if (m.schema !== 1 || JSON.stringify(m.features) !== JSON.stringify(FEATURE_NAMES) || m.policyId !== policyId
        || !['rebound_30s', 'rebound_60s', 'strategy_proxy'].includes(m.target)) throw new Error('schema mismatch');
      const n = FEATURE_NAMES.length;
      if (![m.means, m.scales, m.weights].every(a => Array.isArray(a) && a.length === n && a.every(Number.isFinite))
        || m.scales.some(x => x <= 0) || !Number.isFinite(m.intercept)
        || !Number.isFinite(m.calibration?.a) || !Number.isFinite(m.calibration?.b)) throw new Error('invalid parameters');
      this.id = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      const v = m.validation;
      if (!v?.passed || v.testCount < 100 || v.calibrationCount < 100 || !(v.trainEnd < v.calibrationStart && v.calibrationEnd < v.testStart)
        || !Number.isFinite(v.test?.brier) || !(v.test.brier < v.baseline?.brier) || !(v.test.ece <= 0.1)) {
        this.status = 'model_not_validated'; return;
      }
      this.model = m; this.status = 'experimental_calibrated_model';
    } catch (_) { this.status = 'invalid_or_incompatible_model'; }
  }
  predict(snapshot, at = Date.now()) {
    const base = { modelId: this.id, target: this.model?.target || null, probability: null, shadowOnly: true,
      scope: 'observed_swap_proxy_conditional_on_coverage' };
    if (!snapshot.ready) return { ...base, status: 'insufficient_prior_history' };
    if (!this.model) return { ...base, status: this.status };
    const m = this.model;
    if (Number.isFinite(m.evaluationAfter) && at <= m.evaluationAfter) return { ...base, status: 'before_forward_evaluation_window' };
    if (m.features.some((name, i) => !Number.isFinite(snapshot.values[name]) || Math.abs((snapshot.values[name] - m.means[i]) / m.scales[i]) > 8)) {
      return { ...base, status: 'out_of_training_range' };
    }
    return { ...base, status: this.status, probability: sigmoid(m.calibration.a * rawLogit(m, snapshot.values) + m.calibration.b) };
  }
}
module.exports = { Model, sigmoid, rawLogit };
