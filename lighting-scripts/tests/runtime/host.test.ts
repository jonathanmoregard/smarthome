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
  during: (call: ServiceCall) => Promise<void> = async () => {};

  constructor() {
    writeBack(this.bulbs, this.states);
  }

  /** Each call is answered with the context id `context-<n>`, n counting the calls from 1. */
  async call(call: ServiceCall): Promise<string | undefined> {
    this.calls.push(call);
    const context = `context-${this.calls.length}`;
    await this.during(call);
    if (this.failing(call)) throw new Error('Home Assistant did not take it');
    this.states = afterCall(this.states, call, new Date().toISOString());
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
  const io: HostIo = { ha, journal, clock: () => now.time, log: { info: m => logged.push(m), error: m => logged.push(m) },
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
