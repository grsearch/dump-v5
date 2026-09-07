'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { FEATURE_NAMES } = require('./features');
const { sigmoid, rawLogit } = require('./model');

async function loadDataset(directory, target, wantedPolicy) {
  const files = fs.readdirSync(directory).filter(n => /^samples-.*\.jsonl$/.test(n)).sort();
  const eligible = [], stats = { files: files.length, invalidFiles: 0, samples: 0, immatureOrCensored: 0, insufficientHistory: 0, duplicates: 0, conflicts: 0 };
  for (const name of files) {
    const rows = new Map(); let invalid = false;
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(directory, name)), crlfDelay: Infinity });
    for await (const line of lines) {
      let r;
      try { r = JSON.parse(line); } catch (_) { invalid = true; continue; }
      if (r.type === 'sample' && r.schema === 1) {
        stats.samples++;
        if (!r.features?.ready || !r.decisionFresh) { stats.insufficientHistory++; continue; }
        if (!(r.features.lastHistorySequence < r.sequence) || !Number.isFinite(r.at)
          || !FEATURE_NAMES.every(k => Number.isFinite(r.features.values[k]))) { invalid = true; continue; }
        rows.set(r.id, { id: r.id, key: r.key, at: r.at, mint: r.source?.mint, pool: r.source?.pool, policyId: r.policyId, values: r.features.values });
      }
      if (r.type === 'outcome' && r.target === target && rows.has(r.id)) {
        const row = rows.get(r.id);
        if (r.status === 'observed_proxy' && [0, 1].includes(r.label) && Number.isFinite(r.at) && r.at >= row.at && r.policyId === row.policyId) {
          const minEnd = target === 'rebound_30s' ? row.at + 30000 : target === 'rebound_60s' ? row.at + 60000 : row.at;
          if (r.at < minEnd || row.y !== undefined) { invalid = true; continue; }
          Object.assign(row, { y: r.label, endAt: r.at });
        }
      }
      if (rows.size + eligible.length > 100000) throw new Error('Dataset exceeds 100000 rows; select a smaller date range');
    }
    if (invalid) { stats.invalidFiles++; continue; } // Including a crash-truncated final line: conservative whole-file exclusion.
    for (const row of rows.values()) {
      if (row.y === undefined) stats.immatureOrCensored++;
      else eligible.push(row);
    }
  }
  eligible.sort((a, b) => a.at - b.at);
  const selectedPolicy = wantedPolicy || eligible.at(-1)?.policyId || null;
  const unique = new Map(), conflicts = new Set();
  for (const row of eligible.filter(x => x.policyId === selectedPolicy)) {
    if (unique.has(row.key)) {
      stats.duplicates++;
      if (unique.get(row.key).y !== row.y) { conflicts.add(row.key); stats.conflicts++; }
    } else unique.set(row.key, row);
  }
  const rows = [...unique.values()].filter(r => !conflicts.has(r.key));
  return { rows, policyId: selectedPolicy, stats: { ...stats, eligible: rows.length } };
}
function chronologicalSplit(rows) {
  if (rows.length < 5) return { train: [], calibration: [], test: [], purged: rows.length };
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const calStart = sorted[Math.floor(sorted.length * 0.6)].at, testStart = sorted[Math.floor(sorted.length * 0.8)].at;
  const train = sorted.filter(r => r.at < calStart && r.endAt < calStart);
  const calibration = sorted.filter(r => r.at >= calStart && r.at < testStart && r.endAt < testStart);
  const test = sorted.filter(r => r.at >= testStart);
  return { train, calibration, test, calStart, testStart, purged: rows.length - train.length - calibration.length - test.length };
}
function fitLogistic(xs, ys, iterations = 500) {
  const dimensions = xs[0].length, w = Array(dimensions).fill(0);
  const prior = Math.max(0.001, Math.min(0.999, ys.reduce((a, b) => a + b, 0) / ys.length));
  let intercept = Math.log(prior / (1 - prior));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const grad = Array(dimensions).fill(0); let offset = 0;
    for (let i = 0; i < xs.length; i++) {
      const error = sigmoid(intercept + xs[i].reduce((sum, x, k) => sum + x * w[k], 0)) - ys[i];
      offset += error;
      for (let k = 0; k < dimensions; k++) grad[k] += error * xs[i][k];
    }
    intercept -= 0.05 * offset / xs.length;
    for (let k = 0; k < dimensions; k++) w[k] -= 0.05 * (grad[k] / xs.length + 0.001 * w[k]);
  }
  return { weights: w, intercept };
}
function metrics(probabilities, ys) {
  if (!ys.length) return null;
  let brier = 0, logLoss = 0, correct = 0;
  const bins = Array.from({ length: 5 }, () => ({ count: 0, probabilitySum: 0, positives: 0 }));
  for (let i = 0; i < ys.length; i++) {
    const p = Math.max(1e-9, Math.min(1 - 1e-9, probabilities[i])), y = ys[i];
    brier += (p - y) ** 2; logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p); correct += (p >= 0.5 ? 1 : 0) === y ? 1 : 0;
    const b = bins[Math.min(4, Math.floor(p * 5))]; b.count++; b.probabilitySum += p; b.positives += y;
  }
  let ece = 0;
  const reliability = bins.map((b, i) => {
    if (!b.count) return { lower: i / 5, upper: (i + 1) / 5, count: 0 };
    const observed = b.positives / b.count, predicted = b.probabilitySum / b.count;
    ece += b.count / ys.length * Math.abs(observed - predicted);
    const z = 1.96, denominator = 1 + z * z / b.count;
    const centre = (observed + z * z / (2 * b.count)) / denominator;
    const width = z * Math.sqrt(observed * (1 - observed) / b.count + z * z / (4 * b.count * b.count)) / denominator;
    return { lower: i / 5, upper: (i + 1) / 5, count: b.count, predicted, observed, empirical95Interval: [centre - width, centre + width] };
  });
  return { count: ys.length, brier: brier / ys.length, logLoss: logLoss / ys.length, accuracy: correct / ys.length, ece, reliability };
}
function train(rows, target, policyId) {
  const split = chronologicalSplit(rows), groups = [split.train, split.calibration, split.test];
  const enough = groups.every((g, i) => g.length >= (i === 0 ? 300 : 100) && g.filter(r => r.y === 1).length >= 20 && g.filter(r => r.y === 0).length >= 20);
  const counts = { train: split.train.length, calibration: split.calibration.length, test: split.test.length, purged: split.purged };
  if (!enough) return { model: null, report: { status: 'insufficient_data', counts, requirement: 'train>=300, calibration>=100, test>=100; each split >=20 per class, after overlap purge' } };
  const means = FEATURE_NAMES.map(k => split.train.reduce((a, r) => a + r.values[k], 0) / split.train.length);
  const scales = FEATURE_NAMES.map((k, i) => Math.sqrt(split.train.reduce((a, r) => a + (r.values[k] - means[i]) ** 2, 0) / split.train.length) || 1);
  const x = split.train.map(r => FEATURE_NAMES.map((k, i) => (r.values[k] - means[i]) / scales[i]));
  const fitted = fitLogistic(x, split.train.map(r => r.y));
  const model = { schema: 1, target, policyId, features: FEATURE_NAMES, means, scales, ...fitted };
  const logits = split.calibration.map(r => rawLogit(model, r.values));
  const mean = logits.reduce((a, b) => a + b, 0) / logits.length;
  const scale = Math.sqrt(logits.reduce((a, b) => a + (b - mean) ** 2, 0) / logits.length) || 1;
  const cal = fitLogistic(logits.map(v => [(v - mean) / scale]), split.calibration.map(r => r.y));
  model.calibration = { a: Math.max(0, cal.weights[0] / scale), b: cal.intercept - Math.max(0, cal.weights[0] / scale) * mean };
  const p = split.test.map(r => sigmoid(model.calibration.a * rawLogit(model, r.values) + model.calibration.b));
  const tested = metrics(p, split.test.map(r => r.y));
  const baselineRate = split.calibration.reduce((sum, r) => sum + r.y, 0) / split.calibration.length;
  const baseline = metrics(split.test.map(() => baselineRate), split.test.map(r => r.y));
  const passed = tested.brier < baseline.brier && tested.ece <= 0.1;
  model.validation = { passed, testCount: split.test.length, calibrationCount: split.calibration.length, test: tested, baseline,
    trainEnd: Math.max(...split.train.map(r => r.endAt)), calibrationStart: split.calStart,
    calibrationEnd: Math.max(...split.calibration.map(r => r.endAt)), testStart: split.testStart };
  model.createdAt = new Date().toISOString(); model.labelMeaning = 'Observed-swap counterfactual proxy, not live trade success';
  model.evaluationAfter = Math.max(...rows.map(r => r.endAt));
  const trainingMints = new Set([...split.train, ...split.calibration].map(r => r.mint));
  const unseen = split.test.map((r, i) => ({ r, p: p[i] })).filter(x => !trainingMints.has(x.r.mint));
  return { model, report: { status: passed ? 'experimental_validation_passed' : 'validation_failed', counts,
    validation: model.validation, unseenMintTest: metrics(unseen.map(x => x.p), unseen.map(x => x.r.y)),
    warning: 'One historical holdout is not proof of live profitability. Never select thresholds on this test set and report them as new validation.' } };
}
module.exports = { loadDataset, chronologicalSplit, fitLogistic, metrics, train };
