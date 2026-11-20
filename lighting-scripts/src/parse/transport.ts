/**
 * Parsing for the transport handlers: `effects_frame_plan`, `effects_emit`,
 * `effects_assign` and `effects_filter_commands`, plus the lenient reads of
 * `sensor.ls_effects_runtime` they make.
 *
 * Every strict read raises with the message, and at the point, the inline read
 * did: per-command and per-target parses are thunks the domain calls where the
 * inline parse sat, and a frame source's colour is read only when its channel
 * is sent. Documents the handlers persist or forward -- the assigned targets
 * and assignments, the applied map, the runtime generation, the effect targets
 * a guard carries, a filtered command's other keys, the multicast groups --
 * are carried, never narrowed.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaFloat, jinjaTruthy, lazy, object, ParseError, requireArray, requireNumber, requireObject,
  requireString } from '../runtime/parse.ts';
import { carry, jsonEqual, reveal } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { requireRgb, warmEndOr } from './scale.ts';
import { opaqueMap, storedFact } from './overrides.ts';
import { savedPlanOrder } from './sensors.ts';
import type { OpaqueMap, StoredFact } from './overrides.ts';
import type { RGB } from '../domain/scale.ts';
import type {
  AssignArgs, AssignDetails, BulbEffectName, Channel, EmitArgs, FilterArgs, FrameEffect, FramePlanArgs, FrameSource, FrameTarget,
} from '../domain/transport.ts';
import { lampOrRoom } from './lighting-state.ts';
import { parseOverlayKey } from './overlay-key.ts';

const runtime = 'sensor.ls_effects_runtime';

function requireStrings(container: JsonObject, key: string, context: string): string[] {
  return requireArray(container, key, context).map((value, index) =>
    requireString({ value }, 'value', `${context}.${key}[${index}]`));
}

/** A colour a frame sends: Kelvin, or an rgb triple. */
export type FrameColour = { kind: 'kelvin'; kelvin: number } | { kind: 'rgb'; rgb: RGB };

function frameColour(value: JsonValue | undefined, context: string): FrameColour {
  const colorValue = requireObject({ value: value ?? null }, 'value', context);
  if (Object.hasOwn(colorValue, 'kelvin')) return { kind: 'kelvin', kelvin: requireNumber(colorValue, 'kelvin', context) };
  return { kind: 'rgb', rgb: requireRgb(colorValue.rgb, `${context}.rgb`) };
}

/**
 * The colour a warm-end effect holds: the candle test lamp's warm end, read as
 * a frame colour. Read as the candle renderer read it
 * (`state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0]`):
 * through {@link warmEndOr}; a truthy value must be an rgb triple.
 */
export function warmEndColour(ctx: HouseView, context: string): FrameColour {
  return frameColour({ rgb: warmEndOr(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color')) }, context);
}

/**
 * The bulb effect an effect name names, or `undefined` for every other name.
 * The one place an effect name becomes a {@link BulbEffectName}.
 */
export function bulbEffectName(name: string): BulbEffectName | undefined {
  return name === 'Candle' || name === 'Breathe' || name === 'Colour loop' ? name : undefined;
}

/**
 * The names the frame plan's catalog lists, read only when a source names an
 * effect the bulbs do not run. Absent `effects` lists nothing: the oracle's
 * `source.effect in catalog.effects` is then false.
 */
type CatalogEffectNames = () => ReadonlySet<string>;

/**
 * A frame source's effect, decided once. A name the catalog lists that the
 * bulbs cannot run raises: the oracle would hand it to that effect's software
 * renderer, which the port does not have, and sending it as a plain level
 * would light the lamp at brightness 1.
 */
function frameEffect(kind: string, source: JsonObject, intensity: () => number, catalogEffects: CatalogEffectNames, context: string): FrameEffect {
  if (kind === 'none') return { kind: 'no value' };
  if (kind !== 'effect') return { kind: 'not an effect' };
  const name = requireString(source, 'effect', context);
  const bulb = bulbEffectName(name);
  if (bulb !== undefined) return { kind: 'bulb effect', name: bulb, intensity };
  if (catalogEffects().has(name)) {
    throw new ParseError(`${context}.effect '${name}' is in the catalog but is not an effect the bulbs run (Candle, Breathe, Colour loop)`);
  }
  return { kind: 'uncatalogued effect', name };
}

function parseFrameSource(target: JsonObject, channel: Channel, catalogEffects: CatalogEffectNames, context: string): FrameSource {
  const source = requireObject(target, channel, context);
  const kind = requireString(source, 'kind', `${context}.${channel}`);
  const intensity = lazy(() => requireNumber(source, 'intensity', `${context}.${channel}`));
  const effect = frameEffect(kind, source, intensity, catalogEffects, `${context}.${channel}`);
  return {
    kind,
    effect,
    // Read when the plan reaches the channel, which it does for both. An
    // effect source's `intensity` is required on either channel -- a bulb
    // effect's colour included, though nothing on the colour channel uses it --
    // matching the oracle, which hands `source.intensity` to the effect's
    // renderer for every effect channel. `value` is read as a level here and as
    // a colour only when the colour is sent.
    details: lazy(() => {
      if (kind === 'effect') intensity();
      return {
        // `value | float`, for the brightness channel.
        level: jinjaFloat(source.value),
        // The strict colour read, for the colour channel when it is sent.
        colour: colourContext => frameColour(source.value, colourContext),
      };
    }),
  };
}

function parseFrameCatalog(args: JsonObject): FramePlanArgs['catalog'] {
  // `phases` is not read: no effect is rendered here any more. `effects` is
  // read by the target parse, and only for a name the bulbs do not run.
  const catalog = requireObject(args, 'catalog', 'effects_frame_plan');
  const membersRaw = requireObject(catalog, 'members', 'effects_frame_plan.catalog');
  const topicsRaw = requireObject(catalog, 'topics', 'effects_frame_plan.catalog');
  return {
    members: Object.fromEntries(Object.keys(membersRaw).map(lamp =>
      [lamp, requireStrings(membersRaw, lamp, 'effects_frame_plan.catalog.members')])),
    topics: Object.fromEntries(Object.keys(topicsRaw).map(member =>
      [member, requireString(topicsRaw, member, 'effects_frame_plan.catalog.topics')])),
    // Read only when the group planner is reached, which is where the oracle
    // reads it; forwarded to it unread.
    multicast: lazy(() => carry(requireArray(catalog, 'multicast', 'effects_frame_plan.catalog'))),
  };
}

function parseFrameTargets(args: JsonObject): Record<string, FrameTarget> {
  const targets = requireObject(args, 'targets', 'effects_frame_plan');
  const catalogEffects: CatalogEffectNames = lazy(() => {
    const catalog = requireObject(args, 'catalog', 'effects_frame_plan');
    return new Set(catalog.effects === undefined ? [] : Object.keys(requireObject(catalog, 'effects', 'effects_frame_plan.catalog')));
  });
  return Object.fromEntries(Object.entries(targets).map(([lamp, raw]) => {
    const context = `effects_frame_plan.targets.${lamp}`;
    const target = requireObject({ raw }, 'raw', context);
    const owners = target.owners === undefined ? {} : requireObject(target, 'owners', context);
    return [lamp, {
      brightness: parseFrameSource(target, 'brightness', catalogEffects, context),
      color: parseFrameSource(target, 'color', catalogEffects, context),
      manual: Object.entries(owners).some(([key, value]) =>
        requireString({ value }, 'value', `${context}.owners.${key}`).startsWith('channels:')),
      on: jinjaTruthy(target.on),
      transition: target.transition === undefined ? 3 : requireNumber(target, 'transition', context),
      // The source reads area only inside the guarded transition-room check,
      // where it is compared by identity.
      area: storedFact(target.area),
    }];
  }));
}

// The light half of a dispatch. Captured fields: `catalog` and `targets`
// are raw (6 and 2 sites); `transition_cap`/`transition_rooms` each have a
// `default(none)` path plus a raw use. Nested catalog/target fields are also
// raw: members/topics/multicast/owners/area 1 each, color 5, brightness 7,
// kind 4, effect 8, intensity 1, kelvin 2, rgb/on 4 each, and transition 10.
// `value` is raw four times but has one `| float`, so brightness uses
// jinjaFloat while color uses strict object/color parsers. The captured
// `timestamp`, `animation_tick`, `effects` and `phases` fed the software
// renderers and the frame engine, both gone: callers may still pass them,
// and nothing reads them.
export function parseFramePlanArgs(args: JsonObject): FramePlanArgs {
  return {
    catalog: parseFrameCatalog(args),
    targets: parseFrameTargets(args),
    transitionCap: args.transition_cap == null ? null : requireNumber(args, 'transition_cap', 'effects_frame_plan'),
    transitionRooms: args.transition_rooms == null
      ? null
      : requireArray(args, 'transition_rooms', 'effects_frame_plan').map(room => storedFact(room)),
  };
}

// Captured `commands`, `revision`, and `generation` are raw (1, 2, and 4
// sites); `effect_targets` is raw twice with one `| default({})` fallback.
// Nested payload/owners/members/topic are raw (2/2/1/1), so commands get a
// strict object/string-array/string parser rather than permissive casts.
export function parseEmitArgs(args: JsonObject): EmitArgs {
  return {
    commands: requireArray(args, 'commands', 'effects_emit').map((raw, index) => lazy(() => {
      const context = `effects_emit.commands[${index}]`;
      const command = requireObject({ raw }, 'raw', context);
      const payload = requireObject(command, 'payload', context);
      const owners = requireStrings(command, 'owners', context);
      const members = requireStrings(command, 'members', context);
      const topic = requireString(command, 'topic', context);
      return { body: JSON.stringify(payload), turnsOff: payload.state === 'OFF', owners, members, topic };
    })),
    revision: requireString(args, 'revision', 'effects_emit'),
    // The runtime legitimately has no generation before its first assignment.
    generation: args.generation === null ? null : requireString(args, 'generation', 'effects_emit'),
    effectTargets: lazy(() => opaqueMap(args.effect_targets === undefined ? {} : requireObject(args, 'effect_targets', 'effects_emit'))),
  };
}

function parseAssignTargetViews(targets: JsonObject): ReturnType<AssignDetails['targetViews']> {
  return Object.fromEntries(Object.entries(targets).map(([lamp, raw]) => {
    const context = `effects_assign.targets.${lamp}`;
    const target = requireObject({ raw }, 'raw', context);
    const owners = target.owners === undefined ? {} : requireObject(target, 'owners', context);
    const channels = Object.fromEntries((['brightness', 'color'] as const).map(channel => {
      const source = requireObject(target, channel, context);
      const kind = requireString(source, 'kind', `${context}.${channel}`);
      return [channel, {
        kind,
        // The stop check only asks which bulb effect a channel runs; any other
        // name runs nothing on the bulbs, so it reads as none.
        effect: kind === 'effect' ? bulbEffectName(requireString(source, 'effect', `${context}.${channel}`)) : undefined,
        updated: kind === 'effect' ? requireNumber(source, 'updated', `${context}.${channel}`) : null,
      }];
    })) as ReturnType<AssignDetails['targetViews']>[string]['channels'];
    return [lamp, {
      lampOrRoom: lampOrRoom(lamp, target.is_room),
      channels,
      owners: Object.fromEntries((['brightness', 'color'] as const).map(channel => [
        channel,
        parseOverlayKey(owners[channel] === undefined ? '' : requireString(owners, channel, `${context}.owners`)),
      ])) as ReturnType<AssignDetails['targetViews']>[string]['owners'],
    }];
  }));
}

// Captured `targets`, `assignments`, and `revision` are raw (7, 5, and 7
// sites); `invalidate` has `| default([])` twice; `plan_order` is raw five
// times with one runtime-attribute default. Nested is_room/kind are raw once,
// effect five times, owners twice, brightness/color once, and updated twice;
// typed target views parse those fields without altering persisted targets.
export function parseAssignArgs(args: JsonObject): AssignArgs {
  return {
    revision: requireString(args, 'revision', 'effects_assign'),
    // The captured stale-revision stop precedes every other argument read.
    details: lazy(() => {
      const targets = requireObject(args, 'targets', 'effects_assign');
      return {
        targets: carry(targets),
        targetViews: lazy(() => parseAssignTargetViews(targets)),
        assignments: carry(requireObject(args, 'assignments', 'effects_assign')),
        invalidate: args.invalidate === undefined ? [] : requireArray(args, 'invalidate', 'effects_assign').map(key => storedFact(key)),
        planOrder: args.plan_order === undefined ? undefined : requireNumber(args, 'plan_order', 'effects_assign'),
      };
    }),
  };
}

// Captured `commands` is raw at both sites and nested `ids` is raw nine
// times, so both the command list and each id list are parsed strictly. The
// rest of each command is forwarded unread.
export function parseFilterArgs(args: JsonObject): FilterArgs {
  return {
    commands: requireArray(args, 'commands', 'effects_filter_commands').map((raw, index) => {
      const command = requireObject({ raw }, 'raw', `effects_filter_commands.commands[${index}]`);
      return { document: carry(command), ids: requireStrings(command, 'ids', `effects_filter_commands.commands[${index}]`) };
    }),
  };
}

/**
 * A stored target or assignment's channels, read without raising: a
 * non-mapping target or channel has none. Only a channel naming a bulb effect
 * answers; any other effect name runs nothing on the bulbs.
 */
export interface StoredChannels {
  /** The bulb effect a channel names, when its source is `{kind: 'effect', effect: <bulb effect>}`. */
  bulbEffectOn(channel: Channel): BulbEffectName | undefined;
}

export function storedChannels(value: JsonValue | undefined): StoredChannels {
  const stored = object(value);
  return {
    bulbEffectOn: channel => {
      const source = isObject(stored[channel]) ? stored[channel] : {};
      return source.kind === 'effect' && typeof source.effect === 'string' ? bulbEffectName(source.effect) : undefined;
    },
  };
}

/** One lamp's previous runtime assignment and target, as the stop check reads them. */
export interface PreviousLamp {
  /**
   * The bulb effect the previous assignment names at its top level (captured
   * `old.get(L,{}).get('effect')`), compared as the captured `in` does: only
   * a string equal to a name; anything else is `undefined`.
   */
  effect: BulbEffectName | undefined;
  channels: StoredChannels;
  /** The previous target's `channel.updated`, as stored, for an identity comparison. */
  updated(channel: Channel): StoredFact;
}

/** `sensor.ls_effects_runtime` as `effects_assign` reads it, once. */
export interface RuntimeState {
  /** The stored targets, for the change test and as the applied fallback. */
  targetsEqual(targets: Verbatim): boolean;
  /** `applied == null ? targets : object(applied)`, carried entry by entry. */
  applied: OpaqueMap;
  previous(lamp: string): PreviousLamp;
}

export function runtimeState(ctx: HouseView): RuntimeState {
  const old = object(ctx.attr(runtime, 'assignments')), oldTargets = object(ctx.attr(runtime, 'targets'));
  const priorApplied = ctx.attr(runtime, 'applied');
  return {
    targetsEqual: targets => isDeepStrictEqual(reveal(targets), oldTargets),
    applied: opaqueMap(priorApplied == null ? oldTargets : object(priorApplied)),
    previous: lamp => {
      const previous = object(old[lamp]);
      return {
        effect: typeof previous.effect === 'string' ? bulbEffectName(previous.effect) : undefined,
        channels: storedChannels(previous),
        updated: channel => storedFact(object(object(oldTargets[lamp])[channel]).updated),
      };
    },
  };
}

/** The runtime's `generation` as stored; absent reads as null. */
export function runtimeGeneration(ctx: HouseView): Verbatim {
  const generation = ctx.attr(runtime, 'generation');
  return carry(generation === undefined || generation === null ? null : generation);
}

/** The runtime's `plan_order`, as captured `plan_order or 0`, read by {@link savedPlanOrder}. */
export function runtimePlanOrder(ctx: HouseView): number {
  return savedPlanOrder(ctx);
}

/** Is a runtime assignment, read leniently, deep-equal to the effect target a command carries? */
export function assignedAs(ctx: HouseView, owner: string, target: Verbatim): boolean {
  return isDeepStrictEqual(object(ctx.attr(runtime, 'assignments'))[owner], reveal(target));
}

/** The lamps the runtime currently assigns, in stored order. */
export function assignedLamps(ctx: HouseView): string[] {
  return Object.keys(object(ctx.attr(runtime, 'assignments')));
}

/**
 * Is the area's power gate closed? Captured `not (power or {}).get(area_id(L), true)`:
 * Jinja `not`, so any falsy saved value closes it (`false`, `0`, `''`, `[]`,
 * `{}`, an explicit none); an absent key, and a lamp with no area, take the
 * default, open.
 */
export function powerClosed(ctx: HouseView, area: string | undefined): boolean {
  const power = object(ctx.attr('sensor.ls_overrides', 'power'));
  return area !== undefined && Object.hasOwn(power, area) && !jinjaTruthy(power[area]);
}

/**
 * Captured `generation==state_attr('sensor.ls_effects_runtime','generation')`:
 * Python `==`, by value, with an absent attribute read as none.
 */
export function runtimeGenerationIs(ctx: HouseView, generation: Verbatim | string | null): boolean {
  const stored = ctx.attr(runtime, 'generation');
  const given: JsonValue = typeof generation === 'string' || generation === null ? generation : reveal(generation);
  return jsonEqual(stored === undefined ? null : stored, given);
}

