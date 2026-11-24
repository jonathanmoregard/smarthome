/**
 * The mode overlay: one colour on every lamp outside the private rooms, at any
 * block but night. The dashboard's mode switch and the remote's chord switch
 * it; an overlay reset ends it.
 */
import type { Config } from './config.ts';
import type { RoomId } from './types/ids.ts';
import type { Colour } from './types/light.ts';
import { colourChannelOrThrow } from './types/range.ts';
import type { Block } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/** The mode overlay: one colour on every lamp outside private rooms and outside the night block. */
export type ModeOverlay = { active: false } | { active: true; since: Instant };

/** The mode overlay switched on or off (today's mode switch); switching it on again keeps when it started. */
export function modeSet(mode: ModeOverlay, on: boolean, now: Instant): ModeOverlay {
  if (on === mode.active) return mode;
  return on ? { active: true, since: now } : { active: false };
}

/**
 * The mode overlay over a lamp or a room: not there (off, or a private room),
 * there, or released by the next-block reset (`released`), which a lamp fades
 * out of. A lamp in no room is outside the private rooms.
 */
export function modeOver(mode: ModeOverlay, config: Config, room: RoomId | undefined,
  released: (since: Instant) => boolean): 'none' | 'applies' | 'released' {
  const outsidePrivate = room === undefined || config.rooms[room]?.private !== true;
  if (!mode.active || !outsidePrivate) return 'none';
  return released(mode.since) ? 'released' : 'applies';
}

/** The dashboard's mode switch, switched on or off. */
export type ModeToggled = { kind: 'modeToggled'; on: boolean; at: Instant };

/** The colour the mode overlay shows on a lamp it reaches, in the block the lamp is in: its own, except at night. */
export function modeColour(applies: boolean, block: Block): Colour | undefined {
  return applies && block !== 'night' ? MODE_COLOUR : undefined;
}

/** The mode overlay's colour: today's 255, 105, 180. */
export const MODE_COLOUR: Colour = {
  kind: 'rgb', rgb: { red: colourChannelOrThrow(255), green: colourChannelOrThrow(105), blue: colourChannelOrThrow(180) },
};
