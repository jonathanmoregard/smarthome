/**
 * Parsing for the `state-store` handlers: `ls_store`, `ls_override_block`,
 * `ls_clear_overrides` and `ls_sara_mode`, plus the Jinja spellings the
 * module's scripts share.
 *
 * Every raise stays where the inline read made it: the scope's unhashable
 * check is a lookup function the domain calls at the lookup, after the
 * `ls_apply` dry run, never during argument parsing.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { isObject, jinjaFloat, jinjaInt, jinjaString, object, ParseError, requireString } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { BlockTarget, EffectChannels, OverrideBlockArgs, ProfilePatch, ScheduledBlocks, StoredProfile, StoreProfileArgs, ViaArgs } from '../domain/state-store.ts';
import { opaqueMap, storedFact } from './overrides.ts';

/** Jinja `~` uses an empty string for Undefined, unlike the `| string` filter. */
export function concatString(value: JsonValue | undefined): string {
  return value === undefined ? '' : jinjaString(value);
}

/**
 * The key a Jinja mapping lookup uses. Python mappings reject the unhashable
 * JSON container types as keys, so those raise; every other non-string misses,
 * because a JSON mapping's keys are all strings.
 */
export function mappingKey(key: JsonValue | undefined, context: string): string | undefined {
  if (Array.isArray(key) || isObject(key)) {
    throw new ParseError(`${context} is unhashable for Jinja mapping lookup`);
  }
  return typeof key === 'string' ? key : undefined;
}

/** Captured via has `| default('app')` sites: only an absent via is replaced. */
function via(args: JsonObject): Verbatim {
  return carry(args.via === undefined ? 'app' : args.via);
}

function blockTarget(value: JsonValue | undefined): BlockTarget {
  return {
    isHouse: value === 'house',
    record: carry(value ?? null),
    keyText: concatString(value),
    key: () => mappingKey(value, 'ls_override_block.scope'),
  };
}

/** A room the house scope expanded to: always a plain string key. */
export function roomTarget(room: string): BlockTarget {
  return blockTarget(room);
}

/**
 * Captured scope is raw twice (list construction and comparison), block has
 * one `| lower`, and via has two `| default('app')` sites. Raw scope remains
 * raw; the case filter coerces through Jinja string spelling.
 */
export function parseOverrideBlockArgs(args: JsonObject): OverrideBlockArgs {
  return {
    scope: blockTarget(args.scope),
    block: jinjaString(args.block).toLowerCase(),
    via: via(args),
  };
}

export function parseViaArgs(args: JsonObject): ViaArgs {
  return { via: via(args) };
}

/**
 * The block each scope is scheduled to, from the `ls_apply` dry run, read with
 * the captured `object(object(.plan).sched)` leniency. A scheduled value is only
 * ever compared with the requested block, a string, so a non-string value is
 * `undefined`: it compares unequal exactly as the raw value did.
 */
export function scheduledBlocks(result: JsonValue): ScheduledBlocks {
  const schedule = object(object(object(result).plan).sched);
  return key => {
    if (key === undefined) return undefined;
    const value = schedule[key];
    return typeof value === 'string' ? value : undefined;
  };
}

/** Home Assistant's custom `| bool` filter, measured from the pinned oracle. */
export function haBoolean(value: JsonValue | undefined, context: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isNaN(value) ? true : value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enable'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disable'].includes(normalized)) return false;
  }
  throw new ParseError(`${context} is not accepted by Home Assistant's bool filter`);
}

/**
 * `is defined and is not none` -- the captured guard on every optional `ls_store`
 * field. Absent and explicit none are indistinguishable to it, and both leave
 * the field out of the patch entirely, so one predicate covers both.
 */
function supplied(value: JsonValue | undefined): boolean {
  return value !== undefined && value !== null;
}

/** `(1000000 / (mireds | float)) | int` */
function miredKelvin(mireds: JsonValue | undefined): number {
  // The float filter yields 0.0 both for a zero and for anything it cannot
  // parse, and Python division by 0.0 raises ZeroDivisionError. JavaScript
  // instead produces Infinity or NaN, which `JSON.stringify` wrote to the store
  // as `"k":null` -- a saved profile claiming colour temperature with no value.
  const divisor = jinjaFloat(mireds);
  if (divisor === 0) {
    throw new ParseError('ls_store.mireds must convert to a kelvin value, got a zero divisor');
  }
  return jinjaInt(1_000_000 / divisor);
}

/** `h=hs[0] | float, s=hs[1] | float` */
function huePair(hs: JsonValue | undefined): { h: number; s: number } {
  // Subscripting past the end of a sequence, or into something that is not one,
  // yields Jinja Undefined, and `Undefined | float` is 0.0. `Number(undefined)`
  // was NaN, which serialized to null.
  const pair = Array.isArray(hs) ? hs : [];
  return { h: jinjaFloat(pair[0]), s: jinjaFloat(pair[1]) };
}

/**
 * Captured `store` is required and reaches `.startswith`, so it is a plain
 * string. Every other field is guarded `is defined and is not none`, which
 * makes absence and none identical, and each carries its own filter: `| bool`
 * for on/own, `| int` for brightness and kelvin, `| float` under a division
 * for mireds, `| float` per element for hs. The effect is stored as supplied.
 */
export function parseStoreProfile(args: JsonObject): StoreProfileArgs {
  return {
    // The captured tail evaluates `store.startswith('input_text.ls_lamp_')`,
    // which raises for a non-string. Nothing coerces it, so neither does this.
    entity: requireString(args, 'store', 'ls_store'),
    on: supplied(args.on) ? haBoolean(args.on, 'ls_store.on') : undefined,
    own: supplied(args.own) ? haBoolean(args.own, 'ls_store.own') : undefined,
    brightness: supplied(args.brightness) ? jinjaInt(args.brightness) : undefined,
    kelvin: supplied(args.kelvin) ? jinjaInt(args.kelvin)
      : supplied(args.mireds) ? miredKelvin(args.mireds) : undefined,
    hs: supplied(args.hs) ? huePair(args.hs) : undefined,
    releasesColour: supplied(args.kelvin) || supplied(args.mireds) || supplied(args.hs),
    effect: supplied(args.effect) ? storedFact(args.effect) : undefined,
  };
}

/**
 * `states(store) | from_json(default={})`, then the two `dict.get` reads.
 *
 * The `default={}` genuinely swallows a parse failure -- an unset or non-JSON
 * store reads as an empty profile -- so that fallback is faithful and stays. A
 * cache that parses to a non-mapping is a different case: the captured
 * `current.get(...)` raises on it, here, before the catalog is fetched.
 *
 * Both reads fall back only on an ABSENT key: an explicit null effect is a
 * value (it resolves no channels), and a present `effect_channels` that is not
 * a list is reported as such for the domain to refuse.
 */
export function cachedProfile(text: string, entity: string): StoredProfile {
  let parsed: JsonValue;
  try { parsed = JSON.parse(text) as JsonValue; } catch { parsed = {}; }
  if (!isObject(parsed)) {
    throw new ParseError(`ls_store.store entity ${entity} holds a non-mapping saved profile`);
  }
  // An own key of a parsed JSON document is never undefined; the explicit test
  // only tells the compiler what `hasOwn` already established.
  const effect = parsed.effect, channels = parsed.effect_channels;
  return {
    document: opaqueMap(parsed),
    activeEffect: Object.hasOwn(parsed, 'effect') && effect !== undefined ? storedFact(effect) : 'Normal light',
    effectChannels: !Object.hasOwn(parsed, 'effect_channels') ? 'absent'
      : Array.isArray(channels) ? channels.map(channel => storedFact(channel)) : 'non-list',
  };
}

/**
 * `catalog.effects.get(key, {}).get('channels', [])` over the RAW
 * `effects_catalog` result. The catalog is produced by `effects_catalog`, so a
 * missing channel list there is absence, not a malformed value. The key is
 * looked up when the domain asks, so an unhashable key raises there.
 */
export function catalogEffectChannels(result: JsonValue): EffectChannels {
  const effects = object(object(result).effects);
  return key => {
    const name = mappingKey(key, 'ls_store.effect');
    const channels = object(name === undefined ? undefined : effects[name]).channels;
    return Array.isArray(channels) ? channels.map(channel => storedFact(channel)) : [];
  };
}

/** The profile as the store entity holds it: `{...current, ...patch}`, serialised. */
export function storedProfileText(profile: StoredProfile, patch: ProfilePatch): string {
  return JSON.stringify({ ...profile.document, ...patch });
}
