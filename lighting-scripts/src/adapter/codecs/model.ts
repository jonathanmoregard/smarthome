/**
 * The whole Model read from Home Assistant: the config from the helpers and
 * the catalog, the overlays and saved ranges from the overrides sensor, each
 * remote's gesture state from its room's helpers, and each lamp's saved
 * profile for each block from its store, and each plug's own on/off for
 * each block from the same kind of store.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Config } from '../../domain/config.ts';
import type { LampId, RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Catalog } from './catalog.ts';
import type { EntityState } from '../ha-client.ts';
import type { HouseView } from './house.ts';
import { decodeConfig } from './config.ts';
import type { ConfigSource } from './config.ts';
import { FOLLOWS_ROOM, decodeLampProfile } from './lamp-profiles.ts';
import { storeKeys } from './overlay-key.ts';
import { decodeOverrides } from './overrides-sensor.ts';
import type { Share } from './rooms.ts';
import { IDLE_REMOTE } from '../../domain/remote.ts';
import { decodeRemoteModel } from './remote-helpers.ts';
import { FOLLOWS_ROOM_SWITCH, decodeSwitchProfile } from './switch-profiles.ts';
import { BLOCKS } from '../../domain/types/schedule.ts';
import type { Block } from '../../domain/types/schedule.ts';
import type { LampProfile, SwitchProfile } from '../../domain/profiles.ts';
import type { Model } from '../../domain/update.ts';
import type { RemoteModel } from '../../domain/remote.ts';

/** The config and the profiles: what a helper read gives `update` again. */
export type ConfigRead = Pick<Model, 'config' | 'lampProfiles' | 'switchProfiles'>;

/**
 * What the config and the profiles were last read from: each entity their decoders looked up, as Home Assistant
 * showed it (none for one it does not have), and the registry's rooms, the labels and the timezone. This is the one
 * owner of which entities the config is read from: the set is the decoders' own lookups, recorded as they read, so no
 * list of them is kept by hand. A change to any of it is a change of the config.
 */
export type ConfigFrom = Pick<ConfigSource, 'rooms' | 'labels' | 'timezone'> & { states: Readonly<Record<string, Shown | undefined>> };

/** The whole Model, and what its config and profiles were read from (see {@link ConfigFrom}). */
export function decodeModelFrom(source: ConfigSource, catalog: Catalog): { model: Model; from: ConfigFrom } {
  const { read, from } = readConfig(source, catalog), config = read.config;
  const overrides = decodeOverrides(source.states['sensor.ls_overrides']?.attributes, storeKeys(catalog));
  const remotes: Record<RemoteId, RemoteModel> = Object.fromEntries(entriesOf(config.remotes).map(([remote, { room }]) =>
    [remote, room === undefined ? IDLE_REMOTE : decodeRemoteModel(source, room, reportsOn(source, config, overrides.switchRanges, room))]));
  return { model: { ...read, ...overrides, remotes }, from };
}

/** Whether the config's sources show otherwise in `source` than when it was read `from`: it is to be read again. */
export function configMoved(from: ConfigFrom, source: ConfigSource): boolean {
  return !isDeepStrictEqual(from, configFromOf(source, Object.keys(from.states)));
}

function configFromOf(source: ConfigSource, entities: Iterable<string>): ConfigFrom {
  const shown = (state: EntityState | undefined): Shown | undefined => state === undefined ? undefined : { state: state.state, attributes: state.attributes };
  return { rooms: source.rooms, labels: source.labels, timezone: source.timezone,
    states: Object.fromEntries([...entities].map(entity => [entity, shown(source.states[entity])])) };
}

/** Whether the config, as last read `from`, is read from `entity`. */
export function readsConfig(from: ConfigFrom, entity: string): boolean {
  return Object.hasOwn(from.states, entity);
}

/** The config and the profiles read from `source`, and what they were read from. */
export function readConfig(source: ConfigSource, catalog: Catalog): { read: ConfigRead; from: ConfigFrom } {
  const looked = new Set<string>();
  const states = new Proxy(source.states, {
    get(target, key, receiver) {
      if (typeof key === 'string') looked.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  const recording: ConfigSource = { ...source, states }, config = decodeConfig(recording, catalog);
  const lampProfiles: Record<LampId, Record<Block, LampProfile>> = Object.fromEntries(entriesOf(config.lamps).map(([lamp]) =>
    [lamp, lampProfilesOf(recording, lamp)]));
  const switchProfiles: Record<SwitchId, Record<Block, SwitchProfile>> = Object.fromEntries(entriesOf(config.switches).map(([plug]) =>
    [plug, switchProfilesOf(recording, plug)]));
  return { read: { config, lampProfiles, switchProfiles }, from: configFromOf(source, looked) };
}

/**
 * A lamp's saved profile for each block, from `input_text.ls_lamp_<object>_<block>`,
 * the object being the lamp's entity id after its domain (`ls_base`'s
 * `L.split('.')[1]`). A store that is missing or holds no state reads as its
 * default, as garbage does.
 */
function lampProfilesOf(source: ConfigSource, lamp: LampId): Record<Block, LampProfile> {
  const profile = (block: Block) => {
    const store = source.states[profileStore(lamp, block)];
    return store === undefined ? FOLLOWS_ROOM : decodeLampProfile(store.state);
  };
  const [day, cosy, night] = BLOCKS;
  return { day: profile(day), cosy: profile(cosy), night: profile(night) };
}

/** The store's entity: the object is the entity id after its domain (`ls_base`'s `L.split('.')[1]`). */
export function profileStore(entity: LampId | SwitchId, block: Block): string {
  const object = entity.includes('.') ? entity.slice(entity.indexOf('.') + 1) : entity;
  return `input_text.ls_lamp_${object}_${block}`;
}

/** A plug's own on/off for each block, from the store a lamp's profile lives in (`ls_lamp_<object>_<block>`). */
function switchProfilesOf(source: ConfigSource, plug: SwitchId): Record<Block, SwitchProfile> {
  const profile = (block: Block) => {
    const store = source.states[profileStore(plug, block)];
    return store === undefined ? FOLLOWS_ROOM_SWITCH : decodeSwitchProfile(store.state);
  };
  const [day, cosy, night] = BLOCKS;
  return { day: profile(day), cosy: profile(cosy), night: profile(night) };
}

/**
 * Whether anything the room's power toggle switches reports on: its lamps,
 * and its switches with a range rule (today's toggle `targets`). A power
 * burst read from the helpers keeps it, as a press keeps what it reported.
 */
export function reportsOn(source: ConfigSource, config: Config, switchRanges: Model['switchRanges'], room: RoomId): boolean {
  const on = (entity: LampId | SwitchId) => source.states[entity]?.state === 'on';
  return entriesOf(config.lamps).some(([lamp, placed]) => placed.room === room && on(lamp))
    || entriesOf(switchRanges).some(([plug]) => config.switches[plug]?.room === room && on(plug));
}

/** What a decoder reads of an entity: its state and attributes; Home Assistant's stamps and context are not the config. */
type Shown = Pick<EntityState, 'state' | 'attributes'>;

/** The house as the config is read from it: the states, the rooms, the labels and the timezone. */
export function configSource(house: Pick<HouseView, 'state' | 'rooms' | 'labels' | 'timezone'>): ConfigSource {
  return { states: house.state, rooms: house.rooms, labels: house.labels === undefined ? {} : house.labels, timezone: house.timezone };
}

export function decodeModel(source: ConfigSource, catalog: Catalog): Model {
  return decodeModelFrom(source, catalog).model;
}

/**
 * The Model with its overlays as the overrides sensor holds them, while some room is the old scripts': they commit the
 * house's events, which reach the port's rooms too (a hold over the house holds each room), so the store is the truth.
 * The port's own writes still on their way are in the house it reads. The whole house keeps the Model it holds.
 */
export function followingSensor(model: Model, house: Pick<HouseView, 'state' | 'catalog'>, share: Share): Model {
  if (share.kind === 'house') return model;
  return { ...model, ...decodeOverrides(house.state['sensor.ls_overrides']?.attributes, storeKeys(house.catalog)) };
}
