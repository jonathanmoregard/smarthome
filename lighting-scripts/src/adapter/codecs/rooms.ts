import type { RemoteId, RoomId } from '../../domain/types/ids.ts';
import { toRemoteId, toRoomId } from './ids.ts';

/**
 * Which room the Home Assistant registry puts each thing in, parsed once from
 * the snapshot's area map by {@link parseRooms}.
 */
export interface Rooms {
  /** Each remote's room: the room of the remote's device. */
  readonly ofRemote: Readonly<Record<RemoteId, RoomId>>;
  /**
   * The room of every entity and device the registry places, by its Home
   * Assistant id. Its readers look up lists that mix lamps, bulbs, on/off
   * lights and switches in one (a switch range can be set on an on/off light),
   * so the key stays the registry's own id until those lists are split.
   */
  readonly ofId: Readonly<Record<string, RoomId>>;
}

/**
 * The snapshot's area map, parsed: the registry's rooms by the kind of thing
 * placed in them. This is the step that turns the registry's area ids into
 * rooms, so it may brand them.
 *
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
