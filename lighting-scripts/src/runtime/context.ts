import type { Catalog } from '../adapter/codecs/catalog.ts';
import type { Rooms } from '../adapter/codecs/rooms.ts';

import type { EntityState, JsonObject, JsonValue, ServiceCall as HaServiceCall } from '../adapter/ha-client.ts';
export type { EntityState, JsonObject, JsonValue };
export interface ServiceCall extends HaServiceCall {
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
  /** The snapshot's {@link Snapshot.areas}, parsed: which room each thing is in. */
  readonly rooms: Rooms;
  /**
   * The unparsed catalog document.
   *
   * For the edges only: the name-keyed `effects_catalog` shim serves it
   * verbatim so the HA and parity backends keep comparing the same bytes,
   * including fields no lighting logic reads. Domain logic uses
   * {@link ScriptContext.catalog}.
   */
  rawCatalog(): JsonObject;
  /** Run a script by name and get its JSON answer. */
  run(name: string, args?: JsonObject): JsonValue;
  get(entity: string): string;
  attr(entity: string, key: string): JsonValue | undefined;
  put(entity: string, state: string, attributes?: JsonObject): void;
  emit(service: string, data: JsonObject, target?: JsonObject, guard?: OutputGuard): void;
  fire(event: string, data: JsonObject): void;
  schedule(script: string, args: JsonObject, delayMs: number): void;
}
export type ScriptHandler = (context: ScriptContext, args: JsonObject) => JsonValue;
export type ScriptHandlers = Record<string, ScriptHandler>;
