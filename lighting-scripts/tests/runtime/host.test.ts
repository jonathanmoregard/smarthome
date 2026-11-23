import assert from 'node:assert/strict';
import test from 'node:test';
import { Host } from '../../src/host.ts';
import type { HostIo, Journal } from '../../src/host.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { HouseMirror } from '../../src/adapter/codecs/house.ts';
import { afterCall } from '../../src/adapter/codecs/house.ts';
import { loadBeliefs } from '../../src/adapter/codecs/journal.ts';
import { toInstant, toMqttTopic } from '../../src/adapter/codecs/ids.ts';
import type { Publish } from '../../src/adapter/encode.ts';
import { Unreachable } from '../../src/adapter/ha-client.ts';
import type { EntityState, ServiceCall } from '../../src/adapter/ha-client.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { CATALOG, syntheticStates, world, writeBack } from './fixtures/house-view.ts';

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
    timer: (delayMs, wake) => timers.start(delayMs, wake) };
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
  opened.accept({ kind: 'remote command', data: { command: 'toggle', area: 'room-a', source: 'remote-a' } });
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
  host.accept({ kind: 'dashboard script', script: 'hold block', data: { scope: 'room-a', block: 'night' } });
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
  host.accept({ kind: 'store saved', data: { store, brightness: 100, kelvin: 2500 } });
  await host.idle();
  assert.equal(ha.states[store]?.state, before);
  ha.unreachable = false;
  now.time = at('12:05:00');
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  assert.deepEqual(JSON.parse(ha.states[store]?.state ?? '{}'), { b: 100, m: 'ct', k: 2500 });
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
  host.accept({ kind: 'remote command', data: { command: 'toggle', area: 'room-a', source: 'remote-a' } });
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
  host.accept({ kind: 'dashboard script', script: 'hold block', data: { scope: 'room-a', block: 'night' } });
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
    log: { info: () => {}, warn: () => {}, error: message => logged.push(message) }, timer: () => () => {},
    took: () => { if (broken) { broken = false; throw new Error('the hold broke'); } } }, ha.mirror(), catalog);
  host.accept({ kind: 'started' });
  await host.idle();
  const roomB = structuredClone(ha.states['bulb-b1']);
  assert.equal(ha.states['bulb-a3']?.state, 'on');
  host.disconnected();
  now.time = at('12:01:00');
  host.accept({ kind: 'dashboard script', script: 'hold block', data: { scope: 'room-b', block: 'night' } });
  host.accept({ kind: 'remote command', data: { command: 'toggle', area: 'room-a', source: 'remote-a' } });
  await host.idle();
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  assert.notDeepEqual(ha.states['bulb-b1'], roomB, "the hold ran, sent room b its night, and threw");
  assert.ok(logged.some(line => /the hold broke/.test(line)), 'the throw is logged');
  assert.equal(ha.states['bulb-a3']?.state, 'off', 'the press held after it was applied');
  await host.close();
});
