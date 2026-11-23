/**
 * The live process: Home Assistant's events into the host, the catalog read
 * at start and on every change, the journal kept in a file, the heartbeat.
 * The test harness does not come here; it runs `src/rpc.ts`.
 */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from './adapter/codecs/catalog.ts';
import type { Catalog } from './adapter/codecs/catalog.ts';
import { toInstant } from './adapter/codecs/ids.ts';
import { parseRooms } from './adapter/codecs/rooms.ts';
import type { JsonObject, ServiceCall } from './adapter/ha-client.ts';
import { heartbeatCall } from './adapter/encode.ts';
import { readLiveRoomsFlag, refuseUnlessWholeHouse } from './adapter/live-rooms.ts';
import type { LiveRooms } from './adapter/live-rooms.ts';
import { Host } from './host.ts';
import type { Journal } from './host.ts';
import { entityState, HomeAssistantClient } from './live.ts';

const record = (value: unknown): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as JsonObject;
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // First: a port started without its rooms must not touch anything.
  const liveRooms = readLiveRoomsFlag(argv);
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return value;
  };
  if (!argv.includes('--live')) throw new Error('The host runs live only (--live); the test harness runs src/rpc.ts');
  const configuration = option('--config');
  if (configuration === undefined) throw new Error('Live mode requires --config with the runtime catalog');
  const url = process.env.HA_URL, tokenFile = process.env.HA_TOKEN_FILE;
  if (url === undefined || tokenFile === undefined) throw new Error('Live mode requires HA_URL and an existing HA_TOKEN_FILE');
  let catalog = parseCatalog(await readRuntimeCatalog(configuration));
  const ha = await HomeAssistantClient.connect(url, await readFile(tokenFile, 'utf8'));
  const read = () => ha.read(new Set(Object.keys(catalog.members)));
  let stopHeartbeat = () => {}, watcher: FSWatcher | undefined;
  try {
    const mirror = await read();
    refuseUnlessWholeHouse(liveRooms, catalog, parseRooms(mirror.areas));
    const host = await Host.open({ ha, journal: fileJournal(resolve(option('--state') ?? '.runtime/journal.json')),
      clock: () => toInstant(Date.now() / 1000), log: console,
      timer: (delayMs, wake) => { const timer = setTimeout(wake, delayMs); return () => clearTimeout(timer); } }, mirror, catalog);
    const report = (error: unknown) => console.error(error instanceof Error ? error.message : String(error));
    const reread = () => read().then(house => host.houseRead(house));
    ha.onConnection(connected => { if (connected) void reread().then(() => host.accept({ kind: 'wake' })).catch(report); });
    await ha.subscribe('state_changed', event => {
      const state = event.data.new_state;
      host.stateChanged(String(event.data.entity_id), state === null || state === undefined ? undefined
        : entityState(state as unknown as Parameters<typeof entityState>[0]));
    });
    // Home Assistant keeps the triggers only; every decision runs in this process.
    await ha.subscribe('smarthome_script', event => host.script(String(event.data.script), record(event.data.args ?? {})));
    for (const event of ['entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'label_registry_updated']) {
      await ha.subscribe(event, () => { void reread().catch(report); });
    }
    stopHeartbeat = startHeartbeat(liveRooms, call => ha.call(call), report);
    watcher = watchRuntimeCatalog(configuration, async document => {
      catalog = parseCatalog(document);
      host.catalogChanged(catalog);
      host.accept({ kind: 'wake' });
      console.error('Runtime config reloaded.');
    }, error => console.error(`Runtime config rejected; previous config retained: ${String(error)}`));
    host.accept({ kind: 'started' });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true; stopHeartbeat(); watcher?.close(); await host.close(); await ha.close();
    };
    process.once('SIGINT', () => { void stop().then(() => process.exit()); });
    process.once('SIGTERM', () => { void stop().then(() => process.exit()); });
    console.error('Home Assistant host ready.');
  } catch (error) {
    stopHeartbeat(); watcher?.close(); await ha.close();
    throw error;
  }
}

/** The runtime catalog, parsed in full at load and at every reload, so a catalog the lighting would refuse never replaces the running one. */
export async function readRuntimeCatalog(path: string): Promise<JsonObject> {
  const catalog = record(JSON.parse(await readFile(path, 'utf8')));
  record(catalog.members); record(catalog.groups); record(catalog.effects);
  parseCatalog(catalog);
  return catalog;
}

/** The journal in a file: none before the first save; each save written whole and renamed into place. */
function fileJournal(path: string): Journal {
  return {
    async load() {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async save(text) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp`, file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    },
  };
}

/** How often the port beats; Home Assistant's watchdog treats 30 s without a beat as the port gone. */
export const HEARTBEAT_MS = 10_000;
/** Beat now and every `intervalMs` until the answer is called. A failed beat is reported and the next one still goes. */
export function startHeartbeat(live: LiveRooms, send: (call: ServiceCall) => Promise<unknown>, report: (message: string) => void,
  intervalMs = HEARTBEAT_MS): () => void {
  const beat = () => {
    const call = heartbeatCall(live, Date.now());
    if (call !== undefined) void send(call).catch(error => report(`Heartbeat not sent: ${error instanceof Error ? error.message : String(error)}`));
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  return () => clearInterval(timer);
}

export function watchRuntimeCatalog(path: string, accept: (catalog: JsonObject) => Promise<void>, reject: (error: unknown) => void): FSWatcher {
  let revision = 0;
  return watch(dirname(resolve(path)), (_event, filename) => {
    if (filename !== basename(path)) return;
    const current = ++revision;
    void readRuntimeCatalog(path).then(async catalog => { if (current === revision) await accept(catalog); }).catch(reject);
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

