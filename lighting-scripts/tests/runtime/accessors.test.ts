import assert from 'node:assert/strict';
import test from 'node:test';
import { list, saved, timestamp } from '../../src/adapter/codecs/accessors.ts';
import { context } from './gestures-context.ts';

test('schedule list parsing defaults only absence and rejects present non-arrays', () => {
  assert.deepEqual(list(undefined), []);
  assert.deepEqual(list([0, false, '']), [0, false, '']);
  for (const value of [null, 'light.one', 0, false, {}]) {
    assert.throws(() => list(value as never), /array/,
      `${JSON.stringify(value)} is present and must not be erased to an empty list`);
  }
});

test('schedule timestamps distinguish epoch zero from parse failure', () => {
  assert.equal(timestamp(0), 0);
  assert.equal(timestamp('1970-01-01T00:00:00Z'), 0);
  for (const value of ['not-a-date', '', null, undefined, true]) {
    assert.throws(() => timestamp(value as never), /timestamp/,
      `${JSON.stringify(value) ?? 'undefined'} must not alias epoch zero`);
  }
});

test('a saved profile that is not JSON reads as the captured from_json default, {}', () => {
  // Captured: `states(store) | from_json(default={})` in ls_base, `from_json({})` in effects_ui_sync.
  const ctx = context();
  assert.deepEqual(saved(ctx, 'input_text.missing'), {});
  for (const text of ['unavailable', 'unknown', '{bad json', '', 'on']) {
    ctx.put('input_text.profile', text);
    assert.deepEqual(saved(ctx, 'input_text.profile'), {}, JSON.stringify(text));
  }
});

test('a saved profile that parses to a non-mapping reads as no saved profile (lenient saved-value directive)', () => {
  // The captured `.get` on it raises; saved values take a named default instead.
  const ctx = context();
  for (const text of ['[]', '5', '"x"', 'null']) {
    ctx.put('input_text.profile', text);
    assert.deepEqual(saved(ctx, 'input_text.profile'), {}, text);
  }
});
