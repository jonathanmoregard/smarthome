/**
 * Ids for tests. A test builds a branded id only through these (`id.room('studio')`),
 * never by casting, so tests construct ids the way the parse steps do.
 */
import {
  toBulbId, toCatalogEffectName, toLampId, toRemoteId, toRoomId, toSwitchId, toUserId,
} from '../../../src/adapter/codecs/ids.ts';

export const id = {
  room: toRoomId,
  lamp: toLampId,
  bulb: toBulbId,
  switch: toSwitchId,
  remote: toRemoteId,
  user: toUserId,
  effect: toCatalogEffectName,
};
