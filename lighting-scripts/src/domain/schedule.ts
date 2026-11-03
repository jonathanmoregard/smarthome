import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { isObject, object, ParseError, requireArray, requireBoolean, requireFinite, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { BLOCKS, DEFAULT_BLOCK, type Block } from './blocks.ts';
import { roundEven } from './scale.ts';
import { isBlock } from '../parse/blocks.ts';
import { typed } from '../runtime/entrypoints.ts';

export const blocks: readonly string[] = BLOCKS;
export const list = (value: JsonValue | undefined): JsonValue[] =>
  value === undefined ? [] : requireArray({ value }, 'value', 'schedule list');
export const strings = (value: JsonValue | undefined): string[] => list(value).map((item, index) =>
  requireString({ item }, 'item', `schedule string list[${index}]`));
export function isAreaId(value: string | undefined): value is string { return value !== undefined && value.length > 0; }
export function num(value: JsonValue | undefined, fallback?: number): number {
  // `null` is Home Assistant's no-value spelling for entity attributes. A
  // caller that has a real default must state it; malformed present values do
  // not get to take that default.
  if ((value === undefined || value === null || value === 'unknown' || value === 'unavailable') && fallback !== undefined) return fallback;
  return requireFinite(value, 'schedule number');
}
/**
 * Home Assistant native-template output coercion at the render/re-entry
 * boundary. This is deliberately not a general parser: HA turns a template's
 * exact scalar output back into a native value before a script or variable
 * sensor receives it, so confining that behavior here models the transport
 * boundary without weakening lighting-domain numbers or strings.
 */
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
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const ts = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
  if (!Number.isFinite(ts)) throw new ParseError(`schedule timestamp must be a finite epoch or date string, got ${JSON.stringify(value) ?? 'undefined'}`);
  return ts;
}
export function optionalTimestamp(value: JsonValue | undefined): number | undefined {
  return value === undefined || value === null ? undefined : timestamp(value);
}
const timestampOrZero = (value: JsonValue | undefined): number => optionalTimestamp(value) ?? 0;
export function hasValue(ctx: ScriptContext, entity: string): boolean { return !['unknown', 'unavailable'].includes(ctx.get(entity)); }
export function saved(ctx: ScriptContext, entity: string): JsonObject {
  const state = ctx.get(entity);
  // Home Assistant uses these sentinel states when an input_text has no value;
  // malformed present JSON is a corrupt profile, not another absence spelling.
  if (state === 'unknown' || state === 'unavailable') return {};
  let parsed: JsonValue;
  try { parsed = JSON.parse(state) as JsonValue; }
  catch { throw new ParseError(`${entity} must contain a valid JSON object`); }
  return requireObject({ parsed }, 'parsed', entity);
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
    const ts = timestampOrZero(r.when);
    if (ts >= stamp) { key = k; stamp = ts; }
  }
  return key;
}
export function isRemote(r: JsonObject): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }
/**
 * A lamp's colour as the schedule carries it.
 *
 * `rgb` stays an unparsed list **by design, not by omission**. Home Assistant's
 * `rgb_color` attribute is read raw and handed straight to the command payload,
 * which the parity harness compares byte for byte, so the elements must survive
 * uncoerced. Parsing them into an `RGB` triple here would raise where the
 * oracle passes the value through — a divergence. The elements are coerced only
 * where the captured source coerces them, by `num()` inside
 * {@link interpolate}.
 */
export type LampColor = { kelvin: number; rgb?: never } | { rgb: JsonValue[]; kelvin?: never };
/** What {@link profile} reads off a lamp or schedule entity. */
export type LampProfile = { brightness: number; color: LampColor };
/** A profile plus its on/off state. {@link interpolate} returns this. */
export type LampTarget = LampProfile & { on: boolean };
/** A target plus the raw rgb triple {@link interpolate} mixes with. */
export type LampSample = LampTarget & { rgb: JsonValue[] };

export function profile(ctx: ScriptContext, entity: string): LampProfile {
  const rgb = list(ctx.attr(entity, 'rgb_color'));
  return { brightness: Math.trunc(num(ctx.attr(entity, 'brightness'), 255)), color: ctx.attr(entity, 'color_mode') === 'color_temp'
    ? { kelvin: Math.trunc(num(ctx.attr(entity, 'color_temp_kelvin'), 3000)) }
    : { rgb: rgb.length > 0 ? rgb : [255, 255, 255] } };
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
export type ScheduleDetails = {
  cur: Block | null;
  nxt: Block | null;
  fading: boolean;
  p: number;
  edge: boolean;
  last_fs: number;
  next_fs: number;
  left: number;
  cur_ts: number;
};
interface ScheduledBaseArgs {
  testNow: number | undefined;
  reason: string;
  overrides: JsonObject | undefined;
  roomOnly: string;
  includeDebug: boolean;
}
function parseScheduledBaseArgs(args: JsonObject, context: string, roomOnly: string): ScheduledBaseArgs {
  return {
    testNow: optionalTimestamp(args.test_now),
    reason: args.reason === undefined ? 'config' : requireString(args, 'reason', context),
    overrides: args.overrides === undefined || args.overrides === null
      ? undefined
      : requireObject(args, 'overrides', context),
    roomOnly,
    // The captured template tests definition, not truthiness. The raw value is
    // never otherwise consumed, so the typed domain only carries the decision.
    includeDebug: Object.hasOwn(args, 'debug'),
  };
}
export function scheduleDetails(ctx: ScriptContext, scope: string, at: number): ScheduleDetails {
  const zone = ctx.timezone ?? 'Europe/Stockholm';
  const [year, month, day] = localParts(at, zone) as [number, number, number];
  let cur: Block | null = null, nxt: Block | null = null;
  let curTs = 0, nextTs = 0, nextFade = 0, lastFs = 0, nextFs = 0;
  for (const off of [-2, -1, 0, 1]) {
    const eve = new Date(Date.UTC(year, month - 1, day + off));
    for (const block of BLOCKS) {
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
function initialStage(S: ScheduleDetails): Stage {
  const cur = S.cur === null ? DEFAULT_BLOCK : S.cur;
  const next = S.fading ? S.nxt : S.cur;
  return { from: cur, to: next === null ? DEFAULT_BLOCK : next, p: num(S.p), moving: S.fading, edge: S.edge, source: 'schedule' };
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
  const lampProfile = lamp === null ? undefined : saved(ctx, `input_text.ls_lamp_${lamp.split('.')[1]}_${block}`);
  const own = lampProfile === undefined || lampProfile.own === undefined
    ? false
    : requireBoolean(lampProfile.own, `ls_base.saved.${lamp}.${block}.own`);
  const candidates = [...(own && lamp !== null ? [`light.ls_lamp_${lamp.split('.')[1]}_${block}`] : []), `light.ls_${scope}_${block}`, ...(fallback ? [`light.ls_house_${block}`] : [])];
  return (fallback ? candidates.find(e => hasValue(ctx, e)) : candidates[0]) ?? candidates[0]!;
}
function sample(ctx: ScriptContext, entity: string): LampSample {
  const rgb = list(ctx.attr(entity, 'rgb_color'));
  // `on` is `=== 'on'`, so it is always a real boolean — never absent, never a
  // falsy stand-in. That is what lets every downstream `target.on` read be a
  // boolean test by construction rather than a truthiness gamble.
  return { ...profile(ctx, entity), on: ctx.get(entity) === 'on', rgb: rgb.length > 0 ? rgb : [255, 255, 255] };
}
function interpolate(A: LampSample, B: LampSample, stage: Stage): LampTarget {
  if (!stage.moving || !A.on) return B;
  if (!B.on) return { ...A, brightness: Math.max(1, roundEven(A.brightness * (1 - stage.p))) };
  const a = A.color, b = B.color;
  const color: LampColor = 'kelvin' in a && 'kelvin' in b ? { kelvin: roundEven(a.kelvin + (b.kelvin - a.kelvin) * stage.p) }
    : { rgb: [0, 1, 2].map(i => roundEven(num(A.rgb[i]) + (num(B.rgb[i]) - num(A.rgb[i])) * stage.p)) };
  return { on: true, brightness: roundEven(A.brightness + (B.brightness - A.brightness) * stage.p), color };
}
function applies(r: JsonObject, key: string, lamp: string | null, room: string, privateRoom: boolean): boolean {
  return (r.kind === 'light' && r.target === lamp && lamp !== null)
    || (['channels', 'input'].includes(String(r.kind)) && ((r.scope === 'lamp' && lamp !== null && r.target === lamp) || (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !privateRoom)))
    || (key === 'mode:sara' && !privateRoom);
}

/** One `input_select` the schedule wants moved to match the effective block. */
export type ScheduleMirror = { entity: string; option: string };
/**
 * One output the schedule decided on, before the lamps that share it are
 * attached. Discriminated on `kind`.
 *
 * `rgb` is `JsonValue[]` and must stay so: it comes off `LampColor`, which
 * `profile` fills from `list(ctx.attr(entity, 'rgb_color'))` -- a raw Home
 * Assistant attribute that is handed into compared JSON unchanged. Narrowing
 * it to the three-element `RGB` would be a projection, and it is also simply
 * not what the attribute guarantees. `kelvin` is a real number because
 * `interpolate` computes it.
 */
export type ScheduleOutput =
  | { kind: 'off'; transition: number }
  | { kind: 'ct'; brightness: number; kelvin: number; transition: number }
  | { kind: 'rgb'; brightness: number; rgb: JsonValue[]; transition: number };
/**
 * The same output with its lamps. `ids` is rewritten once more in `packed`,
 * where a baseline group that covers every member replaces them by its own
 * entity, so the field is a plain `string[]` throughout.
 */
export type ScheduleCommand = ScheduleOutput & { ids: string[] } | { kind: 'switch'; service: string; ids: string[] };
/**
 * `ls_base`/`ls_room_base`'s result, typed one layer at a time.
 *
 * `cmds`, `profiles` and `targets` are deliberately still JSON here, and that
 * is a staging decision rather than an omission. All three are constructed and
 * all three will type, but each is a union of several shapes built across two
 * long loops, and `ls_plan` spreads this whole object into compared bytes
 * (`{...schedule}`) while handing `targets` on to `effects_resolve` and
 * `effects_gradient_plan` as JSON arguments. So they go in their own commits,
 * each gated on its own, instead of one change nobody can review.
 *
 * Everything else is exact already:
 *
 * - `schedule_details` was ALWAYS `Record<string, ScheduleDetails>`; the type
 *   existed and the field threw it away.
 * - `revision` is `string` because `EntityState.last_updated` is
 *   `string | undefined` and `ctx.now` is a `string`.
 * - `sara_mirror` is the literal `'off'` or null, nothing else.
 * - `dbg` is optional because the handler adds it only for `includeDebug`,
 *   and an absent key is not the same bytes as a null one.
 */
export type ScheduleEnvelope = {
  cmds: ScheduleCommand[];
  profiles: Record<string, LampProfileEntry>;
  revision: string;
  stale_keys: string[];
  sched: Record<string, Block | null>;
  schedule_details: Record<string, ScheduleDetails>;
  mirror: ScheduleMirror[];
  sara_mirror: 'off' | null;
  dbg?: string[];
};
/**
 * One lamp's scheduled profile, as `schedule.profiles` carries it.
 *
 * `effect` and `effect_channels` stay `JsonValue`: both come from
 * `saved(ctx, ...)`, which parses a stored `input_text` document, and both are
 * handed on untouched -- `ls_store` round-trips `effect_channels` and
 * `effects_ui_sync` reads `effect` back out. The `=== undefined` defaults are
 * absence-only on purpose; a stored null is not the same as a missing key.
 *
 * `area` is `string | null` because the source writes `area || null`, turning
 * a lamp with no area into an explicit null. That is a Jinja-truthiness
 * fallback on a string, so the empty-string case is load-bearing and the
 * spelling stays.
 */
export type LampProfileEntry = {
  effect: JsonValue;
  brightness: number;
  on: boolean;
  period: string;
  area: string | null;
  effect_channels: JsonValue;
  send: boolean;
  ignore_overrides: string[];
};
/**
 * A lamp's entry in `targets`: its profile plus what the renderer needs.
 * `color` is a `LampColor`, so its `rgb` arm is still raw -- see
 * {@link ScheduleOutput}. The off case substitutes `{kelvin: 3000}`.
 */
export type LampTargetEntry = LampProfileEntry & {
  is_room: false;
  color: LampColor;
  day: LampProfile;
  cosy: LampProfile;
  transition: number;
  observed: LampProfile;
};
/**
 * A room's entry in `targets`. **Not** a superset or subset of the lamp entry:
 * it has no `send`, `transition` or `observed`, and it carries `area` as a
 * plain string rather than a nullable one. Keeping them as two members of a
 * union rather than one optional-heavy shape is what stops a reader assuming
 * a field exists on both.
 */
export type RoomTargetEntry = {
  brightness: number;
  color: LampColor;
  area: string;
  is_room: true;
  period: string;
  effect: JsonValue;
  on: boolean;
  day: LampProfile;
  cosy: LampProfile;
  ignore_overrides: string[];
};
export type TargetEntry = LampTargetEntry | RoomTargetEntry;
export type ScheduledBaseResult = {
  targets: Record<string, TargetEntry>;
  schedule: ScheduleEnvelope;
};

export function scheduledBase(ctx: ScriptContext, args: ScheduledBaseArgs, roomLocal = false): ScheduledBaseResult {
  const at = args.testNow === undefined ? timestamp(ctx.now) : args.testNow;
  const why = args.reason;
  const records = args.overrides === undefined
    ? object(ctx.attr('sensor.ls_overrides', 'overrides'))
    : args.overrides;
  const expiry = ctx.get('input_boolean.ls_ovr_next_block_on') === 'on';
  const dimmables = labelled(ctx, 'house_schedule').filter(e => e.startsWith('light.'));
  const plugs = labelled(ctx, 'on_off').filter(e => /^(light|switch)\./.test(e));
  const all = [...dimmables, ...plugs, ...Object.keys(object(ctx.attr('sensor.ls_overrides', 'switch_ranges')))];
  const roomOnly = args.roomOnly;
  const rooms = [...new Set(all.map(e => ctx.areas[e]).filter(isAreaId))].sort().filter(a => !roomOnly || roomOnly === a);
  const details = Object.fromEntries(['house', ...rooms].map(room => [room, scheduleDetails(ctx, room, at)])) as Record<string, ScheduleDetails>;
  const profiles: Record<string, LampProfileEntry> = {}, targets: Record<string, TargetEntry> = {}, commands = new Map<string, ScheduleCommand>();
  const debug: string[] = [];
  for (const lamp of [...dimmables, ...plugs]) {
    if (roomOnly && (!roomLocal || ctx.areas[lamp] !== roomOnly)) continue;
    if (roomLocal && !dimmables.includes(lamp)) continue;
    const area = ctx.areas[lamp] ?? '';
    const room = rooms.includes(area) ? area : 'house';
    const S = details[room]!;
    const privateRoom = privateRooms(ctx).includes(area);
    const newest = latestRemote(records, room);
    let chosen = object(records[`block:${room}`]);
    let chosenStamp = timestampOrZero(chosen.when);
    for (const key of Object.keys(records).sort()) {
      const r = object(records[key]), value = object(r.value);
      if (!['channels', 'input'].includes(String(r.kind)) || !applies(r, key, lamp, room, privateRoom)) continue;
      if (r.scope === 'room' && isRemote(r) && key !== newest) continue;
      const stamp = value.period_updated === undefined ? timestampOrZero(r.when) : num(value.period_updated);
      if (isBlock(value.period) && stamp >= chosenStamp && !(expiry && timestampOrZero(r.when) <= num(S.last_fs))) {
        chosen = { value: value.period, when: r.when ?? null }; chosenStamp = stamp;
      }
    }
    if (expiry && !S.fading && timestampOrZero(chosen.when) <= num(S.last_fs)) chosen = {};
    const ignored = Object.keys(records).sort().filter(key => expiry && applies(object(records[key]), key, lamp, room, privateRoom) && timestampOrZero(object(records[key]).when) <= num(S.last_fs));
    let stage = initialStage(S);
    if (S.fading && (ignored.length || (Object.keys(chosen).length > 0 && timestampOrZero(chosen.when) <= num(S.last_fs)))) {
      stage = { from: 'lamp', to: String(S.nxt), p: Math.min(1, (why === 'tick' ? 60 : 3) / Math.max(num(S.left), 1)), moving: true, edge: false, source: 'fadeout' };
    } else if (blocks.includes(String(chosen.value).toLowerCase())) {
      stage = { ...stage, from: String(chosen.value).toLowerCase(), to: String(chosen.value).toLowerCase(), p: 0, moving: false, source: 'override' };
    } else if (room !== 'house') stage = wakeStage(ctx, room, S, at, stage);
    const block = stage.from === 'lamp' ? stage.to : stage.from;
    const scope = scopeFor(ctx, area, block);
    const lampSaved = saved(ctx, `input_text.ls_lamp_${lamp.split('.')[1]}_${block}`);
    const lampOwn = lampSaved.own === undefined
      ? false
      : requireBoolean(lampSaved.own, `ls_base.saved.${lamp}.${block}.own`);
    const pr = lampOwn ? lampSaved : saved(ctx, `input_text.ls_${scope}_${block}`);
    if (plugs.includes(lamp)) {
      const selectedBlock = !stage.moving || stage.p >= 1 ? stage.to : stage.from;
      const selectedScope = scopeFor(ctx, area, selectedBlock);
      const lp = saved(ctx, `input_text.ls_lamp_${lamp.split('.')[1]}_${selectedBlock}`);
      const src = [`input_boolean.ls_${selectedScope}_${selectedBlock}_on_off`, `input_boolean.ls_house_${selectedBlock}_on_off`].find(e => hasValue(ctx, e));
      const ownsPower = lp.own === undefined
        ? false
        : requireBoolean(lp.own, `ls_base.saved.${lamp}.${selectedBlock}.own`);
      const want = ownsPower
        ? requireBoolean(lp.on, `ls_base.saved.${lamp}.${selectedBlock}.on`)
        : src ? ctx.get(src) === 'on' : null;
      if (!stage.moving && want !== null && ctx.get(lamp) !== (want ? 'on' : 'off')) {
        const service = `homeassistant.turn_${want ? 'on' : 'off'}`;
        const previous = commands.get(service);
        commands.set(service, { kind: 'switch', service, ids: [...(previous?.ids ?? []), lamp] });
      }
      continue;
    }
    const from = sample(ctx, sourceEntity(ctx, lamp, area, stage.from));
    const to = sample(ctx, sourceEntity(ctx, lamp, area, stage.to));
    const target = interpolate(from, to, stage);
    const transition = stage.moving && why === 'tick' ? 60 : 3;
    const color = target.color;
    // `target.brightness` is `number` and `target.on` is `boolean`, so the
    // `?? 1` and `?? false` that used to guard these two reads are unreachable
    // and are dropped rather than left as decoration. Neither ever fired:
    // `??` only catches null/undefined, and `profile`/`interpolate` always
    // produce a number, while `sample` sets `on` from `=== 'on'`. A brightness
    // of 0 kept its 0 before and keeps it now.
    const p: LampProfileEntry = { effect: pr.effect === undefined ? 'Normal light' : pr.effect, brightness: target.brightness, on: target.on, period: block, area: area || null,
      effect_channels: pr.effect_channels === undefined ? ['brightness', 'color'] : pr.effect_channels, send: why !== 'tick' || stage.moving || stage.edge, ignore_overrides: ignored };
    profiles[lamp] = p;
    const command: ScheduleOutput = !target.on ? { kind: 'off', transition } : 'kelvin' in color
      ? { kind: 'ct', brightness: Math.max(target.brightness, 1), kelvin: color.kelvin, transition }
      : { kind: 'rgb', brightness: Math.max(target.brightness, 1), rgb: color.rgb, transition };
    const key = JSON.stringify(command), previous = commands.get(key);
    commands.set(key, { ...command, ids: [...(previous?.ids ?? []), lamp] });
    targets[lamp] = { ...p, is_room: false, brightness: target.on ? Math.max(target.brightness, 1) : target.brightness, color: target.on ? color : { kelvin: 3000 },
      day: profile(ctx, sourceEntity(ctx, lamp, area, 'day', false)), cosy: profile(ctx, sourceEntity(ctx, lamp, area, 'cosy', false)), transition, observed: profile(ctx, lamp) };
    // Scaling first loses the original binary error (0.005 * 100 becomes
    // exactly 0.5). toFixed preserves it; exact binary half-cent values are /8.
    const rounded = Number.isInteger(stage.p * 8) ? roundEven(stage.p * 100) / 100 : Number(stage.p.toFixed(2));
    const debugP = Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
    debug.push(`${lamp} ${room}/${room} ${stage.source} ${stage.from}>${stage.to} p=${debugP} send=True`);
  }
  for (const area of rooms) {
    const S = details[area]!, privateRoom = privateRooms(ctx).includes(area);
    const ignored = Object.keys(records).filter(key => {
      const r = object(records[key]);
      const match = (r.scope === 'room' && r.target === area) || (r.scope === 'house' && !privateRoom) || (key === 'mode:sara' && !privateRoom) || (r.kind === 'block' && r.target === area);
      return expiry && match && timestampOrZero(r.when) <= num(S.last_fs);
    });
    let period: Block = S.cur === null ? DEFAULT_BLOCK : S.cur;
    let stamp = 0, explicit = false;
    const newest = latestRemote(records, area);
    for (const key of Object.keys(records).sort()) {
      const r = object(records[key]);
      if (ignored.includes(key)) continue;
      const match = (r.kind === 'block' && r.target === area) || (['channels', 'input'].includes(String(r.kind)) && ((r.scope === 'room' && r.target === area) || (r.scope === 'house' && !privateRoom)));
      if (!match || (r.scope === 'room' && isRemote(r) && key !== newest)) continue;
      const value = object(r.value), selected = r.kind === 'block' ? r.value : value.period;
      const updated = value.period_updated === undefined ? timestampOrZero(r.when) : num(value.period_updated);
      if (isBlock(selected) && updated >= stamp) { period = selected; stamp = updated; explicit = true; }
    }
    let stage = explicit ? { ...initialStage(S), from: period, to: period, p: 0, moving: false } : wakeStage(ctx, area, S, at, initialStage(S));
    const from = sample(ctx, sourceEntity(ctx, null, area, stage.from, false));
    const to = sample(ctx, sourceEntity(ctx, null, area, stage.to, false));
    const target = interpolate(from, to, stage);
    const pr = saved(ctx, `input_text.ls_${scopeFor(ctx, area, stage.from)}_${stage.from}`);
    // The `!` on brightness/color/on is gone: `interpolate` returns
    // `LampTarget`, where none of the three is optional, so the assertions
    // were asserting something the signature already guaranteed.
    targets[`room:${area}`] = { brightness: target.brightness, color: target.color, area, is_room: true, period: stage.from, effect: pr.effect === undefined ? 'Normal light' : pr.effect, on: target.on,
      day: profile(ctx, sourceEntity(ctx, null, area, 'day', false)), cosy: profile(ctx, sourceEntity(ctx, null, area, 'cosy', false)), ignore_overrides: ignored };
  }
  const stale = Object.keys(records).filter(key => {
    if (!expiry) return false;
    const r = object(records[key]);
    const area = r.kind === 'light' || r.scope === 'lamp' ? ctx.areas[String(r.target)] : String(r.target);
    const scope = rooms.includes(area ?? '') ? area! : 'house';
    const scopes = r.scope === 'house' || key === 'mode:sara' ? rooms.filter(a => !privateRooms(ctx).includes(a)) : [scope];
    return scopes.length > 0 && scopes.every(a => timestampOrZero(r.when) <= num(details[a]!.last_fs) && !details[a]!.fading);
  });
  const sched: Record<string, Block | null> = {}, mirror: ScheduleMirror[] = [];
  for (const scope of ['house', ...rooms]) {
    const S = details[scope]!; sched[scope] = S.cur;
    const override = String(object(records[`block:${scope}`]).value).toLowerCase();
    const effective = isBlock(override) && !stale.includes(`block:${scope}`) ? override : S.cur === null ? DEFAULT_BLOCK : S.cur;
    const option = effective[0]!.toUpperCase() + effective.slice(1), entity = `input_select.ls_${scope}_override`;
    if (ctx.state[entity] && ctx.get(entity) !== option) mirror.push({ entity, option });
  }
  const packed = [...commands.values()].map(command => {
    let ids = command.ids;
    for (const [entity, value] of Object.entries(object(ctx.catalog?.baseline_groups))) {
      const members = strings(value);
      if (members.length > 0 && members.every(member => ids.includes(member))) ids = [entity, ...ids.filter(id => !members.includes(id))];
    }
    return { ...command, ids };
  });
  const schedule: ScheduleEnvelope = { cmds: packed, profiles, revision: ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now, stale_keys: stale, sched, schedule_details: details, mirror,
    sara_mirror: ctx.state['input_boolean.ls_sara_mode_mirror'] && ctx.get('input_boolean.ls_sara_mode_mirror') !== 'off' ? 'off' : null };
  if (args.includeDebug === true) schedule.dbg = debug;
  return { targets, schedule };
}
export const scheduleHandlers: ScriptHandlers = {
  // Captured test_now/overrides are guarded by definition before use; reason
  // and room_only use Undefined-only defaults; debug is definition-tested.
  // Present optional values are parsed, while null overrides retain the
  // producer's explicit "use the state attribute" spelling.
  ls_base: typed('ls_base', {
    parse: args => parseScheduledBaseArgs(
      args,
      'ls_base',
      args.room_only === undefined ? '' : requireString(args, 'room_only', 'ls_base'),
    ),
    run: scheduledBase,
  }),
  // The captured script declaration marks room required, and it drives entity
  // names, comparisons, and indexing rather than iteration or membership.
  ls_room_base: typed('ls_room_base', {
    parse: args => parseScheduledBaseArgs(args, 'ls_room_base', requireString(args, 'room', 'ls_room_base')),
    run: (ctx, args) => scheduledBase(ctx, args, true),
  }),
};
