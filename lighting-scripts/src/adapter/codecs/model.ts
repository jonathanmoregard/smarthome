/**
 * The whole Model read from Home Assistant: the config from the helpers and
 * the catalog, the overlays and saved ranges from the overrides sensor, each
 * remote's gesture state from its room's helpers, and each lamp's saved
 * profile for each block from its store, and each plug's own on/off for
 * each block from the same kind of store.
 */
import { BLOCKS } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type { Config } from '../../domain/config.ts';
import type { LampProfile, Model, RemoteModel, SwitchProfile } from '../../domain/model.ts';
import type { LampId, RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Catalog } from './catalog.ts';
import type { HouseView } from './house.ts';
import { decodeConfig } from './config.ts';
import type { ConfigSource } from './config.ts';
import { FOLLOWS_ROOM, decodeLampProfile } from './lamp-profiles.ts';
import { remoteSources } from './overlay-key.ts';
import { decodeOverrides } from './overrides-sensor.ts';
import type { Share } from './rooms.ts';
import { IDLE_REMOTE } from '../../domain/remote.ts';
import { decodeRemoteModel } from './remote-helpers.ts';
import { FOLLOWS_ROOM_SWITCH, decodeSwitchProfile } from './switch-profiles.ts';

/** The house as the config is read from it: the states, the rooms, the labels and the timezone. */
export function configSource(house: Pick<HouseView, 'state' | 'rooms' | 'labels' | 'timezone'>): ConfigSource {
  return { states: house.state, rooms: house.rooms, labels: house.labels === undefined ? {} : house.labels, timezone: house.timezone };
}

export function decodeModel(source: ConfigSource, catalog: Catalog): Model {
  const config = decodeConfig(source, catalog);
  const overrides = decodeOverrides(source.states['sensor.ls_overrides']?.attributes, remoteSources(catalog));
  const remotes: Record<RemoteId, RemoteModel> = Object.fromEntries(entriesOf(config.remotes).map(([remote, { room }]) =>
    [remote, room === undefined ? IDLE_REMOTE : decodeRemoteModel(source, room, reportsOn(source, config, overrides.switchRanges, room))]));
  const lampProfiles: Record<LampId, Record<Block, LampProfile>> = Object.fromEntries(entriesOf(config.lamps).map(([lamp]) =>
    [lamp, lampProfilesOf(source, lamp)]));
  const switchProfiles: Record<SwitchId, Record<Block, SwitchProfile>> = Object.fromEntries(entriesOf(config.switches).map(([plug]) =>
    [plug, switchProfilesOf(source, plug)]));
  return { config, ...overrides, remotes, lampProfiles, switchProfiles };
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
 * The Model with its overlays as the overrides sensor holds them, while some room is the old scripts': they commit the
 * house's events, which reach the port's rooms too (a hold over the house holds each room), so the store is the truth.
 * The port's own writes still on their way are in the house it reads. The whole house keeps the Model it holds.
 */
export function followingSensor(model: Model, house: Pick<HouseView, 'state' | 'catalog'>, share: Share): Model {
  if (share.kind === 'house') return model;
  return { ...model, ...decodeOverrides(house.state['sensor.ls_overrides']?.attributes, remoteSources(house.catalog)) };
}
