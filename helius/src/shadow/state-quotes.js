'use strict';
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, unpackAccount } = require('@solana/spl-token');
const { PUMP_AMM_SDK } = require('@pump-fun/pump-swap-sdk');
const { PUMP, WSOL } = require('../config');
const fail = reason => { const e = new Error(reason); e.reason = reason; throw e; };
function decodeState(s, values, slot) {
  const infos = values.map(a => a && ({ ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], 'base64') }));
  const [p, m, b, q] = infos;
  if (!p || !m || !b || !q) fail('missing_account');
  if (p.owner.toBase58() !== PUMP || p.data.length < 243) fail('invalid_pool');
  const pool = PUMP_AMM_SDK.decodePool(p), program = new PublicKey(s.tokenProgram);
  if (!pool.baseMint.equals(new PublicKey(s.mint)) || pool.quoteMint.toBase58() !== WSOL
    || pool.poolBaseTokenAccount.toBase58() !== s.baseVault || pool.poolQuoteTokenAccount.toBase58() !== s.quoteVault) fail('pool_identity_mismatch');
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(program)) || !m.owner.equals(program)) fail('invalid_token_program');
  if (m.data.length !== MintLayout.span || b.data.length !== 165 || q.data.length !== 165) fail('unsupported_extensions');
  const mint = MintLayout.decode(m.data);
  if (!mint.isInitialized || mint.freezeAuthorityOption !== 0) fail('mint_not_supported');
  const base = unpackAccount(new PublicKey(s.baseVault), b, program), quote = unpackAccount(new PublicKey(s.quoteVault), q, TOKEN_PROGRAM_ID);
  if (base.mint.toBase58() !== s.mint || quote.mint.toBase58() !== WSOL || base.owner.toBase58() !== s.pool
    || quote.owner.toBase58() !== s.pool || !base.isInitialized || !quote.isInitialized || base.isFrozen || quote.isFrozen) fail('invalid_vault');
  const virtual = BigInt(pool.virtualQuoteReserves.toString());
  if (base.amount === 0n || quote.amount === 0n || virtual < 0n) fail('empty_or_invalid_reserves');
  const price = Number(quote.amount + virtual) / Number(base.amount) / 1e9;
  if (!(price > 0) || !Number.isFinite(price)) fail('invalid_price');
  return { pool: s.pool, mint: s.mint, slot, price, postBase: base.amount.toString(), postQuote: quote.amount.toString(), virtual: virtual.toString() };
}
// Read-only service. Credentials stay in the main process, never in workerData or records.
class StateQuotes {
  constructor(c, { now = Date.now, request = fetch, decode = decodeState } = {}) {
    this.c = c; this.now = now; this.request = request; this.decode = decode;
    this.history = []; this.pools = new Map(); this.busy = false; this.closed = false;
    this.counts = { requests: 0, queriedPools: 0, quotedPools: 0, failedPools: 0, budgetSkips: 0 };
  }
  stats() { return { ...this.counts, enabled: !!this.c.shadow.stateQuotes, inFlight: this.busy }; }
  close() { this.closed = true; this.controller?.abort(); }
  async poll(targets) {
    if (this.closed || this.busy || !this.c.shadow.stateQuotes) return [];
    const at = this.now(), cfg = this.c.shadow;
    this.history = this.history.filter(t => at - t < 60000);
    const unique = new Map(targets.slice(0, 1000).map(s => [s.pool, s]));
    for (const [p, state] of this.pools) if (!unique.has(p) && at - state.lastAt > 300000) this.pools.delete(p);
    if (this.history.length >= cfg.stateQuoteRequestsPerMinute) { this.counts.budgetSkips++; return []; }
    const selected = [...unique.values()].filter(s => at >= (this.pools.get(s.pool)?.nextAt || 0))
      .sort((a, b) => (this.pools.get(a.pool)?.lastAt || 0) - (this.pools.get(b.pool)?.lastAt || 0)).slice(0, 20);
    if (!selected.length) return [];
    const valid = [], results = [];
    for (const s of selected) {
      try { for (const k of [s.pool, s.mint, s.baseVault, s.quoteVault, s.tokenProgram]) new PublicKey(k);
        if (!Number.isSafeInteger(s.slot) || s.slot < 0) throw new Error(); valid.push(s);
      } catch (_) { results.push(this.result(s, at, null, 'invalid_target')); }
    }
    if (!valid.length) return results;
    this.busy = true; this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), 3000);
    this.history.push(at); this.counts.requests++; this.counts.queriedPools += valid.length;
    try {
      const keys = [...new Set(valid.flatMap(s => [s.pool, s.mint, s.baseVault, s.quoteVault]))];
      const response = await this.request(this.c.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: this.controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys,
          { encoding: 'base64', commitment: 'confirmed', minContextSlot: Math.max(...valid.map(s => s.slot)) }] }) });
      if (!response.ok) fail(response.status === 429 ? 'rate_limited' : 'rpc_http_error');
      const body = await response.json();
      if (body.error || !Array.isArray(body.result?.value) || body.result.value.length !== keys.length) fail('rpc_error');
      const slot = body.result.context?.slot;
      if (!Number.isSafeInteger(slot) || slot < Math.max(...valid.map(s => s.slot))) fail('stale_slot');
      if (this.now() - at > 3000 || this.now() < at) fail('stale_response');
      for (const s of valid) {
        try { results.push(this.result(s, at, this.decode(s, [s.pool, s.mint, s.baseVault, s.quoteVault].map(k => body.result.value[keys.indexOf(k)]), slot))); }
        catch (e) { results.push(this.result(s, at, null, e.reason || 'account_decode_failed')); }
      }
    } catch (e) { for (const s of valid) results.push(this.result(s, at, null, e.reason || 'rpc_unavailable')); }
    finally { clearTimeout(timeout); this.busy = false; this.controller = null; }
    return this.closed ? [] : results;
  }
  result(s, requestAt, quote, reason = null) {
    const at = this.now(), old = this.pools.get(s.pool), failures = quote ? 0 : (old?.failures || 0) + 1;
    const interval = this.c.shadow.stateQuoteIntervalMs;
    const delay = Math.min(Math.max(120000, interval), interval * 2 ** Math.min(failures, 4));
    this.pools.delete(s.pool);
    this.pools.set(s.pool, { lastAt: at, nextAt: at + delay, failures });
    if (this.pools.size > 5000) this.pools.delete(this.pools.keys().next().value);
    this.counts[quote ? 'quotedPools' : 'failedPools']++;
    return { type: 'state_quote', source: 'helius_account_state', pool: s.pool, mint: s.mint, requestAt, at,
      latencyMs: at - requestAt, status: quote ? 'quoted' : 'unavailable', reason, quote: quote && { ...quote, requestAt } };
  }
}
module.exports = { StateQuotes, decodeState };
