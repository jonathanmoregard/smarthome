import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { typed } from '../../src/runtime/entrypoints.ts';
import type { TypedName, TypedResults } from '../../src/runtime/entrypoints.ts';
import { controllerHandlers } from '../../src/domain/controller.ts';
import { context } from './gestures-context.ts';

/**
 * Boundary characterization for the controller: what `ls_plan` forwards and
 * when its attribute reads raise, how `ls_switch_plan` reads a rule and its
 * room target, and `ls_apply`'s verbatim dry run.
 */
function recording<K extends TypedName>(seen: Record<string, JsonObject>, name: K, result: () => TypedResults[K]) {
  return typed(name, { parse: args => args, run: (_ctx, args) => { seen[name] = structuredClone(args); return result(); } });
}

function planContext(attributes: JsonObject) {
  const seen: Record<string, JsonObject> = {};
  const ctx = context({
    ...controllerHandlers,
    ls_base: recording(seen, 'ls_base', () => ({ targets: {}, schedule: {
      cmds: [], profiles: {}, revision: 'r', stale_keys: ['old'], sched: {}, schedule_details: {}, mirror: [], sara_mirror: null,
    } })),
    effects_catalog: () => ({}),
    effects_gradient_plan: recording(seen, 'effects_gradient_plan', () => ({ gradients: {} })),
    effects_resolve: recording(seen, 'effects_resolve', () => ({ targets: {}, assignments: {} })),
    ls_switch_plan: recording(seen, 'ls_switch_plan', () => ({ switches: {} })),
  });
  ctx.put('sensor.ls_overrides', '0', attributes);
  ctx.state['sensor.ls_overrides']!.last_updated = ctx.now;
  return { ctx, seen };
}

test('ls_plan forwards the stored overrides to the baseline and only the live ones to the resolver', () => {
  const overrides = { old: { a: 1 }, keep: { b: [2] }, 'mode:sara': { kind: 'mode' } };
  const { ctx, seen } = planContext({ overrides, power: { studio: false } });
  ctx.run('ls_plan', {});
  assert.equal(JSON.stringify(seen.ls_base!.overrides), JSON.stringify(overrides));
  assert.equal(JSON.stringify(seen.effects_resolve!.overrides), JSON.stringify({ keep: { b: [2] }, 'mode:sara': { kind: 'mode' } }));
  assert.equal(seen.effects_resolve!.sara, true);
  assert.deepEqual(seen.effects_resolve!.power, { studio: false });
  assert.deepEqual(seen.ls_switch_plan!.ranges, {});
  assert.deepEqual(seen.ls_switch_plan!.defaults, { bright: [90, 100], cosy: [30, 60] });
});

test('ls_plan refuses a present non-mapping power only after the gradient plan', () => {
  const { ctx, seen } = planContext({ overrides: {}, power: 5 });
  assert.throws(() => ctx.run('ls_plan', {}), /ls_plan\.power.*object/);
  assert.ok(seen.effects_gradient_plan);
  assert.equal(seen.effects_resolve, undefined);
});

test('ls_switch_plan reads a room level with Number() and requires on only for an applying rule', () => {
  const ctx = context(controllerHandlers);
  ctx.areas = { 'switch.s': 'studio', 'switch.t': 'void', 'switch.u': 'hall' };
  const result = ctx.run('ls_switch_plan', {
    targets: { 'room:studio': { level: '255', on: true }, 'room:hall': { level: 255, on: 'yes' } },
    ranges: { 'switch.s': { profile: 'bright' }, 'switch.t': { profile: 'bright' }, 'switch.u': { profile: 'custom', min: 5 } },
    defaults: { bright: [90, 100] },
  });
  assert.deepEqual(result, { switches: { 'switch.s': { on: true, room: 'studio', brightness: 100, range: [90, 100] } } });
});

test('ls_apply\'s dry run answers whatever answered to ls_plan, unread', () => {
  for (const marker of [{ marker: ['literal', 7] }, ['literal', 7], null]) {
    const ctx = context({ ...controllerHandlers, ls_plan: () => marker });
    assert.deepEqual(ctx.run('ls_apply', { dry_run: true }), marker);
  }
});
