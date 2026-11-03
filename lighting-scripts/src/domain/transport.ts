import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, OutputGuard, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, jinjaTruthy, object, requireArray, requireNumber, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { catalogOf } from '../runtime/catalog.ts';
import { typed } from '../runtime/entrypoints.ts';
import { roundEven, clamp } from './scale.ts';
import { recordTimestamp } from './resolution.ts';
import { requireRgb } from '../parse/scale.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const strings = (v: JsonValue | undefined): string[] => list(v).filter((x): x is string => typeof x === 'string');
const runtime = 'sensor.ls_effects_runtime';
const revisionNow = (ctx: ScriptContext) => ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now;

interface FrameSource {
  kind: string;
  effect: string | null;
  details: () => { instance: string | null; intensity: number | null; value: JsonValue | undefined };
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
  effects: Record<string, { renderer: string }>;
  phases: () => JsonObject;
  members: Record<string, string[]>;
  topics: Record<string, string>;
  multicast: () => JsonValue[];
}
interface FramePlanArgs {
  catalog: FrameCatalog;
  targets: Record<string, FrameTarget>;
  animationTick: boolean;
  timestamp: number;
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

interface EngineTickArgs {
  served: Record<string, number>;
  admission: number;
  catalog: JsonObject;
}

function lazy<T>(parse: () => T): () => T {
  let parsed = false;
  let value: T;
  return () => {
    if (!parsed) {
      value = parse();
      parsed = true;
    }
    return value;
  };
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
    // The animation-tick Candle branch skips the color channel entirely.
    details: lazy(() => ({
      instance: kind === 'effect' ? requireString(source, 'instance', `${context}.${channel}`) : null,
      intensity: kind === 'effect' ? requireNumber(source, 'intensity', `${context}.${channel}`) : null,
      value: source.value,
    })),
  };
}

function parseFrameCatalog(args: JsonObject): FrameCatalog {
  const catalog = requireObject(args, 'catalog', 'effects_frame_plan');
  const effectsRaw = requireObject(catalog, 'effects', 'effects_frame_plan.catalog');
  const membersRaw = requireObject(catalog, 'members', 'effects_frame_plan.catalog');
  const topicsRaw = requireObject(catalog, 'topics', 'effects_frame_plan.catalog');
  return {
    effects: Object.fromEntries(Object.entries(effectsRaw).map(([name, raw]) => {
      const effect = requireObject({ raw }, 'raw', `effects_frame_plan.catalog.effects.${name}`);
      return [name, { renderer: requireString(effect, 'renderer', `effects_frame_plan.catalog.effects.${name}`) }];
    })),
    // These raw fields occur only when their captured control-flow site runs.
    phases: lazy(() => requireObject(catalog, 'phases', 'effects_frame_plan.catalog')),
    members: Object.fromEntries(Object.keys(membersRaw).map(lamp =>
      [lamp, requireStrings(membersRaw, lamp, 'effects_frame_plan.catalog.members')])),
    topics: Object.fromEntries(Object.keys(topicsRaw).map(member =>
      [member, requireString(topicsRaw, member, 'effects_frame_plan.catalog.topics')])),
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

function parseServed(args: JsonObject): Record<string, number> {
  const served = requireObject(args, 'served', 'effects_engine_tick');
  return Object.fromEntries(Object.keys(served).map(member =>
    [member, requireNumber(served, member, 'effects_engine_tick.served')]));
}

export function framePlan(ctx: ScriptContext, args: FramePlanArgs): JsonValue {
  const catalog = args.catalog, effects = catalog.effects, rows: JsonValue[] = [];
  for (const [lamp, target] of Object.entries(args.targets)) {
    const frames: JsonObject = {};
    let payload: JsonObject = {};
    const color = target.color, brightness = target.brightness;
    const channels: Array<'brightness' | 'color'> = args.animationTick && color.kind === 'effect' && color.effect === 'Candle' ? ['brightness'] : ['brightness', 'color'];
    for (const channel of channels) {
      const source = target[channel];
      const { instance, intensity, value: sourceValue } = source.details();
      let value = sourceValue;
      if (source.kind === 'effect' && source.effect !== null && Object.hasOwn(effects, source.effect)) {
        const frameKey = `${instance}:${source.effect}`;
        if (!Object.hasOwn(frames, frameKey)) {
          frames[frameKey] = ctx.run(effects[source.effect]!.renderer, {
            timestamp: args.timestamp, brightness: intensity ?? null, transition: 0.4,
            phase: catalog.phases()[lamp] ?? lamp,
          });
        }
        const frame = object(frames[frameKey]);
        value = channel === 'brightness' ? frame.brightness : { rgb: frame.rgb ?? null };
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
  return ctx.run('effects_group_plan', { rows, groups: catalog.multicast() });
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
  if (changed) {
    if (!Object.keys(assignments).length) ctx.emit('script.turn_off', {}, { entity_id: 'script.effects_engine' });
    generation = ctx.now;
  }
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
      let needed = ['Breathe', 'Colour loop'].includes(String(object(old[lamp]).effect));
      for (const channel of ['brightness', 'color']) {
        const typedChannel = channel as 'brightness' | 'color';
        const source = target.channels[typedChannel];
        if (source.kind === 'effect' && target.owners[typedChannel].startsWith('channels:native:') && source.updated !== object(object(oldTargets[lamp])[channel]).updated) needed = true;
      }
      if (needed) for (const member of catalog.members[lamp] ?? []) if (ctx.get(member) === 'on') {
        for (const effect of ['stop_colorloop', 'stop_effect']) commands.push({ topic: catalog.topics[member] ?? null,
          payload: { effect }, members: [member], owners: [lamp], group: false });
      }
    }
    ctx.run('effects_emit', { commands, revision: args.revision, generation });
  }
  if (Object.keys(assignments).length) ctx.emit('script.turn_on', {}, { entity_id: 'script.effects_engine' });
  return { generation: ctx.attr(runtime, 'generation') ?? null };
}

const tickScript = 'effects_engine_tick';
function engineActive(ctx: ScriptContext): boolean {
  return Object.keys(object(ctx.attr(runtime, 'assignments'))).length > 0 && ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') === 'on';
}

/** A continuation replaces HA's blocking delay without holding the input queue. */
export function startEngine(ctx: ScriptContext): JsonValue {
  if (engineActive(ctx) && !(ctx.scheduled ?? []).some(task => task.script === tickScript)) {
    ctx.schedule(tickScript, { served: {}, admission: 0, catalog: ctx.run('effects_catalog') }, 200);
  }
  return null;
}

export function engineTick(ctx: ScriptContext, args: EngineTickArgs): JsonValue {
  if (!engineActive(ctx)) return null;
  // Runtime topology may change without restarting the actor or its fairness state.
  const served = { ...args.served }, catalog = object(ctx.run('effects_catalog'));
  let admission = args.admission;
  if (ctx.attr(runtime, 'revision') === revisionNow(ctx)) {
    const revision = ctx.attr(runtime, 'revision') ?? null, generation = ctx.attr(runtime, 'generation') ?? null;
    const power = object(ctx.attr('sensor.ls_overrides', 'power'));
    // Captured: `... and target.on and power.get(area_id(lamp),true)`. Both sit
    // in a Jinja boolean position. `power.get` defaults only on an ABSENT area;
    // `power[area] !== false` got that case right but admitted every other
    // falsy value, and bare truthiness on `on` admitted empty containers.
    const admits = (area: string) => jinjaTruthy(Object.hasOwn(power, area) ? power[area] : true);
    const targets = Object.fromEntries(Object.entries(object(ctx.attr(runtime, 'assignments'))).filter(([lamp, raw]) =>
      Object.hasOwn(object(catalog.members), lamp) && ctx.get(lamp) === 'on'
      && jinjaTruthy(object(raw).on) && admits(ctx.areas[lamp] ?? '')));
    const batch = object(ctx.run('effects_frame_plan', { targets, catalog, timestamp: recordTimestamp(ctx.now), animation_tick: true }));
    const commands = list(batch.commands).map(object).sort((a, b) => String(a.topic) < String(b.topic) ? -1 : String(a.topic) > String(b.topic) ? 1 : 0);
    let chosen: JsonObject | undefined, oldest = Infinity;
    for (const command of commands) {
      const age = Math.max(-1, ...strings(command.members).map(member => served[member] ?? -1));
      if (age < oldest) { chosen = command; oldest = age; }
    }
    if (chosen) {
      ctx.run('effects_emit', { commands: [chosen], revision, generation, effect_targets: targets });
      admission++;
      for (const member of strings(chosen.members)) served[member] = admission;
    }
  }
  if (engineActive(ctx)) ctx.schedule(tickScript, { served, admission, catalog }, 200);
  return null;
}

export const transportHandlers: ScriptHandlers = {
  effects_engine: startEngine,
  // Captured `effects_engine` reads `served`, `admission`, and `catalog` raw
  // (6, 2, and 3 sites; no numeric filter), so malformed values must raise.
  effects_engine_tick: withParsedArgs({
    parse: args => ({
      served: parseServed(args),
      admission: requireNumber(args, 'admission', 'effects_engine_tick'),
      catalog: requireObject(args, 'catalog', 'effects_engine_tick'),
    }),
    run: engineTick,
  }),
  // Captured fields: `catalog`, `targets`, and `timestamp` are raw (6, 2,
  // and 1 sites); `animation_tick` has `| default(false)` once; and
  // `transition_cap`/`transition_rooms` each have a `default(none)` path plus
  // a raw use. Nested catalog/target fields are also raw: effects 2, renderer
  // 1, phases/members/topics/multicast/owners/area 1 each, color 5, brightness
  // 7, kind 4, effect 8, instance/intensity 1 each, kelvin 2, rgb/on 4 each,
  // and transition 10. `value` is raw four times but has one `| float`, so
  // brightness uses jinjaFloat while color uses strict object/color parsers.
  effects_frame_plan: withParsedArgs({
    parse: args => ({
      catalog: parseFrameCatalog(args),
      targets: parseFrameTargets(args),
      animationTick: jinjaTruthy(args.animation_tick),
      timestamp: requireNumber(args, 'timestamp', 'effects_frame_plan'),
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
