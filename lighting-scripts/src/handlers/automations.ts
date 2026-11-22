/**
 * `automations`'s handlers: the shells that turn Home Assistant automation
 * triggers and MQTT topics into script calls and service effects, read the
 * live house, make the inter-handler calls and perform effects, and the
 * name-keyed table. The decisions they run are pure, in `src/domain`:
 * `pending-output.ts`, `overlay-resets.ts`, `sara-mode.ts` and
 * `range-defaults.ts`.
 */
import type { ScriptHandler, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { timestamp } from '../parse/accessors.ts';
import type { StoredFact, StoredValue } from '../parse/overrides.ts';
import { attributeFact, attributeMapping, lenientOverrides } from '../parse/sensors.ts';
import {
  controlTopic, inputNumber, nativeCapture, nativeControlValue, nativeSourceFor, overrideAges, parseLampChangeArgs, parseNativeControlsArgs,
    parseRemoteArgs, parseSaraModeArgs, parseScheduleEngineArgs, parseTriggerIdArgs, parseWriterArgs, stateContextId,
} from '../parse/automations.ts';
import type {
  LampChangeTrigger, NativeCapture, NativeControlTrigger, RemoteTrigger, RemoteKind, SaraModeTrigger, ScheduleEngineTrigger, OverrideWriterTrigger,
} from '../parse/automations.ts';
import { perform, run } from '../runtime/effects.ts';
import type { Effect, HouseView, Plan } from '../runtime/effects.ts';
import { pendingOutputDirty } from '../domain/pending-output.ts';
import { expiredOverlays } from '../domain/overlay-resets.ts';
import { saraModeChange } from '../domain/sara-mode.ts';
import { isRangeDefault } from '../domain/range-defaults.ts';
import { overlayKeyText, SARA_MODE } from '../domain/types/overlay.ts';

/** Set the control, then resync the UI proxies. */
export function* forwardNativeControl(source: string, attribute: string, value: Verbatim): Plan<null> {
  yield { kind: 'script', name: 'effects_set', args: { source, attribute, value } };
  yield turnOn('effects_ui_sync');
  return null;
}

function turnOn(script: string): Effect {
  return { kind: 'service', service: 'script.turn_on', data: {}, target: { entity_id: `script.${script}` } };
}

/** The override store writer commits the event's data with `who` replaced. */
export function* forwardOverride(args: OverrideWriterTrigger): Plan<null> {
  yield { kind: 'script', name: 'ls_commit', args: { data: withFields(args.data, { who: args.who }) } };
  return null;
}

export function* requestRender(): Plan<null> {
  yield turnOn('ls_render');
  return null;
}

/** The native-light-controls refresh forces a full UI sync on start. */
export function* refreshUi(triggerId: StoredFact): Plan<null> {
  yield { kind: 'script', name: 'effects_ui_sync', args: { force: triggerId === 'start' } };
  return null;
}

/** The schedule engine applies with the trigger as its reason; an absent id or entity is forwarded as null. */
export function* runScheduleEngine(args: ScheduleEngineTrigger): Plan<null> {
  const data: { reason: StoredValue; lights?: StoredValue[] } = { reason: args.id === undefined ? null : args.id };
  if (args.id === 'lamp_on') data.lights = [args.entityId === undefined ? null : args.entityId];
  yield { kind: 'script', name: 'ls_apply', args: data };
  return null;
}

/**
 * End-overrides rules. Not a generator: it reads the house through the view,
 * and the after-limit read raises on a malformed state, so it happens only
 * where the captured script reaches it -- after the rule's on-switch passed.
 * Which overlays the after-limit rule ends is {@link expiredOverlays}.
 */
export function endOverrides(view: HouseView, triggerId: StoredFact): Effect[] {
  const overrides = lenientOverrides(view);
  if (triggerId === 'after' && view.get('input_boolean.ls_ovr_after_on') === 'on') {
    const now = timestamp(view.now), limit = inputNumber(view, 'input_number.ls_ovr_after_min', 180) * 60;
    const expired = expiredOverlays(overrideAges(overrides.entries), now, limit).map(overlayKeyText);
    return expired.length > 0 ? [{ kind: 'event', event: 'ls_override', data: { op: 'clear', keys: expired, via: 'rule_after' } }] : [];
  }
  if (triggerId === 'at' && view.get('input_boolean.ls_ovr_at_on') === 'on' && overrides.entries.length > 0) {
    return [{ kind: 'event', event: 'ls_override', data: { op: 'clear_all', via: 'rule_at' } }];
  }
  return [];
}

/** The Sara mode switch sets or clears `mode:sara` as {@link saraModeChange} decides; no user, no change. */
export function* saraModeSwitch(args: SaraModeTrigger, active: boolean): Plan<null> {
  const who = args.who;
  if (who === null || who === undefined) return null;
  const wanted = args.id === 'on' ? true : args.id === 'off' ? false : undefined;
  if (wanted === undefined) return null;
  const change = saraModeChange(wanted, active);
  if (change === 'set') {
    yield { kind: 'event', event: 'ls_override', data: { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who } };
  } else if (change === 'clear') {
    yield { kind: 'event', event: 'ls_override', data: { op: 'clear', keys: [overlayKeyText(SARA_MODE)], via: 'app', who } };
  }
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
 * House range defaults, fired only when both profiles hold a valid range
 * ({@link isRangeDefault}). Not a generator: each profile's two reads raise on
 * a malformed state, so cosy is read only once bright has passed, as the
 * captured loop does.
 */
export function houseRangeDefaults(view: HouseView): Effect[] {
  const ranges: Record<string, [number, number]> = {};
  for (const profile of ['bright', 'cosy']) {
    const lo = inputNumber(view, `input_number.ls_range_${profile}_min`, -1), hi = inputNumber(view, `input_number.ls_range_${profile}_max`, -1);
    if (!isRangeDefault(lo, hi)) return [];
    ranges[profile] = [lo, hi];
  }
  return [{ kind: 'event', event: 'ls_override', data: { op: 'range_defaults', ranges, via: 'schedule-ui' } }];
}

function remote(kind: RemoteKind): ScriptHandler {
  return withParsedArgs({ parse: args => parseRemoteArgs(kind, args), run: (ctx, args: RemoteTrigger) => run(ctx, forwardRemote(kind, args)) });
}

/** A remote's gesture, forwarded to the room's gesture script; optional fields only when they are strings. */
export function* forwardRemote(kind: RemoteKind, args: RemoteTrigger): Plan<null> {
  const data: { command: StoredValue; payload?: Verbatim; source?: string; device_id?: string } = { command: args.command };
  if (kind === 'preset') data.payload = args.payload;
  if (args.source !== undefined) data.source = args.source;
  if (args.deviceId !== undefined) data.device_id = args.deviceId;
  yield { kind: 'script', name: `ls_remote_gesture_${args.room}`, args: data };
  return null;
}
const runtime = 'sensor.ls_effects_runtime';
const store = 'sensor.ls_overrides';
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
    run: (ctx, args: NativeControlTrigger) => {
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
    run: (ctx, args: OverrideWriterTrigger) => run(ctx, forwardOverride(args)),
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
    run: (ctx, triggerId: StoredFact) => run(ctx, refreshUi(triggerId)),
  }),
  // Schedule engine reads trigger.id and trigger.entity_id raw once each. The
  // entity is only reached on the lamp-on branch, matching captured control flow.
  'automation.lighting_schedule_engine': withParsedArgs({
    parse: parseScheduleEngineArgs,
    run: (ctx, args: ScheduleEngineTrigger) => run(ctx, runScheduleEngine(args)),
  }),
  // End-overrides selects native trigger IDs; parsing only the trigger mapping
  // avoids changing the internal override iteration and timestamp semantics.
  'automation.lighting_schedule_end_overrides': withParsedArgs({
    parse: parseTriggerIdArgs('automation.lighting_schedule_end_overrides'),
    run: (ctx, triggerId: StoredFact) => {
    for (const effect of endOverrides(ctx, triggerId)) perform(ctx, effect);
    return null;
    },
  }),
  // Sara mode reads to_state.context.user_id raw twice (none test + output);
  // the nested attribute chain is strict, while trigger.id is branch-only.
  'automation.lighting_schedule_sara_mode_switch': withParsedArgs({
    parse: parseSaraModeArgs,
    run: (ctx, args: SaraModeTrigger) => run(ctx, saraModeSwitch(args, lenientOverrides(ctx).has(SARA_MODE))),
  }),
  // Lamp change detection reads event.context.user_id/id raw 3/1 times,
  // event.data.service raw once, and service_data once through `default({})`.
  // Keep service_data lazy until the user/service/running-script guards pass.
  // A shell: it makes three result-bearing runs.
  'automation.lighting_schedule_lamp_change_detector': withParsedArgs({
    parse: parseLampChangeArgs,
    run: (ctx, args: LampChangeTrigger) => {
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
