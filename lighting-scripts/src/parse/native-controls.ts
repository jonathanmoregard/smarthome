/**
 * Parsing for `effects_native_plan` (a native HA `light.turn_on` captured as
 * override records) and `effects_set` (a UI proxy control).
 *
 * Both read three raw documents -- the service data or control value, the
 * catalog, and the current plan -- and every read here keeps the inline
 * spelling's exact semantics:
 *
 * - The catalog's `groups` and `effects` keep their `key in mapping` tests and
 *   plain-object lookups, so a name the mapping inherits is found as before.
 * - Plan targets are read leniently (`object(...)`) or strictly
 *   (`optionalObject`) where each inline read did, and a target's document is
 *   carried for the one read that forwards part of it (the underlying colour).
 * - A field whose read can raise is a thunk, called where the inline read sat:
 *   the brightness and colour components are read per scope item, the stamp
 *   only when a record is written.
 * - Pass-through values (an absolute brightness, a Kelvin value, the
 *   underlying colour, the stamp) are carried, never narrowed.
 */
import type { JsonObject, JsonValue, ScriptContext } from '../runtime/context.ts';
import {
  jinjaFloat, jinjaInt, jinjaString, jinjaTruthy, lazy, ParseError, parsePythonNumeric, requireArray, requireNumber, requireObject,
  requireString,
} from '../runtime/parse.ts';
import { carry, carryOptional, reveal } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { RGB } from '../domain/scale.ts';

function selector(container: JsonObject, key: string, split = false): string[] {
  const value = container[key];
  if (value === undefined) return [];
  const values = typeof value === 'string' ? (split ? value.split(',') : [value]) : requireArray(container, key, 'effects_native_plan.sd');
  return values.map((item, index) => requireString({ item }, 'item', `effects_native_plan.sd.${key}[${index}]`));
}
function stringArray(value: JsonValue | undefined, context: string): string[] {
  return requireArray({ value: value ?? [] }, 'value', context).map((item, index) =>
    requireString({ item }, 'item', `${context}[${index}]`));
}
function numberArray(container: JsonObject, key: string, length: 2, context: string): [number, number];
function numberArray(container: JsonObject, key: string, length: 3, context: string): RGB;
function numberArray(container: JsonObject, key: string, length: 4 | 5, context: string): number[];
function numberArray(container: JsonObject, key: string, length: number, context: string): number[] {
  const values = requireArray(container, key, context);
  if (values.length !== length) throw new ParseError(`${context}.${key} must contain ${length} values`);
  const parsed = values.map((value, index) => requireNumber({ value }, 'value', `${context}.${key}[${index}]`));
  if (length === 2) return [parsed[0]!, parsed[1]!];
  if (length === 3) return [parsed[0]!, parsed[1]!, parsed[2]!];
  return parsed;
}
function requiredValue(container: JsonObject, key: string, context: string): JsonValue {
  const value = container[key];
  if (value === undefined) throw new ParseError(`${context}.${key} is required`);
  return value;
}

/** The catalog's `groups`: `source in groups`, and a group's members read on demand. */
export interface CatalogGroups {
  has(source: string): boolean;
  /** An absent group has no members; a present one must be a string list. */
  members(source: string): string[];
}
/** The catalog's `effects`: their names, `name in effects`, and an effect's channels on demand. */
export interface CatalogEffects {
  names: string[];
  has(name: string): boolean;
  channels(effect: string): string[];
}
export interface NativeCatalog {
  members: Record<string, string[]>;
  groups: CatalogGroups;
  effects: CatalogEffects;
}

export function parseNativeCatalog(value: JsonValue | undefined, context: string): NativeCatalog {
  const catalog = value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
  const members = requireObject(catalog, 'members', context);
  const parsedMembers = Object.fromEntries(Object.entries(members).map(([lamp, physical]) =>
    [lamp, stringArray(physical, `${context}.members.${lamp}`)]));
  const groups = requireObject(catalog, 'groups', context);
  const effects = requireObject(catalog, 'effects', context);
  return {
    members: parsedMembers,
    groups: {
      has: source => source in groups,
      members: source => groups[source] === undefined ? [] : stringArray(groups[source], `catalog.groups.${source}`),
    },
    effects: {
      names: Object.keys(effects),
      has: name => name in effects,
      channels: effect => {
        const definition = requireObject(effects, effect, 'catalog.effects');
        return stringArray(definition.channels, `catalog.effects.${effect}.channels`);
      },
    },
  };
}

/** One plan target: whether it holds anything, its level on demand, and its document carried. */
export interface PlanTarget {
  populated: boolean;
  level(context: string): number;
  document: Verbatim;
}
/** A plan's base or resolved targets. */
export interface PlanTargets {
  /** `object(targets[key])` populated? A non-mapping is empty. */
  populatedLeniently(key: string): boolean;
  /** `targets[key]`: absent is `{}`, a present non-mapping raises. */
  target(key: string, context: string): PlanTarget;
}

function planTargets(targets: JsonObject): PlanTargets {
  return {
    populatedLeniently: key => {
      const value = targets[key];
      return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
    },
    target: (key, context) => {
      const target = targets[key] === undefined ? {} : requireObject(targets, key, context);
      return {
        populated: Object.keys(target).length > 0,
        level: levelContext => requireNumber(target, 'level', levelContext),
        document: carry(target),
      };
    },
  };
}

/**
 * The colour a reset to normal light returns to: the base colour under Sara,
 * an effect's own `base` (else the base colour), otherwise the resolved value.
 * Carried as read, absent included.
 */
export function underlyingColour(base: PlanTarget, resolved: PlanTarget): Verbatim {
  const baseDocument = reveal(base.document) as JsonObject;
  const color = requireObject(reveal(resolved.document) as JsonObject, 'color', 'resolved target');
  return carryOptional(color.policy === 'sara'
    ? baseDocument.color
    : color.kind === 'effect' ? (color.base === undefined ? baseDocument.color : color.base) : color.value);
}

export interface NativeCurrent { baseTargets: PlanTargets; resolvedTargets: PlanTargets }
export interface LazyNativeCurrent { baseTargets: PlanTargets; resolvedTargets: () => PlanTargets }

export function parseNativeCurrent(value: JsonValue | undefined, context: string): NativeCurrent {
  const current = value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
  const plan = requireObject(current, 'plan', context);
  const resolved = requireObject(plan, 'resolved', `${context}.plan`);
  return {
    baseTargets: planTargets(requireObject(plan, 'base', `${context}.plan`)),
    resolvedTargets: planTargets(requireObject(resolved, 'targets', `${context}.plan.resolved`)),
  };
}
function parseLazyCurrent(value: JsonValue | undefined, context: string): LazyNativeCurrent {
  const current = value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
  const plan = requireObject(current, 'plan', context);
  return {
    baseTargets: planTargets(requireObject(plan, 'base', `${context}.plan`)),
    resolvedTargets: lazy(() => {
      const resolved = requireObject(plan, 'resolved', `${context}.plan`);
      return planTargets(requireObject(resolved, 'targets', `${context}.plan.resolved`));
    }),
  };
}

/**
 * The brightness a service call asks for, by the first key it holds. An
 * absolute value (`brightness`, `white`) is kept only when it is a number or a
 * boolean -- the only values the plan ever claims -- and the computed kinds
 * read their operand where the plan computes them.
 */
export type BrightnessRequest =
  | { kind: 'none' }
  | { kind: 'absolute'; value: number | boolean | undefined }
  | { kind: 'percent'; percent: () => number }
  | { kind: 'step'; step: () => number }
  | { kind: 'step percent'; step: () => number };

/** The colour a service call asks for, by the first key it holds; components are read on demand. */
export type ColourRequest =
  | { kind: 'kelvin'; kelvin: Verbatim }
  | { kind: 'rgb'; rgb: () => RGB }
  | { kind: 'hs'; hs: () => [number, number] }
  | { kind: 'xy'; xy: () => [number, number] }
  | { kind: 'rgbw' | 'rgbww'; channels: () => number[] }
  | { kind: 'name'; name: string }
  | { kind: 'white' }
  | { kind: 'none' };

export interface ServiceData {
  brightness: BrightnessRequest;
  colour: ColourRequest;
  /** `effect | string`, when the call names one. */
  effect: string | undefined;
}

function absolute(value: JsonValue | undefined): number | boolean | undefined {
  return typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

function serviceData(sd: JsonObject): ServiceData {
  const at = 'effects_native_plan.sd';
  const brightness: BrightnessRequest =
    'brightness' in sd ? { kind: 'absolute', value: absolute(sd.brightness) }
      : 'brightness_pct' in sd ? { kind: 'percent', percent: () => requireNumber(sd, 'brightness_pct', at) }
        : 'brightness_step' in sd ? { kind: 'step', step: () => requireNumber(sd, 'brightness_step', at) }
          : 'brightness_step_pct' in sd ? { kind: 'step percent', step: () => requireNumber(sd, 'brightness_step_pct', at) }
            : 'white' in sd ? { kind: 'absolute', value: absolute(sd.white) }
              : { kind: 'none' };
  const colour: ColourRequest =
    'color_temp_kelvin' in sd ? { kind: 'kelvin', kelvin: carryOptional(sd.color_temp_kelvin) }
      : 'kelvin' in sd ? { kind: 'kelvin', kelvin: carryOptional(sd.kelvin) }
        : 'rgb_color' in sd ? { kind: 'rgb', rgb: () => numberArray(sd, 'rgb_color', 3, at) }
          : 'hs_color' in sd ? { kind: 'hs', hs: () => numberArray(sd, 'hs_color', 2, at) }
            : 'xy_color' in sd ? { kind: 'xy', xy: () => numberArray(sd, 'xy_color', 2, at) }
              : 'rgbw_color' in sd ? { kind: 'rgbw', channels: () => numberArray(sd, 'rgbw_color', 4, at) }
                : 'rgbww_color' in sd ? { kind: 'rgbww', channels: () => numberArray(sd, 'rgbww_color', 5, at) }
                  : 'color_name' in sd ? { kind: 'name', name: jinjaString(sd.color_name) }
                    : 'white' in sd ? { kind: 'white' }
                      : { kind: 'none' };
  return { brightness, colour, effect: 'effect' in sd ? jinjaString(sd.effect) : undefined };
}

/** A lamp's Kelvin range, `| int(6500)` / `| int(2000)` as the captured adapter reads it. */
export function lampKelvinRange(ctx: ScriptContext, lamp: string): { max: number; min: number } {
  return {
    max: jinjaInt(ctx.attr(lamp, 'max_color_temp_kelvin'), 6500),
    min: jinjaInt(ctx.attr(lamp, 'min_color_temp_kelvin'), 2000),
  };
}

/** A group or zone's children, `String`ed, when the attribute is a list. */
export function groupChildren(ctx: ScriptContext, entity: string, zone: boolean): string[] | undefined {
  const children = ctx.attr(entity, zone ? 'persons' : 'entity_id');
  return Array.isArray(children) ? children.map(String) : undefined;
}

export interface NativePlanArgs {
  sd: ServiceData;
  areas: string[];
  devices: string[];
  labels: string[];
  requested: string[];
  catalog: NativeCatalog;
  current: () => LazyNativeCurrent;
  /** The raw stamp, read only when a record is written. */
  stamp: () => Verbatim;
}

// Captured effects_native_plan reads sd/catalog/current/stamp raw (19/8/3/5
// sites). Selector fields entity_id/area_id/device_id/label_id use missing
// empty-list fallbacks before iteration; brightness_pct/brightness_step/
// brightness_step_pct and hs/xy/rgbw/rgbww components are raw arithmetic or
// indexed values, so they parse strictly. color_temp_kelvin/kelvin are raw
// pass-through payloads. The two HA Kelvin attributes use `| int(6500)` /
// `| int(2000)`. Nested members/groups/effects and plan/base/resolved/targets
// are indexed raw structures. Stamp is a raw pass-through payload; current,
// its resolved subtree, and stamp stay lazy until selected work needs them.
export function parseNativePlanArgs(args: JsonObject): NativePlanArgs {
  const sd = requireObject(args, 'sd', 'effects_native_plan');
  return {
    sd: serviceData(sd),
    areas: selector(sd, 'area_id'),
    devices: selector(sd, 'device_id'),
    labels: selector(sd, 'label_id'),
    requested: selector(sd, 'entity_id', true),
    catalog: parseNativeCatalog(args.catalog, 'effects_native_plan.catalog'),
    current: lazy(() => parseLazyCurrent(args.current, 'effects_native_plan.current')),
    stamp: lazy(() => carry(requiredValue(args, 'stamp', 'effects_native_plan'))),
  };
}

/**
 * A raw control value as the range checks and the emitted data read it.
 *
 * `inRange` is not `optionalFinite`: an un-parseable string must answer `false`
 * rather than raise, because this is a validation that collects error
 * messages. It is `parsePythonNumeric` rather than `parseFinite` because the
 * oracle accepts `value: true` as brightness 1 -- `bool` is an `int` subclass
 * in Python -- and a parity test covers it.
 */
export interface ControlScalar {
  inRange(low: number, high: number): boolean;
  /** `value | int` */
  int: number;
}
export interface ControlValue extends ControlScalar {
  /** The value as given, for comparison with literals. */
  raw: JsonValue | undefined;
  /** `value | string` */
  text: string;
  /** `value | float` */
  float: number;
  /** A string's comma-separated parts, or a list's elements; otherwise `undefined`. */
  components: ControlScalar[] | undefined;
  /** The value as a required string, raising as the inline read did. */
  string(context: string): string;
}

function controlScalar(value: JsonValue | undefined): ControlScalar {
  const parsed = parsePythonNumeric(value);
  return {
    inRange: (low, high) => parsed !== undefined && low <= parsed && parsed <= high,
    int: jinjaInt(value),
  };
}

function controlValue(value: JsonValue | undefined): ControlValue {
  const parts = typeof value === 'string' ? value.split(',') : value;
  return {
    ...controlScalar(value),
    raw: value,
    text: jinjaString(value),
    float: jinjaFloat(value),
    components: Array.isArray(parts) ? parts.map(controlScalar) : undefined,
    string: context => value === undefined ? requireString({}, 'value', context) : requireString({ value }, 'value', context),
  };
}

export interface SetArgs {
  source: string;
  attribute: string;
  /** The control value, 'Normal Light' already read as 'Normal light' for an effect. */
  value: ControlValue;
  dryRun: boolean;
}

// Captured effects_set reads source/attribute raw (11/20 sites), value raw
// 18 times plus `| float(-1)` four times and `| int` twice, and dry_run once
// through `| default(false)`. Preserve both numeric filters: float for range
// checks/temperature arithmetic, int for emitted brightness/RGB values.
export function parseSetArgs(args: JsonObject): SetArgs {
  const source = requireString(args, 'source', 'effects_set');
  const attribute = requireString(args, 'attribute', 'effects_set');
  return {
    source,
    attribute,
    value: controlValue(attribute === 'effect' && args.value === 'Normal Light' ? 'Normal light' : args.value),
    dryRun: jinjaTruthy(args.dry_run),
  };
}
