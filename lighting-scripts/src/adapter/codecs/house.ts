/**
 * The house as a turn reads it: Home Assistant's states and registry, the
 * catalog parsed once, and the clock. The codecs read it; nothing else looks
 * inside.
 */
import type { EntityState, JsonObject, JsonValue, ServiceCall } from '../ha-client.ts';
import type { Catalog } from './catalog.ts';
import type { Rooms } from './rooms.ts';
import { parseRooms } from './rooms.ts';

export type HouseView = {
  state: Record<string, EntityState>;
  rooms: Rooms;
  members: string[];
  labels?: Record<string, string[]>;
  devices?: Record<string, string[]>;
  entitySources?: Record<string, string>;
  /** The house's timezone; none when Home Assistant gave none, which the config codec reads as its default. */
  timezone: string | undefined;
  /** The turn's clock, as ISO text. */
  now: string;
  catalog: Catalog;
  /** An entity's state text; `unknown` for an entity Home Assistant does not have. */
  get(entity: string): string;
  attr(entity: string, key: string): JsonValue | undefined;
};

/** Home Assistant's states and registry as the host mirrors them. */
export type HouseMirror = {
  state: Record<string, EntityState>;
  areas: Record<string, string>;
  members: string[];
  labels?: Record<string, string[]>;
  devices?: Record<string, string[]>;
  entitySources?: Record<string, string>;
  timezone?: string;
};

/** The house a turn reads: the mirror, its rooms parsed, the catalog and the turn's clock as ISO text. */
export function houseView(mirror: HouseMirror, now: string, catalog: Catalog): HouseView {
  const state = mirror.state;
  return {
    state, rooms: parseRooms(mirror.areas), members: mirror.members, labels: mirror.labels ?? {}, devices: mirror.devices ?? {},
    entitySources: mirror.entitySources ?? {}, timezone: mirror.timezone, now, catalog,
    get: entity => state[entity]?.state ?? 'unknown',
    attr: (entity, key) => state[entity]?.attributes[key],
  };
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
