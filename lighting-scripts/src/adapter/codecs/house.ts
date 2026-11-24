/**
 * The house as a turn reads it: Home Assistant's states and registry, the
 * catalog parsed once, and the clock. The codecs read it; nothing else looks
 * inside.
 */
import { isDeepStrictEqual } from 'node:util';
import type { EntityState, HouseRead, JsonObject, JsonValue, WireState } from '../ha-client.ts';
import type { Output } from '../encode.ts';
import { leftBy } from './writes.ts';
import { isObject } from './parse.ts';
import type { Catalog } from './catalog.ts';
import type { Rooms } from './rooms.ts';
import type { Instant } from '../../domain/types/time.ts';
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

/** The house with `state` for its states. */
export function withStates(house: HouseView, state: Record<string, EntityState>): HouseView {
  return { ...house, state, get: entity => state[entity]?.state ?? 'unknown', attr: (entity, key) => state[entity]?.attributes[key] };
}

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

/**
 * A whole read of the house, started at `startedAt`, laid over the mirror: the read's registry, and each state as the
 * read has it unless the mirror's changed after the read started and after the read's own copy (an event that came
 * in, or a write of ours, while the read was on its way). A state the read lacks is gone, unless it changed since.
 */
export function mergedRead(current: HouseMirror, read: HouseMirror, startedAt: Instant): HouseMirror {
  const state: Record<string, EntityState> = {};
  const updated = (entity: EntityState | undefined): number => {
    const seconds = entity?.last_updated === undefined ? NaN : Date.parse(entity.last_updated) / 1000;
    return Number.isFinite(seconds) ? seconds : -Infinity;
  };
  for (const [entity, mine] of Object.entries(current.state)) {
    const theirs = read.state[entity], at = updated(mine);
    if (at > startedAt && at > updated(theirs)) state[entity] = mine;
  }
  for (const [entity, theirs] of Object.entries(read.state)) state[entity] ??= theirs;
  return { ...read, state };
}

/** The mirror of a whole read. Schedule membership is the `house_schedule` label over the catalog's lamps. */
export function houseMirrorOf(read: HouseRead, lamps: ReadonlySet<string>): HouseMirror {
  const areaOf: Record<string, string> = {}, deviceEntities: Record<string, string[]> = {}, labelled: Record<string, string[]> = {};
  const deviceIndex = new Map(read.devices.map(device => [device.id, device]));
  const labelIndex = new Map(read.labels.map(label => [label.label_id, label.name]));
  const label = (name: string, entity: string) => {
    for (const key of new Set([name, labelIndex.get(name) ?? name])) labelled[key] = [...new Set([...(labelled[key] ?? []), entity])];
  };
  for (const area of read.areas) for (const name of area.labels ?? []) label(name, area.area_id);
  for (const device of read.devices) if (device.area_id !== null) areaOf[device.id] = device.area_id;
  for (const entity of read.entities) {
    const device = entity.device_id === null ? undefined : deviceIndex.get(entity.device_id);
    const area = entity.area_id ?? device?.area_id;
    if (area !== undefined && area !== null) areaOf[entity.entity_id] = area;
    if (entity.device_id !== null) (deviceEntities[entity.device_id] ??= []).push(entity.entity_id);
    for (const name of [...entity.labels ?? [], ...device?.labels ?? []]) label(name, entity.entity_id);
  }
  return {
    state: Object.fromEntries(read.states.map(state => [state.entity_id, entityStateOf(state)])), areas: areaOf,
  members: (labelled.house_schedule ?? []).filter(entity => lamps.has(entity)), labels: labelled, devices: deviceEntities,
  entitySources: Object.fromEntries(Object.entries(read.sources).map(([entity, source]) => [entity, source.domain])), timezone: read.timezone,
  };
}

/** The house a turn reads: the mirror, its rooms parsed, the catalog and the turn's clock as ISO text. */
export function houseView(mirror: HouseMirror, now: Instant, catalog: Catalog): HouseView {
  const state = mirror.state;
  return {
    state, rooms: parseRooms(mirror.areas), members: mirror.members, labels: mirror.labels ?? {}, devices: mirror.devices ?? {},
    entitySources: mirror.entitySources ?? {}, timezone: mirror.timezone, now: isoText(now), catalog,
    get: entity => state[entity]?.state ?? 'unknown',
    attr: (entity, key) => state[entity]?.attributes[key],
  };
}

/** An instant as Home Assistant's ISO time text, to the millisecond. */
function isoText(at: Instant): string {
  return new Date(at * 1000).toISOString();
}

/**
 * Whether Home Assistant is done with an output of ours queued at `since`: the entity it writes shows what it leaves
 * ({@link leftBy}: a sensor's attributes, anything else its value, a number by its value), or changed after `since`,
 * by someone else, which supersedes it. An output that leaves nothing here (an MQTT message) is never done here.
 */
export function writeSettled(states: Readonly<Record<string, EntityState>>, output: Output, since: Instant): boolean {
  const left = leftBy(output), shown = left === undefined ? undefined : states[left.entity];
  if (left === undefined || shown === undefined) return false;
  const changed = Date.parse(shown.last_changed ?? '') / 1000;
  if (Number.isFinite(changed) && changed > since) return true;
  if (left.attributes !== undefined) return Object.entries(left.attributes).every(([key, value]) => isDeepStrictEqual(shown.attributes[key], value));
  const number = (text: string) => text.trim() === '' ? NaN : Number(text);
  return shown.state === left.state || number(shown.state) === number(left.state);
}

/**
 * The states once Home Assistant has taken an output of ours, as it reports them: what the output leaves
 * ({@link leftBy}) laid over its entity, a sensor's attributes merged over the stored ones. Applied at once, so the
 * next turn reads what was written before the echo arrives.
 */
export function afterOutput(states: Readonly<Record<string, EntityState>>, output: Output, at: Instant): Record<string, EntityState> {
  const left = leftBy(output), now = isoText(at);
  if (left === undefined) return { ...states };
  const previous = states[left.entity], kept = previous === undefined ? {} : previous.attributes;
  return { ...states, [left.entity]: { entity_id: left.entity, state: left.state,
    attributes: structuredClone(left.attributes === undefined ? kept : { ...kept, ...left.attributes }), last_updated: now,
    last_changed: previous?.state === left.state ? previous.last_changed ?? now : now } };
}

/** Home Assistant's events the host subscribes to, by the names Home Assistant gives them. */
export const HA_EVENTS = {
  /** Home Assistant itself started again: the house is read afresh and reconciled. */
  started: 'homeassistant_started',
  stateChanged: 'state_changed',
  /** A script or automation run the bridge forwards ({@link bridgeRunOf} in inputs.ts). */
  bridgeRun: 'smarthome_script',
  /** A registry changed: the house is read again whole. */
  registries: ['entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'label_registry_updated'],
} as const;

/** The states with `entity` set to `state`, or removed when it has none. */
export function withState(states: Readonly<Record<string, EntityState>>, entity: string, state: EntityState | undefined): Record<string, EntityState> {
  const next = { ...states };
  if (state === undefined) delete next[entity]; else next[entity] = state;
  return next;
}

/** A `state_changed` event: the entity, and its new state, none when it was removed. */
export function stateChangedOf(data: JsonObject): { entity: string; state: EntityState | undefined } {
  const entity = String(data.entity_id), raw = data.new_state;
  if (!isObject(raw)) return { entity, state: undefined };
  const text = (key: string): string => typeof raw[key] === 'string' ? raw[key] : '';
  return { entity, state: entityStateOf({ entity_id: entity, state: text('state'), attributes: raw.attributes, context: raw.context,
    last_changed: text('last_changed'), last_updated: text('last_updated') }) };
}

/** An entity's state as the websocket sends it, in the shape the codecs read. */
export function entityStateOf(state: WireState): EntityState {
  const context = isObject(state.context) ? state.context : undefined;
  return { state: state.state, attributes: isObject(state.attributes) ? state.attributes : {}, entity_id: state.entity_id,
    last_changed: state.last_changed, last_updated: state.last_updated, ...(context === undefined ? {} : { context }) };
}
