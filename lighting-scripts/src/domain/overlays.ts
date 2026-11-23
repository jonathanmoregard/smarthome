import type { Config } from './config.ts';
import type { Model, Overlays } from './model.ts';
import { blockPosition, lastTimeOfDay } from './schedule.ts';
import type { LampOrRoom, RoomId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Power } from './types/light.ts';
import type { Block, RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

export type {
  Overlays, SwitchOverlay, BlockOverlay, RemoteOverlay, StepRange, RemoteAdjustment, PresetChoice, RemotePreset, HeldBlock, RememberedPreset,
  LampOverlay, LampOverlayFrom, BrightnessOverlay, ColourOverlay, EffectOverlay, BrightnessPart, ColourPart, EffectPart, ModeOverlay,
} from './model.ts';

/**
 * A block held over a room or the house, moved from `planOverrideBlock` and
 * `houseRooms` in `src/legacy/domain/state-store.ts`. Over the house it is
 * also held over each room a lamp or an on/off switch is in, the private rooms
 * left out. Each target already scheduled to the block has its hold cleared
 * instead.
 */
export function holdBlock(model: Model, over: RoomOrHouse, block: Block, now: Instant): Model {
  const config = model.config;
  const targets: RoomOrHouse[] = over === 'house' ? ['house', ...houseRooms(config)] : [over];
  const blocks = { ...model.overlays.blocks };
  for (const target of targets) {
    if (blockPosition(config, target === 'house' ? undefined : target, now).current === block) delete blocks[target];
    else blocks[target] = { block, since: now };
  }
  return { ...model, overlays: { ...model.overlays, blocks } };
}
/**
 * The rooms a hold over the house reaches: each room a lamp or an on/off
 * switch is in, once, leaving out the private ones and the ones the config does not hold.
 */
function houseRooms(config: Config): RoomId[] {
  const placed = [
    ...Object.values(config.lamps).map(lamp => lamp.room),
    ...Object.values(config.switches).flatMap(placedSwitch => placedSwitch.onOff ? [placedSwitch.room] : []),
  ];
  const rooms = placed.flatMap(room => room !== undefined && config.rooms[room] !== undefined && !config.rooms[room].private ? [room] : []);
  return [...new Set(rooms)];
}

/**
 * The dashboard's clear: every overlay goes, the mode overlay and the switch
 * overlays included (today's `clear_all` empties the stored overlays). A
 * room's saved power is not an overlay, and stays.
 */
export function clearAll(model: Model): Model {
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
export function clearRoom(model: Model, room: RoomId): Model {
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
export function resetsDue(model: Model, now: Instant): Model {
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
export function releasedAtNextBlock(model: Model, now: Instant): Model {
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

/** The mode overlay switched on or off (today's mode switch); switching it on again keeps when it started. */
export function setModeOverlay(model: Model, on: boolean, now: Instant): Model {
  if (on === model.modeOverlay.active) return model;
  return { ...model, modeOverlay: on ? { active: true, since: now } : { active: false } };
}

/** A room switched off or on from the dashboard (today's `power` op). */
export function setRoomPower(model: Model, room: RoomId, power: Power): Model {
  return { ...model, overlays: { ...model.overlays, roomPower: { ...model.overlays.roomPower, [room]: power } } };
}
