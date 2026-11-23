/**
 * A person's change and a dashboard control, as lamp overlays.
 *
 * Moved from `planNativeControls` and `held` in
 * `src/legacy/domain/native-controls.ts`, `lampChangeOverrides` in
 * `src/handlers/automations.ts`, the channel branch of `planUIControls`, and
 * the merge `planCommit` (`src/legacy/domain/state-store.ts`) makes of the
 * channels stored under one key. What stays at the edge for M3 Task 3: which
 * lamps a call reaches and which rooms it names whole (areas, devices, labels,
 * groups), the colour a call's payload stands for (`nativeColor`), the
 * brightness a percent comes to, and the dashboard's checks of its values. A
 * brightness step is resolved here, from the level each lamp or room shows
 * (Amendment 7.2).
 */
import type { Config } from './config.ts';
import { lightingState, pinnedLight } from './lighting-state.ts';
import type { Pinned } from './lighting-state.ts';
import type { ControlLight, Model, RequestedBrightness, RequestedLight } from './model.ts';
import type { BrightnessOverlay, ColourOverlay, EffectOverlay, LampOverlay, LampOverlayFrom } from './overlays.ts';
import type { DashboardControlId, LampId, RoomId } from './types/ids.ts';
import type { Brightness } from './types/light.ts';
import type { LampOrRoom } from './types/lighting-state.ts';
import { brightnessOrThrow } from './types/range.ts';
import type { Instant } from './types/time.ts';

/** The parts one change sets, stamped; undefined leaves a part as the earlier overlay had it. */
type Parts = { brightness: BrightnessOverlay | undefined; colour: ColourOverlay | undefined; effect: EffectOverlay | undefined };

/** An overlay of parts: these parts over the earlier overlay's, which an off had none of. */
function withParts(earlier: LampOverlay | undefined, over: LampOrRoom, from: LampOverlayFrom, parts: Parts, now: Instant): LampOverlay {
  const kept = earlier !== undefined && earlier.kind === 'parts' ? earlier : undefined;
  return {
    kind: 'parts', over, from, since: now,
    brightness: parts.brightness !== undefined ? parts.brightness : kept?.brightness,
    colour: parts.colour !== undefined ? parts.colour : kept?.colour,
    effect: parts.effect !== undefined ? parts.effect : kept?.effect,
  };
}

/**
 * A person's light as parts: a fixed brightness and colour, the candle, or the
 * normal light, which pins what the call leaves at what the lamp or room shows.
 * A step moves from `shown`, the level there.
 */
function requestedParts(light: Extract<RequestedLight, { power: 'on' }>, shown: number, pinned: Pinned | undefined, now: Instant): Parts {
  const normal = light.effect !== undefined && light.effect.kind === 'normal';
  const brightness = light.brightness === undefined ? undefined : resolved(light.brightness, shown);
  return {
    brightness: brightness !== undefined ? { kind: 'fixed', brightness, at: now } : pinnedBrightness(normal, pinned, now),
    colour: light.colour !== undefined ? { kind: 'fixed', colour: light.colour, at: now } : pinnedColour(normal, pinned, now),
    effect: light.effect === undefined ? undefined : { ...light.effect, at: now },
  };
}

/** A fixed level as it is; a step from the level shown, held to 0 to 255 as Home Assistant holds it. */
function resolved(brightness: RequestedBrightness, shown: number): Brightness {
  return brightness.kind === 'fixed' ? brightness.brightness : brightnessOrThrow(Math.round(Math.min(255, Math.max(0, shown + brightness.by))));
}

/** A control's parts, stamped; the normal light pins what the control leaves, as a person's does. */
function controlParts(light: Extract<ControlLight, { power: 'on' }>, pinned: Pinned | undefined, now: Instant): Parts {
  const normal = light.effect !== undefined && light.effect.kind === 'normal';
  return {
    brightness: light.brightness !== undefined ? { ...light.brightness, at: now } : pinnedBrightness(normal, pinned, now),
    colour: light.colour !== undefined ? { ...light.colour, at: now } : pinnedColour(normal, pinned, now),
    effect: light.effect === undefined ? undefined : { ...light.effect, at: now },
  };
}

/**
 * Today's `held`: the normal light pins the level the lamp or room shows. One
 * that shows off has none, and hands the part back to the schedule. Any other
 * change leaves the part alone.
 */
function pinnedBrightness(normal: boolean, pinned: Pinned | undefined, now: Instant): BrightnessOverlay | undefined {
  if (!normal) return undefined;
  return pinned === undefined ? { kind: 'schedule', at: now } : { kind: 'fixed', brightness: pinned.brightness, at: now };
}

/**
 * The same for the colour: the one under an effect and the mode overlay
 * (today's `underlyingColour`), or the schedule's where it shows none.
 */
function pinnedColour(normal: boolean, pinned: Pinned | undefined, now: Instant): ColourOverlay | undefined {
  if (!normal) return undefined;
  return pinned === undefined || pinned.colour === undefined ? { kind: 'schedule', at: now } : { kind: 'fixed', colour: pinned.colour, at: now };
}

/**
 * A person's change in Home Assistant. Each room the call named whole (an
 * area, or a group the edge reads as the room) is one overlay over the room;
 * each lamp it reaches outside those is one over the lamp. Lamps and rooms the
 * config does not hold are left out. Each replaces the person's earlier
 * overlay there: an off replaces it whole, and a light keeps the parts the
 * earlier light set that this one leaves alone (one stored key per lamp or
 * room, whose channels `ls_commit` merges).
 *
 * A light switches the room of each lamp it reaches on; an off leaves the
 * room's power alone (owner, 2026-11-23). Any light ends an older off there,
 * and a plain switch-on (no part) does only that. The normal light pins the
 * level and colour shown, unless the call sets them, and ends a candle.
 */
export function personChanged(model: Model, lamps: readonly LampId[], rooms: readonly RoomId[], light: RequestedLight, now: Instant): Model {
  const config = model.config;
  const known = [...new Set(lamps)].filter(lamp => config.lamps[lamp] !== undefined);
  const whole = [...new Set(rooms)].filter(room => config.rooms[room] !== undefined).sort();
  const from: LampOverlayFrom = { kind: 'person' };
  const levels = lightingState(model, now).lamps;
  let overlays = model.overlays.lamps;
  for (const over of changedOver(config, known, whole)) {
    const mine = (overlay: LampOverlay) => overlay.from.kind === 'person' && sameOver(overlay.over, over);
    const first = firstLampOf(config, known, over);
    const shown = first === undefined ? undefined : levels[first];
    const level = shown === undefined || shown.power === 'off' ? 0 : shown.level;
    overlays = replaced(overlays, mine, earlier => light.power === 'off' ? { kind: 'off', over, from, since: now }
      : withParts(earlier, over, from, requestedParts(light, level, pinnedLight(model, over, now), now), now));
  }
  const roomPower = { ...model.overlays.roomPower };
  if (light.power === 'on') for (const room of roomsOf(config, known)) roomPower[room] = 'on';
  return { ...model, overlays: { ...model.overlays, lamps: overlays, roomPower } };
}

/** What a person's call is over: each room it named whole, then each lamp it reaches outside those rooms. */
function changedOver(config: Config, lamps: readonly LampId[], rooms: readonly RoomId[]): LampOrRoom[] {
  const covered = new Set(rooms);
  const single = lamps.filter(lamp => {
    const room = config.lamps[lamp]?.room;
    return room === undefined || !covered.has(room);
  });
  return [...rooms.map((room): LampOrRoom => ({ kind: 'room', room })), ...single.map((lamp): LampOrRoom => ({ kind: 'lamp', lamp }))];
}

/** The lamp a step on `over` moves from: the lamp itself, or the first lamp the call reaches in the room. */
function firstLampOf(config: Config, lamps: readonly LampId[], over: LampOrRoom): LampId | undefined {
  return over.kind === 'lamp' ? over.lamp : lamps.find(lamp => config.lamps[lamp]?.room === over.room);
}

function sameOver(a: LampOrRoom, b: LampOrRoom): boolean {
  return a.kind === 'room' ? b.kind === 'room' && a.room === b.room : b.kind === 'lamp' && a.lamp === b.lamp;
}

/** The overlays with the first one `mine` picks put back as `next` made it, in its place, or `next`'s added at the end. */
function replaced(overlays: readonly LampOverlay[], mine: (overlay: LampOverlay) => boolean,
  next: (earlier: LampOverlay | undefined) => LampOverlay): LampOverlay[] {
  const index = overlays.findIndex(mine);
  if (index === -1) return [...overlays, next(undefined)];
  return overlays.map((overlay, at) => at === index ? next(overlay) : overlay);
}

/** The rooms the lamps are in, each once. */
function roomsOf(config: Config, lamps: readonly LampId[]): RoomId[] {
  return [...new Set(lamps.flatMap(lamp => {
    const room = config.lamps[lamp]?.room;
    return room === undefined ? [] : [room];
  }))];
}

/**
 * A dashboard control's change: one overlay per control (today's key
 * `channels:ui:<control>`), replacing the control's earlier one the way a
 * person's change replaces theirs. Its power ON (no part) ends an older off
 * there and switches the room on, as a person's plain switch-on does; any
 * other change leaves the room's power alone.
 */
export function dashboardControlSet(model: Model, control: DashboardControlId, over: LampOrRoom, light: ControlLight, now: Instant): Model {
  const from: LampOverlayFrom = { kind: 'dashboard', control };
  const mine = (overlay: LampOverlay) => overlay.from.kind === 'dashboard' && overlay.from.control === control;
  const lamps = replaced(model.overlays.lamps, mine, earlier => light.power === 'off' ? { kind: 'off', over, from, since: now }
    : withParts(earlier, over, from, controlParts(light, pinnedLight(model, over, now), now), now));
  const roomPower = { ...model.overlays.roomPower };
  const room = over.kind === 'room' ? over.room : model.config.lamps[over.lamp]?.room;
  if (plainOn(light) && room !== undefined) roomPower[room] = 'on';
  return { ...model, overlays: { ...model.overlays, lamps, roomPower } };
}

/** A power ON with no part: it sets nothing but the lamp's power. */
function plainOn(light: ControlLight): boolean {
  return light.power === 'on' && light.brightness === undefined && light.colour === undefined && light.effect === undefined;
}
