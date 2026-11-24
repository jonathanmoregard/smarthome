/**
 * `main()` run whole in a child process, over a fake Home Assistant client, for the close-out round 2 reproducers
 * (tests/runtime/closeout-r2.test.ts). Node's `setInterval` is caught so the heartbeat beats only when this script
 * says, and the process exits when done, which ends the catalog watcher and the journal lock with it.
 *
 * Usage: main-child.ts <dir> reload|refuse. Prints one JSON line: every heartbeat call made, those Home Assistant
 * took, and what the process logged.
 *   reload: the catalog gains `light.lamp_c`, which the registry has in `room-c`, under `--live-rooms all`.
 *   refuse: Home Assistant refuses every call with an error (not out of reach).
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HomeAssistantClient } from '../../../src/adapter/ha-client.ts';
import type { HouseRead, ServiceCall } from '../../../src/adapter/ha-client.ts';

const [dir, mode] = process.argv.slice(2);
if (dir === undefined || (mode !== 'reload' && mode !== 'refuse')) throw new Error('usage: main-child.ts <dir> reload|refuse');

const beats: (() => void)[] = [];
globalThis.setInterval = ((beat: () => void) => { beats.push(beat); return 0; }) as unknown as typeof setInterval;
const logged: string[] = [];
for (const level of ['error', 'warn', 'info', 'log'] as const) console[level] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };

const at = '2026-09-21T12:00:00.000000+00:00';
const wire = (entity_id: string, state: string, attributes: object = {}) => ({ entity_id, state, attributes, last_changed: at, last_updated: at });
const READ: HouseRead = {
  states: [wire('light.lamp_a', 'on', { entity_id: ['bulb-a'] }), wire('bulb-a', 'on', { brightness: 10 }),
    wire('light.lamp_c', 'on', { entity_id: ['bulb-c'] }), wire('bulb-c', 'on', { brightness: 10 }),
    wire('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on')],
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
  async subscribe(): Promise<void> {}
  onConnection(): void {}
  async read(): Promise<HouseRead> { return structuredClone(READ); }
  async close(): Promise<void> {}
}
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
await main(['--live', '--config', catalogPath, '--state', join(dir, 'journal.json'), '--live-rooms', 'all']);
const until = async (done: () => boolean) => { for (let waited = 0; !done() && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20)); };

if (mode === 'reload') {
  await writeFile(join(dir, 'catalog.next'), catalog({ 'light.lamp_a': ['bulb-a'], 'light.lamp_c': ['bulb-c'] }));
  await rename(join(dir, 'catalog.next'), catalogPath);
  await until(() => logged.includes('Runtime config reloaded.'));
} else {
  // Let the start's turn make (and have refused) its calls.
  await until(() => fake.calls.some(call => call.service !== 'input_text.set_value'));
  await new Promise(resolve => setTimeout(resolve, 100));
}
for (const beat of beats) beat();
const heartbeat = (calls: readonly ServiceCall[]) => calls.filter(call => call.target?.entity_id === 'input_text.ls_port_heartbeat')
  .map(call => String(call.data.value));
process.stdout.write(`${JSON.stringify({ made: heartbeat(fake.calls), taken: heartbeat(fake.taken),
  others: fake.calls.filter(call => call.target?.entity_id !== 'input_text.ls_port_heartbeat').length, logged,
  catalog: await readFile(catalogPath, 'utf8') })}\n`);
process.exit(0);
