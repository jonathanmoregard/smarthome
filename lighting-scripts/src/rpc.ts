/**
 * The harness's host. The e2e harness (through `tests/parity/rpc.py`) sends
 * one script or automation run at a time, `{script, args, snapshot}`, and
 * reads back the calls made and the house after them. This process is one
 * house: the adapter's state lives here between requests, as it does in the
 * live host. No lighting rule lives here.
 *
 * Two things are the harness's own. `effects_catalog` answers the catalog
 * document as it is (the harness reads the house's bulbs, groups and lamps
 * from it). And a turn's wake is a scheduled `ls_wake` in the snapshot, set
 * only when it falls before the next minute's tick, which wakes the loop
 * anyway: the harness runs every scheduled task before its checkpoint, so a
 * wake hours away would run at once.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Catalog } from './adapter/codecs/catalog.ts';
import { emptyCatalog, parseCatalog } from './adapter/codecs/catalog.ts';
import { afterCall, houseView } from './adapter/codecs/house.ts';
import type { HouseMirror } from './adapter/codecs/house.ts';
import { outputCall } from './adapter/encode.ts';
import type { EntityState, JsonObject, JsonValue, ServiceCall } from './adapter/ha-client.ts';
import { scriptInput } from './adapter/codecs/inputs.ts';
import { afterOutputs, handleInput } from './adapter/loop.ts';
import type { Kept } from './adapter/loop.ts';
import { NO_BELIEFS } from './adapter/reconcile.ts';
import { toInstant } from './adapter/codecs/ids.ts';

/** A task the harness runs when the house's clock reaches `due` (epoch milliseconds). */
export type ScheduledTask = { script: string; args: JsonObject; due: number };

/** The house as the harness sends it: the mirror, the clock, the catalog document, and fields it keeps for itself. */
export type Snapshot = HouseMirror & {
  now: string; elapsed?: number; scheduled?: ScheduledTask[]; catalog?: JsonObject; [kept: string]: unknown;
};

export type Request = { script: string; args: JsonObject; snapshot: Snapshot };

/** A call as the harness records it, at the snapshot's `elapsed` seconds. */
export type TimedCall = ServiceCall & { time: number };

export type Answer = { result: JsonValue; snapshot: Snapshot; calls: TimedCall[]; events: never[]; scriptRuns: string[] };

/** The scheduled script a wake runs. */
const WAKE = 'ls_wake';
/** The minute's tick: what wakes the loop without a scheduled wake. */
const TICK_SECONDS = 60;

let kept: Kept = { kind: 'starting', beliefs: NO_BELIEFS };

/** Start as a fresh process does, with an empty journal. */
export function forgetState(): void {
  kept = { kind: 'starting', beliefs: NO_BELIEFS };
}

/** Each line a request; each answer a line, or `{error}`. */
export async function serve(): Promise<void> {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      process.stdout.write(JSON.stringify(answer(JSON.parse(line) as Request)) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    }
  }
}

/**
 * One request: the turn for the run it names, its calls made against the snapshot's states as Home Assistant takes
 * them. `adjust` lets the harness's bridge change the parsed catalog for its fixtures. A name that is not an input
 * raises `Unsupported script`.
 */
export function answer(request: Request, adjust: (catalog: Catalog) => void = () => {}): Answer {
  const { args, snapshot } = request, script = request.script.replace(/^script\./, '');
  if (!Number.isFinite(Date.parse(snapshot.now))) throw new Error('Snapshot now must be an ISO timestamp');
  if (script === 'effects_catalog') {
    return { result: structuredClone(snapshot.catalog ?? {}), snapshot, calls: [], events: [], scriptRuns: [script] };
  }
  const catalog = snapshot.catalog === undefined ? emptyCatalog() : parseCatalog(snapshot.catalog);
  adjust(catalog);
  const input = scriptInput(script, args, catalog.remotes);
  if (input === 'not ours') throw new Error(`Unsupported script: ${script}`);
  if (input === 'dry run') {
    console.error(`lighting: ${script} is a dry run; dropped`);
    return { result: null, snapshot, calls: [], events: [], scriptRuns: [script] };
  }
  const now = toInstant(Date.parse(snapshot.now) / 1000);
  const turn = handleInput(kept, houseView(snapshot, now, catalog), input);
  if (turn.dropped !== undefined) console.error(`lighting: ${script}: ${turn.dropped}; dropped`);
  let state: Record<string, EntityState> = snapshot.state;
  const calls = turn.outputs.map(output => {
    const call: TimedCall = { ...outputCall(output, turn.now), time: snapshot.elapsed ?? 0 };
    state = afterCall(state, call, now);
    return call;
  });
  const settled = afterOutputs(turn, turn.outputs.map(() => false));
  kept = { kind: 'running', state: settled.state };
  for (const bulb of settled.parked) console.info(`lighting: ${bulb} is parked; left until it comes back on or its light changes`);
  const tick = Math.floor(turn.now / TICK_SECONDS) * TICK_SECONDS + TICK_SECONDS;
  const wakeAt = settled.wakeAt !== undefined && settled.wakeAt < tick ? settled.wakeAt : undefined;
  const scheduled = wakeAt === undefined ? snapshot.scheduled : [...(snapshot.scheduled ?? []).filter(task => task.script !== WAKE),
    { script: WAKE, args: {}, due: Date.parse(snapshot.now) + Math.max(0, Math.round((wakeAt - turn.now) * 1000)) }];
  const after: Snapshot = { ...snapshot, state, ...(scheduled === undefined ? {} : { scheduled }) };
  return { result: null, snapshot: after, calls, events: [], scriptRuns: [script] };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await serve();
