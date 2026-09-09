'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, MintLayout, ExtensionType: E, getTypeLen } = require('@solana/spl-token');
const { inspectExtensions } = require('../src/shadow/account-extensions');
const { PUMP_AMM_SDK } = require('@pump-fun/pump-swap-sdk');
const BN = require('bn.js');
const { key } = require('./fixtures');
const { accountInfo } = require('./executor-fixtures');
const { readConfig, PUMP, WSOL } = require('../src/config');
const { StateQuotes, decodeState } = require('../src/shadow/state-quotes');
const { ExitComparisons } = require('../src/shadow/exit-comparisons');
const { Recovery } = require('../src/shadow/recovery');
const target = n => ({ pool: key(n), mint: key(4), baseVault: key(7), quoteVault: key(8), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), slot: 100 });
function service(extra = {}) {
  let at = 10000; const calls = [];
  const c = readConfig({ HELIUS_API_KEY: 'test-secret', SHADOW_STATE_QUOTE_REQUESTS_PER_MINUTE: '2' });
  const request = async (_, options) => { const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => ({ result: { context: { slot: 101 }, value: body.params[0].map(() => ({})) } }) }; };
  const s = new StateQuotes(c, { now: () => at, request, decode: (t, _, slot) => ({ pool: t.pool, slot, price: 1 }), ...extra });
  return { s, c, calls, time: n => { at = n; } };
}
test('state quotes deduplicate pools, cap batches, enforce rolling budget and never expose credentials', async () => {
  const { s, calls, time } = service();
  const targets = Array.from({ length: 25 }, (_, i) => target(i + 20));
  const first = await s.poll([...targets, targets[0]]);
  assert.equal(first.length, 20); assert.ok(calls[0].params[0].length <= 80);
  assert.equal(calls[0].method, 'getMultipleAccounts'); assert.equal(calls[0].params[1].minContextSlot, 100);
  assert.equal((await s.poll(targets)).length, 5);
  time(30000); assert.equal((await s.poll(targets)).length, 0); assert.equal(calls.length, 2);
  time(70001); assert.equal((await s.poll(targets)).length, 20);
  assert.ok(!JSON.stringify(first).includes('test-secret'));
});
test('failed requests back off, sanitize errors and disabled service makes no calls', async () => {
  let calls = 0;
  const { s, time } = service({ request: async () => { calls++; throw new Error('https://host/?api-key=secret'); } });
  const r = await s.poll([target(1)]); assert.equal(r[0].reason, 'rpc_unavailable'); assert.ok(!JSON.stringify(r).includes('api-key'));
  time(25000); assert.equal((await s.poll([target(1)])).length, 0); assert.equal(calls, 1);
  time(40000); await s.poll([target(1)]); assert.equal(calls, 2);
  s.c.shadow.stateQuotes = false; time(100000); assert.deepEqual(await s.poll([target(1)]), []); assert.equal(calls, 2);
});
test('in-flight requests do not queue duplicates, close discards responses, stale slots are refused', async () => {
  let release;
  const { s } = service({ request: () => new Promise(r => { release = r; }) });
  const pending = s.poll([target(1)]); assert.deepEqual(await s.poll([target(1)]), []);
  s.close(); release({ ok: true, json: async () => ({ result: { context: { slot: 101 }, value: [{}, {}, {}, {}] } }) });
  assert.deepEqual(await pending, []);
  const x = service({ request: async () => ({ ok: true, json: async () => ({ result: { context: { slot: 99 }, value: [{}, {}, {}, {}] } }) }) });
  assert.equal((await x.s.poll([target(1)]))[0].reason, 'stale_slot');
});
test('late RPC results and rate limits remain unavailable instead of producing fresh estimates', async () => {
  const h = service({ request: async () => {
    h.time(14001); return { ok: true, json: async () => ({ result: { context: { slot: 101 }, value: [{}, {}, {}, {}] } }) };
  } });
  assert.equal((await h.s.poll([target(1)]))[0].reason, 'stale_response');
  const rate = service({ request: async () => ({ ok: false, status: 429 }) });
  assert.equal((await rate.s.poll([target(1)]))[0].reason, 'rate_limited');
});
async function accounts() {
  const pub = n => new PublicKey(key(n)), t = target(1);
  const pool = { poolBump: 1, index: 0, creator: pub(2), baseMint: pub(4), quoteMint: new PublicKey(WSOL), lpMint: pub(5),
    poolBaseTokenAccount: pub(7), poolQuoteTokenAccount: pub(8), lpSupply: new BN(1), coinCreator: pub(9),
    isMayhemMode: false, isCashbackCoin: false, virtualQuoteReserves: new BN('10000000000') };
  const p = { owner: new PublicKey(PUMP), data: await PUMP_AMM_SDK.offlineProgram.coder.accounts.encode('pool', pool) };
  const m = { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(MintLayout.span) };
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000n,
    decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, m.data);
  const b = accountInfo(pub(4), pub(1), 100000000000n), q = accountInfo(new PublicKey(WSOL), pub(1), 100000000000n);
  const wire = list => list.map(a => ({ ...a, owner: a.owner.toBase58(), data: [a.data.toString('base64'), 'base64'] }));
  return { t, p, m, b, q, wire };
}
test('account estimates validate real SDK pool identity, vaults and virtual reserves without using stale swap reserves', async () => {
  const { t, p, m, b, q, wire } = await accounts();
  const s = decodeState(t, wire([p, m, b, q]), 101);
  assert.equal(s.virtual, '10000000000'); assert.equal(s.postBase, '100000000000'); assert.ok(Math.abs(s.price - 1.1e-9) < 1e-24);
  assert.throws(() => decodeState({ ...t, mint: key(6) }, wire([p, m, b, q]), 101), /identity/);
  assert.throws(() => decodeState(t, wire([{ ...p, owner: TOKEN_PROGRAM_ID }, m, b, q]), 101), /invalid_pool/);
  assert.throws(() => decodeState(t, wire([p, { ...m, data: Buffer.alloc(90) }, b, q]), 101), /legacy_account_size_mismatch/);
  const empty = accountInfo(new PublicKey(WSOL), new PublicKey(t.pool), 0n);
  assert.throws(() => decodeState(t, wire([p, m, b, empty]), 101), /reserves/);
  assert.throws(() => decodeState(t, [null, ...wire([m, b, q])], 101), /missing_account/);
});
function extended(info, kind, entries) {
  const prefix = Buffer.alloc(166); info.data.copy(prefix); prefix[165] = kind === 'mint' ? 1 : 2;
  const tlvs = entries.map(([type, value]) => { const h = Buffer.alloc(4); h.writeUInt16LE(type); h.writeUInt16LE(value.length, 2); return Buffer.concat([h, value]); });
  return { ...info, owner: TOKEN_2022_PROGRAM_ID, data: Buffer.concat([prefix, ...tlvs]) };
}
test('metadata mint and immutable vault extensions produce the same reserve estimate as legacy accounts', async () => {
  const { t, p, m, b, q, wire } = await accounts(), metadata = Buffer.alloc(80);
  new PublicKey(t.mint).toBuffer().copy(metadata, 32);
  const em = extended(m, 'mint', [[E.MetadataPointer, Buffer.alloc(64)], [E.TokenMetadata, metadata]]);
  const eb = extended(b, 'account', [[E.ImmutableOwner, Buffer.alloc(0)]]);
  const state = decodeState({ ...t, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }, wire([p, em, eb, q]), 101);
  const legacy = decodeState(t, wire([p, m, b, q]), 101);
  assert.equal(state.price, legacy.price); assert.equal(state.postBase, legacy.postBase);
  assert.deepEqual(state.accountDiagnostics[0].extensions.map(e => e.name), ['MetadataPointer', 'TokenMetadata']);
  assert.deepEqual(state.accountDiagnostics[1].extensions.map(e => e.name), ['ImmutableOwner']);
  assert.ok(state.accountDiagnostics.every(d => d.status === 'supported'));
  const h = service({ decode: decodeState, request: async () => ({ ok: true,
    json: async () => ({ result: { context: { slot: 101 }, value: wire([p, em, eb, q]) } }) }) });
  const result = (await h.s.poll([{ ...t, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }]))[0];
  assert.equal(result.status, 'quoted'); assert.equal(result.quote.price, legacy.price);
  assert.equal(result.accountDiagnostics[1].extensions[0].name, 'ImmutableOwner');
});
test('fee, hook, permissions, unknown and mixed extensions are rejected with account-specific diagnostics', async () => {
  const { t, p, m, b, q, wire } = await accounts();
  for (const type of [E.TransferFeeConfig, E.TransferHook, E.PermanentDelegate, E.NonTransferable, E.PausableConfig, 60000]) {
    const em = extended(m, 'mint', [[E.MetadataPointer, Buffer.alloc(64)], [type, Buffer.alloc(type === 60000 ? 1 : getTypeLen(type))]]);
    assert.throws(() => decodeState({ ...t, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }, wire([p, em, { ...b, owner: TOKEN_2022_PROGRAM_ID }, q]), 101), e => {
      assert.equal(e.reason, 'unsupported_extensions');
      const d = e.diagnostics.find(d => d.status === 'rejected');
      assert.equal(d.role, 'baseMint'); assert.equal(d.dataLength, em.data.length); assert.equal(d.blockedExtensions[0].type, type); return true;
    });
  }
  for (const type of [E.TransferFeeAmount, E.TransferHookAccount, E.CpiGuard, E.MemoTransfer]) {
    const eb = extended(b, 'account', [[E.ImmutableOwner, Buffer.alloc(0)], [type, Buffer.alloc(getTypeLen(type))]]);
    const d = inspectExtensions(eb, 'baseVault', 'account', new PublicKey(t.baseVault), TOKEN_2022_PROGRAM_ID);
    assert.equal(d.reason, 'unsupported_extensions'); assert.equal(d.blockedExtensions[0].type, type);
  }
});
test('malformed TLV, wrong account kinds, duplicate types, bad metadata and legacy extensions fail closed', async () => {
  const { t, m, b } = await accounts(), metadata = Buffer.alloc(80); new PublicKey(t.mint).toBuffer().copy(metadata, 32);
  const valid = extended(m, 'mint', [[E.TokenMetadata, metadata]]);
  const cases = [];
  const truncated = { ...valid, data: valid.data.subarray(0, -1) }; cases.push(truncated);
  const kind = { ...valid, data: Buffer.from(valid.data) }; kind.data[165] = 2; cases.push(kind);
  const padded = { ...valid, data: Buffer.from(valid.data) }; padded.data[90] = 1; cases.push(padded);
  cases.push(extended(m, 'mint', [[E.MetadataPointer, Buffer.alloc(63)]]));
  cases.push(extended(m, 'mint', [[E.MetadataPointer, Buffer.alloc(64)], [E.MetadataPointer, Buffer.alloc(64)]]));
  const bad = Buffer.from(metadata); bad.writeUInt32LE(0xffffffff, 64); cases.push(extended(m, 'mint', [[E.TokenMetadata, bad]]));
  cases.push(extended(m, 'mint', [[E.TokenMetadata, Buffer.alloc(80)]]));
  for (const info of cases) assert.equal(inspectExtensions(info, 'baseMint', 'mint', new PublicKey(t.mint), TOKEN_2022_PROGRAM_ID).reason, 'invalid_extension_layout');
  const immutable = extended(b, 'account', [[E.ImmutableOwner, Buffer.alloc(1)]]);
  assert.equal(inspectExtensions(immutable, 'baseVault', 'account', new PublicKey(t.baseVault), TOKEN_2022_PROGRAM_ID).reason, 'invalid_extension_layout');
  assert.equal(inspectExtensions({ ...valid, owner: TOKEN_PROGRAM_ID }, 'baseMint', 'mint', new PublicKey(t.mint), TOKEN_PROGRAM_ID).reason, 'legacy_account_size_mismatch');
});
test('pool polling carries extension diagnostics through unavailable records without raw metadata', async () => {
  const { t, p, m, b, q, wire } = await accounts();
  const em = extended(m, 'mint', [[E.TransferHook, Buffer.alloc(getTypeLen(E.TransferHook))]]);
  const values = wire([p, em, { ...b, owner: TOKEN_2022_PROGRAM_ID }, q]);
  const h = service({ decode: decodeState, request: async () => ({ ok: true, json: async () => ({ result: { context: { slot: 101 }, value: values } }) }) });
  const result = (await h.s.poll([{ ...t, tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58() }]))[0];
  assert.equal(result.validationVersion, 2); assert.equal(result.status, 'unavailable');
  assert.equal(result.accountDiagnostics[0].blockedExtensions[0].name, 'TransferHook');
  assert.equal(result.quote, null); assert.ok(!JSON.stringify(result).includes('test-secret'));
});
const config = { maxActive: 100, maxActivePerPool: 100, maxHoldMs: 30000, maxGapMs: 10000,
  exitDelayMs: 500, takeProfit: 20, stopLoss: 25, trailArm: 0, trailDrop: 3 };
const sample = () => ({ id: 'a', source: { pool: 'p' }, last: { pool: 'p', slot: 1 },
  entry: { cost: 1, amount: 1, at: 0, openedAt: 0, high: 1, entryPrice: 1 }, strategyDone: true });
test('30 and 50 percent targets differ, share entry and retain their stop policies', () => {
  const events = [], x = new ExitComparisons(config, e => events.push(e)), s = sample();
  x.observe(s, { price: 1.25 }, 1.2, 1000); x.observe(s, { price: 1.35 }, 1.3, 1500);
  assert.equal(s.exitComparisons.find(a => a.name === 'take30').pending.reason, 'take_profit');
  assert.equal(s.exitComparisons.find(a => a.name === 'take50').pending, null);
  x.observe(s, { price: 1.55 }, 1.5, 2000); x.observe(s, { price: 1.6 }, 1.55, 2500);
  assert.equal(events.find(e => e.variant === 'take30').netPnlSol, .5);
  assert.equal(events.find(e => e.variant === 'take50').netPnlSol, .55);
  assert.equal(s.entry.high, 1); assert.equal(config.takeProfit, 20);
  const down = sample(); x.observe(down, { price: .7 }, .65, 1000);
  assert.equal(down.exitComparisons.find(a => a.name === 'take50').pending.reason, 'stop_loss');
  assert.equal(down.exitComparisons.find(a => a.name === 'take50_no_stop').pending, null);
});
test('state recovery preserves all variants, ignores pre-deadline snapshots and never changes stream recovery', () => {
  const events = [], s = sample(), x = new ExitComparisons(config, () => {});
  x.observe(s, { price: 1 }, 1, 500); const original = JSON.stringify(s);
  const r = new Recovery(config, e => events.push(e), s => s.net, 'state_exit_recovery'); r.add(s, 'pool_observation_gap', 11000);
  assert.equal(r.active.size, 8); assert.equal(JSON.stringify(s), original);
  r.observe({ pool: 'p', slot: 2, price: 1.4, net: 1.3, requestAt: 10999 }, 12000); assert.equal(events.filter(e => e.phase === 'first_quote').length, 0);
  r.observe({ pool: 'p', slot: 2, price: 1.4, net: 1.3, requestAt: 12000 }, 12100);
  r.observe({ pool: 'p', slot: 2, price: 1.4, net: 1.3, requestAt: 12200 }, 13000);
  assert.equal(events.filter(e => e.phase === 'finished').length, 0);
  r.observe({ pool: 'p', slot: 3, price: 1.4, net: 1.3, requestAt: 14000 }, 14100);
  assert.equal(events.find(e => e.variant === 'take30' && e.phase === 'finished').status, 'account_state_proxy');
  assert.ok(!events.some(e => e.variant === 'take50' && e.phase === 'finished'));
  r.close('process_shutdown', 15000); assert.equal(r.active.size, 0);
  assert.ok(events.every(e => e.type === 'state_exit_recovery' && e.coverage === 'discontinuous'));
});
