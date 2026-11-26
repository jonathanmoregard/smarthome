import type { RemoteId, RoomId } from '../../domain/types/ids.ts';
import type { EntityState } from '../ha-client.ts';
import { toRemoteId, toRoomId } from './ids.ts';

/**
 * The rooms one turn drives: the whole house, or some rooms while the old scripts drive the rest (the room-by-room
 * rollout, spec 5.4). Each room is driven by exactly one system.
 */
export type Share = { kind: 'house' } | { kind: 'rooms'; rooms: ReadonlySet<RoomId> };

/** Whether the turn drives a room; a thing in no room is driven only with the whole house. */
export function drives(share: Share, room: RoomId | undefined): boolean {
  return share.kind === 'house' || (room !== undefined && share.rooms.has(room));
}

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

/**
 * The rooms of `listed` whose port switch `input_boolean.ls_<room>_on_port` is on: a person, or Home Assistant's
 * watchdog, hands a room to the port or back there.
 */
export function portSwitchesOn(state: Readonly<Record<string, EntityState>>, listed: ReadonlySet<RoomId>): ReadonlySet<RoomId> {
  return new Set([...listed].filter(room => state[portSwitch(room)]?.state === 'on'));
}

/** The rooms of `listed` Home Assistant has no port switch for: such a room is never handed over. */
export function portSwitchesMissing(state: Readonly<Record<string, EntityState>>, listed: ReadonlySet<RoomId>): RoomId[] {
  return [...listed].filter(room => state[portSwitch(room)] === undefined);
}

/** A room's port switch, the helper that hands it to the port. */
export function portSwitch(room: RoomId): string {
  return `input_boolean.ls_${room}_on_port`;
}

/** A room argument's text read back: `''` is no room, as the captured `default('')` and its falsy test read it. */
export function roomOfText(text: string): RoomId | undefined {
  return text === '' ? undefined : toRoomId(text);
}
