import type { HouseView } from '../runtime/effects.ts';
import { BLOCKS, DEFAULT_BLOCK, type Block } from './blocks.ts';
import { OFF_END_LEVEL, ramp, roundEven } from './scale.ts';
import { timestamp } from '../parse/accessors.ts';
import { pythonFloatText } from '../runtime/format.ts';
import type { StoredValue } from '../parse/overrides.ts';
import { overridesRevision } from '../parse/sensors.ts';
import { switchRangeEntities } from '../parse/planning.ts';
import {
  entityProfile, entitySample, privateRoomIds, rgbComponent, savedProfile, stateNumber, storedScheduleRecords, wakeInstant,
} from '../parse/schedule.ts';
import type { ScheduleRecord, ScheduleRecords } from '../parse/schedule.ts';
import type { OverlayKey } from './types/overlay.ts';
import { byOverlayKeyText, EMPTY_KEY, overlayKeyText, sameOverlayKey } from './types/overlay.ts';
import type { RoomId } from './types/ids.ts';
import type { RoomOrHouse } from './types/schedule.ts';

export const blocks: readonly string[] = BLOCKS;
/**
 * A lamp's colour as the schedule carries it.
 *
 * `rgb` stays a list of stored values **by design, not by omission**. Home
 * Assistant's `rgb_color` attribute is read raw and handed straight to the
 * command payload, which the parity harness compares byte for byte, so the
 * elements must survive uncoerced. Parsing them into an `RGB` triple here would
 * raise where the oracle passes the value through — a divergence. The elements
 * are coerced only where the captured source coerces them, by
 * `rgbComponent()` inside {@link interpolate}.
 */
export type LampColor = { kelvin: number; rgb?: never } | { rgb: StoredValue[]; kelvin?: never };
/**
 * A light as Home Assistant reports it, and as the schedule decides it: lit
 * with a level (and a colour, when one is reported -- an on light in a
 * brightness-only mode reports none), or off. Off carries neither: off is a
 * state that cannot carry a colour (2026-11-20). A light that is missing or
 * unavailable is not a `LampLight` at all; readers say `undefined`.
 */
export type LampLight = { on: false } | { on: true; brightness: number; color?: LampColor };
/**
 * A {@link LampLight} as a target document spells a scene (`day`, `cosy`) or
 * the observed lamp (`observed`): off is `{on: false}`; lit keeps its
 * `{brightness, color}` spelling with no `on` key, so a lit document is
 * byte-for-byte what it always was. Absent is no key at all.
 */
export type LampProfile = { on: false } | { on?: never; brightness: number; color?: LampColor };
/** A light plus the raw rgb triple {@link interpolate} mixes with, read only for a lit light. */
export type LampSample = { on: false } | { on: true; brightness: number; color?: LampColor; rgb: StoredValue[] | undefined };
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
export function scheduleDetails(view: HouseView, scope: string, at: number): ScheduleDetails {
  const zone = view.timezone ?? 'Europe/Stockholm';
  const [year, month, day] = localParts(at, zone) as [number, number, number];
  let cur: Block | null = null, nxt: Block | null = null;
  let curTs = 0, nextTs = 0, nextFade = 0, lastFs = 0, nextFs = 0;
  for (const off of [-2, -1, 0, 1]) {
    const eve = new Date(Date.UTC(year, month - 1, day + off));
    for (const block of BLOCKS) {
      const src = scope === 'house' || view.get(`input_boolean.ls_${scope}_${block}_own_timing`) === 'on' ? scope : 'house';
      const isDay = block === 'day';
      const weekday = (eve.getUTCDay() + (isDay ? 1 : 0)) % 7;
      const weekend = isDay ? [6, 0].includes(weekday) : [5, 6].includes(weekday);
      const time = view.get(`input_datetime.ls_${src}_${block}_${weekend ? 'weekend' : 'start'}`);
      if (!/^\d\d:\d\d/.test(time)) continue;
      const hour = Number(time.slice(0, 2)), minute = Number(time.slice(3, 5));
      if (hour > 23 || minute > 59) continue;
      const ts = localTime(eve.getUTCFullYear(), eve.getUTCMonth() + 1, eve.getUTCDate() + (isDay || hour < 12 ? 1 : 0), hour, minute, zone);
      const fade = stateNumber(view, `input_number.ls_${src}_${block}_fade`, 20) * 60;
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
/** One `input_select` the schedule wants moved to match the effective block. */
export type ScheduleMirror = { entity: string; option: string };
/**
 * One output the schedule decided on, before the lamps that share it are
 * attached. Discriminated on `kind`.
 *
 * `rgb` is a list of stored values and must stay so: it comes off
 * `LampColor`, which `entityProfile` fills from the `rgb_color` attribute --
 * a raw Home Assistant value that is handed into compared JSON unchanged. Narrowing
 * it to the three-element `RGB` would be a projection, and it is also simply
 * not what the attribute guarantees. `kelvin` is a real number because
 * `interpolate` computes it.
 */
export type ScheduleOutput =
  | { kind: 'off'; transition: number }
  /** A lit lamp whose scene reports no colour: its level only. */
  | { kind: 'brightness'; brightness: number; transition: number }
  | { kind: 'ct'; brightness: number; kelvin: number; transition: number }
  | { kind: 'rgb'; brightness: number; rgb: StoredValue[]; transition: number };
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
 * - `revision` is `string`: the sensor's `last_updated`, read bare as the
 *   captured source reads it, so a missing sensor raises (`overridesRevision`).
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
 * `effect` and `effect_channels` are stored values: both come from a saved
 * `input_text` document (`savedProfile`), and both are handed on untouched -- `ls_store` round-trips `effect_channels` and
 * `effects_ui_sync` reads `effect` back out. The `=== undefined` defaults are
 * absence-only on purpose; a stored null is not the same as a missing key.
 *
 * `area` is `RoomId | null` because the source writes `area || null`, turning
 * a lamp with no area (or the empty area id) into an explicit null: the
 * lamp's room, or null when it is in none.
 */
export type LampProfileEntry = { effect: StoredValue } & ProfileLevel & {
  period: string;
  area: RoomId | null;
  /** As stored, or both channels when the profile names none. */
  effect_channels: StoredValue | string[];
  send: boolean;
  ignore_overrides: string[];
};

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A scheduled lamp's level, as `schedule.profiles` carries it: an off lamp has none. */
export type ProfileLevel = { on: false } | { brightness: number; on: true };
/**
 * A lamp's entry in `targets`: its profile plus what the renderer needs.
 * `color` is a `LampColor`, so its `rgb` arm is still raw -- see
 * {@link ScheduleOutput}. An off target has no `brightness` and no `color`;
 * a lit one has `color` when its scene reports one. `day`, `cosy` and
 * `observed` are absent when the light behind them is missing or unavailable.
 */
export type LampTargetEntry = LampProfileEntry & ({ on: false } | { on: true; color?: LampColor }) & {
  is_room: false;
  day?: LampProfile;
  cosy?: LampProfile;
  transition: number;
  observed?: LampProfile;
};
/**
 * A room's entry in `targets`. **Not** a superset or subset of the lamp entry:
 * it has no `send`, `transition` or `observed`, and it carries `area` as its
 * room rather than a nullable one. Keeping them as two members of a
 * union rather than one optional-heavy shape is what stops a reader assuming
 * a field exists on both.
 */
export type RoomTargetEntry = ({ on: false } | { on: true; brightness: number; color?: LampColor }) & {
  area: RoomId;
  is_room: true;
  period: string;
  effect: StoredValue;
  day?: LampProfile;
  cosy?: LampProfile;
  ignore_overrides: string[];
};
export type TargetEntry = LampTargetEntry | RoomTargetEntry;
export type ScheduledBase = {
  targets: Record<string, TargetEntry>;
  schedule: ScheduleEnvelope;
};
/** The override a lamp follows: the block it names, if any, and its record's `when`. */
type Chosen = { present: boolean; block: Block | undefined; when: () => number };
export interface ScheduledBaseRequest {
  testNow: number | undefined;
  reason: string;
  overrides: ScheduleRecords | undefined;
  /** The one room to plan; none when the request names none or `''` (captured `default('')`). */
  roomOnly: RoomId | undefined;
  includeDebug: boolean;
}
export function nextMidnight(at: number, timezone: string): number {
  const [year, month, day] = localParts(at, timezone) as [number, number, number];
  return localTime(year, month, day + 1, 0, 0, timezone);
}
export function localParts(at: number, timezone: string): number[] {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
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
export function scheduledBase(view: HouseView, args: ScheduledBaseRequest, roomLocal = false): ScheduledBase {
  const at = args.testNow === undefined ? timestamp(view.now) : args.testNow;
  const why = args.reason;
  const records = args.overrides === undefined
    ? storedScheduleRecords(view.attr('sensor.ls_overrides', 'overrides'))
    : args.overrides;
  const keys = records.keys, sortedKeys = [...keys].sort(byOverlayKeyText);
  const expiry = view.get('input_boolean.ls_ovr_next_block_on') === 'on';
  const dimmables = labelled(view, 'house_schedule').filter(e => e.startsWith('light.'));
  const plugs = labelled(view, 'on_off').filter(e => /^(light|switch)\./.test(e));
  const all = [...dimmables, ...plugs, ...switchRangeEntities(view.attr('sensor.ls_overrides', 'switch_ranges'))];
  const roomOnly = args.roomOnly;
  const rooms: RoomId[] = [...new Set(all.map(e => view.rooms.ofId[e]).filter(isAreaId))].sort()
    .filter(a => roomOnly === undefined || roomOnly === a);
  const details = Object.fromEntries(['house', ...rooms].map(room => [room, scheduleDetails(view, room, at)])) as Record<string, ScheduleDetails>;
  const profiles: Record<string, LampProfileEntry> = {}, targets: Record<string, TargetEntry> = {}, commands = new Map<string, ScheduleCommand>();
  const debug: string[] = [];
  for (const lamp of [...dimmables, ...plugs]) {
    if (roomOnly !== undefined && (!roomLocal || view.rooms.ofId[lamp] !== roomOnly)) continue;
    if (roomLocal && !dimmables.includes(lamp)) continue;
    // A lamp the registry places in no room, or in the empty area id, is in no room and follows the house.
    const placed = view.rooms.ofId[lamp];
    const area = isAreaId(placed) ? placed : undefined;
    const room: RoomOrHouse = area !== undefined && rooms.includes(area) ? area : 'house';
    const S = details[room]!;
    const privateRoom = isPrivateRoom(view, area);
    const newest = latestRemote(records, room);
    const blockRecord = records.get({ kind: 'block', scope: room });
    // The block override, or the newest applying period claim. Its `when` is
    // read through the record it came from, so it raises where it did.
    let chosen: Chosen = { present: blockRecord.present, block: blockRecord.valueFolded, when: blockRecord.when };
    let chosenStamp = chosen.when();
    for (const key of sortedKeys) {
      const r = records.get(key);
      if (!isClaim(r) || !applies(r, key, lamp, room, privateRoom)) continue;
      if (r.scope === 'room' && isRemote(r) && !sameOverlayKey(key, newest)) continue;
      const stamp = r.periodStamp();
      if (r.period !== undefined && stamp >= chosenStamp && !(expiry && r.when() <= S.last_fs)) {
        const period = r.period;
        chosen = { present: true, block: period, when: r.when }; chosenStamp = stamp;
      }
    }
    if (expiry && !S.fading && chosen.when() <= S.last_fs) chosen = NOTHING_CHOSEN;
    const ignored = sortedKeys.filter(key => expiry && applies(records.get(key), key, lamp, room, privateRoom) &&
      records.get(key).when() <= S.last_fs);
    let stage = initialStage(S);
    if (S.fading && (ignored.length || (chosen.present && chosen.when() <= S.last_fs))) {
      // `String(S.nxt)`: fading implies a next block, so the null arm is unreachable.
      stage = { from: 'lamp', to: S.nxt === null ? 'null' : S.nxt, p: Math.min(1, (why === 'tick' ? 60 : 3) / Math.max(S.left, 1)),
        moving: true, edge: false, source: 'fadeout' };
    } else if (chosen.block !== undefined) {
      stage = { ...stage, from: chosen.block, to: chosen.block, p: 0, moving: false, source: 'override' };
    } else if (room !== 'house') stage = wakeStage(view, room, S, at, stage);
    const block = stage.from === 'lamp' ? stage.to : stage.from;
    const scope = scopeFor(view, area, block);
    const lampSaved = savedProfile(view, `input_text.ls_lamp_${lampObjectId(lamp)}_${block}`);
    const pr = lampSaved.own ? lampSaved : savedProfile(view, `input_text.ls_${scope}_${block}`);
    if (plugs.includes(lamp)) {
      const selectedBlock = !stage.moving || stage.p >= 1 ? stage.to : stage.from;
      const selectedScope = scopeFor(view, area, selectedBlock);
      const lp = savedProfile(view, `input_text.ls_lamp_${lampObjectId(lamp)}_${selectedBlock}`);
      const src = [`input_boolean.ls_${selectedScope}_${selectedBlock}_on_off`, `input_boolean.ls_house_${selectedBlock}_on_off`].find(e =>
        hasValue(view, e));
      const want = lp.own
        ? lp.on
        : src ? view.get(src) === 'on' : null;
      if (!stage.moving && want !== null && view.get(lamp) !== (want ? 'on' : 'off')) {
        const service = `homeassistant.turn_${want ? 'on' : 'off'}`;
        const previous = commands.get(service);
        commands.set(service, { kind: 'switch', service, ids: [...(previous?.ids ?? []), lamp] });
      }
      continue;
    }
    const from = entitySample(view, sourceEntity(view, lamp, area, stage.from));
    const to = entitySample(view, sourceEntity(view, lamp, area, stage.to));
    const target = interpolate(from, to, stage);
    const transition = stage.moving && why === 'tick' ? 60 : 3;
    // An off target has no level: the entry, the command and the target say off
    // and nothing else (no invented 255, no 3000 K).
    const level: ProfileLevel = target.on ? { brightness: target.brightness, on: true } : { on: false };
    const p: LampProfileEntry = { effect: pr.effect === undefined ? 'Normal light' : pr.effect, ...level, period: block,
      area: area === undefined ? null : area, effect_channels: pr.effectChannels === undefined ? ['brightness', 'color'] : pr.effectChannels,
      send: why !== 'tick' || stage.moving || stage.edge, ignore_overrides: ignored.map(overlayKeyText) };
    profiles[lamp] = p;
    const command: ScheduleOutput = !target.on ? { kind: 'off', transition }
      : target.color === undefined ? { kind: 'brightness', brightness: Math.max(target.brightness, 1), transition }
        : target.color.kelvin !== undefined ? { kind: 'ct', brightness: Math.max(target.brightness, 1), kelvin: target.color.kelvin, transition }
          : { kind: 'rgb', brightness: Math.max(target.brightness, 1), rgb: target.color.rgb, transition };
    const key = JSON.stringify(command), previous = commands.get(key);
    commands.set(key, { ...command, ids: [...(previous?.ids ?? []), lamp] });
    const lit = !target.on ? {} : target.color === undefined ? { brightness: Math.max(target.brightness, 1) }
      : { brightness: Math.max(target.brightness, 1), color: target.color };
    // A scene or lamp that is missing or unavailable has no reading: no key.
    const day = entityProfile(view, sourceEntity(view, lamp, area, 'day', false));
    const cosy = entityProfile(view, sourceEntity(view, lamp, area, 'cosy', false)), observed = entityProfile(view, lamp);
    targets[lamp] = { ...p, is_room: false, ...lit, ...(day === undefined ? {} : { day }), ...(cosy === undefined ? {} : { cosy }), transition,
      ...(observed === undefined ? {} : { observed }) };
    // Scaling first loses the original binary error (0.005 * 100 becomes
    // exactly 0.5). toFixed preserves it; exact binary half-cent values are /8.
    const rounded = Number.isInteger(stage.p * 8) ? roundEven(stage.p * 100) / 100 : Number(stage.p.toFixed(2));
    const debugP = pythonFloatText(rounded);
    debug.push(`${lamp} ${room}/${room} ${stage.source} ${stage.from}>${stage.to} p=${debugP} send=True`);
  }
  for (const area of rooms) {
    const S = details[area]!, privateRoom = isPrivateRoom(view, area);
    const ignored = keys.filter(key => {
      const r = records.get(key);
      const match = (r.scope === 'room' && r.target === area) || (r.scope === 'house' && !privateRoom) || (key.kind === 'sara mode' &&
        !privateRoom) || (r.kind === 'block' && r.target === area);
      return expiry && match && r.when() <= S.last_fs;
    });
    let period: Block = S.cur === null ? DEFAULT_BLOCK : S.cur;
    let stamp = 0, explicit = false;
    const newest = latestRemote(records, area);
    for (const key of sortedKeys) {
      const r = records.get(key);
      if (ignored.some(other => sameOverlayKey(other, key))) continue;
      const match = (r.kind === 'block' && r.target === area) || (isClaim(r) && ((r.scope === 'room' &&
        r.target === area) || (r.scope === 'house' && !privateRoom)));
      if (!match || (r.scope === 'room' && isRemote(r) && !sameOverlayKey(key, newest))) continue;
      const selected = r.kind === 'block' ? r.valueBlock : r.period;
      const updated = r.periodStamp();
      if (selected !== undefined && updated >= stamp) { period = selected; stamp = updated; explicit = true; }
    }
    let stage = explicit ? { ...initialStage(S), from: period, to: period, p: 0, moving: false } : wakeStage(view, area, S, at, initialStage(S));
    const from = entitySample(view, sourceEntity(view, null, area, stage.from, false));
    const to = entitySample(view, sourceEntity(view, null, area, stage.to, false));
    const target = interpolate(from, to, stage);
    const pr = savedProfile(view, `input_text.ls_${scopeFor(view, area, stage.from)}_${stage.from}`);
    // An off room carries no level and no colour, like an off lamp.
    const room = { area, is_room: true as const, period: stage.from, effect: pr.effect === undefined ? 'Normal light' : pr.effect };
    const day = entityProfile(view, sourceEntity(view, null, area, 'day', false));
    const cosy = entityProfile(view, sourceEntity(view, null, area, 'cosy', false));
    const scenes = { ...(day === undefined ? {} : { day }), ...(cosy === undefined ? {} : { cosy }), ignore_overrides: ignored.map(overlayKeyText) };
    targets[`room:${area}`] = !target.on ? { ...room, on: false, ...scenes }
      : target.color === undefined ? { brightness: target.brightness, ...room, on: true, ...scenes }
        : { brightness: target.brightness, color: target.color, ...room, on: true, ...scenes };
  }
  // Read as text: a record's target is any saved text, looked up among the rooms.
  const roomTexts: readonly string[] = rooms;
  const stale = keys.filter(key => {
    if (!expiry) return false;
    const r = records.get(key);
    const target = r.targetName;
    const area = target === undefined ? undefined : r.kind === 'light' || r.scope === 'lamp' ? view.rooms.ofId[target] : target;
    const scope = roomTexts.includes(area ?? '') ? area! : 'house';
    const scopes = r.scope === 'house' || key.kind === 'sara mode' ? rooms.filter(a => !isPrivateRoom(view, a)) : [scope];
    return scopes.length > 0 && scopes.every(a => r.when() <= details[a]!.last_fs && !details[a]!.fading);
  });
  const sched: Record<string, Block | null> = {}, mirror: ScheduleMirror[] = [];
  for (const scope of ['house', ...rooms]) {
    const S = details[scope]!; sched[scope] = S.cur;
    const blockKey: OverlayKey = { kind: 'block', scope };
    const override = records.get(blockKey).valueFolded;
    const effective = override !== undefined && !stale.some(key => sameOverlayKey(key, blockKey)) ? override : S.cur === null ? DEFAULT_BLOCK : S.cur;
    const option = effective[0]!.toUpperCase() + effective.slice(1), entity = `input_select.ls_${scope}_override`;
    if (view.state[entity] && view.get(entity) !== option) mirror.push({ entity, option });
  }
  const packed = [...commands.values()].map(command => {
    let ids = command.ids;
    // The parsed catalog's groups are already string lists, so the `strings()`
    // and `object()` that used to re-read them here only copied them.
    for (const [entity, members] of Object.entries(view.catalog.baseline_groups)) {
      if (members.length > 0 && members.every(member => ids.includes(member))) ids = [entity, ...ids.filter(id => !members.includes(id))];
    }
    return { ...command, ids };
  });
  const schedule: ScheduleEnvelope = { cmds: packed, profiles, revision: overridesRevision(view, roomLocal ? 'ls_room_base' : 'ls_base'),
    stale_keys: stale.map(overlayKeyText), sched, schedule_details: details, mirror,
    sara_mirror: view.state['input_boolean.ls_sara_mode_mirror'] !== undefined && view.get('input_boolean.ls_sara_mode_mirror') !== 'off' ?
      'off' : null };
  if (args.includeDebug === true) schedule.dbg = debug;
  return { targets, schedule };
}
export function labelled(view: HouseView, label: string): string[] {
  // Registry snapshots supply label members, including device-expanded entities.
  const entities = view.labels?.[label] ?? (label === 'house_schedule' ? view.members : []);
  return [...new Set(entities.flatMap(e => view.devices?.[e] ?? [e]))];
}
export function isAreaId<Room extends string>(value: Room | undefined): value is Room { return value !== undefined && value.length > 0; }
/**
 * Is this room one of the private rooms? A lamp in no room is private only
 * when the list names the empty room, as the scripts' `area_id(L) or ''`
 * lookup reads it.
 */
function isPrivateRoom(view: HouseView, room: RoomId | undefined): boolean {
  const rooms: readonly string[] = privateRooms(view);
  return room === undefined ? rooms.includes('') : rooms.includes(room);
}
export function privateRooms(view: HouseView): RoomId[] { return privateRoomIds(view); }

export function latestRemote(records: ScheduleRecords, room: RoomOrHouse): OverlayKey {
  // The scripts start from the empty key and keep it when no remote record applies.
  let key: OverlayKey = EMPTY_KEY, stamp = -1;
  for (const k of [...records.keys].sort(byOverlayKeyText)) {
    const r = records.get(k);
    if (r.scope !== 'room' || r.target !== room || !isRemote(r)) continue;
    const ts = r.when();
    if (ts >= stamp) { key = k; stamp = ts; }
  }
  return key;
}
export function isRemote(r: ScheduleRecord): boolean { return r.kind === 'input' || (r.kind === 'channels' && r.via === 'remote'); }
/** The captured `kind in ['channels','input']`, compared as stored. */
function isClaim(r: ScheduleRecord): boolean { return r.kind === 'channels' || r.kind === 'input'; }
function applies(r: ScheduleRecord, key: OverlayKey, lamp: string | null, room: string, privateRoom: boolean): boolean {
  return (r.kind === 'light' && r.target === lamp && lamp !== null)
    || (isClaim(r) && ((r.scope === 'lamp' && lamp !== null && r.target === lamp) ||
      (r.scope === 'room' && r.target === room) || (r.scope === 'house' && !privateRoom)))
    || (key.kind === 'sara mode' && !privateRoom);
}
function initialStage(S: ScheduleDetails): Stage {
  const cur = S.cur === null ? DEFAULT_BLOCK : S.cur;
  const next = S.fading ? S.nxt : S.cur;
  // `S.p` is computed finite by `scheduleDetails`, so the `num()` that used to
  // re-read it here could never raise or change it.
  return { from: cur, to: next === null ? DEFAULT_BLOCK : next, p: S.p, moving: S.fading, edge: S.edge, source: 'schedule' };
}
function wakeStage(view: HouseView, area: string, S: ScheduleDetails, at: number, stage: Stage): Stage {
  const entity = `input_datetime.ls_${area}_wake`;
  const wake = hasValue(view, entity) ? wakeInstant(view, entity) : undefined;
  if (wake === undefined) return stage;
  const duration = stateNumber(view, `input_number.ls_${area}_wake_fade`, 37.5) * 60;
  const elapsed = at - wake;
  if (S.cur !== 'night' || S.cur_ts > wake) return stage;
  if (elapsed >= 0 && elapsed < duration) return { ...stage, from: 'night', to: 'day', p: elapsed / duration, moving: true, source: 'wake' };
  const hour = localParts(wake, view.timezone ?? 'Europe/Stockholm')[3]!;
  // This is the deployed completed-wake hold, separate from the alarm's 05–12 input window.
  if (elapsed >= duration && elapsed < 86400 && hour >= 4 && hour < 11 && (!S.fading || S.nxt === 'day')) {
    return { from: 'day', to: 'day', p: 0, moving: false, edge: elapsed - duration < 90, source: 'wake' };
  }
  return stage;
}
export function hasValue(view: HouseView, entity: string): boolean { return !['unknown', 'unavailable'].includes(view.get(entity)); }
/** The room's own light when it has one on for the block; the house's otherwise, and for a lamp in no room. */
function scopeFor(view: HouseView, area: RoomId | undefined, block: string): string { return area !== undefined &&
  view.get(`input_boolean.ls_${area}_${block}_own_light`) === 'on' ? area : 'house'; }
/**
 * A lamp's object id, captured `lamp.split('.')[1]`: the text after its domain,
 * up to any further dot. The schedule's lamps are filtered to `light.` and
 * `switch.` ids, so the part is always there; an id without it is not a lamp.
 */
function lampObjectId(lamp: string): string {
  const [, objectId] = lamp.split('.');
  if (objectId === undefined) throw new Error(`schedule lamp ${lamp} has no object id`);
  return objectId;
}
function sourceEntity(view: HouseView, lamp: string | null, area: RoomId | undefined, block: string, fallback = true): string {
  if (block === 'lamp' && lamp) return lamp;
  const scope = scopeFor(view, area, block);
  const lampProfile = lamp === null ? undefined : savedProfile(view, `input_text.ls_lamp_${lampObjectId(lamp)}_${block}`);
  const own = lampProfile === undefined ? false : lampProfile.own;
  const candidates = [...(own && lamp !== null ? [`light.ls_lamp_${lampObjectId(lamp)}_${block}`] : []), `light.ls_${scope}_${block}`,
    ...(fallback ? [`light.ls_house_${block}`] : [])];
  return (fallback ? candidates.find(e => hasValue(view, e)) : candidates[0]) ?? candidates[0]!;
}

/**
 * The light part way through a stage. Off -> on switches the lamp on at
 * {@link OFF_END_LEVEL} in the lit end's colour and ramps the level up to the
 * lit end's over the stage (the remote blend's {@link ramp}, rounded); on -> off
 * dims the lit end towards level 1 and switches off when the stage ends; on -> on
 * mixes level and colour. Both off, or not moving: the destination.
 *
 * Divergence from today's scripts, named (2026-11-20, "Scheduled fades are
 * gradual in both directions"): they jump an off -> on fade straight to the lit
 * end. Unlike the remote blend, which is off AT its off end, a moving fade is lit
 * from p = 0, mirroring on -> off staying lit until the stage ends.
 */
function interpolate(A: LampSample, B: LampSample, stage: Stage): LampLight {
  if (!stage.moving) return lightOf(B);
  if (!A.on) {
    if (!B.on) return lightOf(B);
    const brightness = Math.max(OFF_END_LEVEL, roundEven(ramp(B.brightness, stage.p)));
    return B.color === undefined ? { on: true, brightness } : { on: true, brightness, color: B.color };
  }
  if (!B.on) return { ...lightOf(A), on: true, brightness: Math.max(1, roundEven(A.brightness * (1 - stage.p))) };
  const color = mixedColour(A, B, stage.p), brightness = roundEven(A.brightness + (B.brightness - A.brightness) * stage.p);
  return color === undefined ? { on: true, brightness } : { on: true, brightness, color };
}
const NOTHING_CHOSEN: Chosen = { present: false, block: undefined, when: () => 0 };

/** A sample's light, without the rgb it carried for mixing. */
function lightOf(sample: LampSample): LampLight {
  if (!sample.on) return { on: false };
  return sample.color === undefined ? { on: true, brightness: sample.brightness }
    : { on: true, brightness: sample.brightness, color: sample.color };
}
/**
 * The colour part way between two lit samples. Two colour temperatures mix in
 * kelvin; otherwise the reported rgb triples mix. An end that reports no colour
 * (or no rgb to mix in) gives the fade nothing to mix from: it shows the colour
 * there is, the destination's first.
 */
function mixedColour(A: Extract<LampSample, { on: true }>, B: Extract<LampSample, { on: true }>, p: number): LampColor | undefined {
  const a = A.color, b = B.color, ra = A.rgb, rb = B.rgb;
  if (a !== undefined && b !== undefined && a.kelvin !== undefined && b.kelvin !== undefined) {
    return { kelvin: roundEven(a.kelvin + (b.kelvin - a.kelvin) * p) };
  }
  if (a !== undefined && b !== undefined && ra !== undefined && rb !== undefined) {
    return { rgb: [0, 1, 2].map(i => roundEven(rgbComponent(ra, i) + (rgbComponent(rb, i) - rgbComponent(ra, i)) * p)) };
  }
  return b !== undefined ? b : a;
}
