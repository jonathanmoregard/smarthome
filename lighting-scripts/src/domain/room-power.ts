/**
 * Room power: a room switched off or on, by a room control on the dashboard,
 * the remote's power toggle, or a person's or a control's switch-on. A room
 * not listed is on. Not an overlay: no overlay reset ends it.
 */
import type { RoomId } from './types/ids.ts';
import type { Power } from './types/light.ts';

/** Each room switched off or on. A room not listed is on. */
export type RoomPower = Partial<Record<RoomId, Power>>;

/** The rooms switched on, each of them (a person's light switches on the rooms of the lamps it reaches). */
export function roomsOn(roomPower: RoomPower, rooms: readonly RoomId[]): RoomPower {
  const on = { ...roomPower };
  for (const room of rooms) on[room] = 'on';
  return on;
}

/**
 * The remote's power toggle: the room switched to the opposite of its saved
 * power, or, with none saved, of whether anything in it reports on (`anyOn`,
 * what Home Assistant says its lamps and range-rule switches are, as today).
 * Not the lighting state: a room switched off at the wall shows its schedule's
 * light there, but reports off, and the toggle switches it on.
 */
export function roomPowerToggled(roomPower: RoomPower, room: RoomId, anyOn: boolean): RoomPower {
  const saved = roomPower[room];
  const power: Power = saved !== undefined ? (saved === 'on' ? 'off' : 'on') : anyOn ? 'off' : 'on';
  return roomPowerSet(roomPower, room, power);
}

/** A room switched off or on from the dashboard (today's `power` op). */
export function roomPowerSet(roomPower: RoomPower, room: RoomId, power: Power): RoomPower {
  return { ...roomPower, [room]: power };
}

/** Whether a lamp's room is switched off, which switches the lamp off at once. A lamp in no room never is. */
export function switchedOff(roomPower: RoomPower, room: RoomId | undefined): boolean {
  return room !== undefined && roomPower[room] === 'off';
}

/** A room's power from a room control on the dashboard. */
export type RoomPowerRequested = { kind: 'room power'; room: RoomId; power: Power };
