'use strict';
function bucket() { return { candidates: 0, pass: 0, reject: 0, unknownDecision: 0, selectedKnown: 0,
  selectedCensored: 0, selectedPending: 0, selectedInvalid: 0, wins: 0, severeLosses: 0, severeLossKnown: 0,
  selectedNetSol: 0, pairedCandidates: 0, baselinePairedSol: 0, filteredPairedSol: 0, reasons: {} }; }
function add(b, s, o, arm) {
  b.candidates++; const status = arm.status;
  b[status === 'pass' ? 'pass' : status === 'reject' ? 'reject' : 'unknownDecision']++;
  for (const r of [...(arm.rejected || []), ...(arm.unknown || [])]) b.reasons[`${r.check}:${r.reason}`] = (b.reasons[`${r.check}:${r.reason}`] || 0) + 1;
  const known = o?.policyId === s.policyId && o.at >= s.at && o.status === 'observed_proxy' && Number.isFinite(o.netPnlSol);
  if (known && (status === 'pass' || status === 'reject')) {
    b.pairedCandidates++; b.baselinePairedSol += o.netPnlSol; if (status === 'pass') b.filteredPairedSol += o.netPnlSol;
  }
  if (status !== 'pass') return;
  if (!o) { b.selectedPending++; return; }
  if (o.status === 'censored') { b.selectedCensored++; return; }
  if (!known) { b.selectedInvalid++; return; }
  b.selectedKnown++; b.selectedNetSol += o.netPnlSol; if (o.netPnlSol > 0) b.wins++;
  if (Number.isFinite(o.entryCostSol) && o.entryCostSol > 0) { b.severeLossKnown++; if (o.netPnlSol / o.entryCostSol <= -0.25) b.severeLosses++; }
}
function finish(b) {
  return { ...b, selectedNetSol: b.selectedKnown ? b.selectedNetSol : null,
    meanSelectedNetSol: b.selectedKnown ? b.selectedNetSol / b.selectedKnown : null,
    winRate: b.selectedKnown ? b.wins / b.selectedKnown : null,
    severeLossRate: b.severeLossKnown ? b.severeLosses / b.severeLossKnown : null,
    selectedMissingRate: b.pass ? (b.pass - b.selectedKnown) / b.pass : null,
    pairedDifferenceSol: b.pairedCandidates ? b.filteredPairedSol - b.baselinePairedSol : null };
}
function selectionValidation(samples, outcomes, window) {
  const start = Date.parse(window.start), end = Date.parse(window.endExclusive), groups = new Map(), unique = new Map(), conflicts = new Set();
  let legacySamples = 0, duplicates = 0;
  for (const s of samples.values()) {
    if (!(s.at >= start && s.at < end)) continue;
    if (!s.selection || s.selection.version !== 1) { legacySamples++; continue; }
    const key = `${s.runId}:${s.key}`, o = outcomes.get(`${s.id}:strategy_proxy`);
    if (unique.has(key)) {
      duplicates++; const prev = unique.get(key);
      if (JSON.stringify(prev.s.selection) !== JSON.stringify(s.selection) || JSON.stringify(prev.o) !== JSON.stringify(o)) conflicts.add(key);
    } else unique.set(key, { s, o });
  }
  for (const [key, { s, o }] of unique) {
    if (conflicts.has(key)) continue;
    const meta = { runId: s.runId, runStartedAt: s.runStartedAt ?? null, observationVersion: s.observationVersion ?? null,
      policyId: s.policyId, selectionId: s.selection.selectionId, marketExperimentId: s.selection.marketExperimentId, modelIds: s.selection.modelIds };
    const groupKey = JSON.stringify(meta); let g = groups.get(groupKey);
    if (!g) { g = { ...meta, rules: s.selection.rules, arms: {}, byBeijingHour: {} }; groups.set(groupKey, g); }
    const hour = new Date(s.at + 8 * 3600000).toISOString().slice(0, 13) + ':00+08:00';
    for (const name of ['baseline', 'market', 'risk', 'net', 'combined']) {
      const arm = s.selection.arms[name] || { status: 'unknown' };
      add(g.arms[name] ||= bucket(), s, o, arm);
      const h = g.byBeijingHour[hour] ||= {}; add(h[name] ||= bucket(), s, o, arm);
    }
  }
  for (const g of groups.values()) {
    g.arms = Object.fromEntries(Object.entries(g.arms).map(([k, b]) => [k, finish(b)]));
    for (const h of Object.values(g.byBeijingHour)) for (const name of Object.keys(h)) h[name] = finish(h[name]);
  }
  return { version: 1, candidateWindow: window, legacySamples, duplicates, conflicts: conflicts.size, groups: [...groups.values()],
    note: 'Grouped by process start/run, observation version, policy, fixed rules and model IDs. Start time is not proof of deployment Git SHA. Paired comparison uses the same observed candidates with known decisions: rejected candidate = no order/zero return. Unknown decisions and missing outcomes are excluded, not wins or losses. No portfolio capacity, capital or causal fill claim. Not an automatic live-trading approval.' };
}
module.exports = { selectionValidation };
