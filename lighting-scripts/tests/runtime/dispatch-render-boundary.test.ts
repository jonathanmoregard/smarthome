import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { typed } from '../../src/runtime/entrypoints.ts';
import type { JsonObject, ScriptHandlers, Snapshot } from '../../src/runtime/context.ts';

/**
 * Boundary characterization for `ls_render` and `ls_dispatch`: the bytes they
 * forward, the leniency of the plan documents they read, and where a raise
 * happens.
 */
const now = '2026-10-26T12:00:00.000Z';
function snapshot(overrides: JsonObject, runtime: JsonObject = {}): Snapshot {
  return { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio' },
    catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' }, multicast: [], effects: {} },
    state: {
      'sensor.ls_overrides': { state: '0', attributes: overrides, last_updated: now },
      'sensor.ls_effects_runtime': { state: '0', attributes: { generation: 'g', plan_order: 0, ...runtime } },
      'sensor.ls_cache_studio': { state: '0', attributes: { cache: { keep: 1, gradients: {} } } },
      'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
      'light.lamp': { state: 'on', attributes: {} },
      'light.bulb': { state: 'on', attributes: {} },
    } };
}

/** The real handlers, with `ls_dispatch` replaced by a stub that records what it was handed. */
function capturing(extra: ScriptHandlers): { registry: ScriptHandlers; seen: JsonObject[] } {
  const seen: JsonObject[] = [];
  const registry: ScriptHandlers = { ...handlers, ...extra,
    ls_dispatch: typed('ls_dispatch', { parse: args => args, run: (_ctx, args) => { seen.push(structuredClone(args)); return null; } }) };
  return { registry, seen };
}

test('a room render forwards other rooms\' stored targets in place; a container area never matches the room', () => {
  const { registry, seen } = capturing({ ls_room_plan: () => ({ plan: {
    resolved: { targets: { 'light.n': { area: 'studio' } }, assignments: { 'light.n': { effect: 'x' } } },
    base: { 'light.n': { send: true } }, switches: { 'switch.s': { on: true } }, mirror: [{ entity: 'input_select.x', option: 'Day' }],
    stale_keys: ['k'], sara_mirror: 'on',
  } }) });
  const runtime = { targets: { 'light.a': { area: ['studio'], x: 1 }, 'light.b': { area: 'studio' }, 'light.c': { area: 'elsewhere' } },
    assignments: { 'light.b': { area: 'studio' }, 'light.c': 7 } };
  execute({ script: 'ls_render', args: {}, snapshot: snapshot({ pending_rooms: { studio: 'r1' }, overrides: {} }, runtime) }, registry);
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen[0]!.plan), JSON.stringify({
    base: { 'light.n': { send: true } },
    resolved: {
      targets: { 'light.a': { area: ['studio'], x: 1 }, 'light.c': { area: 'elsewhere' }, 'light.n': { area: 'studio' } },
      assignments: { 'light.c': 7, 'light.n': { effect: 'x' } },
    },
    switches: { 'switch.s': { on: true } }, mirror: [{ entity: 'input_select.x', option: 'Day' }], stale_keys: ['k'],
    revision: now, plan_order: Date.parse(now) / 1000, remote: false, remote_rooms: ['studio'], sara_mirror: 'on',
    output_targets: ['light.n'],
  }));
  assert.deepEqual(seen[0]!.lights, []);
});

test('a room plan that is not a mapping reads as an empty plan', () => {
  const { registry, seen } = capturing({ ls_room_plan: () => ({ plan: 7, cache_update: [] }) });
  execute({ script: 'ls_render', args: {}, snapshot: snapshot({ pending_rooms: { studio: 'r1' } }) }, registry);
  assert.deepEqual(seen[0]!.plan, { base: {}, resolved: { targets: {}, assignments: {} }, switches: {}, mirror: [], stale_keys: [],
    revision: now, plan_order: Date.parse(now) / 1000, remote: false, remote_rooms: ['studio'], sara_mirror: null, output_targets: [] });
});

test('a room plan whose mirror is present but not a list raises', () => {
  const { registry } = capturing({ ls_room_plan: () => ({ plan: { mirror: 5 } }) });
  assert.throws(() => execute({ script: 'ls_render', args: {}, snapshot: snapshot({ pending_rooms: { studio: 'r1' } }) }, registry),
    /schedule list/);
});

test('a full render refreshes room-cache gradients for string areas only, keeping the cache\'s other keys', () => {
  const { registry, seen } = capturing({ ls_plan: () => ({ plan: {
    base: { 'light.a': { area: 'studio' }, 'light.b': { area: ['studio'] }, 'light.c': { area: '' } },
    gradients: { 'light.a': { g: 1 }, 'light.b': { g: 2 } }, revision: 'r',
  } }) });
  const { calls } = execute({ script: 'ls_render', args: {}, snapshot: snapshot({ pending_rooms: {}, full_version: 'v1' }) }, registry);
  const cache = calls.find(call => call.target?.entity_id === 'sensor.ls_cache_studio');
  assert.equal(JSON.stringify(cache?.data.attributes), JSON.stringify({ cache: { keep: 1, gradients: { 'light.a': { g: 1 } } } }));
  assert.equal(JSON.stringify(seen[0]!.plan), JSON.stringify({
    base: { 'light.a': { area: 'studio' }, 'light.b': { area: ['studio'] }, 'light.c': { area: '' } },
    gradients: { 'light.a': { g: 1 }, 'light.b': { g: 2 } }, revision: 'r', remote_rooms: [],
  }));
});

test('dispatch reads a non-mapping baseline entry only for a lamp that reaches the baseline check', () => {
  const target = { area: 'studio', on: true, brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
  const plan = { revision: now, plan_order: 1, base: { 'light.lamp': 5 }, resolved: { targets: { 'light.lamp': target }, assignments: {} } };
  assert.throws(() => execute({ script: 'ls_dispatch', args: { plan }, snapshot: snapshot({}) }, handlers),
    /ls_dispatch\.plan\.base\.light\.lamp must be an object/);
  const off = snapshot({});
  off.state['light.lamp']!.state = 'off';
  assert.doesNotThrow(() => execute({ script: 'ls_dispatch', args: { plan }, snapshot: off }, handlers));
});
