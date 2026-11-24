import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Host } from '../../src/host.ts';
import type { HostIo, Journal } from '../../src/host.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { HouseMirror } from '../../src/adapter/codecs/house.ts';
import { toInstant, toMqttTopic, toPercentRange, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';
import { parseRooms } from '../../src/adapter/codecs/rooms.ts';
import type { HaInput } from '../../src/adapter/codecs/inputs.ts';
import type { RoomsGiven } from '../../src/adapter/live-rooms.ts';
import { afterOutputs, handleInput } from '../../src/adapter/loop.ts';
import type { Kept, Settled, Turn } from '../../src/adapter/loop.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import type { Publish } from '../../src/adapter/encode.ts';
import type { EntityState, ServiceCall } from '../../src/adapter/ha-client.ts';
import { lightingState } from '../../src/domain/lighting-state.ts';
import { update } from '../../src/domain/update.ts';
import type { BulbId, LampId } from '../../src/domain/types/ids.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { CATALOG, houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';
import { bridged } from './support/inputs.ts';
import { servicesTook } from './support/fake-ha-services.ts';

/**
 * Close-out round 2 reproducers (`.superpowers/sdd/2026-11-22-m2-m6-build/closeout-r2-{A,B}.md`). Each defect that
 * reproduced is a test marked `todo` with its id while it stands; the fixer makes it pass and drops the mark. A test
 * not marked is a refuted claim, kept as the check that refuted it. The synthetic house, Monday 2026-09-21, UTC:
 * `room-a` (light.lamp_a1: bulb-a1, bulb-a2; light.lamp_a2: bulb-a3; switch.plug_a), `room-b` (light.lamp_b1: bulb-b1).
 */

const catalog = parseCatalog(CATALOG);
const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const bulbA3 = 'bulb-a3' as BulbId;
const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const HOUSE: RoomsGiven = { kind: 'house' };
const AREAS = { 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b', 'switch.plug_a': 'room-a', 'remote-a': 'room-a' };

/* The host over a fake Home Assistant, as tests/runtime/host.test.ts runs it. */

/** Home Assistant as the host sees it: each call recorded, its helper writes applied, its publishes reaching the bulbs. */
class FakeHa {
  readonly calls: ServiceCall[] = [];
  readonly refused: ServiceCall[] = [];
  readonly bulbs: FakeBulbs = world();
  states: Record<string, EntityState>;
  /** Home Assistant's own stamp of a state it changes: its `isoformat()`, to the microsecond. */
  stamp: (at: Instant) => string = at => new Date(at * 1000).toISOString();

  constructor(states: Record<string, EntityState> = syntheticStates()) {
    this.states = states;
    writeBack(this.bulbs, this.states);
  }

  /** A guarded call is refused, as the script the client sends stops, when its entity was updated since the guard's read. */
  async call(call: ServiceCall): Promise<string | undefined> {
    this.calls.push(call);
    if (call.guard !== undefined && this.states[call.guard.entity]?.last_updated !== call.guard.lastUpdated) {
      this.refused.push(call);
      throw new Error(`${call.guard.entity} changed since it was read`);
    }
    const now = toInstant(Date.now() / 1000), before = this.states;
    this.states = servicesTook(this.states, call, now);
    for (const [entity, state] of Object.entries(this.states)) {
      if (state !== before[entity]) this.states[entity] = { ...state, last_updated: this.stamp(now) };
    }
    if (call.service === 'mqtt.publish' && typeof call.data.topic === 'string' && typeof call.data.payload === 'string'
      && call.data.topic.startsWith('zigbee2mqtt/')) {
      this.bulbs.apply([{ topic: toMqttTopic(call.data.topic), payload: JSON.parse(call.data.payload) as Publish['payload'] }]);
      writeBack(this.bulbs, this.states);
    }
    return `context-${this.calls.length}`;
  }

  mirror(): HouseMirror {
    return { state: structuredClone(this.states), areas: AREAS, members: [], labels: { on_off: ['switch.plug_a'], private_room: ['room-b'] },
      devices: { 'device-plug-a': ['switch.plug_a'] }, timezone: 'UTC' };
  }

  publishesTo(bulb: BulbId): ServiceCall[] {
    return this.calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === `zigbee2mqtt/${bulb}`);
  }
}

class MemoryJournal implements Journal {
  private text: string | undefined = undefined;
  async load(): Promise<string | undefined> { return this.text; }
  async save(text: string): Promise<void> { this.text = text; }
}

async function open(ha: FakeHa, now: { time: Instant }, rooms: RoomsGiven = HOUSE) {
  const logged: string[] = [];
  const io: HostIo = { ha, journal: new MemoryJournal(), clock: () => now.time,
    log: { info: m => logged.push(m), warn: m => logged.push(`warn: ${m}`), error: m => logged.push(m) },
    timer: () => () => {}, rooms };
  return { host: await Host.open(io, ha.mirror(), catalog), logged };
}

/* The loop alone, as tests/runtime/loop.test.ts runs it: each output taken, the house left as the test sets it. */

const STARTING: Kept = { kind: 'starting', beliefs: NO_BELIEFS, share: { kind: 'house' } };

/** Turns over `states`, with the bulbs written in, each settled with every output taken; `view` may change the house the turn reads. */
function loop(states: Record<string, EntityState>) {
  writeBack(world(), states);
  let kept: Kept = STARTING;
  return (time: string, input: HaInput, view = (house: ReturnType<typeof houseView>) => house): Turn & Settled => {
    const turn = handleInput(kept, view(houseView(states, `2026-09-21T${time}Z`)), input, HOUSE);
    const settled = afterOutputs(turn, turn.outputs.map(() => false));
    kept = { kind: 'running', state: settled.state };
    return { ...turn, ...settled };
  };
}

test("closeout r2 A1: a person's turn_off that reaches the port only as a state change is not undone at the next tick", { todo: 'closeout r2 A1' }, async () => {
  // Break: the rollout's (and the cutover's) lamp change bridge passes only `turn_on` (scripts/export-bridge.py:124
  // keeps the detector's condition), so the off comes in only as state_changed, which moves the mirror and nothing
  // else (src/host.ts:157-159); the reconciler sees a settled bulb that reports off under a lit belief and sends it
  // its light again (src/adapter/reconcile.ts:337-339).
  const offAfterTick = async (bridgedCall: boolean) => {
    const ha = new FakeHa(), now = { time: at('12:00:00') };
    const { host } = await open(ha, now);
    host.accept({ kind: 'started' });
    await host.idle();
    // A person's light.turn_off on light.lamp_a2: Home Assistant switches its bulb off and reports both.
    ha.bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
    writeBack(ha.bulbs, ha.states);
    for (const entity of ['bulb-a3', 'light.lamp_a2']) host.stateChanged(entity, ha.states[entity]);
    if (bridgedCall) host.script('automation.lighting_schedule_lamp_change_detector', { trigger: { event: {
      context: { user_id: 'person-1', id: 'person-call' },
      data: { domain: 'light', service: 'turn_off', service_data: { entity_id: 'light.lamp_a2' } } } } });
    now.time = at('12:01:00');
    host.accept({ kind: 'tick' });
    await host.idle();
    await host.close();
    return ha.bulbs.shows(bulbA3);
  };
  assert.deepEqual(await offAfterTick(true), { reach: 'reachable', light: { power: 'off' } }, 'control: the bridged turn_off holds the lamp off');
  assert.deepEqual(await offAfterTick(false), { reach: 'reachable', light: { power: 'off' } });
});

test('closeout r2 A2: a wake time changed in Home Assistant is the one the next tick uses', { todo: 'closeout r2 A2' }, () => {
  // Break: the config is read again only on `helper changed` (src/adapter/loop.ts:156); a state_changed only moves the
  // host's mirror (src/host.ts:157-159), and no rollout bridge forwards the wake helper, so the Model keeps 06:00.
  const moved = at('05:15:00', 22);
  const wakeAt = (input: HaInput) => {
    const states = syntheticStates(), turn = loop(states);
    turn('12:00:00', { kind: 'started' });
    states[`input_datetime.ls_${roomB}_wake`] = { state: '2026-09-22 05:15:00', attributes: { timestamp: moved } };
    return turn('12:01:00', input).state.model.config.rooms[roomB]?.wakeLight?.at;
  };
  assert.equal(wakeAt({ kind: 'helper changed' }), moved, 'control: a helper change reads it');
  assert.equal(wakeAt({ kind: 'tick' }), moved);
});

test("closeout r2 A4: a sensor write queued before Home Assistant's echo of the last one is made over Home Assistant's own read", { todo: 'closeout r2 A4' }, async () => {
  // Break: afterOutput stamps the mirror's `last_updated` as JavaScript ISO text (src/adapter/codecs/house.ts:129-133),
  // the next write's guard is taken from it (src/adapter/codecs/writes.ts:264), and Home Assistant's `isoformat()`
  // never equals it, so the write is refused and made again a second later.
  const states = syntheticStates(change => {
    change['input_boolean.ls_room-a_on_port'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T10:00:00+00:00' };
    change['sensor.ls_overrides'] = { ...change['sensor.ls_overrides']!, last_updated: '2026-09-21T11:59:00.123456+00:00' };
  });
  const ha = new FakeHa(states), now = { time: at('12:00:00') };
  ha.stamp = at => new Date(at * 1000).toISOString().replace(/\.(\d{3})Z$/, '.$1456+00:00');
  const { host } = await open(ha, now, { kind: 'listed', rooms: new Set([roomA]) });
  host.accept({ kind: 'started' });
  await host.idle();
  host.accept(bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
  host.accept(bridged('ls_remote_command', { command: 'toggle', area: roomA, source: 'remote-a' }));
  await host.idle();
  await host.close();
  const sensorWrites = ha.calls.filter(call => call.guard?.entity === 'sensor.ls_overrides');
  assert.ok(sensorWrites.length >= 2, `control: both toggles write the sensor (${sensorWrites.length} writes)`);
  assert.deepEqual(ha.refused.map(call => call.guard?.lastUpdated), []);
});

test("closeout r2 B1: a lamp moved to another room in Home Assistant's registry is in that room at the next tick", { todo: 'closeout r2 B1' }, () => {
  // Break: a registry event re-reads the house into the mirror only (src/main.ts:58, 68; src/host.ts:165-167), queuing
  // no input, and the next tick keeps the config's rooms (src/adapter/loop.ts:156).
  const lampB1 = 'light.lamp_b1' as LampId;
  const roomOf = (input: HaInput) => {
    const turn = loop(syntheticStates());
    turn('12:00:00', { kind: 'started' });
    const movedB1 = (house: ReturnType<typeof houseView>) => ({ ...house, rooms: parseRooms({ ...AREAS, 'light.lamp_b1': 'room-a' }) });
    return turn('12:01:00', input, movedB1).state.model.config.lamps[lampB1]?.room;
  };
  assert.equal(roomOf({ kind: 'helper changed' }), roomA, 'control: a config read takes the move');
  assert.equal(roomOf({ kind: 'tick' }), roomA);
});

test('closeout r2 B3: a missing Zigbee2MQTT bridge sensor is not silent: the bulbs are sent their light, or the log names it', async () => {
  // Break: an absent `binary_sensor.zigbee2mqtt_bridge_connection_state` reads as disconnected
  // (src/adapter/codecs/observed.ts:34), so nextSends sends no bulb (src/adapter/reconcile.ts:299), nothing is
  // logged, and the host's heartbeat stays on (src/host.ts:182).
  const started = async (states: Record<string, EntityState>) => {
    const ha = new FakeHa(states), now = { time: at('12:00:00') };
    const { host, logged } = await open(ha, now);
    host.accept({ kind: 'started' });
    await host.idle();
    const publishes = ['bulb-a1', 'bulb-a2', 'bulb-a3', 'bulb-b1'].flatMap(bulb => ha.publishesTo(bulb as BulbId)).length;
    const paused = host.paused();
    await host.close();
    return { publishes, logged, paused };
  };
  assert.ok((await started(syntheticStates())).publishes > 0, 'control: with the sensor on, the start sends the bulbs');
  const { publishes, logged, paused } = await started(syntheticStates(change => { delete change['binary_sensor.zigbee2mqtt_bridge_connection_state']; }));
  assert.ok(publishes > 0 || logged.some(line => line.includes('zigbee2mqtt_bridge_connection_state')),
    `publishes: ${publishes}; logged: ${JSON.stringify(logged)}; heartbeat paused: ${paused}`);
});

test('closeout r2 B4: a bulb the catalog gives no topic is not believed sent', () => {
  // Break: `publishes` makes no publish for a bulb with no topic (src/adapter/encode.ts:84), so its send is carried by
  // no output (src/adapter/loop.ts:226) and is settled as sent (src/adapter/loop.ts:116-121).
  const { 'bulb-a3': _dropped, ...topics } = CATALOG.topics as Record<string, string>;
  const noTopic = parseCatalog({ ...CATALOG, topics });
  const turn = loop(syntheticStates())('12:00:00', { kind: 'started' }, house => ({ ...house, catalog: noTopic }));
  const sending = turn.sends.find(({ send }) => send.kind !== 'switch' && send.bulb === bulbA3);
  assert.ok(sending !== undefined, 'control: bulb-a3 is sent its light');
  assert.deepEqual(sending.carriedBy, [], 'control: no output carries it');
  assert.notEqual(turn.state.beliefs.bulbs[bulbA3]?.kind, 'sent');
});

test('closeout r2 B4 (ruling): a bulb the catalog gives no topic gets no belief, and the error names it once', () => {
  // Break: the bulb is believed (sent, or retrying) for a publish never made; or nothing names it; or it is named every turn.
  const { 'bulb-a3': _dropped, ...topics } = CATALOG.topics as Record<string, string>;
  const noTopic = parseCatalog({ ...CATALOG, topics }), turn = loop(syntheticStates());
  const view = (house: ReturnType<typeof houseView>) => ({ ...house, catalog: noTopic });
  const start = turn('12:00:00', { kind: 'started' }, view);
  assert.equal(start.state.beliefs.bulbs[bulbA3], undefined);
  assert.deepEqual(start.errors.filter(error => error.includes('bulb-a3')).length, 1);
  assert.deepEqual(turn('12:01:00', { kind: 'tick' }, view).errors, [], 'said once, not every turn');
});

test('closeout r2 B5: a range saved for a plug alone in its room applies at once', { todo: 'closeout r2 B5' }, () => {
  // Break: rangeSaved adds the plug but not its room to config.rooms (src/domain/switches.ts:82-84), so switchPower
  // takes it as roomless and skips the rule (src/domain/switches.ts:110, 118) until the config is read again.
  const plugC = toSwitchId('switch.plug_c'), roomC = toRoomId('room-c'), now = at('12:00:00');
  const saved = (model: ReturnType<typeof syntheticHouse>) => update(model, { kind: 'rangeSaved', switch: plugC,
    rule: { kind: 'custom', range: toPercentRange(0, 100) }, room: roomC, at: now });
  const withRoomC = syntheticHouse();
  withRoomC.config = { ...withRoomC.config, rooms: { ...withRoomC.config.rooms, [roomC]: structuredClone(withRoomC.config.rooms[roomB]!) } };
  assert.equal(lightingState(saved(withRoomC), now).switches[plugC], 'on', 'control: with its room in the config the rule applies');
  assert.equal(lightingState(saved(syntheticHouse()), now).switches[plugC], 'on');
});

test('closeout r2 B6: under --live-rooms all, a room that gains a lamp by a catalog reload is named by the next heartbeat', { todo: 'closeout r2 B6' }, () => {
  // Break: main() fixes the heartbeat's rooms at start (src/main.ts:54, 69); the reload only hands the host the new
  // catalog (src/main.ts:70-75). Runs main() whole in a child, over a fake client (tests/runtime/support/main-child.ts).
  const run = mainChild('reload');
  assert.match(run.catalog, /light\.lamp_c/, 'control: the reload landed');
  assert.ok(run.logged.includes('Runtime config reloaded.'), 'control: the port took it');
  assert.match(run.made.at(-1) ?? '', /\|(.*,)?room-c(,|$)/);
});

test('closeout r2 B2 (refuted): a Home Assistant that refuses every call takes no heartbeat, so its watchdog hands the rooms back', () => {
  // The claim's mechanism holds: refused calls throw no turn, so paused() stays false and main() keeps beating. But
  // main() makes each beat through the same client call (src/main.ts:69), which Home Assistant refuses too.
  const run = mainChild('refuse');
  assert.ok(run.others > 0, 'control: the start made calls, and they were refused');
  assert.ok(run.made.length >= 2, `the heartbeat kept beating after the refused turn: ${JSON.stringify(run.made)}`);
  assert.deepEqual(run.taken, []);
});

test("closeout r2 B7: a switch's open send sets a wake at its retry", () => {
  // Break: afterOutputs' wake reads nextRetry, which covers bulbs only (src/adapter/reconcile.ts:213-216;
  // src/adapter/loop.ts:123), so the switch's retryAt sets no wake.
  const states = syntheticStates(change => { change['switch.plug_a'] = { state: 'on', attributes: {} }; });
  const turn = loop(states)('12:00:00', { kind: 'started' });
  const open = turn.state.beliefs.switches[toSwitchId('switch.plug_a')];
  assert.ok(open?.kind === 'open', 'control: the plug was sent off and has not shown it');
  assert.ok(turn.wakeAt !== undefined && turn.wakeAt <= open.retryAt, `wakeAt ${turn.wakeAt}, retryAt ${open.retryAt}`);
});

/** main() run whole in a child process (tests/runtime/support/main-child.ts), and what it printed. */
function mainChild(mode: 'reload' | 'refuse'): { made: string[]; taken: string[]; others: number; logged: string[]; catalog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-r2-main-'));
  const child = fileURLToPath(new URL('./support/main-child.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', child, dir, mode], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');
}
