/**
 * The lighting state: what every lamp and switch should show at an instant,
 * derived from the Model. It is the schedule with every overlay over it.
 *
 * Moved from `scheduledBase` in `src/legacy/domain/schedule.ts`: the block a
 * lamp is in (a block overlay against a remote's preset, the newer winning),
 * the next-block reset and the fade out of a held light, and a lamp's profile
 * against its room's light. Also moved from `resolveEffects`, `latestStream`,
 * `normalPosition` and the candle rule in `src/legacy/domain/resolution.ts`:
 * brightness and colour taken part by part, in the order each part was set;
 * the remote's steps on the blend, including the dim-below-cosy rule; the mode
 * overlay; and room power. The candle shows the warm end, as today's candle
 * does when it starts (`transport.ts`), unless a newer colour says otherwise.
 */
import { BLOCKS } from './blocks.ts';
import type { Block } from './blocks.ts';
import { blend, OFF_END_LEVEL, roundEven } from './blend.ts';
import type { BlendPosition } from './blend.ts';
import type { Config } from './config.ts';
import { effectNamed } from './effect.ts';
import type { EffectName } from './effect.ts';
import type { Model } from './model.ts';
import type {
  BlockOverlay, BrightnessOverlay, ColourOverlay, EffectOverlay, LampOverlay, RemoteAdjustment, RemoteOverlay, StepRange,
} from './overlays.ts';
import { blockLight, blockPosition, nextTimeOfDay, sceneBetween, scheduledStage, wakeStage } from './schedule.ts';
import type { BlockPosition, Stage, StageEnd } from './schedule.ts';
import { switchPower } from './switches.ts';
import type { LampId, RoomId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { LightingState } from './types/lighting-state.ts';
import type { Brightness, Colour, LampLight, Level, RGB, SceneLight, Transition } from './types/light.ts';
import {
  blendPositionOrThrow, brightnessOrThrow, colourChannelOrThrow, instantOrThrow, levelOrThrow, progressOrThrow, secondsOrThrow,
} from './types/range.ts';
import type { RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';

/** The mode overlay's colour: today's 255, 105, 180. */
export const MODE_COLOUR: Colour = {
  kind: 'rgb', rgb: { red: colourChannelOrThrow(255), green: colourChannelOrThrow(105), blue: colourChannelOrThrow(180) },
};

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

/** The overlays that apply to a lamp at `now`, after the next-block reset. One function, used by `lightingState` and by M3's remote. */
export function overlaysOn(model: Model, lamp: LampId, now: Instant): AppliedOverlays {
  const room = roomOfLamp(model.config, lamp);
  return applied(model, room, lamp, blockPosition(model.config, room, now), true);
}

/**
 * The overlays that reach a lamp (with `lamp`) or a whole room (without one).
 * `reset` false reads them as they were before the next-block reset, which is
 * the light a lamp fading out of a hold starts from.
 *
 * The next-block reset, when its rule is on, releases what was set at or
 * before the last fade start (none in reach: nothing is released). A lamp's
 * block overlay released inside a fade is kept, and makes the lamp fade out of
 * it (today's `chosen.when() <= last_fs` while fading).
 */
function applied(model: Model, room: RoomId | undefined, lamp: LampId | undefined, position: BlockPosition, reset: boolean): AppliedOverlays {
  const { config, overlays } = model;
  const lastFadeStart = position.lastFadeStart;
  const released = (since: Instant) => reset && config.overlayReset.atNextBlock && lastFadeStart !== undefined && since <= lastFadeStart;
  const outsidePrivate = room === undefined || config.rooms[room]?.private !== true;
  const lamps = overlays.lamps.filter(overlay => overlay.over.kind === 'lamp'
    ? lamp !== undefined && overlay.over.lamp === lamp : room !== undefined && overlay.over.room === room);
  const remotes = room === undefined ? [] : overlays.remotes.filter(remote => remote.room === room);
  const remote = newestRemote(remotes);
  const mode = model.modeOverlay;
  const fading = position.fade !== undefined;
  const block = heldBlock(overlays.blocks[room === undefined ? 'house' : room], remote, released, lamp !== undefined, fading);
  const releasedNow = lamps.some(overlay => released(overlay.since)) || remotes.some(other => released(other.since))
    || (mode.active && outsidePrivate && released(mode.since));
  return {
    block: block === undefined || (released(block.setAt) && !fading) ? undefined : block.block,
    lamps: lamps.filter(overlay => !released(overlay.since)),
    remote: remote === undefined || released(remote.since) ? undefined : remote,
    mode: mode.active && outsidePrivate && !released(mode.since),
    fadingOut: lamp !== undefined && fading && (releasedNow || (block !== undefined && released(block.setAt))),
  };
}

/** The newest of a room's remote overlays: only it applies. A tie goes to the source that sorts last, as today's key order. */
function newestRemote(remotes: readonly RemoteOverlay[]): RemoteOverlay | undefined {
  let newest: RemoteOverlay | undefined;
  for (const remote of remotes) {
    if (newest === undefined || remote.since > newest.since
      || (remote.since === newest.since && remote.source.toLowerCase() >= newest.source.toLowerCase())) newest = remote;
  }
  return newest;
}

/**
 * The block held over a room: its block overlay against its newest remote's
 * preset, the newer winning and the preset winning a tie. A preset is read
 * only from a remote overlay the reset has not released. For a room's own
 * light a released block overlay is passed over; for a lamp it stays in the
 * running, and its caller releases it outside a fade (today's two loops).
 */
function heldBlock(overlay: BlockOverlay | undefined, remote: RemoteOverlay | undefined, released: (since: Instant) => boolean,
  forLamp: boolean, fading: boolean): { block: Block; setAt: Instant } | undefined {
  let chosen: { block: Block; stamp: Instant; setAt: Instant } | undefined = overlay === undefined || (!forLamp && released(overlay.since))
    ? undefined : { block: overlay.block, stamp: overlay.since, setAt: overlay.since };
  const preset = remote === undefined || released(remote.since) ? undefined : presetBlock(remote);
  if (remote !== undefined && preset !== undefined && (chosen === undefined || preset.stamp >= chosen.stamp)) {
    chosen = { block: preset.block, stamp: preset.stamp, setAt: remote.since };
  }
  return chosen === undefined || (forLamp && !fading && released(chosen.setAt)) ? undefined : { block: chosen.block, setAt: chosen.setAt };
}

/** The block a remote's preset holds: day or cosy, or the block the candle kept from the preset it left; stamped when it was chosen. */
function presetBlock(remote: RemoteOverlay): { block: Block; stamp: Instant } | undefined {
  const preset = remote.preset;
  if (preset.choice === 'day' || preset.choice === 'cosy') return { block: preset.choice, stamp: preset.since };
  if (preset.choice === 'candle' && preset.block !== undefined) return { block: preset.block.block, stamp: preset.block.since };
  return undefined;
}

/**
 * What a room's switches read: the block the room is in (inside a fade, the
 * block it leaves, or the block a hold released at the fade start kept it in,
 * since today's switches move only once a fade is over) and the room's own
 * light, its block light with the room's overlays, whose level a range rule reads.
 */
export type RoomLight = { block: Block; light: { power: 'off' } | { power: 'on'; brightness: Brightness } };

/** What the overlays work on: a lamp, or a room's own light. */
type Subject = {
  /** The light in a block, before any overlay. */
  lightIn: (block: Block) => SceneLight | undefined;
  /** The two ends of the remote's blend. */
  ends: BlendEnds;
  canRunCandle: boolean;
  warmEnd: RGB;
  /** Where a remote step places the subject on its blend, from the level it shows; undefined where it cannot be placed. */
  place: (step: RemoteAdjustment, range: StepRange, level: Brightness | undefined) => Placed | undefined;
};

/** A lamp as the overlays see it: its light in each block (its own profile, else its room's), its bulbs and its room's remote steps. */
function lampSubject(model: Model, lamp: LampId, room: RoomId | undefined, now: Instant): Subject {
  const config = model.config;
  const lightIn = (block: Block): SceneLight | undefined => {
    const profile = model.lampProfiles[lamp]?.[block];
    return profile !== undefined && profile.follows === 'own' ? profile.light : blockLight(config, room, block);
  };
  const ends = { day: lightIn('day'), cosy: lightIn('cosy') };
  const candle = effectNamed('Candle');
  const bulbs = config.lamps[lamp]?.bulbs;
  return {
    lightIn,
    ends,
    canRunCandle: bulbs !== undefined && bulbs.some(bulb => candle.canRunOn(bulb)),
    warmEnd: config.warmEnd,
    // Rule 4: the room places each step from its own level, and every lamp of the room uses that place (today's room-first
    // order); where the room cannot place it, the lamp places it from its own.
    place: (step, range, level) => {
      const fromRoom = room === undefined ? undefined : roomShown(model, room, now).placed.get(step);
      return fromRoom === undefined ? placeOnBlend(step, range, ends, level) : fromRoom;
    },
  };
}

/**
 * Rule 2: the colour for a lit light with none. The room's light for the
 * block the lamp is in; else the newest earlier block's colour for the lamp,
 * looking back one cycle of blocks; else none.
 */
function fallbackColour(config: Config, subject: Subject, room: RoomId | undefined, block: Block, now: Instant): Colour | undefined {
  const own = colourOf(blockLight(config, room, block));
  if (own !== undefined) return own;
  let since = blockPosition(config, room, now).currentSince;
  for (let looked = 0; looked < BLOCKS.length && since !== undefined; looked++) {
    const earlier = blockPosition(config, room, instantOrThrow(since - 1));
    const lamps = colourOf(subject.lightIn(earlier.current));
    const colour = lamps === undefined ? colourOf(blockLight(config, room, earlier.current)) : lamps;
    if (colour !== undefined) return colour;
    since = earlier.currentSince;
  }
  return undefined;
}

function colourOf(light: SceneLight | undefined): Colour | undefined {
  return light === undefined || light.power === 'off' ? undefined : light.colour;
}

/** A remote step's place on the blend, and the level it was placed from (the dim-below-cosy rule reads it). */
type Placed = { position: BlendPosition; from: number };

type BlendEnds = { day: SceneLight | undefined; cosy: SceneLight | undefined };

/** What the overlay parts leave a subject showing, before the mode overlay and room power. */
type Shown = {
  brightness: Brightness | undefined;
  colour: Colour | undefined;
  /** The candle holds the colour: its warm end shows, unless a colour part set after it says otherwise. */
  candleColour: boolean;
  effect: EffectName;
  /** Set by a remote step on a blend with an off end, which decides whether the lamp is lit; undefined leaves that to the schedule. */
  lit: boolean | undefined;
};

/** One part an overlay sets, or a remote step, with the instant it was set. */
type Change =
  | { kind: 'brightness'; part: BrightnessOverlay }
  | { kind: 'colour'; part: ColourOverlay }
  | { kind: 'effect'; part: EffectOverlay }
  | { kind: 'step'; step: RemoteAdjustment; range: StepRange };

/**
 * Every part the overlays set, oldest first. On a tie an effect comes after a
 * level or colour, so the candle wins it (the codec stores the tied part under
 * the effect); otherwise ties keep the overlays' order, lamp overlays before the remote.
 */
function changesOf(lamps: readonly LampOverlay[], remote: RemoteOverlay | undefined): Change[] {
  const changes: Change[] = [];
  for (const overlay of lamps) {
    if (overlay.brightness !== undefined) changes.push({ kind: 'brightness', part: overlay.brightness });
    if (overlay.colour !== undefined) changes.push({ kind: 'colour', part: overlay.colour });
    if (overlay.effect !== undefined) changes.push({ kind: 'effect', part: overlay.effect });
  }
  if (remote !== undefined) changes.push(...remoteChanges(remote));
  return changes.sort((a, b) => {
    const apart = setAt(a) - setAt(b);
    return apart !== 0 ? apart : (a.kind === 'effect' ? 1 : 0) - (b.kind === 'effect' ? 1 : 0);
  });
}

/**
 * A remote overlay's parts: on the candle, the steps it started from and the
 * candle itself; then its steps, unless they are the ones the candle started
 * from (today's `inputClaims`).
 */
function remoteChanges(remote: RemoteOverlay): Change[] {
  const preset = remote.preset, range = remote.stepRange;
  const changes: Change[] = [];
  const startedFrom = preset.choice === 'candle' ? preset.adjustment : undefined;
  if (preset.choice === 'candle') {
    if (startedFrom !== undefined) changes.push({ kind: 'step', step: startedFrom, range });
    changes.push({ kind: 'effect', part: { kind: 'candle', at: preset.since } });
  }
  const adjustment = remote.adjustment;
  if (adjustment !== undefined && (startedFrom === undefined || !sameSteps(adjustment, startedFrom))) {
    changes.push({ kind: 'step', step: adjustment, range });
  }
  return changes;
}

function setAt(change: Change): Instant {
  return change.kind === 'step' ? change.step.at : change.part.at;
}

function sameSteps(a: RemoteAdjustment, b: RemoteAdjustment): boolean {
  return a.steps === b.steps && a.lower === b.lower && a.upper === b.upper && a.from === b.from && a.at === b.at
    && a.lastPress === b.lastPress && a.everBrighter === b.everBrighter;
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
export function lightingState(model: Model, now: Instant): LightingState {
  const lamps: Record<LampId, LampLight> = {};
  for (const [lamp] of entriesOf(model.config.lamps)) lamps[lamp] = lampLight(model, lamp, now);
  const rooms: Record<RoomOrHouse, RoomLight> = { house: roomShown(model, 'house', now).light };
  for (const [room] of entriesOf(model.config.rooms)) rooms[room] = roomShown(model, room, now).light;
  return { lamps, switches: switchPower(model, rooms, now) };
}

function lampLight(model: Model, lamp: LampId, now: Instant): LampLight {
  const config = model.config;
  const room = roomOfLamp(config, lamp);
  const position = blockPosition(config, room, now);
  const on = applied(model, room, lamp, position, true);
  const subject = lampSubject(model, lamp, room, now);
  if (on.fadingOut && position.fade !== undefined) {
    const before = applied(model, room, lamp, position, false);
    const heldAt = before.block === undefined ? position.current : before.block;
    const held = sceneOf(shownLight(model, subject, still(heldAt), heldAt, before, room, now, undefined));
    const into = position.fade.into;
    const fade: Stage = { from: { kind: 'held light' }, into: { kind: 'block', block: into }, progress: position.fade.progress, moving: true };
    return shownLight(model, subject, fade, into, on, room, now, held);
  }
  const stage = on.block === undefined ? roomStage(config, room, position, now) : still(on.block);
  return shownLight(model, subject, stage, blockAt(stage.from, position.current), on, room, now, undefined);
}

/** The room a lamp is in, where the config holds that room; a lamp in no room, or one the config does not hold, follows the house. */
function roomOfLamp(config: Config, lamp: LampId): RoomId | undefined {
  const room = config.lamps[lamp]?.room;
  return room !== undefined && config.rooms[room] !== undefined ? room : undefined;
}

/** A lit lamp's light as a scene, for a fade that starts from it. */
function sceneOf(light: LampLight): SceneLight {
  return light.power === 'off' ? OFF : { power: 'on', brightness: brightnessOrThrow(light.level), colour: light.colour, effect: light.effect.name };
}

/**
 * A lamp's light: the stage's light (rule 2 filling a missing colour), each
 * overlay part over it in the order it was set, then the mode overlay and room
 * power. `block` is the block the lamp is in (the mode overlay does nothing at
 * night); `held` is the held light a fade out of a hold starts from.
 */
function shownLight(model: Model, subject: Subject, stage: Stage, block: Block, overlays: AppliedOverlays, room: RoomId | undefined,
  now: Instant, held: SceneLight | undefined): LampLight {
  const staged = stageLight(stage, subject.lightIn, held);
  const base = staged.power === 'on' && staged.colour === undefined
    ? { ...staged, colour: fallbackColour(model.config, subject, room, block, now) } : staged;
  const shown = fold(base, changesOf(overlays.lamps, overlays.remote), subject);
  const lit = shown.lit === undefined ? base.power === 'on' : shown.lit;
  if (!lit || (room !== undefined && model.overlays.roomPower[room] === 'off') || shown.brightness === undefined) return OFF;
  const candleColour: Colour = { kind: 'rgb', rgb: subject.warmEnd };
  const colour = overlays.mode && block !== 'night' ? MODE_COLOUR : shown.candleColour ? candleColour : shown.colour;
  const transition = stage.moving ? FADE_STEP : MANUAL;
  return { power: 'on', level: levelOf(shown.brightness), colour, effect: effectNamed(shown.effect), transition };
}

/** The light a stage shows: held, the destination; moving, part way between its ends. A missing light is off. */
function stageLight(stage: Stage, lightIn: (block: Block) => SceneLight | undefined, held: SceneLight | undefined): SceneLight {
  const end = (at: StageEnd): SceneLight => {
    const light = at.kind === 'held light' ? held : lightIn(at.block);
    return light === undefined ? OFF : light;
  };
  return stage.moving ? sceneBetween(end(stage.from), end(stage.into), stage.progress) : end(stage.into);
}

/**
 * Each part over the base in the order it was set. A level or colour set over
 * the candle keeps the candle running at it (owner, 2026-11-22); only a newer
 * effect part ends it. A remote step does nothing while the candle runs
 * (today's catalog: the candle's `remote_adjustment` is `ignore`), nor where
 * the blend has no light to give.
 */
function fold(base: SceneLight, changes: readonly Change[], subject: Subject): Shown {
  const baseEffect: EffectName = base.power === 'on' && base.effect === 'Candle' && subject.canRunCandle ? 'Candle' : 'Normal';
  const baseBrightness = base.power === 'on' ? base.brightness : undefined;
  const baseColour = base.power === 'on' ? base.colour : undefined;
  let shown: Shown = { brightness: baseBrightness, colour: baseColour, candleColour: baseEffect === 'Candle', effect: baseEffect, lit: undefined };
  for (const change of changes) {
    switch (change.kind) {
      case 'brightness':
        shown = { ...shown, brightness: change.part.kind === 'fixed' ? change.part.brightness : baseBrightness, lit: undefined };
        break;
      case 'colour':
        shown = { ...shown, colour: change.part.kind === 'fixed' ? change.part.colour : baseColour, candleColour: false };
        break;
      case 'effect':
        if (change.part.kind === 'candle') {
          if (subject.canRunCandle) shown = { ...shown, effect: 'Candle', candleColour: true, lit: undefined };
        } else if (change.part.kind === 'normal') shown = { ...shown, effect: 'Normal', candleColour: false };
        else shown = { ...shown, effect: baseEffect, candleColour: baseEffect === 'Candle' };
        break;
      case 'step':
        if (shown.effect !== 'Candle') shown = stepped(shown, change.step, change.range, subject);
        break;
    }
  }
  return shown;
}

/**
 * A remote step: the light at the step's place on the subject's blend. Beside
 * an off end the blend decides whether the lamp is lit. Dimming from below the
 * cosy level with no brighter press yet never brightens the lamp.
 */
function stepped(shown: Shown, step: RemoteAdjustment, range: StepRange, subject: Subject): Shown {
  const placed = subject.place(step, range, shown.brightness);
  const { day, cosy } = subject.ends;
  if (placed === undefined || day === undefined || cosy === undefined) return shown;
  const sample = blend(day, cosy, placed.position, subject.warmEnd);
  if (sample === undefined) return shown;
  const bothLit = day.power === 'on' && cosy.power === 'on';
  if (sample.power === 'off') return { ...shown, brightness: undefined, colour: undefined, candleColour: false, lit: bothLit ? undefined : false };
  const dims = step.lastPress === 'down' && !step.everBrighter && placed.from < Math.min(76.5, endLevel(cosy)) && step.from === 'current'
    && step.steps <= 0;
  const brightness = dims ? brightnessOrThrow(Math.min(levelOrOffEnd(shown.brightness), sample.brightness)) : sample.brightness;
  return { ...shown, brightness, colour: sample.colour, candleColour: false, lit: bothLit ? undefined : true };
}

/** An end's level for placing a position: an off end reads as {@link OFF_END_LEVEL}. */
function endLevel(end: SceneLight): Brightness {
  return end.power === 'on' ? end.brightness : OFF_END_LEVEL;
}

/** A level for placing a position: a light that shows none (an off lamp) reads as {@link OFF_END_LEVEL}. */
function levelOrOffEnd(level: Brightness | undefined): Brightness {
  return level === undefined ? OFF_END_LEVEL : level;
}

/** A brightness as a Zigbee level: held to 1..254 and rounded half to even, as today's frames send it. */
function levelOf(brightness: Brightness): Level {
  return levelOrThrow(roundEven(clamp(brightness, 1, 254)));
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** A held block: no fade, from and into the same block. */
function still(block: Block): Stage {
  const end: StageEnd = { kind: 'block', block };
  return { from: end, into: end, progress: progressOrThrow(0), moving: false };
}

/** A room's stage with no hold: its wake light where it applies, else its blocks. */
function roomStage(config: Config, room: RoomId | undefined, position: BlockPosition, now: Instant): Stage {
  const placed = room === undefined ? undefined : config.rooms[room];
  const wake = placed === undefined ? undefined : wakeStage(placed, position, now, config.timezone);
  return wake === undefined ? scheduledStage(position) : wake;
}

/** A stage end's block; the light a hold kept is in `otherwise`. */
function blockAt(end: StageEnd, otherwise: Block): Block {
  return end.kind === 'block' ? end.block : otherwise;
}

/** A room's own light (the house's, for `house`), and where it places each of its remote's steps on its blend. */
function roomShown(model: Model, scope: RoomOrHouse, now: Instant): { light: RoomLight; placed: ReadonlyMap<RemoteAdjustment, Placed> } {
  const config = model.config;
  const room = scope === 'house' ? undefined : scope;
  const position = blockPosition(config, room, now);
  const on = applied(model, room, undefined, position, true);
  const stage = on.block === undefined ? roomStage(config, room, position, now) : still(on.block);
  const lightIn = (block: Block) => blockLight(config, room, block);
  const ends = { day: lightIn('day'), cosy: lightIn('cosy') };
  const placed = new Map<RemoteAdjustment, Placed>();
  const subject: Subject = {
    lightIn, ends, canRunCandle: false, warmEnd: config.warmEnd,
    place: (step, range, level) => {
      const place = placeOnBlend(step, range, ends, level);
      if (place !== undefined) placed.set(step, place);
      return place;
    },
  };
  const base = stageLight(stage, lightIn, undefined);
  const shown = fold(base, changesOf(on.lamps, on.remote), subject);
  const lit = shown.lit === undefined ? base.power === 'on' : shown.lit;
  const off = !lit || (room !== undefined && model.overlays.roomPower[room] === 'off') || shown.brightness === undefined;
  const before = applied(model, room, undefined, position, false).block;
  const block = !stage.moving ? blockAt(stage.into, position.current) : before === undefined ? blockAt(stage.from, position.current) : before;
  return { light: { block, light: off || shown.brightness === undefined ? OFF : { power: 'on', brightness: shown.brightness } }, placed };
}

/**
 * Where a remote step starts on the cosy (0) to day (1) blend, moved from
 * today's `normalPosition`. An off end reads as {@link OFF_END_LEVEL}. Not
 * placed: a missing end, two off ends, a lit end with no colour, or bounds
 * that run backwards.
 */
function placeOnBlend(step: RemoteAdjustment, range: StepRange, ends: BlendEnds, level: Brightness | undefined): Placed | undefined {
  const { day, cosy } = ends;
  if (day === undefined || cosy === undefined || (day.power === 'off' && cosy.power === 'off')) return undefined;
  if ((day.power === 'on' && day.colour === undefined) || (cosy.power === 'on' && cosy.colour === undefined)) return undefined;
  if (step.lower > step.upper) return undefined;
  const at = levelOrOffEnd(level), dayLevel = endLevel(day), cosyLevel = endLevel(cosy);
  const span = dayLevel - cosyLevel, floor = Math.min(76.5, cosyLevel), slope = Math.max(0, span, (cosyLevel - floor) / 2);
  const seed = step.from === 'day' ? 1
    : step.from === 'cosy' ? 0
      : day.power === 'off' ? (at < cosyLevel && cosyLevel > OFF_END_LEVEL ? (cosyLevel - at) / (cosyLevel - OFF_END_LEVEL) : 0)
        : at > dayLevel && dayLevel < 255 ? 1 + (at - dayLevel) / (255 - dayLevel)
          : at < cosyLevel && slope > 0 ? Math.max(-2, (at - cosyLevel) / slope)
            : span > 0 ? (at - cosyLevel) / span : 1;
  const lower = clamp(step.lower, range.min, range.max), upper = clamp(step.upper, range.min, range.max);
  return { position: blendPositionOrThrow(clamp(clamp(seed * 10 + step.steps, lower, upper) / 10, -2, 2)), from: at };
}

/**
 * The next instant the lighting state changes by itself: inside a fade or a
 * wake fade, the next whole minute (which makes a fade a series of one-minute
 * moves, as today); else the next fade start, block start, wake time or wake
 * end, or the next overlay reset falling due (an overlay's age limit, the
 * daily reset time). Undefined when nothing is coming.
 */
export function nextChange(model: Model, now: Instant): Instant | undefined {
  const config = model.config;
  const minute = Math.floor(now / 60) * 60 + 60;
  const times: number[] = [];
  for (const room of [undefined, ...entriesOf(config.rooms).map(([id]) => id)]) {
    const position = blockPosition(config, room, now);
    if (position.fade !== undefined) times.push(minute);
    if (position.nextFadeStart !== undefined) times.push(position.nextFadeStart);
    if (position.nextStart !== undefined) times.push(position.nextStart);
  }
  for (const [id, room] of entriesOf(config.rooms)) {
    const wake = room.wakeLight;
    if (wake === undefined) continue;
    if (wakeStage(room, blockPosition(config, id, now), now, config.timezone)?.moving === true) times.push(minute);
    times.push(wake.at, wake.at + wake.fade * 60);
  }
  const age = config.overlayReset.afterAge;
  if (age !== undefined) for (const since of overlaySinces(model)) times.push(since + age * 60);
  const daily = config.overlayReset.atSetTime;
  if (daily !== undefined) times.push(nextTimeOfDay(now, daily, config.timezone));
  const coming = times.filter(time => time > now);
  return coming.length === 0 ? undefined : instantOrThrow(Math.min(...coming));
}

/** When each overlay was set: what the age limit measures. */
function overlaySinces(model: Model): Instant[] {
  const { overlays, modeOverlay } = model;
  return [
    ...Object.values(overlays.blocks).flatMap(overlay => overlay === undefined ? [] : [overlay.since]),
    ...overlays.remotes.map(remote => remote.since),
    ...overlays.lamps.map(overlay => overlay.since),
    ...Object.values(overlays.switches).flatMap(overlay => overlay === undefined ? [] : [overlay.since]),
    ...(modeOverlay.active ? [modeOverlay.since] : []),
  ];
}

const OFF = { power: 'off' } as const;
const MANUAL: Transition = { kind: 'manual' };
/** One minute's move of a scheduled fade. */
const FADE_STEP: Transition = { kind: 'scheduled fade', over: secondsOrThrow(60) };
