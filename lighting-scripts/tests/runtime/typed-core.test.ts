/**
 * The typed core introduced by design mandate v2: reject ill-typed input at
 * the boundary rather than reproducing Jinja's coercions.
 *
 * The parity probe measured the gate's entire dependence on those coercions at
 * 14 hits, all of them `null` reaching one range check, so these parsers are
 * strict by default and the one real optional is spelled as an optional type.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { optionalBoolean, optionalFinite, parseFinite, ParseError, parsePythonNumeric, requireBoolean, requireFinite } from '../../src/adapter/codecs/parse.ts';
import { blockOption } from '../../src/adapter/codecs/writes.ts';
import { BLOCKS, DEFAULT_BLOCK } from '../../src/domain/types/schedule.ts';

test('parseFinite uses Python float grammar, not JavaScript Number', () => {
  // The divergence that motivates a shared parser: JavaScript reads hex,
  // Python does not, so `Number` here would silently accept a value the
  // oracle rejects.
  assert.equal(parseFinite('0x10'), undefined, "'0x10' must not read as 16");
  assert.equal(Number('0x10'), 16, 'JavaScript would have accepted it');
  assert.equal(parseFinite('1e3'), 1000);
  assert.equal(parseFinite(' 5 '), 5);
  assert.equal(parseFinite('5.7'), 5.7);
  assert.equal(parseFinite('-5'), -5);
  assert.equal(parseFinite('1_000'), 1000);
});

test('parseFinite rejects every non-finite spelling', () => {
  // `float('inf')` and `float('nan')` succeed in Python, but no lighting
  // quantity is infinite or undefined, so the port rejects them.
  for (const value of ['inf', 'Infinity', '-inf', 'nan', '', ' ', 'hot', '5,0']) {
    assert.equal(parseFinite(value), undefined, `${JSON.stringify(value)} must not parse`);
  }
  for (const value of [Infinity, -Infinity, NaN]) {
    assert.equal(parseFinite(value), undefined, `${value} must not parse`);
  }
  for (const value of [null, undefined, true, false, [], {}, [5], { a: 1 }]) {
    assert.equal(parseFinite(value as never), undefined, `${JSON.stringify(value) ?? 'undefined'} must not parse`);
  }
});

test('requireFinite raises where jinjaFloat would have returned a fallback', () => {
  assert.equal(requireFinite(5), 5);
  assert.equal(requireFinite('5.5'), 5.5);
  for (const value of [null, undefined, 'hot', '', Infinity, NaN, [], {}, true]) {
    assert.throws(() => requireFinite(value as never, 'brightness'), ParseError,
      `${JSON.stringify(value) ?? 'undefined'} must raise rather than coerce`);
  }
});

test('optionalFinite folds null in with absence, and nothing else', () => {
  // Home Assistant spells "this attribute has no value" as null, so null and
  // absent mean the same thing here — stated explicitly instead of hidden in
  // a `??` or a -1 sentinel.
  assert.equal(optionalFinite(undefined), undefined);
  assert.equal(optionalFinite(null), undefined);
  assert.equal(optionalFinite(0), 0, 'zero is a value, not an absence');
  assert.equal(optionalFinite('0'), 0);
  assert.throws(() => optionalFinite('hot'), ParseError, 'a present but ill-typed value still raises');
});

test('requireBoolean accepts only real booleans', () => {
  assert.equal(requireBoolean(true), true);
  assert.equal(requireBoolean(false), false);
  // These are exactly the values JavaScript truthiness would have silently
  // accepted, several of them to the wrong answer.
  for (const value of ['true', 'on', '1', 1, 0, '', null, undefined, [], {}]) {
    assert.throws(() => requireBoolean(value as never, 'flag'), ParseError,
      `${JSON.stringify(value) ?? 'undefined'} must not pass as a boolean`);
  }
  assert.equal(optionalBoolean(null), undefined);
  assert.equal(optionalBoolean(undefined), undefined);
  assert.equal(optionalBoolean(false), false, 'false is a value, not an absence');
});

test('Block is a closed union with a label lookup, not string surgery', () => {
  assert.deepEqual([...BLOCKS], ['day', 'cosy', 'night']);
  assert.equal(DEFAULT_BLOCK, 'night');
  assert.deepEqual(BLOCKS.map(blockOption), ['Day', 'Cosy', 'Night']);
});

test('the Python-numeric quirk is confined to its own parser', () => {
  // The general-purpose parsers stay strict: a boolean is not a brightness.
  assert.equal(parseFinite(true as never), undefined);
  assert.throws(() => requireFinite(true as never, 'brightness'), ParseError);
  // Only the explicitly named one inherits Python's numeric tower.
  assert.equal(parsePythonNumeric(true), 1);
  assert.equal(parsePythonNumeric(false), 0);
  assert.equal(parsePythonNumeric('hot'), undefined, 'it is not a general loosening');
  assert.equal(parsePythonNumeric(null), undefined);
});
