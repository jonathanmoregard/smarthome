import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ScriptContext, ScriptHandler, ScriptHandlers, Snapshot } from '../../src/runtime/context.ts';
import type { TypedScriptHandler } from '../../src/runtime/entrypoints.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { stateStoreHandlers } from '../../src/handlers/state-store.ts';
import { context } from './gestures-context.ts';

/**
 * Every captured read of the overrides sensor's revision is the bare
 * `states.sensor.ls_overrides.last_updated.isoformat()`: no `default`, no
 * guard. With the sensor missing, `states.sensor.ls_overrides` is `None`, and
 * `.isoformat()` on the undefined attribute raises (verified against Home
 * Assistant 2026.7.4's template engine: `UndefinedError: 'None' has no
 * attribute 'last_updated'`). These pin that raise, at the point the captured
 * script reaches the read.
 */
const now = '2026-10-26T12:00:00.000Z';

function snapshot(state: Snapshot['state'] = {}): Snapshot {
  return { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio' },
    catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' }, multicast: [], effects: {} },
    state: {
      'sensor.ls_effects_runtime': { state: '0', attributes: { generation: 'g', plan_order: 0 } },
      'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
      'light.lamp': { state: 'on', attributes: {} },
      'light.bulb': { state: 'on', attributes: {} },
      ...state,
    } };
}

/**
 * The real handlers, each named script recorded as it is entered. A typed
 * handler is entered through its typed half, so that is the half wrapped.
 */
function recording(names: string[]): { registry: ScriptHandlers; entered: string[] } {
  const entered: string[] = [];
  const registry: ScriptHandlers = { ...handlers };
  for (const name of names) {
    const real = handlers[name] as ScriptHandler & Partial<TypedScriptHandler>;
    const shim: ScriptHandler = (ctx, args) => { entered.push(name); return real(ctx, args); };
    const entry = real.typed;
    registry[name] = entry === undefined ? shim
      : Object.assign(shim, { typed: { ...entry, run: (ctx: ScriptContext, args: unknown) => { entered.push(name); return entry.run(ctx, args); } } });
  }
  return { registry, entered };
}

test('ls_remote_plan raises on a missing overrides sensor', () => {
  assert.throws(() => execute({ script: 'ls_remote_plan', snapshot: snapshot(),
    args: { source: 'remote', area: 'studio', command: 'up' } }, handlers), /ls_remote_plan\.revision: sensor\.ls_overrides is missing/);
});

test('ls_room_plan raises on a missing overrides sensor before it runs any script', () => {
  // The captured read sits in the first variables block, ahead of every action.
  const { registry, entered } = recording(['ls_room_base', 'effects_catalog', 'effects_gradient_plan', 'effects_resolve', 'ls_switch_plan']);
  assert.throws(() => execute({ script: 'ls_room_plan', snapshot: snapshot(), args: { room: 'studio' } }, registry),
    /ls_room_plan\.revision: sensor\.ls_overrides is missing/);
  assert.deepEqual(entered, []);
});

test('ls_render raises on a missing overrides sensor', () => {
  assert.throws(() => execute({ script: 'ls_render', snapshot: snapshot(), args: {} }, handlers),
    /ls_render\.revision: sensor\.ls_overrides is missing/);
});

test('ls_dispatch raises on a missing overrides sensor at its stale-revision check', () => {
  const { registry, entered } = recording(['effects_catalog', 'effects_assign']);
  assert.throws(() => execute({ script: 'ls_dispatch', snapshot: snapshot(), args: { plan: {
    revision: now, plan_order: 1, resolved: { targets: {}, assignments: {} }, base: {}, switches: {}, mirror: [], stale_keys: [],
  }, lights: [] } }, registry), /ls_dispatch\.revision: sensor\.ls_overrides is missing/);
  assert.deepEqual(entered, []);
});

test('ls_commit raises on a missing overrides sensor even with no expected revision, and writes nothing', () => {
  // Captured: `data.get('expected_revision') in [none, <bare read>]` builds the
  // list, so the read happens whatever the expected revision is.
  const ctx = context(stateStoreHandlers);
  assert.throws(() => ctx.run('ls_commit', { data: { op: 'clear_all' } }), /ls_commit\.revision: sensor\.ls_overrides is missing/);
  assert.deepEqual(ctx.calls, []);
});

test('effects_assign raises on a missing overrides sensor and writes nothing', () => {
  const run = () => execute({ script: 'effects_assign', snapshot: snapshot(), args: { revision: now, targets: {}, assignments: {} } }, handlers);
  assert.throws(run, /effects_assign\.revision: sensor\.ls_overrides is missing/);
});

test('effects_emit raises on a missing overrides sensor with no commands, at its result', () => {
  // Captured result: `completed and <bare read> and ...`; `completed` starts true.
  assert.throws(() => execute({ script: 'effects_emit', snapshot: snapshot(), args: { commands: [], revision: now, generation: 'g' } }, handlers),
    /effects_emit\.revision: sensor\.ls_overrides is missing/);
});

test('effects_emit reads the revision before it reads the command', () => {
  // Captured: `allowed` opens with the bare read; the command's fields come after.
  assert.throws(() => execute({ script: 'effects_emit', snapshot: snapshot(), args: { commands: [{}], revision: now, generation: 'g' } }, handlers),
    /effects_emit\.revision: sensor\.ls_overrides is missing/);
});

const noon = '2026-10-23T12:00:00+02:00';
function configuredBase() {
  const ctx = context(scheduleHandlers);
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  return ctx;
}

test('ls_base raises on a missing overrides sensor', () => {
  assert.throws(() => configuredBase().run('ls_base', { test_now: noon, overrides: {} }), /ls_base\.revision: sensor\.ls_overrides is missing/);
});

test('ls_room_base raises on a missing overrides sensor', () => {
  assert.throws(() => configuredBase().run('ls_room_base', { room: 'studio', test_now: noon, overrides: {} }),
    /ls_room_base\.revision: sensor\.ls_overrides is missing/);
});

test('a present overrides sensor still answers with its last_updated', () => {
  const ctx = configuredBase();
  ctx.put('sensor.ls_overrides', '0', {});
  ctx.state['sensor.ls_overrides']!.last_updated = 'r1';
  const result = ctx.run('ls_base', { test_now: noon, overrides: {} }) as JsonObject;
  assert.equal((result.schedule as JsonObject).revision, 'r1');
});
