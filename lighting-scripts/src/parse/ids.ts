/**
 * The id constructors: the only place a wire string becomes a domain id.
 *
 * Only the parse steps call them (`src/parse/*.ts` and `parseCatalog`). They
 * check nothing and return their input unchanged: whatever the parse step
 * already checked about the string still holds, and nothing is added. Whether
 * an id names something the registry knows is a later, named unit.
 */
import type { BulbId, EffectName, LampId, OverlayKey, RemoteId, RoomId, SwitchId, UserId } from '../domain/types/ids.ts';

export function toRoomId(raw: string): RoomId {
  // Cast: the edge read this string as a room; this is the one place that says so.
  return raw as RoomId;
}

export function toLampId(raw: string): LampId {
  // Cast: the edge read this string as a lamp; this is the one place that says so.
  return raw as LampId;
}

export function toBulbId(raw: string): BulbId {
  // Cast: the edge read this string as a bulb; this is the one place that says so.
  return raw as BulbId;
}

export function toSwitchId(raw: string): SwitchId {
  // Cast: the edge read this string as a switch; this is the one place that says so.
  return raw as SwitchId;
}

export function toRemoteId(raw: string): RemoteId {
  // Cast: the edge read this string as a remote; this is the one place that says so.
  return raw as RemoteId;
}

export function toOverlayKey(raw: string): OverlayKey {
  // Cast: the edge read this string as an overlay key; this is the one place that says so.
  return raw as OverlayKey;
}

export function toUserId(raw: string): UserId {
  // Cast: the edge read this string as a user; this is the one place that says so.
  return raw as UserId;
}

export function toEffectName(raw: string): EffectName {
  // Cast: the edge read this string as a catalog effect; this is the one place that says so.
  return raw as EffectName;
}
