'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSwaps, decodeEvent } = require('../src/parser');
const { fixture, eventBytes } = require('./fixtures');

for (const [encoding, alt] of [['parsed', false], ['base64', false], ['base64', true]]) {
  test(`sell decoding ${encoding} ALT=${alt}`, () => {
    const [swap] = parseSwaps(fixture({ encoding, alt }));
    assert.ok(swap); assert.equal(swap.side, 'sell'); assert.equal(swap.sellSol, 20);
    assert.equal(swap.liquidity, 80); assert.ok(Math.abs(swap.impact - 36) < 1e-9);
  });
}
test('virtual reserves change effective price impact', () => {
  const [swap] = parseSwaps(fixture({ virtual: 100000000000n }));
  assert.ok(Math.abs(swap.impact - 28) < 1e-9);
});
test('buy provides a position price tick but is not a sell', () => {
  const [swap] = parseSwaps(fixture({ side: 'buy' }));
  assert.equal(swap.side, 'buy'); assert.equal(swap.sellSol, 0);
});
test('failed transactions and duplicate pool events are excluded', () => {
  assert.deepEqual(parseSwaps(fixture({ failed: true })), []);
  assert.deepEqual(parseSwaps(fixture({ duplicate: true })), []);
});
test('untrusted events from another program cannot trigger', () => {
  const f = fixture(); f.transaction.meta.innerInstructions[0].instructions[0].programId = f.user;
  assert.deepEqual(parseSwaps(f), []);
});
test('unknown/missing balance or non-WSOL quote is excluded', () => {
  const f = fixture(); f.transaction.meta.postTokenBalances = [];
  assert.deepEqual(parseSwaps(f), []);
  const g = fixture(); g.transaction.transaction.message.instructions[0].accounts[4] = g.mint;
  assert.deepEqual(parseSwaps(g), []);
});
test('multiple swaps or liquidity instructions on same pool are excluded', () => {
  const f = fixture(); const ixs = f.transaction.transaction.message.instructions;
  ixs.push({ ...ixs[0] }); assert.deepEqual(parseSwaps(f), []);
  ixs[1].data = '111111111111'; assert.deepEqual(parseSwaps(f), []);
});
test('truncated event is not silently decoded', () => {
  assert.equal(decodeEvent(eventBytes('SellEvent').subarray(0, 13)), null);
});

test('creation event callback authenticates PumpSwap and does not label a swap as creation', () => {
  const { eventBytes, key } = require('./fixtures'); const { CPI_TAG }=require('../src/parser');
  const bs58=require('bs58').default; const {PUMP,WSOL}=require('../src/config');
  const tx=fixture(); const events=[];
  tx.transaction.meta.innerInstructions[0].instructions.push({programId:PUMP,accounts:[],data:bs58.encode(Buffer.concat([CPI_TAG,eventBytes('CreatePoolEvent',{pool:tx.pool,base_mint:tx.mint,quote_mint:WSOL,timestamp:1000})]))});
  parseSwaps(tx,e=>events.push(e)); assert.equal(events.length,1); assert.equal(events[0].createdAt,1000000);
  tx.transaction.meta.innerInstructions[0].instructions.at(-1).programId=key(88);
  const rejected=[]; parseSwaps(tx,e=>rejected.push(e)); assert.equal(rejected.length,0);
});

test('migration AGE requires matching Pump migrate instruction and completion event, not a pool creation', () => {
  const {CPI_TAG}=require('../src/parser'), ml=require('../src/migration-layout.json'), bs58=require('bs58').default;
  const {PUMP,WSOL}=require('../src/config'); const {key}=require('./fixtures');
  const tx=fixture(), accounts=ml.instructions[0].accounts.map(a=>({mint:tx.mint,pool:tx.pool,pump_amm:PUMP,wsol_mint:WSOL}[a.name]||key(8)));
  const fields=ml.types[0].type.fields, values={mint:tx.mint,pool:tx.pool,quote_mint:WSOL,timestamp:1000};
  const bytes=fields.map(f=>{const v=values[f.name]??(f.type==='pubkey'?key(8):0);if(f.type==='pubkey')return Buffer.from(bs58.decode(v));const b=Buffer.alloc(8);if(f.type==='i64')b.writeBigInt64LE(BigInt(v));else b.writeBigUInt64LE(BigInt(v));return b;});
  tx.transaction.transaction.message.instructions.push({programId:ml.address,accounts,data:bs58.encode(Buffer.from(ml.instructions[0].discriminator))});
  const ev={programId:ml.address,accounts:[],data:bs58.encode(Buffer.concat([CPI_TAG,Buffer.from(ml.events[0].discriminator),...bytes]))};
  tx.transaction.meta.innerInstructions[0].instructions.push(ev);
  const found=[];parseSwaps(tx,e=>found.push(e));assert.equal(found[0].migrationAt,1000000);assert.equal(found[0].source,'pump_migrate_processed');
  tx.transaction.transaction.message.instructions.pop();const rejected=[];parseSwaps(tx,e=>rejected.push(e));assert.equal(rejected.length,0);
});
