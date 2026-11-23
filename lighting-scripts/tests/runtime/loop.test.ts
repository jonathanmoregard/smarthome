import assert from 'node:assert/strict';
import test from 'node:test';
import type { Publish } from '../../src/adapter/encode.ts';
import { configSource, decodeModel } from '../../src/adapter/codecs/model.ts';
import type { HaInput } from '../../src/adapter/inputs.ts';
import { handleInput } from '../../src/adapter/loop.ts';
import type { AdapterState, Turn } from '../../src/adapter/loop.ts';
import { nextChange } from '../../src/domain/lighting-state.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { EntityState } from '../../src/runtime/context.ts';
import { toInstant, toKelvin, toRoomId, toSwitchId } from '../../src/parse/ids.ts';
import { lit } from './fake-bulbs.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';

/**
 * The adapter's loop (M3 Task 3) on the synthetic house: each turn's outputs
 * move a `FakeBulbs` world, whose bulbs are written back into the states the
 * next turn reads. Monday 2026-09-21, UTC: day from 07:00 at 220 and 4000 K;
 * `room-a`'s own cosy fades in from 16:45 to 17:30.
 */

const roomA = toRoomId('room-a');
const ROOM_A_BULBS = ['bulb-a1', 'bulb-a2', 'bulb-a3'] as BulbId[];

/** A house the loop runs in: the states, the bulbs' world and the adapter's state. */
class House {
  readonly states: Record<string, EntityState> = syntheticStates();
  readonly bulbs: FakeBulbs = world();
  state: AdapterState | undefined;
  last: Turn | undefined;

  constructor() {
    writeBack(this.bulbs, this.states);
  }

  /** One turn at `time` (UTC, on the Monday): its writes land in the states, its publishes reach the bulbs. */
  turn(time: string, input: HaInput): Turn {
    const turn = handleInput(this.state, houseView(this.states, `2026-09-21T${time}Z`), input);
    this.state = turn.state;
    this.last = turn;
    for (const output of turn.outputs) {
      if (output.kind === 'sensor') {
        const sensor = this.states[output.write.entity]!;
        this.states[output.write.entity] = { state: output.write.revision, attributes: { ...sensor.attributes, ...output.write.attributes } };
      }
      if (output.kind === 'switch') this.states[output.switch] = { state: output.power, attributes: {} };
    }
    this.bulbs.apply(publishesOf(turn));
    writeBack(this.bulbs, this.states);
    return turn;
  }
}

function publishesOf(turn: Turn): Publish[] {
  return turn.outputs.flatMap(output => output.kind === 'publish' ? [output.publish] : []);
}

const shows = (house: House, bulb: BulbId) => {
  const shown = house.bulbs.shows(bulb);
  return shown.reach === 'reachable' ? shown.light : shown;
};

test('a start with no state decodes it and lights the house', () => {
  const house = new House();
  const turn = house.turn('12:00:00', { kind: 'started' });
  const read = decodeModel(configSource(houseView(house.states, '2026-09-21T12:00:00Z')), houseView(house.states, '2026-09-21T12:00:00Z').catalog);
  assert.deepEqual(turn.state.model.config, read.config);
  assert.ok(publishesOf(turn).length > 0);
  for (const bulb of ['bulb-a2', 'bulb-a3', 'bulb-b1'] as BulbId[]) {
    assert.deepEqual(shows(house, bulb), { power: 'on', level: 220, colour: { kind: 'kelvin', kelvin: 4000 }, effect: 'none' }, bulb);
  }
});

test('a remote press changes the model, the sensor and the bulbs in one turn', () => {
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const turn = house.turn('12:05:00', { kind: 'remote command', data: { command: 'toggle', area: roomA, source: 'remote-a' } });
  assert.equal(turn.state.model.overlays.roomPower[roomA], 'off');
  const sensor = turn.outputs.find(output => output.kind === 'sensor');
  assert.ok(sensor !== undefined && sensor.kind === 'sensor');
  assert.deepEqual(sensor.write.attributes.power, { [roomA]: false });
  for (const bulb of ROOM_A_BULBS) assert.deepEqual(shows(house, bulb), { power: 'off' }, bulb);
  assert.equal(shows(house, 'bulb-b1' as BulbId).power, 'on');
});

test('inputs are applied one at a time in arrival order', () => {
  const house = new House();
  house.turn('16:40:00', { kind: 'started' });
  house.turn('16:55:00', { kind: 'tick' });
  const fading = shows(house, 'bulb-a3' as BulbId);
  assert.equal(fading.power, 'on');
  house.turn('16:55:20', { kind: 'remote command', data: { command: 'toggle', area: roomA, source: 'remote-a' } });
  const after = house.turn('16:56:00', { kind: 'tick' });
  assert.equal(after.state.model.overlays.roomPower[roomA], 'off');
  for (const bulb of ROOM_A_BULBS) assert.deepEqual(shows(house, bulb), { power: 'off' }, bulb);
  house.turn('16:56:20', { kind: 'remote command', data: { command: 'toggle', area: roomA, source: 'remote-a' } });
  house.turn('16:57:00', { kind: 'tick' });
  const lit = shows(house, 'bulb-a3' as BulbId);
  assert.ok(lit.power === 'on' && fading.power === 'on' && lit.level !== fading.level, 'the fade went on after the press');
});

test('nothing is written when nothing changed', () => {
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  house.turn('12:01:00', { kind: 'tick' });
  const quiet = house.turn('12:02:00', { kind: 'tick' });
  assert.deepEqual(quiet.outputs, []);
});

test("a save to a plug's store writes the plug's store, once, with the plug's fields", () => {
  // Break: the plug's save is written through the lamp's encoder (a lamp's fields land in a plug's store), not at
  // all, or twice (once as a config store and once as the plug's profile).
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const store = 'input_text.ls_lamp_plug_a_cosy';
  const turn = house.turn('12:01:00', { kind: 'store saved', data: { store, own: true, on: true } });
  const writes = turn.outputs.flatMap(output => output.kind === 'store' && output.write.entity === store ? [output.write.text] : []);
  assert.deepEqual(writes.map(text => JSON.parse(text)), [{ own: true, on: true }]);
  assert.deepEqual(turn.state.model.switchProfiles[toSwitchId('switch.plug_a')]?.cosy, { follows: 'own', power: 'on' });
});

test('a start sends each control its availability; a later turn only what its proxy shows otherwise', () => {
  // Break: the turn leaves out the proxies' sync (availability, profile editors, effect list), or forces it every turn.
  const house = new House();
  const availability = (turn: Turn) => turn.outputs.flatMap(output =>
    output.kind === 'dashboard' && output.write.kind === 'control sync' && output.write.topic.endsWith('/availability') ? [output.write.payload] : []);
  assert.deepEqual(availability(house.turn('12:00:00', { kind: 'started' })), ['offline']);
  assert.deepEqual(availability(house.turn('12:01:00', { kind: 'tick' })), []);
  house.states['light.room_a_all'] = { state: 'on', attributes: {} };
  assert.deepEqual(availability(house.turn('12:02:00', { kind: 'tick' })), ['online']);
});

test('an input is read against the clocked model: a mode toggle as the age reset releases the mode switches it on', () => {
  // The synthetic house resets overlays after 180 minutes. The mode switched on at 09:00 is released by the clock at
  // 12:00, so a toggle in that turn switches it on again. Break: the toggle reads the mode from before the clock ran,
  // sends on: false, and is lost.
  const house = new House();
  house.turn('09:00:00', { kind: 'started' });
  house.turn('09:00:00', { kind: 'dashboard script', script: 'toggle mode', data: {} });
  assert.equal(house.state!.model.modeOverlay.active, true);
  const toggled = house.turn('12:00:00', { kind: 'dashboard script', script: 'toggle mode', data: {} });
  assert.deepEqual(toggled.state.model.modeOverlay, { active: true, since: Date.parse('2026-09-21T12:00:00Z') / 1000 });
});

test('the turn asks to be woken at nextChange', () => {
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const turn = house.turn('12:01:00', { kind: 'tick' });
  const now = Date.parse('2026-09-21T12:01:00Z') / 1000;
  assert.equal(turn.wakeAt, nextChange(turn.state.model, now as never));
  assert.ok(turn.wakeAt !== undefined && turn.wakeAt > now);
});

test('an input that cannot be read is logged and dropped, and the turn goes on', () => {
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const overlaysBefore = structuredClone(house.state!.model.overlays);
  const turn = house.turn('12:01:00', { kind: 'overlay event', data: { op: 'no such operation' } });
  assert.match(turn.dropped === undefined ? '' : turn.dropped, /no such operation/);
  assert.deepEqual(turn.state.model.overlays, overlaysBefore);
  const held = house.turn('12:02:00', { kind: 'dashboard script', script: 'hold block', data: { scope: roomA, block: 'night' } });
  assert.equal(held.dropped, undefined);
  assert.equal(held.state.model.overlays.blocks[roomA]?.block, 'night');
});

test('a helper change reaches the lighting state the same turn, through the configChanged message', () => {
  // Break: the adapter swaps the config into the state itself (no `configChanged`), or keeps the old one for this turn.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  house.states['input_datetime.ls_house_day_start'] = { state: '08:00:00', attributes: {} };
  const turn = house.turn('12:01:00', { kind: 'helper changed' });
  assert.deepEqual(turn.state.model.config.house.day.weekdayStart, { hour: 8, minute: 0 });
  assert.equal(turn.outputs.some(output => output.kind === 'store'), false);
});

// --- M4: the plug's own button, power-on, put-backs, retries ------------------------------------------------------

const plugA = toSwitchId('switch.plug_a');
const bulbA3 = 'bulb-a3' as BulbId;
const switchesSent = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'switch' ? [[output.switch, output.power]] : []);
const publishedTo = (turn: Turn, bulb: BulbId) => publishesOf(turn).filter(publish => publish.topic === `zigbee2mqtt/${bulb}`);

test("a plug's own button becomes a switch overlay and is not sent back", () => {
  // Owner, 2026-11-22: a press on a plug's own button is an override. Break: the reconciler takes the press back at the
  // next tick (today's scripts), or the press never reaches the Model.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  assert.equal(house.states['switch.plug_a']?.state, 'off');
  house.states['switch.plug_a'] = { state: 'on', attributes: {} };
  const pressed = house.turn('12:01:00', { kind: 'tick' });
  assert.deepEqual(pressed.state.model.overlays.switches[plugA], { power: 'on', since: Date.parse('2026-09-21T12:01:00Z') / 1000 });
  assert.deepEqual(switchesSent(pressed), []);
  assert.deepEqual(switchesSent(house.turn('12:02:00', { kind: 'tick' })), []);
  assert.equal(house.states['switch.plug_a']?.state, 'on');
});

test('a switch we just switched is not a button press', () => {
  // Break: the reconciler's own switching, seen at the next turn, is taken for a press and held as an overlay.
  const house = new House();
  house.states['switch.plug_a'] = { state: 'on', attributes: {} };
  assert.deepEqual(switchesSent(house.turn('12:00:00', { kind: 'started' })), [[plugA, 'off']]);
  assert.equal(house.turn('12:01:00', { kind: 'tick' }).state.model.overlays.switches[plugA], undefined);
  assert.equal(house.turn('12:02:00', { kind: 'tick' }).state.model.overlays.switches[plugA], undefined);
});

test('a bulb changed behind our back is put back', () => {
  // Break: an observed difference that is not a press or a power-on is left as it is.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  house.turn('12:01:00', { kind: 'tick' });
  house.bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, { kind: 'kelvin', kelvin: toKelvin(4000) }) });
  writeBack(house.bulbs, house.states);
  const turn = house.turn('12:02:00', { kind: 'tick' });
  assert.equal(publishedTo(turn, bulbA3).length, 1);
  assert.deepEqual(shows(house, bulbA3), { power: 'on', level: 220, colour: { kind: 'kelvin', kelvin: 4000 }, effect: 'none' });
});

test('a bulb back on from the wall gets its light with the short fade, though it shows it', () => {
  // Review Focus 2. Break: a power-on is not seen, so a bulb whose report matches its light gets nothing (its candle,
  // which no report shows, would stay off), or it comes back over another fade.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  house.bulbs.cut(bulbA3);
  writeBack(house.bulbs, house.states);
  house.turn('12:01:00', { kind: 'tick' });
  house.bulbs.restore(bulbA3);
  writeBack(house.bulbs, house.states);
  const back = house.turn('12:01:30', { kind: 'state changed', entities: ['light.lamp_a2'] });
  assert.deepEqual(publishedTo(back, bulbA3).map(publish => publish.payload),
    [{ brightness: 220, color_temp: 250, transition: 0.2 }]);
});

test('a bulb put back six times in ten minutes is parked, and the turn says so once', () => {
  // Break: the loop puts a bulb back forever, or reports it parked on every turn.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  let putBack = 0;
  const parked: BulbId[] = [];
  for (let minute = 1; minute <= 9; minute++) {
    house.bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, { kind: 'kelvin', kelvin: toKelvin(4000) }) });
    writeBack(house.bulbs, house.states);
    const turn = house.turn(`12:0${minute}:00`, { kind: 'tick' });
    if (publishedTo(turn, bulbA3).length > 0) putBack++;
    parked.push(...turn.parked);
  }
  assert.equal(putBack, 6);
  assert.deepEqual(parked, [bulbA3]);
});

test('the turn asks to be woken for a retry due before the next change', () => {
  // Break: a failed send waits for the next change, which may be hours away, instead of its backoff.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const retryAt = toInstant(Date.parse('2026-09-21T12:01:05Z') / 1000);
  const state = house.state!;
  house.state = { ...state, beliefs: { ...state.beliefs, bulbs: { ...state.beliefs.bulbs,
    [bulbA3]: { kind: 'retrying', shows: undefined, attempts: 1, retryAt } } } };
  assert.equal(house.turn('12:01:00', { kind: 'tick' }).wakeAt, retryAt);
});
