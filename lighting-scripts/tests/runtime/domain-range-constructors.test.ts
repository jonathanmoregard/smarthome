import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blendPositionOrThrow, brightnessOrThrow, colourChannelOrThrow, instantOrThrow, kelvinOrThrow, levelOrThrow, minutesOrThrow, percentOrThrow,
  percentRangeOrThrow, progressOrThrow, secondsOrThrow, stepCountOrThrow, stepOrThrow, timeOfDayOrThrow,
} from '../../src/domain/types/range.ts';

test('each range constructor accepts both ends of its range and throws a RangeError just outside', () => {
  // Break: a bound moves, or a constructor stops checking and returns its input.
  const cases: [string, (raw: number) => number, number, number][] = [
    ['level', levelOrThrow, 1, 254], ['brightness', brightnessOrThrow, 0, 255], ['kelvin', kelvinOrThrow, 1000, 10000],
    ['progress', progressOrThrow, 0, 1], ['percent', percentOrThrow, 0, 100], ['colour channel', colourChannelOrThrow, 0, 255],
    ['step', stepOrThrow, -20, 20], ['step count', stepCountOrThrow, -40, 40], ['blend position', blendPositionOrThrow, -2, 2],
  ];
  for (const [name, build, low, high] of cases) {
    assert.equal(build(low), low, `${name} low end`);
    assert.equal(build(high), high, `${name} high end`);
    assert.throws(() => build(low - 1e-6), RangeError, `${name} below`);
    assert.throws(() => build(high + 1e-6), RangeError, `${name} above`);
    assert.throws(() => build(NaN), RangeError, `${name} NaN`);
  }
});

test('whole-number ranges refuse a fraction, and the colour channel and progress accept one', () => {
  // Break: a level or brightness admits 1.5, or a blended channel is rejected.
  assert.throws(() => levelOrThrow(1.5), RangeError);
  assert.throws(() => brightnessOrThrow(1.5), RangeError);
  assert.equal(colourChannelOrThrow(127.5), 127.5);
  assert.equal(progressOrThrow(0.25), 0.25);
});

test('seconds and minutes are not negative, an instant is any finite number', () => {
  assert.equal(secondsOrThrow(0), 0);
  assert.equal(minutesOrThrow(90), 90);
  assert.equal(instantOrThrow(-5.5), -5.5);
  for (const bad of [-0.1, NaN, Infinity]) assert.throws(() => secondsOrThrow(bad), RangeError);
  assert.throws(() => minutesOrThrow(-1), RangeError);
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => instantOrThrow(bad), RangeError);
});

test('a percent range runs low to high and a time of day is whole hour and minute', () => {
  // Break: a backwards range is accepted, or 24:00 or 10:60 is.
  assert.deepEqual(percentRangeOrThrow(10, 90), { low: 10, high: 90 });
  assert.throws(() => percentRangeOrThrow(90, 10), RangeError);
  assert.deepEqual(timeOfDayOrThrow(23, 59), { hour: 23, minute: 59 });
  for (const [hour, minute] of [[24, 0], [0, 60], [-1, 0], [1.5, 0], [0, 0.5]] as const) {
    assert.throws(() => timeOfDayOrThrow(hour, minute), RangeError);
  }
});
