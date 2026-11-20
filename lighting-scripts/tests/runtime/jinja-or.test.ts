import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { typed } from '../../src/runtime/entrypoints.ts';
import type { JsonObject, JsonValue, ScriptHandlers, Snapshot } from '../../src/runtime/context.ts';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { context } from './gestures-context.ts';
import { house } from './house-view.ts';
import { reveal } from '../../src/runtime/verbatim.ts';
import { dispatchPlanOrder } from '../../src/parse/dispatch-render.ts';
import { runtimePlanOrder } from '../../src/parse/transport.ts';
import { planMapping, planOverrides, planRangeDefaults } from '../../src/parse/controller.ts';
import { rangeDefaults } from '../../src/parse/planning.ts';

/**
 * Captured Jinja `or` / `and` over stored attributes. Jinja's falsy set holds
 * `[]` and `{}` and not NaN; JavaScript's is the other way round, so `||` and
 * `&&` on the raw value diverge both ways. Home Assistant 2026.7.4 renders
 * `{{ {} or 'config' }}` as `'config'` and `{{ {} or [] }}` as `[]`.
 */
const now = '2026-10-26T12:00:00.000Z';

function fullRender(attributes: JsonObject): { reason: JsonValue | undefined; lights: JsonValue | undefined } {
  const seen: { reason?: JsonValue; lights?: JsonValue } = {};
  const registry: ScriptHandlers = { ...handlers,
    ls_plan: (_ctx, args) => { seen.reason = args.reason; return { plan: {} }; },
    ls_dispatch: typed('ls_dispatch', { parse: args => args, run: (_ctx, args) => { seen.lights = structuredClone(args.lights); return null; } }) };
  const snapshot: Snapshot = { now, members: [], areas: {}, state: {
    'sensor.ls_overrides': { state: '0', last_updated: now, attributes: { full_version: 'v1', pending_rooms: {}, ...attributes } },
    'sensor.ls_effects_runtime': { state: '0', attributes: { generation: 'g', plan_order: 0 } },
  } };
  execute({ script: 'ls_render', args: {}, snapshot }, registry);
  return { reason: seen.reason, lights: seen.lights };
}

test('ls_render passes config as the plan reason for an empty-container full_reason', () => {
  // Captured: `state_attr('sensor.ls_overrides','full_reason') or 'config'`.
  for (const empty of [{}, []] as JsonValue[]) {
    assert.equal(fullRender({ full_reason: empty }).reason, 'config', `full_reason ${JSON.stringify(empty)}`);
  }
});

test('ls_render keeps a truthy full_reason as the plan reason', () => {
  assert.equal(fullRender({ full_reason: 'tick' }).reason, 'tick');
  assert.equal(fullRender({}).reason, 'config');
});

test('ls_render hands ls_dispatch an empty light list for an empty-mapping full_lights', () => {
  // Captured: `state_attr('sensor.ls_overrides','full_lights') or []`.
  assert.deepEqual(fullRender({ full_lights: {} }).lights, []);
  assert.deepEqual(fullRender({ full_lights: ['light.a'] }).lights, ['light.a']);
});

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
const runtimeView = (plan_order: JsonValue) => house({ 'sensor.ls_effects_runtime': ['0', { plan_order }] });

test('the runtime plan order is 0 for every Jinja-falsy value (ls_dispatch and effects_assign: `plan_order or 0`)', () => {
  for (const value of falsy) {
    assert.equal(dispatchPlanOrder(runtimeView(value)), 0, `ls_dispatch ${JSON.stringify(value)}`);
    assert.equal(runtimePlanOrder(runtimeView(value)), 0, `effects_assign ${JSON.stringify(value)}`);
  }
  assert.equal(dispatchPlanOrder(house({ 'sensor.ls_effects_runtime': ['0', {}] })), 0);
  assert.equal(dispatchPlanOrder(runtimeView(7)), 7);
  assert.equal(runtimePlanOrder(runtimeView(7)), 7);
});

test('a truthy non-number runtime plan order still raises', () => {
  // Captured `plan.plan_order >= ('x' or 0)` compares a number with a string: TypeError.
  for (const value of ['x', [1], { a: 1 }] as JsonValue[]) {
    assert.throws(() => dispatchPlanOrder(runtimeView(value)), /plan_order/, `ls_dispatch ${JSON.stringify(value)}`);
    assert.throws(() => runtimePlanOrder(runtimeView(value)), /plan_order/, `effects_assign ${JSON.stringify(value)}`);
  }
});

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
