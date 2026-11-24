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
import { parseDeployedCatalog } from './adapter/codecs/catalog.ts';
import type { Catalog } from './adapter/codecs/catalog.ts';
import { HA_EVENTS, houseMirrorOf, stateChangedOf } from './adapter/codecs/house.ts';
import type { HouseMirror } from './adapter/codecs/house.ts';
import { bridgeRunOf } from './adapter/codecs/inputs.ts';
import { toInstant } from './adapter/codecs/ids.ts';
import { parseRooms } from './adapter/codecs/rooms.ts';
import { HomeAssistantClient } from './adapter/ha-client.ts';
import type { JsonValue, ServiceCall } from './adapter/ha-client.ts';
import { heartbeatCall, timingCall } from './adapter/encode.ts';
import { lockJournal } from './journal-lock.ts';
import { lampRooms, refuseUnknownRooms, roomsGiven } from './adapter/live-rooms.ts';
import type { LiveRooms } from './adapter/live-rooms.ts';
import { Host } from './host.ts';
import type { Journal, Timer } from './host.ts';
import type { Instant } from './domain/types/time.ts';

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // First: a port started without its rooms must not touch anything.
  const given = roomsGiven(argv);
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
  let catalog = await readRuntimeCatalog(configuration);
  const journal = resolve(option('--state') ?? '.runtime/journal.json'), unlock = await lockJournal(journal);
  const ha = await HomeAssistantClient.connect(url, await readFile(tokenFile, 'utf8'))
    .catch(async (error: unknown) => { await unlock(); throw error; });
  const read = async () => houseMirrorOf(await ha.read());
  let stopHeartbeat = () => {}, watcher: FSWatcher | undefined;
  try {
    const mirror = await read();
    const areas = parseRooms(mirror.areas);
    if (given.kind === 'listed') refuseUnknownRooms(given.rooms, catalog, areas);
    // The heartbeat names every room the port may drive: with the whole house, each room of its lamps.
    const liveRooms = given.kind === 'listed' ? given.rooms : lampRooms(catalog, areas);
    const clock = () => toInstant(Date.now() / 1000), warn = (message: string) => console.warn(message);
    const host = await Host.open({ ha, journal: fileJournal(journal), clock, log: console,
      timer, rooms: given, took: seconds => void ha.call(timingCall(seconds)).catch(() => undefined) }, mirror, catalog);
    // A registry change may move a lamp or a label the config is read from: the turn after the read takes it.
    const reread = rereading(read, (house, startedAt) => { host.houseRead(house, startedAt); host.accept({ kind: 'wake' }); }, warn, clock, timer);
    const reconnect = rereading(read, (house, startedAt) => host.reconnected(house, startedAt), warn, clock, timer);
    ha.onConnection(connected => { if (connected) reconnect(); else host.disconnected(); });
    await ha.subscribe(HA_EVENTS.started, reconnect);
    await ha.subscribe(HA_EVENTS.stateChanged, event => {
      const changed = stateChangedOf(event.data);
      host.stateChanged(changed.entity, changed.state);
    });
    // Home Assistant keeps the triggers only; every decision runs in this process.
    await ha.subscribe(HA_EVENTS.bridgeRun, event => { const run = bridgeRunOf(event.data); host.script(run.script, run.args); });
    for (const event of HA_EVENTS.registries) await ha.subscribe(event, reread);
    stopHeartbeat = startHeartbeat(liveRooms, call => ha.call(call), message => console.error(message), HEARTBEAT_MS, () => host.paused());
    watcher = watchRuntimeCatalog(configuration, async read => {
      catalog = read;
      host.catalogChanged(catalog);
      host.accept({ kind: 'wake' });
      console.error('Runtime config reloaded.');
    }, error => console.error(`Runtime config rejected; previous config retained: ${String(error)}`));
    host.accept({ kind: 'started' });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true; stopHeartbeat(); watcher?.close(); await host.close(); await ha.close(); await unlock();
    };
    process.once('SIGINT', () => { void stop().then(() => process.exit()); });
    process.once('SIGTERM', () => { void stop().then(() => process.exit()); });
    console.error('Home Assistant host ready.');
  } catch (error) {
    stopHeartbeat(); watcher?.close(); await ha.close(); await unlock();
    throw error;
  }
}

/** The runtime catalog, parsed in full at load and at every reload, so a catalog the lighting would refuse never replaces the running one. */
export async function readRuntimeCatalog(path: string): Promise<Catalog> {
  const document: JsonValue = JSON.parse(await readFile(path, 'utf8'));
  return parseDeployedCatalog(document);
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

/** Node's timer as the host's. */
const timer: Timer = (delayMs, wake) => { const handle = setTimeout(wake, delayMs); return () => clearTimeout(handle); };

/** The longest wait between two reads of the house that failed. */
const READ_RETRY_CAP_SECONDS = 60;

/**
 * A whole read of the house, handed to `land` with the instant it started. A read that fails (or a house that cannot
 * be mirrored) is reported and tried again on a backoff, 1 s doubling up to a minute, until one lands, so a host paused
 * for the read does not stay paused. Starting again drops a retry still waiting.
 */
export function rereading(read: () => Promise<HouseMirror>, land: (house: HouseMirror, startedAt: Instant) => void,
  report: (message: string) => void, clock: () => Instant, after: Timer): () => void {
  let round = 0, cancel = () => {};
  const attempt = (current: number, tries: number): void => {
    const startedAt = clock();
    read().then(house => { if (current === round) land(house, startedAt); }, (error: unknown) => {
      if (current !== round) return;
      const seconds = Math.min(READ_RETRY_CAP_SECONDS, 2 ** tries);
      report(`lighting: the house was not read (${error instanceof Error ? error.message : String(error)}); read again in ${seconds} s`);
      cancel = after(seconds * 1000, () => attempt(current, tries + 1));
    });
  };
  return () => { cancel(); round++; attempt(round, 0); };
}

/** How often the port beats; Home Assistant's watchdog treats 30 s without a beat as the port gone. */
export const HEARTBEAT_MS = 10_000;
/**
 * Beat now and every `intervalMs` until the answer is called, but not while `paused` (the host waits for Home
 * Assistant), so the watchdog sees the port stall. A failed beat is reported and the next one still goes.
 */
export function startHeartbeat(live: LiveRooms, send: (call: ServiceCall) => Promise<unknown>, report: (message: string) => void,
  intervalMs = HEARTBEAT_MS, paused: () => boolean = () => false): () => void {
  const beat = () => {
    if (paused()) return;
    const call = heartbeatCall(live, Date.now());
    if (call !== undefined) void send(call).catch(error => report(`Heartbeat not sent: ${error instanceof Error ? error.message : String(error)}`));
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  return () => clearInterval(timer);
}

export function watchRuntimeCatalog(path: string, accept: (catalog: Catalog) => Promise<void>, reject: (error: unknown) => void): FSWatcher {
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

