import assert from 'node:assert/strict';
import test from 'node:test';
import { anchor, canonicalColor, colorShape, requireRgb, scaleValue } from '../../src/domain/scale.ts';
import { ParseError } from '../../src/runtime/parse.ts';

/**
 * The deployed Jinja reads `day.brightness`, `cosy.brightness`, `position` and
 * `warm_end` raw — no `| int`, no `| float`, no `| default` at any of the 52 /
 * 34 / 32 captured sites — so the oracle raises `TypeError` on a malformed
 * value. These parsers must raise too, instead of letting JavaScript coerce.
 */

test('anchor rejects a brightness that is not a finite number', () => {
  // Before: this returned {brightness: '80'} typed as number, and scaleValue
  // then produced 255 at position 0.5 and NaN below zero.
  assert.throws(() => anchor({ brightness: '80', color: { kelvin: 2200 } }), ParseError);
  assert.throws(() => anchor({ brightness: null, color: { kelvin: 2200 } }), ParseError);
  assert.throws(() => anchor({ brightness: Infinity, color: { kelvin: 2200 } }), ParseError);
  assert.throws(() => anchor({ color: { kelvin: 2200 } }), ParseError);
  assert.throws(() => anchor({}), ParseError);
  assert.throws(() => anchor(undefined), ParseError);
});

test('anchor accepts a well-formed anchor unchanged', () => {
  assert.deepEqual(anchor({ brightness: 80, color: { kelvin: 2200 } }),
    { brightness: 80, color: { kelvin: 2200 } });
  assert.deepEqual(anchor({ brightness: 0, color: { rgb: [255, 126, 0] } }),
    { brightness: 0, color: { rgb: [255, 126, 0] } });
});

test('canonicalColor rejects malformed colors as a named error, not a TypeError', () => {
  // Before: `canonicalColor({})` threw `TypeError: c.rgb is not iterable`, and
  // `canonicalColor({kelvin: 'hot'})` returned a Color whose kelvin was a string.
  for (const bad of [{}, undefined, 'nonsense', { kelvin: 'hot' }, { rgb: [1, 2] },
    { rgb: [1, 2, 'c'] }, { kelvin: 2200, rgb: [1, 2, 3] }, { kelvin: NaN }]) {
    assert.throws(() => canonicalColor(bad as never), ParseError, `expected ParseError for ${JSON.stringify(bad)}`);
  }
});

test('canonicalColor copies rather than aliasing the rgb triple', () => {
  const source: [number, number, number] = [1, 2, 3];
  const parsed = canonicalColor({ rgb: source });
  source[0] = 99;
  assert.deepEqual(parsed, { rgb: [1, 2, 3] });
});

test('colorShape admits any finite kelvin, unlike the range-checking validColor', () => {
  assert.equal(colorShape({ kelvin: 500 }), true);
  assert.equal(colorShape({ kelvin: 20000 }), true);
  assert.equal(colorShape({ rgb: [0, 0, 0] }), true);
  assert.equal(colorShape({ kelvin: 2200, rgb: [1, 2, 3] }), false, 'both channels at once is not a Color');
  assert.equal(colorShape({}), false);
});

test('requireRgb demands exactly three finite numbers', () => {
  assert.deepEqual(requireRgb([1, 2, 3]), [1, 2, 3]);
  for (const bad of [undefined, null, [1, 2], [1, 2, 3, 4], ['1', 2, 3], [1, 2, Infinity], 'red', {}]) {
    assert.throws(() => requireRgb(bad as never), ParseError, `expected ParseError for ${JSON.stringify(bad)}`);
  }
});

test('a well-formed scale still computes the documented values', () => {
  const day = anchor({ brightness: 200, color: { kelvin: 4000 } });
  const cosy = anchor({ brightness: 80, color: { kelvin: 2200 } });
  assert.equal(scaleValue(day, cosy, 0.5).brightness, 140);
  assert.equal(scaleValue(day, cosy, 0).brightness, 80);
  assert.equal(scaleValue(day, cosy, 1).brightness, 200);
  // Below Cosy the floor applies rather than a NaN or a clamp to maximum.
  assert.equal(scaleValue(day, cosy, -0.5).brightness, 76.5);
});
