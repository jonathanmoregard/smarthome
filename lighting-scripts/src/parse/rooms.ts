/**
 * The snapshot's area map, parsed: the registry's rooms by the kind of thing
 * placed in them. This is the step that turns the registry's area ids into
 * rooms, so it may brand them.
 */
import type { RemoteId, RoomId } from '../domain/types/ids.ts';
import type { Rooms } from '../adapter/codecs/rooms.ts';
import { toRemoteId, toRoomId } from './ids.ts';

/**
 * The area map holds entity ids (`light.lamp`, always with a dot) and device
 * ids (no dot) side by side. A remote is read by its device id, so the device
 * entries are its remotes' rooms.
 */
export function parseRooms(areas: Readonly<Record<string, string>>): Rooms {
  const ofId: Record<string, RoomId> = {}, ofRemote: Record<RemoteId, RoomId> = {};
  for (const [id, area] of Object.entries(areas)) {
    const room = toRoomId(area);
    ofId[id] = room;
    if (!id.includes('.')) ofRemote[toRemoteId(id)] = room;
  }
  return { ofId, ofRemote };
}

/** A room argument's text read back: `''` is no room, as the captured `default('')` and its falsy test read it. */
export function roomOfText(text: string): RoomId | undefined {
  return text === '' ? undefined : toRoomId(text);
}
