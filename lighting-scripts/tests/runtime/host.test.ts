import assert from 'node:assert/strict';
import test from 'node:test';
import { Host } from '../../src/host.ts';
import type { HostIo, Journal } from '../../src/host.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { HouseMirror } from '../../src/adapter/codecs/house.ts';
import { afterCall } from '../../src/adapter/codecs/house.ts';
import { loadJournal } from '../../src/adapter/codecs/journal.ts';
import { toInstant, toMqttTopic, toRoomId } from '../../src/adapter/codecs/ids.ts';
import { parseLiveRooms } from '../../src/adapter/live-rooms.ts';
import { startHeartbeat } from '../../src/main.ts';
import type { Publish } from '../../src/adapter/encode.ts';
import { Unreachable } from '../../src/adapter/ha-client.ts';
import type { EntityState, JsonObject, ServiceCall } from '../../src/adapter/ha-client.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { CATALOG, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { bridged } from './support/inputs.ts';

const loadBeliefs = (text: string | undefined) => loadJournal(text).beliefs;

/**
 * The host on the synthetic house, with a fake Home Assistant whose bulbs the publishes move, an in-memory journal,
 * a clock the test sets and timers the test fires. Monday 2026-09-21, UTC.
 */

const catalog = parseCatalog(CATALOG);
const at = (time: string): Instant => toInstant(Date.parse(`2026-09-21T${time}Z`) / 1000);
const bulbA1 = 'bulb-a1' as BulbId;

/** Home Assistant as the host sees it: each call recorded, its helper writes applied, its publishes reaching the bulbs. */
class FakeHa {
  readonly calls: ServiceCall[] = [];
  readonly bulbs: FakeBulbs = world();
  states: Record<string, EntityState> = syntheticStates();
  /** Calls that fail, and the moment each call is made, to hold it there. */
  failing: (call: ServiceCall) => boolean = () => false;
  /** Out of reach: every call rejects as the client does when the connection is down. */
  unreachable = false;
  during: (call: ServiceCall) => Promise<void> = async () => {};

  constructor() {
    writeBack(this.bulbs, this.states);
  }

  /** Each call is answered with the context id `context-<n>`, n counting the calls from 1. */
  async call(call: ServiceCall): Promise<string | undefined> {
    this.calls.push(call);
    const context = `context-${this.calls.length}`;
    await this.during(call);
    if (this.unreachable) throw new Unreachable('Home Assistant is disconnected');
    if (this.failing(call)) throw new Error('Home Assistant did not take it');
    this.states = afterCall(this.states, call, toInstant(Date.now() / 1000));
    if (call.service === 'mqtt.publish' && typeof call.data.topic === 'string' && typeof call.data.payload === 'string'
      && call.data.topic.startsWith('zigbee2mqtt/')) {
      this.bulbs.apply([{ topic: toMqttTopic(call.data.topic), payload: JSON.parse(call.data.payload) as Publish['payload'] }]);
      writeBack(this.bulbs, this.states);
    }
    return context;
  }

  mirror(): HouseMirror {
    return { state: structuredClone(this.states), areas: { 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b',
      'switch.plug_a': 'room-a', 'remote-a': 'room-a' }, members: [], labels: { on_off: ['switch.plug_a'], private_room: ['room-b'] },
    devices: { 'device-plug-a': ['switch.plug_a'] }, timezone: 'UTC' };
  }

  publishesTo(bulb: BulbId): ServiceCall[] {
    return this.calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === `zigbee2mqtt/${bulb}`);
  }
}

/** A journal in memory, with every text it was saved, in order. */
class MemoryJournal implements Journal {
  readonly saved: string[] = [];
  private text: string | undefined = undefined;
  async load(): Promise<string | undefined> { return this.text; }
  async save(text: string): Promise<void> { this.text = text; this.saved.push(text); }
}

/** Timers the test fires: each set timer, and whether it was cancelled. */
class FakeTimers {
  readonly set: { delayMs: number; wake: () => void; cancelled: boolean; fired: boolean }[] = [];
  start(delayMs: number, wake: () => void): () => void {
    const timer = { delayMs, wake: () => { timer.fired = true; wake(); }, cancelled: false, fired: false };
    this.set.push(timer);
    return () => { timer.cancelled = true; };
  }
  /** The timers still to fire: neither cancelled nor spent. */
  live() { return this.set.filter(timer => !timer.cancelled && !timer.fired); }
}

function open(ha: FakeHa, journal: MemoryJournal, now: { time: Instant }, timers = new FakeTimers()) {
  const logged: string[] = [];
  const io: HostIo = { ha, journal, clock: () => now.time,
    log: { info: m => logged.push(m), warn: m => logged.push(`warn: ${m}`), error: m => logged.push(m) },
    timer: (delayMs, wake) => timers.start(delayMs, wake), rooms: { kind: 'house' } };
  return { host: Host.open(io, ha.mirror(), catalog), logged, timers };
}

test('inputs run one at a time', async () => {
  // Break: a second input's turn starts while the first is still sending, so both read the house before either wrote.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  let inside = 0, overlapped = false;
  ha.during = async () => { inside++; if (inside > 1) overlapped = true; await new Promise(resolve => setImmediate(resolve)); inside--; };
  const { host } = open(ha, new MemoryJournal(), now);
  const opened = await host;
  opened.accept({ kind: 'started' });
  opened.accept(bridged('ls_remote_command', { command: 'toggle', area: 'room-a', source: 'remote-a' }));
  opened.accept({ kind: 'tick' });
  await opened.idle();
  assert.equal(overlapped, false);
  assert.ok(ha.calls.length > 0);
  assert.equal(ha.states['bulb-a3']?.state, 'off');
  await opened.close();
});

test("a send's failure reaches afterSend", async () => {
  // Break: the host takes every call as made, so a bulb whose publish failed is believed to show its light.
  const ha = new FakeHa(), now = { time: at('12:00:00') }, journal = new MemoryJournal();
  ha.failing = call => call.data.topic === 'zigbee2mqtt/bulb-a3';
  const host = await open(ha, journal, now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const beliefs = loadBeliefs(journal.saved.at(-1));
  assert.equal(beliefs.bulbs['bulb-a3' as BulbId]?.kind, 'retrying');
  assert.equal(beliefs.bulbs['bulb-a2' as BulbId]?.kind, 'sent');
  await host.close();
});

test('the journal is saved after each bulb send', async () => {
  // Break: the journal is saved once at the end of the turn, so a crash part-way through loses what was sent.
  const ha = new FakeHa(), now = { time: at('12:00:00') }, journal = new MemoryJournal();
  const host = await open(ha, journal, now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const publishes = ha.calls.filter(call => call.service === 'mqtt.publish' && String(call.data.topic).startsWith('zigbee2mqtt/'));
  assert.ok(publishes.length > 1);
  assert.equal(journal.saved.length, publishes.length);
  const believed = journal.saved.map(text => Object.keys(loadBeliefs(text).bulbs).length);
  assert.deepEqual(believed, [...believed].sort((a, b) => a - b));
  assert.equal(believed.at(-1), 4);
  await host.close();
});

test("one timer is set for the turn's wake time and replaced by the next turn", async () => {
  // Break: each turn adds a timer, so the house is woken once per earlier turn; or a fired timer wakes nothing.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const { host: opening, timers } = open(ha, new MemoryJournal(), now);
  const host = await opening;
  host.accept({ kind: 'started' });
  await host.idle();
  assert.equal(timers.live().length, 1);
  const first = timers.live()[0]!;
  now.time = at('12:01:00');
  host.accept({ kind: 'tick' });
  await host.idle();
  assert.equal(timers.live().length, 1);
  assert.equal(first.cancelled, true);
  const before = ha.calls.length;
  now.time = at('17:00:00');
  timers.live()[0]!.wake();
  await host.idle();
  assert.ok(ha.calls.length > before, 'the wake ran a turn');
  await host.close();
});

test('a restart loads the journal and sends nothing the bulbs already show', async () => {
  // Break: the journal is not read, so the candle-firmware bulb, whose report cannot show a candle, is sent its stop
  // and its light again at every restart.
  const ha = new FakeHa(), now = { time: at('12:00:00') }, journal = new MemoryJournal();
  const first = await open(ha, journal, now).host;
  first.accept({ kind: 'started' });
  await first.idle();
  await first.close();
  assert.ok(ha.publishesTo(bulbA1).length > 0);

  ha.calls.length = 0;
  now.time = at('12:00:30');
  const restarted = await open(ha, journal, now).host;
  restarted.accept({ kind: 'started' });
  await restarted.idle();
  assert.deepEqual(['bulb-a1', 'bulb-a2', 'bulb-a3', 'bulb-b1'].flatMap(bulb => ha.publishesTo(bulb as BulbId)), []);
  await restarted.close();

  const forgetful = await open(ha, new MemoryJournal(), now).host;
  forgetful.accept({ kind: 'started' });
  await forgetful.idle();
  assert.ok(ha.publishesTo(bulbA1).length > 0, 'with no journal the candle-firmware bulb is sent again');
  await forgetful.close();
});

test('a turn that throws still leaves a wake set', async () => {
  // Review 5. Break: the timer is armed after the turn's sends only, so a turn that throws (here a state Home
  // Assistant sent with no attributes) leaves the fired timer spent, and retries and fade steps wait for the next tick.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const { host: opening, timers, logged } = open(ha, new MemoryJournal(), now);
  const host = await opening;
  host.accept({ kind: 'started' });
  await host.idle();
  host.stateChanged('bulb-a1', { state: 'on', attributes: null as never });
  now.time = at('12:00:30');
  timers.live()[0]!.wake();
  await host.idle();
  assert.ok(logged.some(line => /lighting: /.test(line)), 'the failed turn is logged');
  assert.equal(timers.live().length, 1, 'a wake is set again');
  await host.close();
});

test("a house read does not undo a newer state: a plug falling back off is not read as a press", async () => {
  // Review 4. Break: the read, started before the plug fell back off, is put back whole over the newer event, so the
  // next turn sees the plug on, takes it for its own button, and holds it on.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const plug = (state: string, time: string): EntityState =>
    ({ entity_id: 'switch.plug_a', state, attributes: {}, last_changed: `2026-09-21T${time}Z`, last_updated: `2026-09-21T${time}Z` });
  const stale = ha.mirror();
  stale.state['switch.plug_a'] = plug('on', '12:00:05');
  host.stateChanged('switch.plug_a', plug('on', '12:00:05'));
  host.stateChanged('switch.plug_a', plug('off', '12:00:20'));
  host.houseRead(stale, at('12:00:10'));
  await host.idle();
  const before = ha.calls.length;
  now.time = at('12:01:00');
  host.accept({ kind: 'tick' });
  await host.idle();
  assert.equal(host.house().state['switch.plug_a']?.state, 'off');
  const overlays = ha.calls.slice(before).filter(call => call.target?.entity_id === 'sensor.ls_overrides' || call.data.entity_id === 'sensor.ls_overrides');
  assert.deepEqual(overlays, [], 'no hold is written for the plug');
  await host.close();
});

test("our own call's echo is dropped, though it arrives before the call is answered; a person's reaches the lighting", async () => {
  // Layer check 1 (was the client's). Break: a mode change our own call made comes back through the bridge and is
  // taken for a person's, or every bridge run of that automation is dropped, a person's with it.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const modeSwitch = (on: boolean, context: string) => ({
    trigger: { id: on ? 'on' : 'off', to_state: { state: on ? 'on' : 'off', context: { id: context, user_id: 'a-person' } } },
  });
  const sensorWrites = () => ha.calls.filter(call => call.service === 'variable.update_sensor' && JSON.stringify(call).includes('ls_overrides'));
  let sent = false;
  ha.during = async () => {
    if (sent) return;
    sent = true;
    host.script('automation.lighting_schedule_sara_mode_switch', modeSwitch(true, `context-${ha.calls.length}`));
  };
  const before = sensorWrites().length;
  now.time = at('12:00:10');
  host.accept(bridged('ls_override_block', { scope: 'room-a', block: 'night' }));
  await host.idle();
  ha.during = async () => {};
  assert.equal(sensorWrites().length, before + 1, "the hold's write only: the echo turned no mode on");
  host.script('automation.lighting_schedule_sara_mode_switch', modeSwitch(true, 'a-person-context'));
  await host.idle();
  assert.equal(sensorWrites().length, before + 2, "the person's change reached the lighting");
  await host.close();
});

const kinds = (journal: MemoryJournal) => Object.values(loadBeliefs(journal.saved.at(-1)).bulbs).map(belief => belief.kind);

test('a disconnect mid-fade counts no failure and pauses; the reconnect sends the fade where it is now', async () => {
  // Review 1. Break: while Home Assistant is down every publish counts as a bulb's failure, so the fading bulbs are
  // retried and parked, stay at their last step, and the reconnect sends them nothing; or the wakes run on regardless.
  const ha = new FakeHa(), now = { time: at('16:50:00') }, journal = new MemoryJournal();
  const { host: opening, timers, logged } = open(ha, journal, now);
  const host = await opening;
  host.accept({ kind: 'started' });
  await host.idle();
  const level = () => ha.states['bulb-a3']?.attributes['brightness'];
  const fading = level();
  ha.unreachable = true;
  now.time = at('16:50:30');
  timers.live()[0]!.wake();
  await host.idle();
  const made = ha.calls.length;
  for (const time of ['16:51:00', '16:52:00', '16:53:00']) {
    now.time = at(time);
    host.accept({ kind: 'tick' });
    await host.idle();
  }
  assert.equal(ha.calls.length, made, 'nothing more is sent while Home Assistant is out of reach');
  assert.deepEqual(timers.live(), [], 'no wake runs while it is out of reach');
  assert.ok(logged.some(line => line.startsWith('warn: ') && /out of reach/.test(line)));
  assert.ok(!kinds(journal).some(kind => kind === 'retrying' || kind === 'parked'), 'no bulb counts a failure');
  ha.unreachable = false;
  now.time = at('17:10:00');
  host.reconnected(ha.mirror(), at('17:10:00'));
  await host.idle();
  assert.notEqual(level(), fading, 'the fade went on to where it is now');
  assert.ok(logged.some(line => line.startsWith('warn: ') && /back/.test(line)));
  assert.equal(timers.live().length, 1);
  await host.close();
});

test('a reconnect unparks every parked bulb and sends it its light', async () => {
  // Review 2. Break: a bulb parked while Home Assistant or its bulbs misbehaved stays parked through the reconnect,
  // until its light changes, hours later perhaps.
  const ha = new FakeHa(), now = { time: at('12:00:00') }, journal = new MemoryJournal();
  const { host: opening, timers } = open(ha, journal, now);
  const host = await opening;
  ha.failing = call => call.data.topic === 'zigbee2mqtt/bulb-a3';
  host.accept({ kind: 'started' });
  await host.idle();
  for (let tries = 0; tries < 6 && loadBeliefs(journal.saved.at(-1)).bulbs['bulb-a3' as BulbId]?.kind !== 'parked'; tries++) {
    now.time = toInstant(now.time + 61);
    timers.live()[0]!.wake();
    await host.idle();
  }
  assert.equal(loadBeliefs(journal.saved.at(-1)).bulbs['bulb-a3' as BulbId]?.kind, 'parked');
  ha.failing = () => false;
  const before = ha.publishesTo('bulb-a3' as BulbId).length;
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  assert.ok(ha.publishesTo('bulb-a3' as BulbId).length > before, 'the bulb is sent its light again');
  assert.equal(loadBeliefs(journal.saved.at(-1)).bulbs['bulb-a3' as BulbId]?.kind, 'sent');
  await host.close();
});


test('a save made as Home Assistant goes out of reach survives the reconnect and lands', async () => {
  // Re-review 1. Break: the reconnect reads the profiles again from what Home Assistant still holds, the Model takes
  // the old profile over the save, and the save is never written.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const store = 'input_text.ls_house_day', before = ha.states[store]?.state;
  ha.unreachable = true;
  now.time = at('12:01:00');
  host.accept(bridged('ls_store', { store, brightness: 100, kelvin: 2500 }));
  await host.idle();
  assert.equal(ha.states[store]?.state, before);
  ha.unreachable = false;
  now.time = at('12:05:00');
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  assert.deepEqual(JSON.parse(ha.states[store]?.state ?? '{}'), { b: 100, m: 'ct', k: 2500, effect_channels: [] });
  const shown = ha.bulbs.shows('bulb-b1' as BulbId);
  assert.deepEqual(shown.reach === 'reachable' ? shown.light : shown, { power: 'on', level: 100, colour: { kind: 'kelvin', kelvin: 2500 },
    effect: 'none' }, "the lamps show the save, which the reconnect's read did not undo");
  await host.close();
});

test('a button pressed while Home Assistant is coming back is applied after the reconnect', async () => {
  // Re-review 3. Break: the press arrives after the connection is up but before the reconnect has run, finds the
  // host paused, and is dropped without a word.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  assert.equal(ha.states['bulb-a3']?.state, 'on');
  host.disconnected();
  now.time = at('12:01:00');
  host.accept(bridged('ls_remote_command', { command: 'toggle', area: 'room-a', source: 'remote-a' }));
  await host.idle();
  assert.equal(ha.states['bulb-a3']?.state, 'on', 'nothing is sent while paused');
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  assert.equal(ha.states['bulb-a3']?.state, 'off', 'the press was applied, after the reconnect');
  await host.close();
});

test("our write is stamped when Home Assistant answered it, so a read started during the call does not undo it", async () => {
  // Re-review 5. Break: the write is stamped with the turn's start, before the read started, so the read's older copy
  // is taken over it.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const stale = ha.mirror();
  stale.state['sensor.ls_overrides'] = { ...stale.state['sensor.ls_overrides']!, last_updated: '2026-09-21T12:00:00Z' };
  ha.during = async call => { if (call.service === 'variable.update_sensor') now.time = at('12:00:20'); };
  now.time = at('12:00:10');
  host.accept(bridged('ls_override_block', { scope: 'room-a', block: 'night' }));
  await host.idle();
  const written = host.house().state['sensor.ls_overrides'];
  assert.notDeepEqual(written?.attributes, stale.state['sensor.ls_overrides']?.attributes, 'the hold was written');
  host.houseRead(stale, at('12:00:15'));
  await host.idle();
  assert.deepEqual(host.house().state['sensor.ls_overrides']?.attributes, written?.attributes);
  await host.close();
});

test('a held input that throws is logged, and the press held after it is still applied', async () => {
  // Final review 1. Break: the held inputs run as one step, so the first that throws ends it, and the press held after
  // it is lost without a word.
  const ha = new FakeHa(), now = { time: at('12:00:00') }, logged: string[] = [];
  let broken = false;
  ha.during = async call => { if (call.data.topic === 'zigbee2mqtt/bulb-b1') broken = true; };
  const host = await Host.open({ ha, journal: new MemoryJournal(), clock: () => now.time,
    log: { info: () => {}, warn: () => {}, error: message => logged.push(message) }, timer: () => () => {}, rooms: { kind: 'house' },
    took: () => { if (broken) { broken = false; throw new Error('the hold broke'); } } }, ha.mirror(), catalog);
  host.accept({ kind: 'started' });
  await host.idle();
  const roomB = structuredClone(ha.states['bulb-b1']);
  assert.equal(ha.states['bulb-a3']?.state, 'on');
  host.disconnected();
  now.time = at('12:01:00');
  host.accept(bridged('ls_override_block', { scope: 'room-b', block: 'night' }));
  host.accept(bridged('ls_remote_command', { command: 'toggle', area: 'room-a', source: 'remote-a' }));
  await host.idle();
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  assert.notDeepEqual(ha.states['bulb-b1'], roomB, "the hold ran, sent room b its night, and threw");
  assert.ok(logged.some(line => /the hold broke/.test(line)), 'the throw is logged');
  assert.equal(ha.states['bulb-a3']?.state, 'off', 'the press held after it was applied');
  await host.close();
});

/*
 * Close-out round 1 reproducers. Each is marked `todo` with its finding's id while the defect stands, so the suite
 * stays green; the fixer drops the mark once the fix makes it pass.
 */

const PLUG = 'switch.plug_a';
const plugCalls = (ha: FakeHa, service: string) => ha.calls.filter(call => call.service === service && call.target?.entity_id === PLUG);

/** A Home Assistant that takes every call but whose plug never switches: no state of the plug moves, no event comes. */
function deafPlug(): FakeHa {
  const ha = new FakeHa();
  ha.states[PLUG] = { state: 'on', attributes: {} };
  const take = ha.call.bind(ha);
  ha.call = async call => {
    const plug = structuredClone(ha.states[PLUG]);
    const context = await take(call);
    ha.states[PLUG] = plug!;
    return context;
  };
  return ha;
}

test('closeout r1 A1/B1: a switch call Home Assistant took but the plug missed is sent again', { todo: 'closeout r1 A1/B1' }, async () => {
  // Break: afterCall puts the switch's sent power into the mirror the moment Home Assistant answers, so the plug reads
  // as on target and is never sent again. The day block at 12:00 lights room-a at 220 (86%), outside plug_a's 20..60.
  const ha = deafPlug(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  assert.equal(plugCalls(ha, 'homeassistant.turn_off').length, 1, 'the plug is sent off once');
  for (const time of ['12:01:00', '12:02:00', '12:03:00']) {
    now.time = at(time);
    host.accept({ kind: 'tick' });
    await host.idle();
  }
  assert.equal(ha.states[PLUG]?.state, 'on', 'Home Assistant still shows the plug on');
  assert.ok(plugCalls(ha, 'homeassistant.turn_off').length > 1,
    `the plug still on is sent off again; mirror shows ${host.house().state[PLUG]?.state}, calls ${plugCalls(ha, 'homeassistant.turn_off').length}`);
  await host.close();
});

test('closeout r1 A1/B1: a full read of a plug that missed our call is no press, and the plug is sent its target', { todo: 'closeout r1 A1/B1' }, async () => {
  // Break: the mirror took the missed off as landed, so the read's real on reads as the plug's own button, and the
  // plug is held on against its range rule.
  const ha = deafPlug(), now = { time: at('12:00:00') };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  now.time = at('12:01:00');
  host.accept({ kind: 'tick' });
  await host.idle();
  const before = plugCalls(ha, 'homeassistant.turn_off').length;
  now.time = at('12:02:00');
  host.houseRead(ha.mirror(), at('12:02:00'));
  host.accept({ kind: 'tick' });
  await host.idle();
  assert.equal(host.house().state[PLUG]?.state, 'on', 'the read shows the plug on');
  const held = ha.calls.flatMap(call => {
    const attributes = call.service === 'variable.update_sensor' ? call.data.attributes as JsonObject | undefined : undefined;
    const overlays = attributes?.switch_overlays as JsonObject | undefined;
    return overlays?.[PLUG] === undefined ? [] : [overlays[PLUG]];
  });
  assert.ok(plugCalls(ha, 'homeassistant.turn_off').length > before,
    `the plug is sent off again; the plug's stored hold: ${JSON.stringify(held.at(-1))}`);
  await host.close();
});

test('closeout r1 A3: a host whose every turn throws stops its heartbeat, so the watchdog hands the room back', async () => {
  // Break: the heartbeat pauses only while Home Assistant is out of reach, so a port that drives nothing beats on.
  // The catalog lists one device under two remotes: it parses, and decodeRemotes throws on every turn.
  const broken = parseCatalog({ ...CATALOG, remotes: { 'room-a': { device_id: 'remote-a', source: 'remote-a' },
    unplaced: { device_id: 'remote-a', source: 'remote-b' } } });
  const ha = new FakeHa(), now = { time: at('12:00:00') }, logged: string[] = [];
  const host = await Host.open({ ha, journal: new MemoryJournal(), clock: () => now.time,
    log: { info: () => {}, warn: () => {}, error: message => logged.push(message) }, timer: () => () => {}, rooms: { kind: 'house' } },
  ha.mirror(), broken);
  for (const input of [{ kind: 'started' }, { kind: 'tick' }, { kind: 'wake' }] as const) host.accept(input);
  await host.idle();
  assert.equal(logged.filter(line => /more than one remote/.test(line)).length, 3, 'every turn threw');
  const beats: ServiceCall[] = [];
  const stop = startHeartbeat(parseLiveRooms('room-a'), async call => { beats.push(call); }, () => {}, 5, () => host.paused());
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
  } finally {
    stop();
  }
  assert.deepEqual(beats, [], `no beat from a host that drives nothing; host.paused() is ${host.paused()}`);
  await host.close();
});

test('a host that stopped its heartbeat after turns that threw resumes it at the first turn that succeeds, saying once that it stopped', async () => {
  // Break: the heartbeat stays stopped once stopped, so a fixed catalog never takes the rooms back; or a turn's throw
  // alone stops it; or the stop is not logged, or is logged at every failed turn after the third.
  const broken = parseCatalog({ ...CATALOG, remotes: { 'room-a': { device_id: 'remote-a', source: 'remote-a' },
    unplaced: { device_id: 'remote-a', source: 'remote-b' } } });
  const ha = new FakeHa(), now = { time: at('12:00:00') }, logged: string[] = [];
  const host = await Host.open({ ha, journal: new MemoryJournal(), clock: () => now.time,
    log: { info: () => {}, warn: () => {}, error: message => logged.push(message) }, timer: () => () => {}, rooms: { kind: 'house' } },
  ha.mirror(), broken);
  const stopped = () => logged.filter(line => /turns in a row failed/.test(line)).length;
  host.accept({ kind: 'started' }); host.accept({ kind: 'tick' });
  await host.idle();
  assert.equal(host.paused(), false, 'two turns that threw are not yet unhealthy');
  for (const input of [{ kind: 'wake' }, { kind: 'tick' }] as const) host.accept(input);
  await host.idle();
  assert.equal(host.paused(), true);
  assert.equal(stopped(), 1, 'the stop is logged once');
  host.catalogChanged(catalog);
  host.accept({ kind: 'wake' });
  await host.idle();
  assert.equal(host.paused(), false, 'the first turn that succeeds resumes the heartbeat');
  await host.close();
});

test('closeout r1 A4: a catalog reload with a new bulb sends that bulb its light at the wake', async () => {
  // Break: the wake main.ts sends after a reload keeps the Model's Config, decoded from the old catalog, so the new
  // bulb is not in any lamp until a helper changes or the process restarts.
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  ha.states['bulb-a4'] = { state: 'off', attributes: {} };
  const host = await open(ha, new MemoryJournal(), now).host;
  host.accept({ kind: 'started' });
  await host.idle();
  const grown = parseCatalog({ ...CATALOG, members: { ...CATALOG.members as JsonObject, 'light.lamp_a2': ['bulb-a3', 'bulb-a4'] },
    topics: { ...CATALOG.topics as JsonObject, 'bulb-a4': 'zigbee2mqtt/bulb-a4' } });
  const toA4 = () => ha.publishesTo('bulb-a4' as BulbId).length;
  host.catalogChanged(grown);
  now.time = at('12:00:10');
  host.accept({ kind: 'wake' });
  await host.idle();
  const atWake = toA4();
  now.time = at('12:00:20');
  host.accept({ kind: 'helper changed' });
  await host.idle();
  assert.ok(toA4() > atWake, 'control: a helper change, which reads the config again, sends the new bulb');
  assert.ok(atWake > 0, 'the wake after the reload sends the new bulb its light');
  await host.close();
});

test('closeout r1 B4: a turn that hands a room back saves the journal, so a restart takes the room as found', async () => {
  // Break: the journal is saved only after a bulb publish, so the turn that hands room-a back (no publish) is never
  // saved; the next start reads room-a as driven all along and trusts beliefs the old scripts made stale.
  const ha = new FakeHa(), now = { time: at('12:00:00') }, journal = new MemoryJournal();
  const portSwitch = 'input_boolean.ls_room-a_on_port';
  const live = (power: 'on' | 'off', time: string): EntityState =>
    ({ entity_id: portSwitch, state: power, attributes: {}, last_changed: `2026-09-21T${time}Z`, last_updated: `2026-09-21T${time}Z` });
  ha.states[portSwitch] = live('on', '11:00:00');
  const openListed = () => Host.open({ ha, journal, clock: () => now.time, log: { info: () => {}, warn: () => {}, error: () => {} },
    timer: () => () => {}, rooms: { kind: 'listed', rooms: new Set([toRoomId('room-a')]) } }, ha.mirror(), catalog);
  const first = await openListed();
  first.accept({ kind: 'started' });
  await first.idle();
  assert.ok(ha.publishesTo(bulbA1).length > 0, 'room-a is driven');
  assert.deepEqual(loadJournal(journal.saved.at(-1)).share, { kind: 'rooms', rooms: new Set(['room-a']) });
  ha.states[portSwitch] = live('off', '12:00:10');
  first.stateChanged(portSwitch, ha.states[portSwitch]);
  now.time = at('12:00:20');
  first.accept({ kind: 'tick' });
  await first.idle();
  await first.close();
  const handedBack = loadJournal(journal.saved.at(-1)).share;

  ha.states[portSwitch] = live('on', '12:00:30');
  ha.calls.length = 0;
  now.time = at('12:00:40');
  const second = await openListed();
  second.accept({ kind: 'started' });
  await second.idle();
  assert.ok(ha.publishesTo(bulbA1).length > 0,
    `room-a handed back and over again is taken as found; the journal's share after the hand-back: ${JSON.stringify([...(handedBack.kind === 'rooms' ? handedBack.rooms : ['house'])])}`);
  await second.close();
});
