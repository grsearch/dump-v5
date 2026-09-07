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
