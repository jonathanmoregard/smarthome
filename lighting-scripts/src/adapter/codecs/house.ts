/**
 * The house as a turn reads it: Home Assistant's states and registry, the
 * catalog parsed once, and the clock. The codecs read it; nothing else looks
 * inside.
 */
import type { EntityState, JsonValue } from '../ha-client.ts';
import type { Catalog } from './catalog.ts';
import type { Rooms } from './rooms.ts';

export type HouseView = {
  state: Record<string, EntityState>;
  rooms: Rooms;
  members: string[];
  labels?: Record<string, string[]>;
  devices?: Record<string, string[]>;
  entitySources?: Record<string, string>;
  timezone?: string;
  /** The turn's clock, as ISO text. */
  now: string;
  catalog: Catalog;
  /** An entity's state text; `unknown` for an entity Home Assistant does not have. */
  get(entity: string): string;
  attr(entity: string, key: string): JsonValue | undefined;
};
