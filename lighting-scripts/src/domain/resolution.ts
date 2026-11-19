import type { ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { gradientSignature, planGradients, sampleGradient } from './gradient.ts';
import type { GradientCurve, GradientSignature } from './gradient.ts';
import { boundedNumber, clamp, scaleValue, WARM_END } from './scale.ts';
import type { Anchor, Color, RGB, Scaled } from './scale.ts';
import { parseGradientPlanArgs } from '../parse/gradient.ts';
import { parseScaleArgs } from '../parse/scale.ts';
import { levelNumber, parseResolveArgs } from '../parse/resolution.ts';

const CHANNELS = ['brightness', 'color'] as const;
export type Channel = typeof CHANNELS[number];
/** The one lamp that may run the Candle effect from a baseline or an override. */
const CANDLE_LAMP = 'light.living_room_yellow_retro_lamp';

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
  bounds: { min: number; max: number } | undefined;
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
/** One mapping override record. Only the field the record's `kind` uses is set. */
export type OverrideRecord = {
  key: string;
  /** `scope`, defaulting to `lamp` for a light record and `''` otherwise. */
  scope: string | undefined;
  /** `scope` exactly as stored, for the remote-stream test. */
  storedScope: string | undefined;
  target: string | undefined;
  kind: string | undefined;
  via: string | undefined;
  stamp: number;
  input: { claims: InputClaim[]; legacy: Patch } | undefined;
  channels: Patch | undefined;
  light: LightValue | undefined;
};
/** A base target. `day`/`cosy`/`color` raise on a malformed value, so they parse when read. */
export type BaseItem = {
  isRoom: Verbatim;
  isRoomTruthy: boolean;
  area: string;
  ignored: string[];
  period: Verbatim;
  periodIsNight: boolean;
  on: Verbatim;
  onTruthy: boolean;
  transition: Verbatim;
  effect: string | undefined;
  effectInstance: Verbatim | undefined;
  /** `undefined` means "the effect's declared channels". */
  effectChannels: Channel[] | undefined;
  anchorsPresent: boolean;
  day(): Anchor;
  cosy(): Anchor;
  color(): Color;
  brightness: Verbatim;
  claims: { observedBrightness: Claim; observedColor: Claim; brightness: Claim; color: Claim };
};
export type ResolveArgs = {
  targets: Array<{ target: string; item: BaseItem }>;
  records: OverrideRecord[];
  channelsOf(effect: string | undefined): Channel[];
  adjustsByGradient(processor: string): boolean;
  private: string[];
  power(area: string): Verbatim;
  gradient(target: string, signature: GradientSignature): GradientCurve | undefined;
  /** Read where the signature lists it (`warm_end|list`); see `warmEndArgument`. */
  warmEnd: () => RGB;
  sara: boolean;
};

type Updated = number | Verbatim;
/**
 * What a channel resolved to. Key order is the order these are built in, and
 * it is compared: `origin`/`position` follow `updated`, and `base`/`intensity`
 * are appended to an effect after both channels resolved.
 */
export type ResolvedSource =
  | { kind: 'constant'; value: ChannelValue; updated: Updated; origin?: 'scale' | 'invalid_source'; position?: number; policy?: 'sara' }
  | { kind: 'effect'; effect: string; instance: string | Verbatim; updated: Updated; base?: ChannelValue; intensity?: ChannelValue };
export type ResolvedTarget = {
  brightness: ResolvedSource;
  color: ResolvedSource;
  period: Verbatim;
  on: Verbatim;
  area: string;
  is_room: Verbatim;
  level: ChannelValue;
  owners: { brightness: string; color: string };
  transition: Verbatim;
};
export type ResolutionResult = { targets: Record<string, ResolvedTarget>; assignments: Record<string, ResolvedTarget> };

type Candidate = { key: string; updated: Stamp; claim: Claim; baselineOnly: boolean };
type InputPosition = { position: number; level: number };
type ClampedInput = { steps: number; lower: number; upper: number; anchor: InputAnchor; legacyPosition: number | undefined; last: string | undefined; hasUp: boolean };
type Selected = { kind: 'none' } | { kind: 'scale'; position: number } | { kind: 'effect'; source: ResolvedSource };

export function lexical(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
function numericStamp(n: number): Stamp { return { value: n, numeric: n, text: `${n}` }; }
function isRemoteStream(r: OverrideRecord): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }

/** The newest remote input stream for a room, over records already in lexical key order. */
export function latestStream(records: OverrideRecord[], room: string): string {
  let key = '', stamp = -1;
  for (const record of records) {
    if (record.storedScope !== 'room' || record.target !== room || !isRemoteStream(record)) continue;
    if (record.stamp >= stamp) { key = record.key; stamp = record.stamp; }
  }
  return key;
}

function normalPosition(input: ClampedInput, day: Anchor, cosy: Anchor, level: number): number {
  const d = day.brightness - cosy.brightness;
  const floor = Math.min(76.5, cosy.brightness);
  const slope = Math.max(0, d, (cosy.brightness - floor) / 2);
  let seed: number;
  if (input.anchor === 'day') seed = 1;
  else if (input.anchor === 'cosy') seed = 0;
  else if (input.legacyPosition !== undefined) seed = input.legacyPosition;
  else if (level > day.brightness && day.brightness < 255) seed = 1 + (level - day.brightness) / (255 - day.brightness);
  else if (level < cosy.brightness && slope > 0) seed = Math.max(-2, (level - cosy.brightness) / slope);
  else seed = d > 0 ? (level - cosy.brightness) / d : 1;
  return clamp(seed * 10 + input.steps, input.lower, input.upper) / 10;
}

/** A remote scale source is read as an input with no steps from its legacy position. */
function remoteInput(claim: Extract<Claim, { kind: 'scale' }>): Claim {
  return {
    kind: 'input',
    input: { steps: 0, lower: -20, upper: 20, bounds: { min: -20, max: 20 }, anchor: 'current', legacyPosition: claim.legacyPosition, last: undefined, hasUp: false },
    updated: claim.updated,
  };
}

function effectClaim(effect: string | undefined, key: string, intensity: number | undefined): Claim {
  return { kind: 'effect', effect, instance: key.length > 0 ? key : undefined, intensity, carried: undefined, updated: undefined };
}

/** The channels a `light` record sets on this target. */
function lightPatch(light: LightValue, key: string, item: BaseItem, args: ResolveArgs): Patch {
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

/** Pure resolution of independent channel claims, room input and effect ownership. */
export function resolveEffects(args: ResolveArgs): ResolutionResult {
  const targets: Record<string, ResolvedTarget> = {}, assignments: Record<string, ResolvedTarget> = {};
  const inputs = new Map<string, InputPosition>(), streams = new Map<string, string>();
  const entries = [...args.targets].sort((a, b) => lexical(a.target, b.target));
  const records = [...args.records].sort((a, b) => lexical(a.key, b.key));
  const order = [...entries.filter(entry => entry.item.isRoomTruthy), ...entries.filter(entry => !entry.item.isRoomTruthy)];
  for (const { target, item } of order) {
    const area = item.area, isRoom = item.isRoomTruthy;
    if (!streams.has(area)) streams.set(area, latestStream(records, area));
    const candidates: Record<Channel, Candidate[]> = { brightness: [], color: [] };
    let gradientChecked = false, curve: GradientCurve | undefined;
    const samples = new Map<number, Scaled>();
    for (const record of records) {
      if (item.ignored.includes(record.key)) continue;
      const scope = record.scope;
      let applies = (scope === 'house' && record.target === 'house' && !args.private.includes(area)) ||
        (scope === 'room' && record.target === area) || (scope === 'lamp' && !isRoom && record.target === target);
      if (record.storedScope === 'room' && isRemoteStream(record) && record.key !== streams.get(area)) applies = false;
      if (!applies) continue;
      const stamp = record.stamp;
      let patch: Patch = {};
      if (record.input !== undefined) {
        patch = record.input.legacy;
        for (const { claim, updated } of record.input.claims) {
          for (const channel of CHANNELS) {
            if (claim.kind === 'input' || (claim.kind === 'effect' && args.channelsOf(claim.effect).includes(channel))) candidates[channel].push({ key: record.key, updated, claim, baselineOnly: false });
          }
        }
      } else if (record.channels !== undefined) patch = record.channels;
      else if (record.light !== undefined) patch = lightPatch(record.light, record.key, item, args);
      for (const channel of CHANNELS) {
        let claim = patch[channel];
        if (claim === undefined) continue;
        if (record.via === 'remote' && claim.kind === 'scale') claim = remoteInput(claim);
        const updated = claim.updated === undefined ? stamp : claim.updated;
        candidates[channel].push({ key: record.key, updated: numericStamp(updated), claim, baselineOnly: false });
        if (claim.kind === 'effect' && args.channelsOf(claim.effect).includes(channel) && claim.instance !== undefined && claim.carried !== undefined && claim.carried.updated <= updated) {
          candidates[channel].push({ key: record.key, updated: numericStamp(claim.carried.updated), claim: claim.carried.claim, baselineOnly: true });
        }
      }
    }
    const baselineEffect = item.effect, declared = args.channelsOf(baselineEffect);
    const enabled = item.effectChannels === undefined ? declared : item.effectChannels;
    const sources: Record<Channel, ResolvedSource> = { brightness: { kind: 'constant', value: 0, updated: -1 }, color: { kind: 'constant', value: 0, updated: -1 } };
    const owners = { brightness: 'base', color: 'base' };
    const underlying: Record<Channel, ChannelValue> = { brightness: 0, color: 0 };
    for (const channel of CHANNELS) {
      const initial: ChannelValue = channel === 'color' ? item.color() : item.brightness;
      let currentUnderlying: ChannelValue = initial;
      let current: ResolvedSource = { kind: 'constant', value: initial, updated: -1 }, owner = 'base';
      if (baselineEffect !== undefined && declared.includes(channel) && enabled.includes(channel) && (baselineEffect !== 'Candle' || target === CANDLE_LAMP)) {
        current = { kind: 'effect', effect: baselineEffect, instance: item.effectInstance === undefined ? `base:${target}:${baselineEffect}` : item.effectInstance, updated: -1 };
        owner = `base:${baselineEffect}`;
      }
      candidates[channel].sort((a, b) => lexical(a.key, b.key)).sort((a, b) => a.updated.numeric - b.updated.numeric);
      for (const candidate of candidates[channel]) {
        const claim = candidate.claim;
        if (target !== CANDLE_LAMP && claim.kind === 'effect' && claim.effect === 'Candle') continue;
        let valid = false, ignore = false, value: ChannelValue = initial;
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
            if (facts !== undefined && item.anchorsPresent && facts.steps !== undefined && facts.lower !== undefined && facts.upper !== undefined && facts.bounds !== undefined
              && facts.lower >= -20 && facts.lower <= facts.upper && facts.upper <= 20) {
              input = { steps: facts.steps, anchor: facts.anchor, legacyPosition: facts.legacyPosition, last: facts.last, hasUp: facts.hasUp,
                lower: clamp(facts.lower, facts.bounds.min, facts.bounds.max), upper: clamp(facts.upper, facts.bounds.min, facts.bounds.max) };
              const ref = `${candidate.key}:${candidate.updated.text}`;
              position = inputs.get(ref);
              if (position === undefined) {
                const level = levelNumber(channel === 'brightness' ? currentUnderlying : underlying.brightness);
                position = { position: normalPosition(input, item.day(), item.cosy(), level), level };
                if (isRoom) inputs.set(ref, position);
              }
              p = position.position;
              const processor = current.kind === 'effect' ? current.effect : 'Normal light';
              ignore = !args.adjustsByGradient(processor);
            } else ignore = true;
          }
          if (!ignore && boundedNumber(p) && item.anchorsPresent) {
            const day = item.day(), cosy = item.cosy();
            if (!gradientChecked) {
              curve = args.gradient(target, gradientSignature(day, cosy, args.warmEnd()));
              gradientChecked = true;
            }
            const coordinate = clamp(p, -2, 2);
            let sample = samples.get(coordinate);
            if (sample === undefined) { sample = curve !== undefined ? sampleGradient(curve, coordinate) : scaleValue(day, cosy, coordinate, args.warmEnd()); samples.set(coordinate, sample); }
            valid = true; value = channel === 'brightness' ? sample.brightness : sample.color;
            if (claim.kind === 'input' && channel === 'brightness' && input !== undefined && input.last === 'down' && !input.hasUp && position !== undefined
              && position.level < Math.min(76.5, cosy.brightness) && input.anchor === 'current' && input.steps <= 0) value = Math.min(levelNumber(currentUnderlying), sample.brightness);
            selected = { kind: 'scale', position: sample.position };
          }
        } else if (claim.kind === 'effect' && claim.effect !== undefined && args.channelsOf(claim.effect).includes(channel) && claim.instance !== undefined) {
          valid = true;
          selected = { kind: 'effect', source: { kind: 'effect', effect: claim.effect, instance: claim.instance, updated: candidate.updated.value } };
          if (channel === 'brightness' && claim.intensity !== undefined) currentUnderlying = claim.intensity;
        }
        if (!ignore) {
          if (candidate.baselineOnly) { if (valid) currentUnderlying = value; }
          else if (valid && selected.kind === 'effect') current = selected.source;
          else {
            currentUnderlying = valid ? value : initial;
            const updated = candidate.updated.value;
            current = !valid ? { kind: 'constant', value: currentUnderlying, updated, origin: 'invalid_source' }
              : selected.kind === 'scale' ? { kind: 'constant', value: currentUnderlying, updated, origin: 'scale', position: selected.position }
                : { kind: 'constant', value: currentUnderlying, updated };
          }
          if (!candidate.baselineOnly) owner = candidate.key;
        }
      }
      sources[channel] = current; owners[channel] = owner; underlying[channel] = currentUnderlying;
    }
    for (const channel of CHANNELS) {
      const source = sources[channel];
      if (source.kind === 'effect') sources[channel] = { ...source, base: underlying[channel], intensity: underlying.brightness };
    }
    if (args.sara && !item.ignored.includes('mode:sara') && !args.private.includes(area) && !item.periodIsNight) {
      sources.color = { kind: 'constant', value: { rgb: [255, 105, 180] }, updated: 0, policy: 'sara' };
      owners.color = 'mode:sara';
    }
    const resolved: ResolvedTarget = { brightness: sources.brightness, color: sources.color, period: item.period,
      on: item.onTruthy ? args.power(area) : item.on, area, is_room: item.isRoom, level: underlying.brightness, owners, transition: item.transition };
    targets[target] = resolved;
    if (!isRoom && (resolved.brightness.kind === 'effect' || resolved.color.kind === 'effect')) assignments[target] = resolved;
  }
  return { targets, assignments };
}

export const resolutionHandlers: ScriptHandlers = {
  // Arguments parsed in `src/parse/resolution.ts`. Every read there is as
  // lenient as the traversal it replaces, so the parse raises nowhere; the
  // three reads that do raise are thunks the resolver calls where it always
  // did.
  effects_resolve: typed('effects_resolve', { parse: parseResolveArgs, run: (_context, args) => resolveEffects(args) }),
  // Arguments parsed in `src/parse/scale.ts`.
  effects_scale: withParsedArgs({
    parse: parseScaleArgs,
    run: (_context, a) => scaleValue(a.day, a.cosy, a.position, a.warmEnd),
  }),
  // Arguments parsed in `src/parse/gradient.ts`, which documents the
  // leniency in them that is load-bearing.
  effects_gradient_plan: typed('effects_gradient_plan', { parse: parseGradientPlanArgs, run: (_context, args) => planGradients(args) }),
};
