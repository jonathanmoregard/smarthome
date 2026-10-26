/** Test-only transport for Python numeric edge cases that JSON cannot represent.
 * Production src/rpc.ts never accepts this envelope. No decision logic lives here.
 */
import { readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { execute, type ExecutionHooks, type ExecutionRequest } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { ScriptContext, ServiceCall, Snapshot } from '../../src/runtime/context.ts';

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
const nativeLog = Math.log;

function perform(value: unknown): void {
  const previousLog = Math.log;
  try {
    const request = value as ExecutionRequest & { parityHooks?: 'all' | 'commit'; parityLog?: boolean };
    const mathLogCalls: number[] = [];
    Math.log = request.parityLog ? (input: number) => { mathLogCalls.push(input); return nativeLog(input); } : nativeLog;
    let depth = 0;
    const trace: ServiceCall[] = [];
    function callback(phase: string, call: ServiceCall, context: ScriptContext): void {
      const ctx = context as ScriptContext & { snapshot(): Snapshot; scriptRuns: string[] };
      send({ callback: { phase, call, snapshot: ctx.snapshot(), calls: trace, events: ctx.events, scriptRuns: ctx.scriptRuns } });
      for (;;) {
        const incoming = readMessage();
        if (!incoming || typeof incoming !== 'object') throw new Error('Missing callback response');
        if ('callback_result' in incoming) {
          const result = incoming.callback_result as { snapshot?: Snapshot; error?: string };
          if (result.error) throw new Error(result.error);
          if (!result.snapshot) throw new Error('Missing callback snapshot');
          Object.assign(ctx, result.snapshot);
          return;
        }
        // Original callbacks may run another script while the outer action is
        // paused. Run that independent transaction before awaiting its state.
        perform(incoming);
      }
    }
    const hooks: ExecutionHooks = request.parityHooks ? {
      beforeService: (call, ctx) => {
        if (request.parityHooks === 'all') callback('before', call, ctx);
        trace.push(structuredClone(call));
      },
      afterService: (call, ctx) => {
        if (request.parityHooks === 'all') callback('after', call, ctx);
      },
      beforeScript: (name, args, ctx) => {
        if (depth++ > 0) {
          const call = { service: 'script.' + name, data: args, time: ctx.elapsed ?? 0 };
          if (request.parityHooks === 'all' || name === 'ls_commit') callback('before', call, ctx);
          trace.push(structuredClone(call));
        }
      },
      afterScript: (name, args, _result, ctx) => {
        if (--depth > 0 && request.parityHooks === 'all') callback('after', { service: 'script.' + name, data: args }, ctx);
      },
    } : {};
    const result = execute(request, handlers, hooks);
    send({ ...result, ...(request.parityHooks ? { calls: trace } : {}), mathLogCalls });
  } catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    Math.log = previousLog;
  }
}

for (;;) {
  const value = readMessage();
  if (value === null) break;
  perform(value);
}
