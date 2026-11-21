import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../src/runtime/context.ts';
import {
  jinjaFloat, jinjaInt, jinjaString, jinjaTruthy, ParseError,
  requireArray, requireNumber, requireObject, requireRange, requireString,
} from '../../src/runtime/parse.ts';

/**
 * Every row below was MEASURED against this repository's own Home Assistant
 * 2026.7.4 / Jinja 3.1.6 closure, not derived from documentation. Regenerate
 * with `scratchpad/oracle-coercion-table.py` if the pinned HA version moves.
 *
 * Columns: value, `| int`, `| int(-1)`, `| float`, `| float(-1.5)`, truthiness.
 */
const MEASURED: ReadonlyArray<readonly [string, JsonValue, number, number, number, number, boolean]> = [
  ['int 5', 5, 5, 5, 5, 5, true],
  ['float 5.7', 5.7, 5, 5, 5.7, 5.7, true],
  ['"5"', '5', 5, 5, 5, 5, true],
  ['"5.7"', '5.7', 5, 5, 5.7, 5.7, true],
  ['""', '', 0, -1, 0, -1.5, false],
  ['" "', ' ', 0, -1, 0, -1.5, true],
  ['"hot"', 'hot', 0, -1, 0, -1.5, true],
  ['"Infinity"', 'Infinity', 0, -1, Infinity, Infinity, true],
  ['"inf"', 'inf', 0, -1, Infinity, Infinity, true],
  ['"nan"', 'nan', 0, -1, NaN, NaN, true],
  ['"1e3"', '1e3', 1000, 1000, 1000, 1000, true],
  ['"0x10"', '0x10', 0, -1, 0, -1.5, true],
  ['"-5"', '-5', -5, -5, -5, -5, true],
  ['"5,0"', '5,0', 0, -1, 0, -1.5, true],
  ['none', null, 0, -1, 0, -1.5, false],
  ['true', true, 1, 1, 1, 1, true],
  ['false', false, 0, 0, 0, 0, false],
  ['[]', [], 0, -1, 0, -1.5, false],
  ['[5]', [5], 0, -1, 0, -1.5, true],
  ['{}', {}, 0, -1, 0, -1.5, false],
];

function same(actual: number, expected: number): boolean {
  return Number.isNaN(expected) ? Number.isNaN(actual) : actual === expected;
}

for (const [label, value, int0, intNeg, float0, floatNeg, truthy] of MEASURED) {
  test(`jinja coercion of ${label} matches the measured oracle`, () => {
    assert.ok(same(jinjaInt(value), int0), `${label} | int => ${jinjaInt(value)}, oracle ${int0}`);
    assert.ok(same(jinjaInt(value, -1), intNeg), `${label} | int(-1) => ${jinjaInt(value, -1)}, oracle ${intNeg}`);
    assert.ok(same(jinjaFloat(value), float0), `${label} | float => ${jinjaFloat(value)}, oracle ${float0}`);
    assert.ok(same(jinjaFloat(value, -1.5), floatNeg), `${label} | float(-1.5) => ${jinjaFloat(value, -1.5)}, oracle ${floatNeg}`);
    assert.equal(jinjaTruthy(value), truthy, `${label} truthiness`);
  });
}

test('jinjaInt never yields a non-finite number, unlike jinjaFloat', () => {
  for (const value of ['inf', '-inf', 'Infinity', 'nan', Infinity, -Infinity, NaN]) {
    assert.ok(Number.isFinite(jinjaInt(value as JsonValue)), `jinjaInt(${String(value)}) must be finite`);
  }
  assert.equal(jinjaFloat('inf'), Infinity);
  assert.equal(jinjaFloat('-inf'), -Infinity);
  assert.ok(Number.isNaN(jinjaFloat('nan')));
});

test('hexadecimal is rejected the way Python rejects it, not accepted the way JavaScript does', () => {
  // Number('0x10') === 16 in JavaScript; the oracle yields the fallback.
  assert.equal(jinjaInt('0x10', -1), -1);
  assert.equal(jinjaFloat('0x10', -1.5), -1.5);
});

test('exponent notation goes through the float path rather than parseInt', () => {
  // parseInt('1e3') === 1, which would be wrong.
  assert.equal(jinjaInt('1e3'), 1000);
  assert.equal(jinjaInt('2.9e2'), 290);
});

test('empty containers are falsy and NaN is truthy, as in Python', () => {
  assert.equal(jinjaTruthy([]), false, 'JavaScript would say true');
  assert.equal(jinjaTruthy({}), false, 'JavaScript would say true');
  assert.equal(jinjaTruthy(NaN), true, 'JavaScript would say false');
  assert.equal(jinjaTruthy([0]), true);
  assert.equal(jinjaTruthy({ a: null }), true);
});

test('jinjaString uses Python scalar spelling', () => {
  assert.equal(jinjaString(null), 'None');
  assert.equal(jinjaString(undefined), 'None');
  assert.equal(jinjaString(true), 'True');
  assert.equal(jinjaString(false), 'False');
  assert.equal(jinjaString('kitchen'), 'kitchen');
});

test('require* fails loudly where Jinja raises instead of coercing', () => {
  // Jinja: `{{ d.missing + 1 }}` raises UndefinedError. JavaScript: NaN.
  assert.throws(() => requireNumber({}, 'brightness'), ParseError);
  assert.throws(() => requireNumber({ brightness: '80' }, 'brightness'), ParseError);
  assert.throws(() => requireNumber({ brightness: Infinity }, 'brightness'), ParseError);
  assert.throws(() => requireString({ area: 5 }, 'area'), ParseError);
  assert.throws(() => requireObject({ day: [] }, 'day'), ParseError);
  assert.throws(() => requireObject({ day: null }, 'day'), ParseError);
  assert.throws(() => requireArray({ targets: 'light.x' }, 'targets'), ParseError);
  assert.equal(requireNumber({ brightness: 80 }, 'brightness'), 80);
  assert.equal(requireString({ area: 'kitchen' }, 'area'), 'kitchen');
  assert.deepEqual(requireObject({ day: { brightness: 1 } }, 'day'), { brightness: 1 });
  assert.deepEqual(requireArray({ targets: ['light.x'] }, 'targets'), ['light.x']);
});

test('requireRange rejects out-of-band brightness instead of clamping silently', () => {
  assert.equal(requireRange({ brightness: 0 }, 'brightness', 0, 255), 0);
  assert.equal(requireRange({ brightness: 255 }, 'brightness', 0, 255), 255);
  assert.throws(() => requireRange({ brightness: 256 }, 'brightness', 0, 255), ParseError);
  assert.throws(() => requireRange({ brightness: -1 }, 'brightness', 0, 255), ParseError);
});

test('ParseError messages name the field and what arrived', () => {
  assert.throws(() => requireNumber({ brightness: '80' }, 'brightness', 'anchor'), {
    name: 'ParseError',
    message: 'anchor.brightness must be a finite number, got string "80"',
  });
});
