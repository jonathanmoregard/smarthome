/**
 * The house as a turn reads it: Home Assistant's states and registry, the
 * catalog parsed once, and the clock. The codecs read it; nothing else looks
 * inside.
 */
import type { EntityState, JsonValue } from '../ha-client.ts';
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
