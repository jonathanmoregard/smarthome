/**
 * Overlay resets: what ends the overlays. The config's three rules (the next
 * block, an age limit, a set time each day), the dashboard's clear-all and a
 * room's reset from its remote. They act on every kind of overlay at once, so
 * the overlays are listed here as one record, and each reset takes and gives
 * back whatever holds them (the Model does).
 */
import type { BlockOverlays } from './block-overlays.ts';
import type { Config } from './config.ts';
import type { LampOverlay } from './lamp-overlays.ts';
import type { ModeOverlay } from './mode.ts';
import type { RemoteOverlay } from './remote.ts';
import type { RoomPower } from './room-power.ts';
import { blockPosition, lastTimeOfDay, nextTimeOfDay } from './schedule.ts';
import type { BlockPosition } from './schedule.ts';
import type { SwitchOverlays } from './switches.ts';
import type { LampOrRoom, RoomId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import { instantOrThrow } from './types/range.ts';
import type { Instant } from './types/time.ts';

/**
 * The overlays: what people, remotes and the dashboard hold over the schedule,
 * until an overlay reset removes them. Every field is one today's overlay flow
 * reads; the comments name the stored field it comes from.
 */
export type Overlays = {
  /** A block held over a room or the house: at most one each. */
  blocks: BlockOverlays;
  /** Each remote's input for its room. Only the newest one per room applies. */
  remotes: readonly RemoteOverlay[];
  /** A light or the candle set on a lamp or a room by a person or from the dashboard. */
  lamps: readonly LampOverlay[];
  /** A room switched off or on. A room not listed is on. Not an overlay: no reset ends it, but it is stored with them. */
  roomPower: RoomPower;
  /** A switch held on or off by a press on its own button: at most one each (decision 8). */
  switches: SwitchOverlays;
};

/** What the resets read and end: the config's rules, every overlay and the mode overlay. The Model is one. */
export type Overlaid = { config: Config; overlays: Overlays; modeOverlay: ModeOverlay };

/**
 * The dashboard's clear: every overlay goes, the mode overlay and the switch
 * overlays included (today's `clear_all` empties the stored overlays). A
 * room's saved power is not an overlay, and stays.
 */
export function clearAll<M extends Overlaid>(model: M): M {
  return {
    ...model,
    overlays: { blocks: {}, remotes: [], lamps: [], roomPower: model.overlays.roomPower, switches: {} },
    modeOverlay: { active: false },
  };
}

/**
 * A room's reset (today's `clear_room`): its block, its remotes' overlays, the
 * overlays over it and over its lamps, and the switch overlays of its
 * switches. Another room's overlays, house-wide ones and its saved power stay.
 */
export function clearRoom<M extends Overlaid>(model: M, room: RoomId): M {
  const { config, overlays } = model;
  const blocks = { ...overlays.blocks };
  delete blocks[room];
  const switches = { ...overlays.switches };
  for (const [id, placed] of entriesOf(config.switches)) if (placed.room === room) delete switches[id];
  return {
    ...model,
    overlays: {
      ...overlays,
      blocks,
      remotes: overlays.remotes.filter(remote => remote.room !== room),
      lamps: overlays.lamps.filter(overlay => overlay.over.kind === 'room'
        ? overlay.over.room !== room : config.lamps[overlay.over.lamp]?.room !== room),
      switches,
    },
  };
}

/**
 * The overlays an after-age or at-set-time reset removes at this instant,
 * moved from `endOverrides` in `src/handlers/automations.ts` and
 * `expiredOverlays` in `src/legacy/domain/overlay-resets.ts`.
 *
 * After an age: every overlay at least that old (today's `>=`). At the set
 * time: every overlay set before the time last came round, which at that time
 * is every overlay (today's `clear_all`). A clock that arrives late still
 * finds them; today a reset time missed while Home Assistant was down never
 * fires. With both rules off nothing is removed.
 */
export function resetsDue<M extends Overlaid>(model: M, now: Instant): M {
  const { overlayReset, timezone } = model.config;
  const age = overlayReset.afterAge;
  const dailyAt = overlayReset.atSetTime === undefined ? undefined : lastTimeOfDay(now, overlayReset.atSetTime, timezone);
  if (age === undefined && dailyAt === undefined) return model;
  const due = (since: Instant) => (age !== undefined && now - since >= age * 60) || (dailyAt !== undefined && since < dailyAt);
  const { overlays, modeOverlay } = model;
  const blocks: Overlays['blocks'] = Object.fromEntries(Object.entries(overlays.blocks)
    .flatMap(([scope, overlay]) => overlay === undefined || due(overlay.since) ? [] : [[scope, overlay]]));
  const switches = { ...overlays.switches };
  for (const [id, overlay] of entriesOf(overlays.switches)) if (overlay !== undefined && due(overlay.since)) delete switches[id];
  return {
    ...model,
    overlays: {
      ...overlays,
      blocks,
      remotes: overlays.remotes.filter(remote => !due(remote.since)),
      lamps: overlays.lamps.filter(overlay => !due(overlay.since)),
      switches,
    },
    modeOverlay: modeOverlay.active && due(modeOverlay.since) ? { active: false } : modeOverlay,
  };
}

/**
 * The overlays the next-block reset has released, removed once the fade that
 * released them is over: today's stale-key clear, which took an overlay out of
 * the store when it was set at or before its scope's last fade start and the
 * scope was not fading. Inside the fade a lamp still fades out of what held
 * it, so the overlay stays until the block the fade led into has started
 * (its fade start included, where the fade has not moved yet). A lamp's overlay is measured on its
 * room (the house's, for a lamp in no room), a block or room overlay on its
 * own scope, a remote's on its room, a switch's on its room as the range rule
 * reads it, and the mode overlay on every room outside the private ones. With
 * the next-block rule off nothing is removed.
 */
export function releasedAtNextBlock<M extends Overlaid>(model: M, now: Instant): M {
  const { config, overlays, modeOverlay } = model;
  if (!config.overlayReset.atNextBlock) return model;
  const placed = (room: RoomId | undefined) => room !== undefined && config.rooms[room] !== undefined ? room : undefined;
  const released = (room: RoomId | undefined, since: Instant) => {
    const position = blockPosition(config, placed(room), now);
    const fadeStart = position.lastFadeStart, started = position.currentSince;
    return fadeStart !== undefined && since <= fadeStart && started !== undefined && started >= fadeStart;
  };
  const lampRoom = (over: LampOrRoom) => over.kind === 'room' ? over.room : config.lamps[over.lamp]?.room;
  // A block over a room the config does not hold is measured on the house, as `blockPosition` reads such a room.
  const roomNamed = (scope: string) => entriesOf(config.rooms).find(([room]) => room === scope)?.[0];
  const blocks: Overlays['blocks'] = Object.fromEntries(Object.entries(overlays.blocks).flatMap(([scope, overlay]) =>
    overlay === undefined || released(roomNamed(scope), overlay.since) ? [] : [[scope, overlay]]));
  const switches = { ...overlays.switches };
  for (const [id, overlay] of entriesOf(overlays.switches)) {
    if (overlay !== undefined && released(config.switches[id]?.room, overlay.since)) delete switches[id];
  }
  const shared = entriesOf(config.rooms).flatMap(([room, placedRoom]) => placedRoom.private ? [] : [room]);
  const modeReleased = modeOverlay.active && shared.length > 0 && shared.every(room => released(room, modeOverlay.since));
  return {
    ...model,
    overlays: {
      ...overlays,
      blocks,
      remotes: overlays.remotes.filter(remote => !released(remote.room, remote.since)),
      lamps: overlays.lamps.filter(overlay => !released(lampRoom(overlay.over), overlay.since)),
      switches,
    },
    modeOverlay: modeReleased ? { active: false } : modeOverlay,
  };
}

/** When an overlay reset next falls due: each overlay's age limit, and the daily reset time. */
export function resetTimes(model: Overlaid, now: Instant): Instant[] {
  const { config } = model;
  const times: Instant[] = [];
  const age = config.overlayReset.afterAge;
  if (age !== undefined) for (const since of overlaySinces(model)) times.push(instantOrThrow(since + age * 60));
  const daily = config.overlayReset.atSetTime;
  if (daily !== undefined) times.push(nextTimeOfDay(now, daily, config.timezone));
  return times;
}

/** When each overlay was set: what the age limit measures. */
function overlaySinces(model: Overlaid): Instant[] {
  const { overlays, modeOverlay } = model;
  return [
    ...Object.values(overlays.blocks).flatMap(overlay => overlay === undefined ? [] : [overlay.since]),
    ...overlays.remotes.map(remote => remote.since),
    ...overlays.lamps.map(overlay => overlay.since),
    ...Object.values(overlays.switches).flatMap(overlay => overlay === undefined ? [] : [overlay.since]),
    ...(modeOverlay.active ? [modeOverlay.since] : []),
  ];
}

/** The dashboard's clear. */
export type ClearAll = { kind: 'clear all' };

/**
 * Inside a room's blocks at `position`: whether the next-block reset, when its
 * rule is on, has released an overlay set at `since`, which it does to what
 * was set at or before the last fade start (none in reach: nothing is released).
 */
export function nextBlockReleases(config: Config, position: BlockPosition): (since: Instant) => boolean {
  const lastFadeStart = position.lastFadeStart;
  return since => config.overlayReset.atNextBlock && lastFadeStart !== undefined && since <= lastFadeStart;
}
