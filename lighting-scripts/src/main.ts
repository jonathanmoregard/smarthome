import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EntityState, JsonObject, ScriptHandlers, Snapshot } from './runtime/context.ts';
import type { ExecutionRequest, ExecutionResult } from './runtime/engine.ts';
import { parseCatalog } from './runtime/catalog.ts';
import { LightingHost } from './runtime/host.ts';
import type { Program, OutputTransport } from './runtime/host.ts';
import { HomeAssistantTransport } from './live.ts';
import { readLiveRoomsFlag } from './parse/live-rooms.ts';
import type { LiveRooms } from './parse/live-rooms.ts';
import { drivenLamps, handedRooms, heartbeatCall, isPortSwitch, liveScope, newlyHanded, refuseUnknownRooms } from './runtime/live-rooms.ts';
import type { ServiceCall } from './runtime/context.ts';
import type { Handed } from './runtime/live-rooms.ts';

const record = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as JsonObject;
};
export async function loadProgram(directory?: string): Promise<Program> {
  const base = directory ? pathToFileURL(resolve(directory) + '/').href : new URL('./', import.meta.url).href;
  const extension = directory ? 'js' : 'ts';
  const [engine, registry] = await Promise.all([
    import(new URL(`runtime/engine.${extension}`, base).href) as Promise<{ execute: (request: ExecutionRequest, handlers: ScriptHandlers) =>
      ExecutionResult }>,
    import(new URL(`runtime/registry.${extension}`, base).href) as Promise<{ handlers: ScriptHandlers }>,
  ]);
  if (typeof engine.execute !== 'function' || !registry.handlers) throw new Error('Candidate does not export its execution boundary');
  return request => engine.execute(request, registry.handlers);
}
export async function readRuntimeCatalog(path: string): Promise<JsonObject> {
  const catalog = record(JSON.parse(await readFile(path, 'utf8')));
  record(catalog.members); record(catalog.groups); record(catalog.effects);
  // The full parse runs here, at load and at every reload, so a catalog the
  // lighting logic would refuse (a bulb shared by two lamps, say) is rejected
  // before it replaces the running one, not on the next dispatch.
  parseCatalog(catalog);
  return catalog;
}
export function watchRuntimeCatalog(path: string, accept: (catalog: JsonObject) => Promise<void>, reject: (error: unknown) => void): FSWatcher {
  let revision = 0;
  return watch(dirname(resolve(path)), (_event, filename) => {
    if (filename !== basename(path)) return;
    const current = ++revision;
    void readRuntimeCatalog(path).then(async catalog => { if (current === revision) await accept(catalog); }).catch(reject);
  });
}
/**
 * Hands rooms over to the port. Whenever it looks, every room that changed
 * hands to the port since the last look has its lamps re-sent: the old
 * scripts drove them until now, so what the bulbs show is not what the port
 * last sent. Requested lamps are sent whatever was applied, bulb effects
 * included. A look after a missed change (Home Assistant out of reach, a
 * restart) finds the same rooms an event would have.
 */
export class RoomHandover {
  private handed: Handed = new Map();
  private readonly host: LightingHost;
  private readonly live: LiveRooms;
  constructor(host: LightingHost, live: LiveRooms) { this.host = host; this.live = live; }
  /** Re-send the rooms newly handed to the port; answers whether any were. */
  async reconcile(): Promise<boolean> {
    const snapshot = this.host.snapshot(), now = handedRooms(this.live, snapshot), rooms = newlyHanded(this.handed, now);
    this.handed = now;
    const lamps = rooms.size === 0 ? [] : drivenLamps(this.live, snapshot, rooms);
    if (lamps.length > 0) await this.host.dispatch('ls_apply', { reason: 'config', lights: lamps });
    return lamps.length > 0;
  }
}
/** A Home Assistant state change; a port switch changing may hand a room over. */
export async function ingestChange(host: LightingHost, handover: RoomHandover, entity: string, state: EntityState | null): Promise<void> {
  await host.ingestState(entity, state);
  if (isPortSwitch(entity)) await handover.reconcile();
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
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const option = (name: string) =>
    { const index = argv.indexOf(name); if (index < 0) return undefined; const value = argv[index + 1]; if (!value ||
    value.startsWith('--')) throw new Error(`Missing value for ${name}`); return value; };
  // First: a port started without its rooms must not touch anything.
  const liveRooms = readLiveRoomsFlag(argv);
  const configuration = option('--config'), fixture = option('--snapshot');
  const statePath = resolve(option('--state') ?? '.runtime/state.json');
  let initial: Snapshot = fixture ? JSON.parse(await readFile(fixture, 'utf8')) as Snapshot : { state: {}, areas: {}, members: [],
    now: new Date().toISOString() };
  if (configuration) initial.catalog = await readRuntimeCatalog(configuration);
  const program = await loadProgram(option('--program'));
  let live: HomeAssistantTransport | undefined;
  const dryCalls: unknown[] = [];
  let transport: OutputTransport = { send: async call => { dryCalls.push(call); }, close: async () => {} };
  if (argv.includes('--live')) {
    if (!configuration) throw new Error('Live mode requires --config with the existing runtime catalog');
    const url = process.env.HA_URL, tokenFile = process.env.HA_TOKEN_FILE;
    if (!url || !tokenFile) throw new Error('Live mode requires HA_URL and an existing HA_TOKEN_FILE');
    live = await HomeAssistantTransport.connect(url, await readFile(tokenFile, 'utf8'));
    transport = live;
  }
  const host = await LightingHost.open({ path: statePath, initial, program, transport, scope: liveScope(liveRooms), connected: !live,
    report: message =>
    console.error(message) }).catch(async error => { await transport.close(); throw error; });
  let watcher: FSWatcher | undefined;
  const handover = new RoomHandover(host, liveRooms);
  let stopHeartbeat = () => {};
  try {
  if (configuration) await host.update(state => { state.catalog = initial.catalog!; });
  let stopping = false;
  const refresh = async () => {
    if (!live || stopping) return;
    await host.refresh(previous => live!.refresh(previous));
  };
  if (live) {
    await refresh();
    // The registry's areas are read now; a live room they do not hold is refused before anything is sent.
    refuseUnknownRooms(liveRooms, host.snapshot());
    live.onConnection(connected => { void (async () => {
      await host.connectionChanged(false);
      // A room whose switch changed while out of reach is handed over once output is allowed again.
      if (connected) { await refresh(); await host.connectionChanged(true); await handover.reconcile();
        await host.dispatch('ls_apply', { reason: 'config' }); }
    })().catch(error => console.error(String(error))); });
    await live.subscribe('state_changed', event => { void (async () => {
      const entity = String(event.data.entity_id), state = event.data.new_state;
      if (state === null || (state && typeof state === 'object' && !Array.isArray(state))) await ingestChange(host, handover, entity,
        state as unknown as Snapshot['state'][string] | null);
    })().catch(error => console.error(String(error))); });
    // HA retains triggers only; all decision/actions run in the typed process.
    // The host's scope decides, as the run starts, whether the input is the port's.
    await live.subscribe('smarthome_script', event => { void host.dispatch(String(event.data.script),
      record(event.data.args ?? {})).catch(error => console.error(String(error))); });
    for (const event of ['entity_registry_updated', 'device_registry_updated', 'area_registry_updated',
      'label_registry_updated']) await live.subscribe(event, () => { void refresh().then(() => handover.reconcile())
      .catch(error => console.error(String(error))); });
    await host.connectionChanged(true);
    const connection = live;
    stopHeartbeat = startHeartbeat(liveRooms, call => connection.send(call), message => console.error(message));
    // On start every driven room is newly handed over, so its lamps are re-sent.
    if (!await handover.reconcile()) await host.dispatch('ls_apply', { reason: 'config' });
  }
  watcher = configuration ? watchRuntimeCatalog(configuration, async catalog => {
    await host.update(state => { state.catalog = catalog; });
    console.error('Runtime config reloaded.');
    if (live) await host.dispatch('ls_apply', { reason: 'config' });
  }, error => console.error(`Runtime config rejected; previous config retained: ${String(error)}`)) : undefined;
  process.on('message', (message: unknown) => { void (async () => {
    const request = record(message);
    if (request.type !== 'reload' || typeof request.directory !== 'string') return;
    const candidate = await loadProgram(request.directory);
    await host.replaceProgram(candidate);
    if (live) await host.dispatch('ls_apply', { reason: 'config' });
    console.error('Program reloaded; connection and intent retained.');
  })().catch(error => console.error(`Reload rejected; last working program retained: ${String(error)}`)); });
  const stop = async () => { if (stopping) return; stopping = true; stopHeartbeat(); watcher?.close(); await host.close(); };
  process.once('SIGINT', () => { void stop().then(() => process.exit()); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit()); });
  console.error(live ? 'Home Assistant host ready.' : 'Offline host ready; service calls are captured only.');
  if (!live) {
    for await (const line of createInterface({ input: process.stdin })) {
      if (!line.trim()) continue;
      try {
        const command = record(JSON.parse(line));
        const result = await host.dispatch(String(command.script), record(command.args ?? {})); await host.drain();
        process.stdout.write(JSON.stringify({ result, calls: dryCalls.splice(0), snapshot: host.snapshot() }) + '\n');
      } catch (error) { process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n'); }
    }
    await stop();
  }
  } catch (error) { stopHeartbeat(); watcher?.close(); await host.close(); throw error; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main().catch(error =>
  { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
