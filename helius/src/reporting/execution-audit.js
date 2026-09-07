'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');

function decompose(paperPnl, comparison) {
  const e = comparison.executionBreakdown?.entry, x = comparison.executionBreakdown?.exit;
  if (!e || !x) return { status: 'legacy_missing_breakdown' };
  const v = [paperPnl, comparison.netPnlSol, e.sizeSol, e.spotAmount, e.curveAmount, e.afterFeeAmount, e.filledAmount,
    e.networkFeeSol, x.spotPrice, x.spotProceeds, x.curveOut, x.afterFeeOut, x.afterSlippageOut, x.networkFeeSol];
  if (!v.every(Number.isFinite)) return { status: 'invalid_breakdown' };
  const components = {
    timingAndExitRule: e.spotAmount * x.spotPrice - e.sizeSol - paperPnl,
    entryCurveImpact: (e.curveAmount - e.spotAmount) * x.spotPrice,
    entryFeeEffect: (e.afterFeeAmount - e.curveAmount) * x.spotPrice,
    entrySlippageAndRounding: (e.filledAmount - e.afterFeeAmount) * x.spotPrice,
    entryNetworkFee: -e.networkFeeSol,
    exitCurveImpact: x.curveOut - x.spotProceeds,
    exitFee: x.afterFeeOut - x.curveOut,
    exitSlippage: x.afterSlippageOut - x.afterFeeOut,
    exitNetworkFee: -x.networkFeeSol,
  };
  const residualSol = comparison.netPnlSol - paperPnl - Object.values(components).reduce((a, b) => a + b, 0);
  return { status: Math.abs(residualSol) <= 1e-8 ? 'reconciled' : 'mismatch', components, residualSol };
}
async function executionAudit(directory) {
  const quality = await require('../../scripts/inspect-export').inspect(directory);
  const start = Date.parse(quality.window.start), end = Date.parse(quality.window.endExclusive);
  const sells = new Map(), comparisons = new Map();
  const input = fs.createReadStream(path.join(directory, 'analysis.jsonl.gz')), unzip = zlib.createGunzip();
  input.on('error', e => unzip.destroy(e)); input.pipe(unzip);
  try {
    for await (const line of readline.createInterface({ input: unzip, crlfDelay: Infinity })) {
      const { dataset, record: r } = JSON.parse(line), at = r.at ?? Date.parse(r.time);
      if (dataset === 'trading' && r.type === 'paper_sell' && at >= start && at < end && r.positionId && r.pool) sells.set(`${r.positionId}:${r.pool}`, r);
      if (dataset === 'shadow' && r.type === 'execution_comparison') comparisons.set(r.key, r);
      if (sells.size > 100000 || comparisons.size > 100000) throw new Error('Execution audit size limit exceeded');
    }
  } finally { input.destroy(); unzip.destroy(); }
  const rows = [], totals = { paperCloses: sells.size, matchedObserved: 0, noComparison: 0, censored: 0,
    missingPaperPnl: 0, reconciled: 0, legacyMissingBreakdown: 0, mismatchedBreakdown: 0, paperPnlSol: 0, proxyPnlSol: 0 };
  for (const [key, p] of sells) {
    const c = comparisons.get(key), row = { key, mint: p.mint, paper: { openedAt: p.openedAt, closedAt: Date.parse(p.time), reason: p.reason, pnlSol: p.grossPnlSol }, diagnostic: p.diagnostic };
    if (!c) { totals.noComparison++; row.status = 'no_comparison_in_archive'; }
    else if (c.status !== 'observed_proxy' || !Number.isFinite(c.netPnlSol)) { totals.censored++; row.status = 'proxy_unknown'; row.reason = c.reason; }
    else if (!Number.isFinite(p.grossPnlSol)) { totals.missingPaperPnl++; row.status = 'missing_paper_pnl'; }
    else {
      totals.matchedObserved++; totals.paperPnlSol += p.grossPnlSol; totals.proxyPnlSol += c.netPnlSol;
      row.status = 'matched'; row.proxy = { policyId: c.policyId, entryAt: c.entryAt, exitAt: c.exitAt, triggerAt: c.triggerAt,
        pnlSol: c.netPnlSol, reason: c.reason, assumptions: c.executionPolicy };
      row.entryTimeDifferenceMs = Number.isFinite(c.entryAt) && Number.isFinite(p.openedAt) ? c.entryAt - p.openedAt : null;
      row.exitTimeDifferenceMs = Number.isFinite(c.exitAt) ? c.exitAt - Date.parse(p.time) : null;
      row.pnlDifferenceSol = c.netPnlSol - p.grossPnlSol;
      row.decomposition = decompose(p.grossPnlSol, c);
      const status = row.decomposition.status;
      totals[status === 'reconciled' ? 'reconciled' : status === 'legacy_missing_breakdown' ? 'legacyMissingBreakdown' : 'mismatchedBreakdown']++;
    }
    rows.push(row);
  }
  return { schema: 1, window: quality.window, totals, migrationPipeline: quality.audit.migrationPipeline,
    note: 'Signed accounting bridge under fixed proxy assumptions, not causal attribution or actual fees. Timing term also includes exit-rule and position-size differences. Missing observations remain unknown.', rows };
}
module.exports = { executionAudit, decompose };
