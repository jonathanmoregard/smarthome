import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LightingHost } from '../../src/runtime/host.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { ServiceCall, Snapshot } from '../../src/runtime/context.ts';

test('MQTT bridge remote goes through typed gesture, intent store, render and a dry physical sink', async () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const initial: Snapshot = { now: new Date(now).toISOString(), members: ['light.studio'], areas: { 'light.studio': 'studio', 'light.bulb': 'studio', remote: 'studio' }, catalog: {
    members: { 'light.studio': ['light.bulb'] }, groups: {}, effects: {}, processors: { 'Normal light': { remote_adjustment: 'gradient' } }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' }, multicast: [], ui_rows: [], ui_discovery: [], remotes: { studio: { source: 'mqtt-remote', device_id: 'remote' } },
  }, state: {
    'sensor.ls_overrides': { state: '0', attributes: { overrides: {} }, last_updated: '2026-10-26T11:00:00Z' },
    'sensor.ls_effects_runtime': { state: '0', attributes: { assignments: {}, targets: {}, applied: {}, handled_rooms: {} } },
    'light.studio': { state: 'on', attributes: { brightness: 220, color_mode: 'color_temp', color_temp_kelvin: 4000 } },
    'light.bulb': { state: 'on', attributes: { brightness: 220 } },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
  } };
  for (const [period, hour, brightness, kelvin] of [['day', '07:00:00', 220, 4000], ['cosy', '18:00:00', 110, 2200], ['night', '23:00:00', 3, 2000]] as const) {
    for (const type of ['start', 'weekend']) initial.state[`input_datetime.ls_house_${period}_${type}`] = { state: hour, attributes: {} };
    initial.state[`input_number.ls_house_${period}_fade`] = { state: '20', attributes: {} };
    initial.state[`input_text.ls_house_${period}`] = { state: JSON.stringify({ on: true, b: brightness, m: 'ct', k: kelvin }), attributes: {} };
    initial.state[`light.ls_house_${period}`] = { state: 'on', attributes: { brightness, color_mode: 'color_temp', color_temp_kelvin: kelvin } };
  }
  const directory = await mkdtemp(join(tmpdir(), 'lighting-remote-host-')), calls: ServiceCall[] = [], errors: string[] = [];
  const host = await LightingHost.open({ path: join(directory, 'state.json'), initial, autoTimers: false, now: () => now, report: message => errors.push(message), program: request => execute(request, handlers), transport: { send: async call => { calls.push(call); }, close: async () => {} } });
  try {
    await host.dispatch('automation.remote_directions', { room: 'studio', trigger: { platform: 'mqtt', topic: 'zigbee2mqtt/remote/action', payload: 'brightness_step_up', id: 'up' } });
    await host.drain();
    assert.deepEqual(errors, []);
    const emitted = calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === 'zigbee2mqtt/bulb/set');
    assert.equal(emitted.length, 1);
    assert.equal(JSON.parse(String(emitted[0]!.data.payload)).brightness, 224);
    const runtime = host.snapshot().state['sensor.ls_effects_runtime']!.attributes;
    assert.equal(runtime.targets['room:studio'].level, 223.5);
    assert.equal(Object.keys(host.snapshot().state['sensor.ls_overrides']!.attributes.overrides).length, 1);
  } finally { await host.close(); }
});
