import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import { parseRooms } from '../../src/adapter/codecs/rooms.ts';
import { toRoomId } from '../../src/adapter/codecs/ids.ts';
import type { HaInput } from '../../src/adapter/codecs/inputs.ts';
import type { EntityState, JsonObject } from '../../src/adapter/ha-client.ts';
import type { Output } from '../../src/adapter/encode.ts';
import { parseLiveRooms, readLiveRoomsFlag, refuseUnknownRooms } from '../../src/adapter/live-rooms.ts';
import type { RoomsGiven } from '../../src/adapter/live-rooms.ts';
import { afterOutputs, handleInput } from '../../src/adapter/loop.ts';
import type { AdapterState, Turn } from '../../src/adapter/loop.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { bridged } from './support/inputs.ts';

/**
 * The rooms the live port drives (spec 5.4, plan M6 Task 1). A room is the port's when it is on the port's
 * `--live-rooms` list and its port switch is on; the old scripts drive the rest of the house, sharing the state
 * sensors with the port.
 */

/** A made-up house: two rooms with one lamp each, a lamp the registry puts in no room, and a room with only a remote. */
const catalog = parseCatalog({ members: { 'light.studio': ['light.studio_bulb'], 'light.den': ['light.den_bulb'],
  'light.loose': ['light.loose_bulb'] } });
const rooms = parseRooms({ 'light.studio': 'studio', 'light.den': 'den', 'remote-s': 'studio', 'remote-x': 'porch' });

test('the live rooms are refused when the setting is missing, so a missing list never means every room', () => {
  assert.throws(() => parseLiveRooms(undefined), /--live-rooms/);
  assert.throws(() => readLiveRoomsFlag(['--live', '--config', 'catalog.json']), /--live-rooms/);
  assert.throws(() => readLiveRoomsFlag(['--live-rooms', '--live']), /--live-rooms/);
});

test('an empty live-room setting is an empty list, and a list names its rooms', () => {
  assert.equal(parseLiveRooms('').size, 0);
  assert.equal(readLiveRoomsFlag(['--live-rooms', '']).size, 0);
  assert.deepEqual([...parseLiveRooms('studio,den')].sort(), ['den', 'studio']);
  assert.deepEqual([...readLiveRoomsFlag(['--live-rooms', 'studio'])], ['studio']);
});

test('a live-room list with an empty entry is refused', () => {
  assert.throws(() => parseLiveRooms('studio,,den'), /empty room/);
  assert.throws(() => parseLiveRooms('studio,'), /empty room/);
});

test("a live room that holds no lamp of the house is refused, naming it and the house's rooms; part of the house is a list", () => {
  // Break: a misspelt room is driven by neither system; or a list that leaves rooms to the old scripts is refused.
  assert.doesNotThrow(() => refuseUnknownRooms(parseLiveRooms('studio'), catalog, rooms));
  assert.doesNotThrow(() => refuseUnknownRooms(parseLiveRooms(''), catalog, rooms));
  assert.throws(() => refuseUnknownRooms(parseLiveRooms('studio,den,stduio'), catalog, rooms),
    { message: '--live-rooms names stduio, which holds no lamp of the house; its rooms are den, studio' });
  assert.throws(() => refuseUnknownRooms(parseLiveRooms('studio,porch'), catalog, rooms), /names porch/);
});

/**
 * The synthetic house shared with the old scripts: `room-a` (two lamps, `plug_a`, `remote-a`) and `room-b` (one
 * lamp). Monday 2026-09-21, UTC; the day block lights every lamp at 220 and 4000 K.
 */
const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const portSwitch = (room: string) => `input_boolean.ls_${room}_on_port`;
const RUNTIME = 'sensor.ls_effects_runtime', CACHE_A = `sensor.ls_cache_${roomA}`;

/** What the old scripts keep in the shared sensors: a room-a hold, a house-wide hold, the render queue and bookkeeping. */
function sharedStates(switches: Record<string, 'on' | 'off'>): Record<string, EntityState> {
  return syntheticStates(states => {
    const sensor = states['sensor.ls_overrides']!;
    sensor.attributes = {
      ...sensor.attributes,
      overrides: {
        [`block:${roomA}`]: { kind: 'block', target: roomA, value: 'night', when: '2026-09-21T11:00:00+00:00', created: '2026-09-21T11:00:00+00:00', who: null, via: 'app' },
        'block:house': { kind: 'block', target: 'house', value: 'cosy', when: '2026-09-21T11:30:00+00:00', created: '2026-09-21T11:30:00+00:00', who: null, via: 'app' },
      },
      pending_rooms: { [roomA]: '2026-09-21T11:59:00+00:00' }, last_request: '2026-09-21T11:59:00+00:00', received_at: 1790000000,
      full_version: '2026-09-21T11:59:00+00:00', full_reason: 'config', full_lights: ['light.lamp_a1'],
    };
    sensor.last_updated = '2026-09-21T11:59:00+00:00';
    states[RUNTIME] = { state: '2026-09-21T11:59:01+00:00', attributes: {
      targets: { 'light.lamp_a1': { brightness: 30 } }, assignments: { 'light.lamp_a1': 'Candle' }, applied: { 'light.lamp_a1': { brightness: 30 } },
      revision: '2026-09-21T11:59:00+00:00', generation: 7, plan_order: 1790000000, handled_full: '2026-09-21T11:58:00+00:00',
      handled_rooms: { [roomA]: '2026-09-21T11:58:00+00:00' }, transport_recovery: { 'bulb-a1': 2 },
      candle_group: ['bulb-a1'], candle_response: {}, candle_syncing: false, candle_retry_at: null, candle_error: null } };
    states[CACHE_A] = { state: 'ok', attributes: { cache: { version: 3, room: roomA, gradients: { 'light.lamp_a1': [1, 2] } } } };
    for (const [room, power] of Object.entries(switches)) states[portSwitch(room)] = { state: power, attributes: {}, last_changed: '2026-09-21T10:00:00+00:00' };
  });
}

/** A house the port shares: the states, the bulbs, what the port kept, and the rooms it was given. */
class Shared {
  readonly bulbs: FakeBulbs = world();
  state: AdapterState | undefined;
  readonly states: Record<string, EntityState>;
  readonly given: RoomsGiven;
  constructor(states: Record<string, EntityState>, given: RoomsGiven) {
    this.states = states; this.given = given;
    writeBack(this.bulbs, this.states);
  }

  turn(time: string, input: HaInput): Turn {
    const kept = this.state === undefined ? { kind: 'starting' as const, beliefs: NO_BELIEFS } : { kind: 'running' as const, state: this.state };
    const turn = handleInput(kept, houseView(this.states, `2026-09-21T${time}Z`), input, this.given);
    for (const output of turn.outputs) {
      if (output.kind === 'sensor') {
        const sensor = this.states[output.write.entity]!;
        this.states[output.write.entity] = { state: output.write.revision, attributes: { ...sensor.attributes, ...output.write.attributes },
          last_updated: `2026-09-21T${time}Z` };
      }
      if (output.kind === 'switch') this.states[output.switch] = { state: output.power, attributes: {} };
    }
    this.bulbs.apply(turn.outputs.flatMap(output => output.kind === 'publish' ? [output.publish] : []));
    writeBack(this.bulbs, this.states);
    this.state = afterOutputs(turn, turn.outputs.map(() => false)).state;
    return turn;
  }
}

const listed = (...names: string[]): RoomsGiven => ({ kind: 'listed', rooms: new Set(names.map(toRoomId)) });
const bulbsSent = (turn: Turn) => [...new Set(turn.outputs.flatMap(output => output.kind === 'publish' ? [output.publish.topic] : []))].sort();
const sensorWrite = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'sensor' ? [output.write] : [])[0];
const pressInRoomA: HaInput = bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' });
const holdRoomB: HaInput = bridged('ls_override_block', { scope: roomB, block: 'night' });

test('a lamp in a room that is not live is sent nothing', () => {
  // Break: the reconciler is handed the whole house's lamps, and the port fights the old scripts in room-a.
  const shared = new Shared(sharedStates({ [roomA]: 'on', [roomB]: 'on' }), listed(roomB));
  assert.deepEqual(bulbsSent(shared.turn('12:00:00', { kind: 'started' })), ['zigbee2mqtt/bulb-b1']);
});

test("a room whose port switch is off is not the port's: switching it off hands the room back", () => {
  // Break: the list alone decides, so the watchdog's switch-off, or a person's, does not stop the port.
  const shared = new Shared(sharedStates({ [roomA]: 'on', [roomB]: 'off' }), listed(roomA, roomB));
  const sent = bulbsSent(shared.turn('12:00:00', { kind: 'started' }));
  assert.deepEqual(sent, ['zigbee2mqtt/bulb-a1', 'zigbee2mqtt/bulb-a2', 'zigbee2mqtt/bulb-a3']);
});

test('an input for a room that is not live changes nothing', () => {
  // Break: the port acts on a press the old scripts also act on: the room's power is toggled twice, or written by both.
  const shared = new Shared(sharedStates({ [roomA]: 'on', [roomB]: 'on' }), listed(roomB));
  shared.turn('12:00:00', { kind: 'started' });
  const model = structuredClone(shared.state!.model);
  const turn = shared.turn('12:01:00', pressInRoomA);
  assert.deepEqual(turn.outputs, []);
  assert.deepEqual(turn.state.model.overlays, model.overlays);
});

test('a house-wide input changes nothing while a room is still on the old scripts: they commit it', () => {
  // Rollout manifest: Sara mode, the house's block and clearing every overlay are the old scripts'. Break: both
  // systems commit the same toggle, or the port clears the old rooms' holds.
  const shared = new Shared(sharedStates({ [roomA]: 'on', [roomB]: 'on' }), listed(roomB));
  shared.turn('12:00:00', { kind: 'started' });
  for (const input of [{ kind: 'dashboard script', script: { kind: 'toggle mode' } }, { kind: 'dashboard script', script: { kind: 'clear overlays' } },
    bridged('ls_override_block', { scope: 'house', block: 'day' })] as HaInput[]) {
    assert.deepEqual(shared.turn('12:01:00', input).outputs, [], JSON.stringify(input));
  }
});

test("the port's rooms follow a hold over the house the old scripts commit", () => {
  // Break: the port keeps the Model it read at start, so its rooms never see the old scripts' house-wide commits.
  const states = sharedStates({ [roomA]: 'on', [roomB]: 'on' });
  const overrides = states['sensor.ls_overrides']!.attributes.overrides as JsonObject;
  delete overrides['block:house']; delete overrides[`block:${roomA}`];
  const shared = new Shared(states, listed(roomA));
  shared.turn('12:00:00', { kind: 'started' });
  // The old scripts' hold over the house holds each room of it, the port's included.
  for (const target of ['house', roomA, roomB]) {
    overrides[`block:${target}`] = { kind: 'block', target, value: 'night', when: '2026-09-21T12:00:30+00:00', who: null, via: 'app' };
  }
  const turn = shared.turn('12:01:00', { kind: 'wake' });
  assert.equal(turn.state.model.overlays.blocks.house?.block, 'night');
  assert.deepEqual(bulbsSent(turn), ['zigbee2mqtt/bulb-a1', 'zigbee2mqtt/bulb-a2', 'zigbee2mqtt/bulb-a3']);
  assert.equal(sensorWrite(turn), undefined, 'the commit is the old scripts\'; the port writes nothing back');
});

test("another room's stored overlays are byte-identical after a turn", () => {
  // Review Focus 4, spec 4.4. Break: the port's write drops or rewrites what the old scripts keep for room-a, or the
  // house-wide hold they committed.
  const states = sharedStates({ [roomA]: 'on', [roomB]: 'on' });
  const before = JSON.stringify((states['sensor.ls_overrides']!.attributes.overrides as JsonObject)[`block:${roomA}`]);
  const house = JSON.stringify((states['sensor.ls_overrides']!.attributes.overrides as JsonObject)['block:house']);
  const shared = new Shared(states, listed(roomB));
  shared.turn('12:00:00', { kind: 'started' });
  const write = sensorWrite(shared.turn('12:01:00', holdRoomB));
  assert.ok(write !== undefined, 'the hold over room-b is written');
  const overrides = write.attributes.overrides as JsonObject;
  assert.equal(JSON.stringify(overrides[`block:${roomA}`]), before);
  assert.equal(JSON.stringify(overrides['block:house']), house);
  assert.equal((overrides[`block:${roomB}`] as JsonObject).value, 'night');
});

test("a room handed to the port is sent its lamps again: the old scripts may have stopped a firmware candle meanwhile", () => {
  // The candle is not reported by the bulb, so only what the port last sent says it runs. Break: the port trusts it
  // after the old scripts drove the room, and the candle stays stopped.
  const states = sharedStates({ [roomA]: 'on', [roomB]: 'on' });
  delete (states['sensor.ls_overrides']!.attributes.overrides as JsonObject)[`block:${roomA}`];
  const shared = new Shared(states, listed(roomA));
  shared.turn('12:00:00', { kind: 'started' });
  const candle = shared.turn('12:00:05', bridged('automation.lighting_schedule_lamp_change_detector', { trigger: { event: { context: { user_id: 'someone', id: 'person' },
    data: { domain: 'light', service: 'turn_on', service_data: { entity_id: 'light.lamp_a1', effect: 'candle' } } } } }));
  assert.ok(bulbsSent(candle).includes('zigbee2mqtt/bulb-a1'), 'the candle starts');
  states[portSwitch(roomA)] = { state: 'off', attributes: {}, last_changed: '2026-09-21T12:00:10+00:00' };
  assert.deepEqual(bulbsSent(shared.turn('12:00:20', { kind: 'wake' })), []);
  states[portSwitch(roomA)] = { state: 'on', attributes: {}, last_changed: '2026-09-21T12:00:30+00:00' };
  assert.ok(bulbsSent(shared.turn('12:00:40', { kind: 'wake' })).includes('zigbee2mqtt/bulb-a1'));
});

test('the dashboard is left to the old scripts while a room is still theirs', () => {
  // README "Rooms on the port": the block selects, the mode mirror and the controls' proxies have one publisher.
  // Break: the port and the old scripts both publish the dashboard, each from its own view.
  const shared = new Shared(sharedStates({ [roomA]: 'on', [roomB]: 'on' }), listed(roomB));
  assert.deepEqual(shared.turn('12:00:00', { kind: 'started' }).outputs.filter(output => output.kind === 'dashboard'), []);
});

test("a remote's helpers and a block light's store of a room that is not live are not written", () => {
  // Break: the port's clock closes room-a's remote chord and writes its helpers, or it writes room-a's saved block
  // light, both the old scripts'.
  const states = sharedStates({ [roomA]: 'on', [roomB]: 'on' });
  states[`timer.ls_${roomA}_remote_chord`] = { state: 'active', attributes: { duration: '0:00:03', finishes_at: '2026-09-21T12:00:30+00:00' } };
  const shared = new Shared(states, listed(roomB));
  const helpers = (turn: Turn) => turn.outputs.filter(output => output.kind === 'helper' || output.kind === 'store');
  shared.turn('12:00:00', { kind: 'started' });
  assert.deepEqual(helpers(shared.turn('12:01:00', { kind: 'tick' })), [], 'the chord timer ran out at 12:00:30');
  assert.deepEqual(helpers(shared.turn('12:02:00', bridged('ls_store', { store: `input_text.ls_${roomA}_day`, brightness: 100 }))), []);
});

test('with every room live nothing extra is written: the turn is the whole house\'s', () => {
  // Break: a port given every room keeps leaving house-wide inputs to the old scripts, or writes something more.
  const run = (given: RoomsGiven) => {
    const shared = new Shared(sharedStates({ [roomA]: 'on', [roomB]: 'on' }), given);
    return [shared.turn('12:00:00', { kind: 'started' }), shared.turn('12:01:00', pressInRoomA),
      shared.turn('12:02:00', { kind: 'dashboard script', script: { kind: 'toggle mode' } })].map(turn => turn.outputs);
  };
  assert.deepEqual(run(listed(roomA, roomB)), run({ kind: 'house' }));
});

/**
 * The fields the old scripts read across rooms (`docs/sensor-fields.md`, "Carried"). The old scripts keep each one
 * valid themselves as long as the port never writes it and every write of the port moves the store's revision, so
 * an old render planned before it is not marked handled and runs again.
 */
const portWrites = (): { turn: Turn; outputs: Output[]; states: Record<string, EntityState> } => {
  const states = sharedStates({ [roomA]: 'on', [roomB]: 'on' });
  const shared = new Shared(states, listed(roomB));
  const outputs = [...shared.turn('12:00:00', { kind: 'started' }).outputs];
  const turn = shared.turn('12:01:00', holdRoomB);
  return { turn, outputs: [...outputs, ...turn.outputs], states };
};
const overridesWritten = (outputs: Output[]) => outputs.flatMap(output => output.kind === 'sensor' && output.write.entity === 'sensor.ls_overrides' ? [output.write] : []);
const touches = (outputs: Output[], entity: string) => outputs.some(output =>
  (output.kind === 'sensor' || output.kind === 'helper' || output.kind === 'store') && output.write.entity === entity);

test("carried 1: every write of the port moves the store's revision", () => {
  const { turn } = portWrites();
  const write = sensorWrite(turn);
  assert.ok(write !== undefined);
  assert.notEqual(write.revision, '2026-09-21T14:13:20+00:00');
  assert.equal(write.revision, '2026-09-21T12:01:00.000000Z');
});

for (const [row, fields] of [[2, ['pending_rooms']], [3, ['last_request', 'received_at']], [4, ['full_version', 'full_reason', 'full_lights']]] as const) {
  test(`carried ${row}: the overrides sensor's ${fields.join(', ')} ${fields.length === 1 ? 'is' : 'are'} never written by the port`, () => {
    const { outputs } = portWrites();
    assert.ok(overridesWritten(outputs).length > 0);
    for (const write of overridesWritten(outputs)) for (const field of fields) assert.equal(Object.hasOwn(write.attributes, field), false, field);
  });
}

for (const [row, what] of [[5, 'the record of what every lamp was sent'], [6, 'the render requests answered'], [7, 'the retry ledger'],
  [8, "the software candle's group sync"]] as const) {
  test(`carried ${row}: the runtime sensor's ${what} is never written by the port`, () => {
    assert.equal(touches(portWrites().outputs, RUNTIME), false);
  });
}

test("carried 9: a room cache's gradients are never written by the port", () => {
  assert.equal(touches(portWrites().outputs, CACHE_A), false);
});
