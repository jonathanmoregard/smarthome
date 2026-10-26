/** Explicit, serializable boundary between lighting decisions and HA I/O. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export interface EntityState {
  state: string;
  attributes: JsonObject;
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
  catalog?: JsonObject;
  entitySources?: Record<string, string>;
}
export interface ScriptContext extends Snapshot {
  calls: ServiceCall[];
  events: EventRecord[];
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
