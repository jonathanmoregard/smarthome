/**
 * The whole Model read from Home Assistant: the config from the helpers and
 * the catalog, the overlays and saved ranges from the overrides sensor, each
 * remote's gesture state from its room's helpers, and each lamp's saved
 * profile for each block from its store.
 */
import { BLOCKS } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type { LampProfile, Model, RemoteModel } from '../../domain/model.ts';
import type { LampId, RemoteId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Catalog } from '../../runtime/catalog.ts';
import { decodeConfig } from './config.ts';
import type { ConfigSource } from './config.ts';
import { FOLLOWS_ROOM, decodeLampProfile } from './lamp-profiles.ts';
import { decodeOverrides } from './overrides-sensor.ts';
import { IDLE_REMOTE, decodeRemoteModel } from './remote-helpers.ts';

export function decodeModel(source: ConfigSource, catalog: Catalog): Model {
  const config = decodeConfig(source, catalog);
  const overrides = decodeOverrides(source.states['sensor.ls_overrides']?.attributes);
  const remotes: Record<RemoteId, RemoteModel> = Object.fromEntries(entriesOf(config.remotes).map(([remote, { room }]) =>
    [remote, room === undefined ? IDLE_REMOTE : decodeRemoteModel(source, room)]));
  const lampProfiles: Record<LampId, Record<Block, LampProfile>> = Object.fromEntries(entriesOf(config.lamps).map(([lamp]) =>
    [lamp, lampProfilesOf(source, lamp)]));
  return { config, ...overrides, remotes, lampProfiles };
}

/**
 * A lamp's saved profile for each block, from `input_text.ls_lamp_<object>_<block>`,
 * the object being the lamp's entity id after its domain (`ls_base`'s
 * `L.split('.')[1]`). A store that is missing or holds no state reads as its
 * default, as garbage does.
 */
function lampProfilesOf(source: ConfigSource, lamp: LampId): Record<Block, LampProfile> {
  const object = lamp.includes('.') ? lamp.slice(lamp.indexOf('.') + 1) : lamp;
  const profile = (block: Block) => {
    const store = source.states[`input_text.ls_lamp_${object}_${block}`];
    return store === undefined ? FOLLOWS_ROOM : decodeLampProfile(store.state);
  };
  const [day, cosy, night] = BLOCKS;
  return { day: profile(day), cosy: profile(cosy), night: profile(night) };
}
