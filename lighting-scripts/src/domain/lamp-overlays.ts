/**
 * Lamp overlays: a person's change in Home Assistant and a dashboard control,
 * held over a lamp or a room part by part, or as an off, until a newer part,
 * a remote step or an overlay reset; and the parts they lay over the schedule's
 * light.
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
import { roomPowerSet, roomsOn } from './room-power.ts';
import type { RoomPower } from './room-power.ts';
import type { DashboardControlId, LampId, LampOrRoom, RoomId } from './types/ids.ts';
import type { Brightness, BrightnessStep, Colour, LampLight } from './types/light.ts';
import { brightnessOrThrow } from './types/range.ts';
import type { Instant } from './types/time.ts';

/**
 * A lamp or a room held by a person or from the dashboard: part by part, or
 * switched off.
 *
 * Part by part, each part is undefined when this overlay leaves it alone. The
 * effect is a part of its own: a newer level or colour hold on a candle lamp
 * keeps the candle running at the new level or colour, and only a newer effect
 * part ends it.
 *
 * Off (owner, 2026-11-23: a person's off in HA is a hold) holds the lamp or
 * room off from `since` until a newer part or remote step, from anyone, or an
 * overlay reset. It has no level, colour or effect, and never switches the room's power.
 */
export type LampOverlay =
  | {
    kind: 'parts';
    over: LampOrRoom;
    from: LampOverlayFrom;
    since: Instant;
    brightness: BrightnessOverlay | undefined;
    colour: ColourOverlay | undefined;
    effect: EffectOverlay | undefined;
  }
  | { kind: 'off'; over: LampOrRoom; from: LampOverlayFrom; since: Instant };

/** The lamp overlays that reach a lamp (with `lamp`) or a whole room (without one): its own, and its room's. */
export function lampOverlaysOn(overlays: readonly LampOverlay[], room: RoomId | undefined, lamp: LampId | undefined): LampOverlay[] {
  return overlays.filter(overlay => overlay.over.kind === 'lamp'
    ? lamp !== undefined && overlay.over.lamp === lamp : room !== undefined && overlay.over.room === room);
}

/** The overlays with the first one `mine` picks put back as `next` made it, in its place, or `next`'s added at the end. */
function replaced(overlays: readonly LampOverlay[], mine: (overlay: LampOverlay) => boolean,
  next: (earlier: LampOverlay | undefined) => LampOverlay): LampOverlay[] {
  const index = overlays.findIndex(mine);
  if (index === -1) return [...overlays, next(undefined)];
  return overlays.map((overlay, at) => at === index ? next(overlay) : overlay);
}

/** A person's HA change (one per lamp or room), or a dashboard control (one per control). */
export type LampOverlayFrom = { kind: 'person' } | { kind: 'dashboard'; control: DashboardControlId };

/** `at` is when this part was last set (the stored per-channel `updated`): the newest part of each kind wins per lamp. */
export type BrightnessOverlay = BrightnessPart & { at: Instant };

export type ColourOverlay = ColourPart & { at: Instant };

export type EffectOverlay = EffectPart & { at: Instant };

/** A brightness: fixed, or back to the schedule's over any older overlay. */
export type BrightnessPart = { kind: 'fixed'; brightness: Brightness } | { kind: 'schedule' };

/** A colour: fixed, or back to the schedule's over any older overlay. */
export type ColourPart = { kind: 'fixed'; colour: Colour } | { kind: 'schedule' };

/**
 * The candle, at whatever level and colour the other parts give; the normal
 * light, over a block's candle too; or back to the effect the schedule's light names.
 */
export type EffectPart = { kind: 'candle' } | { kind: 'normal' } | { kind: 'schedule' };

/**
 * A person's HA call: every lamp it reaches, and the rooms it named whole (an
 * area, or a group holding every lamp of the room: today's `roomScopes`).
 */
export type LampChangedByPerson = {
  kind: 'lampChangedByPerson'; lamps: readonly LampId[]; rooms: readonly RoomId[]; light: RequestedLight; at: Instant;
};

/**
 * What a person's call set: off, or on with a brightness, a colour, the
 * candle or the normal light, or each lamp's power the other way (a toggle).
 * Switched on with none of them (a plain `turn_on`), it ends the off holds
 * there and switches the room on.
 */
export type RequestedLight =
  | { power: 'off' }
  | { power: 'on'; brightness: RequestedBrightness | undefined; colour: Colour | undefined; effect: RequestedEffect | undefined }
  | { power: 'toggle' };

/**
 * A person's brightness: a fixed level, or a step that moves each lamp the
 * call reaches from the level that lamp shows (off counts as 0).
 */
export type RequestedBrightness = { kind: 'fixed'; brightness: Brightness } | { kind: 'step'; by: BrightnessStep };

/** A fixed level as it is; a step from the level shown, held to 0 to 255 as Home Assistant holds it. */
function resolved(brightness: RequestedBrightness, shown: Brightness): Brightness {
  return brightness.kind === 'fixed' ? brightness.brightness : brightnessOrThrow(Math.round(Math.min(255, Math.max(0, shown + brightness.by))));
}

/** The effect a person's call can choose: the candle, or the normal light. */
export type RequestedEffect = Extract<EffectPart, { kind: 'candle' } | { kind: 'normal' }>;

/**
 * What a lamp or a room shows under its overlays, before the mode overlay and
 * an effect's own colour: what choosing the normal light pins (today's `held`,
 * its colour `underlyingColour`). Undefined where it shows off, which has no
 * level or colour to pin. The lighting state works it out.
 */
export type Pinned = { brightness: Brightness; colour: Colour | undefined };

/** The parts one change sets, stamped; undefined leaves a part as the earlier overlay had it. */
type Parts = { brightness: BrightnessOverlay | undefined; colour: ColourOverlay | undefined; effect: EffectOverlay | undefined };

/** A dashboard control's parts, or its off, on a lamp or room; `update` stamps them and makes the overlay the control's. */
export type DashboardControlSet = { kind: 'dashboard control'; control: DashboardControlId; over: LampOrRoom; light: ControlLight };

/**
 * What a dashboard control sets: the lamp or room off (a hold, as a person's
 * off is), or on with the parts it names. Switched on with no part, it ends
 * the off holds there and switches the room on, as a person's plain switch-on does.
 */
export type ControlLight =
  | { power: 'off' }
  | { power: 'on'; brightness: BrightnessPart | undefined; colour: ColourPart | undefined; effect: EffectPart | undefined };

/** A power ON with no part: it sets nothing but the lamp's power. */
function plainOn(light: ControlLight): boolean {
  return light.power === 'on' && light.brightness === undefined && light.colour === undefined && light.effect === undefined;
}

/** One part a lamp overlay sets, with the instant it was set. */
export type LampPart =
  | { kind: 'brightness'; part: BrightnessOverlay }
  | { kind: 'colour'; part: ColourOverlay }
  | { kind: 'effect'; part: EffectOverlay }
  | { kind: 'off'; at: Instant }
  /** A person's or a control's light, set at the overlay's `since`: it ends an older off, even with no part of its own (a plain switch-on). */
  | { kind: 'on'; at: Instant };

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
 *
 * `shown` is what the lighting state shows when the change arrives: each
 * lamp's light, which a step moves from, and what the normal light pins. A
 * toggle is resolved per lamp against it: a lamp shown lit is switched off,
 * and one shown off is switched on, as a plain switch-on; a room named whole
 * stays one overlay where all its lamps the call reaches go the same way.
 */
export function personChanged(
  overlays: { lamps: readonly LampOverlay[]; roomPower: RoomPower }, config: Config,
  shown: { lamps: Readonly<Record<LampId, LampLight>>; pinned: (over: LampOrRoom) => Pinned | undefined }, change: LampChangedByPerson,
): { lamps: readonly LampOverlay[]; roomPower: RoomPower } {
  const { light, at: now } = change;
  if (light.power === 'toggle') {
    const lit = (lamp: LampId) => shown.lamps[lamp]?.power === 'on';
    const part = (resolved: RequestedLight, takes: (lamp: LampId) => boolean): LampChangedByPerson => ({ ...change, light: resolved,
      lamps: change.lamps.filter(takes), rooms: change.rooms.filter(room => change.lamps.every(lamp => config.lamps[lamp]?.room !== room || takes(lamp))) });
    const off = personChanged(overlays, config, shown, part({ power: 'off' }, lit));
    return personChanged(off, config, shown, part({ power: 'on', brightness: undefined, colour: undefined, effect: undefined }, lamp => !lit(lamp)));
  }
  const known = [...new Set(change.lamps)].filter(lamp => config.lamps[lamp] !== undefined);
  const whole = [...new Set(change.rooms)].filter(room => config.rooms[room] !== undefined).sort();
  const from: LampOverlayFrom = { kind: 'person' };
  let lamps = overlays.lamps;
  for (const over of changedOver(config, known, whole)) {
    const mine = (overlay: LampOverlay) => overlay.from.kind === 'person' && sameOver(overlay.over, over);
    const first = firstLampOf(config, known, over);
    const lampShown = first === undefined ? undefined : shown.lamps[first];
    const level = brightnessOrThrow(lampShown === undefined || lampShown.power === 'off' ? 0 : lampShown.level);
    lamps = replaced(lamps, mine, earlier => light.power === 'off' ? { kind: 'off', over, from, since: now }
      : withParts(earlier, over, from, requestedParts(light, level, shown.pinned(over), now), now));
  }
  const roomPower = light.power === 'on' ? roomsOn(overlays.roomPower, roomsOf(config, known)) : overlays.roomPower;
  return { lamps, roomPower };
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

function sameOver(a: LampOrRoom, b: LampOrRoom): boolean {
  return a.kind === 'room' ? b.kind === 'room' && a.room === b.room : b.kind === 'lamp' && a.lamp === b.lamp;
}

/** The lamp a step on `over` moves from: the lamp itself, or the first lamp the call reaches in the room. */
function firstLampOf(config: Config, lamps: readonly LampId[], over: LampOrRoom): LampId | undefined {
  return over.kind === 'lamp' ? over.lamp : lamps.find(lamp => config.lamps[lamp]?.room === over.room);
}

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
function requestedParts(light: Extract<RequestedLight, { power: 'on' }>, shown: Brightness, pinned: Pinned | undefined, now: Instant): Parts {
  const normal = light.effect !== undefined && light.effect.kind === 'normal';
  const brightness = light.brightness === undefined ? undefined : resolved(light.brightness, shown);
  return {
    brightness: brightness !== undefined ? { kind: 'fixed', brightness, at: now } : pinnedBrightness(normal, pinned, now),
    colour: light.colour !== undefined ? { kind: 'fixed', colour: light.colour, at: now } : pinnedColour(normal, pinned, now),
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
 * other change leaves the room's power alone. `pinned` is what the normal
 * light pins on a lamp or room, as the lighting state shows it now.
 */
export function dashboardControlSet(
  overlays: { lamps: readonly LampOverlay[]; roomPower: RoomPower }, config: Config, pinned: (over: LampOrRoom) => Pinned | undefined,
  set: DashboardControlSet, now: Instant,
): { lamps: readonly LampOverlay[]; roomPower: RoomPower } {
  const { control, over, light } = set;
  const from: LampOverlayFrom = { kind: 'dashboard', control };
  const mine = (overlay: LampOverlay) => overlay.from.kind === 'dashboard' && overlay.from.control === control;
  const lamps = replaced(overlays.lamps, mine, earlier => light.power === 'off' ? { kind: 'off', over, from, since: now }
    : withParts(earlier, over, from, controlParts(light, pinned(over), now), now));
  const room = over.kind === 'room' ? over.room : config.lamps[over.lamp]?.room;
  const roomPower = plainOn(light) && room !== undefined ? roomPowerSet(overlays.roomPower, room, 'on') : overlays.roomPower;
  return { lamps, roomPower };
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

/** Every part the lamp overlays set, in the overlays' order: each overlay's off or light, then its parts. */
export function lampParts(overlays: readonly LampOverlay[]): LampPart[] {
  const parts: LampPart[] = [];
  for (const overlay of overlays) {
    parts.push({ kind: overlay.kind === 'off' ? 'off' : 'on', at: overlay.since });
    if (overlay.kind === 'off') continue;
    if (overlay.brightness !== undefined) parts.push({ kind: 'brightness', part: overlay.brightness });
    if (overlay.colour !== undefined) parts.push({ kind: 'colour', part: overlay.colour });
    if (overlay.effect !== undefined) parts.push({ kind: 'effect', part: overlay.effect });
  }
  return parts;
}
