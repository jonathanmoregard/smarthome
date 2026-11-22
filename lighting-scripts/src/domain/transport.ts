import type { OutputGuard } from '../runtime/context.ts';
import type { Catalog } from '../runtime/catalog.ts';
import type { Effect, HouseView, Plan } from '../runtime/effects.ts';
import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { roundEven, clamp } from './scale.ts';
import type { OpaqueMap, StoredFact, StoredValue } from '../parse/overrides.ts';
import { overridesRevision } from '../parse/sensors.ts';
import { assignedAs, powerClosed, runtimeGeneration, runtimeGenerationIs, runtimePlanOrder, runtimeState, warmEndColour }
  from '../parse/transport.ts';
import type { FrameColour, RuntimeState, StoredChannels } from '../parse/transport.ts';
import type { LampOrRoom } from './types/lighting-state.ts';
import type { OverlayKey } from './types/overlay.ts';
import type { BulbId, LampId } from './types/ids.ts';

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
  /**
   * Is a lamp whose previous assignment names this effect at its top level
   * told to stop it, whatever its channels say? The captured rule is
   * `old.get(L,{}).get('effect') in ['Breathe','Colour loop']`: written when
   * Candle was the software renderer, so a Candle named there stops nothing by
   * name (its stop comes from the channel it runs, {@link runningIn}).
   */
  readonly stoppedByName: boolean;
};
export function bulbEffect(name: BulbEffectName): BulbEffect {
  switch (name) {
    case 'Candle': return { channel: 'brightness', start: 'channel_change', colour: 'warm end', stoppedByName: false };
    case 'Breathe': return { channel: 'brightness', start: 'breathe', colour: 'none', stoppedByName: true };
    case 'Colour loop': return { channel: 'color', start: 'colorloop', colour: 'none', stoppedByName: true };
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
  /**
   * One the bulbs run: sent as a static light, then started. `intensity` is
   * the level it runs at (the candle's ceiling), read when the plan reaches
   * the channel.
   */
  | { kind: 'bulb effect'; name: BulbEffectName; intensity: () => number }
  /**
   * A name the catalog does not list. The oracle's membership test is false,
   * so it sends the source as its value (`value | float` for brightness, the
   * strict colour read for colour); so does the port, deliberately.
   */
  | { kind: 'uncatalogued effect'; name: string }
  | { kind: 'not an effect' }
  /**
   * The channel shows nothing (`{kind: 'none'}`: an off lamp's channel, or a
   * lit lamp that reports no colour). Nothing is read and nothing is sent for it.
   */
  | { kind: 'no value' };

export interface FrameSource {
  kind: string;
  effect: FrameEffect;
  /**
   * Read when the plan reaches the channel. Raises for an effect source with
   * no finite `intensity`, on either channel.
   */
  details: () => {
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
    /** Each lamp's bulbs. */
    members: Record<LampId, BulbId[]>;
    /** Each bulb's MQTT command topic. */
    topics: Record<BulbId, string>;
    /** The multicast groups, forwarded to the group planner unread. */
    multicast: () => Verbatim;
  };
  targets: Record<string, FrameTarget>;
  transitionCap: number | null;
  transitionRooms: StoredValue[] | null;
}
/** One lamp's light. Keys are written in the order the captured payload has them. */
type FramePayload = { brightness?: number; color_temp?: number; color?: { rgb: string }; state?: 'OFF'; transition?: number };
export type FrameRow = { entity: string; owner: string; topic: string | null; payload: FramePayload };

export interface EmitCommand {
  /** The MQTT body: the command's payload, serialised as given. */
  body: string;
  /** Does the payload switch the lamp off (`state == 'OFF'`)? */
  turnsOff: boolean;
  /** The lamps whose light the command carries. */
  owners: LampId[];
  members: BulbId[];
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
    lampOrRoom: LampOrRoom;
    /** `effect` is the bulb effect a channel names, `undefined` for any other source or name. */
    channels: Record<Channel, { kind: string; effect: BulbEffectName | undefined; updated: number | null }>;
    /** The overlay owning each channel; `base` (the schedule) and an absent owner read as saved keys. */
    owners: Record<Channel, OverlayKey>;
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


/** One row per on member of each on lamp, carrying that lamp's light. */
export function frameRows(view: HouseView, args: FramePlanArgs): FrameRow[] {
  const catalog = args.catalog, rows: FrameRow[] = [];
  // The targets are lighting-state entry keys, plain text until those lists are parsed; look their lamps up as text.
  const membersByText: Readonly<Record<string, BulbId[] | undefined>> = catalog.members;
  for (const [lamp, target] of Object.entries(args.targets)) {
    let payload: FramePayload = {};
    const color = target.color, brightness = target.brightness;
    for (const channel of ['brightness', 'color'] as const) {
      const source = target[channel];
      if (source.effect.kind === 'no value') continue;
      const details = source.details();
      if (channel === 'brightness') {
        payload.brightness = roundEven(clamp(frameLevel(source.effect, details), 1, 254));
        continue;
      }
      const colour = frameColourOf(view, source.effect, details, `effects_frame_plan.targets.${lamp}.color.value`);
      if (colour === undefined) continue;
      if (colour.kind === 'kelvin') payload.color_temp = roundEven(1_000_000 / colour.kelvin);
      else payload.color = { rgb: colour.rgb.join(',') };
    }
    let transition = target.on
      ? (brightness.kind === 'effect' || color.kind === 'effect' ? 0.4 : target.manual ? 0.2 : target.transition)
      : target.transition;
    const capped = args.transitionRooms === null || args.transitionRooms.includes(target.area ?? null);
    if (args.transitionCap !== null && capped) transition = Math.min(transition, args.transitionCap);
    payload = target.on ? { ...payload, transition } : { state: 'OFF', transition };
    if (view.get(lamp) === 'on') for (const member of membersByText[lamp] ?? []) {
      if (view.get(member) === 'on') rows.push({ entity: member, owner: lamp,
        topic: catalog.topics[member] ?? null, payload });
    }
  }
  return rows;
}

type FrameDetails = ReturnType<FrameSource['details']>;

/** A brightness source's level: a bulb effect runs at its intensity, anything else is its value. */
function frameLevel(effect: FrameEffect, details: FrameDetails): number {
  switch (effect.kind) {
    case 'bulb effect': return effect.intensity();
    case 'uncatalogued effect':
    case 'not an effect': return details.level;
    case 'no value': throw new Error('A channel that shows nothing has no level');
    default: { const unknown: never = effect; throw new Error(`Unhandled frame effect ${JSON.stringify(unknown)}`); }
  }
}

/** A colour source's colour, or `undefined` when the bulb effect owns the colour and nothing is sent. */
function frameColourOf(view: HouseView, effect: FrameEffect, details: FrameDetails, context: string): FrameColour | undefined {
  switch (effect.kind) {
    case 'bulb effect': {
      const held = bulbEffect(effect.name).colour;
      switch (held) {
        case 'warm end': return warmEndColour(view);
        case 'none': return undefined;
        default: { const unknown: never = held; throw new Error(`Unhandled bulb effect colour ${JSON.stringify(unknown)}`); }
      }
    }
    case 'uncatalogued effect':
    case 'not an effect': return details.colour(context);
    case 'no value': return undefined;
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


/** One command's gate: the request, the revision read for it, and the command itself. */
export interface EmitGate {
  revision: string;
  generation: string | null;
  /** The overrides revision as read for this command. */
  current: string;
  command: EmitCommand;
  effectTargets: OpaqueMap;
}

/**
 * The guarded publish of a command the house still allows, or `undefined`.
 * Allowed while the revision and runtime generation are the request's, every
 * owner and member is on, an owner's area power gate is not closed (an OFF
 * passes it), each owner is assigned the effect target it carries, and the
 * MQTT bridge is connected.
 */
export function publishCommand(view: HouseView, gate: EmitGate): Effect | undefined {
  const { revision, generation, command, effectTargets } = gate;
  const owners = command.owners, members = command.members;
  let allowed = revision === gate.current && runtimeGenerationIs(view, generation);
  for (const owner of owners) if (view.get(owner) !== 'on' || !command.turnsOff && powerClosed(view, view.rooms.ofId[owner])) allowed = false;
  for (const member of members) if (view.get(member) !== 'on') allowed = false;
  const targeted = Object.keys(effectTargets).length > 0;
  if (targeted) for (const owner of owners) {
    if (!Object.hasOwn(effectTargets, owner) || !assignedAs(view, owner, effectTargets[owner]!)) allowed = false;
  }
  if (!allowed || view.get('binary_sensor.zigbee2mqtt_bridge_connection_state') !== 'on') return undefined;
  const guard: OutputGuard = { revision, generation, owners, members, ...(targeted ? { effectTargets } : {}) };
  return {
    kind: 'service', service: 'mqtt.publish',
    data: { topic: command.topic, payload: command.body, qos: 0, retain: false }, guard,
  };
}

/**
 * Is the request still the house's: the overrides revision (read bare, so a
 * missing sensor raises) and then the runtime generation, both unchanged?
 */
export function stillCurrent(view: HouseView, script: string, revision: string, generation: Verbatim | string | null): boolean {
  return revision === overridesRevision(view, script) && runtimeGenerationIs(view, generation);
}

export type StopCommand = { topic: string; payload: { effect: string }; members: BulbId[]; owners: string[]; group: false };


/** What `effects_assign` decides from the runtime as it stood before the store. */
export interface AssignDecision {
  /** The runtime as read before the store; the stop check reads the previous assignment from it. */
  stored: RuntimeState;
  /** The targets, the stored revision or the invalidations changed: a new generation, and stops. */
  changed: boolean;
  generation: Verbatim | string;
  planOrder: number;
  /** Store the runtime: on a change, or for a plan order newer than the stored one. */
  write: boolean;
}

export function assignDecision(view: HouseView, revision: string, details: AssignDetails): AssignDecision {
  const stored = runtimeState(view);
  const changed = !stored.targetsEqual(details.targets) || revision !== view.attr(runtime, 'revision') || details.invalidate.length > 0;
  const planOrder = details.planOrder === undefined ? runtimePlanOrder(view) : details.planOrder;
  const generation: Verbatim | string = changed ? view.now : runtimeGeneration(view);
  return { stored, changed, generation, planOrder, write: changed || planOrder > runtimePlanOrder(view) };
}

/**
 * The runtime store, keeping the applied entries no invalidation names and no
 * lamp {@link stoppedLamps} tells to stop. A stopped lamp's bulbs no longer
 * show its applied light, sent by ls_dispatch or not (a baseline `send: false`
 * lamp is stopped and skipped), so it leaves `applied` and the next dispatch
 * that asks for that light sends it, a bulb-effect start included.
 */
export function* planAssignUpdate(decision: AssignDecision, revision: string, details: AssignDetails, stopped: string[]): Plan<void> {
  if (!decision.write) return;
  const invalidate = details.invalidate, generation = decision.generation;
  const applied = Object.fromEntries(Object.entries(decision.stored.applied).filter(([key]) =>
    !invalidate.includes(key) && !stopped.includes(key)));
  yield {
    kind: 'service', service: 'variable.update_sensor',
    data: { value: generation, replace_attributes: false, attributes: {
      targets: details.targets, assignments: details.assignments, applied, revision, generation, plan_order: decision.planOrder,
    } },
    target: { entity_id: runtime },
  };
}

/**
 * The lamps told to stop: each lamp target leaving an effect its bulbs run,
 * or whose native-owned effect channel was re-stamped, in target order.
 */
export function stoppedLamps(targetViews: ReturnType<AssignDetails['targetViews']>, stored: RuntimeState): string[] {
  const lamps: string[] = [];
  for (const target of Object.values(targetViews)) {
    if (target.lampOrRoom.kind === 'room') continue;
    const lamp = target.lampOrRoom.lamp;
    const previous = stored.previous(lamp);
    let needed = previous.effect !== undefined && bulbEffect(previous.effect).stoppedByName;
    for (const channel of ['brightness', 'color'] as const) {
      const source = target.channels[channel];
      // A lamp leaving an effect its bulbs run is told to stop it, before its new light.
      const was = runningIn(channel, previous.channels);
      if (was !== undefined && runningOn(channel, source.effect) !== was) needed = true;
      if (source.kind === 'effect' && target.owners[channel].kind === 'native control' &&
        source.updated !== previous.updated(channel)) needed = true;
    }
    if (needed) lamps.push(lamp);
  }
  return lamps;
}

/** The stops for each {@link stoppedLamps} lamp: `stop_colorloop` then `stop_effect`, per on member. */
export function stopCommands(view: HouseView, catalog: Catalog, targetViews: ReturnType<AssignDetails['targetViews']>,
  stored: RuntimeState): StopCommand[] {
  const commands: StopCommand[] = [];
  // The lamps are lighting-state entry keys, plain text until those lists are parsed; look them up as text.
  const membersByText: Readonly<Record<string, BulbId[] | undefined>> = catalog.members;
  for (const lamp of stoppedLamps(targetViews, stored)) {
    for (const member of membersByText[lamp] ?? []) if (view.get(member) === 'on') {
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
  return commands;
}

/**
 * Drop the assigned lamps from each command: a group id with an assigned
 * member becomes its unassigned members, and a command left with no id goes.
 */
export function filterCommands(catalog: Catalog, active: string[], commands: FilterArgs['commands']): { commands: Verbatim[] } {
  const kept: Verbatim[] = [];
  for (const command of commands) {
    const ids: string[] = [];
    for (const id of command.ids) {
      const members = catalog.groups[id] ?? [id];
      ids.push(...(members.some(x => active.includes(x)) ? members.filter(x => !active.includes(x)) : [id]));
    }
    if (ids.length) kept.push(withFields(command.document, { ids: [...new Set(ids)] }));
  }
  return { commands: kept };
}
