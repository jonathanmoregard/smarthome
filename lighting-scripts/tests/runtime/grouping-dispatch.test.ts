import assert from 'node:assert/strict';
import test from 'node:test';
import { execute } from '../../src/runtime/engine.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';
const revision = '2026-10-26T12:00:00+01:00';
const target = { is_room: false, area: 'studio', period: 'day', on: true, level: 150, transition: 3, brightness: { kind: 'constant', value: 150 }, color: { kind: 'constant', value: { kelvin: 3000 } } };
function snapshot(): Snapshot {
  return { now: revision, members: ['light.lamp'], areas: { 'light.lamp': 'studio' }, catalog: { members: { 'light.lamp': ['light.endpoint'] }, topics: { 'light.endpoint': 'zigbee2mqtt/lamp/set' }, multicast: [], effects: {} }, state: {
    'sensor.ls_overrides': { state: '0', attributes: {}, last_updated: revision },
    'sensor.ls_effects_runtime': { state: '0', attributes: { assignments: {}, applied: {}, targets: {}, generation: 'old' } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'light.lamp': { state: 'on', attributes: {} }, 'light.endpoint': { state: 'on', attributes: { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 } },
  } };
}
function plan(): JsonObject { return { revision, plan_order: Date.parse(revision) / 1000, base: { 'light.lamp': { send: true } }, resolved: { targets: { 'light.lamp': target }, assignments: {} }, switches: {}, mirror: [], stale_keys: [], sara_mirror: null }; }
async function handlers() {
  const modulePath = '../../src/domain/dispatch-render.ts';
  const port = await import(modulePath).catch(() => ({}));
  assert.equal(typeof port.dispatchHandlers?.ls_dispatch, 'function', 'dispatcher exists');
  const registry = await import('../../src/runtime/registry.ts');
  return { ...registry.handlers, ...port.dispatchHandlers };
}

test('stale override revision and older same-revision plan reject without output or state change', async () => {
  const registry = await handlers();
  for (const stale of [{ ...plan(), revision: 'old' }, { ...plan(), plan_order: 0 }]) {
    const initial = snapshot(); initial.state['sensor.ls_effects_runtime'].attributes.plan_order = 1;
    const result = execute({ script: 'ls_dispatch', args: { plan: stale }, snapshot: initial }, registry);
    assert.deepEqual(result.snapshot, initial);
    assert.deepEqual(result.calls, []);
    assert.equal(result.result, null);
  }
});

test('dispatch marks applied only with an output-success fence after completed emission', async () => {
  const result = execute({ script: 'ls_dispatch', args: { plan: plan() }, snapshot: snapshot() }, await handlers());
  assert.equal(result.result.completed, true);
  const applied = result.calls.find(c => c.service === 'variable.update_sensor' && c.data.attributes.applied?.['light.lamp']);
  assert.ok(applied);
  assert.equal(applied.guard.requiresOutputSuccess, true);
  assert.equal(applied.guard.revision, revision);
  assert.deepEqual(result.snapshot.state['sensor.ls_effects_runtime'].attributes.applied, { 'light.lamp': target });
});

test('revision change during publication prevents applied bookkeeping and stale override clearing', async () => {
  const current = plan(); current.stale_keys = ['expired'];
  const result = execute({ script: 'ls_dispatch', args: { plan: current }, snapshot: snapshot() }, await handlers(), {
    afterService(call, ctx) {
      if (call.service === 'mqtt.publish' && String(call.data.topic).startsWith('zigbee2mqtt/')) {
        ctx.now = '2026-10-26T12:00:01+01:00'; ctx.put('sensor.ls_overrides', '1', { overrides: { refreshed: {} } });
      }
    },
  });
  assert.equal(result.result, null);
  assert.deepEqual(result.events, []);
  assert.equal(result.snapshot.state['sensor.ls_effects_runtime'].attributes.applied['light.lamp'], undefined);
});

test('room render coalesces pending versions and keeps unrelated room state without resending it', async () => {
  const initial = snapshot();
  initial.state['sensor.ls_overrides'].attributes = { pending_rooms: { studio: 'request-1' }, overrides: {}, full_version: null };
  const other = { ...target, area: 'elsewhere' };
  initial.state['sensor.ls_effects_runtime'].attributes.targets = { 'light.other': other };
  initial.state['sensor.ls_effects_runtime'].attributes.applied = { 'light.other': other };
  initial.state['sensor.ls_cache_studio'] = { state: '0', attributes: {} };
  for (const [period, time] of [['day', '07:00:00'], ['cosy', '18:00:00'], ['night', '23:00:00']]) {
    for (const suffix of ['start', 'weekend']) initial.state[`input_datetime.ls_house_${period}_${suffix}`] = { state: time, attributes: {} };
    initial.state[`light.ls_house_${period}`] = { state: 'on', attributes: { brightness: 150, color_mode: 'color_temp', color_temp_kelvin: 3000 } };
    initial.state[`input_text.ls_house_${period}`] = { state: '{"on":true,"b":150}', attributes: {} };
  }
  const result = execute({ script: 'ls_render', args: {}, snapshot: initial }, await handlers());
  const runtime = result.snapshot.state['sensor.ls_effects_runtime'].attributes;
  assert.deepEqual(runtime.targets['light.other'], other);
  assert.deepEqual(runtime.handled_rooms, { studio: 'request-1' });
  assert.deepEqual(runtime.last_latency.rooms, ['studio']);
  const successful = result.calls.find(c => c.service === 'variable.update_sensor' && c.data.attributes.handled_rooms);
  assert.equal(successful.guard.requiresOutputSuccess, true);
  assert.equal(result.calls.filter(c => c.service === 'mqtt.publish' && String(c.data.topic).startsWith('zigbee2mqtt/')).length, 1);
  const repeat = execute({ script: 'ls_render', args: {}, snapshot: result.snapshot }, await handlers());
  assert.deepEqual(repeat.calls, []);
});
