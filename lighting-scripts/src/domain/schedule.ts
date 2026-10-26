import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, isObject, roundEven } from './scale.ts';

export const blocks = ['day', 'cosy', 'night'];
export const list = (value: JsonValue | undefined): JsonValue[] => Array.isArray(value) ? value : [];
export const strings = (value: JsonValue | undefined): string[] => list(value).filter((v): v is string => typeof v === 'string');
export function num(value: JsonValue | undefined, fallback = 0): number {
  const n = typeof value === 'number' || typeof value === 'boolean' ? Number(value) : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
/** HA template output coercion for scalar sensor/control values. */
export function nativeScalar(value: JsonValue): JsonValue {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text === 'True') return true;
  if (text === 'False') return false;
  if (text === 'None') return null;
  const numeric = /^[+-]?(?!0\d)\d*(?:\.\d*)?$/.test(text) && /\d/.test(text);
  return numeric && Number.isFinite(Number(text)) ? Number(text) : value;
}
export function timestamp(value: JsonValue | undefined): number {
  if (typeof value === 'number') return value;
  const ts = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  return Number.isFinite(ts) ? ts : 0;
}
export function hasValue(ctx: ScriptContext, entity: string): boolean { return !['unknown', 'unavailable'].includes(ctx.get(entity)); }
export function saved(ctx: ScriptContext, entity: string): JsonObject {
  try { return object(JSON.parse(ctx.get(entity))); } catch { return {}; }
}
export function labelled(ctx: ScriptContext, label: string): string[] {
  // Registry snapshots supply label members, including device-expanded entities.
  const entities = ctx.labels?.[label] ?? (label === 'house_schedule' ? ctx.members : []);
  return [...new Set(entities.flatMap(e => ctx.devices?.[e] ?? [e]))];
}
export function privateRooms(ctx: ScriptContext): string[] { return ctx.labels?.private_room ?? []; }
export function latestRemote(records: JsonObject, room: string): string {
  let key = '', stamp = -1;
  for (const k of Object.keys(records).sort()) {
    const r = object(records[k]);
    if (r.scope !== 'room' || r.target !== room || !isRemote(r)) continue;
    const ts = timestamp(r.when);
    if (ts >= stamp) { key = k; stamp = ts; }
  }
  return key;
}
export function isRemote(r: JsonObject): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }
export function profile(ctx: ScriptContext, entity: string): JsonObject {
  return { brightness: Math.trunc(num(ctx.attr(entity, 'brightness'), 255)), color: ctx.attr(entity, 'color_mode') === 'color_temp'
    ? { kelvin: Math.trunc(num(ctx.attr(entity, 'color_temp_kelvin'), 3000)) }
    : { rgb: list(ctx.attr(entity, 'rgb_color')).length ? ctx.attr(entity, 'rgb_color')! : [255, 255, 255] } };
}
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(at: number, timezone: string): number[] {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, formatter);
  }
  const p = Object.fromEntries(formatter.formatToParts(new Date(at * 1000)).map(v => [v.type, v.value]));
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(k => Number(p[k]));
}
/** Resolve a wall-clock instant with ZoneInfo's default first-fold policy. */
export function localTime(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const offsets = new Set([-86400, 0, 86400].map(delta => {
    const [y, m, d, h, min, s] = localParts(wall + delta, timezone) as [number, number, number, number, number, number];
    return Date.UTC(y, m - 1, d, h, min, s) / 1000 - wall - delta;
  }));
  const candidates = [...offsets].map(offset => wall - offset);
  const valid = candidates.filter(candidate => {
    const [y, m, d, h, min] = localParts(candidate, timezone) as [number, number, number, number, number];
    return Date.UTC(y, m - 1, d, h, min) / 1000 === wall;
  });
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
}
export function nextMidnight(at: number, timezone: string): number {
  const [year, month, day] = localParts(at, timezone) as [number, number, number];
  return localTime(year, month, day + 1, 0, 0, timezone);
}
export function scheduleDetails(ctx: ScriptContext, scope: string, at: number): JsonObject {
  const zone = ctx.timezone ?? 'Europe/Stockholm';
  const [year, month, day] = localParts(at, zone) as [number, number, number];
  let cur: string | null = null, nxt: string | null = null;
  let curTs = 0, nextTs = 0, nextFade = 0, lastFs = 0, nextFs = 0;
  for (const off of [-2, -1, 0, 1]) {
    const eve = new Date(Date.UTC(year, month - 1, day + off));
    for (const block of blocks) {
      const src = scope === 'house' || ctx.get(`input_boolean.ls_${scope}_${block}_own_timing`) === 'on' ? scope : 'house';
      const isDay = block === 'day';
      const weekday = (eve.getUTCDay() + (isDay ? 1 : 0)) % 7;
      const weekend = isDay ? [6, 0].includes(weekday) : [5, 6].includes(weekday);
      const time = ctx.get(`input_datetime.ls_${src}_${block}_${weekend ? 'weekend' : 'start'}`);
      if (!/^\d\d:\d\d/.test(time)) continue;
      const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5));
      if (hour > 23 || minute > 59) continue;
      const ts = localTime(eve.getUTCFullYear(), eve.getUTCMonth() + 1, eve.getUTCDate() + (isDay || hour < 12 ? 1 : 0), hour, minute, zone);
      const fade = num(ctx.get(`input_number.ls_${src}_${block}_fade`), 20) * 60;
      if (ts <= at && ts > curTs) { cur = block; curTs = ts; }
      if (ts > at && (nxt === null || ts < nextTs)) { nxt = block; nextTs = ts; nextFade = fade; }
      if (ts - fade > at && (nextFs === 0 || ts - fade < nextFs)) nextFs = ts - fade;
      if (ts - fade <= at && ts - fade > lastFs) lastFs = ts - fade;
    }
  }
  const left = nextTs - at;
  const fading = nxt !== null && nextFade > 0 && left < nextFade && nxt !== cur;
  return { cur, nxt, fading, p: fading ? 1 - left / nextFade : 0, edge: at - curTs < 90, last_fs: lastFs, next_fs: nextFs, left, cur_ts: curTs };
}
interface Stage { from: string; to: string; p: number; moving: boolean; edge: boolean; source: string }
function initialStage(S: JsonObject): Stage {
  return { from: String(S.cur ?? 'night'), to: String((S.fading ? S.nxt : S.cur) ?? 'night'), p: num(S.p), moving: Boolean(S.fading), edge: Boolean(S.edge), source: 'schedule' };
}
function wakeStage(ctx: ScriptContext, area: string, S: JsonObject, at: number, stage: Stage): Stage {
  const entity = `input_datetime.ls_${area}_wake`;
  if (!hasValue(ctx, entity)) return stage;
  const wake = num(ctx.attr(entity, 'timestamp'));
  const duration = num(ctx.get(`input_number.ls_${area}_wake_fade`), 37.5) * 60;
  const elapsed = at - wake;
  if (S.cur !== 'night' || num(S.cur_ts) > wake) return stage;
  if (elapsed >= 0 && elapsed < duration) return { ...stage, from: 'night', to: 'day', p: elapsed / duration, moving: true, source: 'wake' };
  const hour = localParts(wake, ctx.timezone ?? 'Europe/Stockholm')[3]!;
  // This is the deployed completed-wake hold, separate from the alarm's 05–12 input window.
  if (elapsed >= duration && elapsed < 86400 && hour >= 4 && hour < 11 && (!S.fading || S.nxt === 'day')) {
    return { from: 'day', to: 'day', p: 0, moving: false, edge: elapsed - duration < 90, source: 'wake' };
  }
  return stage;
}
function scopeFor(ctx: ScriptContext, area: string, block: string): string { return area && ctx.get(`input_boolean.ls_${area}_${block}_own_light`) === 'on' ? area : 'house'; }
function sourceEntity(ctx: ScriptContext, lamp: string | null, area: string, block: string, fallback = true): string {
  if (block === 'lamp' && lamp) return lamp;
  const scope = scopeFor(ctx, area, block);
  const own = lamp && saved(ctx, `input_text.ls_lamp_${lamp.split('.')[1]}_${block}`).own;
  const candidates = [...(own ? [`light.ls_lamp_${lamp!.split('.')[1]}_${block}`] : []), `light.ls_${scope}_${block}`, ...(fallback ? [`light.ls_house_${block}`] : [])];
  return (fallback ? candidates.find(e => hasValue(ctx, e)) : candidates[0]) ?? candidates[0]!;
}
function sample(ctx: ScriptContext, entity: string): JsonObject {
  return { ...profile(ctx, entity), on: ctx.get(entity) === 'on', rgb: list(ctx.attr(entity, 'rgb_color')).length ? ctx.attr(entity, 'rgb_color')! : [255, 255, 255] };
}
function interpolate(A: JsonObject, B: JsonObject, stage: Stage): JsonObject {
  if (!stage.moving || !A.on) return B;
  if (!B.on) return { ...A, brightness: Math.max(1, roundEven(num(A.brightness) * (1 - stage.p))) };
  const a = object(A.color), b = object(B.color);
  const color: JsonObject = 'kelvin' in a && 'kelvin' in b ? { kelvin: roundEven(num(a.kelvin) + (num(b.kelvin) - num(a.kelvin)) * stage.p) }
    : { rgb: [0, 1, 2].map(i => roundEven(num(list(A.rgb)[i]) + (num(list(B.rgb)[i]) - num(list(A.rgb)[i])) * stage.p)) };
  return { on: true, brightness: roundEven(num(A.brightness) + (num(B.brightness) - num(A.brightness)) * stage.p), color };
}
function applies(r: JsonObject, key: string, lamp: string | null, room: string, privateRoom: boolean): boolean {
  return (r.kind === 'light' && r.target === lamp && lamp !== null)
    || (['channels', 'input'].includes(String(r.kind)) && ((r.scope === 'lamp' && lamp !== null && r.target === lamp) || (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !privateRoom)))
    || (key === 'mode:sara' && !privateRoom);
}

export function scheduledBase(ctx: ScriptContext, args: JsonObject, roomLocal = false): JsonObject {
  const at = timestamp(args.test_now || ctx.now);
  const why = String(args.reason ?? 'config');
  const records = object(args.overrides ?? ctx.attr('sensor.ls_overrides', 'overrides'));
  const expiry = ctx.get('input_boolean.ls_ovr_next_block_on') === 'on';
  const dimmables = labelled(ctx, 'house_schedule').filter(e => e.startsWith('light.'));
  const plugs = labelled(ctx, 'on_off').filter(e => /^(light|switch)\./.test(e));
  const all = [...dimmables, ...plugs, ...Object.keys(object(ctx.attr('sensor.ls_overrides', 'switch_ranges')))];
  const roomOnly = String((roomLocal ? args.room : args.room_only) ?? '');
  const rooms = [...new Set(all.map(e => ctx.areas[e]).filter((a): a is string => Boolean(a)))].sort().filter(a => !roomOnly || roomOnly === a);
  const details: JsonObject = Object.fromEntries(['house', ...rooms].map(room => [room, scheduleDetails(ctx, room, at)]));
  const profiles: JsonObject = {}, targets: JsonObject = {}, commands = new Map<string, JsonObject>();
  const debug: string[] = [];
  for (const lamp of [...dimmables, ...plugs]) {
    if (roomOnly && (!roomLocal || ctx.areas[lamp] !== roomOnly)) continue;
    if (roomLocal && !dimmables.includes(lamp)) continue;
    const area = ctx.areas[lamp] ?? '';
    const room = rooms.includes(area) ? area : 'house';
    const S = object(details[room]);
    const privateRoom = privateRooms(ctx).includes(area);
    const newest = latestRemote(records, room);
    let chosen = object(records[`block:${room}`]);
    let chosenStamp = timestamp(chosen.when);
    for (const key of Object.keys(records).sort()) {
      const r = object(records[key]), value = object(r.value);
      if (!['channels', 'input'].includes(String(r.kind)) || !applies(r, key, lamp, room, privateRoom)) continue;
      if (r.scope === 'room' && isRemote(r) && key !== newest) continue;
      const stamp = num(value.period_updated, timestamp(r.when));
      if (blocks.includes(String(value.period)) && stamp >= chosenStamp && !(expiry && timestamp(r.when) <= num(S.last_fs))) {
        chosen = { value: value.period!, when: r.when ?? null }; chosenStamp = stamp;
      }
    }
    if (expiry && !S.fading && timestamp(chosen.when) <= num(S.last_fs)) chosen = {};
    const ignored = Object.keys(records).sort().filter(key => expiry && applies(object(records[key]), key, lamp, room, privateRoom) && timestamp(object(records[key]).when) <= num(S.last_fs));
    let stage = initialStage(S);
    if (S.fading && (ignored.length || (Object.keys(chosen).length > 0 && timestamp(chosen.when) <= num(S.last_fs)))) {
      stage = { from: 'lamp', to: String(S.nxt), p: Math.min(1, (why === 'tick' ? 60 : 3) / Math.max(num(S.left), 1)), moving: true, edge: false, source: 'fadeout' };
    } else if (blocks.includes(String(chosen.value).toLowerCase())) {
      stage = { ...stage, from: String(chosen.value).toLowerCase(), to: String(chosen.value).toLowerCase(), p: 0, moving: false, source: 'override' };
    } else if (room !== 'house') stage = wakeStage(ctx, room, S, at, stage);
    const block = stage.from === 'lamp' ? stage.to : stage.from;
    const scope = scopeFor(ctx, area, block);
    const lampSaved = saved(ctx, `input_text.ls_lamp_${lamp.split('.')[1]}_${block}`);
    const pr = lampSaved.own ? lampSaved : saved(ctx, `input_text.ls_${scope}_${block}`);
    if (plugs.includes(lamp)) {
      const selectedBlock = !stage.moving || stage.p >= 1 ? stage.to : stage.from;
      const selectedScope = scopeFor(ctx, area, selectedBlock);
      const lp = saved(ctx, `input_text.ls_lamp_${lamp.split('.')[1]}_${selectedBlock}`);
      const src = [`input_boolean.ls_${selectedScope}_${selectedBlock}_on_off`, `input_boolean.ls_house_${selectedBlock}_on_off`].find(e => hasValue(ctx, e));
      const want = lp.own ? Boolean(lp.on) : src ? ctx.get(src) === 'on' : null;
      if (!stage.moving && want !== null && ctx.get(lamp) !== (want ? 'on' : 'off')) {
        const service = `homeassistant.turn_${want ? 'on' : 'off'}`;
        const previous = commands.get(service);
        commands.set(service, { kind: 'switch', service, ids: [...strings(previous?.ids), lamp] });
      }
      continue;
    }
    const from = sample(ctx, sourceEntity(ctx, lamp, area, stage.from));
    const to = sample(ctx, sourceEntity(ctx, lamp, area, stage.to));
    const target = interpolate(from, to, stage);
    const transition = stage.moving && why === 'tick' ? 60 : 3;
    const color = object(target.color);
    const p: JsonObject = { effect: pr.effect ?? 'Normal light', brightness: target.brightness ?? 1, on: target.on ?? false, period: block, area: area || null,
      effect_channels: pr.effect_channels ?? ['brightness', 'color'], send: why !== 'tick' || stage.moving || stage.edge, ignore_overrides: ignored };
    profiles[lamp] = p;
    const command: JsonObject = !target.on ? { kind: 'off', transition } : 'kelvin' in color
      ? { kind: 'ct', brightness: Math.max(num(target.brightness), 1), kelvin: color.kelvin!, transition }
      : { kind: 'rgb', brightness: Math.max(num(target.brightness), 1), rgb: color.rgb ?? [255, 255, 255], transition };
    const key = JSON.stringify(command), previous = commands.get(key);
    commands.set(key, { ...command, ids: [...strings(previous?.ids), lamp] });
    targets[lamp] = { ...p, is_room: false, brightness: target.on ? Math.max(num(target.brightness), 1) : p.brightness!, color: target.on ? color : { kelvin: 3000 },
      day: profile(ctx, sourceEntity(ctx, lamp, area, 'day', false)), cosy: profile(ctx, sourceEntity(ctx, lamp, area, 'cosy', false)), transition, observed: profile(ctx, lamp) };
    // Scaling first loses the original binary error (0.005 * 100 becomes
    // exactly 0.5). toFixed preserves it; exact binary half-cent values are /8.
    const rounded = Number.isInteger(stage.p * 8) ? roundEven(stage.p * 100) / 100 : Number(stage.p.toFixed(2));
    const debugP = Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
    debug.push(`${lamp} ${room}/${room} ${stage.source} ${stage.from}>${stage.to} p=${debugP} send=True`);
  }
  for (const area of rooms) {
    const S = object(details[area]), privateRoom = privateRooms(ctx).includes(area);
    const ignored = Object.keys(records).filter(key => {
      const r = object(records[key]);
      const match = (r.scope === 'room' && r.target === area) || (r.scope === 'house' && !privateRoom) || (key === 'mode:sara' && !privateRoom) || (r.kind === 'block' && r.target === area);
      return expiry && match && timestamp(r.when) <= num(S.last_fs);
    });
    let period = String(S.cur ?? 'night'), stamp = 0, explicit = false;
    const newest = latestRemote(records, area);
    for (const key of Object.keys(records).sort()) {
      const r = object(records[key]);
      if (ignored.includes(key)) continue;
      const match = (r.kind === 'block' && r.target === area) || (['channels', 'input'].includes(String(r.kind)) && ((r.scope === 'room' && r.target === area) || (r.scope === 'house' && !privateRoom)));
      if (!match || (r.scope === 'room' && isRemote(r) && key !== newest)) continue;
      const value = object(r.value), selected = r.kind === 'block' ? r.value : value.period;
      const updated = num(value.period_updated, timestamp(r.when));
      if (blocks.includes(String(selected)) && updated >= stamp) { period = String(selected); stamp = updated; explicit = true; }
    }
    let stage = explicit ? { ...initialStage(S), from: period, to: period, p: 0, moving: false } : wakeStage(ctx, area, S, at, initialStage(S));
    const from = sample(ctx, sourceEntity(ctx, null, area, stage.from, false));
    const to = sample(ctx, sourceEntity(ctx, null, area, stage.to, false));
    const target = interpolate(from, to, stage);
    const pr = saved(ctx, `input_text.ls_${scopeFor(ctx, area, stage.from)}_${stage.from}`);
    targets[`room:${area}`] = { brightness: target.brightness!, color: target.color!, area, is_room: true, period: stage.from, effect: pr.effect ?? 'Normal light', on: target.on!,
      day: profile(ctx, sourceEntity(ctx, null, area, 'day', false)), cosy: profile(ctx, sourceEntity(ctx, null, area, 'cosy', false)), ignore_overrides: ignored };
  }
  const stale = Object.keys(records).filter(key => {
    if (!expiry) return false;
    const r = object(records[key]);
    const area = r.kind === 'light' || r.scope === 'lamp' ? ctx.areas[String(r.target)] : String(r.target);
    const scope = rooms.includes(area ?? '') ? area! : 'house';
    const scopes = r.scope === 'house' || key === 'mode:sara' ? rooms.filter(a => !privateRooms(ctx).includes(a)) : [scope];
    return scopes.length > 0 && scopes.every(a => timestamp(r.when) <= num(object(details[a]).last_fs) && !object(details[a]).fading);
  });
  const sched: JsonObject = {}, mirror: JsonValue[] = [];
  for (const scope of ['house', ...rooms]) {
    const S = object(details[scope]); sched[scope] = S.cur ?? null;
    const override = String(object(records[`block:${scope}`]).value).toLowerCase();
    const effective = blocks.includes(override) && !stale.includes(`block:${scope}`) ? override : String(S.cur ?? 'night');
    const option = effective[0]!.toUpperCase() + effective.slice(1), entity = `input_select.ls_${scope}_override`;
    if (ctx.state[entity] && ctx.get(entity) !== option) mirror.push({ entity, option });
  }
  const packed = [...commands.values()].map(command => {
    let ids = strings(command.ids);
    for (const [entity, value] of Object.entries(object(ctx.catalog?.baseline_groups))) {
      const members = strings(value);
      if (members.length > 0 && members.every(member => ids.includes(member))) ids = [entity, ...ids.filter(id => !members.includes(id))];
    }
    return { ...command, ids };
  });
  const schedule: JsonObject = { cmds: packed, profiles, revision: ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now, stale_keys: stale, sched, schedule_details: details, mirror,
    sara_mirror: ctx.state['input_boolean.ls_sara_mode_mirror'] && ctx.get('input_boolean.ls_sara_mode_mirror') !== 'off' ? 'off' : null };
  if (args.debug) schedule.dbg = debug;
  return { targets, schedule };
}
export const scheduleHandlers: ScriptHandlers = {
  ls_base: (ctx, args) => scheduledBase(ctx, args),
  ls_room_base: (ctx, args) => scheduledBase(ctx, args, true),
};
