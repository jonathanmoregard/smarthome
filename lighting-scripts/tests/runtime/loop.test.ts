import assert from 'node:assert/strict';
import test from 'node:test';
import type { Publish } from '../../src/adapter/encode.ts';
import { configSource, decodeModel } from '../../src/adapter/codecs/model.ts';
import type { HaInput } from '../../src/adapter/codecs/inputs.ts';
import { afterOutputs, handleInput, wantsTurn } from '../../src/adapter/loop.ts';
import { PLANTS_ALL_OFF } from '../../src/adapter/codecs/inputs.ts';
import type { Output } from '../../src/adapter/encode.ts';
import type { AdapterState, Kept, Settled, Turn } from '../../src/adapter/loop.ts';
import type { RoomsGiven } from '../../src/adapter/live-rooms.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { EntityState } from '../../src/adapter/ha-client.ts';
import { toEntityId, toInstant, toKelvin, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';
import { lit } from './fake-bulbs.ts';
import type { FakeBulbs, FakeLight } from './fake-bulbs.ts';
import { houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { bridged } from './support/inputs.ts';
import { nextChange } from '../../src/domain/update.ts';

/**
 * The adapter's loop (M3 Task 3) on the synthetic house: each turn's outputs
 * move a `FakeBulbs` world, whose bulbs are written back into the states the
 * next turn reads. Monday 2026-09-21, UTC: day from 07:00 at 220 and 4000 K;
 * `room-a`'s own cosy fades in from 16:45 to 17:30.
 */

/** A fresh process with an empty journal. */
const STARTING: Kept = { kind: 'starting', beliefs: NO_BELIEFS, share: { kind: 'house' } };
/** The whole house, as the harness runs it. */
const HOUSE: RoomsGiven = { kind: 'house' };

const roomA = toRoomId('room-a');
const ROOM_A_BULBS = ['bulb-a1', 'bulb-a2', 'bulb-a3'] as BulbId[];

/** A house the loop runs in: the states, the bulbs' world and the adapter's state. */
/**
 * The stores this file's saves go to, as Home Assistant has them, input_text helpers: a save to a store Home Assistant
 * lacks is held, not sent (close-out r4 ruling B6).
 */
const STORES = ['input_text.ls_house_day', 'input_text.ls_room-a_day', 'input_text.ls_nowhere_day', 'input_text.ls_lamp_lamp_a2_day',
  'input_text.ls_lamp_plug_a_cosy'];

class House {
  readonly states: Record<string, EntityState> = syntheticStates(change => {
    for (const store of STORES) change[store] = { state: '', attributes: {} };
  });
  readonly bulbs: FakeBulbs = world();
  state: AdapterState | undefined;
  last: Turn | undefined;

  /** The plant lights, each labelled `plant_light` in `room-a`. */
  readonly plants: readonly string[];

  /** `plants`: the house's plant lights, each a plug seeded off. */
  constructor({ plants = [] }: { plants?: readonly string[] } = {}) {
    this.plants = plants;
    for (const plant of plants) this.states[plant] = { state: 'off', attributes: {} };
    writeBack(this.bulbs, this.states);
  }

  /**
   * One turn at `time` (UTC: a time on the Monday, or a full instant such as `2026-09-22T07:00:00`): its writes land
   * in the states, its publishes reach the bulbs and the all-off control's write lands, but for the `failing` ones, and
   * the turn is settled with how each output went.
   */
  turn(time: string, input: HaInput, failing: (output: Output) => boolean = () => false): Turn & Settled {
    const at = time.includes('T') ? `${time}Z` : `2026-09-21T${time}Z`;
    const turn = handleInput(this.state === undefined ? STARTING : { kind: 'running', state: this.state }, houseView(this.states, at, this.plants),
      input, HOUSE);
    const failed = turn.outputs.map(failing);
    for (const [index, output] of turn.outputs.entries()) {
      if (output.kind === 'sensor') {
        const sensor = this.states[output.write.entity]!;
        this.states[output.write.entity] = { state: output.write.revision, attributes: { ...sensor.attributes, ...output.write.attributes } };
      }
      if (output.kind === 'switch') this.states[output.switch] = { state: output.power, attributes: {} };
      if (output.kind === 'dashboard' && output.write.kind === 'plants all-off' && failed[index] !== true) {
        this.states[output.write.entity] = { state: output.write.on ? 'on' : 'off', attributes: {}, last_changed: at };
      }
    }
    this.bulbs.apply(turn.outputs.flatMap((output, index) => output.kind === 'publish' && !failed[index] ? [output.publish] : []));
    writeBack(this.bulbs, this.states);
    const settled = afterOutputs(turn, failed);
    this.state = settled.state;
    this.last = turn;
    return { ...turn, ...settled };
  }
}

function publishesOf(turn: Turn): Publish[] {
  return turn.outputs.flatMap(output => output.kind === 'publish' ? [output.publish] : []);
}

const shows = (house: House, bulb: BulbId) => {
  const shown = house.bulbs.shows(bulb);
  return shown.reach === 'reachable' ? shown.light : shown;
};

/** The light a bulb in reach shows; one out of reach fails the test. */
const lightOrThrow = (house: House, bulb: BulbId): FakeLight => {
  const shown = house.bulbs.shows(bulb);
  if (shown.reach === 'unreachable') throw new Error(`${bulb} is out of reach`);
  return shown.light;
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
  const turn = house.turn('12:05:00', bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
  assert.equal(turn.state.model.overlays.roomPower[roomA], 'off');
  const sensor = turn.outputs.find(output => output.kind === 'sensor');
  assert.ok(sensor !== undefined && sensor.kind === 'sensor');
  assert.deepEqual(sensor.write.attributes.power, { [roomA]: false });
  for (const bulb of ROOM_A_BULBS) assert.deepEqual(shows(house, bulb), { power: 'off' }, bulb);
  assert.equal(lightOrThrow(house, 'bulb-b1' as BulbId).power, 'on');
});

test('inputs are applied one at a time in arrival order', () => {
  const house = new House();
  house.turn('16:40:00', { kind: 'started' });
  house.turn('16:55:00', { kind: 'tick' });
  const fading = lightOrThrow(house, 'bulb-a3' as BulbId);
  assert.equal(fading.power, 'on');
  house.turn('16:55:20', bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
  const after = house.turn('16:56:00', { kind: 'tick' });
  assert.equal(after.state.model.overlays.roomPower[roomA], 'off');
  for (const bulb of ROOM_A_BULBS) assert.deepEqual(shows(house, bulb), { power: 'off' }, bulb);
  house.turn('16:56:20', bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
  house.turn('16:57:00', { kind: 'tick' });
  const lit = lightOrThrow(house, 'bulb-a3' as BulbId);
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
  const turn = house.turn('12:01:00', bridged('ls_store', { store, own: true, on: true }));
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
  house.turn('09:00:00', { kind: 'dashboard script', script: { kind: 'toggle mode' } });
  assert.equal(house.state!.model.modeOverlay.active, true);
  const toggled = house.turn('12:00:00', { kind: 'dashboard script', script: { kind: 'toggle mode' } });
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
  const turn = house.turn('12:01:00', bridged('ls_commit', { data: { op: 'no such operation' } }));
  assert.match(turn.dropped === undefined ? '' : turn.dropped, /no such operation/);
  assert.deepEqual(turn.state.model.overlays, overlaysBefore);
  const held = house.turn('12:02:00', bridged('ls_override_block', { scope: roomA, block: 'night' }));
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

test("a block light's save moves the lamps in the same turn, and Home Assistant's echo moves nothing", () => {
  // Amendment 7.2. Break: the save is written to its store and the lamps wait for the helper echo a turn later, or
  // the echo, read again, comes to a different light and moves them twice.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const store = 'input_text.ls_house_day';
  const saved = house.turn('12:01:00', bridged('ls_store', { store, brightness: 100, kelvin: 2500 }));
  const writes = saved.outputs.flatMap(output => output.kind === 'store' && output.write.entity === store ? [output.write.text] : []);
  assert.deepEqual(writes.map(text => JSON.parse(text)), [{ b: 100, m: 'ct', k: 2500, effect_channels: [] }]);
  for (const bulb of ['bulb-a2', 'bulb-b1'] as BulbId[]) {
    assert.deepEqual(shows(house, bulb), { power: 'on', level: 100, colour: { kind: 'kelvin', kelvin: 2500 }, effect: 'none' }, bulb);
  }
  house.states[store] = { state: writes[0]!, attributes: {} };
  house.states['light.ls_house_day'] = { state: 'on', attributes: { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 } };
  assert.deepEqual(publishesOf(house.turn('12:01:05', { kind: 'helper changed' })), []);
});

test("a block light's save is written for any room its store names; a store that names no block is dropped", () => {
  // Amendment 8.2, review 6. Break: a room the config has no lamp in has its dashboard save dropped (it reverts), as
  // before it was written; or a store whose name is no block light's is written as one.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const stores = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'store' ? [output.write.entity] : []);
  for (const [time, store] of [['12:01:00', 'input_text.ls_room-a_day'], ['12:02:00', 'input_text.ls_nowhere_day']] as const) {
    const saved = house.turn(time, bridged('ls_store', { store, brightness: 100 }));
    assert.deepEqual(stores(saved), [store]);
    assert.equal(saved.dropped, undefined);
  }
  const turn = house.turn('12:03:00', bridged('ls_store', { store: 'input_text.ls_nowhere', brightness: 100 }));
  assert.deepEqual(stores(turn), []);
  assert.match(turn.dropped ?? '', /input_text\.ls_nowhere\b/);
});

test('a profile save Home Assistant did not take is written again on the backoff, and once taken is not', () => {
  // Review 3. Break: the Model takes the save and the next turn diffs it against itself, so the failed write is never
  // made again, Home Assistant keeps the old profile and a restart loses the save; or a taken write is made again.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const store = 'input_text.ls_lamp_lamp_a2_day';
  const written = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'store' && output.write.entity === store ? [output.write.text] : []);
  const failed = house.turn('12:01:00', bridged('ls_store', { store, on: false }), output => output.kind === 'store');
  assert.equal(written(failed).length, 1);
  assert.equal(failed.wakeAt, Date.parse('2026-09-21T12:01:01Z') / 1000, 'woken after the first backoff');
  const again = house.turn('12:01:01', { kind: 'wake' });
  assert.deepEqual(written(again), written(failed));
  assert.deepEqual(written(house.turn('12:01:02', { kind: 'wake' })), []);
});

const LAMP_A2_DAY = 'input_text.ls_lamp_lamp_a2_day';
const storeWrites = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'store' && output.write.entity === LAMP_A2_DAY ? [output.write.text] : []);

test("a save Home Assistant did not take survives a change to another helper, and is written on its backoff", () => {
  // Re-review 1. Break: the helper change reads the profiles again from what Home Assistant still holds, the Model
  // takes the old light over the save (the lamps go back), and the save is dropped, never written.
  const house = new House(), store = 'input_text.ls_house_day';
  const saves = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'store' && output.write.entity === store ? [output.write.text] : []);
  const saved = { power: 'on', level: 100, colour: { kind: 'kelvin', kelvin: 2500 }, effect: 'none' };
  house.turn('12:00:00', { kind: 'started' });
  const failed = house.turn('12:01:00', bridged('ls_store', { store, brightness: 100, kelvin: 2500 }), output => output.kind === 'store');
  assert.equal(saves(failed).length, 1);
  assert.deepEqual(shows(house, 'bulb-b1' as BulbId), saved, 'the save moved the lamps');
  house.states['input_text.ls_lamp_lamp_b1_day'] = { state: '{"b":40}', attributes: {}, last_changed: '2026-09-21T12:01:00.500Z' };
  assert.deepEqual(saves(house.turn('12:01:00.500', { kind: 'helper changed' })), [], 'not sent again before its backoff');
  assert.deepEqual(shows(house, 'bulb-b1' as BulbId), saved, 'the helper change kept the save');
  assert.deepEqual(saves(house.turn('12:01:01', { kind: 'wake' })), saves(failed));
});

test("a person's newer change to the helper replaces a save still waiting to be written", () => {
  // Outbox. Break: the waiting save is written over the person's later change, which is lost.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  const failed = house.turn('12:01:00', bridged('ls_store', { store: LAMP_A2_DAY, on: false }), output => output.kind === 'store');
  assert.equal(storeWrites(failed).length, 1);
  const theirs = JSON.stringify({ own: true, on: true, b: 50 });
  house.states[LAMP_A2_DAY] = { state: theirs, attributes: {}, last_changed: '2026-09-21T12:01:00.500Z' };
  house.turn('12:01:00.500', { kind: 'helper changed' });
  for (const time of ['12:01:01', '12:01:03', '12:01:30']) assert.deepEqual(storeWrites(house.turn(time, { kind: 'wake' })), [], time);
});

/** Drive wakes from `turn` until none is due before `until`, adding up `count` and the warnings. */
function wakesUntil(house: House, turn: Turn & Settled, until: string, refused: (output: Output) => boolean, count: (turn: Turn) => number) {
  let tries = count(turn), last = turn;
  const warnings = [...turn.warnings];
  for (let step = 0; step < 8 && last.wakeAt !== undefined && last.wakeAt < Date.parse(`2026-09-21T${until}Z`) / 1000; step++) {
    last = house.turn(new Date(last.wakeAt * 1000).toISOString().slice(11, 23), { kind: 'wake' }, refused);
    tries += count(last);
    warnings.push(...last.warnings);
  }
  return { tries, warnings };
}

test('a write Home Assistant always refuses is tried five times on the backoff, then parked with one warning; the lamps follow Home Assistant', () => {
  // Re-review 4, final review 3. Break: the write is tried every minute forever, or it is never parked, or the warning
  // repeats; or the parked save is still laid over Home Assistant's states, so the lamps keep a light it never took.
  const house = new House(), store = 'input_text.ls_house_day';
  const saves = (turn: Turn) => turn.outputs.filter(output => output.kind === 'store' && output.write.entity === store).length;
  const refused = (output: Output) => output.kind === 'store';
  house.turn('12:00:00', { kind: 'started' });
  const before = shows(house, 'bulb-b1' as BulbId);
  const saved = house.turn('12:01:00', bridged('ls_store', { store, brightness: 100, kelvin: 2500 }), refused);
  assert.deepEqual(shows(house, 'bulb-b1' as BulbId), { power: 'on', level: 100, colour: { kind: 'kelvin', kelvin: 2500 }, effect: 'none' });
  const { tries, warnings } = wakesUntil(house, saved, '12:10:00', refused, saves);
  assert.equal(tries, 5);
  for (const time of ['12:10:00', '12:20:00']) assert.equal(saves(house.turn(time, { kind: 'tick' }, refused)), 0, time);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /input_text\.ls_house_day.*follows what Home Assistant holds/);
  assert.deepEqual(shows(house, 'bulb-b1' as BulbId), before, 'the lamps went back to what Home Assistant holds');
});

test('a reconnect unparks every parked write, a publish included, and sends it again', () => {
  // Final review 2. Break: a write parked while Home Assistant misbehaved stays parked through the reconnect, as bulbs
  // are not, so the control's proxy shows the wrong availability until something else changes it.
  const house = new House(), topic = 'house/v1/effect_preview/room_a_all/set/availability';
  const published = (turn: Turn) => turn.outputs.filter(output => output.kind === 'dashboard' && output.write.kind === 'control sync'
    && output.write.topic === topic).length;
  const refused = (output: Output) => output.kind === 'dashboard' && output.write.kind === 'control sync' && output.write.topic === topic;
  const started = house.turn('12:00:00', { kind: 'started' }, refused);
  const { tries, warnings } = wakesUntil(house, started, '12:10:00', refused, published);
  assert.equal(tries, 5);
  assert.equal(warnings.length, 1);
  assert.equal(published(house.turn('12:10:00', { kind: 'tick' })), 0, 'parked');
  assert.equal(published(house.turn('12:11:00', { kind: 'reconnected' })), 1, 'sent again on the reconnect');
  assert.equal(published(house.turn('12:12:00', { kind: 'tick' })), 0, 'and, taken, not again');
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
  const back = house.turn('12:01:30', { kind: 'state changed', entities: [toEntityId('light.lamp_a2')] });
  assert.deepEqual(publishedTo(back, bulbA3).map(publish => publish.payload),
    [{ brightness: 220, color_temp: 250, transition: 0.2 }]);
});

test('a bulb put back six times in ten minutes is parked, and the turn says so once', () => {
  // Break: the loop puts a bulb back forever, or reports it parked on every turn.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  let putBack = 0;
  const parked: BulbId[] = [], notes: string[] = [];
  for (let minute = 1; minute <= 9; minute++) {
    house.bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, { kind: 'kelvin', kelvin: toKelvin(4000) }) });
    writeBack(house.bulbs, house.states);
    const turn = house.turn(`12:0${minute}:00`, { kind: 'tick' });
    if (publishedTo(turn, bulbA3).length > 0) putBack++;
    parked.push(...turn.parked);
    notes.push(...turn.notes);
  }
  assert.equal(putBack, 6);
  assert.deepEqual(parked, [bulbA3]);
  // Layer check 8: the line the host logs is the adapter's.
  assert.deepEqual(notes, [`lighting: ${bulbA3} is parked: it does not take what it is sent; left until it comes back on or its light changes`]);
});

test("a bulb that flaps its power is parked though each put-back's own on is reported", () => {
  // Review fix 3. Break: the report of our own put-back (off to on) forgets the bulb's belief, its put-backs with it,
  // so a bulb something keeps switching off is put back forever and never parked.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  let putBack = 0;
  const parked: BulbId[] = [];
  for (let minute = 1; minute <= 7; minute++) {
    house.bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
    writeBack(house.bulbs, house.states);
    const turn = house.turn(`12:0${minute}:00`, { kind: 'tick' });
    if (publishedTo(turn, bulbA3).length > 0) putBack++;
    parked.push(...turn.parked);
    parked.push(...house.turn(`12:0${minute}:30`, { kind: 'state changed', entities: [toEntityId('light.lamp_a2')] }).parked);
  }
  assert.equal(putBack, 6);
  assert.deepEqual(parked, [bulbA3]);
});

/** A house whose bulb-a3 was put back six times, then parked. */
function parkedA3(): House {
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  for (let minute = 1; minute <= 6; minute++) {
    house.bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, { kind: 'kelvin', kelvin: toKelvin(4000) }) });
    writeBack(house.bulbs, house.states);
    house.turn(`12:0${minute}:00`, { kind: 'tick' });
  }
  assert.equal(house.state?.beliefs.bulbs[bulbA3]?.kind, 'parked', 'control: six put-backs park it');
  return house;
}

/** Bulb-a3 back from its wall power with its power-on light, reported on to on. */
function poweredUp(house: House): void {
  house.bulbs.set(bulbA3, { reach: 'reachable', light: lit(254, undefined) });
  writeBack(house.bulbs, house.states);
}

test("a parked bulb's announce, its own power-up, sends it its light with the power-on fade; its on-to-on report alone does not", () => {
  // Closeout r2 A3. Break: the announce is not an input, so a parked bulb whose wall power came back before Home
  // Assistant saw it unavailable keeps its power-on light; or the report alone unparks it, and a flapping bulb is
  // fought again.
  const house = parkedA3();
  poweredUp(house);
  assert.deepEqual(publishedTo(house.turn('12:07:00', { kind: 'tick' }), bulbA3), [], 'control: the on-to-on report leaves it parked');
  const announced = house.turn('12:07:30', { kind: 'bulb announced', bulb: bulbA3 });
  assert.deepEqual(publishedTo(announced, bulbA3).map(publish => publish.payload), [{ brightness: 220, color_temp: 250, transition: 0.2 }]);
  assert.deepEqual(shows(house, bulbA3), { power: 'on', level: 220, colour: { kind: 'kelvin', kelvin: 4000 }, effect: 'none' });
});

test('a start unparks a bulb the journal held parked, so a park does not outlive a restart', () => {
  // Break: the journal's park survives the restart, so a bulb whose light was lost while the port was down is sent
  // nothing until its target moves.
  const house = parkedA3();
  poweredUp(house);
  const journal: Kept = { kind: 'starting', beliefs: house.state!.beliefs, share: { kind: 'house' } };
  const turn = handleInput(journal, houseView(house.states, '2026-09-21T12:08:00Z'), { kind: 'started' }, HOUSE);
  assert.deepEqual(publishedTo(turn, bulbA3).map(publish => publish.payload), [{ brightness: 220, color_temp: 250, transition: 0.2 }]);
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

test("a failed publish is retried after its backoff, and the turn asks to be woken for it", () => {
  // Amendment 8.2. Break: every send is taken as sent whatever the host reports, so a lost publish waits for the
  // next change, which may be hours away, and the bulb shows the wrong light until then.
  const house = new House();
  house.turn('12:00:00', { kind: 'started' });
  house.bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, { kind: 'kelvin', kelvin: toKelvin(4000) }) });
  writeBack(house.bulbs, house.states);
  const failing = (output: Output) => output.kind === 'publish' && output.publish.topic === `zigbee2mqtt/${bulbA3}`;
  const turn = house.turn('12:01:00', { kind: 'tick' }, failing);
  const retryAt = toInstant(Date.parse('2026-09-21T12:01:01Z') / 1000);
  assert.deepEqual(turn.state.beliefs.bulbs[bulbA3], { kind: 'retrying', shows: undefined, attempts: 1, retryAt });
  assert.equal(turn.wakeAt, retryAt);
});

test("the beliefs part-way through a turn hold only the sends whose outputs have all gone", () => {
  // Break: the journal saved after a bulb's send holds sends not yet made, so a restart part-way through a turn
  // believes a bulb shows a light it was never sent.
  const house = new House();
  const turn = handleInput(STARTING, houseView(house.states, '2026-09-21T12:00:00Z'), { kind: 'started' }, HOUSE);
  const none = afterOutputs(turn, []);
  assert.deepEqual(none.state.beliefs.bulbs, turn.state.beliefs.bulbs);
  const last = turn.outputs.map(output => output.kind).lastIndexOf('publish');
  const some = afterOutputs(turn, turn.outputs.slice(0, last).map(() => false));
  const all = afterOutputs(turn, turn.outputs.map(() => false));
  const believed = (settled: Settled) => Object.keys(settled.state.beliefs.bulbs).length;
  assert.ok(believed(none) < believed(some) && believed(some) < believed(all), `${believed(none)} ${believed(some)} ${believed(all)}`);
});

test('a missing Zigbee2MQTT bridge sensor counts as unknown: the bulbs are still sent, and the error is said once', () => {
  // Closeout r2 B3. Break: a missing sensor reads as disconnected, so nothing is sent and nothing said; or the error
  // is said every turn.
  const house = new House();
  delete house.states['binary_sensor.zigbee2mqtt_bridge_connection_state'];
  const start = house.turn('12:00:00', { kind: 'started' });
  assert.ok(publishesOf(start).length > 0, 'the start sends the bulbs');
  assert.deepEqual(start.errors.filter(error => error.includes('binary_sensor.zigbee2mqtt_bridge_connection_state')).length, 1);
  assert.deepEqual(house.turn('12:01:00', { kind: 'tick' }).errors, [], 'said once, not every turn');
  house.states['binary_sensor.zigbee2mqtt_bridge_connection_state'] = { state: 'off', attributes: {} };
  house.bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
  writeBack(house.bulbs, house.states);
  assert.deepEqual(publishesOf(house.turn('12:02:00', { kind: 'tick' })), [], 'a disconnected bridge is still sent nothing');
});

const PLANT_A = 'switch.plant_a';
const plantA = toSwitchId(PLANT_A);

/** A house with one plant light, `switch.plant_a` in `room-a`, and the all-off control off; then `change` to its states. */
function plantHouse(change: (states: Record<string, EntityState>) => void = () => {}): House {
  const house = new House({ plants: [PLANT_A] });
  house.states[PLANTS_ALL_OFF] = { state: 'off', attributes: {} };
  change(house.states);
  return house;
}

/** The turn's switch output for `switch.plant_a`, if it made one. */
function plantOut(turn: Turn): Extract<Output, { kind: 'switch' }> | undefined {
  return turn.outputs.find((output): output is Extract<Output, { kind: 'switch' }> => output.kind === 'switch' && output.switch === toSwitchId(PLANT_A));
}

/** The turn's write to the all-off control, if it made one. */
function allOffOut(turn: Turn): Output | undefined {
  return turn.outputs.find(output => output.kind === 'dashboard' && output.write.kind === 'plants all-off');
}

/** A plant house started at noon, all off switched on from the dashboard at 12:05, as Home Assistant stamps it. */
function allOffAt1205(): House {
  const house = plantHouse();
  house.turn('12:00:00', { kind: 'started' });
  house.states[PLANTS_ALL_OFF] = { state: 'on', attributes: {}, last_changed: '2026-09-21T12:05:00Z' };
  house.turn('12:05:00', { kind: 'wake' });
  return house;
}

test('all off from the dashboard switches the plant lights off, and is stored', () => {
  // Break: the control is not read, so the plant light stays on; or all off is not written to the sensor, so a
  // restart forgets it; or the port writes the control it was just switched by.
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  house.states[PLANTS_ALL_OFF] = { state: 'on', attributes: {} };
  const turn = house.turn('12:05:00', { kind: 'wake' });
  assert.equal(plantOut(turn)?.power, 'off');
  assert.notEqual(house.states['sensor.ls_overrides']!.attributes['plant_all_off'], undefined);
  assert.equal(allOffOut(turn), undefined);
});

test('at the next day start the plant lights go on and the control is switched off', () => {
  // Break: the control is not mirrored back, so it shows on after the hold is gone; or the control's on, read against
  // the clocked Model, sets all off again at the day start.
  const house = allOffAt1205();
  const turn = house.turn('2026-09-22T07:00:00', { kind: 'tick' });
  assert.equal(plantOut(turn)?.power, 'on');
  assert.deepEqual(allOffOut(turn), { kind: 'dashboard', write: { kind: 'plants all-off', entity: PLANTS_ALL_OFF, on: false } });
  assert.equal(house.turn('2026-09-22T07:01:00', { kind: 'tick' }).state.model.plantOverrides.allOff, undefined);
});

test('switching all off off by hand ends the hold at once', () => {
  // Break: the control's off is not read, so the plant lights stay off until the next day start.
  const house = allOffAt1205();
  house.states[PLANTS_ALL_OFF] = { state: 'off', attributes: {} };
  assert.equal(plantOut(house.turn('13:00:00', { kind: 'wake' }))?.power, 'on');
});

test('Review Focus 3: while the control\'s off write has not landed, its on does not set all off again', () => {
  // Break: the control is read as Home Assistant reports it, not with the port's own write still waiting laid over
  // it, so the refused off leaves it on and the next turn sets all off again.
  const house = allOffAt1205();
  const failing = (output: Output) => output.kind === 'dashboard' && output.write.kind === 'plants all-off';
  house.turn('2026-09-22T07:00:00', { kind: 'tick' }, failing);
  const next = house.turn('2026-09-22T07:01:00', { kind: 'tick' }, failing);
  assert.equal(next.state.model.plantOverrides.allOff, undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'on');
  // Past the refusal limit: the write is parked and no longer laid over the house, so the control shows its old on.
  const warnings: string[] = [];
  for (const minute of ['02', '03', '04', '05', '06', '07', '08']) {
    const turn = house.turn(`2026-09-22T07:${minute}:00`, { kind: 'tick' }, failing);
    warnings.push(...turn.warnings);
    assert.equal(turn.state.model.plantOverrides.allOff, undefined, `07:${minute}`);
    assert.equal(house.states['switch.plant_a']!.state, 'on', `07:${minute}`);
  }
  assert.ok(warnings.some(warning => warning.includes(PLANTS_ALL_OFF) && warning.includes('parked')), 'the control\'s write was parked');
  // Home Assistant back: the parked off is laid over again, and the plant lights stay on.
  const back = house.turn('2026-09-22T07:09:00', { kind: 'reconnected' });
  assert.equal(back.state.model.plantOverrides.allOff, undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'on');
  assert.equal(house.states[PLANTS_ALL_OFF]!.state, 'off', 'the control is switched off once Home Assistant takes it');
});

test('Review Focus 3: a control Home Assistant shows with no stamp is not read as a new on at the day start that releases it', () => {
  // Break: the control is read against the clocked Model, so at the releasing day start an on that carries no
  // `last_changed` (taken as switched on now) sets all off again before the port's off is even queued.
  const house = allOffAt1205();
  house.states[PLANTS_ALL_OFF] = { state: 'on', attributes: {} };
  const turn = house.turn('2026-09-22T07:00:00', { kind: 'tick' });
  assert.equal(turn.state.model.plantOverrides.allOff, undefined);
  assert.equal(plantOut(turn)?.power, 'on');
});

test('Review Focus 3: a restart before the control\'s off lands does not set all off again', () => {
  // Break: the outbox is not journalled, so after a restart the control's old on is read as a level against a sensor
  // that no longer holds the hold, and all off is set again for a day no person chose.
  const house = allOffAt1205();
  const failing = (output: Output) => output.kind === 'dashboard' && output.write.kind === 'plants all-off';
  house.turn('2026-09-22T07:00:00', { kind: 'tick' }, failing);
  house.state = undefined;                         // the process starts again; its outbox is lost
  const turn = house.turn('2026-09-22T07:02:00', { kind: 'started' });
  assert.equal(turn.state.model.plantOverrides.allOff, undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'on');
  assert.equal(house.states[PLANTS_ALL_OFF]!.state, 'off', 'the control is switched off');
});

test('Review Focus 2: a start while the control is unavailable keeps a stored all-off', () => {
  // Break: an unavailable control reads as off, so a restart before Home Assistant loads it clears the stored hold
  // and the plant lights come on.
  const house = allOffAt1205();
  house.state = undefined;                         // the process starts again
  house.states[PLANTS_ALL_OFF] = { state: 'unavailable', attributes: {} };
  const turn = house.turn('12:30:00', { kind: 'started' });
  assert.notEqual(turn.state.model.plantOverrides.allOff, undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'off');
});

test('the control switching is a reason for a turn', () => {
  // Break: no turn runs when the control is switched, so all off waits for the next minute's tick.
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  assert.equal(wantsTurn({ kind: 'running', state: house.state! }, PLANTS_ALL_OFF, { state: 'on', attributes: {} }), true);
});

test('the all-off control is switched off at the day start while some room is still the old scripts\'', () => {
  // Break: the control's write is made only with the whole house, as the dashboard's other writes are, so during the
  // rollout it shows on after the hold is gone; the old scripts do not know the control.
  const house = allOffAt1205();
  house.states['input_boolean.ls_room-a_on_port'] = { state: 'on', attributes: {} };
  const rooms: RoomsGiven = { kind: 'listed', rooms: new Set([roomA]) };
  const turn = handleInput({ kind: 'running', state: house.state! }, houseView(house.states, '2026-09-22T07:00:00Z', house.plants), { kind: 'tick' }, rooms);
  assert.deepEqual(allOffOut(turn), { kind: 'dashboard', write: { kind: 'plants all-off', entity: PLANTS_ALL_OFF, on: false } });
});

/**
 * A plant house started at noon, where the start sends `switch.plant_a` on, and the host's turn when Home Assistant
 * reports that on landed (`wantsTurn`, a wake): a later change is read against the plug seen on, with no send open.
 */
function plantHouseAtNoon(): House {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  assert.equal(house.states['switch.plant_a']!.state, 'on', 'control: the start switched the plant light on');
  house.turn('12:00:01', { kind: 'wake' });
  return house;
}

/** A plant house started at noon, `switch.plant_a` switched off by hand at 12:05. */
function handOffAt1205(): House {
  const house = plantHouseAtNoon();
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  house.turn('12:05:00', { kind: 'wake' });
  return house;
}

test('a start sends a plant light what the clock says, at any instant', () => {
  // Regression (passes after Task 6). Break: a start reads the plug's power as a hand switch, or sends it nothing.
  const on = plantHouse(); assert.equal(plantOut(on.turn('12:00:00', { kind: 'started' }))?.power, 'on');
  const off = plantHouse(states => { states['switch.plant_a'] = { state: 'on', attributes: {} }; });
  assert.equal(plantOut(off.turn('20:00:00', { kind: 'started' }))?.power, 'off');
});
test('a plant light switched by hand holds until the next day start', () => {
  // Regression. Break: the press is taken back, or held past the next day start.
  const house = plantHouseAtNoon();
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const pressed = house.turn('12:05:00', { kind: 'wake' });
  assert.equal(plantOut(pressed), undefined);
  assert.equal(pressed.state.model.plantOverrides.handSwitches[plantA]?.power, 'off');
  assert.equal(plantOut(house.turn('18:00:00', { kind: 'tick' })), undefined);
  assert.equal(plantOut(house.turn('2026-09-22T07:00:00', { kind: 'tick' }))?.power, 'on');
});
test('a hand switch survives a restart', () => {
  // Regression. Break: the hand switch is not stored, so the start puts the plug back on.
  const house = handOffAt1205();
  house.state = undefined;
  assert.equal(plantOut(house.turn('12:30:00', { kind: 'started' })), undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'off');
});
test('a plant light found changed when Home Assistant is back is put right, not held', () => {
  // Spec 3.7.5. Break: a change seen across a reconnect is read as the plug's own button and held for the day.
  const house = plantHouseAtNoon();
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const turn = house.turn('12:10:00', { kind: 'reconnected' });
  assert.equal(plantOut(turn)?.power, 'on');
  assert.equal(turn.state.model.plantOverrides.handSwitches[plantA], undefined);
});
test('Review Focus 1: a plug out of reach at its day start is sent its power when it is back, with no hold', () => {
  // Regression (Amendment 8.1). Break: its return from out of reach is read as its own button, held off for the day.
  const house = plantHouse();
  assert.equal(plantOut(house.turn('06:00:00', { kind: 'started' })), undefined, 'control: off before the day start, nothing sent');
  house.states['switch.plant_a'] = { state: 'unavailable', attributes: {} };
  assert.equal(plantOut(house.turn('07:00:00', { kind: 'tick' })), undefined);
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const back = house.turn('07:10:00', { kind: 'wake' });
  assert.equal(plantOut(back)?.power, 'on');
  assert.equal(back.state.model.plantOverrides.handSwitches[plantA], undefined);
});
test('a range save for a plant light is refused and logged', () => {
  // Spec 3.7.4. Break: the save is dropped quietly by the domain, so the dashboard says nothing of why.
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  const turn = house.turn('12:05:00', bridged('ls_range_save', { entity: 'switch.plant_a', profile: 'bright' }));
  assert.match(turn.dropped ?? '', /is a plant light/);
  assert.equal(turn.state.model.switchRanges[plantA], undefined);
});
test('a range rule stored for a plant light is said once', () => {
  // Spec 3.7.4. Break: the stored rule is ignored without a word, or the error is said every turn.
  const house = plantHouse(states => { states['sensor.ls_overrides']!.attributes.switch_ranges = { 'switch.plant_a': { profile: 'bright' } }; });
  const said = (turn: Turn) => turn.errors.filter(error => /switch\.plant_a is a plant light/.test(error)).length;
  assert.equal(said(house.turn('12:00:00', { kind: 'started' })), 1);
  assert.equal(said(house.turn('12:01:00', { kind: 'tick' })), 0);
});
test('a lighting switch\'s own button is still an overlay', () => {
  // Regression. Break: the plant lights' rules reach a lighting switch, whose press is no longer an overlay.
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  house.states['switch.plug_a'] = { state: house.states['switch.plug_a']!.state === 'on' ? 'off' : 'on', attributes: {} };
  assert.notEqual(house.turn('12:05:00', { kind: 'wake' }).state.model.overlays.switches[toSwitchId('switch.plug_a')], undefined);
});
test('a plant light found changed when Home Assistant starts again under a running port is put right, not held', () => {
  // Spec 3.7.5, the start half. Break: only a reconnect is read afresh, so Home Assistant's own start, which the port
  // runs through as `started` with its state kept, reads the change as the plug's own button.
  const house = plantHouseAtNoon();
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const turn = house.turn('12:10:00', { kind: 'started' });
  assert.equal(plantOut(turn)?.power, 'on');
  assert.equal(turn.state.model.plantOverrides.handSwitches[plantA], undefined);
});
test('a switch overlay stored for a plant light is said once', () => {
  // Spec 3.7.4. Break: only a stored range rule is said, and a lighting overlay left from before the label is ignored
  // without a word.
  const house = plantHouse(states => {
    states['sensor.ls_overrides']!.attributes.switch_overlays = { 'switch.plant_a': { power: 'off', when: '2026-09-21T11:30:00Z' } };
  });
  const said = (turn: Turn) => turn.errors.filter(error => /switch\.plant_a is a plant light/.test(error)).length;
  const started = house.turn('12:00:00', { kind: 'started' });
  assert.notEqual(started.state.model.overlays.switches[plantA], undefined, 'control: the overlay is read into the Model');
  assert.equal(said(started), 1);
  assert.equal(said(house.turn('12:01:00', { kind: 'tick' })), 0);
});
test('a lighting switch found changed when Home Assistant is back is still its own button', () => {
  // Interface 1, as today. Break: every switch found changed at a reconnect is put right, a lighting switch's press too.
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  assert.equal(house.states['switch.plug_a']!.state, 'off', 'control: the plug is off and was sent nothing');
  house.states['switch.plug_a'] = { state: 'on', attributes: {} };
  const turn = house.turn('12:10:00', { kind: 'reconnected' });
  assert.equal(turn.state.model.overlays.switches[plugA]?.power, 'on');
  assert.deepEqual(switchesSent(turn).filter(([plug]) => plug === plugA), []);
});
