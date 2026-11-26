import assert from 'node:assert/strict';
import test from 'node:test';
import { percentRangeOf, stepBoundsOf, stepOf } from '../../src/adapter/codecs/ids.ts';

/**
 * The lenient range readers: a saved value is its range type when it is in
 * range, and none otherwise. They never raise, so each read site picks its
 * own named fallback instead of repeating the range check before a
 * constructor that raises.
 */

const NOT_NUMBERS = [undefined, null, true, false, '5', [], {}, NaN, Infinity, -Infinity];

test('a step is a finite number in -20..20, anything else is none', () => {
  // Break: the bounds are exclusive, or a boolean, a numeric string or a non-finite number passes.
  for (const value of [-20, -0.5, 0, 7, 20]) assert.equal(stepOf(value), value);
  for (const value of [...NOT_NUMBERS, -20.01, 21]) assert.equal(stepOf(value), undefined, String(value));
});

test('step bounds are two steps with min not above max', () => {
  // Break: a backwards pair passes, or a pair with one bad end keeps the good one.
  assert.deepEqual(stepBoundsOf(-4, 4), { min: -4, max: 4 });
  assert.deepEqual(stepBoundsOf(3, 3), { min: 3, max: 3 });
  for (const [min, max] of [[4, -4], [-21, 4], [-4, 21], [-4, '4'], [undefined, 4], [true, 4]]) {
    assert.equal(stepBoundsOf(min, max), undefined, `${String(min)}..${String(max)}`);
  }
});

test('a percent range is two numbers in 0..100 with low not above high', () => {
  // Break: a boolean end passes (Jinja's `is number` admits it, this read does not), or a backwards pair passes.
  assert.deepEqual(percentRangeOf(10, 60), { low: 10, high: 60 });
  assert.deepEqual(percentRangeOf(0, 100), { low: 0, high: 100 });
  for (const [low, high] of [[60, 10], [-1, 10], [10, 101], [true, 80], [10, null], [NaN, 10]]) {
    assert.equal(percentRangeOf(low, high), undefined, `${String(low)}..${String(high)}`);
  }
});
