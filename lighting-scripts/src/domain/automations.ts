import type { ScriptHandler, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { timestamp } from '../parse/accessors.ts';
import type { OpaqueMap, StoredFact, StoredValue } from '../parse/overrides.ts';
import { attributeFact, attributeMapping, lenientOverrides } from '../parse/sensors.ts';
import {
  inputNumber, nativeCapture, nativeControlValue, nativeSourceFor, overrideAges, parseLampChangeArgs,
  parseNativeControlsArgs, parseRemoteArgs, parseSaraModeArgs, parseScheduleEngineArgs, parseTriggerIdArgs,
  parseWriterArgs, stateContextId,
} from '../parse/automations.ts';
import { perform, run } from '../runtime/effects.ts';
import type { Effect, HouseView, Plan } from '../runtime/effects.ts';

const runtime = 'sensor.ls_effects_runtime';
const store = 'sensor.ls_overrides';
function turnOn(script: string): Effect {
  return { kind: 'service', service: 'script.turn_on', data: {}, target: { entity_id: `script.${script}` } };
}

export type RemoteKind = 'power' | 'directions' | 'preset';
export interface RemoteArgs {
  room: string;
  /** The gesture command: the kind itself, or directions' `trigger.id` as stored. */
  command: StoredValue;
  /** Preset's `trigger.payload_json` as stored, `null` when absent. */
  payload: Verbatim;
  source: string | undefined;
  deviceId: string | undefined;
}
export interface NativeControlsArgs {
  topic: string;
  /** The MQTT payload as received, or absent. */
  payload: Verbatim;
  /** The bridge's alias -> source mapping (parsed on first use); a non-string entry is `undefined`. */
  source: (alias: string) => string | undefined;
}
export interface WriterArgs {
  /** The event data, forwarded with `who` replaced. */
  data: Verbatim;
  who: Verbatim;
}
export interface TriggerIdArgs { id: StoredFact }
export interface ScheduleEngineArgs extends TriggerIdArgs { entityId: StoredFact }
export interface SaraModeArgs extends TriggerIdArgs { who: StoredFact }
export interface LampChangeArgs {
  who: StoredFact;
  details: () => {
    service: StoredFact;
    /** `service_data | default({})`, forwarded to `effects_native_plan` as `sd`. */
    serviceData: () => Verbatim;
    contextId: StoredFact;
  };
}
/** What the capture reads of `effects_native_plan`'s answer. */
export interface NativeCapture {
  powerAreas: StoredValue[];
  records: () => { document: Verbatim; count: number };
}

/** A remote's gesture, forwarded to the room's gesture script; optional fields only when they are strings. */
export function* forwardRemote(kind: RemoteKind, args: RemoteArgs): Plan<null> {
  const data: { command: StoredValue; payload?: Verbatim; source?: string; device_id?: string } = { command: args.command };
  if (kind === 'preset') data.payload = args.payload;
  if (args.source !== undefined) data.source = args.source;
  if (args.deviceId !== undefined) data.device_id = args.deviceId;
  yield { kind: 'script', name: `ls_remote_gesture_${args.room}`, args: data };
  return null;
}
function remote(kind: RemoteKind): ScriptHandler {
  return withParsedArgs({ parse: args => parseRemoteArgs(kind, args), run: (ctx, args: RemoteArgs) => run(ctx, forwardRemote(kind, args)) });
}

const CONTROLLED = ['power', 'brightness', 'rgb', 'temperature', 'effect'];
/** A native-control MQTT topic's alias (fourth segment) and attribute (last), when the attribute is one this controls. */
export function controlTopic(topic: string): { alias: string; attribute: string } | undefined {
  const parts = topic.split('/'), alias = parts[3] ?? '', attribute = parts.at(-1) ?? '';
  return CONTROLLED.includes(attribute) ? { alias, attribute } : undefined;
}
/** Set the control, then resync the UI proxies. */
export function* forwardNativeControl(source: string, attribute: string, value: Verbatim): Plan<null> {
  yield { kind: 'script', name: 'effects_set', args: { source, attribute, value } };
  yield turnOn('effects_ui_sync');
  return null;
}

/** The override store writer commits the event's data with `who` replaced. */
export function* forwardOverride(args: WriterArgs): Plan<null> {
  yield { kind: 'script', name: 'ls_commit', args: { data: withFields(args.data, { who: args.who }) } };
  return null;
}

/** The output facts the pending-output recovery compares, each as stored (compared by identity). */
export interface PendingOutput {
  fullVersion: StoredFact;
  handledFull: StoredFact;
  pendingRooms: OpaqueMap;
  handledRooms: OpaqueMap;
}
/** Output is dirty when the last full render or any pending room was not handled. */
export function pendingOutputDirty(output: PendingOutput): boolean {
  return output.fullVersion !== output.handledFull
    || Object.entries(output.pendingRooms).some(([room, version]) => version !== output.handledRooms[room]);
}
export function* requestRender(): Plan<null> {
  yield turnOn('ls_render');
  return null;
}

/** The native-light-controls refresh forces a full UI sync on start. */
export function* refreshUi(args: TriggerIdArgs): Plan<null> {
  yield { kind: 'script', name: 'effects_ui_sync', args: { force: args.id === 'start' } };
  return null;
}

/** The schedule engine applies with the trigger as its reason; an absent id or entity is forwarded as null. */
export function* runScheduleEngine(args: ScheduleEngineArgs): Plan<null> {
  const data: { reason: StoredValue; lights?: StoredValue[] } = { reason: args.id === undefined ? null : args.id };
  if (args.id === 'lamp_on') data.lights = [args.entityId === undefined ? null : args.entityId];
  yield { kind: 'script', name: 'ls_apply', args: data };
  return null;
}

/**
 * End-overrides rules. Not a generator: it reads the house through the view,
 * and the after-limit read raises on a malformed state, so it happens only
 * where the captured script reaches it -- after the rule's on-switch passed.
 */
export function endOverrides(view: HouseView, args: TriggerIdArgs): Effect[] {
  const overrides = lenientOverrides(view);
  if (args.id === 'after' && view.get('input_boolean.ls_ovr_after_on') === 'on') {
    const now = timestamp(view.now), limit = inputNumber(view, 'input_number.ls_ovr_after_min', 180) * 60;
    // An unreadable `when` ages from now, so it is never older than the limit unless the limit is 0.
    const expired = overrideAges(overrides.entries)
      .filter(({ when }) => now - (when === undefined ? now : when) >= limit).map(({ key }) => key);
    return expired.length ? [{ kind: 'event', event: 'ls_override', data: { op: 'clear', keys: expired, via: 'rule_after' } }] : [];
  }
  if (args.id === 'at' && view.get('input_boolean.ls_ovr_at_on') === 'on' && overrides.entries.length > 0) {
    return [{ kind: 'event', event: 'ls_override', data: { op: 'clear_all', via: 'rule_at' } }];
  }
  return [];
}

/** The Sara mode switch sets or clears `mode:sara` only when that changes it; no user, no change. */
export function* saraModeSwitch(args: SaraModeArgs, active: boolean): Plan<null> {
  const who = args.who;
  if (who === null || who === undefined) return null;
  if (args.id === 'on' && !active) {
    yield { kind: 'event', event: 'ls_override', data: { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who } };
  } else if (args.id === 'off' && active) yield { kind: 'event', event: 'ls_override', data: { op: 'clear', keys: ['mode:sara'], via: 'app', who } };
  return null;
}

/**
 * A lamp change's overrides: power its areas, then the channel records. The
 * records list is read only after the power events, where the inline read
 * sat, so a malformed list raises after them.
 */
export function* lampChangeOverrides(capture: NativeCapture, who: StoredValue): Plan<null> {
  for (const area of capture.powerAreas) yield { kind: 'event', event: 'ls_override', data: { op: 'power', area, on: true, via: 'app', who } };
  const records = capture.records();
  if (records.count > 0) yield { kind: 'event', event: 'ls_override', data: { op: 'set', records: records.document, via: 'app', who } };
  return null;
}

/**
 * House range defaults, fired only when both profiles hold a valid range. Not
 * a generator: each profile's two reads raise on a malformed state, so cosy is
 * read only once bright has passed, as the captured loop does.
 */
export function houseRangeDefaults(view: HouseView): Effect[] {
  const ranges: Record<string, [number, number]> = {};
  for (const profile of ['bright', 'cosy']) {
    const lo = inputNumber(view, `input_number.ls_range_${profile}_min`, -1), hi = inputNumber(view, `input_number.ls_range_${profile}_max`, -1);
    if (!(0 <= lo && lo <= hi && hi <= 100)) return [];
    ranges[profile] = [lo, hi];
  }
  return [{ kind: 'event', event: 'ls_override', data: { op: 'range_defaults', ranges, via: 'schedule-ui' } }];
}

const center = remote('power'), directions = remote('directions'), preset = remote('preset');
export const automationHandlers: ScriptHandlers = {
  'automation.remote_center': center,
  'automation.remote_directions': directions,
  'automation.remote_preset': preset,
  'automation.lighting_bedroom_remote_preset_arrows': preset,
  'automation.lighting_jonathan_s_bedroom_remote_center': center,
  'automation.lighting_jonathan_s_bedroom_remote_directions': directions,
  'automation.lighting_kitchen_remote_center': center,
  'automation.lighting_kitchen_remote_directions': directions,
  'automation.lighting_kitchen_remote_preset_arrows': preset,
  'automation.lighting_living_room_remote_center': center,
  'automation.lighting_living_room_remote_directions': directions,
  'automation.lighting_living_room_remote_preset_arrows': preset,
  // Across each remote sibling, directions reads trigger.id raw once, preset
  // reads trigger.payload_json raw once, and center never reads trigger. Room is
  // the typed bridge topology key; optional source/device_id are forwarded only
  // when strings, matching the captured static action data.
  // Native controls reads trigger.topic raw four times through split/indexing,
  // trigger.payload raw once, and sources by dynamic index once. Topic is a
  // required string; sources stays lazy until a supported attribute survives.
  'automation.effects_native_light_controls': withParsedArgs({
    parse: parseNativeControlsArgs,
    run: (ctx, args: NativeControlsArgs) => {
    const control = controlTopic(args.topic);
    if (control === undefined) return null;
    // The catalog is parsed on first read, so it is read only once the topic passed.
    const row = nativeSourceFor(ctx.catalog?.ui_rows, control.alias);
    const source = row.matched ? row.source : args.source(control.alias);
    if (source === undefined) return null;
    return run(ctx, forwardNativeControl(source, control.attribute, nativeControlValue(args.payload, control.attribute)));
    },
  }),
  'automation.lighting_schedule_override_store_writer': withParsedArgs({
    parse: parseWriterArgs,
    run: (ctx, args: WriterArgs) => run(ctx, forwardOverride(args)),
  }),
  'automation.lighting_recover_pending_output': ctx => {
    if (ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') !== 'on') return null;
    const dirty = pendingOutputDirty({
      fullVersion: attributeFact(ctx, store, 'full_version'),
      handledFull: attributeFact(ctx, runtime, 'handled_full'),
      pendingRooms: attributeMapping(ctx, store, 'pending_rooms'),
      handledRooms: attributeMapping(ctx, runtime, 'handled_rooms'),
    });
    return dirty ? run(ctx, requestRender()) : null;
  },
  // Refresh reads trigger.id raw once for comparison only.
  'automation.effects_refresh_native_light_controls': withParsedArgs({
    parse: parseTriggerIdArgs('automation.effects_refresh_native_light_controls'),
    run: (ctx, args: TriggerIdArgs) => run(ctx, refreshUi(args)),
  }),
  // Schedule engine reads trigger.id and trigger.entity_id raw once each. The
  // entity is only reached on the lamp-on branch, matching captured control flow.
  'automation.lighting_schedule_engine': withParsedArgs({
    parse: parseScheduleEngineArgs,
    run: (ctx, args: ScheduleEngineArgs) => run(ctx, runScheduleEngine(args)),
  }),
  // End-overrides selects native trigger IDs; parsing only the trigger mapping
  // avoids changing the internal override iteration and timestamp semantics.
  'automation.lighting_schedule_end_overrides': withParsedArgs({
    parse: parseTriggerIdArgs('automation.lighting_schedule_end_overrides'),
    run: (ctx, args: TriggerIdArgs) => {
    for (const effect of endOverrides(ctx, args)) perform(ctx, effect);
    return null;
    },
  }),
  // Sara mode reads to_state.context.user_id raw twice (none test + output);
  // the nested attribute chain is strict, while trigger.id is branch-only.
  'automation.lighting_schedule_sara_mode_switch': withParsedArgs({
    parse: parseSaraModeArgs,
    run: (ctx, args: SaraModeArgs) => run(ctx, saraModeSwitch(args, lenientOverrides(ctx).has('mode:sara'))),
  }),
  // Lamp change detection reads event.context.user_id/id raw 3/1 times,
  // event.data.service raw once, and service_data once through `default({})`.
  // Keep service_data lazy until the user/service/running-script guards pass.
  // A shell: it makes three result-bearing runs.
  'automation.lighting_schedule_lamp_change_detector': withParsedArgs({
    parse: parseLampChangeArgs,
    run: (ctx, args: LampChangeArgs) => {
    // The HA bridge preserves the original running-script context condition.
    const who = args.who;
    if (who === null || who === undefined) return null;
    const details = args.details();
    if (details.service !== 'turn_on') return null;
    const contextId = details.contextId;
    const runningScript = typeof contextId === 'string' && Object.entries(ctx.state).some(([entity, state]) =>
      entity.startsWith('script.') && state.state === 'on' && stateContextId(state) === contextId);
    if (runningScript) return null;
    const catalog = ctx.run('effects_catalog'), current = ctx.run('ls_apply', { dry_run: true, reason: 'config' });
    const capture = nativeCapture(ctx.run('effects_native_plan', { sd: details.serviceData(), catalog, current, stamp: timestamp(ctx.now) }));
    return run(ctx, lampChangeOverrides(capture, who));
    },
  }),
  'automation.switch_lamps_validate_house_defaults': ctx => {
    for (const effect of houseRangeDefaults(ctx)) perform(ctx, effect);
    return null;
  },
};
