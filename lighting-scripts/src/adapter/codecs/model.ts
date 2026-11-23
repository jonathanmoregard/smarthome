/**
 * The whole Model read from Home Assistant: the config from the helpers and
 * the catalog, the overlays and saved ranges from the overrides sensor, each
 * remote's gesture state from its room's helpers, and each lamp's saved
 * profile for each block from its store, and each plug's own on/off for
 * each block from the same kind of store.
 */
import { BLOCKS } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type { LampProfile, Model, RemoteModel, SwitchProfile } from '../../domain/model.ts';
import type { LampId, RemoteId, SwitchId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Catalog } from '../../runtime/catalog.ts';
import { decodeConfig } from './config.ts';
import type { ConfigSource } from './config.ts';
import { FOLLOWS_ROOM, decodeLampProfile } from './lamp-profiles.ts';
import { remoteSources } from './overlay-key.ts';
import { decodeOverrides } from './overrides-sensor.ts';
import { IDLE_REMOTE, decodeRemoteModel } from './remote-helpers.ts';
import { FOLLOWS_ROOM_SWITCH, decodeSwitchProfile } from './switch-profiles.ts';

export function decodeModel(source: ConfigSource, catalog: Catalog): Model {
  const config = decodeConfig(source, catalog);
  const overrides = decodeOverrides(source.states['sensor.ls_overrides']?.attributes, remoteSources(catalog));
  const remotes: Record<RemoteId, RemoteModel> = Object.fromEntries(entriesOf(config.remotes).map(([remote, { room }]) =>
    [remote, room === undefined ? IDLE_REMOTE : decodeRemoteModel(source, room)]));
  const lampProfiles: Record<LampId, Record<Block, LampProfile>> = Object.fromEntries(entriesOf(config.lamps).map(([lamp]) =>
    [lamp, lampProfilesOf(source, lamp)]));
  const switchProfiles: Record<SwitchId, Record<Block, SwitchProfile>> = Object.fromEntries(entriesOf(config.switches).map(([plug]) =>
    [plug, switchProfilesOf(source, plug)]));
  return { config, ...overrides, remotes, lampProfiles, switchProfiles };
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

/** A plug's own on/off for each block, from the store a lamp's profile lives in (`ls_lamp_<object>_<block>`). */
function switchProfilesOf(source: ConfigSource, plug: SwitchId): Record<Block, SwitchProfile> {
  const profile = (block: Block) => {
    const store = source.states[profileStore(plug, block)];
    return store === undefined ? FOLLOWS_ROOM_SWITCH : decodeSwitchProfile(store.state);
  };
  const [day, cosy, night] = BLOCKS;
  return { day: profile(day), cosy: profile(cosy), night: profile(night) };
}

/** The store's entity: the object is the entity id after its domain (`ls_base`'s `L.split('.')[1]`). */
function profileStore(entity: LampId | SwitchId, block: Block): string {
  const object = entity.includes('.') ? entity.slice(entity.indexOf('.') + 1) : entity;
  return `input_text.ls_lamp_${object}_${block}`;
}
