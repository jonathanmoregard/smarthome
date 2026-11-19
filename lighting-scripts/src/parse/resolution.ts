/**
 * Parsing for `effects_resolve`: the baseline targets, the stored override
 * records and the claims inside them, the catalog's channel declarations and
 * the cached gradients.
 *
 * Every one of these arrives as an argument document, and the resolver has to
 * reproduce what the inline traversal did for ANY document, not just
 * well-formed ones -- `tests/parity/native_resolution.py` fuzzes claims whose
 * values are `True`, `None`, `'90'` and `{'rgb': [0, 0, False]}` against the
 * live template. So this parser keeps every distinction the traversal could
 * observe:
 *
 * - Values that reach the output unread (`period`, `on`, `is_room`,
 *   `transition`, a base `effect_instance`, a non-numeric base `brightness`, a
 *   claim's raw `updated`) are carried as `Verbatim`.
 * - Where the traversal did arithmetic on a raw value -- `level > day`,
 *   `a.updated - b.updated` -- JavaScript coerced it with `Number(...)`, and
 *   where it interpolated one into a key it used `String(...)`. Those exact
 *   coercions are computed here, once, so the domain does the same arithmetic
 *   on a number.
 * - Facts compared only with string literals are `string | undefined`: a
 *   non-string stored value compares unequal to every literal, as `undefined`
 *   does.
 *
 * Nothing here raises. The three reads in the resolver that do --
 * `anchor(item.day)`, `anchor(item.cosy)` and `canonicalColor(item.color)` --
 * are thunks, called where the inline read sat. So parsing the whole argument
 * document before resolving moves no raise.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { isObject, jinjaTruthy, object } from '../runtime/parse.ts';
import { carry, carryOptional } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { boundedNumber } from '../domain/scale.ts';
import type { Color } from '../domain/scale.ts';
import { latestStream, lexical } from '../domain/resolution.ts';
import type { BaseItem, Channel, ChannelValue, Claim, InputAnchor, InputClaim, InputFacts, LightValue, OverrideRecord, Patch, ResolveArgs, Stamp } from '../domain/resolution.ts';
import { anchor, canonicalColor, validColor } from './scale.ts';
import { validGradient, warmEndArgument } from './gradient.ts';

/**
 * A record or input timestamp in seconds, `0` when absent or unparseable.
 * Lenient on purpose, and with microsecond precision: HA record order uses it.
 */
export function recordTimestamp(value: JsonValue | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  // Date.parse truncates sub-millisecond precision; HA record order uses microseconds.
  const fraction = /(?:T| )\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1];
  const timestamp = Date.parse(fraction ? value.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1') : value);
  return Number.isNaN(timestamp) ? 0 : timestamp / 1000 + (fraction ? Number('0.' + fraction.slice(0, 6)) : 0);
}

function defaulted(o: JsonObject, key: string, fallback: JsonValue): JsonValue { return o[key] === undefined ? fallback : o[key]; }
function optionalString(value: JsonValue | undefined): string | undefined { return typeof value === 'string' ? value : undefined; }
function nonEmptyString(value: JsonValue | undefined): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
function isChannel(value: JsonValue): value is Channel { return value === 'brightness' || value === 'color'; }

/** The number JavaScript arithmetic reads from a raw value: `Number(value)`. */
export function levelNumber(value: ChannelValue): number {
  return Number(value);
}

/** A raw `updated`, with the two coercions the resolver applies to it. */
function rawStamp(value: JsonValue): Stamp {
  return { value: carry(value), numeric: Number(value), text: String(value) };
}

function constantClaim(value: JsonValue | undefined, updated: number | undefined): Claim {
  return {
    kind: 'constant',
    brightness: typeof value === 'number' && value >= 0 && value <= 255 ? value : undefined,
    // `canonicalColor` cannot raise on a value `validColor` accepted.
    color: validColor(value) ? canonicalColor(value) : undefined,
    updated,
  };
}

function inputAnchor(value: JsonValue | undefined): InputAnchor {
  if (value === 'day' || value === 'cosy') return value;
  return value === undefined || value === 'current' ? 'current' : 'other';
}

function inputFacts(input: JsonObject): InputFacts {
  const field = (key: string): number | undefined => {
    const v = input[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= -40 && v <= 40 ? v : undefined;
  };
  const range = input.step_range === undefined ? { min: -20, max: 20 } : object(input.step_range);
  const min = range.min, max = range.max;
  const legacy = input.legacy_position;
  return {
    steps: field('steps'),
    lower: field('lower'),
    upper: field('upper'),
    bounds: typeof min === 'number' && typeof max === 'number' && -20 <= min && min <= max && max <= 20 ? { min, max } : undefined,
    anchor: inputAnchor(input.anchor),
    legacyPosition: typeof legacy === 'number' || typeof legacy === 'boolean' ? Number(legacy) : undefined,
    last: optionalString(input.last),
    hasUp: jinjaTruthy(input.has_up),
  };
}

/** The constant or scale source an effect carries, followed through up to eight effect links. */
function carriedOf(underlying: JsonValue | undefined): { claim: Claim; updated: number } | undefined {
  let carried = underlying;
  for (let depth = 0; depth < 8; depth++) if (isObject(carried) && carried.kind === 'effect') carried = carried.underlying;
  if (isObject(carried) && (carried.kind === 'constant' || carried.kind === 'scale') && boundedNumber(carried.updated)) {
    return { claim: claimOf(carried), updated: carried.updated };
  }
  return undefined;
}

/** One channel source as stored in an override. A non-mapping, or an unknown kind, is invalid. */
function claimOf(source: JsonValue | undefined): Claim {
  if (!isObject(source)) return { kind: 'invalid', updated: undefined };
  const updated = boundedNumber(source.updated) ? source.updated : undefined;
  switch (source.kind) {
    case 'constant': return constantClaim(source.value, updated);
    case 'scale': {
      const position = source.position;
      return {
        kind: 'scale',
        position: boundedNumber(position) ? position : undefined,
        legacyPosition: typeof position === 'number' || typeof position === 'boolean' ? Number(position) : undefined,
        updated,
      };
    }
    case 'input': return { kind: 'input', input: isObject(source.input) ? inputFacts(source.input) : undefined, updated };
    case 'effect': return {
      kind: 'effect',
      effect: optionalString(source.effect),
      instance: nonEmptyString(source.instance),
      intensity: typeof source.intensity === 'number' && source.intensity >= 0 && source.intensity <= 255 ? source.intensity : undefined,
      carried: carriedOf(source.underlying),
      updated,
    };
    default: return { kind: 'invalid', updated };
  }
}

/** `channel in patch` for both channels, in the patch the record stores. */
function patchOf(channels: JsonObject): Patch {
  const patch: Patch = {};
  if ('brightness' in channels) patch.brightness = claimOf(channels.brightness);
  if ('color' in channels) patch.color = claimOf(channels.color);
  return patch;
}

/**
 * The claims a remote input record makes: its selection's own input and
 * effect, and its adjustment. Their `updated` is NOT sanitised the way a
 * channel source's is -- it is whatever the record stores -- so it is carried
 * raw, with the coercions the resolver applies to it.
 */
function inputClaims(value: JsonObject, key: string, stamp: number): InputClaim[] {
  const claims: InputClaim[] = [];
  const selection = value.selection;
  const preset = selection === 'day' || selection === 'cosy' || selection === null || selection === undefined;
  const claimInput = (input: JsonObject): InputClaim => {
    const presetAnchor = ['day', 'cosy'].includes(String(input.anchor)) && ['day', 'cosy'].includes(String(value.period));
    const merged: JsonObject = {
      ...input,
      step_range: defaulted(value, 'step_range', { min: -20, max: 20 }),
      anchor: presetAnchor ? value.period! : defaulted(input, 'anchor', 'current'),
    };
    return { claim: { kind: 'input', input: inputFacts(merged), updated: undefined }, updated: rawStamp(defaulted(input, 'updated', stamp)) };
  };
  if (!preset && !isObject(value.legacy_channels)) {
    if (isObject(value.selection_input)) claims.push(claimInput(value.selection_input));
    claims.push({
      claim: {
        kind: 'effect',
        effect: optionalString(selection),
        instance: nonEmptyString(defaulted(value, 'selection_instance', `${key}:${String(selection)}`)),
        intensity: undefined,
        carried: undefined,
        updated: undefined,
      },
      updated: rawStamp(defaulted(value, 'selection_updated', stamp)),
    });
  }
  if (isObject(value.adjustment) && (preset || !isDeepStrictEqual(value.adjustment, value.selection_input))) claims.push(claimInput(value.adjustment));
  return claims;
}

function lightValue(value: JsonValue | undefined): LightValue {
  if (value === null || value === undefined) return { kind: 'unset' };
  if (!isObject(value)) return { kind: 'other' };
  return {
    kind: 'set',
    effectPresent: value.effect !== null && value.effect !== undefined,
    effect: optionalString(value.effect),
    hasBrightness: 'brightness' in value,
    brightnessDefined: value.brightness !== undefined,
    brightness: constantClaim(value.brightness, undefined),
    intensity: typeof value.brightness === 'number' && value.brightness >= 0 && value.brightness <= 255 ? value.brightness : undefined,
  };
}

function overrideRecord(key: string, record: JsonObject): OverrideRecord {
  const value = record.value;
  const stamp = recordTimestamp(record.when);
  return {
    key,
    scope: optionalString(defaulted(record, 'scope', record.kind === 'light' ? 'lamp' : '')),
    storedScope: optionalString(record.scope),
    target: optionalString(record.target),
    kind: optionalString(record.kind),
    via: optionalString(record.via),
    stamp,
    input: record.kind === 'input' && isObject(value)
      ? { claims: inputClaims(value, key, stamp), legacy: patchOf(object(value.legacy_channels)) }
      : undefined,
    channels: record.kind === 'channels' && isObject(value) && isObject(value.channels) ? patchOf(value.channels) : undefined,
    light: record.kind === 'light' ? lightValue(value) : undefined,
  };
}

/** The mapping records only: every loop over the records skips the rest. */
function overrideRecords(overrides: JsonObject): OverrideRecord[] {
  return Object.entries(overrides).flatMap(([key, record]) => isObject(record) ? [overrideRecord(key, record)] : []);
}

function baseItem(raw: JsonValue): BaseItem {
  const item = object(raw), observed = object(item.observed);
  const isRoom = defaulted(item, 'is_room', false), on = defaulted(item, 'on', true), effect = defaulted(item, 'effect', 'Normal light');
  const brightness = item.brightness, color = item.color;
  return {
    isRoom: carry(isRoom),
    isRoomTruthy: jinjaTruthy(isRoom),
    area: String(item.area),
    ignored: Array.isArray(item.ignore_overrides) ? item.ignore_overrides.filter((key): key is string => typeof key === 'string') : [],
    period: carryOptional(item.period),
    periodIsNight: item.period === 'night',
    on: carry(on),
    onTruthy: jinjaTruthy(on),
    transition: carry(defaulted(item, 'transition', 3)),
    effect: optionalString(effect),
    effectInstance: item.effect_instance === undefined ? undefined : carry(item.effect_instance),
    effectChannels: item.effect_channels === undefined ? undefined : Array.isArray(item.effect_channels) ? item.effect_channels.filter(isChannel) : [],
    anchorsPresent: isObject(item.day) && isObject(item.cosy),
    day: () => anchor(item.day),
    cosy: () => anchor(item.cosy),
    color: (): Color => canonicalColor(color),
    brightness: carryOptional(brightness),
    claims: {
      observedBrightness: constantClaim(observed.brightness === undefined ? brightness : observed.brightness, undefined),
      observedColor: constantClaim(observed.color === undefined ? color : observed.color, undefined),
      brightness: constantClaim(brightness, undefined),
      color: constantClaim(color, undefined),
    },
  };
}

function effectChannels(catalog: JsonObject, name: string | undefined): Channel[] {
  const definition = name === undefined ? {} : object(object(catalog.effects)[name]);
  const channels = definition.channels;
  return Array.isArray(channels) && channels.length > 0 && channels.every(isChannel) ? channels.filter(isChannel) : [];
}

/**
 * `effects_resolve`'s arguments. Every container is read leniently (`object`,
 * `Array.isArray`), as the inline reads did, so nothing raises here.
 *
 * `warm_end` is read by `warmEndArgument` (`src/parse/gradient.ts`), the
 * same reader `effects_gradient_plan` uses: the field default only when
 * absent, read where the resolver first lists it in a gradient signature.
 */
export function parseResolveArgs(args: JsonObject): ResolveArgs {
  const base = object(args.base), overrides = object(args.overrides), catalog = object(args.catalog);
  const privateRooms = Array.isArray(args.private) ? args.private : [];
  const power = object(args.power), gradients = object(args.gradients);
  return {
    targets: Object.entries(base).map(([target, item]) => ({ target, item: baseItem(item) })),
    records: overrideRecords(overrides),
    channelsOf: name => effectChannels(catalog, name),
    adjustsByGradient: processor => defaulted(object(object(catalog.processors)[processor]), 'remote_adjustment', processor === 'Normal light' ? 'gradient' : 'ignore') === 'gradient',
    private: privateRooms.filter((room): room is string => typeof room === 'string'),
    power: area => carry(defaulted(power, area, true)),
    gradient: (target, signature) => {
      const cached = gradients[target];
      return validGradient(cached, signature) ? cached.curve : undefined;
    },
    warmEnd: warmEndArgument(args, 'effects_resolve'),
    sara: jinjaTruthy(args.sara),
  };
}

/**
 * The newest remote input stream for a room, over a raw override mapping. For
 * `ls_remote_plan`, whose records are not parsed yet; the resolver itself
 * calls `latestStream` with the records it parsed.
 */
export function latestRemoteKey(records: JsonObject, room: string): string {
  return latestStream(overrideRecords(records).sort((a, b) => lexical(a.key, b.key)), room);
}
