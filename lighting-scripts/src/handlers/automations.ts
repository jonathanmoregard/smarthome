/**
 * `automations`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/automations.ts`.
 */
import type { ScriptHandler, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { timestamp } from '../parse/accessors.ts';
import { attributeFact, attributeMapping, lenientOverrides } from '../parse/sensors.ts';
import {
  nativeCapture, nativeControlValue, nativeSourceFor, parseLampChangeArgs, parseNativeControlsArgs, parseRemoteArgs, parseSaraModeArgs,
    parseScheduleEngineArgs, parseTriggerIdArgs, parseWriterArgs, stateContextId,
} from '../parse/automations.ts';
import { perform, run } from '../runtime/effects.ts';
import {
  controlTopic, endOverrides, forwardNativeControl, forwardOverride, forwardRemote, houseRangeDefaults, lampChangeOverrides,
    pendingOutputDirty, refreshUi, requestRender, runScheduleEngine, saraModeSwitch,
} from '../domain/automations.ts';
import type {
  LampChangeArgs, NativeControlsArgs, RemoteArgs, RemoteKind, SaraModeArgs, ScheduleEngineArgs, TriggerIdArgs, WriterArgs,
} from '../domain/automations.ts';
import { SARA_MODE } from '../domain/types/overlay.ts';

function remote(kind: RemoteKind): ScriptHandler {
  return withParsedArgs({ parse: args => parseRemoteArgs(kind, args), run: (ctx, args: RemoteArgs) => run(ctx, forwardRemote(kind, args)) });
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
    run: (ctx, args: SaraModeArgs) => run(ctx, saraModeSwitch(args, lenientOverrides(ctx).has(SARA_MODE))),
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
