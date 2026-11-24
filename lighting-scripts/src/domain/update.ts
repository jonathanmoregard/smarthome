/**
 * The Model, its messages and `update` (Elm's Model, Msg and update): the
 * composition root. The Model is a record of each concept's slices, the Msg
 * the union of each concept's messages, and `update` takes each message to
 * its concept's update. Total and pure: every message gives a Model, and
 * nothing is read but the two arguments.
 *
 * The concepts: the remote (`./remote.ts`), lamp overlays
 * (`./lamp-overlays.ts`), block overlays (`./block-overlays.ts`), the mode
 * overlay (`./mode.ts`), room power (`./room-power.ts`), switches and their
 * range rules (`./switches.ts`), lamp and plug profiles (`./profiles.ts`), the
 * overlay resets (`./overlay-resets.ts`) and plant lights with their overrides
 * (`./plant-lights.ts`). The lighting state
 * (`./lighting-state.ts`) is derived from the Model; a person's change and a
 * dashboard control read it here, for the level a step moves from and what
 * the normal light pins.
 */
import type { BlockHeld } from './block-overlays.ts';
import { holdBlock } from './block-overlays.ts';
import type { Config } from './config.ts';
import { dashboardControlSet, personChanged } from './lamp-overlays.ts';
import type { DashboardControlSet, LampChangedByPerson, Pinned } from './lamp-overlays.ts';
import { lightingState, pinnedLight, roomOverlays } from './lighting-state.ts';
import { modeSet } from './mode.ts';
import type { ModeOverlay, ModeToggled } from './mode.ts';
import { clearAll, clearRoom, releasedAtNextBlock, resetsDue, resetTimes } from './overlay-resets.ts';
import type { ClearAll, Overlays } from './overlay-resets.ts';
import { plantChanges, plantLightSwitched, plantOverridesReleased, plantsAllOffSet } from './plant-lights.ts';
import type { PlantOverrides, PlantsAllOffSet } from './plant-lights.ts';
import { lampProfileSaved, switchProfileSaved } from './profiles.ts';
import type { LampProfiles, LampProfileSaved, SwitchProfiles, SwitchProfileSaved } from './profiles.ts';
import { buttonPressed, remoteState, remoteSteered, windowDeadlines, windowsClosed } from './remote.ts';
import type { RemoteButtonPressed, RemoteCommand, RemoteModel, RemotePressed } from './remote.ts';
import { roomPowerSet, roomPowerToggled } from './room-power.ts';
import type { RoomPowerRequested } from './room-power.ts';
import { blockPosition, scheduleChanges } from './schedule.ts';
import { rangeSaved, switchButtonPressed } from './switches.ts';
import type { RangeDefaults, RangeDefaultsSaved, RangeRules, RangeSaved, SwitchButtonPressed } from './switches.ts';
import type { LampOrRoom, RemoteId, RoomId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import { instantOrThrow } from './types/range.ts';
import type { Instant } from './types/time.ts';

/**
 * Everything the lighting state is derived from: the config, the overlays and
 * the saved settings people make from the dashboard and remotes (Elm's Model).
 */
export type Model = {
  config: Config;
  overlays: Overlays;
  modeOverlay: ModeOverlay;
  remotes: Record<RemoteId, RemoteModel>;
  switchRanges: RangeRules;
  /** Saved from the dashboard's range helpers at run time, so Model, not Config. */
  rangeDefaults: RangeDefaults;
  lampProfiles: LampProfiles;
  switchProfiles: SwitchProfiles;
  plantOverrides: PlantOverrides;
};

/**
 * The next instant the Model or the lighting state changes by itself, when the
 * adapter sends the clock (Elm's subscriptions): the schedule's next move, the
 * next overlay reset falling due (an overlay's age limit, the daily reset
 * time), a remote's chord or power burst closing its window (a burst of one
 * press then toggles its room), or a plant light's day start or timer
 * switch-off. Undefined when nothing is coming.
 */
export function nextChange(model: Model, now: Instant): Instant | undefined {
  const times = [...scheduleChanges(model.config, now), ...resetTimes(model, now), ...windowDeadlines(model.remotes), ...plantChanges(model.config, now)];
  const coming = times.filter(time => time > now);
  return coming.length === 0 ? undefined : instantOrThrow(Math.min(...coming));
}

/**
 * The chords and power bursts whose window closed by `now`, closed: a chord
 * is dropped; a burst of one press toggles its room's power, of three resets
 * the room. The clock closes them; a press closes its own remote's first.
 */
function remoteTimeouts(model: Model, now: Instant): Model {
  return entriesOf(model.remotes).reduce((closed, [remote]) => windowClosed(closed, remote, closed.config.remotes[remote]?.room, now), model);
}

/** One remote's chord and burst, closed where their window has. A burst of one or three acts only for a remote in a room. */
function windowClosed(model: Model, remote: RemoteId, room: RoomId | undefined, now: Instant): Model {
  const before = remoteState(model.remotes, remote);
  const { state, burst } = windowsClosed(before, now);
  const closed = gesturesSaved(model, remote, before, state);
  if (burst === undefined || room === undefined) return closed;
  return burst.kind === 'toggle' ? withOverlays(closed, { roomPower: roomPowerToggled(closed.overlays.roomPower, room, burst.anyOn) })
    : clearRoom(closed, room);
}

/** A remote's gesture state saved where the gestures changed it: a remote nobody has pressed keeps no entry. */
function gesturesSaved(model: Model, remote: RemoteId, before: RemoteModel, after: RemoteModel): Model {
  return after === before ? model : { ...model, remotes: { ...model.remotes, [remote]: after } };
}

function withOverlays(model: Model, changed: Partial<Overlays>): Model {
  return { ...model, overlays: { ...model.overlays, ...changed } };
}

/** What the normal light pins on a lamp or a room, as the lighting state shows it at `now`. */
function pinnedAt(model: Model, now: Instant): (over: LampOrRoom) => Pinned | undefined {
  return over => pinnedLight(model, over, now);
}

/**
 * A command a remote sends for its room (from its gestures, or another
 * caller). A remote with no room does nothing.
 */
function remotePressed(model: Model, pressed: RemotePressed): Model {
  const room = model.config.remotes[pressed.remote]?.room;
  if (room === undefined) return model;
  return roomCommand(model, pressed.remote, room, pressed.command, pressed.anyOn, pressed.at);
}

/**
 * A remote's command, to what it changes: the toggle to the room's power
 * (against what the room reports, `anyOn`), the reset to the room's overlays,
 * the mode press to the mode overlay, and brighter, dimmer, left and right to
 * the remote's overlay, which reads the room's carried overlay and held block
 * from the lighting state.
 */
function roomCommand(model: Model, remote: RemoteId, room: RoomId, command: RemoteCommand, anyOn: boolean, now: Instant): Model {
  switch (command) {
    case 'toggle': return withOverlays(model, { roomPower: roomPowerToggled(model.overlays.roomPower, room, anyOn) });
    case 'reset': return clearRoom(model, room);
    case 'mode': return { ...model, modeOverlay: modeSet(model.modeOverlay, !model.modeOverlay.active, now) };
    case 'up': case 'down': case 'left': case 'right': {
      const onRoom = roomOverlays(model, room, now);
      const at = { room, carried: onRoom.remote, held: onRoom.block, scheduled: blockPosition(model.config, room, now).current };
      return withOverlays(model, { remotes: remoteSteered(model.overlays, at, remote, command, now) });
    }
  }
}

/**
 * A button pressed on a remote. The windows of this remote that closed before
 * the press are closed first, as today's timers would have, then the press
 * goes through the gestures, and the command they give goes to the room. A
 * remote with no room does nothing.
 */
function remoteButtonPressed(model: Model, pressed: RemoteButtonPressed): Model {
  const room = model.config.remotes[pressed.remote]?.room;
  if (room === undefined) return model;
  const caught = windowClosed(model, pressed.remote, room, pressed.at);
  const before = remoteState(caught.remotes, pressed.remote);
  const gestured = buttonPressed(before, pressed.button, pressed.anyOn, pressed.at);
  const turned = gesturesSaved(caught, pressed.remote, before, gestured.state);
  return gestured.command === undefined ? turned : roomCommand(turned, pressed.remote, room, gestured.command, pressed.anyOn, pressed.at);
}

/**
 * Everything that can happen to the Model (Elm's Msg). `at` is when the input
 * arrived: what every overlay it sets is stamped with. The clock's `now` is
 * the instant it reads.
 */
export type Msg =
  | { kind: 'clock'; now: Instant }
  /** The config and the saved profiles read again from the helpers: they replace the Model's; the overlays and the remotes stay. */
  | { kind: 'configChanged'; config: Config; lampProfiles: LampProfiles; switchProfiles: SwitchProfiles; at: Instant }
  | { kind: 'overlayRequested'; request: OverlayRequest; at: Instant }
  | LampChangedByPerson
  | RemotePressed
  | RemoteButtonPressed
  | SwitchButtonPressed
  | ModeToggled
  | RangeSaved
  | RangeDefaultsSaved
  | LampProfileSaved
  | SwitchProfileSaved
  | PlantsAllOffSet;

/** An overlay asked for from the dashboard. */
export type OverlayRequest = BlockHeld | ClearAll | DashboardControlSet | RoomPowerRequested;

/**
 * `update(model, msg)`: everything that can happen to the Model, one case per
 * message, each calling its concept's update.
 *
 * The clock removes the overlays a reset makes due and those the next-block
 * reset released, then closes the remotes' chords and power bursts whose
 * window has closed, and drops the plant overrides that no longer apply.
 */
export function update(model: Model, msg: Msg): Model {
  switch (msg.kind) {
    case 'clock': {
      const released = remoteTimeouts(releasedAtNextBlock(resetsDue(model, msg.now), msg.now), msg.now);
      return { ...released, plantOverrides: plantOverridesReleased(released.plantOverrides, released.config, msg.now) };
    }
    case 'configChanged': return { ...model, config: msg.config, lampProfiles: msg.lampProfiles, switchProfiles: msg.switchProfiles };
    case 'overlayRequested': return overlayRequested(model, msg.request, msg.at);
    case 'lampChangedByPerson': {
      const shown = { lamps: lightingState(model, msg.at).lamps, pinned: pinnedAt(model, msg.at) };
      return withOverlays(model, personChanged(model.overlays, model.config, shown, msg));
    }
    case 'remotePressed': return remotePressed(model, msg);
    case 'remoteButtonPressed': return remoteButtonPressed(model, msg);
    case 'switchButtonPressed':
      return model.config.switches[msg.switch]?.kind === 'plant light'
        ? { ...model, plantOverrides: plantLightSwitched(model.plantOverrides, model.config, msg) }
        : withOverlays(model, { switches: switchButtonPressed(model.overlays.switches, model.config, msg) });
    case 'modeToggled': return { ...model, modeOverlay: modeSet(model.modeOverlay, msg.on, msg.at) };
    case 'rangeSaved': return { ...model, ...rangeSaved(model.config, model.switchRanges, msg) };
    case 'rangeDefaultsSaved': return { ...model, rangeDefaults: msg.defaults };
    case 'lampProfileSaved': return { ...model, lampProfiles: lampProfileSaved(model.lampProfiles, msg) };
    case 'switchProfileSaved': return { ...model, switchProfiles: switchProfileSaved(model.switchProfiles, msg) };
    case 'plantsAllOffSet': return { ...model, plantOverrides: plantsAllOffSet(model.plantOverrides, msg) };
  }
}

function overlayRequested(model: Model, request: OverlayRequest, at: Instant): Model {
  switch (request.kind) {
    case 'hold block': return withOverlays(model, { blocks: holdBlock(model.overlays.blocks, model.config, request, at) });
    case 'clear all': return clearAll(model);
    case 'dashboard control': return withOverlays(model, dashboardControlSet(model.overlays, model.config, pinnedAt(model, at), request, at));
    case 'room power': return withOverlays(model, { roomPower: roomPowerSet(model.overlays.roomPower, request.room, request.power) });
  }
}
