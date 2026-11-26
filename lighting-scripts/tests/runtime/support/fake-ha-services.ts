import type { EntityState, JsonObject, ServiceCall } from '../../../src/adapter/ha-client.ts';
import type { Instant } from '../../../src/domain/types/time.ts';

/**
 * Home Assistant's own handling of the services the port calls, for a fake Home Assistant: a sensor update sets its
 * value and its attributes (merged, unless `replace_attributes`), a text or number helper its value as text
 * (`String(value)`), a select its option, a boolean or a switch its power, a timer its run. Any other call changes no
 * state here. The port's own reading of what its writes leave is `leftBy` (src/adapter/codecs/writes.ts); this is the
 * house's side, so it reads the calls by their service names, as Home Assistant does.
 */
export function servicesTook(states: Readonly<Record<string, EntityState>>, call: ServiceCall, at: Instant): Record<string, EntityState> {
  const next = { ...states }, now = new Date(at * 1000).toISOString();
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
