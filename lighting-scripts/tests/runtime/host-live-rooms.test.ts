import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ServiceCall, Snapshot } from '../../src/runtime/context.ts';
import { execute } from '../../src/runtime/engine.ts';
import { LightingHost } from '../../src/runtime/host.ts';
import type { OutputScope } from '../../src/runtime/host.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { liveScope } from '../../src/runtime/live-rooms.ts';
import { parseLiveRooms } from '../../src/parse/live-rooms.ts';

const runtime = 'sensor.ls_effects_runtime';
const overrides = { state: '1', attributes: {}, last_updated: 'r1' };
const bare: Snapshot = { now: '2026-10-26T12:00:00Z', areas: {}, members: [], state: {
  'sensor.ls_overrides': overrides,
  [runtime]: { state: '1', attributes: { generation: 1, applied: {} } },
} };
const directory = () => mkdtemp(join(tmpdir(), 'lighting-live-rooms-'));
const notDen: OutputScope = { sends: call => call.data.topic !== 'den', keeps: () => false };

test('a call the scope does not send is skipped, and the batch still succeeds', async () => {
  const calls: ServiceCall[] = [];
  const host = await LightingHost.open({ path: join(await directory(), 'state.json'), initial: bare, autoTimers: false, scope: notDen,
    program: request => execute(request, { render: ctx => {
      ctx.emit('mqtt.publish', { topic: 'den' }); ctx.emit('mqtt.publish', { topic: 'studio' });
      ctx.emit('variable.update_sensor', { attributes: { applied: { 'light.studio': 1 } } }, { entity_id: runtime },
        { revision: 'r1', generation: 1, requiresOutputSuccess: true });
      return null;
    } }),
    transport: { send: async call => { calls.push(call); }, close: async () => {} } });
  try {
    await host.dispatch('render'); await host.drain();
    assert.deepEqual(calls.filter(call => call.service === 'mqtt.publish').map(call => call.data.topic), ['studio']);
    assert.deepEqual(host.snapshot().state[runtime]?.attributes.applied, { 'light.studio': 1 });
    assert.equal(host.recoveryRequired, false);
  } finally { await host.close(); }
});

test('a kept entity\'s writes stay in the process', async () => {
  const calls: ServiceCall[] = [];
  const keepsRuntime: OutputScope = { sends: call => call.target?.entity_id !== runtime, keeps: entity => entity === runtime };
  const host = await LightingHost.open({ path: join(await directory(), 'state.json'), initial: bare, autoTimers: false, scope: keepsRuntime,
    program: request => execute(request, { mark: ctx => {
      ctx.emit('variable.update_sensor', { value: 'local', attributes: { applied: { 'light.studio': 2 } } }, { entity_id: runtime });
      return null;
    } }),
    transport: { send: async call => { calls.push(call); }, close: async () => {} } });
  try {
    await host.dispatch('mark'); await host.drain();
    assert.deepEqual(calls, []);
    assert.deepEqual(host.snapshot().state[runtime]?.attributes.applied, { 'light.studio': 2 });
  } finally { await host.close(); }
});

test('a kept entity is read from Home Assistant once, then never again', async () => {
  const keepsRuntime: OutputScope = { sends: () => true, keeps: entity => entity === runtime };
  const seedless: Snapshot = { ...bare, state: { 'sensor.ls_overrides': overrides } };
  const host = await LightingHost.open({ path: join(await directory(), 'state.json'), initial: seedless, autoTimers: false,
    scope: keepsRuntime, program: request => execute(request, {}), transport: { send: async () => {}, close: async () => {} } });
  try {
    const theirs = (applied: string) => ({ state: '2', attributes: { applied: { [applied]: 1 } }, last_updated: '2026-10-26T12:00:01Z' });
    await host.ingestState(runtime, theirs('first'));
    assert.deepEqual(host.snapshot().state[runtime]?.attributes.applied, { first: 1 });
    await host.ingestState(runtime, { ...theirs('second'), last_updated: '2026-10-26T12:00:02Z' });
    await host.refresh(async previous => ({ ...previous, state: { ...previous.state, [runtime]: { ...theirs('third'),
      last_updated: '2026-10-26T12:00:03Z' } } }));
    await host.ingestState(runtime, null);
    assert.deepEqual(host.snapshot().state[runtime]?.attributes.applied, { first: 1 });
  } finally { await host.close(); }
});

/** Two made-up rooms with one scheduled lamp each; both port switches are on. */
function twoRooms(): Snapshot {
  const snapshot: Snapshot = { now: '2026-10-26T12:00:00Z', members: ['light.studio', 'light.den'], areas: { 'light.studio': 'studio',
    'light.studio_bulb': 'studio', 'light.den': 'den', 'light.den_bulb': 'den' }, catalog: {
    members: { 'light.studio': ['light.studio_bulb'], 'light.den': ['light.den_bulb'] }, groups: {}, effects: {}, processors: {},
    topics: { 'light.studio_bulb': 'zigbee2mqtt/studio_bulb/set', 'light.den_bulb': 'zigbee2mqtt/den_bulb/set' }, multicast: [],
    ui_rows: [], ui_discovery: [], remotes: {},
  }, state: {
    'sensor.ls_overrides': { state: '0', attributes: { overrides: {} }, last_updated: '2026-10-26T11:00:00Z' },
    [runtime]: { state: '0', attributes: { assignments: {}, targets: {}, applied: {}, handled_rooms: {} } },
    'light.studio': { state: 'on', attributes: { brightness: 10 } }, 'light.studio_bulb': { state: 'on', attributes: {} },
    'light.den': { state: 'on', attributes: { brightness: 10 } }, 'light.den_bulb': { state: 'on', attributes: {} },
    'binary_sensor.zigbee2mqtt_bridge_connection_state': { state: 'on', attributes: {} },
    'input_boolean.ls_studio_on_port': { state: 'on', attributes: {} }, 'input_boolean.ls_den_on_port': { state: 'on', attributes: {} },
  } };
  for (const [period, hour, brightness, kelvin] of [['day', '07:00:00', 220, 4000], ['cosy', '18:00:00', 110, 2200],
    ['night', '23:00:00', 3, 2000]] as const) {
    for (const type of ['start', 'weekend']) snapshot.state[`input_datetime.ls_house_${period}_${type}`] = { state: hour, attributes: {} };
    snapshot.state[`input_number.ls_house_${period}_fade`] = { state: '20', attributes: {} };
    snapshot.state[`input_text.ls_house_${period}`] = { state: JSON.stringify({ on: true, b: brightness, m: 'ct', k: kelvin }), attributes: {} };
    snapshot.state[`light.ls_house_${period}`] = { state: 'on', attributes: { brightness, color_mode: 'color_temp', color_temp_kelvin: kelvin } };
  }
  return snapshot;
}

async function applyHouse(live: string): Promise<{ calls: ServiceCall[]; errors: string[]; host: LightingHost }> {
  const calls: ServiceCall[] = [], errors: string[] = [];
  const host = await LightingHost.open({ path: join(await directory(), 'state.json'), initial: twoRooms(), autoTimers: false,
    scope: liveScope(parseLiveRooms(live)), report: message => errors.push(message), program: request => execute(request, handlers),
    transport: { send: async call => { calls.push(call); }, close: async () => {} } });
  await host.dispatch('ls_apply', { reason: 'config' }); await host.drain();
  return { calls, errors, host };
}
const bulbTopics = (calls: ServiceCall[]) => calls.filter(call => call.service === 'mqtt.publish').map(call => call.data.topic);

test('the schedule computes every room but reaches only the lamps of live rooms', async () => {
  const { calls, errors, host } = await applyHouse('studio');
  try {
    assert.deepEqual(errors, []);
    assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/studio_bulb/set']);
    // Both rooms were computed: the kept bookkeeping records both lamps' targets.
    const targets = host.snapshot().state[runtime]?.attributes.targets;
    assert.ok(targets !== undefined && targets !== null && typeof targets === 'object');
    assert.deepEqual(Object.keys(targets).filter(key => key.startsWith('light.')).sort(), ['light.den', 'light.studio']);
    assert.equal(calls.some(call => call.target?.entity_id === runtime), false);
    assert.equal(calls.some(call => call.target?.entity_id === 'sensor.ls_overrides'), true);
  } finally { await host.close(); }
});

test('with an empty live-room list the schedule reaches no lamp', async () => {
  const { calls, host } = await applyHouse('');
  try { assert.deepEqual(bulbTopics(calls), []); } finally { await host.close(); }
});
