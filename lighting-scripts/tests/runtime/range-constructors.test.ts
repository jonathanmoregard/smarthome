import assert from 'node:assert/strict';
import test from 'node:test';
import { ParseError } from '../../src/runtime/parse.ts';
import { EFFECT_START_FADE, MANUAL_FADE, toColourChannel, toInstant, toSeconds, toTimeOfDay, toTimezone } from '../../src/parse/ids.ts';

test('a colour channel is 0..255 and may be fractional', () => {
  assert.equal(toColourChannel(0), 0);
  assert.equal(toColourChannel(255), 255);
  assert.equal(toColourChannel(127.5), 127.5);
  for (const bad of [-1, 256, NaN, Infinity]) assert.throws(() => toColourChannel(bad), ParseError);
});

test('seconds are finite and not negative', () => {
  assert.equal(toSeconds(0), 0);
  assert.equal(toSeconds(0.2), 0.2);
  for (const bad of [-0.1, NaN, Infinity]) assert.throws(() => toSeconds(bad), ParseError);
});

test('an instant is finite', () => {
  assert.equal(toInstant(1_700_000_000.5), 1_700_000_000.5);
  for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => toInstant(bad), ParseError);
});

test('a time of day is hour 0..23 and minute 0..59, whole', () => {
  assert.deepEqual(toTimeOfDay(23, 59), { hour: 23, minute: 59 });
  assert.deepEqual(toTimeOfDay(0, 0), { hour: 0, minute: 0 });
  for (const [hour, minute] of [[24, 0], [-1, 0], [0, 60], [0, -1], [1.5, 0], [0, 0.5]] as const) {
    assert.throws(() => toTimeOfDay(hour, minute), ParseError);
  }
});

test('a timezone is a non-empty IANA zone id', () => {
  assert.equal(toTimezone('Europe/Stockholm'), 'Europe/Stockholm');
  for (const bad of ['', 'Not/AZone']) assert.throws(() => toTimezone(bad), ParseError);
});

test('the fades are 0.2 s for a manual change and 0.4 s into an effect start', () => {
  assert.equal(MANUAL_FADE, 0.2);
  assert.equal(EFFECT_START_FADE, 0.4);
});
