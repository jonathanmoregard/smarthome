import type { JsonObject, ScriptContext, ScriptHandler, ScriptHandlers } from '../runtime/context.ts';
import { object } from './scale.ts';
import { list, nativeScalar, num, timestamp } from './schedule.ts';

const runtime = 'sensor.ls_effects_runtime';
const store = 'sensor.ls_overrides';
function turnOn(ctx: ScriptContext, script: string): void { ctx.emit('script.turn_on', {}, { entity_id: `script.${script}` }); }
function remote(kind: 'power' | 'directions' | 'preset'): ScriptHandler {
  return (ctx, args) => {
    const trigger = object(args.trigger);
    if (typeof args.room !== 'string' || !/^[a-z0-9_]+$/.test(args.room)) throw Error('Remote automation requires a runtime room ID');
    const data: JsonObject = { command: kind === 'directions' ? trigger.id ?? '' : kind };
    if (kind === 'preset') data.payload = trigger.payload_json ?? {};
    for (const key of ['source', 'device_id']) if (typeof args[key] === 'string') data[key] = args[key]!;
    ctx.run(`ls_remote_gesture_${args.room}`, data);
    return null;
  };
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
  'automation.effects_native_light_controls': (ctx, args) => {
    const trigger = object(args.trigger), parts = String(trigger.topic ?? '').split('/'), alias = parts[3] ?? '', attribute = parts.at(-1) ?? '';
    if (!['power', 'brightness', 'rgb', 'temperature', 'effect'].includes(attribute)) return null;
    let source = object(args.sources)[alias];
    for (const raw of list(ctx.catalog?.ui_rows)) {
      const row = object(raw), topic = object(row.topics).power;
      if (typeof topic === 'string' && topic.split('/')[3] === alias) source = row.source;
    }
    if (typeof source !== 'string') return null;
    let value = nativeScalar(trigger.payload ?? '');
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
  'automation.lighting_schedule_override_store_writer': (ctx, args) => {
    const event = object(object(args.trigger).event), data = object(event.data);
    ctx.run('ls_commit', { data: { ...data, who: data.who || object(event.context).user_id || null } });
    return null;
  },
  'automation.lighting_recover_pending_output': ctx => {
    if (ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') !== 'on') return null;
    const handled = object(ctx.attr(runtime, 'handled_rooms'));
    const dirty = ctx.attr(store, 'full_version') !== ctx.attr(runtime, 'handled_full') || Object.entries(object(ctx.attr(store, 'pending_rooms'))).some(([room, version]) => version !== handled[room]);
    if (dirty) turnOn(ctx, 'ls_render');
    return null;
  },
  'automation.effects_candle_group_state': (ctx, args) => {
    const trigger = object(args.trigger), attributes: JsonObject = {};
    if (trigger.id === 'groups') {
      const name = object(ctx.catalog?.candle_group).friendly_name ?? 'fx_candle_active';
      let group: JsonObject = { exists: false, members: [], observed_at: timestamp(ctx.now) };
      for (const raw of list(trigger.payload_json)) {
        const candidate = object(raw);
        if (candidate.friendly_name === name) group = { exists: true, id: candidate.id ?? null, members: list(candidate.members), observed_at: timestamp(ctx.now) };
      }
      attributes.candle_group = group;
    } else if (trigger.id === 'response' && String(object(trigger.payload_json).transaction ?? '').startsWith('candle:')) attributes.candle_response = trigger.payload_json!;
    else return null;
    ctx.emit('variable.update_sensor', { value: nativeScalar(ctx.get(runtime)), replace_attributes: false, attributes }, { entity_id: runtime });
    ctx.run('effects_candle_sync_resume');
    return null;
  },
  'automation.effects_candle_membership': ctx => { turnOn(ctx, 'effects_candle_sync'); return null; },
  'automation.effects_lifecycle': ctx => {
    if (!(ctx.scheduled ?? []).some(task => task.script === 'effects_engine_tick') && ctx.get('script.effects_engine') === 'off' && Object.keys(object(ctx.attr(runtime, 'assignments'))).length) ctx.run('ls_apply', { reason: 'config' });
    return null;
  },
  'automation.effects_refresh_native_light_controls': (ctx, args) => { ctx.run('effects_ui_sync', { force: object(args.trigger).id === 'start' }); return null; },
  'automation.lighting_schedule_engine': (ctx, args) => {
    const trigger = object(args.trigger), data: JsonObject = { reason: trigger.id ?? '' };
    if (trigger.id === 'lamp_on') data.lights = [trigger.entity_id ?? ''];
    ctx.run('ls_apply', data);
    return null;
  },
  'automation.lighting_schedule_end_overrides': (ctx, args) => {
    const trigger = object(args.trigger), overrides = object(ctx.attr(store, 'overrides'));
    if (trigger.id === 'after' && ctx.get('input_boolean.ls_ovr_after_on') === 'on') {
      const now = timestamp(ctx.now), limit = num(ctx.get('input_number.ls_ovr_after_min'), 180) * 60;
      const expired = Object.entries(overrides).filter(([, raw]) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
        // Native HA as_timestamp accepts date text, not numeric Unix seconds.
        const value = raw.when, parsed = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
        return now - (Number.isFinite(parsed) ? parsed : now) >= limit;
      }).map(([key]) => key);
      if (expired.length) ctx.fire('ls_override', { op: 'clear', keys: expired, via: 'rule_after' });
    } else if (trigger.id === 'at' && ctx.get('input_boolean.ls_ovr_at_on') === 'on' && Object.keys(overrides).length) ctx.fire('ls_override', { op: 'clear_all', via: 'rule_at' });
    return null;
  },
  'automation.lighting_schedule_sara_mode_switch': (ctx, args) => {
    const trigger = object(args.trigger), who = object(object(trigger.to_state).context).user_id;
    if (who === null || who === undefined) return null;
    const active = Object.hasOwn(object(ctx.attr(store, 'overrides')), 'mode:sara');
    if (trigger.id === 'on' && !active) ctx.fire('ls_override', { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'app', who });
    else if (trigger.id === 'off' && active) ctx.fire('ls_override', { op: 'clear', keys: ['mode:sara'], via: 'app', who });
    return null;
  },
  'automation.lighting_schedule_lamp_change_detector': (ctx, args) => {
    // The HA bridge preserves the original running-script context condition.
    const event = object(object(args.trigger).event), data = object(event.data), who = object(event.context).user_id;
    if (who === null || who === undefined || data.service !== 'turn_on') return null;
    const catalog = ctx.run('effects_catalog'), current = ctx.run('ls_apply', { dry_run: true, reason: 'config' });
    const capture = object(ctx.run('effects_native_plan', { sd: object(data.service_data), catalog, current, stamp: timestamp(ctx.now) }));
    for (const power of list(capture.power)) ctx.fire('ls_override', { op: 'power', area: object(power).area ?? '', on: true, via: 'app', who });
    const records = list(capture.records);
    if (records.length) ctx.fire('ls_override', { op: 'set', records, via: 'app', who });
    return null;
  },
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
