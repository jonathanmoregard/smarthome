/**
 * The harness's host. The e2e harness (through `tests/parity/rpc.py`) sends
 * one script or automation run at a time, `{script, args, snapshot}`, and
 * reads back the calls made and the house after them. This process is one
 * house: it runs the live {@link Host}, kept between requests, over fakes:
 * a Home Assistant that takes every call and records it, a journal in memory,
 * the snapshot's clock, and a timer that becomes the harness's scheduled wake.
 *
 * Two things are the harness's own. `effects_catalog` answers the catalog
 * document as it is (the harness reads the house's bulbs, groups and lamps
 * from it). And a turn's wake is a scheduled `ls_wake` in the snapshot, set
 * only when it falls before the next minute's tick, which wakes the loop
 * anyway: the harness runs every scheduled task before its checkpoint, so a
 * wake hours away would run at once.
 */
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Catalog } from './adapter/codecs/catalog.ts';
import { emptyCatalog, parseCatalog } from './adapter/codecs/catalog.ts';
import type { HouseMirror } from './adapter/codecs/house.ts';
import { toInstant } from './adapter/codecs/ids.ts';
import { scriptInput } from './adapter/codecs/inputs.ts';
import type { JsonObject, JsonValue, ServiceCall } from './adapter/ha-client.ts';
import type { Instant } from './domain/types/time.ts';
import { Host } from './host.ts';

/** A task the harness runs when the house's clock reaches `due` (epoch milliseconds). */
export type ScheduledTask = { script: string; args: JsonObject; due: number };

/** The house as the harness sends it: the mirror, the clock, the catalog document, and fields it keeps for itself. */
export type Snapshot = HouseMirror & {
  now: string; elapsed?: number; scheduled?: ScheduledTask[]; catalog?: JsonObject; [kept: string]: unknown;
};

/** The mirror the snapshot holds, without the harness's own fields. */
function mirrorOf(snapshot: Snapshot): HouseMirror {
  const { state, areas, members, labels, devices, entitySources, timezone } = snapshot;
  return {
    state, areas, members, ...(labels === undefined ? {} : { labels }), ...(devices === undefined ? {} : { devices }),
    ...(entitySources === undefined ? {} : { entitySources }), ...(timezone === undefined ? {} : { timezone }),
  };
}

export type Request = { script: string; args: JsonObject; snapshot: Snapshot };

/** A call as the harness records it, at the snapshot's `elapsed` seconds. */
export type TimedCall = ServiceCall & { time: number };

export type Answer = { result: JsonValue; snapshot: Snapshot; calls: TimedCall[]; events: never[]; scriptRuns: string[] };

/** The scheduled script a wake runs. */
const WAKE = 'ls_wake';
/** The minute's tick: what wakes the loop without a scheduled wake. */
const TICK_SECONDS = 60;

/** What the fakes hand the host for the request in hand: its clock, the calls it records, the wake it asks for. */
type Current = { now: Instant; elapsed: number; calls: TimedCall[]; wakeMs: number | undefined };

let current: Current = { now: toInstant(0), elapsed: 0, calls: [], wakeMs: undefined };
let host: Host | undefined;
let journal: string | undefined;
/** The catalog the host holds: a request's catalog is handed over only when it differs, so the config is read again only then. */
let held: Catalog | undefined;

/** Start as a fresh process does, with an empty journal. */
export function forgetState(): void {
  host = undefined; journal = undefined; held = undefined;
}

/** Each line a request; each answer a line, or `{error}`. */
export async function serve(): Promise<void> {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      process.stdout.write(JSON.stringify(await answer(JSON.parse(line) as Request)) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    }
  }
}

/**
 * One request: the turn for the run it names, made by the host against the snapshot's states as Home Assistant
 * takes them. `adjust` lets the harness's bridge change the parsed catalog for its fixtures. A name that is not an
 * input raises `Unsupported script`.
 */
export async function answer(request: Request, adjust: (catalog: Catalog) => void = () => {}): Promise<Answer> {
  const { args, snapshot } = request, script = request.script.replace(/^script\./, '');
  const ms = Date.parse(snapshot.now);
  if (!Number.isFinite(ms)) throw new Error('Snapshot now must be an ISO timestamp');
  if (script === 'effects_catalog') {
    return { result: structuredClone(snapshot.catalog ?? {}), snapshot, calls: [], events: [], scriptRuns: [script] };
  }
  const catalog = snapshot.catalog === undefined ? emptyCatalog() : parseCatalog(snapshot.catalog);
  adjust(catalog);
  if (scriptInput(script, args, catalog) === 'not ours') throw new Error(`Unsupported script: ${script}`);
  current = { now: toInstant(ms / 1000), elapsed: snapshot.elapsed ?? 0, calls: [], wakeMs: undefined };
  const mirror = mirrorOf(snapshot);
  if (host === undefined) {
    host = await Host.open({
      ha: { call: async call => { current.calls.push({ ...call, time: current.elapsed }); return undefined; } },
      journal: { load: async () => journal, save: async text => { journal = text; } },
      clock: () => current.now, log: console, rooms: { kind: 'house' },
      timer: delayMs => { current.wakeMs = delayMs; return () => { current.wakeMs = undefined; }; },
    }, mirror, catalog);
  } else {
    if (!isDeepStrictEqual(catalog, held)) host.catalogChanged(catalog);
    host.houseRead(mirror, current.now);
  }
  held = catalog;
  // As Home Assistant's bridge forwards it: the host reads it (an echo of ours, a dry run, an input) as live.
  host.script(script, args);
  await host.idle();
  const tick = (Math.floor(current.now / TICK_SECONDS) + 1) * TICK_SECONDS, wakeMs = current.wakeMs;
  const scheduled = wakeMs === undefined || current.now + wakeMs / 1000 >= tick ? snapshot.scheduled
    : [...(snapshot.scheduled ?? []).filter(task => task.script !== WAKE), { script: WAKE, args: {}, due: ms + wakeMs }];
  const after: Snapshot = { ...snapshot, state: host.house().state, ...(scheduled === undefined ? {} : { scheduled }) };
  return { result: null, snapshot: after, calls: current.calls, events: [], scriptRuns: [script] };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await serve();
