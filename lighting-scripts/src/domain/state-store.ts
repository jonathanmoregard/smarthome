import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { isObject, object } from './scale.ts';
import { recordTimestamp } from './resolution.ts';
import { labelled, privateRooms } from './schedule.ts';

const records = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isObject) : [];
const values = (value: JsonValue | undefined): JsonValue[] => Array.isArray(value) ? value : [];
const keyOf = (record: JsonObject) => String(record.key ?? `${record.kind}:${record.source ?? record.target}`);
const bool = (v: JsonValue | undefined) => typeof v === 'string' ? ['true', 'on', 'yes', '1'].includes(v.toLowerCase()) : Boolean(v);

/** The single override writer, preserving unrelated attributes and channel timestamps. */
export function commit(ctx: ScriptContext, args: JsonObject): JsonObject {
  const data = object(args.data);
  const entity = 'sensor.ls_overrides';
  const currentRevision = ctx.state[entity]?.last_updated ?? ctx.now;
  if (data.expected_revision != null && data.expected_revision !== currentRevision) return { accepted: false };
  const before = object(ctx.attr(entity, 'overrides'));
  let overrides = structuredClone(before);
  let patch: JsonObject = {};
  const op = data.op ?? 'set';
  if (op === 'clear_all') overrides = {};
  else if (op === 'clear') overrides = Object.fromEntries(Object.entries(before).filter(([k]) => !values(data.keys).includes(k)));
  else if (op === 'clear_room') overrides = Object.fromEntries(Object.entries(before).filter(([, raw]) => {
    const r = object(raw), target = String(r.target);
    return !(r.scope === 'room' && r.target === data.area || (r.scope === 'lamp' || r.kind === 'light') && ctx.areas[target] === data.area || r.kind === 'block' && r.target === data.area);
  }));
  else if (op === 'set') for (const r of records(data.records)) {
    const key = keyOf(r), old = object(overrides[key]);
    let value = r.value ?? null;
    if (r.kind === 'channels' && isObject(value)) {
      const prior = object(old.value);
      const channels = { ...object(prior.channels) };
      for (const [channel, raw] of Object.entries(object(value.channels))) {
        const claim = { ...object(raw) }, previous = object(channels[channel]);
        if (claim.kind === 'effect' && !Object.hasOwn(claim, 'underlying')) {
          const underlying = ['constant', 'scale'].includes(String(previous.kind)) ? previous : previous.underlying;
          if (isObject(underlying)) claim.underlying = underlying;
        }
        channels[channel] = claim;
      }
      value = { ...prior, ...value, channels };
    }
    overrides[key] = { ...r, value, when: ctx.now, created: old.created ?? old.when ?? ctx.now, who: data.who || null, via: data.via ?? null };
  }
  else if (op === 'power') patch.power = { ...object(ctx.attr(entity, 'power')), [String(data.area)]: bool(data.on) };
  else if (op === 'range_set') {
    const valid = ['bright', 'cosy'].includes(String(data.profile)) || data.profile === 'custom' && typeof data.min === 'number' && typeof data.max === 'number' && 0 <= data.min && data.min <= data.max && data.max <= 100;
    if (valid) patch.switch_ranges = { ...object(ctx.attr(entity, 'switch_ranges')), [String(data.entity)]: data.profile === 'custom' ? { profile: 'custom', min: data.min!, max: data.max! } : { profile: data.profile! } };
  } else if (op === 'range_defaults') {
    const ranges = object(data.ranges);
    const valid = (v: JsonValue | undefined) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && 0 <= v[0] && v[0] <= v[1] && v[1] <= 100;
    if (valid(ranges.bright) && valid(ranges.cosy)) patch.range_defaults = ranges;
  }
  if (data.via === 'remote' && data.source && data.request_id) patch.remote_ack = { ...object(ctx.attr(entity, 'remote_ack')), [String(data.source)]: data.request_id };
  patch = { ...patch, overrides, last_via: data.via ?? null };
  const pending = { ...object(ctx.attr(entity, 'pending_rooms')) };
  const affected = new Set<string>();
  if (data.area) affected.add(String(data.area));
  for (const record of records(data.records)) for (const item of [object(before[keyOf(record)]), record]) {
    if (item.scope === 'room') affected.add(String(item.target));
  }
  for (const room of affected) pending[room] = ctx.now;
  patch = { ...patch, pending_rooms: pending, last_request: ctx.now, received_at: data.received_at ?? recordTimestamp(ctx.now) };
  const full = data.via !== 'remote' || ['render_request', 'clear', 'clear_all'].includes(String(data.op)) || records(data.records).some(r => r.kind === 'mode');
  if (full) {
    const unhandled = ctx.attr(entity, 'full_version') !== (ctx.attr('sensor.ls_effects_runtime', 'handled_full') || null);
    const previousLights = unhandled ? values(ctx.attr(entity, 'full_lights')) : [];
    const previousReason = unhandled ? ctx.attr(entity, 'full_reason') : null;
    let reason = data.reason ?? (data.via === 'remote' ? 'remote' : 'config');
    if (reason === 'tick' && previousReason && previousReason !== 'tick') reason = 'config';
    patch = { ...patch, full_version: ctx.now, full_reason: reason, full_lights: [...new Set([...previousLights, ...values(data.lights)])] };
  }
  ctx.emit('variable.update_sensor', { value: ctx.now, attributes: patch, replace_attributes: false }, { entity_id: entity });
  ctx.emit('script.turn_on', {}, { entity_id: 'script.ls_render' });
  return { accepted: true, revision: ctx.state[entity]?.last_updated ?? ctx.now, committed_at: recordTimestamp(ctx.now) };
}

export function storeProfile(ctx: ScriptContext, args: JsonObject): JsonValue {
  const entity = String(args.store);
  let current: JsonObject;
  try { current = object(JSON.parse(ctx.get(entity)) as JsonValue); } catch { current = {}; }
  const catalog = object(ctx.run('effects_catalog'));
  const patch: JsonObject = {};
  for (const key of ['on', 'own']) if (args[key] != null) patch[key] = bool(args[key]);
  if (args.brightness != null) patch.b = Math.trunc(Number(args.brightness)) || 0;
  if (args.kelvin != null) { patch.m = 'ct'; patch.k = Math.trunc(Number(args.kelvin)) || 0; }
  else if (args.mireds != null) { patch.m = 'ct'; patch.k = Math.trunc(1_000_000 / Number(args.mireds)); }
  if (args.hs != null) { const hs = values(args.hs); patch.m = 'hs'; patch.h = Number(hs[0]); patch.s = Number(hs[1]); }
  const effects = object(catalog.effects);
  let channels = values(current.effect_channels ?? object(effects[String(current.effect ?? 'Normal light')]).channels);
  if (args.effect != null) { patch.effect = args.effect; channels = values(object(effects[String(args.effect)]).channels); }
  else {
    if (args.brightness != null) channels = channels.filter(x => x !== 'brightness');
    if (args.kelvin != null || args.mireds != null || args.hs != null) channels = channels.filter(x => x !== 'color');
  }
  patch.effect_channels = channels;
  const value = JSON.stringify({ ...current, ...patch });
  ctx.emit('input_text.set_value', { value }, { entity_id: entity });
  if (entity.startsWith('input_text.ls_lamp_')) ctx.fire('ls_lamp_store_changed', { store: entity });
  return null;
}

export const stateStoreHandlers: ScriptHandlers = {
  ls_commit: commit, ls_store: storeProfile,
  ls_override_block: (ctx, args) => {
    const current = object(ctx.run('ls_apply', { dry_run: true }));
    const schedule = object(object(current.plan).sched), scope = String(args.scope), block = String(args.block).toLowerCase();
    const targets = [scope];
    if (scope === 'house') {
      const privateAreas = privateRooms(ctx);
      const entities = [...labelled(ctx, 'house_schedule'), ...labelled(ctx, 'on_off')];
      const rooms = entities.map(entity => ctx.areas[entity]).filter((area): area is string => Boolean(area) && !privateAreas.includes(area!));
      targets.push(...new Set(rooms));
    }
    const set = targets.filter(target => schedule[target] !== block).map(target => ({ kind: 'block', target, value: block }));
    const clear = targets.filter(target => schedule[target] === block).map(target => `block:${target}`);
    if (set.length) ctx.fire('ls_override', { op: 'set', records: set, via: args.via ?? 'app' });
    if (clear.length) ctx.fire('ls_override', { op: 'clear', keys: clear, via: args.via ?? 'app' });
    return null;
  },
  ls_clear_overrides: (ctx, args) => { ctx.fire('ls_override', { op: 'clear_all', via: args.via ?? 'app' }); return null; },
  ls_sara_mode: (ctx, args) => {
    ctx.fire('ls_override', Object.hasOwn(object(ctx.attr('sensor.ls_overrides', 'overrides')), 'mode:sara')
      ? { op: 'clear', keys: ['mode:sara'], via: args.via ?? 'app' }
      : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: args.via ?? 'app' });
    return null;
  },
};
