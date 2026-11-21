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
import { RoomHandover, ingestChange } from '../../src/main.ts';

const runtime = 'sensor.ls_effects_runtime';
const overrides = { state: '1', attributes: {}, last_updated: 'r1' };
const bare: Snapshot = { now: '2026-10-26T12:00:00Z', areas: {}, members: [], state: {
  'sensor.ls_overrides': overrides,
  [runtime]: { state: '1', attributes: { generation: 1, applied: {} } },
} };
const directory = () => mkdtemp(join(tmpdir(), 'lighting-live-rooms-'));
const notDen: OutputScope = { origin: () => ({ kind: 'house' }), share: call => call.data.topic === 'den' ? [] : [call], keeps: () => false };

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
  const keepsRuntime: OutputScope = { origin: () => ({ kind: 'house' }), share: call => call.target?.entity_id === runtime ? [] : [call],
    keeps: entity => entity === runtime };
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
  const keepsRuntime: OutputScope = { origin: () => ({ kind: 'house' }), share: call => [call], keeps: entity => entity === runtime };
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

/** The two rooms with a verified multicast group over both rooms' bulbs, as the candle cross groups are. */
function crossGroup(): Snapshot {
  const snapshot = twoRooms();
  if (snapshot.catalog !== undefined) snapshot.catalog.multicast = [{ id: 'cross', topic: 'zigbee2mqtt/cross/set', verified: true,
    members: ['light.den_bulb', 'light.studio_bulb'] }];
  return snapshot;
}

async function applyHouse(live: string, initial: Snapshot = twoRooms()): Promise<{ calls: ServiceCall[]; errors: string[]; host: LightingHost }> {
  const calls: ServiceCall[] = [], errors: string[] = [];
  const host = await LightingHost.open({ path: join(await directory(), 'state.json'), initial, autoTimers: false,
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
    assert.equal(calls.some(call => call.target?.entity_id === 'sensor.ls_overrides'), false, 'the old scripts commit house events');
  } finally { await host.close(); }
});

test('with an empty live-room list the port sends nothing at all', async () => {
  const { calls, host } = await applyHouse('');
  try { assert.deepEqual(calls, []); } finally { await host.close(); }
});

test('a house event commits nothing house-wide while a room is still on the old scripts', async () => {
  const { calls, host } = await applyHouse('studio');
  try {
    assert.deepEqual(calls.filter(call => call.service !== 'mqtt.publish'), []);
    assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/studio_bulb/set']);
  } finally { await host.close(); }
});

test('a group publish over a driven and an old-scripts room reaches the driven lamp on its own topic', async () => {
  const { calls, errors, host } = await applyHouse('studio', crossGroup());
  try {
    assert.deepEqual(errors, []);
    assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/studio_bulb/set']);
  } finally { await host.close(); }
});

test('with every room driven the group publish goes out whole', async () => {
  const { calls, host } = await applyHouse('studio,den', crossGroup());
  try { assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/cross/set']); } finally { await host.close(); }
});

test('a lamp switched on in a room the port does not drive does nothing in the port', async () => {
  const { calls, errors, host } = await applyHouse('studio');
  try {
    const before = host.snapshot(), sent = calls.length, reported = errors.length;
    await host.dispatch('automation.lighting_schedule_engine', { trigger: { platform: 'device', id: 'lamp_on', entity_id: 'light.den' } });
    await host.drain();
    assert.equal(calls.length, sent);
    assert.deepEqual(host.snapshot().state['sensor.ls_overrides'], before.state['sensor.ls_overrides']);
    assert.deepEqual(errors.slice(reported), ['Ignored automation.lighting_schedule_engine: not in a room the port drives']);
  } finally { await host.close(); }
});

test('a lamp switched on in a driven room reaches the port', async () => {
  const { calls, host } = await applyHouse('studio');
  try {
    const before = host.snapshot();
    await host.dispatch('automation.lighting_schedule_engine', { trigger: { platform: 'device', id: 'lamp_on', entity_id: 'light.studio' } });
    await host.drain();
    assert.notDeepEqual(host.snapshot().state['sensor.ls_overrides'], before.state['sensor.ls_overrides']);
    assert.ok(calls.length > 0);
    // The port is this input's one writer, so its record of the lamp-on reaches the shared store.
    assert.equal(calls.some(call => call.target?.entity_id === 'sensor.ls_overrides'), true);
  } finally { await host.close(); }
});

test('an input that arrives as its room is handed back is not run: the room is decided when the run starts', async () => {
  const { calls, errors, host } = await applyHouse('studio');
  try {
    const before = host.snapshot(), sent = calls.length;
    // Home Assistant reports the switch off, then the bridge delivers a press made just before it.
    const off = host.ingestState('input_boolean.ls_studio_on_port', { state: 'off', attributes: {}, last_updated: '2026-10-26T12:00:01Z' });
    const press = host.dispatch('automation.lighting_schedule_engine', { trigger: { platform: 'device', id: 'lamp_on', entity_id: 'light.studio' } });
    await off; await press; await host.drain();
    assert.equal(calls.length, sent);
    assert.deepEqual(host.snapshot().state['sensor.ls_overrides'], before.state['sensor.ls_overrides']);
    assert.match(errors.at(-1) ?? '', /^Ignored automation\.lighting_schedule_engine/);
  } finally { await host.close(); }
});

test('a timer of a room that is no longer driven is dropped, not run', async () => {
  const errors: string[] = [];
  const initial = twoRooms();
  initial.state['input_boolean.ls_studio_on_port'] = { state: 'off', attributes: {} };
  initial.scheduled = [{ script: 'ls_remote_gesture', args: { room: 'studio', command: 'power_done' }, due: 0 }];
  if (initial.catalog !== undefined) initial.catalog.remotes = { studio: { source: 'remote-studio', device_id: 'remote-s' } };
  initial.areas['remote-s'] = 'studio';
  const host = await LightingHost.open({ path: join(await directory(), 'state.json'), initial, autoTimers: false, now: () => 1,
    scope: liveScope(parseLiveRooms('studio')), report: message => errors.push(message), program: request => execute(request, handlers),
    transport: { send: async () => {}, close: async () => {} } });
  try {
    await host.runDue(); await host.drain();
    assert.deepEqual(host.snapshot().scheduled, []);
    assert.deepEqual(errors, ['Ignored ls_remote_gesture: not in a room the port drives']);
  } finally { await host.close(); }
});

test('handing a room to the port re-sends its lamps, even ones the port already sent', async () => {
  const { calls, host } = await applyHouse('studio');
  try {
    const handover = new RoomHandover(host, parseLiveRooms('studio'));
    await handover.reconcile(); await host.drain();
    calls.length = 0;
    await host.dispatch('ls_apply', { reason: 'config' }); await host.drain();
    assert.deepEqual(bulbTopics(calls), [], 'an unchanged lamp is not sent again by an ordinary apply');
    await ingestChange(host, handover, 'input_boolean.ls_studio_on_port', { state: 'off', attributes: {}, last_changed: '2026-10-26T12:00:01Z' });
    await ingestChange(host, handover, 'input_boolean.ls_studio_on_port', { state: 'on', attributes: {}, last_changed: '2026-10-26T12:00:02Z' });
    await host.drain();
    assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/studio_bulb/set']);
    calls.length = 0;
    await handover.reconcile(); await host.drain();
    assert.deepEqual(bulbTopics(calls), [], 'a room already handed over is not re-sent');
  } finally { await host.close(); }
});

test('a port switch turning on for a room not in the list hands nothing over', async () => {
  const { calls, host } = await applyHouse('studio');
  try {
    const handover = new RoomHandover(host, parseLiveRooms('studio'));
    await handover.reconcile(); await host.drain();
    calls.length = 0;
    await ingestChange(host, handover, 'input_boolean.ls_den_on_port', { state: 'off', attributes: {}, last_changed: '2026-10-26T12:00:01Z' });
    await ingestChange(host, handover, 'input_boolean.ls_den_on_port', { state: 'on', attributes: {}, last_changed: '2026-10-26T12:00:02Z' });
    await host.drain();
    assert.deepEqual(calls, []);
  } finally { await host.close(); }
});

/** Two driven-list rooms; den's switch starts off and the start-up hand-over has run. */
async function denOff(): Promise<{ calls: ServiceCall[]; host: LightingHost; handover: RoomHandover }> {
  const initial = twoRooms();
  initial.state['input_boolean.ls_den_on_port'] = { state: 'off', attributes: {}, last_changed: '2026-10-26T11:00:00Z' };
  const { calls, host } = await applyHouse('studio,den', initial);
  const handover = new RoomHandover(host, parseLiveRooms('studio,den'));
  await handover.reconcile(); await host.drain();
  calls.length = 0;
  return { calls, host, handover };
}
const reconnect = async (host: LightingHost, handover: RoomHandover, changes: Snapshot['state']) => {
  await host.connectionChanged(false);
  await host.refresh(async previous => ({ ...previous, state: { ...previous.state, ...changes } }));
  await host.connectionChanged(true);
  await handover.reconcile();
  await host.dispatch('ls_apply', { reason: 'config' }); await host.drain();
};

test('a port switch turned on while Home Assistant was out of reach hands its room over on reconnect', async () => {
  const { calls, host, handover } = await denOff();
  try {
    await reconnect(host, handover, { 'input_boolean.ls_den_on_port': { state: 'on', attributes: {}, last_changed: '2026-10-26T12:00:05Z' } });
    assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/den_bulb/set']);
  } finally { await host.close(); }
});

test('a port switch turned off and on again while out of reach still hands its room over again', async () => {
  const { calls, host, handover } = await denOff();
  try {
    await ingestChange(host, handover, 'input_boolean.ls_den_on_port', { state: 'on', attributes: {}, last_changed: '2026-10-26T12:00:01Z' });
    await host.drain();
    calls.length = 0;
    // The old scripts drove den for a while; only the switch's change time tells.
    await reconnect(host, handover, { 'input_boolean.ls_den_on_port': { state: 'on', attributes: {}, last_changed: '2026-10-26T12:00:09Z' } });
    assert.deepEqual(bulbTopics(calls), ['zigbee2mqtt/den_bulb/set']);
  } finally { await host.close(); }
});
