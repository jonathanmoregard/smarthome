import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createConnection } from 'home-assistant-js-websocket';
import type { HaWebSocket } from 'home-assistant-js-websocket';
import { Host } from '../../src/host.ts';
import type { HostIo, Journal } from '../../src/host.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import type { HouseMirror } from '../../src/adapter/codecs/house.ts';
import { toInstant, toMqttTopic, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';
import type { HaInput } from '../../src/adapter/codecs/inputs.ts';
import type { RoomsGiven } from '../../src/adapter/live-rooms.ts';
import { afterOutputs, handleInput } from '../../src/adapter/loop.ts';
import type { Kept, Settled, Turn } from '../../src/adapter/loop.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import type { Publish } from '../../src/adapter/encode.ts';
import { HomeAssistantClient } from '../../src/adapter/ha-client.ts';
import type { EntityState, JsonObject, ServiceCall } from '../../src/adapter/ha-client.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import type { FakeBulbs } from './fake-bulbs.ts';
import { CATALOG, houseView, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { servicesTook } from './support/fake-ha-services.ts';
import { bridged } from './support/inputs.ts';

/**
 * Close-out round 3 reproducers (`.superpowers/sdd/2026-11-22-m2-m6-build/closeout-r3-{A,B}.md`; verdicts in
 * closeout-r3-verdicts.md). Each defect that reproduced is a test marked `todo` with its id while it stands; the fixer
 * makes it pass and drops the mark. B8's reproducer is in reconcile.test.ts, beside the switch-press tests. The
 * synthetic house, Monday 2026-09-21, UTC: `room-a` (light.lamp_a1: bulb-a1, bulb-a2; light.lamp_a2: bulb-a3;
 * switch.plug_a), `room-b` (light.lamp_b1: bulb-b1).
 */

const catalog = parseCatalog(CATALOG);
const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const roomA = toRoomId('room-a');
const HOUSE: RoomsGiven = { kind: 'house' };
const AREAS = { 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b', 'switch.plug_a': 'room-a', 'remote-a': 'room-a' };
const BULBS = ['bulb-a1', 'bulb-a2', 'bulb-a3', 'bulb-b1'] as BulbId[];

/* Home Assistant's websocket, as tests/runtime/host-client.test.ts fakes it, answering as `answer` says. */

class SocketPort extends EventTarget {
  OPEN = 1; readyState = 1; haVersion = '2026.7.4'; frames: Record<string, unknown>[] = [];
  private readonly answer: (frame: Record<string, unknown>) => object;
  constructor(answer: (frame: Record<string, unknown>) => object) { super(); this.answer = answer; }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>; this.frames.push(frame);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, type: 'result', ...this.answer(frame) }) })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('closeout r3 A1/B1, B4: a guarded call Home Assistant stopped at its guard rejects', async () => {
  // Break: the client takes a guarded call's success as the write made, without reading the script's response. Home
  // Assistant 2026.7.4 answers execute_script with success whether the guard stopped the script or not
  // (helpers/script.py:474-487, components/websocket_api/commands.py:1216-1222); the guard script's `stop` with
  // `response_variable` says which: `{guard: 'written'}`, or `{guard: 'refused', seen: <the stamp it saw>}`. The
  // socket answers as Home Assistant's own handle_execute_script answered that script, run offline.
  // B4: this is the client-level pin of what Home Assistant really answers.
  const stale = { service: 'variable.update_sensor', target: { entity_id: 'sensor.ls_overrides' },
    data: { value: 'r2', attributes: { overrides: {} }, replace_attributes: false },
    guard: { entity: 'sensor.ls_overrides', lastUpdated: '2026-09-21T11:59:00.123456+00:00' } };
  const client = async (answer: (frame: Record<string, unknown>) => object) => {
    const socket = new SocketPort(answer);
    return { socket, client: new HomeAssistantClient(await createConnection({ createSocket: async () => socket as unknown as HaWebSocket })) };
  };
  const refused = await client(() => ({ success: false, error: { code: 'home_assistant_error', message: 'refused' } }));
  await assert.rejects(refused.client.call(stale), { code: 'home_assistant_error' }, 'control: an error answer rejects');
  await refused.client.close();
  const written = await client(() => ({ success: true, result: { context: { id: 'script-context' }, response: { guard: 'written' } } }));
  assert.equal(await written.client.call(stale), 'script-context', 'control: a guard that let the write through resolves');
  await written.client.close();
  const unread = await client(() => ({ success: true, result: { context: { id: 'script-context' }, response: null } }));
  await assert.rejects(unread.client.call(stale), 'control: an answer that does not say the write was made rejects');
  await unread.client.close();
  const stopped = await client(() => ({ success: true,
    result: { context: { id: 'script-context' }, response: { guard: 'refused', seen: '2026-09-21T11:59:30.654321+00:00' } } }));
  const answer = await stopped.client.call(stale).then(context => `resolved with ${context}`, (error: unknown) => error);
  await stopped.client.close();
  assert.equal(stopped.socket.frames[0]?.type, 'execute_script', 'control: the guard went as a script');
  assert.ok(answer instanceof Error, `a stopped guard must reject: ${String(answer)}`);
  assert.match(answer.message, /2026-09-21T11:59:30\.654321\+00:00/, 'the refusal names the stamp Home Assistant saw');
});

/* The loop alone, as closeout-r2.test.ts runs it: each output taken, the house left as the test sets it. */

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

test("closeout r3 A2/B3: a start before Home Assistant has the overrides sensor does not delete the sensor's ranges once it has", () => {
  // Break: the whole house's Model takes its overlays and ranges from the sensor at the start only
  // (src/adapter/codecs/model.ts:44; followingSensor returns it as is for the house, model.ts:143), so an absent
  // sensor reads as none, and the next turn writes the stored ones' deletion (src/adapter/codecs/writes.ts:193-200).
  const plugA = toSwitchId('switch.plug_a');
  const wake = (absentAtStart: boolean) => {
    const states = syntheticStates(), sensor = states['sensor.ls_overrides']!, turn = loop(states);
    if (absentAtStart) delete states['sensor.ls_overrides'];
    turn('12:00:00', { kind: 'started' });
    states['sensor.ls_overrides'] = sensor;
    return turn('12:01:00', { kind: 'wake' });
  };
  const sensorWrites = (turn: Turn) => turn.outputs.flatMap(output => output.kind === 'sensor' ? [output.write] : []);
  const control = wake(false);
  assert.deepEqual(sensorWrites(control), [], 'control: with the sensor there at the start, the wake writes nothing');
  assert.deepEqual(control.state.model.switchRanges[plugA], { kind: 'custom', range: { low: 20, high: 60 } }, 'control: the range is read');
  const late = wake(true);
  assert.deepEqual(sensorWrites(late), [], "the wake writes no deletion of the sensor's switch_ranges");
});

test('closeout r3 A2/B3 (ruling): while the overrides sensor is unread the port writes it nothing, still lights, and reads it once it comes', () => {
  // Break: an absent (or restored-unavailable) sensor reads as an empty one, so a hold made meanwhile is written over
  // what the sensor holds once Home Assistant has loaded it; or the port stops lighting while it waits; or, once read,
  // the Model keeps the empty overlays instead of the sensor's.
  const plugA = toSwitchId('switch.plug_a');
  const sensorWrites = (turn: Turn) => turn.outputs.filter(output => output.kind === 'sensor');
  const publishes = (turn: Turn) => turn.outputs.filter(output => output.kind === 'publish').length;
  for (const unread of ['absent', 'unavailable'] as const) {
    const states = syntheticStates(), sensor = states['sensor.ls_overrides']!, turn = loop(states);
    if (unread === 'absent') delete states['sensor.ls_overrides'];
    else states['sensor.ls_overrides'] = { state: 'unavailable', attributes: { restored: true, friendly_name: 'ls_overrides' } };
    const start = turn('12:00:00', { kind: 'started' });
    assert.ok(publishes(start) > 0, `${unread}: the start still lights the house from the schedule`);
    assert.deepEqual(sensorWrites(start), [], `${unread}: the start writes no sensor`);
    const toggled = turn('12:00:30', bridged('ls_remote_command', { command: 'toggle', area: 'room-a', source: 'remote-a' }));
    assert.deepEqual(sensorWrites(toggled), [], `${unread}: a hold made while the sensor is unread is not written`);
    states['sensor.ls_overrides'] = sensor;
    const read = turn('12:01:00', { kind: 'wake' });
    assert.deepEqual(read.state.model.switchRanges[plugA], { kind: 'custom', range: { low: 20, high: 60 } }, `${unread}: once read, the ranges are the sensor's`);
    assert.deepEqual(sensorWrites(read), [], `${unread}: once read, nothing of the sensor's is deleted`);
  }
});

/* The host over a fake Home Assistant, as closeout-r2.test.ts runs it. */

class FakeHa {
  readonly calls: ServiceCall[] = [];
  readonly bulbs: FakeBulbs = world();
  states: Record<string, EntityState>;
  /** A call this says hangs is left unanswered, as Home Assistant leaves a service call it is still running. */
  hangs: (call: ServiceCall) => boolean = () => false;
  readonly hung: ((error: Error) => void)[] = [];

  constructor(states: Record<string, EntityState> = syntheticStates()) {
    this.states = states;
    writeBack(this.bulbs, this.states);
  }

  async call(call: ServiceCall): Promise<string | undefined> {
    this.calls.push(call);
    if (this.hangs(call)) return new Promise((_resolve, reject) => { this.hung.push(reject); });
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

  publishes(): number {
    return this.calls.filter(call => call.service === 'mqtt.publish' && BULBS.some(bulb => call.data.topic === `zigbee2mqtt/${bulb}`)).length;
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

test('closeout r3 B6: a call Home Assistant never answers stops the heartbeat, so its watchdog hands the rooms back', { todo: 'closeout r3 B6' }, async t => {
  // Break: the host awaits each call with no bound (src/host.ts:114), so its queue waits for good, while paused()
  // (src/host.ts:182) stays false and main()'s heartbeat, a call of its own (src/main.ts:68), keeps beating. Home
  // Assistant's websocket call_service awaits the service with no timeout of its own (components/websocket_api/
  // commands.py, handle_call_service: `blocking=True`); an MQTT publish is bounded at 10 s, other services are not.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.parse('2026-09-21T12:00:00Z') });
  const ha = new FakeHa();
  ha.hangs = call => call.service === 'mqtt.publish';
  const timer: HostIo['timer'] = (ms, wake) => { const handle = setTimeout(wake, ms); return () => clearTimeout(handle); };
  const { host } = await open(ha, HOUSE, () => toInstant(Date.now() / 1000), timer);
  host.accept({ kind: 'started' });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(ha.hung.length, 1, 'control: the start made a publish, and it hangs');
  assert.equal(host.paused(), false, 'control: a call just made does not pause the heartbeat');
  for (let second = 0; second < 60; second++) { t.mock.timers.tick(1000); for (let i = 0; i < 5; i++) await Promise.resolve(); }
  const paused = host.paused();
  ha.hangs = () => false;
  for (const reject of ha.hung.splice(0)) reject(new Error('test over'));
  t.mock.timers.reset();
  await host.close();
  assert.equal(paused, true, 'a minute into a call Home Assistant has not answered, the heartbeat is paused');
});

test('closeout r3 B10: a listed room with no port switch helper is not silent', async () => {
  // Break: portSwitchesOn reads a missing `input_boolean.ls_<room>_on_port` as off (src/adapter/codecs/rooms.ts:56),
  // so the listed room is never handed over; refuseUnknownRooms (src/adapter/live-rooms.ts:51) checks only that the
  // room has lamps, and nothing logs the helper's absence.
  const started = async (change: (states: Record<string, EntityState>) => void) => {
    const ha = new FakeHa(syntheticStates(change));
    const { host, logged } = await open(ha, { kind: 'listed', rooms: new Set([roomA]) }, () => at('12:00:00'));
    host.accept({ kind: 'started' });
    await host.idle();
    await host.close();
    return { publishes: ha.publishes(), logged };
  };
  assert.ok((await started(states => { states['input_boolean.ls_room-a_on_port'] = { state: 'on', attributes: {} }; })).publishes > 0,
    'control: with the helper on, the start drives room-a');
  const { publishes, logged } = await started(states => { delete states['input_boolean.ls_room-a_on_port']; });
  assert.equal(publishes, 0, 'control: with no helper, room-a is not driven');
  assert.ok(logged.some(line => line.includes('input_boolean.ls_room-a_on_port')), `logged: ${JSON.stringify(logged)}`);
});

/* main() run whole in a child process (tests/runtime/support/main-child.ts). */

function mainChild(mode: 'gap' | 'gap-control'): { bulbA: number; logged: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-r3-main-'));
  const child = fileURLToPath(new URL('./support/main-child.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', child, dir, mode], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');
}

test('closeout r3 B7: a state change between the house read and the state_changed subscription reaches the mirror', { todo: 'closeout r3 B7' }, () => {
  // Break: main() reads the house (src/main.ts:51) and subscribes to state_changed only later (src/main.ts:60), after
  // Host.open and the homeassistant_started subscription; Home Assistant hands an event only to the subscriptions live
  // when it fires, so a change in between never reaches the mirror until a whole read. Here room-a is handed to the port
  // in that gap; a bridged recovery tick follows.
  assert.ok(mainChild('gap-control').bulbA > 0, 'control: handed over once subscribed, the tick drives room-a');
  const gap = mainChild('gap');
  assert.ok(gap.bulbA > 0, `handed over in the gap, the tick drives room-a: ${gap.bulbA} publishes to bulb-a`);
});

/* The rollout's lamp change bridge, exported from the captured detector and rendered as Home Assistant renders it. */

const EXPORT = fileURLToPath(new URL('../../scripts/export-bridge.py', import.meta.url));
const RENDER = fileURLToPath(new URL('./support/render-conditions.py', import.meta.url));
const DETECTOR = 'lighting_schedule_lamp_change_detector';
const CAPTURED = fileURLToPath(new URL(`../../reference/live/automations/${DETECTOR}.json`, import.meta.url));

/** The detector's rollout bridge, exported with --rollout from `config` (the captured one by default), and the run. */
function rolloutDetector(config?: JsonObject): { status: number | null; stderr: string; conditions: JsonObject[] } {
  const root = mkdtempSync(join(tmpdir(), 'closeout-r3-export-')), source = join(root, 'automations'), output = join(root, 'out');
  mkdirSync(source);
  writeFileSync(join(source, `${DETECTOR}.json`), config === undefined ? readFileSync(CAPTURED, 'utf8') : JSON.stringify({ config }));
  writeFileSync(join(root, 'catalog.json'), JSON.stringify({ members: {}, groups: {}, effects: {}, remotes: {} }));
  const run = spawnSync('python3', [EXPORT, '--rollout', '--source', source, '--catalog', join(root, 'catalog.json'), '--output', output], { encoding: 'utf8' });
  const conditions = run.status === 0 ? (JSON.parse(readFileSync(join(output, `${DETECTOR}.json`), 'utf8')) as { conditions: JsonObject[] }).conditions : [];
  return { status: run.status, stderr: run.stderr, conditions };
}

/**
 * Whether the bridge passes a person's light call: every template condition, rendered with Home Assistant 2026.7.4's
 * Jinja. Home Assistant fires call_service with the call's target merged into `service_data` (core.py:2860-2861).
 * light.lamp_a2 and device-a are in room-a, label-a's entities are in room-a, and room-a is on the port.
 */
function passes(conditions: JsonObject[], service: string, serviceData: JsonObject, user: string | null = 'person-1'): boolean {
  const given = { conditions, areas: { 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b', 'device-a': 'room-a' },
    on: ['input_boolean.ls_room-a_on_port'],
    trigger: { event: { context: { user_id: user, id: 'person-call' }, data: { domain: 'light', service, service_data: serviceData } } } };
  const run = spawnSync('python3', [RENDER], { input: JSON.stringify(given), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const verdicts = JSON.parse(run.stdout) as boolean[];
  assert.ok(verdicts.length > 0, 'the bridge has template conditions');
  return verdicts.every(Boolean);
}

test("closeout r3 B2: the rollout's lamp change bridge passes a person's call that names a port room by area, device or label", () => {
  // Break: LAMP_CHANGE_ON_PORT reads only service_data.entity_id (scripts/export-bridge.py:120-124); a call with no
  // entity_id is not the port's, though callReach reads area_id, device_id and label_id (src/adapter/codecs/native-call.ts:66-71).
  const { status, stderr, conditions } = rolloutDetector();
  assert.equal(status, 0, stderr);
  assert.equal(passes(conditions, 'turn_off', { entity_id: 'light.lamp_a2' }), true, 'control: by entity_id it passes');
  // Reach is the port's alone (close-out r3 ruling, B2): the bridge passes a person's call into a room not on the port
  // too, and the port drops that room ("closeout r3 B2 (ruling)" below). What the bridge still decides is a person's light call.
  assert.equal(passes(conditions, 'turn_off', { entity_id: 'light.lamp_b1' }), true, 'control: reach is the port\'s, so a room not on the port is passed');
  assert.equal(passes(conditions, 'turn_off', { entity_id: 'light.lamp_a2' }, null), false, 'control: a call no person made is not passed');
  assert.equal(passes(conditions, 'toggle', { entity_id: 'light.lamp_a2' }), false, 'control: a light call other than turn_on or turn_off is not passed');
  const by = Object.fromEntries((['area_id', 'device_id', 'label_id'] as const).map(key =>
    [key, passes(conditions, 'turn_off', { [key]: { area_id: 'room-a', device_id: 'device-a', label_id: 'label-a' }[key] })]));
  assert.deepEqual(by, { area_id: true, device_id: true, label_id: true });
});

test("closeout r3 B5: the rendered rollout lamp change conditions pass a person's turn_off for a port room", () => {
  // Pin for B5: export-bridge-rollout.test.ts:126 checks only that the text `service == 'turn_on'` is gone; a widened
  // filter that still drops turn_off passes it. This renders the conditions, and passes today. With TURN_ON_OR_OFF
  // (export-bridge.py:67) as "trigger.event.data.service in ('turn_on', 'turn_off')[:1]" it fails on its last
  // assertion, and with "trigger.event.data.service_name in ('turn_on', 'turn_off')" on the turn_on control, while
  // every test in export-bridge-rollout.test.ts passes (closeout-r3-verdicts.md). The area_id half of B5's pin is B2's.
  const { status, stderr, conditions } = rolloutDetector();
  assert.equal(status, 0, stderr);
  assert.equal(passes(conditions, 'turn_on', { entity_id: 'light.lamp_a2' }), true, 'control: turn_on passes');
  assert.equal(passes(conditions, 'turn_off', { entity_id: 'light.lamp_a2' }, null), false, 'control: a call no person made is not passed');
  assert.equal(passes(conditions, 'turn_off', { entity_id: 'light.lamp_a2' }), true);
});

test("closeout r3 B9: a detector whose turn_on filter is worded otherwise is widened, or the export fails", () => {
  // Break: passing_turn_off is a str.replace of one exact text (scripts/export-bridge.py:66-73); the same filter with
  // double quotes is left as it is, and the export still exits 0.
  const captured = JSON.parse(readFileSync(CAPTURED, 'utf8')) as { config: JsonObject };
  const condition = (captured.config.conditions as { value_template: string }[])[0]!.value_template;
  assert.match(condition, /service == 'turn_on'/, 'control: the capture has the exact wording the export replaces');
  const reworded = { ...captured.config, conditions: [{ condition: 'template', value_template: condition.replace("'turn_on'", '"turn_on"') }] };
  const { status, stderr, conditions } = rolloutDetector(reworded);
  assert.ok(status !== 0 || passes(conditions, 'turn_off', { entity_id: 'light.lamp_a2' }),
    `the export exited ${status} (${stderr.trim()}) and its bridge drops a person's turn_off`);
});

test('closeout r3 B9 (ruling): a detector condition of a shape the export does not know fails the export, naming what it found', () => {
  // Break: the export widens what it can find and passes the rest through, so a filter it did not read stays, and the
  // bridge drops a person's call with the export's exit 0.
  const captured = JSON.parse(readFileSync(CAPTURED, 'utf8')) as { config: JsonObject };
  const condition = (captured.config.conditions as { value_template: string }[])[0]!.value_template;
  for (const unknown of [
    condition.replace("trigger.event.data.service == 'turn_on'", "trigger.event.data.service in ['turn_on']"),
    condition.replace('{{ ', '{% if true %}{{ ').replace(' }}', ' }}{% endif %}'),
    condition.replace('trigger.event.context.user_id is not none and ', ''),
  ]) {
    const { status, stderr } = rolloutDetector({ ...captured.config, conditions: [{ condition: 'template', value_template: unknown }] });
    assert.notEqual(status, 0, unknown);
    assert.match(stderr, /lighting_schedule_lamp_change_detector/, unknown);
    assert.doesNotMatch(stderr, /Traceback/, `a clear message, not a stack: ${stderr}`);
  }
});

test("closeout r3 B2 (ruling): the port takes a person's call into its live rooms and drops the rooms that are not", () => {
  // Break: the port drops a call whose reach is not all live (src/adapter/live-rooms.ts ownsMessage), so a call over
  // room-a and room-b holds nothing in room-a; or it acts on room-b, the old scripts' room.
  const states = syntheticStates(change => {
    change['input_boolean.ls_room-a_on_port'] = { state: 'on', attributes: {}, last_changed: '2026-09-21T10:00:00+00:00' };
  });
  writeBack(world(), states);
  const given: RoomsGiven = { kind: 'listed', rooms: new Set([roomA]) };
  let kept: Kept = { kind: 'starting', beliefs: NO_BELIEFS, share: { kind: 'rooms', rooms: new Set() } };
  const turn = (time: string, input: HaInput): Turn => {
    const result = handleInput(kept, houseView(states, `2026-09-21T${time}Z`), input, given);
    kept = { kind: 'running', state: afterOutputs(result, result.outputs.map(() => false)).state };
    return result;
  };
  const personOff = (serviceData: JsonObject) => bridged('automation.lighting_schedule_lamp_change_detector', { trigger: { event: {
    context: { user_id: 'person-1', id: 'person-call' }, data: { domain: 'light', service: 'turn_off', service_data: serviceData } } } });
  const held = (result: Turn) => JSON.stringify(result.state.model.overlays.lamps);
  turn('12:00:00', { kind: 'started' });
  const roomBOnly = turn('12:00:10', personOff({ entity_id: 'light.lamp_b1' }));
  assert.doesNotMatch(held(roomBOnly), /lamp_b1/, 'a call into room-b alone is dropped');
  const both = turn('12:00:20', personOff({ entity_id: ['light.lamp_a2', 'light.lamp_b1'] }));
  assert.match(held(both), /lamp_a2/, "the call's room-a part holds lamp_a2 off");
  assert.doesNotMatch(held(both), /lamp_b1/, "the call's room-b part is the old scripts'");
});
