import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { context } from './gestures-context.ts';
import { reveal } from '../../src/runtime/verbatim.ts';
import { planMapping, planOverrides, planRangeDefaults } from '../../src/parse/controller.ts';
import { rangeDefaults } from '../../src/parse/planning.ts';

/**
 * Captured Jinja `or` / `and` over stored attributes. Jinja's falsy set holds
 * `[]` and `{}` and not NaN; JavaScript's is the other way round, so `||` and
 * `&&` on the raw value diverge both ways. Home Assistant 2026.7.4 renders
 * `{{ {} or 'config' }}` as `'config'` and `{{ {} or [] }}` as `[]`.
 */
function tickCommit(previousReason: JsonValue): JsonValue | undefined {
  // Unhandled: the stored full_version is not the runtime's handled_full.
  const ctx = context(stateStoreHandlers);
  ctx.put('sensor.ls_overrides', '0', { full_version: 'v1', full_reason: previousReason });
  ctx.run('ls_commit', { data: { op: 'render_request', reason: 'tick' } });
  const update = ctx.calls.find(call => call.service === 'variable.update_sensor');
  return (update?.data.attributes as JsonObject | undefined)?.full_reason;
}

test('ls_commit keeps a tick reason over an empty-container previous reason', () => {
  // Captured: `'config' if reason=='tick' and previous_reason and previous_reason!='tick' else reason`.
  for (const empty of [{}, []] as JsonValue[]) assert.equal(tickCommit(empty), 'tick', `previous ${JSON.stringify(empty)}`);
});

test('ls_commit turns a tick into config over a NaN previous reason', () => {
  // `bool(float('nan'))` is True in Jinja; NaN is falsy in JavaScript.
  assert.equal(tickCommit(Number.NaN), 'config');
});

test('ls_commit turns a tick into config over a non-tick previous reason, and not over tick or none', () => {
  assert.equal(tickCommit('remote'), 'config');
  assert.equal(tickCommit('tick'), 'tick');
  assert.equal(tickCommit(null), 'tick');
});

// Close-out review round 3: siblings of the `x or default` reads above that
// were ported as an absent/null-only default. Each falsy value takes the
// default; a truthy value of the wrong type still raises, as the captured
// comparison or `.get`/`.items()` downstream of it does.
const falsy: JsonValue[] = [null, false, 0, '', [], {}];

test("ls_plan reads overrides, power and switch_ranges as `attr or {}`: every falsy value is the empty mapping", () => {
  for (const value of [...falsy, undefined]) {
    assert.deepEqual(planOverrides(value).entries, {}, `overrides ${JSON.stringify(value)}`);
    assert.deepEqual(reveal(planMapping(value)), {}, `power ${JSON.stringify(value)}`);
  }
  assert.deepEqual(reveal(planMapping({ room: true })), { room: true });
});

test('ls_plan reads a saved truthy non-mapping overrides, power or switch_ranges as {} (lenient saved-value directive)', () => {
  // Captured `overrides.items()` and the callees' `.get`/`.items()` raise on it.
  for (const value of ['x', [1], 5, true] as JsonValue[]) {
    assert.deepEqual(planOverrides(value).entries, {}, JSON.stringify(value));
    assert.deepEqual(reveal(planMapping(value)), {}, JSON.stringify(value));
  }
});

const builtInRanges = { bright: [90, 100], cosy: [30, 60] };
test('range_defaults takes the built-in ranges for every Jinja-falsy value (ls_plan and ls_room_plan)', () => {
  for (const value of [...falsy, undefined]) {
    assert.deepEqual(reveal(planRangeDefaults(value)), builtInRanges, `ls_plan ${JSON.stringify(value)}`);
    assert.deepEqual(reveal(rangeDefaults(value)), builtInRanges, `ls_room_plan ${JSON.stringify(value)}`);
  }
  assert.deepEqual(reveal(planRangeDefaults({ bright: [80, 90] })), { bright: [80, 90] });
  assert.deepEqual(reveal(rangeDefaults({ bright: [80, 90] })), { bright: [80, 90] });
});

test('a saved truthy non-mapping range_defaults is the built-in ranges (ls_plan and ls_room_plan)', () => {
  for (const value of ['x', [1], 5, true] as JsonValue[]) {
    assert.deepEqual(reveal(planRangeDefaults(value)), builtInRanges, `ls_plan ${JSON.stringify(value)}`);
    assert.deepEqual(reveal(rangeDefaults(value)), builtInRanges, `ls_room_plan ${JSON.stringify(value)}`);
  }
});
