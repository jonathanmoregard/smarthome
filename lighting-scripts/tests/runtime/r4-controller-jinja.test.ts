import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { typed } from '../../src/runtime/entrypoints.ts';
import type { TypedName, TypedResults } from '../../src/runtime/entrypoints.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { context } from './gestures-context.ts';

/**
 * `ls_plan` and `ls_apply` only forward `test_now` (captured
 * `{{ test_now|default(none) }}`) and `test_overrides`; `ls_base` is the one
 * place that parses test_now. `ls_apply`'s gate is captured
 * `dry_run|default(false) or ((test_now is not defined or not test_now) and
 * test_overrides is not defined and not (force_all|default(false)))`, so
 * test_now there is a Jinja-truthiness test and nothing more.
 */
function recording<K extends TypedName>(seen: JsonObject[], name: K, result: () => TypedResults[K]) {
  return typed(name, { parse: args => args, run: (_ctx, args) => { seen.push({ [name]: structuredClone(args) }); return result(); } });
}
function planContext(overrides: JsonObject = { sensor: { kind: 'block' } }) {
  const seen: JsonObject[] = [];
  const ctx = context({
    ...controllerHandlers,
    ls_base: recording(seen, 'ls_base', () => ({ targets: {}, schedule: {
      cmds: [], profiles: {}, revision: 'r', stale_keys: [], sched: {}, schedule_details: {}, mirror: [], sara_mirror: null,
    } })),
    effects_catalog: () => ({}),
    effects_gradient_plan: recording(seen, 'effects_gradient_plan', () => ({ gradients: {} })),
    effects_resolve: recording(seen, 'effects_resolve', () => ({ targets: {}, assignments: {} })),
    ls_switch_plan: recording(seen, 'ls_switch_plan', () => ({ switches: {} })),
    ls_commit: (_ctx, args) => { seen.push({ ls_commit: structuredClone(args) }); return { accepted: true }; },
  });
  ctx.put('sensor.ls_overrides', '0', { overrides });
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  return { ctx, seen };
}
const baseArgs = (seen: JsonObject[]) => (seen.find(s => 'ls_base' in s)!.ls_base as JsonObject);

test('ls_plan forwards test_now unread, null when absent', () => {
  for (const value of [0, '', false, 'not a date', '2026-10-23T19:00:00+02:00', 1762000000, null] as JsonValue[]) {
    const { ctx, seen } = planContext();
    ctx.run('ls_plan', { test_now: value });
    assert.deepEqual(baseArgs(seen).test_now, value, JSON.stringify(value));
  }
  const { ctx, seen } = planContext();
  ctx.run('ls_plan', {});
  assert.equal(baseArgs(seen).test_now, null);
});

test('ls_plan falls back to the stored overrides for any test_overrides that is not a mapping', () => {
  for (const value of [[], 'x', 5, true, null] as JsonValue[]) {
    const { ctx, seen } = planContext();
    ctx.run('ls_plan', { test_overrides: value });
    assert.deepEqual(baseArgs(seen).overrides, { sensor: { kind: 'block' } }, JSON.stringify(value));
  }
  const { ctx, seen } = planContext();
  ctx.run('ls_plan', { test_overrides: { given: { kind: 'block' } } });
  assert.deepEqual(baseArgs(seen).overrides, { given: { kind: 'block' } });
});

test('ls_apply commits for a Jinja-falsy test_now, as for none at all', () => {
  for (const value of [0, '', false, null] as JsonValue[]) {
    const { ctx, seen } = planContext();
    assert.equal(ctx.run('ls_apply', { test_now: value }), null);
    assert.equal(seen.filter(s => 'ls_commit' in s).length, 1, JSON.stringify(value));
  }
});

test('ls_apply stops without parsing a truthy test_now when not a dry run', () => {
  for (const value of ['not a date', '2026-10-23T19:00:00+02:00', 1762000000, [1]] as JsonValue[]) {
    const { ctx, seen } = planContext();
    assert.equal(ctx.run('ls_apply', { test_now: value }), null);
    assert.deepEqual(seen, [], JSON.stringify(value));
  }
});

test('ls_apply forwards test_now and test_overrides to its dry-run plan unread', () => {
  for (const [test_now, test_overrides] of [[0, []], ['not a date', 'x'], ['2026-10-23T19:00:00+02:00', { a: {} }]] as [JsonValue, JsonValue][]) {
    const forwarded: JsonObject[] = [];
    const ctx = context({ ...controllerHandlers, ls_plan: (_ctx, args) => { forwarded.push(structuredClone(args)); return null; } });
    ctx.run('ls_apply', { dry_run: true, test_now, test_overrides });
    assert.deepEqual(forwarded, [{ reason: 'config', test_now, test_overrides }], JSON.stringify([test_now, test_overrides]));
  }
});

/**
 * `sensor.ls_overrides` attributes are state the scripts themselves save.
 * Captured `state_attr(...) or {}` (and `or {'bright':[90,100],'cosy':[30,60]}`
 * for range_defaults) raises downstream on a truthy non-mapping; by the lenient
 * saved-value directive (2026-11-19) such a value takes the same default.
 */
test("ls_plan reads saved sensor mappings leniently: a truthy non-mapping is the captured `or` default", () => {
  for (const bad of [5, 'x', [1], true] as JsonValue[]) {
    const { ctx, seen } = planContext();
    ctx.put('sensor.ls_overrides', '0', { overrides: bad, power: bad, switch_ranges: bad, range_defaults: bad });
    ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
    ctx.run('ls_plan', {});
    const args = (name: string) => seen.find(s => name in s)![name] as JsonObject;
    assert.deepEqual(args('ls_base').overrides, {}, JSON.stringify(bad));
    assert.deepEqual(args('effects_resolve').power, {}, JSON.stringify(bad));
    assert.deepEqual(args('ls_switch_plan').ranges, {}, JSON.stringify(bad));
    assert.deepEqual(args('ls_switch_plan').defaults, { bright: [90, 100], cosy: [30, 60] }, JSON.stringify(bad));
  }
});
