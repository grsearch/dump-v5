'use strict';
class Age {
  constructor(entries = []) {
    this.pools = new Map(); this.counters = { accepted: 0, restored: 0, rejected: 0, evicted: 0, known: 0, unknown: 0 };
    for (const e of entries.slice(-20000)) this.created(e, true);
  }
  created(e, restored = false) {
    if (!e || e.source !== 'pump_migrate_processed' || e.migrationAt !== e.createdAt || typeof e.pool !== 'string' || typeof e.mint !== 'string' || !Number.isSafeInteger(e.createdAt)
      || e.createdAt <= 0 || !Number.isSafeInteger(e.observedAt) || e.createdAt > e.observedAt + 2000) { this.counters.rejected++; return false; }
    this.counters[restored ? 'restored' : 'accepted']++;
    const old = this.pools.get(e.pool);
    this.pools.delete(e.pool); this.pools.set(e.pool, { ...e,
      conflict: !!e.conflict || !!old?.conflict || !!(old && (old.mint !== e.mint || old.createdAt !== e.createdAt)) });
    if (this.pools.size > 20000) { this.pools.delete(this.pools.keys().next().value); this.counters.evicted++; }
    return true;
  }
  snapshot(s, at) {
    const e = this.pools.get(s.pool), known = e && !e.conflict && e.mint === s.mint && e.createdAt <= at && e.observedAt <= at;
    this.counters[known ? 'known' : 'unknown']++;
    const reason = known ? null : !e ? 'migration_not_cached' : e.conflict ? 'conflicting_evidence' : e.mint !== s.mint ? 'mint_mismatch' : 'evidence_not_yet_known_at_candidate';
    return { version: 2, definition: 'since_pump_graduation_migration', tokenCreatedAt: null, tokenAgeMs: null,
      migrationAt: known ? e.migrationAt : null, migrationAgeMs: known ? at - e.migrationAt : null,
      source: known ? e.source : 'unknown', creationSignature: known ? e.signature : null,
      status: known ? 'observed_processed_not_finalized' : 'unknown',
      unknownReason: reason,
      note: 'AGE starts at authenticated Pump migrate completion; unknown history stays null.' };
  }
}
module.exports = { Age };
