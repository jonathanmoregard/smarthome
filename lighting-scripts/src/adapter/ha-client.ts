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

/**
 * The states once Home Assistant has taken a call of ours, as it reports them: a sensor update sets its value and its
 * attributes (merged, unless `replace_attributes`), a text or number helper its value as text (`String(value)`), a
 * select its option, a boolean or a switch its power, a timer its run. Any other call changes no state here: what it
 * reaches reports back. Applied at once, so the next turn reads what was written before the echo arrives.
 */
export function afterCall(states: Readonly<Record<string, EntityState>>, call: ServiceCall, now: string): Record<string, EntityState> {
  const next = { ...states };
  const ids = call.target?.entity_id ?? call.data.entity_id;
  for (const entity of (Array.isArray(ids) ? ids : [ids]).filter((id): id is string => typeof id === 'string')) {
    const previous = next[entity];
    const put = (state: string, attributes: JsonObject | undefined): void => {
      next[entity] = { entity_id: entity, state, attributes: structuredClone(attributes ?? previous?.attributes ?? {}), last_updated: now,
        last_changed: previous?.state === state ? previous.last_changed ?? now : now };
    };
    const data = call.data;
    if (call.service === 'variable.update_sensor') {
      const attributes = data.attributes !== null && typeof data.attributes === 'object' && !Array.isArray(data.attributes) ? data.attributes : {};
      put(String(data.value ?? previous?.state ?? 'unknown'), { ...(data.replace_attributes === true ? {} : previous?.attributes), ...attributes });
    } else if (call.service === 'input_text.set_value' || call.service === 'input_number.set_value') put(String(data.value), undefined);
    else if (call.service === 'input_select.select_option') put(String(data.option), undefined);
    else if (/^(input_boolean|homeassistant)\.turn_(on|off)$/.test(call.service)) put(call.service.endsWith('_on') ? 'on' : 'off', undefined);
    else if (call.service === 'timer.start' || call.service === 'timer.cancel') put(call.service === 'timer.start' ? 'active' : 'idle', undefined);
  }
  return next;
}
