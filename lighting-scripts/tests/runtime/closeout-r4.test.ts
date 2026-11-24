import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createConnection } from 'home-assistant-js-websocket';
import type { HaWebSocket } from 'home-assistant-js-websocket';
import { readRuntimeCatalog, rereading } from '../../src/main.ts';
import { Host } from '../../src/host.ts';
import type { HostIo, Journal } from '../../src/host.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { HouseMirror } from '../../src/adapter/codecs/house.ts';
import { toEntityId, toInstant, toMqttTopic, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';
import { outputCall } from '../../src/adapter/encode.ts';
import type { Publish } from '../../src/adapter/encode.ts';
import type { HaInput } from '../../src/adapter/codecs/inputs.ts';
import type { RoomsGiven } from '../../src/adapter/live-rooms.ts';
import { afterOutputs, handleInput } from '../../src/adapter/loop.ts';
import type { Kept, Settled, Turn } from '../../src/adapter/loop.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import { HomeAssistantClient } from '../../src/adapter/ha-client.ts';
import type { EntityState, JsonObject, ServiceCall } from '../../src/adapter/ha-client.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { CATALOG, houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { servicesTook } from './support/fake-ha-services.ts';
import { bridged } from './support/inputs.ts';

/**
 * Close-out round 4 reproducers (`.superpowers/sdd/2026-11-22-m2-m6-build/closeout-r4-{A,B}.md`; verdicts in
 * closeout-r4-verdicts.md). Each defect that reproduced is a test marked `todo` with its id while it stands; the fixer
 * makes it pass and drops the mark. The synthetic house, Monday 2026-09-21, UTC: `room-a` (light.lamp_a1: bulb-a1,
 * bulb-a2; light.lamp_a2: bulb-a3; switch.plug_a, on while room-a's light is in its range, 17:09 to 22:14 on a
 * weekday), `room-b` (light.lamp_b1: bulb-b1).
 */

const HOUSE: RoomsGiven = { kind: 'house' };
const plugA = toSwitchId('switch.plug_a');

/* The loop alone, as closeout-r3.test.ts runs it: each output taken, the house left as the test sets it. */

/** Turns over `states` in the whole house, each settled with every output taken. */
function loop(states: Record<string, EntityState>) {
  writeBack(world(), states);
  let kept: Kept = { kind: 'starting', beliefs: NO_BELIEFS, share: { kind: 'house' } };
  return (time: string, input: HaInput): Turn & Settled => {
    const turn = handleInput(kept, houseView(states, `2026-09-21T${time}Z`), input, HOUSE);
    const settled = afterOutputs(turn, turn.outputs.map(() => false));
    kept = { kind: 'running', state: settled.state };
    return { ...turn, ...settled };
  };
}

const switchSends = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'switch' ? [`${output.switch} ${output.power}`] : []);

test('closeout r4 A1: our switch-on that lands after the target moved off is not taken for a press', { todo: 'closeout r4 A1' }, () => {
  // Break: switchesSeen drops an open send once the target moves off its power (src/adapter/reconcile.ts:300), so when
  // the send lands late, switchPressed finds no send of ours (reconcile.ts:251) and reads the plug's on as its own
  // button (loop.ts:211, inputs.ts:727): the plug is held on and is sent no off.
  const states = syntheticStates(change => {
    change['switch.plug_a'] = { state: 'off', attributes: {}, last_changed: '2026-09-21T20:00:00+00:00' };
  });
  const turn = loop(states);
  assert.deepEqual(switchSends(turn('22:13:00', { kind: 'started' })), ['switch.plug_a on'],
    "control: as the cosy light fades out, the plug's range (20..60 %) still wants it on");
  const moved = turn('22:14:05', { kind: 'wake' });
  assert.deepEqual(switchSends(moved), [], 'control: below the range at 22:14 it wants it off, and it still shows off');
  assert.deepEqual(moved.state.beliefs.switches, {}, 'control: the open on was dropped as the target moved off it');
  states['switch.plug_a'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T22:14:07+00:00' };
  const landed = turn('22:14:10', { kind: 'state changed', entities: [toEntityId('switch.plug_a')] });
  assert.deepEqual({ held: landed.state.model.overlays.switches[plugA], sent: switchSends(landed) }, { held: undefined, sent: ['switch.plug_a off'] },
    'our own late on is no press: the plug is not held, and is sent the off its range wants');
});

/** A person's light call as the lamp change detector forwards it: Home Assistant's call_service event data, target merged in. */
const personCall = (service: string, serviceData: JsonObject) => bridged('automation.lighting_schedule_lamp_change_detector', { trigger: { event: {
  context: { user_id: 'person-1', id: 'person-call' }, data: { domain: 'light', service, service_data: serviceData } } } });
const heldLamps = (turn: Turn) => JSON.stringify(turn.state.model.overlays.lamps);

test("closeout r4 A2/B4: a person's light.toggle, and a light call by floor_id, hold the lamps they reach", { todo: 'closeout r4 A2/B4' }, () => {
  // Break: lightCall reads only `turn_on` and `turn_off` (src/adapter/codecs/inputs.ts:494), so a toggle is no call;
  // callTargets reads entity_id, area_id, device_id and label_id (src/adapter/codecs/native-call.ts:58-61), and the
  // house view has no floors, so a floor_id call reaches no lamp. Either way nothing is held and the next turn puts the
  // lamp back. Home Assistant 2026.7.4 fires call_service with `service: 'toggle'` (components/light/__init__.py:549-553,
  // const.py:900) and merges the target, floor_id included, into service_data (core.py:2860-2861, 2880-2887;
  // helpers/config_validation.py:1328-1331).
  const run = (service: string, serviceData: JsonObject) => {
    const turn = loop(syntheticStates());
    turn('12:00:00', { kind: 'started' });
    return heldLamps(turn('12:00:10', personCall(service, serviceData)));
  };
  // Held: lamp_a2 itself, or room-a whole, as an area call holds it.
  const holdsA2 = (held: string) => /lamp_a2|"room":"room-a"/.test(held);
  assert.equal(holdsA2(run('turn_off', { entity_id: 'light.lamp_a2' })), true, 'control: a turn_off by entity holds the lamp');
  assert.equal(holdsA2(run('turn_off', { area_id: 'room-a' })), true, 'control: a turn_off by area holds its room');
  assert.equal(holdsA2(run('turn_on', { entity_id: 'light.lamp_b1' })), false, 'control: a call into room-b holds nothing of room-a');
  assert.deepEqual({ toggle: holdsA2(run('toggle', { entity_id: 'light.lamp_a2' })), floor: holdsA2(run('turn_off', { floor_id: 'ground' })) },
    { toggle: true, floor: true }, "a person's toggle of lamp_a2, and a turn_off of room-a's floor (`ground`, which the house view has yet to carry), hold it");
});

/* The host over a fake Home Assistant, as closeout-r3.test.ts runs it. */

const catalog = parseCatalog(CATALOG);
const at = (time: string): Instant => toInstant(Date.parse(`2026-09-21T${time}Z`) / 1000);
const AREAS = { 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b', 'switch.plug_a': 'room-a', 'remote-a': 'room-a' };
const DETECTOR = 'automation.lighting_schedule_lamp_change_detector';

class FakeHa {
  readonly calls: ServiceCall[] = [];
  readonly bulbs: FakeBulbs = world();
  states: Record<string, EntityState>;
  /** Runs as a call reaches Home Assistant, before it is answered. */
  during: (call: ServiceCall) => void = () => {};
  /** A call this says fails is refused with an error, as Home Assistant refuses a service call that raised. */
  fails: (call: ServiceCall) => boolean = () => false;
  /** A call this says hangs is left unanswered, as Home Assistant leaves a service call it is still running. */
  hangs: (call: ServiceCall) => boolean = () => false;
  readonly hung: ((error: Error) => void)[] = [];

  constructor(states: Record<string, EntityState> = syntheticStates()) {
    this.states = states;
    writeBack(this.bulbs, this.states);
  }

  async call(call: ServiceCall): Promise<string | undefined> {
    this.calls.push(call);
    this.during(call);
    if (this.fails(call)) throw new Error(`${call.service} refused`);
    if (this.hangs(call)) return new Promise((_resolve, reject) => { this.hung.push(reject); });
    // Home Assistant sets no state of an entity it does not have: an entity service call over a missing entity logs a
    // warning and answers success (helpers/service.py:765-771, 801-806; components/websocket_api/commands.py:281-292).
    const target = call.target?.entity_id;
    if (call.service === 'input_text.set_value' && typeof target === 'string' && this.states[target] === undefined) return `context-${this.calls.length}`;
    this.states = servicesTook(this.states, call, toInstant(Date.now() / 1000));
    if (call.service === 'mqtt.publish' && typeof call.data.topic === 'string' && typeof call.data.payload === 'string'
      && call.data.topic.startsWith('zigbee2mqtt/')) {
      this.bulbs.apply([{ topic: toMqttTopic(call.data.topic), payload: JSON.parse(call.data.payload) as Publish['payload'] }]);
      writeBack(this.bulbs, this.states);
    }
    return `context-${this.calls.length}`;
  }

  mirror(): HouseMirror {
    return { state: structuredClone(this.states), areas: AREAS, labels: { on_off: ['switch.plug_a'], private_room: ['room-b'] },
      devices: { 'device-plug-a': ['switch.plug_a'] }, timezone: 'UTC' };
  }

  light(bulb: string) {
    const shown = this.bulbs.shows(bulb as BulbId);
    return shown.reach === 'reachable' ? shown.light.power : 'unreachable';
  }
}

class MemoryJournal implements Journal {
  private text: string | undefined = undefined;
  async load(): Promise<string | undefined> { return this.text; }
  async save(text: string): Promise<void> { this.text = text; }
}

async function open(ha: FakeHa, rooms: RoomsGiven, clock: () => Instant, timer: HostIo['timer'] = () => () => {}) {
  const logged: string[] = [];
  const io: HostIo = { ha, journal: new MemoryJournal(), clock,
    log: { info: m => logged.push(m), warn: m => logged.push(`warn: ${m}`), error: m => logged.push(m) }, timer, rooms };
  return { host: await Host.open(io, ha.mirror(), catalog), logged };
}

test("closeout r4 A3: a person's light call that comes while a bulb's publish fails is taken", { todo: 'closeout r4 A3' }, async () => {
  // Break: script() marks a run that came while the turn was calling, and drops it when any call of that turn failed
  // (src/host.ts:72-74; bridgeVerdict, src/adapter/codecs/inputs.ts:697). A failed mqtt.publish cannot be a lamp change
  // detector's echo (that triggers on call_service of domain light, and the port calls no light service), yet the
  // person's turn_off is dropped and lamp_a2 is put back on.
  const run = async (publishFails: boolean) => {
    const ha = new FakeHa();
    const now = { time: at('12:00:00') };
    const { host, logged } = await open(ha, HOUSE, () => now.time);
    let first = true;
    const toB1 = (call: ServiceCall) => call.service === 'mqtt.publish' && call.data.topic === 'zigbee2mqtt/bulb-b1';
    ha.during = call => {
      if (!toB1(call) || !first) return;
      first = false;
      // The person switches lamp_a2 off as the start's publish to bulb-b1 (room-b, switched off) is out.
      ha.bulbs.apply([{ topic: toMqttTopic('zigbee2mqtt/bulb-a3'), payload: { state: 'OFF' } as Publish['payload'] }]);
      writeBack(ha.bulbs, ha.states);
      host.stateChanged('bulb-a3', ha.states['bulb-a3']);
      host.stateChanged('light.lamp_a2', ha.states['light.lamp_a2']);
      host.script(DETECTOR, { trigger: { event: { context: { user_id: 'person-1', id: 'person-call' },
        data: { domain: 'light', service: 'turn_off', service_data: { entity_id: 'light.lamp_a2' } } } } });
    };
    ha.fails = call => publishFails && toB1(call) && ha.calls.filter(toB1).length === 1;
    host.accept({ kind: 'started' });
    await host.idle();
    now.time = at('12:01:00');
    host.accept({ kind: 'wake' });
    await host.idle();
    await host.close();
    return { a3: ha.light('bulb-a3'), dropped: logged.filter(line => /came as a call failed/.test(line)), first };
  };
  const answered = await run(false);
  assert.equal(answered.first, false, 'control: the person called during the publish to bulb-b1');
  assert.equal(answered.a3, 'off', 'control: with the publish answered, the turn_off holds lamp_a2 off');
  const failed = await run(true);
  assert.deepEqual({ a3: failed.a3, dropped: failed.dropped }, { a3: 'off', dropped: [] },
    "a failed publish is no echo of a light call: the person's turn_off is taken, and lamp_a2 stays off");
});

test('closeout r4 A4: a reloaded catalog that names one device for two remotes is rejected, and the running one kept', async () => {
  // Break: the reload reads the catalog with parseDeployedCatalog alone (src/main.ts:104-107, 178), which does not see
  // a device listed twice; decodeConfig does (src/adapter/codecs/config.ts:131-133), at every turn after the reload,
  // so each turn throws, and the config the port ran on is gone.
  const twice = { ...CATALOG, groups: {}, effects: {},
    remotes: { 'room-a': { device_id: 'remote-a', source: 'remote-a' }, unplaced: { device_id: 'remote-a', source: 'remote-b' } } };
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const { host, logged } = await open(ha, HOUSE, () => now.time);
  host.accept({ kind: 'started' });
  await host.idle();
  assert.equal(logged.filter(line => /device remote-a is listed for more than one remote/.test(line)).length, 0, 'control: the start ran');
  host.catalogChanged(parseCatalog(twice));
  for (const time of ['12:01:00', '12:02:00']) { now.time = at(time); host.accept({ kind: 'wake' }); await host.idle(); }
  await host.close();
  assert.equal(logged.filter(line => /device remote-a is listed for more than one remote/.test(line)).length, 2,
    `control: once such a catalog reaches the host, every turn throws: ${JSON.stringify(logged)}`);
  const path = join(mkdtempSync(join(tmpdir(), 'closeout-r4-catalog-')), 'catalog.json');
  writeFileSync(path, JSON.stringify(twice));
  const reloaded = await readRuntimeCatalog(path).then(() => 'accepted', (error: unknown) => String(error));
  assert.match(reloaded, /remote-a/, 'the reload rejects it, so main() keeps the running catalog (src/main.ts:87)');
});

/** Turns over `states` in `given`, each output made as Home Assistant takes it: the states and the bulbs move with them. */
function applied(states: Record<string, EntityState>, given: RoomsGiven) {
  const bulbs = world();
  writeBack(bulbs, states);
  let kept: Kept = { kind: 'starting', beliefs: NO_BELIEFS, share: { kind: 'rooms', rooms: new Set() } };
  const turn = (time: string, input: HaInput): Turn => {
    const result = handleInput(kept, houseView(states, `2026-09-21T${time}Z`), input, given);
    for (const output of result.outputs) {
      if (output.kind === 'publish') bulbs.apply([output.publish]);
      else Object.assign(states, servicesTook(states, outputCall(output, result.now), result.now));
    }
    writeBack(bulbs, states);
    kept = { kind: 'running', state: afterOutputs(result, result.outputs.map(() => false)).state };
    return result;
  };
  return { turn, bulbs };
}

test('closeout r4 B1: a listed room keeps its hold while the overrides sensor is unavailable', { todo: 'closeout r4 B1' }, () => {
  // Break: with some room the old scripts', followingSensor decodes the sensor's attributes at every turn
  // (src/adapter/codecs/model.ts:161-163) without asking whether it is read (model.ts:138-142): an unavailable sensor
  // (Home Assistant restarting the variable integration) reads as no overlays, and the wake lights the held-off lamp.
  const states = syntheticStates(change => {
    change['input_boolean.ls_room-a_on_port'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T10:00:00+00:00' };
  });
  const { turn, bulbs } = applied(states, { kind: 'listed', rooms: new Set([toRoomId('room-a')]) });
  const a3 = () => { const shown = bulbs.shows('bulb-a3' as BulbId); return shown.reach === 'reachable' ? shown.light.power : 'unreachable'; };
  turn('12:00:00', { kind: 'started' });
  assert.equal(a3(), 'on', 'control: the start lights room-a');
  bulbs.apply([{ topic: toMqttTopic('zigbee2mqtt/bulb-a3'), payload: { state: 'OFF' } as Publish['payload'] }]);
  writeBack(bulbs, states);
  const off = turn('12:00:10', personCall('turn_off', { entity_id: 'light.lamp_a2' }));
  assert.match(heldLamps(off), /lamp_a2/, 'control: the person holds lamp_a2 off');
  assert.match(JSON.stringify(states['sensor.ls_overrides']?.attributes), /lamp_a2/, 'control: the hold is in the sensor');
  turn('12:01:00', { kind: 'wake' });
  assert.equal(a3(), 'off', 'control: a wake keeps it off');
  states['sensor.ls_overrides'] = { state: 'unavailable', attributes: { restored: true, friendly_name: 'ls_overrides' } };
  const unavailable = turn('12:02:00', { kind: 'wake' });
  assert.deepEqual({ held: /lamp_a2/.test(heldLamps(unavailable)), a3: a3() }, { held: true, a3: 'off' },
    'an unavailable sensor is unread, not empty: lamp_a2 stays held off');
});

test('closeout r4 B2: once the watchdog hands the rooms back after unanswered calls, the heartbeat beats again', { todo: 'closeout r4 B2' }, async t => {
  // Break: the run of unanswered calls ends only with a call answered (src/adapter/ha-client.ts:192), and paused()
  // reads it (src/host.ts:184). Once Home Assistant's watchdog has turned the port switch off, the turns drive no room
  // and make no call, so the count stays at 3, paused() stays true, and main() never beats again (src/main.ts:164).
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-09-21T12:00:00Z') });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const seconds = async (count: number) => { for (let second = 0; second < count; second++) { t.mock.timers.tick(1000); await flush(); } };
  const ha = new FakeHa(syntheticStates(change => {
    change['input_boolean.ls_room-a_on_port'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T10:00:00+00:00' };
  }));
  ha.hangs = () => true;
  const timer: HostIo['timer'] = (ms, wake) => { const handle = setTimeout(wake, ms); return () => clearTimeout(handle); };
  const { host } = await open(ha, { kind: 'listed', rooms: new Set([toRoomId('room-a')]) }, () => toInstant(Date.now() / 1000), timer);
  let started = false;
  host.accept({ kind: 'started' });
  void host.idle().then(() => { started = true; });
  for (let second = 0; second < 600 && !started; second++) { t.mock.timers.tick(1000); await flush(); }
  assert.ok(started && ha.hung.length >= 3, `control: the start's ${ha.hung.length} calls went unanswered`);
  assert.equal(host.paused(), true, 'control: three unanswered calls in a row stop the heartbeat');
  // Home Assistant's watchdog, 30 s without a beat, turns the port switch off; Home Assistant answers again.
  ha.hangs = () => false;
  host.stateChanged('input_boolean.ls_room-a_on_port', { state: 'off', attributes: {}, last_changed: new Date(Date.now()).toISOString() });
  const before = ha.calls.length;
  for (let minute = 0; minute < 3; minute++) { host.accept({ kind: 'tick' }); await seconds(60); }
  const after = { calls: ha.calls.length - before, paused: host.paused() };
  for (const reject of ha.hung.splice(0)) reject(new Error('test over'));
  t.mock.timers.reset();
  await host.close();
  assert.equal(after.calls, 0, 'control: with room-a handed back, the ticks make no call');
  assert.equal(after.paused, false, 'with no call out and none unanswered since, the heartbeat beats again');
});

/* Home Assistant's websocket, as tests/runtime/host-client.test.ts fakes it: a frame `answer` gives nothing to is never answered. */

class SocketPort extends EventTarget {
  OPEN = 1; readyState = 1; haVersion = '2026.7.4'; frames: Record<string, unknown>[] = [];
  private readonly answer: (frame: Record<string, unknown>) => object | undefined;
  constructor(answer: (frame: Record<string, unknown>) => object | undefined) { super(); this.answer = answer; }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>; this.frames.push(frame);
    const answer = this.answer(frame);
    if (answer !== undefined) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, type: 'result', ...answer }) })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('closeout r4 B3: a house read one of whose lists Home Assistant never answers is read again, and the host comes back', async t => {
  // Break: read() awaits its seven requests with no bound (src/adapter/ha-client.ts:153-162), and rereading tries again
  // only on a rejection (src/main.ts:140-152). After a reconnect, one list left unanswered keeps the host disconnected,
  // paused() true, for good.
  /** Ten minutes after a reconnect whose read's first area list is left unanswered, or not: the host, paused or back. */
  const run = async (unanswered: boolean) => {
    let areaLists = 0;
    const socket = new SocketPort(frame => {
      if (frame.type === 'get_config') return { success: true, result: { time_zone: 'UTC' } };
      if (frame.type === 'config/area_registry/list' && ++areaLists === 1 && unanswered) return undefined;
      return { success: true, result: frame.type === 'supported_features' ? null : [] };
    });
    const client = new HomeAssistantClient(await createConnection({ createSocket: async () => socket as unknown as HaWebSocket }));
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-21T12:00:00Z') });
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const ha = new FakeHa(), timer: HostIo['timer'] = (ms, wake) => { const handle = setTimeout(wake, ms); return () => clearTimeout(handle); };
    const { host } = await open(ha, HOUSE, () => toInstant(Date.now() / 1000), timer);
    host.disconnected();
    const reports: string[] = [];
    // Once the run is over, a read never ends, so closing the client (which rejects the list still out) starts no retries.
    let over = false;
    const read = () => over ? new Promise<HouseMirror>(() => {}) : client.read().then(() => ha.mirror());
    const reconnect = rereading(read, (house, startedAt) => host.reconnected(house, startedAt),
      message => reports.push(message), () => toInstant(Date.now() / 1000), timer);
    reconnect();
    for (let second = 0; second < 600; second++) { t.mock.timers.tick(1000); await flush(); }
    const after = { paused: host.paused(), areaLists, reports };
    over = true;
    t.mock.timers.reset();
    await host.close();
    await client.close();
    return after;
  };
  assert.equal((await run(false)).paused, false, 'control: a read Home Assistant answers whole brings the host back');
  const after = await run(true);
  assert.equal(after.areaLists >= 1, true, 'control: the read asked for the area list');
  assert.equal(after.paused, false, `ten minutes on, the house was read again and the host is back: ${JSON.stringify(after)}`);
});

test("closeout r4 B6: a profile saved to a store Home Assistant lacks is not taken as written and then lost", async () => {
  // Break: Home Assistant 2026.7.4 answers input_text.set_value over an entity it does not have with success, and only
  // logs a warning (helpers/service.py:765-771 log_missing, :801-806 `return None`; websocket_api/commands.py:281-292
  // send_result; run offline, closeout-r4-verdicts.md). The outbox drops a write answered so as taken
  // (src/adapter/outbox.ts:126); the host lays it into its mirror (src/host.ts:117), so the lamp shows the save until
  // the config is read again (a reconnect, a helper change), from a house with no such store: the profile reads as
  // following its room, and nothing said why.
  const store = 'input_text.ls_lamp_lamp_a2_day';
  const ha = new FakeHa(), now = { time: at('12:00:00') };
  const { host, logged } = await open(ha, HOUSE, () => now.time);
  const level = () => { const shown = ha.bulbs.shows('bulb-a3' as BulbId); return shown.reach === 'reachable' && shown.light.power === 'on' ? shown.light.level : 0; };
  host.accept({ kind: 'started' });
  await host.idle();
  assert.equal(ha.states[store], undefined, 'control: Home Assistant has no store for lamp_a2 in the day block');
  const scheduled = level();
  now.time = at('12:01:00');
  host.accept(bridged('ls_store', { store, own: true, on: true, brightness: 100 }));
  await host.idle();
  // Ruling B6: the store is checked against the mirror before sending, so a save to one Home Assistant lacks is held
  // rather than sent (this control said "the save was written" until then).
  assert.ok(!ha.calls.some(call => call.service === 'input_text.set_value' && call.target?.entity_id === store), 'control: the save is held, not sent');
  assert.equal(ha.states[store], undefined, 'control: Home Assistant set nothing');
  assert.equal(level(), 100, `control: lamp_a2 shows the save (the schedule's ${scheduled} before)`);
  // The next read of the config: Home Assistant comes back after a blip, and the house is read whole.
  now.time = at('12:05:00');
  host.disconnected();
  host.reconnected(ha.mirror(), now.time);
  await host.idle();
  await host.close();
  const named = logged.filter(line => line.includes(store));
  assert.ok(level() === 100 || named.length > 0, `after the config is read again lamp_a2 shows ${level()}, and the log names no ${store}: ${JSON.stringify(logged)}`);
  assert.deepEqual({ level: level(), named: named.length }, { level: 100, named: 1 },
    'ruling B6: the Model keeps the profile, and the missing store is named once');
});

/* main() run whole in a child process (tests/runtime/support/main-child.ts). */

type ChildRun = { made: string[]; logged: string[]; catalog: string; runtime: ServiceCall[] };

function mainChild(mode: 'reload' | 'late-catalog' | 'runtime' | 'reject'): ChildRun {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-r4-main-'));
  const child = fileURLToPath(new URL('./support/main-child.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', child, dir, mode], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as ChildRun;
}

test('closeout r4 A4 (ruling): main() keeps the running catalog when a reload fails the config decode, and logs it once', () => {
  // Ruling A4: a reloaded catalog is checked with the full config decode before it replaces the old one; on a failure
  // the previous catalog and config stay in use, and the error is logged once. Break: the reload takes the catalog after
  // parseDeployedCatalog alone, so the turns after it throw; or each write of the same bad catalog is logged again.
  const run = mainChild('reject');
  const named = run.logged.filter(line => /device remote-a is listed for more than one remote/.test(line));
  assert.deepEqual({ named: named.length, rejected: named.every(line => line.startsWith('Runtime config rejected')),
    reloaded: run.logged.includes('Runtime config reloaded.') }, { named: 1, rejected: true, reloaded: false },
    `the bad catalog is rejected once, and no turn throws on it: ${JSON.stringify(run.logged)}`);
  assert.match(run.made.at(-1) ?? '', /\|room-a$/, 'the heartbeat still names the running catalog\'s rooms alone');
});

test('closeout r4 B5: a catalog written while main() starts, after it read the catalog, is loaded', () => {
  // Break: main() reads the catalog at its start (src/main.ts:44) and watches the file only from :82, after connecting
  // and reading the house; fs.watch reports no change made before it was set up, so the new catalog is never loaded.
  const reload = mainChild('reload');
  assert.ok(reload.logged.includes('Runtime config reloaded.'), 'control: a catalog written once main() is up is loaded');
  assert.match(reload.made.at(-1) ?? '', /\|(.*,)?room-c(,|$)/, 'control: and the heartbeat names its room-c');
  const late = mainChild('late-catalog');
  assert.match(late.catalog, /light\.lamp_c/, 'control: the catalog on disk has lamp_c, written during the house read');
  assert.deepEqual({ reloaded: late.logged.includes('Runtime config reloaded.'), beat: /\|(.*,)?room-c(,|$)/.test(late.made.at(-1) ?? '') },
    { reloaded: true, beat: true }, `the catalog on disk is the one the port runs: ${JSON.stringify(late.made)}`);
});

test("closeout r4 B9: the calls a running port makes leave the runtime sensor's carried records as the old scripts wrote them", () => {
  // Pin for B9: live-rooms.test.ts:445-450 ('carried 5..8') reads handleInput's outputs only, but main() writes
  // sensor.ls_effects_runtime itself, through `took` (src/main.ts:70, timingCall in src/adapter/encode.ts:203-206).
  // With timingCall's `replace_attributes: false` made `true`, which deletes every carried record, all four of those
  // tests pass (closeout-r4-verdicts.md). This runs main() whole, and lays each of its calls to the runtime sensor over
  // the records as Home Assistant's variable.update_sensor does. It passes today.
  const run = mainChild('runtime');
  assert.ok(run.runtime.length > 0, 'control: main() writes the runtime sensor (the turn\'s latency)');
  const records = { targets: { 'light.lamp_a': 1 }, assignments: {}, applied: {}, revision: 'r', generation: 7, plan_order: [],
    handled_full: 'f', handled_rooms: { 'room-a': 'v' }, transport_recovery: {}, candle_group: [], candle_response: null,
    candle_syncing: false, candle_retry_at: null, candle_error: null };
  const before: Record<string, EntityState> = { 'sensor.ls_effects_runtime': { state: '7', attributes: records } };
  const after = run.runtime.reduce((states, call) => servicesTook(states, call, at('12:00:01')), before);
  const attributes = after['sensor.ls_effects_runtime']?.attributes ?? {};
  assert.deepEqual(Object.fromEntries(Object.keys(records).map(key => [key, attributes[key]])), records);
});

/* The rollout's bridges, exported from the captured automations with scripts/export-bridge.py --rollout. */

const EXPORT = fileURLToPath(new URL('../../scripts/export-bridge.py', import.meta.url));
const RENDER = fileURLToPath(new URL('./support/render-conditions.py', import.meta.url));
const captured = (slug: string) => (JSON.parse(readFileSync(fileURLToPath(new URL(`../../reference/live/automations/${slug}.json`, import.meta.url)), 'utf8')) as
  { config: JsonObject }).config;

/** The rollout bridge of automation `slug` exported from `config`, and the run. */
function rolloutBridge(slug: string, config: JsonObject): { status: number | null; stderr: string; conditions: JsonObject[] } {
  const root = mkdtempSync(join(tmpdir(), 'closeout-r4-export-')), source = join(root, 'automations'), output = join(root, 'out');
  mkdirSync(source);
  writeFileSync(join(source, `${slug}.json`), JSON.stringify({ config }));
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ members: {}, groups: {}, effects: {}, remotes: {} }));
  const run = spawnSync('python3', [EXPORT, '--rollout', '--source', source, '--catalog', join(root, 'catalog.json'), '--output', output], { encoding: 'utf8' });
  const conditions = run.status === 0 ? (JSON.parse(readFileSync(join(output, `${slug}.json`), 'utf8')) as { conditions: JsonObject[] }).conditions : [];
  return { status: run.status, stderr: run.stderr, conditions };
}

test("closeout r4 A2/B4 (bridge): the rollout's lamp change bridge passes a person's light.toggle", () => {
  // Break: the bridge is built to pass `service in ('turn_on', 'turn_off')` only (scripts/export-bridge.py:77, 116), so a
  // person's toggle of a port room's lamp never reaches the port. Rendered with Home Assistant 2026.7.4's Jinja.
  const { status, stderr, conditions } = rolloutBridge('lighting_schedule_lamp_change_detector', captured('lighting_schedule_lamp_change_detector'));
  assert.equal(status, 0, stderr);
  const passes = (service: string, user: string | null = 'person-1') => {
    const given = { conditions, areas: { 'light.lamp_a2': 'room-a' }, on: ['input_boolean.ls_room-a_on_port'],
      trigger: { event: { context: { user_id: user, id: 'person-call' }, data: { domain: 'light', service, service_data: { entity_id: 'light.lamp_a2' } } } } };
    const run = spawnSync('python3', [RENDER], { input: JSON.stringify(given), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return (JSON.parse(run.stdout) as boolean[]).every(Boolean);
  };
  assert.equal(passes('turn_off'), true, 'control: a turn_off passes');
  assert.equal(passes('toggle', null), false, 'control: a toggle no person made does not');
  assert.equal(passes('toggle'), true);
});

test("closeout r4 B8: the pending-output bridge's export fails when no condition reads the old runtime's bookkeeping", () => {
  // Break: the rollout drops the conditions that name ls_effects_runtime (scripts/export-bridge.py:205) and succeeds when
  // none does, so a recovery whose dirty check reads its bookkeeping under another name keeps that check, and the port's
  // rooms get no 5 s tick while the old side is clean.
  const slug = 'lighting_recover_pending_output', config = captured(slug);
  const dirtyCheck = (conditions: JsonObject[]) => JSON.stringify(conditions).includes('handled_full');
  assert.equal(dirtyCheck(config.conditions as JsonObject[]), true, 'control: the capture holds the dirty check');
  const today = rolloutBridge(slug, config);
  assert.equal(today.status, 0, today.stderr);
  assert.equal(dirtyCheck(today.conditions), false, 'control: the export drops it as captured');
  const renamed = rolloutBridge(slug, JSON.parse(JSON.stringify(config).replaceAll('sensor.ls_effects_runtime', 'sensor.ls_render_runtime')) as JsonObject);
  assert.ok(renamed.status !== 0 || !dirtyCheck(renamed.conditions),
    `the export exited ${renamed.status} (${renamed.stderr.trim()}) and its bridge keeps the old dirty check`);
});
