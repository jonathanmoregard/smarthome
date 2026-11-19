import type { OutputGuard, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, withParsedArgs } from '../runtime/parse.ts';
import { catalogOf } from '../runtime/catalog.ts';
import { typed } from '../runtime/entrypoints.ts';
import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { roundEven, clamp } from './scale.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import type { OpaqueMap, StoredFact, StoredValue } from '../parse/overrides.ts';
import { overridesRevision } from '../parse/sensors.ts';
import {
  assignedAs, assignedLamps, parseAssignArgs, parseEmitArgs, parseFilterArgs, parseFramePlanArgs, powerClosed,
  runtimeGeneration, runtimePlanOrder, runtimeState, warmEndColour,
} from '../parse/transport.ts';
import type { FrameColour, StoredChannels } from '../parse/transport.ts';
import type { GroupPlanResult } from './grouping.ts';

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
/**
 * The effects the bulbs run. Closed: the parse edge (`src/parse/transport.ts`)
 * turns an effect name into one of these, or into {@link FrameEffect}'s other
 * cases, once; nothing downstream holds an effect name as an open string.
 */
export type BulbEffectName = 'Candle' | 'Breathe' | 'Colour loop';
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
export function bulbEffect(name: BulbEffectName): BulbEffect {
  switch (name) {
    case 'Candle': return { channel: 'brightness', start: 'channel_change', colour: 'warm end' };
    case 'Breathe': return { channel: 'brightness', start: 'breathe', colour: 'none' };
    case 'Colour loop': return { channel: 'color', start: 'colorloop', colour: 'none' };
    default: { const unknown: never = name; throw new Error(`Unhandled bulb effect ${JSON.stringify(unknown)}`); }
  }
}

/**
 * The bulb effect a channel runs, or `undefined`. An effect runs on exactly one
 * channel: a Candle claim on colour alone holds the warm colour and starts
 * nothing, because the flicker is a brightness effect.
 */
function runningOn(channel: Channel, name: BulbEffectName | undefined): BulbEffectName | undefined {
  return name !== undefined && bulbEffect(name).channel === channel ? name : undefined;
}
/**
 * {@link runningOn} for an unparsed target: a stored runtime assignment, or a
 * resolved target `ls_dispatch` has not handed to the strict frame plan yet.
 * Read without raising, as every other read of those documents is
 * ({@link StoredChannels}).
 */
export function runningIn(channel: Channel, stored: StoredChannels): BulbEffectName | undefined {
  return runningOn(channel, stored.bulbEffectOn(channel));
}

/**
 * What a frame source's effect means to the frame plan, decided at the parse
 * edge against the frame plan's own catalog, as the oracle decides it with
 * `source.effect in catalog.effects`.
 */
export type FrameEffect =
  /** One the bulbs run: sent as a static light, then started. */
  | { kind: 'bulb effect'; name: BulbEffectName }
  /**
   * A name the catalog does not list. The oracle's membership test is false,
   * so it sends the source as its value (`value | float` for brightness, the
   * strict colour read for colour); so does the port, deliberately.
   */
  | { kind: 'uncatalogued effect'; name: string }
  | { kind: 'not an effect' };

export interface FrameSource {
  kind: string;
  effect: FrameEffect;
  details: () => {
    intensity: number | null;
    /** The source's `value | float`. */
    level: number;
    /** The source's value read strictly as a colour (raises with `context`). */
    colour: (context: string) => FrameColour;
  };
}
export interface FrameTarget {
  brightness: FrameSource;
  color: FrameSource;
  manual: boolean;
  on: boolean;
  transition: number;
  /** The target's area as stored, compared by identity with the transition rooms. */
  area: StoredFact;
}
export interface FramePlanArgs {
  catalog: {
    members: Record<string, string[]>;
    topics: Record<string, string>;
    /** The multicast groups, forwarded to the group planner unread. */
    multicast: () => Verbatim;
  };
  targets: Record<string, FrameTarget>;
  transitionCap: number | null;
  transitionRooms: StoredValue[] | null;
}
/** One lamp's light. Keys are written in the order the captured payload has them. */
type FramePayload = { brightness?: number; color_temp?: number; color?: { rgb: string }; state?: 'OFF'; transition?: number };
type FrameRow = { entity: string; owner: string; topic: string | null; payload: FramePayload };

export interface EmitCommand {
  /** The MQTT body: the command's payload, serialised as given. */
  body: string;
  /** Does the payload switch the lamp off (`state == 'OFF'`)? */
  turnsOff: boolean;
  owners: string[];
  members: string[];
  topic: string;
}
export interface EmitArgs {
  commands: Array<() => EmitCommand>;
  revision: string;
  generation: string | null;
  /** Effect targets a guard carries, by owner. */
  effectTargets: () => OpaqueMap;
}

export interface AssignArgs {
  revision: string;
  details: () => AssignDetails;
}
export interface AssignDetails {
  /** The assigned targets, persisted as given. */
  targets: Verbatim;
  targetViews: () => Record<string, {
    isRoom: boolean;
    /** `effect` is the bulb effect a channel names, `undefined` for any other source or name. */
    channels: Record<Channel, { kind: string; effect: BulbEffectName | undefined; updated: number | null }>;
    owners: Record<Channel, string>;
  }>;
  /** The assignments, persisted as given. */
  assignments: Verbatim;
  /** Keys to drop from the applied map, compared by identity. */
  invalidate: StoredValue[];
  planOrder: number | undefined;
}
export interface FilterArgs {
  /** Each command as given, and its ids. */
  commands: Array<{ document: Verbatim; ids: string[] }>;
}

/**
 * Each lamp's light, sent once. A channel running a bulb effect gets a static
 * value: brightness is the effect's intensity (the level it runs at, and the
 * candle's ceiling); colour is what the effect holds (see {@link BulbEffect}).
 * The start follows in a second emission, so it always lands after the light.
 */
export function framePlan(ctx: ScriptContext, args: FramePlanArgs): GroupPlanResult {
  const catalog = args.catalog, rows: FrameRow[] = [];
  for (const [lamp, target] of Object.entries(args.targets)) {
    let payload: FramePayload = {};
    const color = target.color, brightness = target.brightness;
    for (const channel of ['brightness', 'color'] as const) {
      const source = target[channel];
      const details = source.details();
      if (channel === 'brightness') {
        payload.brightness = roundEven(clamp(frameLevel(source.effect, details), 1, 254));
        continue;
      }
      const colour = frameColourOf(ctx, source.effect, details, `effects_frame_plan.targets.${lamp}.color.value`);
      if (colour === undefined) continue;
      if (colour.kind === 'kelvin') payload.color_temp = roundEven(1_000_000 / colour.kelvin);
      else payload.color = { rgb: colour.rgb.join(',') };
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

type FrameDetails = ReturnType<FrameSource['details']>;

/** A brightness source's level: a bulb effect runs at its intensity, anything else is its value. */
function frameLevel(effect: FrameEffect, details: FrameDetails): number {
  switch (effect.kind) {
    case 'bulb effect': return jinjaFloat(details.intensity);
    case 'uncatalogued effect':
    case 'not an effect': return details.level;
    default: { const unknown: never = effect; throw new Error(`Unhandled frame effect ${JSON.stringify(unknown)}`); }
  }
}

/** A colour source's colour, or `undefined` when the bulb effect owns the colour and nothing is sent. */
function frameColourOf(ctx: ScriptContext, effect: FrameEffect, details: FrameDetails, context: string): FrameColour | undefined {
  switch (effect.kind) {
    case 'bulb effect': {
      const held = bulbEffect(effect.name).colour;
      switch (held) {
        case 'warm end': return warmEndColour(ctx, context);
        case 'none': return undefined;
        default: { const unknown: never = held; throw new Error(`Unhandled bulb effect colour ${JSON.stringify(unknown)}`); }
      }
    }
    case 'uncatalogued effect':
    case 'not an effect': return details.colour(context);
    default: { const unknown: never = effect; throw new Error(`Unhandled frame effect ${JSON.stringify(unknown)}`); }
  }
}

/**
 * `effects_emit`'s result. Both fields are built here from the publishes this
 * call made, so nothing is passed through and the type is lossless.
 */
export type EmitResult = { published_at: number[]; completed: boolean };
/**
 * `effects_assign`'s result.
 *
 * `generation` is carried: it is the runtime sensor's own attribute, read raw
 * and handed back raw, and `ls_dispatch` compares it with `!==` against the
 * same attribute. Narrowing it to a string would be a projection of a value
 * the gate compares.
 */
export type AssignResult = { generation: Verbatim };

export function emitCommands(ctx: ScriptContext, args: EmitArgs): EmitResult {
  const revision = args.revision, generation = args.generation;
  let completed = true;
  const published: number[] = [];
  for (const parseCommand of args.commands) {
    // Captured: `allowed` opens with the bare revision read; the command's
    // fields are read after it.
    const current = overridesRevision(ctx, 'effects_emit');
    const command = parseCommand();
    const owners = command.owners, members = command.members;
    let allowed = revision === current && generation === ctx.attr(runtime, 'generation');
    for (const owner of owners) if (ctx.get(owner) !== 'on' || !command.turnsOff && powerClosed(ctx, ctx.areas[owner] ?? '')) allowed = false;
    for (const member of members) if (ctx.get(member) !== 'on') allowed = false;
    const effectTargets = args.effectTargets();
    if (Object.keys(effectTargets).length) for (const owner of owners) {
      if (!Object.hasOwn(effectTargets, owner) || !assignedAs(ctx, owner, effectTargets[owner]!)) allowed = false;
    }
    if (allowed && ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') === 'on') {
      published.push(recordTimestamp(ctx.now));
      const guard: OutputGuard = { revision, generation, owners, members,
        ...(Object.keys(effectTargets).length ? { effectTargets } : {}) };
      ctx.emit('mqtt.publish', { topic: command.topic, payload: command.body, qos: 0, retain: false }, undefined, guard);
    } else completed = false;
  }
  return { published_at: published, completed: completed && revision === overridesRevision(ctx, 'effects_emit') && generation === ctx.attr(runtime, 'generation') };
}

type StopCommand = { topic: string; payload: { effect: string }; members: string[]; owners: string[]; group: false };

export function assignEffects(ctx: ScriptContext, args: AssignArgs): AssignResult {
  if (args.revision !== overridesRevision(ctx, 'effects_assign')) return { generation: runtimeGeneration(ctx) };
  const details = args.details();
  const targets = details.targets, assignments = details.assignments;
  const stored = runtimeState(ctx);
  const invalidate = details.invalidate;
  const changed = !stored.targetsEqual(targets) || args.revision !== ctx.attr(runtime, 'revision') || invalidate.length > 0;
  let generation: Verbatim | string = runtimeGeneration(ctx);
  const planOrder = details.planOrder === undefined ? runtimePlanOrder(ctx) : details.planOrder;
  if (changed) generation = ctx.now;
  if (changed || planOrder > runtimePlanOrder(ctx)) {
    const applied = Object.fromEntries(Object.entries(stored.applied).filter(([key]) => !invalidate.includes(key)));
    ctx.emit('variable.update_sensor', { value: generation, replace_attributes: false,
      attributes: { targets, assignments, applied, revision: args.revision, generation, plan_order: planOrder } }, { entity_id: runtime });
  }
  if (changed) {
    const catalog = catalogOf(ctx);
    const commands: StopCommand[] = [];
    for (const [lamp, target] of Object.entries(details.targetViews())) {
      if (target.isRoom) continue;
      const previous = stored.previous(lamp);
      let needed = ['Breathe', 'Colour loop'].includes(previous.effect);
      for (const channel of ['brightness', 'color'] as const) {
        const source = target.channels[channel];
        // A lamp leaving an effect its bulbs run is told to stop it, before its new light.
        const was = runningIn(channel, previous.channels);
        if (was !== undefined && runningOn(channel, source.effect) !== was) needed = true;
        if (source.kind === 'effect' && target.owners[channel].startsWith('channels:native:') && source.updated !== previous.updated(channel)) needed = true;
      }
      if (needed) for (const member of catalog.members[lamp] ?? []) if (ctx.get(member) === 'on') {
        // A member the catalog gives no topic is skipped, as the light path
        // skips it: `framePlan` hands its row to `effects_group_plan` with
        // `topic: null`, which rejects it as an invalid endpoint row. Pushing
        // the null here instead made `effects_emit`'s command parse raise and
        // aborted the whole dispatch.
        const topic = catalog.topics[member];
        if (topic === undefined) continue;
        for (const effect of ['stop_colorloop', 'stop_effect']) commands.push({ topic,
          payload: { effect }, members: [member], owners: [lamp], group: false });
      }
    }
    ctx.run('effects_emit', { commands, revision: args.revision, generation });
  }
  return { generation: runtimeGeneration(ctx) };
}

export const transportHandlers: ScriptHandlers = {
  effects_frame_plan: typed('effects_frame_plan', { parse: parseFramePlanArgs, run: framePlan }),
  effects_emit: typed('effects_emit', { parse: parseEmitArgs, run: emitCommands }),
  effects_assign: typed('effects_assign', { parse: parseAssignArgs, run: assignEffects }),
  effects_filter_commands: withParsedArgs({
    parse: parseFilterArgs,
    run: (ctx, args) => {
    const catalog = catalogOf(ctx), active = assignedLamps(ctx);
    const commands: Verbatim[] = [];
    for (const command of args.commands) {
      const ids: string[] = [];
      for (const id of command.ids) {
        const members = catalog.groups[id] ?? [id];
        ids.push(...(members.some(x => active.includes(x)) ? members.filter(x => !active.includes(x)) : [id]));
      }
      if (ids.length) commands.push(withFields(command.document, { ids: [...new Set(ids)] }));
    }
    return { commands };
    },
  }),
};
