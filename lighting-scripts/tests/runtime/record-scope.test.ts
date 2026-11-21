import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResolveArgs } from '../../src/parse/resolution.ts';
import type { JsonObject } from '../../src/runtime/context.ts';

/**
 * A stored override record's scope is one of the three a record can apply at
 * (house, room, lamp), or none: absent, `null`, other text or a non-string
 * names no scope and the record applies nowhere. A `light` record with no
 * scope is a lamp's (captured `r.get('scope', 'lamp' if kind == 'light' else '')`).
 */

const scopeOf = (record: JsonObject) => {
  const parsed = parseResolveArgs({ overrides: { k: record } }).records[0];
  return parsed === undefined ? 'no record' : [parsed.scope, parsed.storedScope];
};

test('a record names one of the three scopes, or none, never an invented one', () => {
  // Break: an absent scope on a non-light record reads as the empty scope `''` instead of none.
  assert.deepEqual(scopeOf({ kind: 'channels' }), [undefined, undefined]);
  assert.deepEqual(scopeOf({ kind: 'light' }), ['lamp', undefined]);
  assert.deepEqual(scopeOf({ kind: 'light', scope: null }), [undefined, undefined]);
  for (const scope of ['house', 'room', 'lamp'] as const) assert.deepEqual(scopeOf({ kind: 'channels', scope }), [scope, scope]);
  for (const scope of ['', 'kitchen', 7, true]) assert.deepEqual(scopeOf({ kind: 'light', scope }), [undefined, undefined], String(scope));
});
