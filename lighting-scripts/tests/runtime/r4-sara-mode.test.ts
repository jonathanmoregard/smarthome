import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../src/runtime/context.ts';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { context } from './gestures-context.ts';

/**
 * `ls_sara_mode` tests `'mode:sara' in (state_attr('sensor.ls_overrides','overrides') or {})`
 * and nothing else reads the attribute, so the test is Python `in` exactly: a
 * mapping's keys, a list's elements, a string's substrings. A value `in` raises
 * on (a number) reads as the `or {}` default (lenient saved-value directive).
 */
function toggles(overrides: JsonValue): string {
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', { overrides });
  ctx.run('ls_sara_mode', {});
  const data = ctx.events[0]!.data as { op: string };
  return data.op;
}

test("ls_sara_mode clears when 'mode:sara' is in the saved overrides as Python `in` reads it", () => {
  assert.equal(toggles({ 'mode:sara': {} }), 'clear');
  assert.equal(toggles(['mode:sara']), 'clear');
  assert.equal(toggles('old mode:sara'), 'clear');
});

test("ls_sara_mode sets when it is not, and for a value `in` cannot search", () => {
  for (const overrides of [{}, [], '', null, ['mode'], 'mode', 5, true] as JsonValue[]) {
    assert.equal(toggles(overrides), 'set', JSON.stringify(overrides));
  }
});
