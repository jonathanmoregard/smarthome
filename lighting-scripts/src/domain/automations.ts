import type { JsonObject, JsonValue, ScriptContext, ScriptHandler, ScriptHandlers } from '../runtime/context.ts';
import { isObject, jinjaString, jinjaTruthy, object, ParseError, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { list, nativeScalar, num, timestamp } from './schedule.ts';

const runtime = 'sensor.ls_effects_runtime';
const store = 'sensor.ls_overrides';
function turnOn(ctx: ScriptContext, script: string): void { ctx.emit('script.turn_on', {}, { entity_id: `script.${script}` }); }

interface RemoteArgs {
  room: string;
  command: JsonValue;
  payload: JsonValue | undefined;
  source: string | undefined;
  deviceId: string | undefined;
}
interface NativeControlsArgs {
  topic: string;
  payload: JsonValue | undefined;
  sources: () => JsonObject;
}
interface WriterArgs { data: JsonObject; who: JsonValue }
interface CandleGroupArgs { id: JsonValue | undefined; payloadJson: JsonValue | undefined }
interface TriggerIdArgs { id: JsonValue | undefined }
interface ScheduleEngineArgs extends TriggerIdArgs { entityId: JsonValue | undefined }
interface SaraModeArgs extends TriggerIdArgs { who: JsonValue | undefined }
interface LampChangeArgs {
  who: JsonValue | undefined;
  details: () => {
    service: JsonValue | undefined;
    serviceData: () => JsonObject;
    contextId: JsonValue | undefined;
  };
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

function triggerObject(args: JsonObject, context: string): JsonObject {
  return requireObject(args, 'trigger', context);
}

/** Jinja `| list`: Undefined is empty; strings and mappings iterate. */
function jinjaList(value: JsonValue | undefined, context: string): JsonValue[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'string') return [...value];
  if (isObject(value)) return Object.keys(value);
  throw new ParseError(`${context} is not iterable for Jinja's list filter`);
}

function remote(kind: 'power' | 'directions' | 'preset'): ScriptHandler {
  return withParsedArgs({
    parse: args => {
      const room = requireString(args, 'room', `automation.remote_${kind}`);
      if (!/^[a-z0-9_]+$/.test(room)) throw new ParseError('Remote automation requires a runtime room ID');
      // Center never reads trigger. Directions and preset reach distinct raw
      // fields, so the shared factory must not impose either field on the other.
      const trigger = kind === 'power' ? undefined : triggerObject(args, `automation.remote_${kind}`);
      return {
        room,
        command: kind === 'directions' ? trigger!.id ?? null : kind,
        payload: kind === 'preset' ? trigger!.payload_json : undefined,
        source: typeof args.source === 'string' ? args.source : undefined,
        deviceId: typeof args.device_id === 'string' ? args.device_id : undefined,
      };
    },
    run: (ctx, args: RemoteArgs) => {
      const data: JsonObject = { command: args.command };
      if (kind === 'preset') data.payload = args.payload ?? null;
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
    parse: args => {
      const trigger = triggerObject(args, 'automation.effects_native_light_controls');
      return {
        topic: requireString(trigger, 'topic', 'automation.effects_native_light_controls.trigger'),
        payload: trigger.payload,
        // The captured automation always declares this mapping (88 entries).
        // The typed host may instead supply topology through ctx.catalog, so
        // an omitted bridge copy is the empty fallback, not malformed data.
        sources: lazy(() => args.sources === undefined ? {} : requireObject(args, 'sources', 'automation.effects_native_light_controls')),
      };
    },
    run: (ctx, args: NativeControlsArgs) => {
    const parts = args.topic.split('/'), alias = parts[3] ?? '', attribute = parts.at(-1) ?? '';
    if (!['power', 'brightness', 'rgb', 'temperature', 'effect'].includes(attribute)) return null;
    let source: JsonValue | undefined, catalogMatch = false;
    for (const raw of list(ctx.catalog?.ui_rows)) {
      const row = object(raw), topic = object(row.topics).power;
      if (typeof topic === 'string' && topic.split('/')[3] === alias) {
        source = row.source;
        catalogMatch = true;
      }
    }
    if (!catalogMatch) source = args.sources()[alias];
    if (typeof source !== 'string') return null;
    let value = nativeScalar(args.payload ?? null);
    if (attribute === 'rgb' && typeof value === 'string') {
      // MQTT RGB triplets render as a Python tuple in HA's native templates.
      // Preserve that JSON array boundary without executing template source.
      const raw = value.trim();
      try { value = JSON.parse(raw.startsWith('[') ? raw : `[${raw.replace(/^\(|\)$/g, '')}]`) as JsonObject[string]; } catch { /* Preserve malformed text for the normal validation path. */ }
    }
    ctx.run('effects_set', { source, attribute, value });
    turnOn(ctx, 'effects_ui_sync');
    return null;
    },
  }),
  // Writer reads trigger.event.data as a mapping once, data.who raw once in an
  // `or` chain, and event.context.user_id raw once. Jinja `or` replaces empty
  // containers too, so use jinjaTruthy rather than JavaScript `||`.
  'automation.lighting_schedule_override_store_writer': withParsedArgs({
    parse: args => {
      const trigger = triggerObject(args, 'automation.lighting_schedule_override_store_writer');
      const event = requireObject(trigger, 'event', 'automation.lighting_schedule_override_store_writer.trigger');
      const data = requireObject(event, 'data', 'automation.lighting_schedule_override_store_writer.trigger.event');
      const who = jinjaTruthy(data.who) ? data.who! : (() => {
        const eventContext = requireObject(event, 'context', 'automation.lighting_schedule_override_store_writer.trigger.event');
        return jinjaTruthy(eventContext.user_id) ? eventContext.user_id! : null;
      })();
      return { data, who };
    },
    run: (ctx, args: WriterArgs) => {
    ctx.run('ls_commit', { data: { ...args.data, who: args.who } });
    return null;
    },
  }),
  'automation.lighting_recover_pending_output': ctx => {
    if (ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') !== 'on') return null;
    const handled = object(ctx.attr(runtime, 'handled_rooms'));
    const dirty = ctx.attr(store, 'full_version') !== ctx.attr(runtime, 'handled_full') || Object.entries(object(ctx.attr(store, 'pending_rooms'))).some(([room, version]) => version !== handled[room]);
    if (dirty) turnOn(ctx, 'ls_render');
    return null;
  },
  // Candle group state reads payload_json four times: one iteration, one
  // mapping guard, one transaction `| string` method chain, and one raw output.
  // Matched candidate friendly_name/id/members occur once each; members has
  // `| list`, so missing is empty while strings/mappings retain iteration.
  'automation.effects_candle_group_state': withParsedArgs({
    parse: args => {
      const trigger = triggerObject(args, 'automation.effects_candle_group_state');
      return { id: trigger.id, payloadJson: trigger.payload_json };
    },
    run: (ctx, args: CandleGroupArgs) => {
    const attributes: JsonObject = {};
    if (args.id === 'groups') {
      const name = object(ctx.catalog?.candle_group).friendly_name ?? 'fx_candle_active';
      let group: JsonObject = { exists: false, members: [], observed_at: timestamp(ctx.now) };
      for (const raw of jinjaList(args.payloadJson, 'automation.effects_candle_group_state.trigger.payload_json')) {
        if (!isObject(raw)) continue;
        if (raw.friendly_name === name) group = { exists: true, id: raw.id ?? null,
          members: jinjaList(raw.members, 'automation.effects_candle_group_state.trigger.payload_json.members'), observed_at: timestamp(ctx.now) };
      }
      attributes.candle_group = group;
    } else if (args.id === 'response' && isObject(args.payloadJson)
      && jinjaString(args.payloadJson.transaction).startsWith('candle:')) attributes.candle_response = args.payloadJson;
    else return null;
    ctx.emit('variable.update_sensor', { value: nativeScalar(ctx.get(runtime)), replace_attributes: false, attributes }, { entity_id: runtime });
    ctx.run('effects_candle_sync_resume');
    return null;
    },
  }),
  'automation.effects_candle_membership': ctx => { turnOn(ctx, 'effects_candle_sync'); return null; },
  'automation.effects_lifecycle': ctx => {
    if (!(ctx.scheduled ?? []).some(task => task.script === 'effects_engine_tick') && ctx.get('script.effects_engine') === 'off' && Object.keys(object(ctx.attr(runtime, 'assignments'))).length) ctx.run('ls_apply', { reason: 'config' });
    return null;
  },
  // Refresh reads trigger.id raw once for comparison only.
  'automation.effects_refresh_native_light_controls': withParsedArgs({
    parse: args => ({ id: triggerObject(args, 'automation.effects_refresh_native_light_controls').id }),
    run: (ctx, args: TriggerIdArgs) => { ctx.run('effects_ui_sync', { force: args.id === 'start' }); return null; },
  }),
  // Schedule engine reads trigger.id and trigger.entity_id raw once each. The
  // entity is only reached on the lamp-on branch, matching captured control flow.
  'automation.lighting_schedule_engine': withParsedArgs({
    parse: args => {
      const trigger = triggerObject(args, 'automation.lighting_schedule_engine');
      return { id: trigger.id, entityId: trigger.entity_id };
    },
    run: (ctx, args: ScheduleEngineArgs) => {
    const data: JsonObject = { reason: args.id ?? null };
    if (args.id === 'lamp_on') data.lights = [args.entityId ?? null];
    ctx.run('ls_apply', data);
    return null;
    },
  }),
  // End-overrides selects native trigger IDs; parsing only the trigger mapping
  // avoids changing the internal override iteration and timestamp semantics.
  'automation.lighting_schedule_end_overrides': withParsedArgs({
    parse: args => ({ id: triggerObject(args, 'automation.lighting_schedule_end_overrides').id }),
    run: (ctx, args: TriggerIdArgs) => {
    const overrides = object(ctx.attr(store, 'overrides'));
    if (args.id === 'after' && ctx.get('input_boolean.ls_ovr_after_on') === 'on') {
      const now = timestamp(ctx.now), limit = num(ctx.get('input_number.ls_ovr_after_min'), 180) * 60;
      const expired = Object.entries(overrides).filter(([, raw]) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
        // Native HA as_timestamp accepts date text, not numeric Unix seconds.
        const value = raw.when, parsed = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
        return now - (Number.isFinite(parsed) ? parsed : now) >= limit;
      }).map(([key]) => key);
      if (expired.length) ctx.fire('ls_override', { op: 'clear', keys: expired, via: 'rule_after' });
    } else if (args.id === 'at' && ctx.get('input_boolean.ls_ovr_at_on') === 'on' && Object.keys(overrides).length) ctx.fire('ls_override', { op: 'clear_all', via: 'rule_at' });
    return null;
    },
  }),
  // Sara mode reads to_state.context.user_id raw twice (none test + output);
  // the nested attribute chain is strict, while trigger.id is branch-only.
  'automation.lighting_schedule_sara_mode_switch': withParsedArgs({
    parse: args => {
      const trigger = triggerObject(args, 'automation.lighting_schedule_sara_mode_switch');
      const toState = requireObject(trigger, 'to_state', 'automation.lighting_schedule_sara_mode_switch.trigger');
      const stateContext = requireObject(toState, 'context', 'automation.lighting_schedule_sara_mode_switch.trigger.to_state');
      return { id: trigger.id, who: stateContext.user_id };
    },
    run: (ctx, args: SaraModeArgs) => {
    const who = args.who;
    if (who === null || who === undefined) return null;
    const active = Object.hasOwn(object(ctx.attr(store, 'overrides')), 'mode:sara');
    if (args.id === 'on' && !active) ctx.fire('ls_override', { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who });
    else if (args.id === 'off' && active) ctx.fire('ls_override', { op: 'clear', keys: ['mode:sara'], via: 'app', who });
    return null;
    },
  }),
  // Lamp change detection reads event.context.user_id/id raw 3/1 times,
  // event.data.service raw once, and service_data once through `default({})`.
  // Keep service_data lazy until the user/service/running-script guards pass.
  'automation.lighting_schedule_lamp_change_detector': withParsedArgs({
    parse: args => {
      const trigger = triggerObject(args, 'automation.lighting_schedule_lamp_change_detector');
      const event = requireObject(trigger, 'event', 'automation.lighting_schedule_lamp_change_detector.trigger');
      const eventContext = requireObject(event, 'context', 'automation.lighting_schedule_lamp_change_detector.trigger.event');
      return {
        who: eventContext.user_id,
        details: lazy(() => {
          const data = requireObject(event, 'data', 'automation.lighting_schedule_lamp_change_detector.trigger.event');
          return {
            service: data.service,
            serviceData: lazy(() => data.service_data === undefined ? {} : requireObject(data, 'service_data', 'automation.lighting_schedule_lamp_change_detector.trigger.event.data')),
            contextId: eventContext.id,
          };
        }),
      };
    },
    run: (ctx, args: LampChangeArgs) => {
    // The HA bridge preserves the original running-script context condition.
    const who = args.who;
    if (who === null || who === undefined) return null;
    const details = args.details();
    if (details.service !== 'turn_on') return null;
    const runningScript = typeof details.contextId === 'string' && Object.entries(ctx.state).some(([entity, raw]) =>
      entity.startsWith('script.') && raw.state === 'on'
      && object(raw.context).id === details.contextId);
    if (runningScript) return null;
    const catalog = ctx.run('effects_catalog'), current = ctx.run('ls_apply', { dry_run: true, reason: 'config' });
    const capture = object(ctx.run('effects_native_plan', { sd: details.serviceData(), catalog, current, stamp: timestamp(ctx.now) }));
    for (const power of list(capture.power)) ctx.fire('ls_override', { op: 'power', area: object(power).area ?? '', on: true, via: 'app', who });
    const records = list(capture.records);
    if (records.length) ctx.fire('ls_override', { op: 'set', records, via: 'app', who });
    return null;
    },
  }),
  'automation.switch_lamps_validate_house_defaults': ctx => {
    const ranges: JsonObject = {};
    for (const profile of ['bright', 'cosy']) {
      const lo = num(ctx.get(`input_number.ls_range_${profile}_min`), -1), hi = num(ctx.get(`input_number.ls_range_${profile}_max`), -1);
      if (!(0 <= lo && lo <= hi && hi <= 100)) return null;
      ranges[profile] = [lo, hi];
    }
    ctx.fire('ls_override', { op: 'range_defaults', ranges, via: 'schedule-ui' });
    return null;
  },
};
