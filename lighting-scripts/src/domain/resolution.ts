import type { Verbatim } from '../runtime/verbatim.ts';
import type { Catalog } from '../runtime/catalog.ts';
import { gradientSignature, sampleGradient } from './gradient.ts';
import type { GradientCurve, GradientSignature } from './gradient.ts';
import { OFF_END_LEVEL, blend, boundedNumber, clamp } from './scale.ts';
import type { BlendEnd, Blended, Color, RGB } from './scale.ts';
import { DEFAULT_STEP_BOUNDS, levelNumber } from '../parse/resolution.ts';
import type { LampOrRoom } from './types/lighting-state.ts';
import type { OverlayKey } from './types/overlay.ts';
import { EMPTY_KEY, overlayKeyText, sameOverlayKey, SARA_MODE } from './types/overlay.ts';
import type { RoomId } from './types/ids.ts';
import type { Step } from './types/remote.ts';

const CHANNELS = ['brightness', 'color'] as const;
export type Channel = typeof CHANNELS[number];

/**
 * The lamps that may run Candle: Candle runs on the bulb's own firmware, so a
 * lamp may run it iff it has at least one bulb and every bulb is declared
 * flashed with that firmware (`bulbs.<entity>.candle`). A lamp with no bulbs
 * has nothing to run it on.
 */
export function candleLamps(catalog: Pick<Catalog, 'members' | 'bulbs'>): ReadonlySet<string> {
  return new Set(Object.entries(catalog.members)
    .filter(([, bulbs]) => bulbs.length > 0 && bulbs.every(bulb => catalog.bulbs[bulb]?.candle === true))
    .map(([lamp]) => lamp));
}

/**
 * A value a channel can hold. A colour is always parsed. A brightness is a
 * number, or -- when it is the base document's own value, which the resolver
 * passes through without validating -- carried raw, because it reaches the
 * output unchanged; arithmetic reads it through `levelNumber`, the coercion
 * JavaScript applied to it before.
 */
export type ChannelValue = number | Verbatim | Color;
/**
 * A claim's `updated`. Sanitised claims hold a number; a remote input's own
 * claims hold whatever the record stores, so the two coercions the resolver
 * applies -- ordering (`numeric`) and the position-cache key (`text`) -- are
 * computed by the parser, and `value` is what reaches the output.
 */
export type Stamp = { value: number | Verbatim; numeric: number; text: string };
/** `anchor`, as the position seed and the low-brightness rule read it. Absent counts as `current`. */
export type InputAnchor = 'day' | 'cosy' | 'current' | 'other';
/**
 * A remote input's adjustment. `steps`/`lower`/`upper` are `undefined` unless
 * finite and within [-40, 40]; `bounds` is `undefined` unless the step range is
 * well-ordered within [-20, 20].
 */
export type InputFacts = {
  steps: number | undefined;
  lower: number | undefined;
  upper: number | undefined;
  bounds: { min: Step; max: Step } | undefined;
  anchor: InputAnchor;
  legacyPosition: number | undefined;
  last: string | undefined;
  hasUp: boolean;
};
/**
 * One channel source as an override stores it. `updated` is the source's own
 * stamp when it is a bounded number. `invalid` is a non-mapping or an unknown
 * kind; both fall back to the base value as an invalid source.
 */
export type Claim =
  | { kind: 'constant'; brightness: number | undefined; color: Color | undefined; updated: number | undefined }
  | { kind: 'scale'; position: number | undefined; legacyPosition: number | undefined; updated: number | undefined }
  | { kind: 'input'; input: InputFacts | undefined; updated: number | undefined }
  | {
    kind: 'effect';
    effect: string | undefined;
    /** Only a non-empty string makes an effect claim valid. */
    instance: string | undefined;
    /** A brightness in [0, 255], or `undefined`. */
    intensity: number | undefined;
    /** The constant or scale source the effect carries underneath it. */
    carried: { claim: Claim; updated: number } | undefined;
    updated: number | undefined;
  }
  | { kind: 'invalid'; updated: number | undefined };
export type Patch = { brightness?: Claim; color?: Claim };
export type InputClaim = { claim: Claim; updated: Stamp };
/** A `light` record's value: `null`/absent, a mapping, or something else (no patch). */
export type LightValue =
  | { kind: 'unset' }
  | { kind: 'other' }
  | {
    kind: 'set';
    /** `effect` is present and not null. */
    effectPresent: boolean;
    effect: string | undefined;
    hasBrightness: boolean;
    brightnessDefined: boolean;
    brightness: Claim;
    intensity: number | undefined;
  };
/** Where a stored record applies: the whole house, one room, or one lamp. */
export type RecordScope = 'house' | 'room' | 'lamp';
/** One mapping override record. Only the field the record's `kind` uses is set. */
export type OverrideRecord = {
  key: OverlayKey;
  /** The record's scope, a `light` record's defaulting to `lamp`; none (applies nowhere) when it names no scope. */
  scope: RecordScope | undefined;
  /** The scope exactly as stored, with no default, for the remote-stream test. */
  storedScope: RecordScope | undefined;
  target: string | undefined;
  kind: string | undefined;
  via: string | undefined;
  stamp: number;
  input: { claims: InputClaim[]; legacy: Patch } | undefined;
  channels: Patch | undefined;
  light: LightValue | undefined;
};
/**
 * A target's room: the room its document's `area` names, or none, when `area`
 * is absent, `null` (the schedule's lamp in no room) or a saved value that is
 * not text (read as that `null`). A target in no room has no room records, no
 * remote stream, is never private, takes the default power, and is written
 * with area `null`, as the scripts write it.
 */
export type TargetArea = { kind: 'room'; room: RoomId } | { kind: 'no room' };
/** Both ends of a target's cosy <-> day blend. */
export type BlendEnds = { day: BlendEnd; cosy: BlendEnd };
/**
 * A base target. `anchors`/`color` raise on a malformed value, so they parse
 * when read.
 *
 * An off target carries no level and no colour (off is a state that cannot
 * carry a colour, 2026-11-20), and a lit one may report no colour, so both base
 * values are optional: `undefined` is "nothing to show on this channel".
 */
export type BaseItem = {
  /** `is_room` as stored, echoed on the resolved target unread. */
  isRoomAsStored: Verbatim;
  lampOrRoom: LampOrRoom;
  area: TargetArea;
  ignored: OverlayKey[];
  period: Verbatim;
  periodIsNight: boolean;
  on: Verbatim;
  onTruthy: boolean;
  transition: Verbatim;
  effect: string | undefined;
  effectInstance: Verbatim | undefined;
  /** `undefined` means "the effect's declared channels". */
  effectChannels: Channel[] | undefined;
  /** Are both `day` and `cosy` mappings? Otherwise there is no blend (the "no anchor" path). */
  anchorsPresent: boolean;
  /** The two ends, read day then cosy; `undefined` when a lit end has no colour, which is treated as no anchors. */
  anchors(): BlendEnds | undefined;
  color(): Color | undefined;
  brightness: Verbatim | undefined;
  claims: { observedBrightness: Claim; observedColor: Claim; brightness: Claim; color: Claim };
};

type Updated = number | Verbatim;
/**
 * What a channel resolved to. Key order is the order these are built in, and
 * it is compared: `origin`/`position` follow `updated`, and `base`/`intensity`
 * are appended to an effect after both channels resolved.
 */
export type ResolvedSource =
  | { kind: 'constant'; value: ChannelValue; updated: Updated; origin?: 'scale' | 'invalid_source'; position?: number; policy?: 'sara' }
  /**
   * The channel shows nothing: an off target's own channel, a lit target that
   * reports no colour, or a blend at (or past) its off end. Never a value.
   */
  | { kind: 'none'; updated: Updated; origin?: 'scale' | 'invalid_source'; position?: number }
  | { kind: 'effect'; effect: string; instance: string | Verbatim; updated: Updated; base?: ChannelValue; intensity?: ChannelValue };
/**
 * One resolved lamp or room.
 *
 * An off lamp's entry has `on` falsy; a channel nothing claimed holds
 * `{kind: 'none'}`, and `level` is absent unless a claim gave the brightness
 * channel a value. Mapping this to a bulb's power/level/colour is the
 * reconciler's job (`desired.ts`), not resolution's.
 */
export type ResolvedTarget = {
  brightness: ResolvedSource;
  color: ResolvedSource;
  period: Verbatim;
  /** As the schedule and room power give it, or `false` where a blend with an off end is at or past that end. */
  on: Verbatim | boolean;
  /** The target's room; `null` for a target in no room. */
  area: RoomId | null;
  is_room: Verbatim;
  level?: ChannelValue;
  owners: { brightness: string; color: string };
  transition: Verbatim;
};
export type Resolution = { targets: Record<string, ResolvedTarget>; assignments: Record<string, ResolvedTarget> };

type Candidate = { key: OverlayKey; updated: Stamp; claim: Claim; baselineOnly: boolean };
type InputPosition = { position: number; level: number };
type ClampedInput = {
  steps: number; lower: number; upper: number; anchor: InputAnchor;
  legacyPosition: number | undefined; last: string | undefined; hasUp: boolean;
};
/** `lit` is set only for a blend with an off end, which decides whether the lamp is lit. */
type Selected = { kind: 'none' } | { kind: 'scale'; position: number; lit: boolean | undefined } | { kind: 'effect'; source: ResolvedSource };

export function lexical(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
/** A channel holding `value`, or holding nothing (`none`) when there is no value to hold. */
function holding(value: ChannelValue | undefined, updated: Updated,
  extra: { origin?: 'scale' | 'invalid_source'; position?: number } = {}): ResolvedSource {
  return value === undefined ? { kind: 'none', updated, ...extra } : { kind: 'constant', value, updated, ...extra };
}
function numericStamp(n: number): Stamp { return { value: n, numeric: n, text: `${n}` }; }
function isRemoteStream(r: OverrideRecord): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }

/**
 * The newest remote input stream for a room, over records already in lexical
 * key order: the room-scoped remote records whose saved target `isRoom` accepts.
 */
export function latestStream(records: OverrideRecord[], isRoom: (target: OverrideRecord['target']) => boolean): OverlayKey {
  // The scripts start from the empty key and keep it when no remote record applies.
  let key: OverlayKey = EMPTY_KEY, stamp = -1;
  for (const record of records) {
    if (record.storedScope !== 'room' || !isRoom(record.target) || !isRemoteStream(record)) continue;
    if (record.stamp >= stamp) { key = record.key; stamp = record.stamp; }
  }
  return key;
}

/** An end's level for placing a position: an off end reads as {@link OFF_END_LEVEL}. */
function endLevel(end: BlendEnd): number { return end.on ? end.brightness : OFF_END_LEVEL; }

/** A channel value's level for placing a position: a channel that shows nothing (an off lamp) reads as {@link OFF_END_LEVEL}. */
function positionLevel(value: ChannelValue | undefined): number { return value === undefined ? OFF_END_LEVEL : levelNumber(value); }

/**
 * Where the remote's adjustment starts on the cosy (0) <-> day (1) axis.
 *
 * An off end reads as {@link OFF_END_LEVEL}. With a lit cosy and an off day the
 * blend falls from the cosy level to the off end, the reverse of the rule's
 * day-above-cosy shape, so a level there is placed by inverting that ramp: at
 * or above the cosy level is cosy (0), {@link OFF_END_LEVEL} is the off day end.
 */
function normalPosition(input: ClampedInput, ends: BlendEnds, level: number): number {
  const dayLevel = endLevel(ends.day), cosyLevel = endLevel(ends.cosy);
  const d = dayLevel - cosyLevel;
  const floor = Math.min(76.5, cosyLevel);
  const slope = Math.max(0, d, (cosyLevel - floor) / 2);
  let seed: number;
  if (input.anchor === 'day') seed = 1;
  else if (input.anchor === 'cosy') seed = 0;
  else if (input.legacyPosition !== undefined) seed = input.legacyPosition;
  else if (!ends.day.on) seed = level < cosyLevel && cosyLevel > OFF_END_LEVEL ? (cosyLevel - level) / (cosyLevel - OFF_END_LEVEL) : 0;
  else if (level > dayLevel && dayLevel < 255) seed = 1 + (level - dayLevel) / (255 - dayLevel);
  else if (level < cosyLevel && slope > 0) seed = Math.max(-2, (level - cosyLevel) / slope);
  else seed = d > 0 ? (level - cosyLevel) / d : 1;
  return clamp(seed * 10 + input.steps, input.lower, input.upper) / 10;
}

/** A remote scale source is read as an input with no steps from its legacy position. */
function remoteInput(claim: Extract<Claim, { kind: 'scale' }>): Claim {
  return {
    kind: 'input',
    input: { steps: 0, lower: -20, upper: 20, bounds: { ...DEFAULT_STEP_BOUNDS }, anchor: 'current', legacyPosition: claim.legacyPosition,
      last: undefined, hasUp: false },
    updated: claim.updated,
  };
}

function effectClaim(effect: string | undefined, key: string, intensity: number | undefined): Claim {
  return { kind: 'effect', effect, instance: key.length > 0 ? key : undefined, intensity, carried: undefined, updated: undefined };
}

export type ResolveRequest = {
  targets: Array<{ target: string; item: BaseItem }>;
  records: OverrideRecord[];
  channelsOf(effect: string | undefined): Channel[];
  adjustsByGradient(processor: string): boolean;
  private: RoomId[];
  /** The room's saved power; a target in no room has none, so the default. */
  power(room: RoomId | undefined): Verbatim;
  gradient(target: string, signature: GradientSignature): GradientCurve | undefined;
  /** Read where the signature lists it (`warm_end|list`); see `warmEndArgument`. */
  warmEnd: () => RGB;
  sara: boolean;
};
/** The channels a `light` record sets on this target. */
function lightPatch(light: LightValue, key: string, item: BaseItem, args: ResolveRequest): Patch {
  if (light.kind === 'unset') return { brightness: item.claims.observedBrightness, color: item.claims.observedColor };
  if (light.kind === 'other') return {};
  if (light.effectPresent && light.effect !== 'Normal light') {
    const declared = args.channelsOf(light.effect);
    if (declared.length === 0) return { brightness: item.claims.brightness, color: item.claims.color };
    const patch: Patch = {};
    for (const channel of declared) patch[channel] = effectClaim(light.effect, key, light.intensity);
    if (light.hasBrightness && !declared.includes('brightness')) patch.brightness = light.brightness;
    return patch;
  }
  if (light.effect === 'Normal light') {
    return { brightness: light.brightnessDefined ? light.brightness : item.claims.observedBrightness, color: item.claims.observedColor };
  }
  return light.hasBrightness ? { brightness: light.brightness } : {};
}

/**
 * Pure resolution of independent channel claims, room input and effect
 * ownership. `candle` is the lamps that may run Candle ({@link candleLamps});
 * Candle from a baseline or a claim is dropped on every other lamp.
 */
export function resolveEffects(args: ResolveRequest, candle: ReadonlySet<string>): Resolution {
  const targets: Record<string, ResolvedTarget> = {}, assignments: Record<string, ResolvedTarget> = {};
  const inputs = new Map<string, InputPosition>(), streams = new Map<RoomId | undefined, OverlayKey>();
  const entries = [...args.targets].sort((a, b) => lexical(a.target, b.target));
  const records = [...args.records].sort((a, b) => lexical(overlayKeyText(a.key), overlayKeyText(b.key)));
  const order = [...entries.filter(entry => entry.item.lampOrRoom.kind === 'room'),
    ...entries.filter(entry => entry.item.lampOrRoom.kind === 'lamp')];
  for (const { target, item } of order) {
    const room = item.area.kind === 'room' ? item.area.room : undefined, isRoom = item.lampOrRoom.kind === 'room';
    const isPrivate = room !== undefined && args.private.includes(room);
    // A target in no room has no remote stream.
    if (!streams.has(room)) streams.set(room, latestStream(records, stored => room !== undefined && stored === room));
    const candidates: Record<Channel, Candidate[]> = { brightness: [], color: [] };
    let gradientChecked = false, curve: GradientCurve | undefined;
    const samples = new Map<number, Blended>();
    for (const record of records) {
      if (item.ignored.some(key => sameOverlayKey(key, record.key))) continue;
      const scope = record.scope;
      let applies = (scope === 'house' && record.target === 'house' && !isPrivate) ||
        (scope === 'room' && room !== undefined && record.target === room)
        || (scope === 'lamp' && item.lampOrRoom.kind === 'lamp' && record.target === item.lampOrRoom.lamp);
      const stream = streams.get(room);
      if (record.storedScope === 'room' && isRemoteStream(record) && (stream === undefined || !sameOverlayKey(record.key, stream))) {
        applies = false;
      }
      if (!applies) continue;
      const stamp = record.stamp;
      let patch: Patch = {};
      if (record.input !== undefined) {
        patch = record.input.legacy;
        for (const { claim, updated } of record.input.claims) {
          for (const channel of CHANNELS) {
            if (claim.kind === 'input' || (claim.kind === 'effect' &&
              args.channelsOf(claim.effect).includes(channel))) candidates[channel].push({ key: record.key, updated, claim, baselineOnly: false });
          }
        }
      } else if (record.channels !== undefined) patch = record.channels;
      else if (record.light !== undefined) patch = lightPatch(record.light, overlayKeyText(record.key), item, args);
      for (const channel of CHANNELS) {
        let claim = patch[channel];
        if (claim === undefined) continue;
        if (record.via === 'remote' && claim.kind === 'scale') claim = remoteInput(claim);
        const updated = claim.updated === undefined ? stamp : claim.updated;
        candidates[channel].push({ key: record.key, updated: numericStamp(updated), claim, baselineOnly: false });
        if (claim.kind === 'effect' && args.channelsOf(claim.effect).includes(channel) && claim.instance !== undefined &&
          claim.carried !== undefined && claim.carried.updated <= updated) {
          candidates[channel].push({ key: record.key, updated: numericStamp(claim.carried.updated), claim: claim.carried.claim, baselineOnly: true });
        }
      }
    }
    const baselineEffect = item.effect, declared = args.channelsOf(baselineEffect);
    const enabled = item.effectChannels === undefined ? declared : item.effectChannels;
    const sources: Record<Channel, ResolvedSource> = { brightness: { kind: 'none', updated: -1 }, color: { kind: 'none', updated: -1 } };
    const owners = { brightness: 'base', color: 'base' };
    const underlying: Record<Channel, ChannelValue | undefined> = { brightness: undefined, color: undefined };
    // Whether the blend lights the lamp, when the brightness channel follows a
    // blend with an off end; `undefined` leaves on/off to the schedule.
    let blendLit: boolean | undefined;
    for (const channel of CHANNELS) {
      const initial: ChannelValue | undefined = channel === 'color' ? item.color() : item.brightness;
      let currentUnderlying: ChannelValue | undefined = initial;
      let current: ResolvedSource = holding(initial, -1), owner = 'base';
      if (baselineEffect !== undefined && declared.includes(channel) && enabled.includes(channel) && (baselineEffect !== 'Candle' ||
        candle.has(target))) {
        current = { kind: 'effect', effect: baselineEffect, instance: item.effectInstance === undefined ?
          `base:${target}:${baselineEffect}` : item.effectInstance, updated: -1 };
        owner = `base:${baselineEffect}`;
      }
      candidates[channel].sort((a, b) => lexical(overlayKeyText(a.key), overlayKeyText(b.key))).sort((a, b) => a.updated.numeric - b.updated.numeric);
      for (const candidate of candidates[channel]) {
        const claim = candidate.claim;
        if (!candle.has(target) && claim.kind === 'effect' && claim.effect === 'Candle') continue;
        let valid = false, ignore = false, value: ChannelValue | undefined = initial;
        let selected: Selected = { kind: 'none' };
        if (claim.kind === 'constant') {
          const v = channel === 'brightness' ? claim.brightness : claim.color;
          valid = v !== undefined;
          if (v !== undefined) value = v;
        } else if (claim.kind === 'scale' || claim.kind === 'input') {
          let p = claim.kind === 'scale' ? claim.position : undefined;
          let input: ClampedInput | undefined, position: InputPosition | undefined;
          if (claim.kind === 'input') {
            const facts = claim.input;
            if (facts !== undefined && item.anchorsPresent && facts.steps !== undefined && facts.lower !== undefined &&
              facts.upper !== undefined && facts.bounds !== undefined
              && facts.lower >= -20 && facts.lower <= facts.upper && facts.upper <= 20) {
              input = { steps: facts.steps, anchor: facts.anchor, legacyPosition: facts.legacyPosition, last: facts.last, hasUp: facts.hasUp,
                lower: clamp(facts.lower, facts.bounds.min, facts.bounds.max), upper: clamp(facts.upper, facts.bounds.min, facts.bounds.max) };
              const ref = `${overlayKeyText(candidate.key)}:${candidate.updated.text}`;
              position = inputs.get(ref);
              if (position === undefined) {
                const level = positionLevel(channel === 'brightness' ? currentUnderlying : underlying.brightness);
                const ends = item.anchors();
                // No usable pair, or both ends off: the lamp is not on this blend, and the
                // room does not cache a position it could not place.
                if (ends !== undefined && (ends.day.on || ends.cosy.on)) {
                  position = { position: normalPosition(input, ends, level), level };
                  if (isRoom) inputs.set(ref, position);
                }
              }
              if (position !== undefined) {
                p = position.position;
                const processor = current.kind === 'effect' ? current.effect : 'Normal light';
                ignore = !args.adjustsByGradient(processor);
              } else ignore = true;
            } else ignore = true;
          }
          if (!ignore && boundedNumber(p) && item.anchorsPresent) {
            const ends = item.anchors();
            // Both ends off: the lamp is skipped and keeps what it had. A lit end with
            // no colour: no blend, as with a missing anchor (an invalid source).
            if (ends !== undefined && !ends.day.on && !ends.cosy.on) ignore = true;
            else if (ends !== undefined) {
              const { day, cosy } = ends;
              const coordinate = clamp(p, -2, 2);
              let sample = samples.get(coordinate);
              if (sample === undefined) {
                if (day.on && cosy.on) {
                  // Only two lit ends have a compiled curve.
                  if (!gradientChecked) {
                    curve = args.gradient(target, gradientSignature(day, cosy, args.warmEnd()));
                    gradientChecked = true;
                  }
                  sample = curve !== undefined ? { on: true, ...sampleGradient(curve, coordinate) } : blend(day, cosy, coordinate, args.warmEnd())!;
                } else sample = blend(day, cosy, coordinate, args.warmEnd())!;
                samples.set(coordinate, sample);
              }
              valid = true;
              value = !sample.on ? undefined : channel === 'brightness' ? sample.brightness : sample.color;
              if (sample.on && claim.kind === 'input' && channel === 'brightness' && input !== undefined && input.last === 'down' &&
                !input.hasUp && position !== undefined && position.level < Math.min(76.5, endLevel(cosy)) && input.anchor === 'current' &&
                input.steps <= 0) value = Math.min(positionLevel(currentUnderlying), sample.brightness);
              selected = { kind: 'scale', position: sample.position, lit: day.on && cosy.on ? undefined : sample.on };
            }
          }
        } else if (claim.kind === 'effect' && claim.effect !== undefined && args.channelsOf(claim.effect).includes(channel) &&
          claim.instance !== undefined) {
          valid = true;
          selected = { kind: 'effect', source: { kind: 'effect', effect: claim.effect, instance: claim.instance, updated: candidate.updated.value } };
          if (channel === 'brightness' && claim.intensity !== undefined) currentUnderlying = claim.intensity;
        }
        if (!ignore) {
          if (candidate.baselineOnly) { if (valid) currentUnderlying = value; }
          else if (valid && selected.kind === 'effect') {
            current = selected.source;
            if (channel === 'brightness') blendLit = undefined;
          } else {
            currentUnderlying = valid ? value : initial;
            const updated = candidate.updated.value;
            current = !valid ? holding(currentUnderlying, updated, { origin: 'invalid_source' })
              : selected.kind === 'scale' ? holding(currentUnderlying, updated, { origin: 'scale', position: selected.position })
                : holding(currentUnderlying, updated);
            if (channel === 'brightness') blendLit = valid && selected.kind === 'scale' ? selected.lit : undefined;
          }
          if (!candidate.baselineOnly) owner = overlayKeyText(candidate.key);
        }
      }
      sources[channel] = current; owners[channel] = owner; underlying[channel] = currentUnderlying;
    }
    for (const channel of CHANNELS) {
      const source = sources[channel], base = underlying[channel], intensity = underlying.brightness;
      if (source.kind === 'effect') {
        sources[channel] = { ...source, ...(base === undefined ? {} : { base }), ...(intensity === undefined ? {} : { intensity }) };
      }
    }
    if (args.sara && !item.ignored.some(key => key.kind === 'sara mode') && !isPrivate && !item.periodIsNight) {
      sources.color = { kind: 'constant', value: { rgb: [255, 105, 180] }, updated: 0, policy: 'sara' };
      owners.color = overlayKeyText(SARA_MODE);
    }
    // A blend with an off end decides whether the lamp is lit; otherwise the schedule does, as before.
    const lit = blendLit === undefined ? item.onTruthy : blendLit;
    const level = underlying.brightness;
    const resolved: ResolvedTarget = { brightness: sources.brightness, color: sources.color, period: item.period,
      on: lit ? args.power(room) : blendLit === undefined ? item.on : false,
      area: item.area.kind === 'room' ? item.area.room : null, is_room: item.isRoomAsStored,
      ...(level === undefined ? {} : { level }), owners, transition: item.transition };
    targets[target] = resolved;
    if (!isRoom && (resolved.brightness.kind === 'effect' || resolved.color.kind === 'effect')) assignments[target] = resolved;
  }
  return { targets, assignments };
}
