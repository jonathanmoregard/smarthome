import assert from 'node:assert/strict';
import test from 'node:test';
import type { Publish } from '../../src/adapter/encode.ts';
import { configSource, decodeModel } from '../../src/adapter/codecs/model.ts';
import type { HaInput } from '../../src/adapter/codecs/inputs.ts';
import { afterOutputs, handleInput } from '../../src/adapter/loop.ts';
import type { Output } from '../../src/adapter/encode.ts';
import type { AdapterState, Kept, Settled, Turn } from '../../src/adapter/loop.ts';
import type { RoomsGiven } from '../../src/adapter/live-rooms.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { EntityState } from '../../src/adapter/ha-client.ts';
import { toInstant, toKelvin, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';
import { lit } from './fake-bulbs.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
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

  constructor() {
    writeBack(this.bulbs, this.states);
  }

  /**
   * One turn at `time` (UTC, on the Monday): its writes land in the states, its publishes reach the bulbs but for the
   * `failing` ones, and the turn is settled with how each output went.
   */
  turn(time: string, input: HaInput, failing: (output: Output) => boolean = () => false): Turn & Settled {
    const turn = handleInput(this.state === undefined ? STARTING : { kind: 'running', state: this.state }, houseView(this.states, `2026-09-21T${time}Z`), input, HOUSE);
    const failed = turn.outputs.map(failing);
    for (const output of turn.outputs) {
      if (output.kind === 'sensor') {
        const sensor = this.states[output.write.entity]!;
        this.states[output.write.entity] = { state: output.write.revision, attributes: { ...sensor.attributes, ...output.write.attributes } };
      }
      if (output.kind === 'switch') this.states[output.switch] = { state: output.power, attributes: {} };
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
  assert.equal(shows(house, 'bulb-b1' as BulbId).power, 'on');
});

test('inputs are applied one at a time in arrival order', () => {
  const house = new House();
  house.turn('16:40:00', { kind: 'started' });
  house.turn('16:55:00', { kind: 'tick' });
  const fading = shows(house, 'bulb-a3' as BulbId);
  assert.equal(fading.power, 'on');
  house.turn('16:55:20', bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
  const after = house.turn('16:56:00', { kind: 'tick' });
  assert.equal(after.state.model.overlays.roomPower[roomA], 'off');
  for (const bulb of ROOM_A_BULBS) assert.deepEqual(shows(house, bulb), { power: 'off' }, bulb);
  house.turn('16:56:20', bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
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

test("a plug pressed seconds after we switched it is held, though the next tick sees what the last one did", () => {
  // Review fix 1, read from HA's last_changed (option B). We switch the plug off at 12:00; it lands at 12:00:01 and a
  // person presses it on at 12:00:20, so the 12:01 tick sees on, as at 12:00. Break: the press is read against the
  // last look only, our off is sent again, and the press is lost.
  const house = new House();
  house.states['switch.plug_a'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T11:00:00Z' };
  assert.deepEqual(switchesSent(house.turn('12:00:00', { kind: 'started' })), [[plugA, 'off']]);
  house.states['switch.plug_a'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T12:00:20Z' };
  const tick = house.turn('12:01:00', { kind: 'tick' });
  assert.deepEqual(tick.state.model.overlays.switches[plugA], { power: 'on', since: Date.parse('2026-09-21T12:01:00Z') / 1000 });
  assert.deepEqual(switchesSent(tick), []);
  assert.deepEqual(switchesSent(house.turn('12:02:00', { kind: 'tick' })), []);
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
    parked.push(...house.turn(`12:0${minute}:30`, { kind: 'state changed', entities: ['light.lamp_a2'] }).parked);
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
