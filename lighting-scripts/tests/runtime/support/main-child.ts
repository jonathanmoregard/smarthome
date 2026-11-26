/**
 * `main()` run whole in a child process, over a fake Home Assistant client, for the close-out round 2 reproducers
 * (tests/runtime/closeout-r2.test.ts). Node's `setInterval` is caught so the heartbeat beats only when this script
 * says, and the process exits when done, which ends the catalog watcher and the journal lock with it.
 *
 * Usage: main-child.ts <dir> reload|refuse|gap|gap-control|during-read|late-catalog|runtime|reject. Prints one JSON line: every
 * heartbeat call made, those Home Assistant took, what the process logged, how many publishes reached bulb-a, and every
 * call to `sensor.ls_effects_runtime`.
 *   reload: the catalog gains `light.lamp_c`, which the registry has in `room-c`, under `--live-rooms all`.
 *   refuse: Home Assistant refuses every call with an error (not out of reach).
 *   gap: under `--live-rooms room-a`, `input_boolean.ls_room-a_on_port` turns on after the read and before the
 *     state_changed subscription, so no subscriber hears it (close-out round 3, B7); then a bridged recovery tick.
 *   gap-control: the same change, made once the subscription is live, so it is heard; then the same tick.
 *   during-read: while the house read is out, the switch turns off and then on, two state_changed events the read
 *     does not show; then the same tick (close-out round 3, B7 ruling: events held during the read apply after it, in order).
 *   late-catalog: as reload, but the catalog gains `light.lamp_c` while the house read is out, after main() read the
 *     catalog and before it watches it (close-out round 4, B5).
 *   runtime: under `--live-rooms all`, the start's turn and the calls main() makes after it (close-out round 4, B9).
 *   reject: under `--live-rooms all`, a catalog naming one device for two remotes is written twice once main() is up,
 *     then a bridged recovery tick runs a turn (close-out round 4, A4 ruling: the running catalog is kept, and the
 *     rejection logged once).
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HomeAssistantClient } from '../../../src/adapter/ha-client.ts';
import type { HouseRead, ServiceCall } from '../../../src/adapter/ha-client.ts';

const [dir, mode] = process.argv.slice(2);
const MODES = ['reload', 'refuse', 'gap', 'gap-control', 'during-read', 'late-catalog', 'runtime', 'reject'];
if (dir === undefined || mode === undefined || !MODES.includes(mode)) throw new Error(`usage: main-child.ts <dir> ${MODES.join('|')}`);
const gap = mode === 'gap' || mode === 'gap-control' || mode === 'during-read';

const beats: (() => void)[] = [];
globalThis.setInterval = ((beat: () => void) => { beats.push(beat); return 0; }) as unknown as typeof setInterval;
const logged: string[] = [];
for (const level of ['error', 'warn', 'info', 'log'] as const) console[level] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };

const at = '2026-09-21T12:00:00.000000+00:00';
const wire = (entity_id: string, state: string, attributes: object = {}) => ({ entity_id, state, attributes, last_changed: at, last_updated: at });
const READ: HouseRead = {
  states: [wire('light.lamp_a', 'on', { entity_id: ['bulb-a'] }), wire('bulb-a', 'on', { brightness: 10 }),
    wire('light.lamp_c', 'on', { entity_id: ['bulb-c'] }), wire('bulb-c', 'on', { brightness: 10 }),
    wire('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on'), wire('input_boolean.ls_room-a_on_port', 'off')],
  timezone: 'UTC',
  entities: [{ entity_id: 'light.lamp_a', area_id: 'room-a', device_id: null }, { entity_id: 'light.lamp_c', area_id: 'room-c', device_id: null }],
  devices: [], areas: [{ area_id: 'room-a' }, { area_id: 'room-c' }], labels: [], sources: {},
};

class FakeClient {
  readonly calls: ServiceCall[] = [];
  readonly taken: ServiceCall[] = [];
  async call(call: ServiceCall): Promise<string | undefined> {
    this.calls.push(call);
    if (mode === 'refuse') throw new Error('Home Assistant refused it');
    this.taken.push(call);
    return undefined;
  }
  async probe(): Promise<void> {}
  readonly listeners = new Map<string, (event: { event_type: string; data: object }) => void>();
  async subscribe(event: string, callback: (event: { event_type: string; data: object }) => void): Promise<void> {
    // Home Assistant hands an event only to the subscriptions live when it fires.
    const handOver = { entity_id: 'input_boolean.ls_room-a_on_port', new_state: { ...wire('input_boolean.ls_room-a_on_port', 'on'),
      last_changed: '2026-09-21T12:00:01.000000+00:00', last_updated: '2026-09-21T12:00:01.000000+00:00' } };
    if (event === 'state_changed' && mode === 'gap') READ.states = READ.states.map(state => state.entity_id === handOver.entity_id ? handOver.new_state : state);
    this.listeners.set(event, callback);
    if (event === 'state_changed' && mode === 'gap-control') callback({ event_type: event, data: handOver });
  }
  readonly mqtt = new Map<string, (payload: unknown) => void>();
  async subscribeMqtt(topic: string, callback: (payload: unknown) => void): Promise<void> { this.mqtt.set(topic, callback); }
  onConnection(): void {}
  async read(): Promise<HouseRead> {
    const read = structuredClone(READ);
    if (mode === 'late-catalog' && !lateWritten) {
      lateWritten = true;
      await writeFile(join(dir!, 'catalog.next'), catalog({ 'light.lamp_a': ['bulb-a'], 'light.lamp_c': ['bulb-c'] }));
      await rename(join(dir!, 'catalog.next'), catalogPath);
    }
    if (mode === 'during-read') {
      for (const [state, second] of [['off', '01'], ['on', '02']] as const) {
        const at = `2026-09-21T12:00:${second}.000000+00:00`;
        this.listeners.get('state_changed')?.({ event_type: 'state_changed', data: { entity_id: 'input_boolean.ls_room-a_on_port',
          new_state: { ...wire('input_boolean.ls_room-a_on_port', state), last_changed: at, last_updated: at } } });
      }
    }
    return read;
  }
  async close(): Promise<void> {}
}
let lateWritten = false;
const fake = new FakeClient();
(HomeAssistantClient as unknown as { connect: () => Promise<FakeClient> }).connect = async () => fake;

const catalogPath = join(dir, 'catalog.json'), token = join(dir, 'token');
const catalog = (members: Record<string, string[]>) => JSON.stringify({ mode: 'sara', members, groups: {}, effects: {},
  topics: { 'bulb-a': 'zigbee2mqtt/bulb-a', 'bulb-c': 'zigbee2mqtt/bulb-c' } });
await writeFile(catalogPath, catalog({ 'light.lamp_a': ['bulb-a'] }));
await writeFile(token, 'token');
process.env.HA_URL = 'http://fake.invalid';
process.env.HA_TOKEN_FILE = token;

const { main } = await import('../../../src/main.ts');
await main(['--live', '--config', catalogPath, '--state', join(dir, 'journal.json'), '--live-rooms', gap ? 'room-a' : 'all']);
const until = async (done: () => boolean) => { for (let waited = 0; !done() && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20)); };

if (mode === 'late-catalog') {
  await until(() => logged.includes('Runtime config reloaded.'));
} else if (mode === 'runtime') {
  await until(() => fake.calls.some(call => call.target?.entity_id === 'sensor.ls_effects_runtime'));
} else if (mode === 'reject') {
  const twice = JSON.parse(catalog({ 'light.lamp_a': ['bulb-a'], 'light.lamp_c': ['bulb-c'] })) as object;
  for (let write = 0; write < 2; write++) {
    await writeFile(join(dir, 'catalog.next'), JSON.stringify({ ...twice,
      remotes: { 'room-a': { device_id: 'remote-a', source: 'remote-a' }, unplaced: { device_id: 'remote-a', source: 'remote-b' } } }));
    await rename(join(dir, 'catalog.next'), catalogPath);
    await until(() => logged.filter(line => line.startsWith('Runtime config rejected')).length > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fake.listeners.get('smarthome_script')?.({ event_type: 'smarthome_script', data: { script: 'automation.lighting_recover_pending_output', args: { trigger: {} } } });
  await new Promise(resolve => setTimeout(resolve, 200));
} else if (mode === 'reload') {
  await writeFile(join(dir, 'catalog.next'), catalog({ 'light.lamp_a': ['bulb-a'], 'light.lamp_c': ['bulb-c'] }));
  await rename(join(dir, 'catalog.next'), catalogPath);
  await until(() => logged.includes('Runtime config reloaded.'));
} else if (gap) {
  await new Promise(resolve => setTimeout(resolve, 100));
  fake.listeners.get('smarthome_script')?.({ event_type: 'smarthome_script', data: { script: 'automation.lighting_recover_pending_output', args: { trigger: {} } } });
  await new Promise(resolve => setTimeout(resolve, 200));
} else {
  // Let the start's turn make (and have refused) its calls.
  await until(() => fake.calls.some(call => call.service !== 'input_text.set_value'));
  await new Promise(resolve => setTimeout(resolve, 100));
}
const heartbeat = (calls: readonly ServiceCall[]) => calls.filter(call => call.target?.entity_id === 'input_text.ls_port_heartbeat')
  .map(call => String(call.data.value));
// A beat makes its call asynchronously: wait for each fired beat's call before printing, or a slow runner prints the
// start's beat alone (seen on CI, PR #50).
const beatsBefore = heartbeat(fake.calls).length;
for (const beat of beats) beat();
if (beats.length > 0) await until(() => heartbeat(fake.calls).length > beatsBefore);
process.stdout.write(`${JSON.stringify({ made: heartbeat(fake.calls), taken: heartbeat(fake.taken),
  others: fake.calls.filter(call => call.target?.entity_id !== 'input_text.ls_port_heartbeat').length, logged,
  bulbA: fake.calls.filter(call => call.service === 'mqtt.publish' && call.data.topic === 'zigbee2mqtt/bulb-a').length,
  runtime: fake.calls.filter(call => call.target?.entity_id === 'sensor.ls_effects_runtime'),
  catalog: await readFile(catalogPath, 'utf8') })}\n`);
process.exit(0);
