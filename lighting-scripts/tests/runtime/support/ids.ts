/**
 * Ids for tests. A test builds a branded id only through these (`id.room('studio')`),
 * never by casting, so tests construct ids the way the parse steps do.
 */
import {
  toBulbId, toEffectName, toLampId, toOverlayKey, toRemoteId, toRoomId, toSwitchId, toUserId,
} from '../../../src/parse/ids.ts';

export const id = {
  room: toRoomId,
  lamp: toLampId,
  bulb: toBulbId,
  switch: toSwitchId,
  remote: toRemoteId,
  overlayKey: toOverlayKey,
  user: toUserId,
  effect: toEffectName,
};
