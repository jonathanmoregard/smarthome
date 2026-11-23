import type { ScriptContext, ScriptHandler, ScriptHandlers } from '../../src/runtime/context.ts';
import { parseRooms } from '../../src/adapter/codecs/rooms.ts';
import { emptyCatalog } from '../../src/adapter/codecs/catalog.ts';

function handler(handlers: ScriptHandlers, name: string): ScriptHandler {
  const found = handlers[name.replace(/^script\./, '')];
  if (found === undefined) throw Error(`Unsupported test handler ${name}`);
  return found;
}

/** Dry service sink with an empty catalog: no network, while helper writes are visible to the next event. */
export function context(handlers: ScriptHandlers = {}): ScriptContext {
  const catalog = emptyCatalog();
  return {
    state: {}, areas: {}, members: [], now: '2026-10-26T12:00:00+01:00', calls: [], events: [],
    catalog,
    rawCatalog() { return {}; },
    // Parsed on every read, so a test may assign `areas` after building the context.
    get rooms() { return parseRooms(this.areas); },
    get(entity) { return this.state[entity]?.state ?? 'unknown'; },
    attr(entity, key) { return this.state[entity]?.attributes[key]; },
    // Home Assistant stamps last_updated on every write, as the engine's put does.
    put(entity, state, attributes) { this.state[entity] = { state, attributes: attributes ?? this.state[entity]?.attributes ?? {}, last_updated: this.now }; },
    emit(service, data, target) { this.calls.push({ service, data, ...(target ? { target } : {}) }); },
    fire(event, data) { this.events.push({ event, data }); },
    schedule(script, args, delayMs) { (this.scheduled ??= []).push({ script, args, due: Date.parse(this.now) + delayMs }); },
    run(name, args = {}) { return handler(handlers, name)(this, args); },
  };
}
