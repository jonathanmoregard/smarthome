import assert from 'node:assert/strict';
import test from 'node:test';
import { toKelvin, toLevel, toMinutes, toPercent, toPercentRange, toProgress } from '../../src/parse/ids.ts';

const bad = (build: () => unknown) => assert.throws(build, { name: 'ParseError' });

test('a level is a whole Zigbee level, 1..254', () => {
  // Break: a no-op constructor lets 0 (off), 255 (Home Assistant full) or 1.5 through as a level.
  assert.equal(toLevel(1), 1); assert.equal(toLevel(254), 254);
  for (const n of [0, 255, 1.5, NaN, Infinity, -1]) bad(() => toLevel(n));
});

test('a percent is 0..100', () => {
  assert.equal(toPercent(0), 0); assert.equal(toPercent(100), 100); assert.equal(toPercent(39.2), 39.2);
  for (const n of [-0.1, 100.1, NaN]) bad(() => toPercent(n));
});

test('a percent range is two percents, low not above high', () => {
  // Break: accepting low > high would make the switch-range check unsatisfiable without saying so.
  assert.deepEqual(toPercentRange(10, 10), { low: 10, high: 10 });
  assert.deepEqual(toPercentRange(0, 100), { low: 0, high: 100 });
  for (const [low, high] of [[50, 40], [-1, 10], [0, 101]] as const) bad(() => toPercentRange(low, high));
});

test('a colour temperature is 1000..10000 K, the dashboard\'s 100..1000 mireds', () => {
  assert.equal(toKelvin(1000), 1000); assert.equal(toKelvin(10000), 10000); assert.equal(toKelvin(2700), 2700);
  for (const n of [999, 10001, NaN]) bad(() => toKelvin(n));
});

test('a transition progress is 0..1', () => {
  assert.equal(toProgress(0), 0); assert.equal(toProgress(1), 1); assert.equal(toProgress(0.25), 0.25);
  for (const n of [-0.01, 1.01, NaN]) bad(() => toProgress(n));
});

test('a minutes count is finite and not negative', () => {
  assert.equal(toMinutes(0), 0); assert.equal(toMinutes(180), 180);
  for (const n of [-1, NaN, Infinity]) bad(() => toMinutes(n));
});
