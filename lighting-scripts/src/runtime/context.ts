import type { Catalog } from './catalog.ts';
import type { TypedResults } from './entrypoints.ts';

/** Explicit, serializable boundary between lighting decisions and HA I/O. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export interface EntityState {
  state: string;
  attributes: JsonObject;
  context?: JsonObject;
  entity_id?: string;
  last_updated?: string;
  last_changed?: string;
}
export interface ServiceCall {
  service: string;
  data: JsonObject;
  target?: JsonObject;
  time?: number;
  guard?: OutputGuard;
}
export interface OutputGuard {
  revision: string;
  generation: JsonValue;
  owners?: string[];
  members?: string[];
  effectTargets?: JsonObject;
  requiresOutputSuccess?: boolean;
}
export interface EventRecord { event: string; data: JsonObject }
export interface ScheduledTask { script: string; args: JsonObject; due: number }
export interface Snapshot {
  state: Record<string, EntityState>;
  areas: Record<string, string>;
  members: string[];
  now: string;
  timezone?: string;
  elapsed?: number;
  labels?: Record<string, string[]>;
  devices?: Record<string, string[]>;
  identifiers?: Record<string, JsonValue[]>;
  scheduled?: ScheduledTask[];
  /**
   * The raw registry document, as persisted and as transported to HA and the
   * parity harness. Parsed into a {@link Catalog} for lighting logic; see
   * {@link ScriptContext}.
   */
  catalog?: JsonObject;
  entitySources?: Record<string, string>;
}
/**
 * `Omit<Snapshot, 'catalog'>` is the point: the snapshot carries the catalog as
 * the raw JSON document it is persisted and transported as, and the context
 * carries the parsed {@link Catalog} that lighting logic reads. Two views over
 * one document, each serving its real caller -- an interface cannot narrow an
 * inherited property, and conflating the two is what previously pushed raw
 * catalog traversal into ten domain modules.
 */
export interface ScriptContext extends Omit<Snapshot, 'catalog'> {
  calls: ServiceCall[];
  events: EventRecord[];
  /** Parsed once per execution, on first read. */
  catalog: Catalog;
  /**
   * The unparsed catalog document.
   *
   * For the edges only: the name-keyed `effects_catalog` shim serves it
   * verbatim so the HA and parity backends keep comparing the same bytes,
   * including fields no lighting logic reads. Domain logic uses
   * {@link ScriptContext.catalog}.
   */
  rawCatalog(): JsonObject;
  /**
   * Call another script by name and get JSON back.
   *
   * The name-keyed view, for the edges: Home Assistant, the parity RPC, and the
   * scripts not yet converted. Prefer {@link ScriptContext.call} for anything
   * in {@link TypedResults} -- `run` hands back `JsonValue`, so the caller has
   * to re-dissolve what the callee already built.
   */
  run(name: string, args?: JsonObject): JsonValue;
  /**
   * Call a converted entrypoint and get its real type back.
   *
   * The arguments stay a `JsonObject` on purpose and are not a leftover: the
   * parity harness records every inter-handler call as
   * `{service: 'script.' + name, data: args}` and compares those bytes
   * (`tests/parity/bridge.ts:117`), and `scriptRuns` records the name
   * (`adapters.py:249`). So the name and the argument bytes are observable
   * behaviour and must not change; the result is the only part of the data flow
   * that was never observed, and the only part this types.
   */
  call<K extends keyof TypedResults>(name: K, args?: JsonObject): TypedResults[K];
  get(entity: string): string;
  attr(entity: string, key: string): JsonValue | undefined;
  put(entity: string, state: string, attributes?: JsonObject): void;
  emit(service: string, data: JsonObject, target?: JsonObject, guard?: OutputGuard): void;
  fire(event: string, data: JsonObject): void;
  schedule(script: string, args: JsonObject, delayMs: number): void;
}
export type ScriptHandler = (context: ScriptContext, args: JsonObject) => JsonValue;
export type ScriptHandlers = Record<string, ScriptHandler>;
