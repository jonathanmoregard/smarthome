import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, OutputGuard, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaTruthy, requireArray, requireNumber, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { object, roundEven, clamp } from './scale.ts';
import { recordTimestamp } from './resolution.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const strings = (v: JsonValue | undefined): string[] => list(v).filter((x): x is string => typeof x === 'string');
const runtime = 'sensor.ls_effects_runtime';
const revisionNow = (ctx: ScriptContext) => ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now;

interface FramePlanArgs {
  catalog: JsonObject;
  targets: JsonObject;
  animationTick: boolean;
  timestamp: number;
  transitionCap: number | null;
  transitionRooms: JsonValue[] | null;
}

interface EmitArgs {
  commands: JsonValue[];
  revision: string;
  generation: string;
  effectTargets: JsonObject;
}

interface AssignArgs {
  targets: JsonObject;
  assignments: JsonObject;
  revision: string;
  invalidate: JsonValue[];
  planOrder: number | undefined;
}

interface EngineTickArgs {
  served: JsonObject;
  admission: number;
  catalog: JsonObject;
}

export function framePlan(ctx: ScriptContext, args: FramePlanArgs): JsonValue {
  const catalog = args.catalog, effects = object(catalog.effects), rows: JsonValue[] = [];
  for (const [lamp, raw] of Object.entries(args.targets)) {
    const target = object(raw), frames: JsonObject = {};
    let payload: JsonObject = {};
    const color = object(target.color), brightness = object(target.brightness);
    const channels = args.animationTick && color.kind === 'effect' && color.effect === 'Candle' ? ['brightness'] : ['brightness', 'color'];
    for (const channel of channels) {
      const source = object(target[channel]);
      let value = source.value;
      if (source.kind === 'effect' && Object.hasOwn(effects, String(source.effect))) {
        const frameKey = `${source.instance}:${source.effect}`;
        if (!Object.hasOwn(frames, frameKey)) {
          frames[frameKey] = ctx.run(String(object(effects[String(source.effect)]).renderer), {
            timestamp: args.timestamp, brightness: source.intensity ?? null, transition: 0.4,
            phase: object(catalog.phases)[lamp] ?? lamp,
          });
        }
        const frame = object(frames[frameKey]);
        value = channel === 'brightness' ? frame.brightness : { rgb: frame.rgb ?? null };
      }
      if (channel === 'brightness') payload.brightness = roundEven(clamp(Number(value), 1, 254));
      else {
        const colorValue = object(value);
        if (Object.hasOwn(colorValue, 'kelvin')) payload.color_temp = roundEven(1_000_000 / Number(colorValue.kelvin));
        else payload.color = { rgb: list(colorValue.rgb).join(',') };
      }
    }
    const manual = Object.values(object(target.owners)).some(x => String(x).startsWith('channels:'));
    let transition = target.on ? (brightness.kind === 'effect' || color.kind === 'effect' ? 0.4 : manual ? 0.2 : Number(target.transition ?? 3)) : Number(target.transition ?? 3);
    if (args.transitionCap !== null && (args.transitionRooms === null || args.transitionRooms.includes(target.area ?? null))) transition = Math.min(transition, args.transitionCap);
    payload = target.on ? { ...payload, transition } : { state: 'OFF', transition };
    if (ctx.get(lamp) === 'on') for (const member of strings(object(catalog.members)[lamp])) {
      if (ctx.get(member) === 'on') rows.push({ entity: member, owner: lamp,
        topic: object(catalog.topics)[member] ?? null, payload });
    }
  }
  return ctx.run('effects_group_plan', { rows, groups: catalog.multicast ?? [] });
}

export function emitCommands(ctx: ScriptContext, args: EmitArgs): JsonObject {
  const revision = args.revision, generation = args.generation;
  let completed = true;
  const published: number[] = [];
  for (const raw of args.commands) {
    const command = object(raw), payload = object(command.payload);
    const owners = strings(command.owners), members = strings(command.members);
    let allowed = revision === revisionNow(ctx) && generation === ctx.attr(runtime, 'generation');
    for (const owner of owners) if (ctx.get(owner) !== 'on' || payload.state !== 'OFF' && object(ctx.attr('sensor.ls_overrides', 'power'))[ctx.areas[owner] ?? ''] === false) allowed = false;
    for (const member of members) if (ctx.get(member) !== 'on') allowed = false;
    const effectTargets = args.effectTargets;
    if (Object.keys(effectTargets).length) for (const owner of owners) {
      if (!Object.hasOwn(effectTargets, owner) || !isDeepStrictEqual(object(ctx.attr(runtime, 'assignments'))[owner], effectTargets[owner])) allowed = false;
    }
    if (allowed && ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') === 'on') {
      published.push(recordTimestamp(ctx.now));
      const guard: OutputGuard = { revision, generation, owners, members,
        ...(Object.keys(effectTargets).length ? { effectTargets } : {}) };
      ctx.emit('mqtt.publish', { topic: command.topic ?? null, payload: JSON.stringify(payload), qos: 0, retain: false }, undefined, guard);
    } else completed = false;
  }
  return { published_at: published, completed: completed && revision === revisionNow(ctx) && generation === ctx.attr(runtime, 'generation') };
}

export function assignEffects(ctx: ScriptContext, args: AssignArgs): JsonObject {
  if (args.revision !== revisionNow(ctx)) return { generation: ctx.attr(runtime, 'generation') ?? null };
  const targets = args.targets, assignments = args.assignments;
  const old = object(ctx.attr(runtime, 'assignments')), oldTargets = object(ctx.attr(runtime, 'targets'));
  const invalidate = args.invalidate;
  const changed = !isDeepStrictEqual(targets, oldTargets) || args.revision !== ctx.attr(runtime, 'revision') || invalidate.length > 0;
  let generation = ctx.attr(runtime, 'generation') ?? null;
  const planOrder = args.planOrder ?? requireNumber({ plan_order: ctx.attr(runtime, 'plan_order') ?? 0 }, 'plan_order', 'effects_assign runtime');
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
    const catalog = object(ctx.run('effects_catalog'));
    const commands: JsonValue[] = [];
    for (const [lamp, raw] of Object.entries(targets)) {
      const target = object(raw);
      if (target.is_room) continue;
      let needed = ['Breathe', 'Colour loop'].includes(String(object(old[lamp]).effect));
      for (const channel of ['brightness', 'color']) {
        const source = object(target[channel]);
        if (source.kind === 'effect' && String(object(target.owners)[channel] ?? '').startsWith('channels:native:') && source.updated !== object(object(oldTargets[lamp])[channel]).updated) needed = true;
      }
      if (needed) for (const member of strings(object(catalog.members)[lamp])) if (ctx.get(member) === 'on') {
        for (const effect of ['stop_colorloop', 'stop_effect']) commands.push({ topic: object(catalog.topics)[member] ?? null,
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
    const targets = Object.fromEntries(Object.entries(object(ctx.attr(runtime, 'assignments'))).filter(([lamp, raw]) =>
      Object.hasOwn(object(catalog.members), lamp) && ctx.get(lamp) === 'on' && object(raw).on && power[ctx.areas[lamp] ?? ''] !== false));
    const batch = object(ctx.run('effects_frame_plan', { targets, catalog, timestamp: recordTimestamp(ctx.now), animation_tick: true }));
    const commands = list(batch.commands).map(object).sort((a, b) => String(a.topic) < String(b.topic) ? -1 : String(a.topic) > String(b.topic) ? 1 : 0);
    let chosen: JsonObject | undefined, oldest = Infinity;
    for (const command of commands) {
      const age = Math.max(-1, ...strings(command.members).map(member => Number(served[member] ?? -1)));
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
      served: requireObject(args, 'served', 'effects_engine_tick'),
      admission: requireNumber(args, 'admission', 'effects_engine_tick'),
      catalog: requireObject(args, 'catalog', 'effects_engine_tick'),
    }),
    run: engineTick,
  }),
  // Captured fields: `catalog`, `targets`, and `timestamp` are raw (6, 2,
  // and 1 sites); `animation_tick` has `| default(false)` once; and
  // `transition_cap`/`transition_rooms` each have a `default(none)` path plus
  // a raw use. Defaults stay observable while supplied values remain strict.
  effects_frame_plan: withParsedArgs({
    parse: args => ({
      catalog: requireObject(args, 'catalog', 'effects_frame_plan'),
      targets: requireObject(args, 'targets', 'effects_frame_plan'),
      animationTick: jinjaTruthy(args.animation_tick),
      timestamp: requireNumber(args, 'timestamp', 'effects_frame_plan'),
      transitionCap: args.transition_cap == null ? null : requireNumber(args, 'transition_cap', 'effects_frame_plan'),
      transitionRooms: args.transition_rooms == null ? null : requireArray(args, 'transition_rooms', 'effects_frame_plan'),
    }),
    run: framePlan,
  }),
  // Captured `commands`, `revision`, and `generation` are raw (1, 2, and 4
  // sites); `effect_targets` is raw twice with one `| default({})` fallback.
  effects_emit: withParsedArgs({
    parse: args => ({
      commands: requireArray(args, 'commands', 'effects_emit'),
      revision: requireString(args, 'revision', 'effects_emit'),
      generation: requireString(args, 'generation', 'effects_emit'),
      effectTargets: args.effect_targets === undefined ? {} : requireObject(args, 'effect_targets', 'effects_emit'),
    }),
    run: emitCommands,
  }),
  // Captured `targets`, `assignments`, and `revision` are raw (7, 5, and 7
  // sites); `invalidate` has `| default([])` twice; `plan_order` is raw five
  // times with one runtime-attribute default. Explicit malformed values raise.
  effects_assign: withParsedArgs({
    parse: args => ({
      targets: requireObject(args, 'targets', 'effects_assign'),
      assignments: requireObject(args, 'assignments', 'effects_assign'),
      revision: requireString(args, 'revision', 'effects_assign'),
      invalidate: args.invalidate === undefined ? [] : requireArray(args, 'invalidate', 'effects_assign'),
      planOrder: args.plan_order === undefined ? undefined : requireNumber(args, 'plan_order', 'effects_assign'),
    }),
    run: assignEffects,
  }),
  // Captured `commands` is raw at both sites, so it must be an array.
  effects_filter_commands: withParsedArgs({
    parse: args => ({ commands: requireArray(args, 'commands', 'effects_filter_commands') }),
    run: (ctx, args) => {
    const catalog = object(ctx.run('effects_catalog')), active = Object.keys(object(ctx.attr(runtime, 'assignments')));
    const commands: JsonValue[] = [];
    for (const raw of args.commands) {
      const command = object(raw), ids: string[] = [];
      for (const id of strings(command.ids)) {
        const members = strings(object(catalog.groups)[id] ?? [id]);
        ids.push(...(members.some(x => active.includes(x)) ? members.filter(x => !active.includes(x)) : [id]));
      }
      if (ids.length) commands.push({ ...command, ids: [...new Set(ids)] });
    }
    return { commands };
    },
  }),
};
