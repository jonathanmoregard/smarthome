/** Test-only transport for Python numeric edge cases that JSON cannot represent, over `src/rpc.ts`'s `answer`.
 * Production src/rpc.ts never accepts this envelope. No decision logic lives here.
 */
import { readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { Catalog } from '../../src/adapter/codecs/catalog.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import { answer } from '../../src/rpc.ts';
import type { Request } from '../../src/rpc.ts';

type PathPart = string | number;
interface Nonfinite { path: PathPart[]; value: 'NaN' | 'Infinity' | '-Infinity' }
interface Envelope { payload: unknown; nonfinite: Nonfinite[] }

function decode(envelope: Envelope): unknown {
  for (const entry of envelope.nonfinite) {
    if (!entry.path.length) throw new Error('A numeric root is not a request');
    let container = envelope.payload;
    for (const key of entry.path.slice(0, -1)) {
      if (!container || typeof container !== 'object' || !Object.hasOwn(container, key)) throw new Error('Invalid numeric path');
      container = (container as Record<PathPart, unknown>)[key];
    }
    const key = entry.path.at(-1)!;
    if (!container || typeof container !== 'object' || !Object.hasOwn(container, key)) throw new Error('Invalid numeric path');
    if (!['NaN', 'Infinity', '-Infinity'].includes(entry.value)) throw new Error('Invalid numeric tag');
    Object.defineProperty(container, key, { value: Number(entry.value), enumerable: true, writable: true, configurable: true });
  }
  return envelope.payload;
}

function encode(payload: unknown): Envelope {
  const nonfinite: Nonfinite[] = [];
  function walk(value: unknown, path: PathPart[]): unknown {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      nonfinite.push({ path, value: String(value) as Nonfinite['value'] });
      return null;
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, [...path, index]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, [...path, key])]));
    return value;
  }
  return { payload: walk(payload, []), nonfinite };
}

const buffer = Buffer.alloc(65536);
const decoder = new StringDecoder('utf8');
let pending = '';
function readLine(): string | null {
  while (!pending.includes('\n')) {
    const count = readSync(0, buffer, 0, buffer.length, null);
    if (!count) {
      const last = pending || null;
      pending = '';
      return last;
    }
    pending += decoder.write(buffer.subarray(0, count));
  }
  const end = pending.indexOf('\n');
  const line = pending.slice(0, end);
  pending = pending.slice(end + 1);
  return line;
}
function readMessage(): unknown {
  const line = readLine();
  if (line === null) return null;
  const value = JSON.parse(line) as Envelope | Record<string, unknown>;
  return 'nonfinite' in value ? decode(value as Envelope) : value;
}
function send(value: unknown): void { writeSync(1, JSON.stringify(encode(value)) + '\n'); }
/** The one lamp the preserved fixtures let run Candle (the port's former hard-coded `CANDLE_LAMP`). */
const FIXTURE_CANDLE_LAMPS: ReadonlySet<string> = new Set(['light.living_room_yellow_retro_lamp']);
/** The mode the preserved fixtures name (the port's former hard-coded mode). */
const FIXTURE_MODE = parseCatalog({ mode: 'sara' }).mode;
/**
 * The preserved fixtures predate the catalog's per-bulb `candle` flag and its `mode`: in them, one lamp ran Candle by
 * name, and the mode's name was built in. That lamp's bulbs are marked, and the mode named, in each run's parsed
 * catalog, never in the document, since `effects_catalog` output is compared byte for byte. Production reads the
 * catalog's flag and mode instead.
 */
function withFixtureNames(catalog: Catalog): void {
  for (const [lamp, bulbs] of Object.entries(catalog.members)) {
    if (FIXTURE_CANDLE_LAMPS.has(lamp)) for (const bulb of bulbs) catalog.bulbs[bulb] = { candle: true };
  }
  catalog.mode = FIXTURE_MODE;
}
const nativeLog = Math.log;

async function perform(value: unknown): Promise<void> {
  const previousLog = Math.log;
  try {
    const request = value as Request & { parityHooks?: 'all' | 'commit'; parityLog?: boolean; parityDependencies?: Record<string, unknown> };
    const mathLogCalls: number[] = [];
    Math.log = request.parityLog ? (input: number) => { mathLogCalls.push(input); return nativeLog(input); } : nativeLog;
    // A turn runs no other script and stops at no call, so the commit hook never fires; a service hook cannot be kept.
    if (request.parityHooks === 'all') throw new Error('Service callbacks are not supported: a turn does not stop at its calls');
    for (const name of Object.keys(request.parityDependencies ?? {})) {
      if (name !== 'ls_plan') throw new Error(`Unsupported parity literal dependency: ${name}`);
    }
    send({ ...await answer(request, withFixtureNames), mathLogCalls, dependencyCalls: [] });
  } catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    Math.log = previousLog;
  }
}

for (;;) {
  const value = readMessage();
  if (value === null) break;
  await perform(value);
}
