import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, OutputGuard, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { isObject, jinjaFloat, jinjaTruthy, lazy, object, requireArray, requireNumber, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { catalogOf } from '../runtime/catalog.ts';
import { typed } from '../runtime/entrypoints.ts';
import { roundEven, clamp } from './scale.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import { requireRgb } from '../parse/scale.ts';
import { warmEndOf } from '../parse/planning.ts';
import type { GroupPlanResult } from './grouping.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const runtime = 'sensor.ls_effects_runtime';

/**
 * The effects the bulbs render themselves: the channel each one runs on, and
 * the Zigbee2MQTT light `effect` that starts it. The port sends a lamp its
 * light once, then the start, and streams nothing; leaving one sends
 * `stop_colorloop` and `stop_effect` first.
 *
 * - Candle: the Innr RB 282 C firmware's Identify TriggerEffect 0x0b
 *   (`channel_change`) flickers under whatever level the lamp is at, holds the
 *   lamp's colour, and stops on `stop_effect`, Off, or any brightness command.
 * - Breathe and Colour loop: the bulbs' own Zigbee effects (`breathe`,
 *   `colorloop`), stopped by `stop_effect` and `stop_colorloop`.
 */
export type Channel = 'brightness' | 'color';
export type BulbEffect = {
  /** The channel the bulb animates; the start is sent only when this channel runs the effect. */
  readonly channel: Channel;
  readonly start: string;
  /**
   * The colour sent before the start when the effect claims the colour
   * channel. Candle holds the warm end its software renderer used to return;
   * a loop owns the colour from its start on, so nothing is sent for it.
   */
  readonly colour: 'warm end' | 'none';
};
const BULB_EFFECTS: ReadonlyMap<string, BulbEffect> = new Map([
  ['Candle', { channel: 'brightness', start: 'channel_change', colour: 'warm end' }],
  ['Breathe', { channel: 'brightness', start: 'breathe', colour: 'none' }],
  ['Colour loop', { channel: 'color', start: 'colorloop', colour: 'none' }],
]);

type SourceKind = { kind: string; effect: string | null };

/** The bulb effect a channel source names, wherever it sits, or `undefined`. */
function bulbEffect(source: SourceKind): BulbEffect | undefined {
  return source.kind === 'effect' && source.effect !== null ? BULB_EFFECTS.get(source.effect) : undefined;
}

/**
 * The bulb effect a channel runs, or `undefined`. An effect runs on exactly one
 * channel: a Candle claim on colour alone holds the warm colour and starts
 * nothing, because the flicker is a brightness effect.
 */
function runningOn(channel: Channel, source: SourceKind): BulbEffect | undefined {
  const effect = bulbEffect(source);
  return effect !== undefined && effect.channel === channel ? effect : undefined;
}
/**
 * {@link runningOn} for an unparsed target: a stored runtime assignment, or a
 * resolved target `ls_dispatch` has not handed to the strict frame plan yet.
 * Read without raising, as every other read of those documents is.
 */
export function runningIn(channel: Channel, stored: JsonObject): BulbEffect | undefined {
  const source = isObject(stored[channel]) ? stored[channel] : {};
  return source.kind === 'effect' && typeof source.effect === 'string'
    ? runningOn(channel, { kind: 'effect', effect: source.effect }) : undefined;
}
const revisionNow = (ctx: ScriptContext) => ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now;

interface FrameSource {
  kind: string;
  effect: string | null;
  details: () => { intensity: number | null; value: JsonValue | undefined };
}
interface FrameTarget {
  brightness: FrameSource;
  color: FrameSource;
  manual: boolean;
  on: boolean;
  transition: number;
  area: JsonValue | undefined;
}
interface FrameCatalog {
  members: Record<string, string[]>;
  topics: Record<string, string>;
  multicast: () => JsonValue[];
}
interface FramePlanArgs {
  catalog: FrameCatalog;
  targets: Record<string, FrameTarget>;
  transitionCap: number | null;
  transitionRooms: JsonValue[] | null;
}

interface EmitArgs {
  commands: Array<() => { payload: JsonObject; owners: string[]; members: string[]; topic: string }>;
  revision: string;
  generation: string | null;
  effectTargets: () => JsonObject;
}

interface AssignArgs {
  revision: string;
  details: () => AssignDetails;
}
interface AssignDetails {
  targets: JsonObject;
  targetViews: () => Record<string, {
    isRoom: boolean;
    channels: Record<'brightness' | 'color', { kind: string; effect: string | null; updated: number | null }>;
    owners: Record<'brightness' | 'color', string>;
  }>;
  assignments: JsonObject;
  invalidate: JsonValue[];
  planOrder: number | undefined;
}

function requireStrings(container: JsonObject, key: string, context: string): string[] {
  return requireArray(container, key, context).map((value, index) =>
    requireString({ value }, 'value', `${context}.${key}[${index}]`));
}

function parseFrameSource(target: JsonObject, channel: 'brightness' | 'color', context: string): FrameSource {
  const source = requireObject(target, channel, context);
  const kind = requireString(source, 'kind', `${context}.${channel}`);
  const effect = kind === 'effect' ? requireString(source, 'effect', `${context}.${channel}`) : null;
  return {
    kind,
    effect,
    // Read where the plan reads them: a bulb effect's colour needs neither.
    details: lazy(() => ({
      intensity: kind === 'effect' ? requireNumber(source, 'intensity', `${context}.${channel}`) : null,
      value: source.value,
    })),
  };
}

function parseFrameCatalog(args: JsonObject): FrameCatalog {
  // `effects` and `phases` are not read: no effect is rendered here any more.
  const catalog = requireObject(args, 'catalog', 'effects_frame_plan');
  const membersRaw = requireObject(catalog, 'members', 'effects_frame_plan.catalog');
  const topicsRaw = requireObject(catalog, 'topics', 'effects_frame_plan.catalog');
  return {
    members: Object.fromEntries(Object.keys(membersRaw).map(lamp =>
      [lamp, requireStrings(membersRaw, lamp, 'effects_frame_plan.catalog.members')])),
    topics: Object.fromEntries(Object.keys(topicsRaw).map(member =>
      [member, requireString(topicsRaw, member, 'effects_frame_plan.catalog.topics')])),
    // Read only when the group planner is reached, which is where the oracle reads it.
    multicast: lazy(() => requireArray(catalog, 'multicast', 'effects_frame_plan.catalog')),
  };
}

function parseFrameTargets(args: JsonObject): Record<string, FrameTarget> {
  const targets = requireObject(args, 'targets', 'effects_frame_plan');
  return Object.fromEntries(Object.entries(targets).map(([lamp, raw]) => {
    const context = `effects_frame_plan.targets.${lamp}`;
    const target = requireObject({ raw }, 'raw', context);
    const owners = target.owners === undefined ? {} : requireObject(target, 'owners', context);
    return [lamp, {
      brightness: parseFrameSource(target, 'brightness', context),
      color: parseFrameSource(target, 'color', context),
      manual: Object.entries(owners).some(([key, value]) =>
        requireString({ value }, 'value', `${context}.owners.${key}`).startsWith('channels:')),
      on: jinjaTruthy(target.on),
      transition: target.transition === undefined ? 3 : requireNumber(target, 'transition', context),
      // The source reads area only inside the guarded transition-room check.
      area: target.area,
    }];
  }));
}

function parseEmitCommands(args: JsonObject): EmitArgs['commands'] {
  return requireArray(args, 'commands', 'effects_emit').map((raw, index) => lazy(() => {
      const context = `effects_emit.commands[${index}]`;
      const command = requireObject({ raw }, 'raw', context);
      return {
        payload: requireObject(command, 'payload', context),
        owners: requireStrings(command, 'owners', context),
        members: requireStrings(command, 'members', context),
        topic: requireString(command, 'topic', context),
      };
    }));
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
        effect: kind === 'effect' ? requireString(source, 'effect', `${context}.${channel}`) : null,
        updated: kind === 'effect' ? requireNumber(source, 'updated', `${context}.${channel}`) : null,
      }];
    })) as ReturnType<AssignDetails['targetViews']>[string]['channels'];
    return [lamp, {
      isRoom: jinjaTruthy(target.is_room),
      channels,
      owners: Object.fromEntries((['brightness', 'color'] as const).map(channel => [
        channel,
        owners[channel] === undefined ? '' : requireString(owners, channel, `${context}.owners`),
      ])) as ReturnType<AssignDetails['targetViews']>[string]['owners'],
    }];
  }));
}

/**
 * Each lamp's light, sent once. A channel running a bulb effect gets a static
 * value: brightness is the effect's intensity (the level it runs at, and the
 * candle's ceiling); colour is what the effect holds (see {@link BulbEffect}).
 * The start follows in a second emission, so it always lands after the light.
 */
export function framePlan(ctx: ScriptContext, args: FramePlanArgs): GroupPlanResult {
  const catalog = args.catalog, rows: JsonValue[] = [];
  for (const [lamp, target] of Object.entries(args.targets)) {
    let payload: JsonObject = {};
    const color = target.color, brightness = target.brightness;
    for (const channel of ['brightness', 'color'] as const) {
      const source = target[channel];
      const { intensity, value: sourceValue } = source.details();
      const effect = bulbEffect(source);
      let value = sourceValue;
      if (effect !== undefined) {
        if (channel === 'brightness') value = intensity;
        else if (effect.colour === 'warm end') value = { rgb: warmEndOf(ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color')) };
        else continue;
      }
      if (channel === 'brightness') payload.brightness = roundEven(clamp(jinjaFloat(value), 1, 254));
      else {
        const colorValue = requireObject({ value: value ?? null }, 'value', `effects_frame_plan.targets.${lamp}.color.value`);
        if (Object.hasOwn(colorValue, 'kelvin')) payload.color_temp = roundEven(1_000_000 / requireNumber(colorValue, 'kelvin', `effects_frame_plan.targets.${lamp}.color.value`));
        else payload.color = { rgb: requireRgb(colorValue.rgb, `effects_frame_plan.targets.${lamp}.color.value.rgb`).join(',') };
      }
    }
    let transition = target.on ? (brightness.kind === 'effect' || color.kind === 'effect' ? 0.4 : target.manual ? 0.2 : target.transition) : target.transition;
    if (args.transitionCap !== null && (args.transitionRooms === null || args.transitionRooms.includes(target.area ?? null))) transition = Math.min(transition, args.transitionCap);
    payload = target.on ? { ...payload, transition } : { state: 'OFF', transition };
    if (ctx.get(lamp) === 'on') for (const member of catalog.members[lamp] ?? []) {
      if (ctx.get(member) === 'on') rows.push({ entity: member, owner: lamp,
        topic: catalog.topics[member] ?? null, payload });
    }
  }
  // `ctx.call`, not `ctx.run`: this result is what `effects_frame_plan`
  // answers, so it must arrive typed. The call itself is unchanged -- same
  // name in `scriptRuns`, same argument bytes in the compared trace.
  return ctx.call('effects_group_plan', { rows, groups: catalog.multicast() });
}

/**
 * `effects_emit`'s result. Both fields are built here from the publishes this
 * call made, so nothing is passed through and the type is lossless.
 */
export type EmitResult = { published_at: number[]; completed: boolean };
/**
 * `effects_assign`'s result.
 *
 * `generation` stays a `JsonValue` deliberately: it is the runtime sensor's own
 * attribute, read raw and handed back raw, and `ls_dispatch` compares it with
 * `!==` against the same attribute. Narrowing it to a string would be a
 * projection of a value the gate compares.
 */
export type AssignResult = { generation: JsonValue };

export function emitCommands(ctx: ScriptContext, args: EmitArgs): EmitResult {
  const revision = args.revision, generation = args.generation;
  let completed = true;
  const published: number[] = [];
  for (const parseCommand of args.commands) {
    const command = parseCommand();
    const payload = command.payload;
    const owners = command.owners, members = command.members;
    let allowed = revision === revisionNow(ctx) && generation === ctx.attr(runtime, 'generation');
    for (const owner of owners) if (ctx.get(owner) !== 'on' || payload.state !== 'OFF' && object(ctx.attr('sensor.ls_overrides', 'power'))[ctx.areas[owner] ?? ''] === false) allowed = false;
    for (const member of members) if (ctx.get(member) !== 'on') allowed = false;
    const effectTargets = args.effectTargets();
    if (Object.keys(effectTargets).length) for (const owner of owners) {
      if (!Object.hasOwn(effectTargets, owner) || !isDeepStrictEqual(object(ctx.attr(runtime, 'assignments'))[owner], effectTargets[owner])) allowed = false;
    }
    if (allowed && ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') === 'on') {
      published.push(recordTimestamp(ctx.now));
      const guard: OutputGuard = { revision, generation, owners, members,
        ...(Object.keys(effectTargets).length ? { effectTargets } : {}) };
      ctx.emit('mqtt.publish', { topic: command.topic, payload: JSON.stringify(payload), qos: 0, retain: false }, undefined, guard);
    } else completed = false;
  }
  return { published_at: published, completed: completed && revision === revisionNow(ctx) && generation === ctx.attr(runtime, 'generation') };
}

export function assignEffects(ctx: ScriptContext, args: AssignArgs): AssignResult {
  if (args.revision !== revisionNow(ctx)) return { generation: ctx.attr(runtime, 'generation') ?? null };
  const details = args.details();
  const targets = details.targets, assignments = details.assignments;
  const old = object(ctx.attr(runtime, 'assignments')), oldTargets = object(ctx.attr(runtime, 'targets'));
  const invalidate = details.invalidate;
  const changed = !isDeepStrictEqual(targets, oldTargets) || args.revision !== ctx.attr(runtime, 'revision') || invalidate.length > 0;
  let generation = ctx.attr(runtime, 'generation') ?? null;
  const planOrder = details.planOrder ?? requireNumber({ plan_order: ctx.attr(runtime, 'plan_order') ?? 0 }, 'plan_order', 'effects_assign runtime');
  if (changed) generation = ctx.now;
  if (changed || planOrder > requireNumber({ plan_order: ctx.attr(runtime, 'plan_order') ?? 0 }, 'plan_order', 'effects_assign runtime')) {
    const priorApplied = ctx.attr(runtime, 'applied');
    const applied = Object.fromEntries(Object.entries(priorApplied == null ? oldTargets : object(priorApplied)).filter(([key]) => !invalidate.includes(key)));
    ctx.emit('variable.update_sensor', { value: generation, replace_attributes: false,
      attributes: { targets, assignments, applied, revision: args.revision, generation, plan_order: planOrder } }, { entity_id: runtime });
  }
  if (changed) {
    const catalog = catalogOf(ctx);
    const commands: JsonValue[] = [];
    for (const [lamp, target] of Object.entries(details.targetViews())) {
      if (target.isRoom) continue;
      const previous = object(old[lamp]);
      let needed = ['Breathe', 'Colour loop'].includes(String(previous.effect));
      for (const channel of ['brightness', 'color'] as const) {
        const source = target.channels[channel];
        // A lamp leaving an effect its bulbs run is told to stop it, before its new light.
        const was = runningIn(channel, previous);
        if (was !== undefined && runningOn(channel, source) !== was) needed = true;
        if (source.kind === 'effect' && target.owners[channel].startsWith('channels:native:') && source.updated !== object(object(oldTargets[lamp])[channel]).updated) needed = true;
      }
      if (needed) for (const member of catalog.members[lamp] ?? []) if (ctx.get(member) === 'on') {
        for (const effect of ['stop_colorloop', 'stop_effect']) commands.push({ topic: catalog.topics[member] ?? null,
          payload: { effect }, members: [member], owners: [lamp], group: false });
      }
    }
    ctx.run('effects_emit', { commands, revision: args.revision, generation });
  }
  return { generation: ctx.attr(runtime, 'generation') ?? null };
}

export const transportHandlers: ScriptHandlers = {
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
  effects_frame_plan: typed('effects_frame_plan', {
    parse: args => ({
      catalog: parseFrameCatalog(args),
      targets: parseFrameTargets(args),
      transitionCap: args.transition_cap == null ? null : requireNumber(args, 'transition_cap', 'effects_frame_plan'),
      transitionRooms: args.transition_rooms == null ? null : requireArray(args, 'transition_rooms', 'effects_frame_plan'),
    }),
    run: framePlan,
  }),
  // Captured `commands`, `revision`, and `generation` are raw (1, 2, and 4
  // sites); `effect_targets` is raw twice with one `| default({})` fallback.
  // Nested payload/owners/members/topic are raw (2/2/1/1), so commands get a
  // strict object/string-array/string parser rather than permissive casts.
  effects_emit: typed('effects_emit', {
    parse: args => ({
      commands: parseEmitCommands(args),
      revision: requireString(args, 'revision', 'effects_emit'),
      // The runtime legitimately has no generation before its first assignment.
      generation: args.generation === null ? null : requireString(args, 'generation', 'effects_emit'),
      effectTargets: lazy(() => args.effect_targets === undefined ? {} : requireObject(args, 'effect_targets', 'effects_emit')),
    }),
    run: emitCommands,
  }),
  // Captured `targets`, `assignments`, and `revision` are raw (7, 5, and 7
  // sites); `invalidate` has `| default([])` twice; `plan_order` is raw five
  // times with one runtime-attribute default. Nested is_room/kind are raw once,
  // effect five times, owners twice, brightness/color once, and updated twice;
  // typed target views parse those fields without altering persisted targets.
  effects_assign: typed('effects_assign', {
    parse: args => ({
      revision: requireString(args, 'revision', 'effects_assign'),
      // The captured stale-revision stop precedes every other argument read.
      details: lazy(() => {
        const targets = requireObject(args, 'targets', 'effects_assign');
        return {
          targets,
          targetViews: lazy(() => parseAssignTargetViews(targets)),
          assignments: requireObject(args, 'assignments', 'effects_assign'),
          invalidate: args.invalidate === undefined ? [] : requireArray(args, 'invalidate', 'effects_assign'),
          planOrder: args.plan_order === undefined ? undefined : requireNumber(args, 'plan_order', 'effects_assign'),
        };
      }),
    }),
    run: assignEffects,
  }),
  // Captured `commands` is raw at both sites and nested `ids` is raw nine
  // times, so both the command list and each id list are parsed strictly.
  effects_filter_commands: withParsedArgs({
    parse: args => ({ commands: requireArray(args, 'commands', 'effects_filter_commands').map((raw, index) => {
      const command = requireObject({ raw }, 'raw', `effects_filter_commands.commands[${index}]`);
      return { raw: command, ids: requireStrings(command, 'ids', `effects_filter_commands.commands[${index}]`) };
    }) }),
    run: (ctx, args) => {
    const catalog = catalogOf(ctx), active = Object.keys(object(ctx.attr(runtime, 'assignments')));
    const commands: JsonValue[] = [];
    for (const command of args.commands) {
      const ids: string[] = [];
      for (const id of command.ids) {
        const members = catalog.groups[id] ?? [id];
        ids.push(...(members.some(x => active.includes(x)) ? members.filter(x => !active.includes(x)) : [id]));
      }
      if (ids.length) commands.push({ ...command.raw, ids: [...new Set(ids)] });
    }
    return { commands };
    },
  }),
};
