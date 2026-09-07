'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { digest } = require('../src/reporting/archive');
const { FEATURE_NAMES } = require('../src/shadow/features');
const { chronologicalSplit } = require('../src/shadow/training');
async function inspect(directory) {
  const file = path.join(directory, 'analysis.jsonl.gz'), summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
  if (await digest(file) !== summary.sha256 || fs.statSync(file).size !== summary.bytes) throw new Error('Archive checksum/size mismatch');
  const counts = {}, samples = new Map(), outcomes = new Map(); let lines = 0, bytes = 0, first = null, footer = null;
  const audit = { windowCounts: {}, coverageGapReasons: {}, featureReasons: {}, policies: {}, paper: { closed: 0, wins: 0, losses: 0, flat: 0, missingPnl: 0, grossPnlSol: 0 }, shadowHealth: { observations: 0, maxQueueDepth: 0, maxDroppedPerSession: 0, maxHistoryEvictionsPerSession: 0 } };
  const closes = new Set(), delays = [];
  const inc = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
  const input = fs.createReadStream(file), unzip = zlib.createGunzip();
  input.on('error', e => unzip.destroy(e)); input.pipe(unzip);
  unzip.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024 * 1024) unzip.destroy(new Error('Inspection limit: 1 GiB uncompressed')); });
  try {
    for await (const line of readline.createInterface({ input: unzip, crlfDelay: Infinity })) {
      const row = JSON.parse(line), r = row.record; if (!r || !row.dataset) throw new Error('Invalid archive row');
      lines++; counts[`${row.dataset}:${r.type || ''}`] = (counts[`${row.dataset}:${r.type || ''}`] || 0) + 1;
      if (row.dataset === 'manifest') first = r;
      if (row.dataset === 'summary') footer = r;
      const at = r.at ?? Date.parse(r.time), inside = at >= Date.parse(summary.window.start) && at < Date.parse(summary.window.endExclusive);
      if (inside) {
        inc(audit.windowCounts, `${row.dataset}:${r.type || ''}`);
        if (row.dataset === 'trading' && r.type === 'paper_sell') {
          const key = r.positionId || `${r.mint}:${r.openedAt}`;
          if (!closes.has(key)) {
            closes.add(key); audit.paper.closed++;
            if (Number.isFinite(r.grossPnlSol)) { audit.paper.grossPnlSol += r.grossPnlSol; audit.paper[r.grossPnlSol > 0 ? 'wins' : r.grossPnlSol < 0 ? 'losses' : 'flat']++; }
            else audit.paper.missingPnl++;
          }
        }
        if (row.dataset === 'trading' && r.type === 'shadow_health') {
          const h = audit.shadowHealth; h.observations++;
          h.maxQueueDepth = Math.max(h.maxQueueDepth, r.queueDepth || 0);
          h.maxDroppedPerSession = Math.max(h.maxDroppedPerSession, r.dropped || 0);
          h.maxHistoryEvictionsPerSession = Math.max(h.maxHistoryEvictionsPerSession, r.historyEvictions || 0);
        }
        if (row.dataset === 'shadow' && r.type === 'coverage_gap') inc(audit.coverageGapReasons, r.reason || 'unknown');
        if (row.dataset === 'shadow' && r.type === 'proxy_entry' && Number.isFinite(r.actualEntryDelayMs) && delays.length < 100000) delays.push(r.actualEntryDelayMs);
        if (row.dataset === 'shadow' && r.type === 'sample') {
          inc(audit.featureReasons, r.features?.ready ? 'ready' : r.features?.reason || 'missing_features');
          if (r.policyId) audit.policies[r.policyId] = r.policy;
        }
      }
      if (row.dataset !== 'shadow') continue;
      if (r.type === 'sample') samples.set(r.id, r);
      if (r.type === 'outcome') outcomes.set(`${r.id}:${r.target}`, r);
      if (samples.size > 100000 || outcomes.size > 300000) throw new Error('Inspection sample limit exceeded');
    }
  } finally { input.destroy(); unzip.destroy(); }
  if (!first || !footer || JSON.stringify(first.window) !== JSON.stringify(summary.window) || JSON.stringify(footer) !== JSON.stringify(summary.stats)) throw new Error('Manifest/summary mismatch');
  const targets = {};
  for (const target of ['rebound_30s', 'rebound_60s', 'strategy_proxy']) {
    const rows = []; let censored = 0;
    const cohort = { samples: 0, observed: 0, positive: 0, negative: 0, censored: 0, missingAtExport: 0, censorReasons: {} };
    for (const s of samples.values()) {
      if (!(s.at >= Date.parse(summary.window.start) && s.at < Date.parse(summary.window.endExclusive))) continue;
      cohort.samples++;
      const o = outcomes.get(`${s.id}:${target}`);
      if (!o) cohort.missingAtExport++;
      else if (o.status === 'censored') { cohort.censored++; inc(cohort.censorReasons, o.reason || 'unknown'); }
      else if (o.status === 'observed_proxy' && [0, 1].includes(o.label)) { cohort.observed++; cohort[o.label ? 'positive' : 'negative']++; }
    }
    for (const o of outcomes.values()) {
      if (o.target !== target) continue;
      if (o.status === 'censored') censored++;
      const s = samples.get(o.id), horizon = target === 'rebound_30s' ? 30000 : target === 'rebound_60s' ? 60000 : 0;
      if (!(s?.at >= Date.parse(summary.window.start) && s.at < Date.parse(summary.window.endExclusive))
        || !s?.features?.ready || !s.decisionFresh || !(s.features.lastHistorySequence < s.sequence)
        || !FEATURE_NAMES.every(k => Number.isFinite(s.features.values?.[k])) || !Number.isFinite(s.at)
        || o.status !== 'observed_proxy' || ![0, 1].includes(o.label) || !Number.isFinite(o.at) || o.at < s.at + horizon || s.policyId !== o.policyId) continue;
      rows.push({ key: s.key, at: s.at, endAt: o.at, y: o.label, policyId: s.policyId });
    }
    const policies = {};
    for (const policy of new Set(rows.map(r => r.policyId))) {
      const group = rows.filter(r => r.policyId === policy), unique = new Map(), conflicts = new Set();
      for (const row of group) { if (unique.has(row.key) && unique.get(row.key).y !== row.y) conflicts.add(row.key); else if (!unique.has(row.key)) unique.set(row.key, row); }
      const valid = [...unique.values()].filter(r => !conflicts.has(r.key)), split = chronologicalSplit(valid);
      const groups = [split.train, split.calibration, split.test];
      policies[policy] = { eligible: valid.length, positive: valid.filter(r => r.y === 1).length, negative: valid.filter(r => r.y === 0).length,
        splitCounts: groups.map(g => g.length), purged: split.purged,
        meetsTrainingMinimum: groups.every((g, i) => g.length >= (i === 0 ? 300 : 100) && g.filter(r => r.y === 1).length >= 20 && g.filter(r => r.y === 0).length >= 20) };
    }
    targets[target] = { censored, policies, windowCandidateCohort: cohort };
  }
  delays.sort((a, b) => a - b);
  audit.proxyEntryDelayMs = { count: delays.length, p50: delays.length ? delays[Math.floor((delays.length - 1) * 0.5)] : null, p95: delays.length ? delays[Math.floor((delays.length - 1) * 0.95)] : null };
  audit.warnings = [];
  if (Object.keys(audit.coverageGapReasons).length) audit.warnings.push('Coverage gaps exist; censored labels are unknown, not negative.');
  if (Object.keys(audit.featureReasons).some(k => k !== 'ready')) audit.warnings.push('Some candidates lack prior history and cannot train.');
  if (Object.keys(audit.policies).length > 1) audit.warnings.push('Multiple policies: train and evaluate separately.');
  if (audit.paper.closed) audit.warnings.push('Paper PnL is gross spot simulation, excluding execution impact, fees and delay; proxy delay is not live buy latency.');
  if (!Object.values(targets).some(t => Object.values(t.policies).some(p => p.meetsTrainingMinimum))) audit.warnings.push('No target/policy meets the training minimum.');
  return { integrity: 'verified', lines, window: summary.window, snapshotAt: summary.snapshotAt, windowRecords: summary.stats.windowRecords,
    configSizeSol: summary.config?.sizeSol, sampleRecords: samples.size, counts, targets, audit, dataQuality: summary.dataQuality,
    note: 'Training minimum is not validation of predictive performance. Snapshots alone are not training samples.' };
}
if (require.main === module) inspect(path.resolve(process.argv[2] || '.')).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { inspect };
