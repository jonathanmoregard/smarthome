/**
 * Parsing for the controller handlers -- `ls_switch_plan`, `ls_plan`,
 * `ls_apply` and `ls_remote_command` -- and for the override sensor and cache
 * attributes `ls_plan` reads.
 *
 * `ls_plan`'s attribute reads are strict where the inline reads were
 * (`attributeMappingOr`: absent or Jinja-falsy is `{}`, any other non-mapping
 * raises), and each is a function the domain calls exactly where the inline
 * read sat, between the inter-handler calls. The documents `ls_plan` forwards
 * -- the override mapping, the active overrides, the cached gradients, the
 * power and switch-range mappings, the range defaults -- are carried. So is
 * whatever answered to `ls_plan` when `ls_apply` dry-runs it: that verbatim
 * pass-through is pinned by `tests/parity/test_bridge.py` (see
 * `tasks/ls-plan-design.md`).
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { isObject, jinjaTruthy, lazy, object, requireArray, requireBoolean, requireObject, requireString } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { RGB } from '../domain/scale.ts';
import { opaqueMap } from './overrides.ts';
import type { OpaqueMap } from './overrides.ts';
import { requireRgb, warmEndOr } from './scale.ts';
import { savedMappingOr } from './accessors.ts';
import { BUILT_IN_RANGES } from './planning.ts';
import type { ApplyArgs, PlanArgs, PlanOverrides, RemoteCommandArgs, SwitchInterval, SwitchPlanArgs } from '../domain/controller.ts';
import { toPercent, toRemoteSource, toRoomId, toSwitchId } from './ids.ts';
import { roomOfText } from './rooms.ts';

const lenientList = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];

/** Captured `{{ value|default(none) }}` forwarded to another script: the value unread, none when absent. */
function forwardedOrNone(value: JsonValue | undefined): Verbatim {
  return carry(value === undefined ? null : value);
}

function optionalScriptBoolean(value: JsonValue | undefined, context: string): boolean {
  return value === undefined ? false : requireBoolean(value, context);
}

/** A saved `sensor.ls_overrides` mapping, captured `attr or {}`, read by {@link savedMappingOr}. */
function attributeMappingOr(value: JsonValue | undefined): JsonObject {
  return savedMappingOr(value, {});
}

function planOverridesOf(value: JsonObject): PlanOverrides {
  return { document: carry(value), entries: opaqueMap(value) };
}

/** Captured `is number`: a finite number, or a boolean (Python's 0 or 1). */
const jinjaNumber = (v: JsonValue | undefined): v is number | boolean => typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v);
const asNumber = (v: number | boolean): number => typeof v === 'boolean' ? Number(v) : v;

/**
 * One switch rule's interval: `[min, max]` for a custom rule, else the
 * profile's default -- looked up only for a text profile, since
 * `defaults.get(profile,[])` finds no other key and raises on a container
 * (lenient saved-value directive: no range) -- and `undefined` unless a valid
 * 0-100 range.
 */
function switchRange(rule: JsonObject, defaults: JsonObject): SwitchInterval | undefined {
  const interval = rule.profile === 'custom' ? [rule.min, rule.max]
    : typeof rule.profile === 'string' ? lenientList(defaults[rule.profile]) : [];
  const first = interval[0], second = interval[1];
  if (interval.length !== 2 || !jinjaNumber(first) || !jinjaNumber(second)) return undefined;
  const low = asNumber(first), high = asNumber(second);
  if (!(0 <= low && low <= high && high <= 100)) return undefined;
  return { low: toPercent(low), high: toPercent(high), stored: [first, second] };
}

// Captured targets/defaults each use mapping.get once and ranges uses
// mapping.items once; all three therefore require real mappings. A rule and a
// room target are read leniently; the target's `on` is required only once its
// rule and target both apply.
export function parseSwitchPlanArgs(args: JsonObject): SwitchPlanArgs {
  const targets = requireObject(args, 'targets', 'ls_switch_plan');
  const ranges = requireObject(args, 'ranges', 'ls_switch_plan');
  const defaults = requireObject(args, 'defaults', 'ls_switch_plan');
  return {
    // Each rule's interval is read at its turn.
    rules: Object.entries(ranges).map(([entity, raw]) => ({ entity: toSwitchId(entity), range: () => switchRange(object(raw), defaults) })),
    roomTarget: room => {
      const group = object(targets[`room:${room}`]);
      return {
        populated: Object.keys(group).length > 0,
        // `Number(...)`: the JavaScript coercion the inline arithmetic applied.
        // An off room shows no level and carries none.
        level: () => group.level === undefined ? undefined : Number(group.level),
        on: () => requireBoolean(group.on, `ls_switch_plan.targets.room:${room}.on`),
      };
    },
  };
}

// Captured test_now has one default(none), reason two default('config')
// sites, room one default(''), and test_overrides is optional at two sites.
export function parsePlanArgs(args: JsonObject): PlanArgs {
  // Captured `test_overrides if test_overrides|default(none) is mapping else
  // <stored overrides>`: anything that is not a mapping takes the fallback.
  const testOverrides = args.test_overrides;
  return {
    testOverrides: isObject(testOverrides) ? planOverridesOf(testOverrides) : undefined,
    // Captured `{{ test_now|default(none) }}`: forwarded unread; ls_base parses it.
    testNow: forwardedOrNone(args.test_now),
    reason: args.reason === undefined ? 'config' : requireString(args, 'reason', 'ls_plan'),
    room: args.room === undefined ? undefined : roomOfText(requireString(args, 'room', 'ls_plan')),
  };
}

// Captured dry_run/force_all use boolean defaults, test_now and
// test_overrides are definition-guarded, reason defaults only when absent,
// and lights is consumed only after the dry-run/test guard.
export function parseApplyArgs(args: JsonObject): ApplyArgs {
  const dryRun = optionalScriptBoolean(args.dry_run, 'ls_apply.dry_run');
  const forceAll = optionalScriptBoolean(args.force_all, 'ls_apply.force_all');
  const hasTestOverrides = Object.hasOwn(args, 'test_overrides');
  return {
    dryRun,
    forceAll,
    // Captured gate `not (test_now is not defined or not test_now)`: a
    // Jinja-truthiness test, nothing parsed.
    testNowGiven: args.test_now !== undefined && jinjaTruthy(args.test_now),
    testNow: forwardedOrNone(args.test_now),
    hasTestOverrides,
    testOverrides: forwardedOrNone(args.test_overrides),
    reason: args.reason === undefined ? 'config' : requireString(args, 'reason', 'ls_apply'),
    lights: lazy(() => carry(args.lights === undefined ? [] : requireArray(args, 'lights', 'ls_apply'))),
  };
}

// Captured source/area/command are raw at four/four/two sites and drive
// identifiers and command dispatch; dry_run has default(false).
export function parseRemoteCommandArgs(args: JsonObject): RemoteCommandArgs {
  return {
    source: toRemoteSource(requireString(args, 'source', 'ls_remote_command')),
    area: toRoomId(requireString(args, 'area', 'ls_remote_command')),
    command: requireString(args, 'command', 'ls_remote_command'),
    dryRun: optionalScriptBoolean(args.dry_run, 'ls_remote_command.dry_run'),
  };
}

/** `sensor.ls_overrides`'s `overrides`, captured `overrides or {}`, read by {@link savedMappingOr}. */
export function planOverrides(value: JsonValue | undefined): PlanOverrides {
  return planOverridesOf(attributeMappingOr(value));
}

/** A saved attribute mapping `ls_plan` forwards, captured `attr or {}`, read by {@link savedMappingOr}. */
export function planMapping(value: JsonValue | undefined): Verbatim {
  return carry(attributeMappingOr(value));
}

/**
 * The warm-end test lamp's `rgb_color`, read as the captured
 * `rgb_color or [255,126,0]` through the shared {@link warmEndOr}: any
 * Jinja-falsy value takes the built-in warm end; a truthy one must be a triple.
 */
export function planWarmEnd(value: JsonValue | undefined): RGB {
  return requireRgb(warmEndOr(value), 'ls_plan.warm_end');
}

/** A room cache's gradients, read leniently; entries carried. */
export function cachedGradients(value: JsonValue | undefined): OpaqueMap {
  return opaqueMap(object(value).gradients);
}

/** `range_defaults` as captured `range_defaults or {bright, cosy}`, read by {@link savedMappingOr}. */
export function planRangeDefaults(value: JsonValue | undefined): Verbatim {
  return carry(savedMappingOr(value, BUILT_IN_RANGES));
}

/** The override sensor's `last_updated`, required. */
export function planRevision(value: string | undefined): string {
  return requireString({ value: value === undefined ? null : value }, 'value', 'ls_plan.revision');
}

/** Whatever answered to `ls_plan`, carried unread. */
export function planPassThrough(value: JsonValue): Verbatim {
  return carry(value);
}
