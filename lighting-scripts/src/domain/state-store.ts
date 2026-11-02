import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaString, jinjaTruthy, ParseError, requireArray, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { isObject, object } from './scale.ts';
import { recordTimestamp } from './resolution.ts';
import { isAreaId, labelled, privateRooms } from './schedule.ts';

const values = (value: JsonValue | undefined): JsonValue[] => Array.isArray(value) ? value : [];

interface CommitRecord {
  raw: JsonObject;
  key: JsonValue;
  keyContext: string;
  writeKey: () => string;
  kind: JsonValue | undefined;
  scope: JsonValue | undefined;
  target: JsonValue | undefined;
  value: JsonValue | undefined;
  channelClaims: () => Array<[string, JsonObject]>;
}
interface CommitData {
  raw: JsonObject;
  op: JsonValue;
  records: CommitRecord[];
  via: JsonValue | undefined;
  who: JsonValue;
  area: JsonValue | undefined;
  clearContains: () => (key: string) => boolean;
  power: () => { area: string; on: boolean };
  range: () => { entity: string; profile: JsonValue; min: JsonValue; max: JsonValue } | undefined;
  ranges: () => JsonObject | undefined;
  remoteAck: () => { source: string; requestId: JsonValue } | undefined;
  full: () => { reason: JsonValue; lights: JsonValue[] };
}
interface CommitArgs {
  expectedRevision: JsonValue | undefined;
  details: () => CommitData;
}
interface OverrideBlockArgs { scope: JsonValue | undefined; block: string; via: JsonValue }
interface ViaArgs { via: JsonValue }

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

/** Jinja `~` uses an empty string for Undefined, unlike the `| string` filter. */
function concatString(value: JsonValue | undefined): string {
  return value === undefined ? '' : jinjaString(value);
}

/** Python mappings reject the unhashable JSON container types as keys. */
function jinjaMappingGet(record: JsonObject, key: JsonValue | undefined, context: string): JsonValue | undefined {
  if (Array.isArray(key) || isObject(key)) {
    throw new ParseError(`${context} is unhashable for Jinja mapping lookup`);
  }
  return typeof key === 'string' ? record[key] : undefined;
}

/** Home Assistant's custom `| bool` filter, measured from the pinned oracle. */
function haBoolean(value: JsonValue | undefined, context: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isNaN(value) ? true : value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', 'enable'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'disable'].includes(normalized)) return false;
  }
  throw new ParseError(`${context} is not accepted by Home Assistant's bool filter`);
}

function parseRecords(value: JsonValue | undefined, context: string): CommitRecord[] {
  // The source iterates its `get(..., [])` result. Empty strings/mappings are
  // empty iterations; any non-empty non-array reaches `.get()` and raises.
  if (value === undefined || value === '' || isObject(value) && !Object.keys(value).length) return [];
  const rawRecords = requireArray({ value: value ?? null }, 'value', context);
  return rawRecords.map((raw, index) => {
    const recordContext = `${context}[${index}]`;
    const record = requireObject({ raw }, 'raw', recordContext);
    // `dict.get('key', fallback)` evaluates this concat even when key exists,
    // but only falls back for an absent key (explicit null must not fall back).
    const fallbackKey = `${concatString(record.kind)}:${concatString(record.source === undefined ? record.target : record.source)}`;
    const key = record.key === undefined ? fallbackKey : record.key;
    const value = record.value;
    return {
      raw: record,
      key,
      keyContext: `${recordContext}.key`,
      writeKey: lazy(() => record.key === undefined ? fallbackKey : requireString(record, 'key', recordContext)),
      kind: record.kind,
      scope: record.scope,
      target: record.target,
      value,
      channelClaims: lazy(() => {
        if (!isObject(value)) return [];
        const channels = value.channels === undefined ? {} : requireObject(value, 'channels', `${recordContext}.value`);
        return Object.entries(channels).map(([channel, claim]) => [
          channel,
          requireObject({ claim }, 'claim', `${recordContext}.value.channels.${channel}`),
        ]);
      }),
    };
  });
}

function membership(value: JsonValue | undefined, context: string): (key: string) => boolean {
  const container = value === undefined ? [] : value;
  if (Array.isArray(container)) return key => container.includes(key);
  if (typeof container === 'string') return key => container.includes(key);
  if (isObject(container)) return key => Object.hasOwn(container, key);
  throw new ParseError(`${context} must support Jinja membership`);
}

function testedNumber(value: JsonValue | undefined): { raw: number | boolean; numeric: number } | undefined {
  if (typeof value === 'boolean') return { raw: value, numeric: value ? 1 : 0 };
  if (typeof value === 'number') return { raw: value, numeric: value };
  return undefined;
}

function validRangePair(value: JsonValue | undefined, context: string): value is JsonValue[] {
  // Jinja's `sequence` test accepts strings and mappings. They simply fail the
  // length test unless length is two; at length two, numeric comparison raises.
  if (typeof value === 'string' || isObject(value)) {
    if ((typeof value === 'string' ? value.length : Object.keys(value).length) !== 2) return false;
    throw new ParseError(`${context} sequence elements cannot be compared with numeric bounds`);
  }
  if (!Array.isArray(value) || value.length !== 2) return false;
  const low = testedNumber(value[0]), high = testedNumber(value[1]);
  if (low === undefined || high === undefined) {
    throw new ParseError(`${context} sequence elements cannot be compared with numeric bounds`);
  }
  return 0 <= low.numeric && low.numeric <= high.numeric && high.numeric <= 100;
}

function parseCommitData(data: JsonObject): CommitData {
  const records = parseRecords(data.records, 'ls_commit.data.records');
  const via = data.via;
  return {
    raw: data,
    op: data.op === undefined ? 'set' : data.op,
    records,
    via,
    who: jinjaTruthy(data.who) ? data.who! : null,
    area: data.area,
    clearContains: lazy(() => membership(data.keys, 'ls_commit.data.keys')),
    power: lazy(() => ({
      area: requireString(data, 'area', 'ls_commit.data'),
      on: haBoolean(data.on, 'ls_commit.data.on'),
    })),
    range: lazy(() => {
      const profile = data.profile;
      if (profile === 'bright' || profile === 'cosy') {
        return { entity: requireString(data, 'entity', 'ls_commit.data'), profile, min: null, max: null };
      }
      if (profile !== 'custom') return undefined;
      const min = testedNumber(data.min), max = testedNumber(data.max);
      if (min === undefined || max === undefined || min.numeric < 0 || min.numeric > max.numeric || max.numeric > 100) return undefined;
      return { entity: requireString(data, 'entity', 'ls_commit.data'), profile, min: min.raw, max: max.raw };
    }),
    ranges: lazy(() => {
      const ranges = data.ranges === undefined ? {} : requireObject(data, 'ranges', 'ls_commit.data');
      return validRangePair(ranges.bright, 'ls_commit.data.ranges.bright') && validRangePair(ranges.cosy, 'ls_commit.data.ranges.cosy') ? ranges : undefined;
    }),
    remoteAck: lazy(() => {
      if (via !== 'remote' || !jinjaTruthy(data.source) || !jinjaTruthy(data.request_id)) return undefined;
      return { source: requireString(data, 'source', 'ls_commit.data'), requestId: data.request_id! };
    }),
    full: lazy(() => ({
      reason: data.reason === undefined ? (via === 'remote' ? 'remote' : 'config') : data.reason,
      lights: data.lights === undefined ? [] : requireArray(data, 'lights', 'ls_commit.data'),
    })),
  };
}

/** The single override writer, preserving unrelated attributes and channel timestamps. */
export function commit(ctx: ScriptContext, args: CommitArgs): JsonObject {
  const entity = 'sensor.ls_overrides';
  const currentRevision = ctx.state[entity]?.last_updated ?? ctx.now;
  if (args.expectedRevision != null && args.expectedRevision !== currentRevision) return { accepted: false };
  const parsed = args.details(), data = parsed.raw;
  const before = object(ctx.attr(entity, 'overrides'));
  let overrides = structuredClone(before);
  let patch: JsonObject = {};
  const op = parsed.op;
  if (op === 'clear_all') overrides = {};
  else if (op === 'clear') {
    const contains = parsed.clearContains();
    overrides = Object.fromEntries(Object.entries(before).filter(([key]) => !contains(key)));
  }
  else if (op === 'clear_room') overrides = Object.fromEntries(Object.entries(before).filter(([, raw]) => {
    const r = object(raw), targetArea = typeof r.target === 'string' ? ctx.areas[r.target] : undefined;
    return !(r.scope === 'room' && r.target === parsed.area || (r.scope === 'lamp' || r.kind === 'light') && targetArea === parsed.area || r.kind === 'block' && r.target === parsed.area);
  }));
  else if (op === 'set') for (const record of parsed.records) {
    const key = record.writeKey(), old = object(overrides[key]);
    let value = record.value === undefined ? null : record.value;
    if (record.kind === 'channels' && isObject(value)) {
      const prior = object(old.value);
      const channels = { ...object(prior.channels) };
      for (const [channel, raw] of record.channelClaims()) {
        const claim = { ...raw }, previous = object(channels[channel]);
        if (claim.kind === 'effect' && !Object.hasOwn(claim, 'underlying')) {
          const underlying = ['constant', 'scale'].includes(String(previous.kind)) ? previous : previous.underlying;
          if (isObject(underlying)) claim.underlying = underlying;
        }
        channels[channel] = claim;
      }
      value = { ...prior, ...value, channels };
    }
    overrides[key] = { ...record.raw, value, when: ctx.now, created: old.created ?? old.when ?? ctx.now, who: parsed.who, via: parsed.via ?? null };
  }
  else if (op === 'power') {
    const power = parsed.power();
    patch.power = { ...object(ctx.attr(entity, 'power')), [power.area]: power.on };
  }
  else if (op === 'range_set') {
    const range = parsed.range();
    if (range) patch.switch_ranges = { ...object(ctx.attr(entity, 'switch_ranges')), [range.entity]: range.profile === 'custom' ? { profile: 'custom', min: range.min, max: range.max } : { profile: range.profile } };
  } else if (op === 'range_defaults') {
    const ranges = parsed.ranges();
    if (ranges) patch.range_defaults = ranges;
  }
  const remoteAck = parsed.remoteAck();
  if (remoteAck) patch.remote_ack = { ...object(ctx.attr(entity, 'remote_ack')), [remoteAck.source]: remoteAck.requestId };
  patch = { ...patch, overrides, last_via: parsed.via ?? null };
  const pending = { ...object(ctx.attr(entity, 'pending_rooms')) };
  const affected: Array<JsonValue | undefined> = [];
  if (jinjaTruthy(parsed.area)) affected.push(parsed.area);
  for (const record of parsed.records) for (const item of [
    object(jinjaMappingGet(before, record.key, record.keyContext)),
    record.raw,
  ]) {
    if (item.scope === 'room') affected.push(item.target);
  }
  for (const [index, room] of affected.entries()) {
    pending[requireString({ room: room ?? null }, 'room', `ls_commit affected[${index}]`)] = ctx.now;
  }
  patch = { ...patch, pending_rooms: pending, last_request: ctx.now,
    received_at: data.received_at === undefined ? recordTimestamp(ctx.now) : data.received_at };
  const full = parsed.via !== 'remote' || ['render_request', 'clear', 'clear_all'].includes(typeof data.op === 'string' ? data.op : '') || parsed.records.some(r => r.kind === 'mode');
  if (full) {
    const unhandled = ctx.attr(entity, 'full_version') !== (ctx.attr('sensor.ls_effects_runtime', 'handled_full') || null);
    const previousLights = unhandled ? values(ctx.attr(entity, 'full_lights')) : [];
    const previousReason = unhandled ? ctx.attr(entity, 'full_reason') : null;
    const fullData = parsed.full();
    let reason = fullData.reason;
    if (reason === 'tick' && previousReason && previousReason !== 'tick') reason = 'config';
    patch = { ...patch, full_version: ctx.now, full_reason: reason, full_lights: [...new Set([...previousLights, ...fullData.lights])] };
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
  for (const key of ['on', 'own']) {
    if (args[key] != null) patch[key] = haBoolean(args[key], `ls_store.${key}`);
  }
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
  // Captured `data` is accessed as a mapping throughout. Its nested fields are:
  // expected_revision raw once; op raw four times with one `get(..., 'set')`;
  // records three times with `get(..., [])`; area seven raw sites; via five;
  // who twice with one `or none`; keys/lights once each with empty-list
  // fallbacks; reason/received_at once each with `get` fallbacks; source and
  // request_id twice each behind truthiness gates; on once through HA `| bool`;
  // profile four comparison-only sites; min/max three sites each behind Jinja
  // `is number`; ranges once with `get(..., {})`, then bright/cosy four sites
  // each (sequence, length, two indexes). Record key/kind/source/target/value/
  // scope occur 2/5/2/6/1/3 times; value.channels has one empty-object fallback.
  // Keep the stale-revision stop ahead of every other parse and make operation-
  // specific strict fields lazy, matching the captured short-circuit order.
  ls_commit: withParsedArgs({
    parse: args => {
      const data = requireObject(args, 'data', 'ls_commit');
      return {
        expectedRevision: data.expected_revision,
        details: lazy(() => parseCommitData(data)),
      };
    },
    run: commit,
  }),
  ls_store: storeProfile,
  // Captured scope is raw twice (list construction and comparison), block has
  // one `| lower`, and via has two `| default('app')` sites. Raw scope remains
  // raw; the case filter coerces through Jinja string spelling.
  ls_override_block: withParsedArgs({
    parse: args => ({
      scope: args.scope,
      block: jinjaString(args.block).toLowerCase(),
      via: args.via === undefined ? 'app' : args.via,
    }),
    run: (ctx, args: OverrideBlockArgs) => {
    const current = object(ctx.run('ls_apply', { dry_run: true }));
    const schedule = object(object(current.plan).sched), scope = args.scope, block = args.block;
    const targets: Array<JsonValue | undefined> = [scope];
    if (scope === 'house') {
      const privateAreas = privateRooms(ctx);
      const entities = [...labelled(ctx, 'house_schedule'), ...labelled(ctx, 'on_off')];
      const rooms = entities.map(entity => ctx.areas[entity]).filter(isAreaId).filter(area => !privateAreas.includes(area));
      targets.push(...new Set(rooms));
    }
    const scheduled = (target: JsonValue | undefined) => jinjaMappingGet(schedule, target, 'ls_override_block.scope');
    const set = targets.filter(target => scheduled(target) !== block).map(target => ({ kind: 'block', target: target ?? null, value: block }));
    const clear = targets.filter(target => scheduled(target) === block).map(target => `block:${concatString(target)}`);
    if (set.length) ctx.fire('ls_override', { op: 'set', records: set, via: args.via });
    if (clear.length) ctx.fire('ls_override', { op: 'clear', keys: clear, via: args.via });
    return null;
    },
  }),
  // Captured via has one `| default('app')` site; explicit null/falsy values
  // survive because Jinja default only replaces Undefined.
  ls_clear_overrides: withParsedArgs({
    parse: args => ({ via: args.via === undefined ? 'app' : args.via }),
    run: (ctx, args: ViaArgs) => { ctx.fire('ls_override', { op: 'clear_all', via: args.via }); return null; },
  }),
  // Captured via has two `| default('app')` sites with the same semantics.
  ls_sara_mode: withParsedArgs({
    parse: args => ({ via: args.via === undefined ? 'app' : args.via }),
    run: (ctx, args: ViaArgs) => {
    ctx.fire('ls_override', Object.hasOwn(object(ctx.attr('sensor.ls_overrides', 'overrides')), 'mode:sara')
      ? { op: 'clear', keys: ['mode:sara'], via: args.via }
      : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: args.via });
    return null;
    },
  }),
};
