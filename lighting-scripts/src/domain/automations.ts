import type { ScriptContext, ScriptHandler, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { timestamp } from '../parse/accessors.ts';
import type { StoredFact, StoredValue } from '../parse/overrides.ts';
import { attributeFact, attributeMapping, lenientOverrides } from '../parse/sensors.ts';
import {
  inputNumber, nativeCapture, nativeControlValue, nativeSourceFor, overrideAges, parseLampChangeArgs,
  parseNativeControlsArgs, parseRemoteArgs, parseSaraModeArgs, parseScheduleEngineArgs, parseTriggerIdArgs,
  parseWriterArgs, stateContextId,
} from '../parse/automations.ts';

const runtime = 'sensor.ls_effects_runtime';
const store = 'sensor.ls_overrides';
function turnOn(ctx: ScriptContext, script: string): void { ctx.emit('script.turn_on', {}, { entity_id: `script.${script}` }); }

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

function remote(kind: RemoteKind): ScriptHandler {
  return withParsedArgs({
    parse: args => parseRemoteArgs(kind, args),
    run: (ctx, args: RemoteArgs) => {
      const data: { command: StoredValue; payload?: Verbatim; source?: string; device_id?: string } = { command: args.command };
      if (kind === 'preset') data.payload = args.payload;
      if (args.source !== undefined) data.source = args.source;
      if (args.deviceId !== undefined) data.device_id = args.deviceId;
      ctx.run(`ls_remote_gesture_${args.room}`, data);
      return null;
    },
  });
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
    const parts = args.topic.split('/'), alias = parts[3] ?? '', attribute = parts.at(-1) ?? '';
    if (!['power', 'brightness', 'rgb', 'temperature', 'effect'].includes(attribute)) return null;
    const row = nativeSourceFor(ctx.catalog?.ui_rows, alias);
    const source = row.matched ? row.source : args.source(alias);
    if (source === undefined) return null;
    ctx.run('effects_set', { source, attribute, value: nativeControlValue(args.payload, attribute) });
    turnOn(ctx, 'effects_ui_sync');
    return null;
    },
  }),
  'automation.lighting_schedule_override_store_writer': withParsedArgs({
    parse: parseWriterArgs,
    run: (ctx, args: WriterArgs) => {
    ctx.run('ls_commit', { data: withFields(args.data, { who: args.who }) });
    return null;
    },
  }),
  'automation.lighting_recover_pending_output': ctx => {
    if (ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') !== 'on') return null;
    const handled = attributeMapping(ctx, runtime, 'handled_rooms');
    const dirty = attributeFact(ctx, store, 'full_version') !== attributeFact(ctx, runtime, 'handled_full')
      || Object.entries(attributeMapping(ctx, store, 'pending_rooms')).some(([room, version]) => version !== handled[room]);
    if (dirty) turnOn(ctx, 'ls_render');
    return null;
  },
  // Refresh reads trigger.id raw once for comparison only.
  'automation.effects_refresh_native_light_controls': withParsedArgs({
    parse: parseTriggerIdArgs('automation.effects_refresh_native_light_controls'),
    run: (ctx, args: TriggerIdArgs) => { ctx.run('effects_ui_sync', { force: args.id === 'start' }); return null; },
  }),
  // Schedule engine reads trigger.id and trigger.entity_id raw once each. The
  // entity is only reached on the lamp-on branch, matching captured control flow.
  'automation.lighting_schedule_engine': withParsedArgs({
    parse: parseScheduleEngineArgs,
    run: (ctx, args: ScheduleEngineArgs) => {
    // An absent id or entity is forwarded as null.
    const data: { reason: StoredValue; lights?: StoredValue[] } = { reason: args.id === undefined ? null : args.id };
    if (args.id === 'lamp_on') data.lights = [args.entityId === undefined ? null : args.entityId];
    ctx.run('ls_apply', data);
    return null;
    },
  }),
  // End-overrides selects native trigger IDs; parsing only the trigger mapping
  // avoids changing the internal override iteration and timestamp semantics.
  'automation.lighting_schedule_end_overrides': withParsedArgs({
    parse: parseTriggerIdArgs('automation.lighting_schedule_end_overrides'),
    run: (ctx, args: TriggerIdArgs) => {
    const overrides = lenientOverrides(ctx);
    if (args.id === 'after' && ctx.get('input_boolean.ls_ovr_after_on') === 'on') {
      const now = timestamp(ctx.now), limit = inputNumber(ctx, 'input_number.ls_ovr_after_min', 180) * 60;
      // An unreadable `when` ages from now, so it is never older than the limit unless the limit is 0.
      const expired = overrideAges(overrides.entries)
        .filter(({ when }) => now - (when === undefined ? now : when) >= limit).map(({ key }) => key);
      if (expired.length) ctx.fire('ls_override', { op: 'clear', keys: expired, via: 'rule_after' });
    } else if (args.id === 'at' && ctx.get('input_boolean.ls_ovr_at_on') === 'on' && overrides.entries.length > 0) ctx.fire('ls_override', { op: 'clear_all', via: 'rule_at' });
    return null;
    },
  }),
  // Sara mode reads to_state.context.user_id raw twice (none test + output);
  // the nested attribute chain is strict, while trigger.id is branch-only.
  'automation.lighting_schedule_sara_mode_switch': withParsedArgs({
    parse: parseSaraModeArgs,
    run: (ctx, args: SaraModeArgs) => {
    const who = args.who;
    if (who === null || who === undefined) return null;
    const active = lenientOverrides(ctx).has('mode:sara');
    if (args.id === 'on' && !active) ctx.fire('ls_override', { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who });
    else if (args.id === 'off' && active) ctx.fire('ls_override', { op: 'clear', keys: ['mode:sara'], via: 'app', who });
    return null;
    },
  }),
  // Lamp change detection reads event.context.user_id/id raw 3/1 times,
  // event.data.service raw once, and service_data once through `default({})`.
  // Keep service_data lazy until the user/service/running-script guards pass.
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
    for (const area of capture.powerAreas) ctx.fire('ls_override', { op: 'power', area, on: true, via: 'app', who });
    const records = capture.records();
    if (records.count > 0) ctx.fire('ls_override', { op: 'set', records: records.document, via: 'app', who });
    return null;
    },
  }),
  'automation.switch_lamps_validate_house_defaults': ctx => {
    const ranges: Record<string, [number, number]> = {};
    for (const profile of ['bright', 'cosy']) {
      const lo = inputNumber(ctx, `input_number.ls_range_${profile}_min`, -1), hi = inputNumber(ctx, `input_number.ls_range_${profile}_max`, -1);
      if (!(0 <= lo && lo <= hi && hi <= 100)) return null;
      ranges[profile] = [lo, hi];
    }
    ctx.fire('ls_override', { op: 'range_defaults', ranges, via: 'schedule-ui' });
    return null;
  },
};
