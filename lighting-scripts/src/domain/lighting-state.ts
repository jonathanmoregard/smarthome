/**
 * The lighting state: what every lamp and switch should show at an instant,
 * derived from the Model. It is the schedule with every overlay over it.
 *
 * This is the combine step. Each concept gives its part for a lamp or a room:
 * the block a hold chose and the remote's steps (`./remote.ts`), the lamp
 * overlays' parts (`./lamp-overlays.ts`), the mode overlay's colour
 * (`./mode.ts`), room power (`./room-power.ts`), a lamp's own light in a block
 * (`./profiles.ts`), whether each switch is on (`./switches.ts`) and what the
 * next-block reset has released (`./overlay-resets.ts`). The schedule
 * (`./schedule.ts`) gives a room's stage and its light, and the colour a lamp
 * falls back to. Here the parts are folded over the schedule's light in the
 * order each was set.
 *
 * Moved from `scheduledBase` in `src/legacy/domain/schedule.ts`: the block a
 * lamp is in, the next-block reset and the fade out of a held light, and a
 * lamp's profile against its room's light. Also moved from `resolveEffects`
 * and the candle rule in `src/legacy/domain/resolution.ts`: brightness and
 * colour taken part by part, in the order each part was set; the remote's
 * steps on the blend; the mode overlay; and room power. The candle shows the
 * warm end, as today's candle does when it starts (`transport.ts`), unless a
 * newer colour says otherwise.
 */
import { roundEven } from './blend.ts';
import type { Config } from './config.ts';
import { candle, effectNamed, normal } from './effect.ts';
import type { Effect } from './effect.ts';
import { lampOverlaysOn, lampParts } from './lamp-overlays.ts';
import type { LampOverlay, LampPart, Pinned } from './lamp-overlays.ts';
import { modeColour, modeOver } from './mode.ts';
import type { ModeOverlay } from './mode.ts';
import { nextBlockReleases } from './overlay-resets.ts';
import type { Overlays } from './overlay-resets.ts';
import { lampLightIn } from './profiles.ts';
import type { LampProfiles, SwitchProfiles } from './profiles.ts';
import { heldBlock, newestRemote, placeOnBlend, remoteParts, remotesOn, steppedLight } from './remote.ts';
import type { BlendEnds, Placed, RemoteAdjustment, RemoteOverlay, RemotePart, StepRange } from './remote.ts';
import { switchedOff } from './room-power.ts';
import { blockAt, blockLight, blockPosition, fallbackColour, roomStage, stageLight, still } from './schedule.ts';
import type { BlockPosition, Stage } from './schedule.ts';
import { plantPower } from './plant-lights.ts';
import type { PlantOverrides } from './plant-lights.ts';
import { switchPower } from './switches.ts';
import type { RangeDefaults, RangeRules, RoomLight } from './switches.ts';
import type { LampId, LampOrRoom, RoomId, SwitchId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Brightness, Colour, LampLight, Level, Power, RGB, SceneLight, Transition } from './types/light.ts';
import { brightnessOrThrow, levelOrThrow, secondsOrThrow } from './types/range.ts';
import type { Block, RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/** What every lamp and switch should show: derived from the Model, and what the adapter makes the house match. */
export type LightingState = { lamps: Record<LampId, LampLight>; switches: Record<SwitchId, Power> };

/**
 * What the lighting state is worked out from: every slice of the Model but the
 * remotes' gestures. Spelled out here, not read off the Model, because the
 * Model's `update` asks the lighting state what a person's change pins, and
 * the domain's modules import one way only. The Model is one of these.
 */
export type LightingSources = {
  config: Config;
  overlays: Overlays;
  modeOverlay: ModeOverlay;
  switchRanges: RangeRules;
  rangeDefaults: RangeDefaults;
  lampProfiles: LampProfiles;
  switchProfiles: SwitchProfiles;
  plantOverrides: PlantOverrides;
};

/** What choosing the normal light pins on a lamp or a room at `now`: what it shows under its overlays. */
export function pinnedLight(model: LightingSources, over: LampOrRoom, now: Instant): Pinned | undefined {
  return over.kind === 'lamp' ? lampShown(model, over.lamp, now, pinnedOf) : roomShown(model, over.room, now).pinned;
}

/** A room's own light (the house's, for `house`), and where it places each of its remote's steps on its blend. */
function roomShown(model: LightingSources, scope: RoomOrHouse, now: Instant): {
  light: RoomLight; placed: ReadonlyMap<RemoteAdjustment, Placed>; pinned: Pinned | undefined;
} {
  const config = model.config;
  const room = scope === 'house' ? undefined : scope;
  const position = blockPosition(config, room, now);
  const on = applied(model, room, undefined, position, true);
  const stage = on.block === undefined ? roomStage(config, room, position, now) : still(on.block);
  const lightIn = (block: Block) => blockLight(config, room, block);
  const ends = { day: lightIn('day'), cosy: lightIn('cosy') };
  const placed = new Map<RemoteAdjustment, Placed>();
  const subject: Subject = {
    lightIn, ends, canRun: () => false, warmEnd: config.warmEnd,
    place: (step, range, level) => {
      const place = placeOnBlend(step, range, ends, level);
      if (place !== undefined) placed.set(step, place);
      return place;
    },
  };
  const base = stageLight(stage, lightIn, undefined);
  const shown = fold(base, changesOf(on.lamps, on.remote), subject);
  const lit = shown.lit === undefined ? base.power === 'on' : shown.lit;
  // A person's or a control's off holds the lamps, not the room's light a range rule reads: today an off is not in it.
  const off = !lit || switchedOff(model.overlays.roomPower, room) || shown.brightness === undefined;
  const switchStage: RoomLight['stage'] = stage.moving ? { moving: true } : { moving: false, block: blockAt(stage.into, position.current) };
  const light: RoomLight['light'] = off || shown.brightness === undefined ? OFF : { power: 'on', brightness: shown.brightness };
  const pinned = off || shown.off || shown.brightness === undefined ? undefined : { brightness: shown.brightness, colour: shown.colour };
  return { light: { stage: switchStage, light }, placed, pinned };
}

function lampLight(model: LightingSources, lamp: LampId, now: Instant): LampLight {
  return lampShown(model, lamp, now, shownLight);
}

/** A lamp through its stage and overlays, as `show` gives it; a fade out of a hold starts from its held light. */
function lampShown<T>(model: LightingSources, lamp: LampId, now: Instant, show: (sources: LampSources) => T): T {
  const config = model.config;
  const room = roomOfLamp(config, lamp);
  const position = blockPosition(config, room, now);
  const on = applied(model, room, lamp, position, true);
  const subject = lampSubject(model, lamp, room, now);
  if (on.fadingOut && position.fade !== undefined) {
    const before = applied(model, room, lamp, position, false);
    const heldAt = before.block === undefined ? position.current : before.block;
    const held = sceneOf(shownLight({ model, subject, stage: still(heldAt), block: heldAt, overlays: before, room, now, held: undefined }));
    const into = position.fade.into;
    const fade: Stage = { from: { kind: 'held light' }, into: { kind: 'block', block: into }, progress: position.fade.progress, moving: true };
    return show({ model, subject, stage: fade, block: into, overlays: on, room, now, held });
  }
  const stage = on.block === undefined ? roomStage(config, room, position, now) : still(on.block);
  return show({ model, subject, stage, block: blockAt(stage.from, position.current), overlays: on, room, now, held: undefined });
}

/** A lamp as the overlays see it: its light in each block (its own profile, else its room's), its bulbs and its room's remote steps. */
function lampSubject(model: LightingSources, lamp: LampId, room: RoomId | undefined, now: Instant): Subject {
  const config = model.config;
  const lightIn = (block: Block): SceneLight | undefined => lampLightIn(model.lampProfiles[lamp]?.[block], blockLight(config, room, block));
  const ends = { day: lightIn('day'), cosy: lightIn('cosy') };
  const bulbs = config.lamps[lamp]?.bulbs;
  return {
    lightIn,
    ends,
    canRun: effect => bulbs !== undefined && bulbs.some(bulb => effect.canRunOn(bulb)),
    warmEnd: config.warmEnd,
    // Rule 4: the room places each step from its own level, and every lamp of the room uses that place (today's room-first
    // order); where the room cannot place it, the lamp places it from its own.
    place: (step, range, level) => {
      const fromRoom = room === undefined ? undefined : roomShown(model, room, now).placed.get(step);
      return fromRoom === undefined ? placeOnBlend(step, range, ends, level) : fromRoom;
    },
  };
}

/** A lit lamp's light as a scene, for a fade that starts from it. */
function sceneOf(light: LampLight): SceneLight {
  return light.power === 'off' ? OFF : { power: 'on', brightness: brightnessOrThrow(light.level), colour: light.colour, effect: light.effect.name };
}




/** The overlays that apply to a lamp at an instant, after the next-block reset. */
export type AppliedOverlays = {
  /**
   * The block held over the lamp's room (the house's, for a lamp in no room):
   * its block overlay or its newest remote's preset, whichever is newer.
   * Undefined: the schedule's block.
   */
  block: Block | undefined;
  /** The lamp's own overlays and its room's. */
  lamps: readonly LampOverlay[];
  /** The newest remote overlay of the lamp's room. */
  remote: RemoteOverlay | undefined;
  /** The mode overlay is active and the lamp is outside the private rooms. The night block is the lighting state's to check. */
  mode: boolean;
  /**
   * Inside a fade into the next block, something that held the lamp was set
   * before the fade began, so the next-block reset released it. The lamp then
   * fades out of the light it was held at, into the next block.
   */
  fadingOut: boolean;
};

/** What the overlays work on: a lamp, or a room's own light. */
type Subject = {
  /** The light in a block, before any overlay. */
  lightIn: (block: Block) => SceneLight | undefined;
  /** The two ends of the remote's blend. */
  ends: BlendEnds;
  /** Some bulb of the subject can run the effect. */
  canRun: (effect: Effect) => boolean;
  warmEnd: RGB;
  /** Where a remote step places the subject on its blend, from the level it shows; undefined where it cannot be placed. */
  place: (step: RemoteAdjustment, range: StepRange, level: Brightness | undefined) => Placed | undefined;
};




/**
 * A block's light in the colour it shows: the warm end where its effect holds the warm colour and the lamp can run
 * that effect. A fade then moves into the colour the candle will show, and the candle starts at the block's start with
 * no jump (owner, 2026-11-24: "fade into candle color over transition and then start effect").
 */
function warmWhereShown(light: SceneLight | undefined, subject: Subject): SceneLight | undefined {
  if (light === undefined || light.power === 'off') return light;
  const effect = effectNamed(light.effect);
  return effect.holdsWarmColour && subject.canRun(effect) ? { ...light, colour: { kind: 'rgb', rgb: subject.warmEnd } } : light;
}

/** What the overlay parts leave a subject showing, before the mode overlay and room power. */
type Shown = {
  brightness: Brightness | undefined;
  colour: Colour | undefined;
  /** The effect holds the warm colour: the warm end shows, unless a colour part set after it says otherwise. */
  warmColour: boolean;
  effect: Effect;
  /** Set by a remote step on a blend with an off end, which decides whether the lamp is lit; undefined leaves that to the schedule. */
  lit: boolean | undefined;
  /** A person's or a control's off holds it, until a newer part or remote step. Apart from `lit`: a colour part never resets that. */
  off: boolean;
};

/** One part an overlay sets, or a remote step, with the instant it was set. */
type Change = LampPart | RemotePart;

/**
 * Every part the overlays set, oldest first. On a tie an effect comes after a
 * level or colour, so the candle wins it (the codec stores the tied part under
 * the effect); otherwise ties keep the overlays' order, lamp overlays before the remote.
 */
function changesOf(lamps: readonly LampOverlay[], remote: RemoteOverlay | undefined): Change[] {
  const changes: Change[] = [...lampParts(lamps), ...(remote === undefined ? [] : remoteParts(remote))];
  return changes.sort((a, b) => {
    const apart = setAt(a) - setAt(b);
    return apart !== 0 ? apart : (a.kind === 'effect' ? 1 : 0) - (b.kind === 'effect' ? 1 : 0);
  });
}

function setAt(change: Change): Instant {
  switch (change.kind) {
    case 'step': return change.step.at;
    case 'off': case 'on': return change.at;
    default: return change.part.at;
  }
}

/**
 * What a lamp's light is worked out from: the lighting state's sources, the
 * lamp as the overlays see it, its stage, the block it is in (the mode overlay
 * does nothing at night), the overlays on it, its room, the instant, and the
 * held light a fade out of a hold starts from.
 */
type LampSources = {
  model: LightingSources;
  subject: Subject;
  stage: Stage;
  block: Block;
  overlays: AppliedOverlays;
  room: RoomId | undefined;
  now: Instant;
  held: SceneLight | undefined;
};

function pinnedOf(sources: LampSources): Pinned | undefined {
  const { shown, off } = foldedLight(sources);
  return off || shown.brightness === undefined ? undefined : { brightness: shown.brightness, colour: shown.colour };
}

/**
 * A lamp's light: the stage's light (rule 2 filling a missing colour), each
 * overlay part over it in the order it was set, then the mode overlay and room
 * power.
 */
function shownLight(sources: LampSources): LampLight {
  const { model, subject, stage, block, overlays, room } = sources;
  const { shown, off } = foldedLight(sources);
  if (switchedOff(model.overlays.roomPower, room)) return SWITCHED_OFF;
  if (off || shown.brightness === undefined) return FADED_OFF;
  const warmColour: Colour = { kind: 'rgb', rgb: subject.warmEnd };
  const mode = modeColour(overlays.mode, block);
  const colour = mode !== undefined ? mode : shown.warmColour ? warmColour : shown.colour;
  const transition = stage.moving ? FADE_STEP : MANUAL;
  return { power: 'on', level: levelOf(shown.brightness), colour, effect: shown.effect, transition };
}

/** The stage's light with every overlay part folded over it, and whether the lamp is off: held off, unlit, or its room switched off. */
function foldedLight(sources: LampSources): { shown: Shown; off: boolean } {
  const { model, subject, stage, block, overlays, room, now, held } = sources;
  const staged = stageLight(stage, block => warmWhereShown(subject.lightIn(block), subject), held);
  const base = staged.power === 'on' && staged.colour === undefined
    ? { ...staged, colour: fallbackColour(model.config, subject.lightIn, room, block, now) } : staged;
  const shown = fold(base, changesOf(overlays.lamps, overlays.remote), subject);
  const lit = shown.lit === undefined ? base.power === 'on' : shown.lit;
  return { shown, off: shown.off || !lit || switchedOff(model.overlays.roomPower, room) };
}

/** A brightness as a Zigbee level: held to 1..254 and rounded half to even, as today's frames send it. */
function levelOf(brightness: Brightness): Level {
  return levelOrThrow(roundEven(clamp(brightness, 1, 254)));
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The lighting state at `now`.
 *
 * The schedule's light for each lamp, at the block a hold chose, through a
 * fade, the wake light or a fade out of a hold. Each overlay part that reaches
 * the lamp applies in the order it was set. Then the mode overlay's colour,
 * and room power over whether a lit lamp is on.
 *
 * Rules that replace the old plumbing:
 * 1. A lamp's transition is a scheduled fade over 60 s while its stage is
 *    moving, and manual otherwise.
 * 2. A lit light with no colour takes its room's colour for the block it is
 *    in. With none there, it takes the colour of the newest earlier block that
 *    has one for the lamp. With none in any block it has no colour, and each
 *    bulb keeps its own.
 * 3. The candle shows on a lamp where some bulb can run it. A bulb that cannot
 *    run it shows the lamp's light as normal light (`bulbAppearance`). Today a
 *    lamp needs every bulb to run it: a named change.
 * 4. The remote's place on the blend is worked out each time from its room,
 *    and never cached.
 * 5. Old stored shapes take no part: the Model does not hold them.
 */
export function lightingState(model: LightingSources, now: Instant): LightingState {
  const lamps: Record<LampId, LampLight> = {};
  for (const [lamp] of entriesOf(model.config.lamps)) lamps[lamp] = lampLight(model, lamp, now);
  const rooms: Record<RoomOrHouse, RoomLight> = { house: roomShown(model, 'house', now).light };
  for (const [room] of entriesOf(model.config.rooms)) rooms[room] = roomShown(model, room, now).light;
  return { lamps, switches: { ...switchPower(model, rooms, now), ...plantPower(model, now) } };
}

/** The overlays that apply to a lamp at `now`, after the next-block reset. One function, used by `lightingState` and by M3's remote. */
export function overlaysOn(model: LightingSources, lamp: LampId, now: Instant): AppliedOverlays {
  const room = roomOfLamp(model.config, lamp);
  return applied(model, room, lamp, blockPosition(model.config, room, now), true);
}

/** The room a lamp is in, where the config holds that room; a lamp in no room, or one the config does not hold, follows the house. */
function roomOfLamp(config: Config, lamp: LampId): RoomId | undefined {
  const room = config.lamps[lamp]?.room;
  return room !== undefined && config.rooms[room] !== undefined ? room : undefined;
}

/**
 * The overlays that reach a lamp (with `lamp`) or a whole room (without one).
 * `reset` false reads them as they were before the next-block reset, which is
 * the light a lamp fading out of a hold starts from.
 *
 * The next-block reset releases what it releases (`nextBlockReleases`). A
 * lamp's block overlay released inside a fade is kept, and makes the lamp fade
 * out of it (today's `chosen.when() <= last_fs` while fading).
 */
function applied(model: LightingSources, room: RoomId | undefined, lamp: LampId | undefined, position: BlockPosition,
  reset: boolean): AppliedOverlays {
  const { config, overlays } = model;
  const releases = nextBlockReleases(config, position);
  const released = (since: Instant) => reset && releases(since);
  const lamps = lampOverlaysOn(overlays.lamps, room, lamp);
  const remotes = remotesOn(overlays.remotes, room);
  const remote = newestRemote(remotes);
  const mode = modeOver(model.modeOverlay, config, room, released);
  const fading = position.fade !== undefined;
  const block = heldBlock(overlays.blocks[room === undefined ? 'house' : room], remote, released, lamp !== undefined, fading);
  const releasedNow = lamps.some(overlay => released(overlay.since)) || remotes.some(other => released(other.since)) || mode === 'released';
  return {
    block: block === undefined || (released(block.setAt) && !fading) ? undefined : block.block,
    lamps: lamps.filter(overlay => !released(overlay.since)),
    remote: remote === undefined || released(remote.since) ? undefined : remote,
    mode: mode === 'applies',
    fadingOut: lamp !== undefined && fading && (releasedNow || (block !== undefined && released(block.setAt))),
  };
}

/**
 * The overlays that apply to a room's own light at `now`, after the
 * next-block reset: the remote reads its room's newest remote overlay and its
 * held block here.
 */
export function roomOverlays(model: LightingSources, room: RoomId, now: Instant): AppliedOverlays {
  return applied(model, room, undefined, blockPosition(model.config, room, now), true);
}


/**
 * Each part over the base in the order it was set. A level or colour set over
 * the candle keeps the candle running at it (owner, 2026-11-22); only a newer
 * effect part ends it. A remote step does nothing under an effect that ignores
 * steps (`Effect.ignoresRemoteSteps`), nor where the blend has no light to
 * give. An off holds the subject off until any newer part or remote step
 * (owner, 2026-11-23).
 */
function fold(base: SceneLight, changes: readonly Change[], subject: Subject): Shown {
  const named = base.power === 'on' ? effectNamed(base.effect) : normal;
  const baseEffect = subject.canRun(named) ? named : normal;
  const baseBrightness = base.power === 'on' ? base.brightness : undefined;
  const baseColour = base.power === 'on' ? base.colour : undefined;
  let shown: Shown = {
    brightness: baseBrightness, colour: baseColour, warmColour: baseEffect.holdsWarmColour, effect: baseEffect, lit: undefined, off: false,
  };
  for (const change of changes) {
    if (change.kind !== 'off') shown = { ...shown, off: false };
    switch (change.kind) {
      case 'off':
        shown = { ...shown, off: true };
        break;
      case 'on':
        break;
      case 'brightness':
        shown = { ...shown, brightness: change.part.kind === 'fixed' ? change.part.brightness : baseBrightness, lit: undefined };
        break;
      case 'colour':
        shown = { ...shown, colour: change.part.kind === 'fixed' ? change.part.colour : baseColour, warmColour: false };
        break;
      case 'effect':
        if (change.part.kind === 'candle') {
          if (subject.canRun(candle)) shown = { ...shown, effect: candle, warmColour: candle.holdsWarmColour, lit: undefined };
        } else if (change.part.kind === 'normal') shown = { ...shown, effect: normal, warmColour: normal.holdsWarmColour };
        else shown = { ...shown, effect: baseEffect, warmColour: baseEffect.holdsWarmColour };
        break;
      case 'step':
        if (!shown.effect.ignoresRemoteSteps) shown = stepped(shown, change.step, change.range, subject);
        break;
    }
  }
  return shown;
}

/** A remote step over what the subject shows: the light it gives on the subject's blend (`steppedLight`), where it gives one. */
function stepped(shown: Shown, step: RemoteAdjustment, range: StepRange, subject: Subject): Shown {
  const light = steppedLight(step, subject.place(step, range, shown.brightness), subject.ends, subject.warmEnd, shown.brightness);
  if (light === undefined) return shown;
  const lit = light.decidesLit ? light.power === 'on' : undefined;
  return light.power === 'off'
    ? { ...shown, brightness: undefined, colour: undefined, warmColour: false, lit }
    : { ...shown, brightness: light.brightness, colour: light.colour, warmColour: false, lit };
}

const OFF = { power: 'off' } as const;
const MANUAL: Transition = { kind: 'manual' };
const FADED_OFF: LampLight = { power: 'off', transition: MANUAL };
/** A lamp off by its room's power switch: at once. */
const SWITCHED_OFF: LampLight = { power: 'off', transition: { kind: 'switch' } };
/** One minute's move of a scheduled fade. */
const FADE_STEP: Transition = { kind: 'scheduled fade', over: secondsOrThrow(60) };
