/**
 * Parsing for `ls_dispatch` and `ls_render`: the dispatch plan, the requested
 * lights, the runtime and override sensor reads both make, and the `ls_plan` /
 * `ls_room_plan` results `ls_render` merges.
 *
 * Every strict read raises with the message, and at the point, the inline read
 * did: a baseline entry is required only when its lamp reaches the baseline
 * check, and the switches, mirrors and stale keys only after effect
 * assignment. The two plan results are decided exceptions (criterion 2) and are
 * read with exactly the `object()`/`list()`/`strings()` leniency the inline
 * reads applied. Documents the handlers forward or persist -- resolved targets
 * and assignments, the merged plan, the room-cache updates, the applied map --
 * are carried, never narrowed; facts compared by identity are stored facts.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import {
  isObject, jinjaTruthy, lazy, object, requireArray, requireNumber, requireObject, requireString,
} from '../runtime/parse.ts';
import { carry, reveal } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { list, strings } from './accessors.ts';
import { opaqueMap, storedFact } from './overrides.ts';
import type { OpaqueMap, StoredFact, StoredValue } from './overrides.ts';
import { storedChannels } from './transport.ts';
import { savedPlanOrder } from './sensors.ts';
import type { DispatchRequest, DispatchDetails, DispatchTarget } from '../domain/dispatch-render.ts';
import { lampOrRoom } from './lighting-state.ts';
import { toRoomId } from './ids.ts';
import type { RoomId } from '../domain/types/ids.ts';

const runtime = 'sensor.ls_effects_runtime';

/** `sensor.ls_effects_runtime` as `ls_dispatch` reads it before assigning, once. */
export interface DispatchRuntime {
  /** Is a lamp's resolved target deep-equal to what was last applied (or assigned, when nothing was)? */
  applied(lamp: string, target: Verbatim): boolean;
  /** Did the previous assignments name this lamp? */
  hadEffect(lamp: string): boolean;
}

export function dispatchRuntime(ctx: HouseView): DispatchRuntime {
  const applied = ctx.attr(runtime, 'applied');
  const previous = object(applied === null || applied === undefined ? ctx.attr(runtime, 'targets') : applied);
  const previousEffects = object(ctx.attr(runtime, 'assignments'));
  return {
    applied: (lamp, target) => isDeepStrictEqual(reveal(target), previous[lamp]),
    hadEffect: lamp => Object.hasOwn(previousEffects, lamp),
  };
}

/** `ls_plan`'s answer, read as `ls_render`'s full path reads it. */
export interface FullPlan {
  /** `{ ...object(result.plan), remote_rooms: rooms }`, forwarded to `ls_dispatch`. */
  document: Verbatim;
  /** The distinct non-empty string areas the plan's baseline names, in order: its rooms. */
  areas: RoomId[];
  /** The plan's gradients for the baseline lamps in a room, keyed by lamp. */
  gradientsIn(room: RoomId): OpaqueMap;
}

export function fullPlan(result: JsonValue, rooms: RoomId[]): FullPlan {
  const plan: JsonObject = { ...object(object(result).plan), remote_rooms: rooms };
  const bases = object(plan.base), gradients = object(plan.gradients);
  return {
    document: carry(plan),
    areas: [...new Set(Object.values(bases).map(t => object(t).area)
      .filter((area): area is string => typeof area === 'string' && area.length > 0).map(toRoomId))],
    gradientsIn: room => Object.fromEntries(Object.entries(bases)
      .filter(([key, t]) => object(t).area === room && Object.hasOwn(gradients, key))
      .map(([key]) => [key, carry(gradients[key]!)])),
  };
}

/** A room's `sensor.ls_cache_<room>` cache, read leniently, as the full path refreshes its gradients. */
export interface RoomCacheGradients {
  /** Are these exactly the cached gradients? */
  holds(gradients: OpaqueMap): boolean;
  /** `{ ...cache, gradients }`. */
  withGradients(gradients: OpaqueMap): Verbatim;
}

export function roomCacheGradients(value: JsonValue | undefined): RoomCacheGradients {
  const old = object(value);
  return {
    holds: gradients => isDeepStrictEqual(gradients, old.gradients),
    withGradients: gradients => carry({ ...old, gradients }),
  };
}

/** `ls_room_plan`'s answer, read as `ls_render`'s partial path merges it. */
export interface RoomPlanView {
  targets: OpaqueMap;
  assignments: OpaqueMap;
  base: OpaqueMap;
  switches: OpaqueMap;
  mirror: Verbatim[];
  staleKeys: string[];
  /** The room's new cache, when the plan returned a mapping for it. */
  cacheUpdate: Verbatim | undefined;
  saraMirror: StoredFact;
}

/**
 * Read in the order the inline merge read it; `list()` and `strings()` raise on
 * a present non-list `mirror` / `stale_keys`, everything else is lenient.
 */
export function roomPlanView(result: JsonValue): RoomPlanView {
  const planned = object(result);
  const plan = object(planned.plan);
  const resolved = object(plan.resolved);
  return {
    targets: opaqueMap(resolved.targets),
    assignments: opaqueMap(resolved.assignments),
    base: opaqueMap(plan.base),
    switches: opaqueMap(plan.switches),
    mirror: list(plan.mirror).map(entry => carry(entry)),
    staleKeys: strings(plan.stale_keys),
    cacheUpdate: isObject(planned.cache_update) ? carry(planned.cache_update) : undefined,
    saraMirror: storedFact(plan.sara_mirror),
  };
}

/**
 * The full render due, captured `full_version and full_version != handled_full`:
 * the stored `full_version` when it is Jinja-truthy and differs from the stored
 * `handled_full`, else `undefined`. Both are saved state; nothing raises.
 */
export function dueFullVersion(ctx: HouseView): StoredValue | undefined {
  const version = ctx.attr('sensor.ls_overrides', 'full_version'), handled = ctx.attr(runtime, 'handled_full');
  return version !== undefined && jinjaTruthy(version) && !isDeepStrictEqual(version, handled) ? storedFact(version) : undefined;
}

// Captured `plan` is raw at 20 sites. Its revision/resolved/base/plan_order,
// assignments/output_targets/remote_rooms/targets/switches/mirror/stale_keys
// fields are all raw (9/5/1/3/3/2/3/5/2/3/2 sites), so they use strict
// object/number/array parsers. Nested area/option/entity/sara_mirror are raw
// (1/1/1/2); option/entity are required strings while comparison-only area
// and sara_mirror retain their raw values. Boolean-context fields is_room,
// send, remote, on use Python truthiness (1/1/2/5 raw sites). `lights` has
// four raw uses and one `| default(none)`, preserved by its parser.
export function parseDispatchArgs(args: JsonObject): DispatchRequest {
  const plan = requireObject(args, 'plan', 'ls_dispatch');
  return {
    revision: requireString(plan, 'revision', 'ls_dispatch.plan'),
    planOrder: requireNumber(plan, 'plan_order', 'ls_dispatch.plan'),
    // Keep captured early-return evaluation order for the remaining fields.
    details: () => parseDispatchDetails(plan, args.lights),
  };
}

function parseDispatchDetails(plan: JsonObject, lights: JsonValue | undefined): DispatchDetails {
  const resolved = requireObject(plan, 'resolved', 'ls_dispatch.plan');
  const base = requireObject(plan, 'base', 'ls_dispatch.plan');
  const targets = requireObject(resolved, 'targets', 'ls_dispatch.plan.resolved');
  const targetViews = Object.fromEntries(Object.entries(targets).map(([lamp, raw]) => [lamp, dispatchTarget(lamp, raw)]));
  const assignments = requireObject(resolved, 'assignments', 'ls_dispatch.plan.resolved');
  return {
    targets: carry(targets),
    targetViews,
    assignments: carry(assignments),
    assigned: lamp => Object.hasOwn(assignments, lamp),
    baselineSend: lamp => {
      if (base[lamp] === undefined) return true;
      const baseline = requireObject(base, lamp, 'ls_dispatch.plan.base');
      return baseline.send === undefined ? true : jinjaTruthy(baseline.send);
    },
    requested: parseRequestedLights(lights),
    // Both are read unfiltered in the captured script, but an unfiltered read
    // is not the same as a required field: Jinja's Undefined iterates as empty
    // and reports `| length` 0, raising only in arithmetic or a coercion
    // filter. These two are iterated, and `ls_render` only sets
    // `output_targets` on the partial-plan path, so absence is legal and
    // requiring them broke seven parity modules.
    outputTargets: (plan.output_targets === undefined ? [] : requireArray(plan, 'output_targets', 'ls_dispatch.plan')).map(lamp => storedFact(lamp)),
    remoteRooms: (plan.remote_rooms === undefined ? [] : requireArray(plan, 'remote_rooms', 'ls_dispatch.plan')).map(room => storedFact(room)),
    remote: jinjaTruthy(plan.remote),
    // These stages run only after effect assignment and publication. All three
    // collections are iterated rather than used arithmetically, and the
    // captured script guards them (`switches` has a `| default(...)` site,
    // `stale_keys` two `is defined` tests), so an absent key is silently empty
    // in the oracle and must be here too.
    switches: lazy(() => Object.entries(plan.switches === undefined ? {} : requireObject(plan, 'switches',
      'ls_dispatch.plan')).map(([entity, raw]) => lazy(() => {
        const value = requireObject({ raw }, 'raw', `ls_dispatch.plan.switches.${entity}`);
        return { entity, on: jinjaTruthy(value.on) };
      }))),
    mirrors: lazy(() => (plan.mirror === undefined ? [] : requireArray(plan, 'mirror', 'ls_dispatch.plan')).map((raw, index) => lazy(() => {
        const value = requireObject({ raw }, 'raw', `ls_dispatch.plan.mirror[${index}]`);
        return {
          option: requireString(value, 'option', `ls_dispatch.plan.mirror[${index}]`),
          entity: requireString(value, 'entity', `ls_dispatch.plan.mirror[${index}]`),
        };
      }))),
    staleKeys: lazy(() => (plan.stale_keys === undefined ? [] : requireArray(plan, 'stale_keys', 'ls_dispatch.plan')).map(key => storedFact(key))),
    saraMirror: storedFact(plan.sara_mirror),
  };
}

function dispatchTarget(lamp: string, raw: JsonValue): DispatchTarget {
  const target = requireObject({ raw }, 'raw', `ls_dispatch.plan.resolved.targets.${lamp}`);
  return {
    document: carry(target),
    lampOrRoom: lampOrRoom(lamp, target.is_room),
    area: storedFact(target.area),
    on: jinjaTruthy(target.on),
    channels: storedChannels(target),
  };
}

function parseRequestedLights(value: JsonValue | undefined): StoredValue[] {
  const requested = value === undefined ? null : value; // captured `| default(none)`
  return (Array.isArray(requested) ? requested : jinjaTruthy(requested) ? [requested] : []).map(light => storedFact(light));
}

/** The runtime's `plan_order`, as captured `plan_order or 0`, read by {@link savedPlanOrder}. */
export function dispatchPlanOrder(ctx: HouseView): number {
  return savedPlanOrder(ctx);
}

/** A carried document's `area`, read leniently: a non-mapping has none. */
export function areaOf(document: Verbatim): StoredFact {
  return storedFact(object(reveal(document)).area);
}

/** A saved room-keyed map's keys (`pending_rooms`, `handled_rooms`): the rooms it names. */
export function roomKeys(map: Readonly<Record<string, unknown>>): RoomId[] {
  return Object.keys(map).map(toRoomId);
}
