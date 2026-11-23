/**
 * A person's change and a dashboard control, as lamp overlays.
 *
 * Moved from `planNativeControls` and `held` in
 * `src/legacy/domain/native-controls.ts`, `lampChangeOverrides` in
 * `src/handlers/automations.ts`, the channel branch of `planUIControls`, and
 * the merge `planCommit` (`src/legacy/domain/state-store.ts`) makes of the
 * channels stored under one key. What stays at the edge for M3 Task 3: which
 * lamps a call names (areas, devices, labels, groups), the colour a call's
 * payload stands for (`nativeColor`), the brightness a step or a percent
 * comes to, and the dashboard's checks of its values.
 */
import type { Config } from './config.ts';
import type { ControlLight, Model, RequestedLight } from './model.ts';
import type { BrightnessOverlay, ColourOverlay, EffectOverlay, LampOverlay, LampOverlayFrom } from './overlays.ts';
import type { DashboardControlId, LampId, RoomId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { LampOrRoom } from './types/lighting-state.ts';
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

/** A person's light as parts: a fixed brightness and colour, the candle, or the normal light, which hands back what the call leaves. */
function requestedParts(light: Extract<RequestedLight, { power: 'on' }>, now: Instant): Parts {
  const normal = light.effect === 'Normal';
  return {
    brightness: light.brightness !== undefined ? { kind: 'fixed', brightness: light.brightness, at: now } : handedBack(normal, now),
    colour: light.colour !== undefined ? { kind: 'fixed', colour: light.colour, at: now } : handedBack(normal, now),
    effect: light.effect === undefined ? undefined : { kind: light.effect === 'Candle' ? 'candle' : 'normal', at: now },
  };
}

/** A control's parts, stamped; the normal light hands back what the control leaves, as a person's does (today's `held`). */
function controlParts(light: Extract<ControlLight, { power: 'on' }>, now: Instant): Parts {
  const normal = light.effect !== undefined && light.effect.kind === 'normal';
  return {
    brightness: light.brightness !== undefined ? { ...light.brightness, at: now } : handedBack(normal, now),
    colour: light.colour !== undefined ? { ...light.colour, at: now } : handedBack(normal, now),
    effect: light.effect === undefined ? undefined : { ...light.effect, at: now },
  };
}

/** A part the normal light hands back to the schedule; none for any other change. */
function handedBack(normal: boolean, now: Instant): { kind: 'schedule'; at: Instant } | undefined {
  return normal ? { kind: 'schedule', at: now } : undefined;
}

/**
 * A person's change in Home Assistant. A change of every lamp of a room is one
 * overlay over the room, otherwise one over each lamp; lamps the config does
 * not hold are left out. Each replaces the person's earlier overlay over that
 * lamp or room: an off replaces it whole, and a light keeps the parts the
 * earlier light set that this one leaves alone (one stored key per lamp or
 * room, whose channels `ls_commit` merges).
 *
 * A light switches each room it touches on; an off leaves the room's power
 * alone (owner, 2026-11-23). The normal light hands brightness and colour
 * back to the schedule, unless the call sets them too, and ends a candle.
 */
export function personChanged(model: Model, lamps: readonly LampId[], light: RequestedLight, now: Instant): Model {
  const config = model.config;
  const known = [...new Set(lamps)].filter(lamp => config.lamps[lamp] !== undefined);
  const from: LampOverlayFrom = { kind: 'person' };
  let overlays = model.overlays.lamps;
  for (const over of changedOver(config, known)) {
    const mine = (overlay: LampOverlay) => overlay.from.kind === 'person' && sameOver(overlay.over, over);
    overlays = replaced(overlays, mine, earlier => light.power === 'off' ? { kind: 'off', over, from, since: now }
      : withParts(earlier, over, from, requestedParts(light, now), now));
  }
  const roomPower = { ...model.overlays.roomPower };
  if (light.power === 'on') for (const room of roomsOf(config, known)) roomPower[room] = 'on';
  return { ...model, overlays: { ...model.overlays, lamps: overlays, roomPower } };
}

/**
 * What a person's call names: each room all of whose lamps it names (sorted,
 * as today's `roomScopes`), then each named lamp outside those rooms.
 */
function changedOver(config: Config, lamps: readonly LampId[]): LampOrRoom[] {
  const named = new Set(lamps);
  const whole = entriesOf(config.rooms).map(([room]) => room).filter(room => {
    const inRoom = entriesOf(config.lamps).filter(([, lamp]) => lamp.room === room);
    return inRoom.length > 0 && inRoom.every(([lamp]) => named.has(lamp));
  }).sort();
  const covered = new Set(whole);
  const single = lamps.filter(lamp => {
    const room = config.lamps[lamp]?.room;
    return room === undefined || !covered.has(room);
  });
  const rooms = whole.map((room): LampOrRoom => ({ kind: 'room', room }));
  return [...rooms, ...single.map((lamp): LampOrRoom => ({ kind: 'lamp', lamp }))];
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
 * person's change replaces theirs. It never changes a room's power.
 */
export function dashboardControlSet(model: Model, control: DashboardControlId, over: LampOrRoom, light: ControlLight, now: Instant): Model {
  const from: LampOverlayFrom = { kind: 'dashboard', control };
  const mine = (overlay: LampOverlay) => overlay.from.kind === 'dashboard' && overlay.from.control === control;
  const lamps = replaced(model.overlays.lamps, mine, earlier => light.power === 'off' ? { kind: 'off', over, from, since: now }
    : withParts(earlier, over, from, controlParts(light, now), now));
  return { ...model, overlays: { ...model.overlays, lamps } };
}
