import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, OutputGuard, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, roundEven, clamp } from './scale.ts';
import { recordTimestamp } from './resolution.ts';

const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const strings = (v: JsonValue | undefined): string[] => list(v).filter((x): x is string => typeof x === 'string');
const runtime = 'sensor.ls_effects_runtime';
const revisionNow = (ctx: ScriptContext) => ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now;

export function framePlan(ctx: ScriptContext, args: JsonObject): JsonValue {
  const catalog = object(args.catalog), effects = object(catalog.effects), rows: JsonValue[] = [];
  for (const [lamp, raw] of Object.entries(object(args.targets))) {
    const target = object(raw), frames: JsonObject = {};
    let payload: JsonObject = {};
    const color = object(target.color), brightness = object(target.brightness);
    const channels = args.animation_tick && color.kind === 'effect' && color.effect === 'Candle' ? ['brightness'] : ['brightness', 'color'];
    for (const channel of channels) {
      const source = object(target[channel]);
      let value = source.value;
      if (source.kind === 'effect' && Object.hasOwn(effects, String(source.effect))) {
        const frameKey = `${source.instance}:${source.effect}`;
        if (!Object.hasOwn(frames, frameKey)) {
          frames[frameKey] = ctx.run(String(object(effects[String(source.effect)]).renderer), {
            timestamp: args.timestamp ?? 0, brightness: source.intensity ?? null, transition: 0.4,
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
    if (typeof args.transition_cap === 'number' && (!Array.isArray(args.transition_rooms) || args.transition_rooms.includes(target.area ?? null))) transition = Math.min(transition, args.transition_cap);
    payload = target.on ? { ...payload, transition } : { state: 'OFF', transition };
    if (ctx.get(lamp) === 'on') for (const member of strings(object(catalog.members)[lamp])) {
      if (ctx.get(member) === 'on') rows.push({ entity: member, owner: lamp,
        topic: object(catalog.topics)[member] ?? null, payload });
    }
  }
  return ctx.run('effects_group_plan', { rows, groups: catalog.multicast ?? [] });
}

export function emitCommands(ctx: ScriptContext, args: JsonObject): JsonObject {
  const revision = String(args.revision), generation = args.generation ?? null;
  let completed = true;
  const published: number[] = [];
  for (const raw of list(args.commands)) {
    const command = object(raw), payload = object(command.payload);
    const owners = strings(command.owners), members = strings(command.members);
    let allowed = revision === revisionNow(ctx) && generation === ctx.attr(runtime, 'generation');
    for (const owner of owners) if (ctx.get(owner) !== 'on' || payload.state !== 'OFF' && object(ctx.attr('sensor.ls_overrides', 'power'))[ctx.areas[owner] ?? ''] === false) allowed = false;
    for (const member of members) if (ctx.get(member) !== 'on') allowed = false;
    const effectTargets = object(args.effect_targets);
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

export function assignEffects(ctx: ScriptContext, args: JsonObject): JsonObject {
  if (args.revision !== revisionNow(ctx)) return { generation: ctx.attr(runtime, 'generation') ?? null };
  const targets = object(args.targets), assignments = object(args.assignments);
  const old = object(ctx.attr(runtime, 'assignments')), oldTargets = object(ctx.attr(runtime, 'targets'));
  const invalidate = strings(args.invalidate);
  const changed = !isDeepStrictEqual(targets, oldTargets) || args.revision !== ctx.attr(runtime, 'revision') || invalidate.length > 0;
  let generation = ctx.attr(runtime, 'generation') ?? null;
  const planOrder = args.plan_order ?? ctx.attr(runtime, 'plan_order') ?? 0;
  if (changed) {
    if (!Object.keys(assignments).length) ctx.emit('script.turn_off', {}, { entity_id: 'script.effects_engine' });
    generation = ctx.now;
  }
  if (changed || Number(planOrder) > Number(ctx.attr(runtime, 'plan_order') ?? 0)) {
    const priorApplied = ctx.attr(runtime, 'applied');
    const applied = Object.fromEntries(Object.entries(priorApplied == null ? oldTargets : object(priorApplied)).filter(([key]) => !invalidate.includes(key)));
    ctx.emit('variable.update_sensor', { value: generation, replace_attributes: false,
      attributes: { targets, assignments, applied, revision: args.revision ?? null, generation, plan_order: planOrder } }, { entity_id: runtime });
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
    ctx.run('effects_emit', { commands, revision: args.revision ?? null, generation });
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

export function engineTick(ctx: ScriptContext, args: JsonObject): JsonValue {
  if (!engineActive(ctx)) return null;
  // Runtime topology may change without restarting the actor or its fairness state.
  const served = { ...object(args.served) }, catalog = object(ctx.run('effects_catalog'));
  let admission = Number(args.admission ?? 0);
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
  effects_engine: startEngine, effects_engine_tick: engineTick,
  effects_frame_plan: framePlan, effects_emit: emitCommands, effects_assign: assignEffects,
  effects_filter_commands: (ctx, args) => {
    const catalog = object(ctx.run('effects_catalog')), active = Object.keys(object(ctx.attr(runtime, 'assignments')));
    const commands: JsonValue[] = [];
    for (const raw of list(args.commands)) {
      const command = object(raw), ids: string[] = [];
      for (const id of strings(command.ids)) {
        const members = strings(object(catalog.groups)[id] ?? [id]);
        ids.push(...(members.some(x => active.includes(x)) ? members.filter(x => !active.includes(x)) : [id]));
      }
      if (ids.length) commands.push({ ...command, ids: [...new Set(ids)] });
    }
    return { commands };
  },
};
