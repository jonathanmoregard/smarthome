import type { JsonObject, ScriptContext, ScriptHandler, ScriptHandlers } from '../../src/runtime/context.ts';
import type { Catalog } from '../../src/runtime/catalog.ts';
import { emptyCatalog, parseCatalog } from '../../src/runtime/catalog.ts';
import { typedDispatch } from '../../src/runtime/entrypoints.ts';

function handler(handlers: ScriptHandlers | undefined, name: string): ScriptHandler {
  const found = handlers?.[name.replace(/^script\./, '')];
  if (!found) throw Error(`Unsupported test handler ${name}`);
  return found;
}

/**
 * Raw catalog documents per context, mirroring the engine: a test supplies the
 * document, and the parsed view is derived from it on first read. Keeping the
 * raw document is what lets a test state a malformed catalog and assert on the
 * parse error, which assigning a ready-made `Catalog` could not express.
 */
const documents = new WeakMap<ScriptContext, { raw?: JsonObject; parsed?: Catalog }>();

/** Supply the raw runtime catalog, as the catalog file and HA snapshot do. */
export function setCatalog(ctx: ScriptContext, document: JsonObject): void {
  documents.set(ctx, { raw: document });
}

/**
 * The handler table a context dispatches against, so a test can widen it after
 * the fact. Replacing `ctx.run` by hand does not work any more and never really
 * did: it bypasses the context's own dispatch, so a typed call would reach a
 * different table than a name-keyed one.
 */
const tables = new WeakMap<ScriptContext, ScriptHandlers>();

/** Add handlers to an existing context, as a later `import` makes them available. */
export function setHandlers(ctx: ScriptContext, handlers: ScriptHandlers): void {
  tables.set(ctx, { ...tables.get(ctx), ...handlers });
}

/** Dry service sink: no network, while helper writes are visible to the next event. */
export function context(handlers: ScriptHandlers = {}): ScriptContext {
  const ctx: ScriptContext = {
    state: {}, areas: {}, members: [], now: '2026-10-26T12:00:00+01:00', calls: [], events: [],
    get catalog(): Catalog {
      const held = documents.get(this) ?? {};
      held.parsed ??= held.raw === undefined ? emptyCatalog() : parseCatalog(held.raw);
      documents.set(this, held);
      return held.parsed;
    },
    rawCatalog() { return documents.get(this)?.raw ?? {}; },
    get(entity) { return this.state[entity]?.state ?? 'unknown'; },
    attr(entity, key) { return this.state[entity]?.attributes[key]; },
    put(entity, state, attributes) { this.state[entity] = { state, attributes: attributes ?? this.state[entity]?.attributes ?? {} }; },
    emit(service, data, target) { this.calls.push({ service, data, ...(target ? { target } : {}) }); },
    fire(event, data) { this.events.push({ event, data }); },
    schedule(script, args, delayMs) { (this.scheduled ??= []).push({ script, args, due: Date.parse(this.now) + delayMs }); },
    run(name, args = {}) { return handler(tables.get(this), name)(this, args); },
    // Mirrors the engine through the same `typedDispatch`, so a name-keyed stub
    // in a test is decoded here exactly as the engine would decode it.
    call(name, args = {}) { return typedDispatch(name, handler(tables.get(this), name), this, args); },
  };
  tables.set(ctx, { ...handlers });
  return ctx;
}
export function commandCalls(ctx: ScriptContext): JsonObject[] {
  return ctx.calls.filter(c => c.service === 'script.turn_on' && c.target?.entity_id === 'script.ls_remote_command')
    .map(c => c.data.variables as JsonObject);
}
