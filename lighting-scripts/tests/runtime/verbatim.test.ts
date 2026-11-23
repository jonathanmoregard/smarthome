import assert from 'node:assert/strict';
import test from 'node:test';
import { carry, jsonEqual, sameDocument } from '../../src/runtime/verbatim.ts';

// `jsonEqual` is the planner's old local `equal`, moved. It is deliberately NOT
// `isDeepStrictEqual`, and the two disagree in exactly these two places.
test('jsonEqual never equates NaN and does equate 0 with -0, unlike isDeepStrictEqual', () => {
  assert.equal(jsonEqual(Number.NaN, Number.NaN), false);
  assert.equal(jsonEqual([Number.NaN], [Number.NaN]), false);
  assert.equal(jsonEqual(0, -0), true);
  assert.equal(jsonEqual({ a: 0 }, { a: -0 }), true);
});

test('jsonEqual ignores mapping key order but not list order', () => {
  assert.equal(jsonEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(jsonEqual([1, 2], [2, 1]), false);
  assert.equal(jsonEqual({ a: 1 }, { a: 1, b: null }), false);
  assert.equal(sameDocument(carry({ x: 'y', n: 1 }), carry({ n: 1, x: 'y' })), true);
});

test('a carried value is the document itself, so carrying it into an output moves no byte', () => {
  const payload = { state: 'ON', transition: 0.4 };
  assert.equal(carry(payload), payload);
});
