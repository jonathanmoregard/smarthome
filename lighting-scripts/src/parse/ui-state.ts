/**
 * Parsing for the UI mirror (`effects_ui_sync`, `effects_ui_catalog`) and
 * `ls_range_save`.
 *
 * The UI rows and discovery rows are the catalog's deliberately raw lists
 * (`Catalog.ui_rows`/`ui_discovery`), so their elements are parsed here, one row
 * per loop iteration, with every raise in the order the inline reads made it.
 * The runtime sensor's targets and assignments are read through a lenient
 * {@link UiTargetView}: only the handful of fields the mirror reads, each with
 * the exact type test the inline code applied, so nothing compares differently.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaOr, jinjaString, jinjaTruthy, object, parseFinite, requireBoolean, requireObject, requireString } from '../runtime/parse.ts';
import { carry, reveal } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { jinjaListOf, saved, strings } from './accessors.ts';
import { percentRangeOf, toSwitchId } from './ids.ts';
import type { SwitchId } from '../domain/types/ids.ts';
import type { PercentRange } from '../domain/types/light.ts';

const runtime = 'sensor.ls_effects_runtime';

/**
 * A UI row collection the catalog must name. Absence is an error here, not an
 * empty list: a catalog with no rows would otherwise publish nothing and look
 * like a working sync.
 */
function rows(ctx: HouseView, key: 'ui_rows' | 'ui_discovery'): JsonValue[] {
  const value = ctx.catalog[key];
  if (value === undefined) throw new Error(`Missing runtime catalog.${key}`);
  return value;
}

function requireStringValue(value: JsonValue | undefined, context: string): string {
  return requireString({ value: value === undefined ? null : value }, 'value', context);
}

/** Captured rows use an absent key or an empty string to mean no profile store. */
function optionalStoreId(value: JsonValue | undefined, context: string): string | undefined {
  if (value === undefined) return undefined;
  const store = requireStringValue(value, context);
  return store.length === 0 ? undefined : store;
}

/**
 * One UI row. The rows are the catalog's, so `source` and `proxy` must be text:
 * a row without them is a configuration error, refused here.
 */
export interface UiRow {
  source: string;
  proxy: string;
  store: string | undefined;
  members: string[];
  /** The row's topic for a channel, when the topics mapping holds a string there. */
  topic(channel: string): string | undefined;
}

/** The `ui_rows` list, each row parsed as the loop reaches it. */
export function uiRows(ctx: HouseView): Array<() => UiRow> {
  return rows(ctx, 'ui_rows').map(raw => () => {
    const row = object(raw);
    const source = requireString(row, 'source', 'effects_ui_sync.row'), proxy = requireString(row, 'proxy', 'effects_ui_sync.row');
    // The store raises before the members do.
    const store = optionalStoreId(row.store, 'effects_ui_sync.row.store');
    const members = strings(row.members), topics = object(row.topics);
    return {
      source, proxy, store, members,
      topic: channel => {
        const topic = topics[channel];
        return typeof topic === 'string' ? topic : undefined;
      },
    };
  });
}

/** A display colour as the mirror reads it: an rgb triple and its MQTT text. */
export interface Rgb { text: string; value: Verbatim }

function rgbOf(value: JsonValue | undefined): Rgb | undefined {
  return Array.isArray(value) && value.length === 3 ? { text: value.join(','), value: carry(value) } : undefined;
}

/**
 * Which colour a display mapping names: `'kelvin' in display` first, then
 * `'rgb' in display`. The key decides the branch whatever its value is; the
 * value is then read with the exact test the mirror applies (a number; a
 * three-element list), so a malformed value fails that test as it did inline.
 */
export type Display =
  | { kind: 'kelvin'; kelvin: number | undefined }
  | { kind: 'rgb'; rgb: Rgb | undefined }
  | { kind: 'neither' };

function displayOf(value: JsonObject): Display {
  if ('kelvin' in value) return { kind: 'kelvin', kelvin: typeof value.kelvin === 'number' ? value.kelvin : undefined };
  if ('rgb' in value) return { kind: 'rgb', rgb: rgbOf(value.rgb) };
  return { kind: 'neither' };
}

/** {@link displayOf} for a member's carried constant colour. */
export function displayOfColour(colour: Verbatim): Display {
  return displayOf(object(reveal(colour)));
}

/**
 * A runtime target or assignment, read leniently: a non-mapping is `{}`, a
 * non-mapping claim has no fields.
 */
export interface UiTargetView {
  /** Effects claimed on brightness then colour (Jinja-truthy names only), `String`ed. */
  claimEffects: string[];
  /** The entry's own Jinja-truthy `effect`, `String`ed, unless it is 'Normal light'. */
  effect: string | undefined;
  level: number | undefined;
  brightness: number | undefined;
  /** The colour claim's value when it is a constant mapping, carried for comparison. */
  constantColour: Verbatim | undefined;
  /** The colour claim's display when the claim is a constant (a non-mapping value is `neither`). */
  display: Display | undefined;
  /** Whether the entry has any key at all. */
  populated: boolean;
}

function uiTargetView(raw: JsonValue | undefined): UiTargetView {
  const entry = object(raw), claimEffects: string[] = [];
  for (const channel of ['brightness', 'color']) {
    const claim = object(entry[channel]);
    // Captured `claim.get('effect')` sits in a Jinja boolean position, where
    // an empty container is false, so `jinjaTruthy` keeps out '' and an empty
    // list or mapping. A truthy effect that is not text still goes into the
    // names as its printed text, the way the captured `fx.names+[claim.effect]`
    // publishes it, and `jinjaString` prints it as Python does (`True`, not
    // `true`). A container is the one input it does not match (Python prints
    // its repr, or raises in `unique`); no producer writes one, since the
    // resolver's effect claims name catalog effects, which are text. The same
    // holds for `entry.effect`.
    if (claim.kind === 'effect' && jinjaTruthy(claim.effect)) claimEffects.push(jinjaString(claim.effect));
  }
  const colour = object(entry.color);
  return {
    claimEffects,
    effect: jinjaTruthy(entry.effect) && entry.effect !== 'Normal light' ? jinjaString(entry.effect) : undefined,
    level: typeof entry.level === 'number' ? entry.level : undefined,
    brightness: typeof entry.brightness === 'number' ? entry.brightness : undefined,
    constantColour: colour.kind === 'constant' && isObject(colour.value) ? carry(colour.value) : undefined,
    display: colour.kind === 'constant' ? displayOf(object(colour.value)) : undefined,
    populated: Object.keys(entry).length > 0,
  };
}

/** `sensor.ls_effects_runtime`'s targets and assignments, read once. */
export interface RuntimeTargets {
  /** A member's target, else its assignment: plain-object lookups, as inline. */
  member(entity: string): UiTargetView;
  target(key: string): UiTargetView;
}

export function runtimeTargets(ctx: HouseView): RuntimeTargets {
  const targets = object(ctx.attr(runtime, 'targets'));
  const assignments = object(ctx.attr(runtime, 'assignments'));
  return {
    member: entity => uiTargetView(Object.hasOwn(targets, entity) ? targets[entity] : assignments[entity]),
    target: key => uiTargetView(targets[key]),
  };
}

/** What a light entity's attributes say, read with the mirror's type tests. */
export interface LampReading {
  brightness: number | undefined;
  colourTemp: boolean;
  kelvin: number | undefined;
  rgb: Rgb | undefined;
}

export function lampReading(ctx: HouseView, entity: string): LampReading {
  const brightness = ctx.attr(entity, 'brightness'), kelvin = ctx.attr(entity, 'color_temp_kelvin');
  return {
    brightness: typeof brightness === 'number' ? brightness : undefined,
    colourTemp: ctx.attr(entity, 'color_mode') === 'color_temp',
    kelvin: typeof kelvin === 'number' ? kelvin : undefined,
    rgb: rgbOf(ctx.attr(entity, 'rgb_color')),
  };
}

/** A proxy colour temperature that is not a number: 0, the captured read's default for no value. */
const NO_PROXY_KELVIN = 0;

/**
 * The proxy's `color_temp_kelvin`: a number (or numeric text) is itself, and
 * anything else -- absent, `null`, unreadable -- is {@link NO_PROXY_KELVIN}
 * (2026-11-21: a value a person can edit recovers to a default). Never raises.
 */
export function proxyKelvin(ctx: HouseView, proxy: string): number {
  const kelvin = parseFinite(ctx.attr(proxy, 'color_temp_kelvin'));
  return kelvin === undefined ? NO_PROXY_KELVIN : kelvin;
}

/**
 * The colour the proxy reports, or none. Home Assistant reports `rgb_color:
 * null` for a light showing no colour (off, or not in a colour mode); the
 * captured `rgb_color or ...` treats every Jinja-falsy value that way, and a
 * reported value goes through Jinja's `list`.
 */
function proxyRgb(ctx: HouseView, proxy: string): JsonValue[] | undefined {
  const reported = ctx.attr(proxy, 'rgb_color');
  // A value Jinja cannot list shows no triple either (the captured `| list` raises on it).
  return reported === undefined || !jinjaTruthy(reported) ? undefined : jinjaListOf(reported);
}

/**
 * Does the proxy show this triple? Captured `(state_attr(proxy,'rgb_color') or []) | list == rgb | list`:
 * a proxy showing no colour shows no triple.
 */
export function proxyShowsRgb(ctx: HouseView, proxy: string, rgb: Rgb): boolean {
  const shown = proxyRgb(ctx, proxy);
  return shown !== undefined && isDeepStrictEqual(shown, reveal(rgb.value));
}

/** A row's stored profile: whether it names effect channels, and its effect. */
export interface UiProfile {
  namesEffectChannels: boolean;
  effect: string;
}

/** The effect a saved profile with no usable `effect` shows (the captured `.get` default). */
const DEFAULT_PROFILE_EFFECT = 'Normal light';

/**
 * A saved profile's effect. A saved value, read leniently with a default (user
 * directive 2026-11-19): an absent key is the captured
 * `profile.get('effect','Normal light')` default, and a present non-string
 * (null, a number, a boolean, a list, a mapping) takes the same default rather
 * than raising. The captured mirror would publish such a value as its Python
 * repr, which no effect list holds; a non-string names no catalog effect, so the
 * lamp's own resolver claims no effect channels for it, and 'Normal light' is
 * what the lamp actually shows. It never raises.
 */
function savedEffect(profile: JsonObject): string {
  return typeof profile.effect === 'string' ? profile.effect : DEFAULT_PROFILE_EFFECT;
}

/** The channels a saved profile with no `effect_channels` key claims (the captured `.get` default). */
const DEFAULT_PROFILE_EFFECT_CHANNELS: JsonValue = ['brightness', 'color'];

/**
 * Does a saved profile name any effect channels? A saved value, read
 * leniently with a default (user directive 2026-11-19): the captured mirror
 * reads `profile.get('effect_channels', ['brightness','color'])` under Jinja
 * truthiness, so an absent key takes the default (true), and any present value
 * -- null, a non-list, a list of non-strings -- is its Jinja truthiness. It
 * never raises.
 */
function namesEffectChannels(profile: JsonObject): boolean {
  const channels = Object.hasOwn(profile, 'effect_channels') ? profile.effect_channels : DEFAULT_PROFILE_EFFECT_CHANNELS;
  return jinjaTruthy(channels);
}

export function uiProfile(ctx: HouseView, store: string): UiProfile {
  const pr = saved(ctx, store);
  return {
    namesEffectChannels: namesEffectChannels(pr),
    effect: savedEffect(pr),
  };
}

/** One discovery row, from the catalog: its entity and its config's unique id must be text, or the row is refused. */
export interface DiscoveryRow {
  entity: string;
  uniqueId: string;
  /** The stored discovery config, republished with `effect_list` replaced. */
  config: Verbatim;
}

export function discoveryRows(ctx: HouseView): DiscoveryRow[] {
  return rows(ctx, 'ui_discovery').map(raw => {
    const row = object(raw), at = 'effects_ui_catalog.row';
    const entity = requireString(row, 'entity', at), config = requireObject(row, 'config', at);
    return { entity, uniqueId: requireString(config, 'unique_id', `${at}.config`), config: carry(config) };
  });
}

export function parseUiSyncArgs(args: JsonObject): { dryRun: boolean; force: boolean } {
  return {
    dryRun: args.dry_run === undefined ? false : requireBoolean(args.dry_run, 'effects_ui_sync.dry_run'),
    force: args.force === undefined ? false : requireBoolean(args.force, 'effects_ui_sync.force'),
  };
}

/** A range bound as given: absent, or the stored value (only a number is a bound). */
export type RangeBound = string | number | boolean | null | Verbatim | undefined;

/**
 * Own Range's ends, as a percent range: both numbers (a boolean is not one
 * here, unlike Jinja's `is number`), with `0 <= low <= high <= 100`; otherwise
 * `undefined`, and the request is refused.
 */
export function ownRange(low: RangeBound, high: RangeBound): PercentRange | undefined {
  return percentRangeOf(low, high);
}

function bound(value: JsonValue | undefined): RangeBound {
  return Array.isArray(value) || isObject(value) ? carry(value) : value;
}

export interface RangeSaveRequest {
  /** The switch to configure; none when the request names none or `''` (captured `default('')`). */
  entity: SwitchId | undefined;
  profile: string;
  dryRun: boolean;
  minimum: RangeBound;
  maximum: RangeBound;
}

export function parseRangeSaveArgs(args: JsonObject): RangeSaveRequest {
  return {
    entity: args.entity === undefined ? undefined : switchOfText(requireString(args, 'entity', 'ls_range_save')),
    profile: args.profile === undefined ? 'bright' : requireString(args, 'profile', 'ls_range_save'),
    dryRun: args.dry_run === undefined ? false : requireBoolean(args.dry_run, 'ls_range_save.dry_run'),
    minimum: bound(args.minimum),
    maximum: bound(args.maximum),
  };
}

function switchOfText(text: string): SwitchId | undefined {
  return text === '' ? undefined : toSwitchId(text);
}

/**
 * The switch as the captured script names it in every read and in its answer:
 * the switch's entity, or `''` when the request names none (`default('')`).
 */
export function switchText(entity: SwitchId | undefined): string {
  return entity === undefined ? '' : entity;
}

/** `ls_range_save`'s answer: the decision, with no switch spelled `''` as the captured script answers it. */
export function rangeSaveAnswer(result: { valid: boolean; errors: string[]; entity: SwitchId | undefined; config: JsonObject }): JsonObject {
  return { valid: result.valid, errors: result.errors, entity: switchText(result.entity), config: result.config };
}

/** A switch's stored range bounds, read leniently from `sensor.ls_overrides`. */
export function storedRangeBounds(ctx: HouseView, entity: string): { min: RangeBound; max: RangeBound } {
  const previous = object(object(ctx.attr('sensor.ls_overrides', 'switch_ranges'))[entity]);
  return { min: bound(previous.min), max: bound(previous.max) };
}

/**
 * Is the light on/off only? Captured `(state_attr(e,'supported_color_modes') or []) != ['onoff']`:
 * absent or Jinja-falsy is no modes, and any other value is on/off only exactly
 * when it equals `['onoff']` -- a non-list simply compares unequal, nothing raises.
 */
export function onOffOnly(ctx: HouseView, entity: string): boolean {
  return isDeepStrictEqual(jinjaOr(ctx.attr(entity, 'supported_color_modes'), []), ['onoff']);
}
