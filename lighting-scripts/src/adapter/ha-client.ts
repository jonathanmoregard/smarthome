/**
 * Home Assistant's wire, as the adapter reads and writes it: JSON values, an
 * entity's state, a service call.
 */

/** A JSON value as Home Assistant and the harness send it: the input to parsing, never its result. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/** An entity's state as Home Assistant reports it. */
export interface EntityState {
  state: string;
  attributes: JsonObject;
  context?: JsonObject;
  entity_id?: string;
  last_updated?: string;
  last_changed?: string;
}

/** A Home Assistant service call: `domain.service`, its data and its target. */
export interface ServiceCall {
  service: string;
  data: JsonObject;
  target?: JsonObject;
}

/** What the host needs of Home Assistant: a service call, which rejects when Home Assistant did not take it. */
export interface HaClient {
  call(call: ServiceCall): Promise<void>;
}
