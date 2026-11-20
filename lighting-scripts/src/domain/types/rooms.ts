import type { RemoteId, RoomId } from './ids.ts';

/**
 * Which room the Home Assistant registry puts each thing in, parsed once from
 * the snapshot's area map (`src/parse/rooms.ts`).
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
