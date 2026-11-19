import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaTruthy, ParseError, withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import { isAreaId, labelled, privateRooms } from './schedule.ts';
import { cachedProfile, catalogEffectChannels, parseOverrideBlockArgs, parseStoreProfile, parseViaArgs, roomTarget, scheduledBlocks, storedProfileText } from '../parse/state-store.ts';
import { affectedRoom, mergedValue, overrideRecord, parseCommitArgs, underlyingOf } from '../parse/overrides.ts';
import type { OpaqueMap, StoredEntry, StoredFact, StoredValue } from '../parse/overrides.ts';
import { attributeFact, attributeList, attributeMapping, lenientOverrides, overridesRevision } from '../parse/sensors.ts';

/** One channel claim of a `channels` record, as written. */
export interface ChannelClaim {
  channel: string;
  document: Verbatim;
  isEffect: boolean;
  hasUnderlying: boolean;
}
/** One record of an `ls_commit` request. `document` is the record as sent. */
export interface CommitRecord {
  document: Verbatim;
  /** The key the affected-room scan looks up; raises for an unhashable key. */
  lookupKey: () => string | undefined;
  /** The key the record is written under; raises for a present non-string key. */
  writeKey: () => string;
  kind: StoredFact;
  scope: StoredFact;
  target: StoredFact;
  value: StoredFact;
  valueIsMapping: boolean;
  channelClaims: () => ChannelClaim[];
}
/**
 * A stored switch range rule. Not `ui-state`'s `RangeConfig`: the custom bounds
 * pass Jinja's `is number`, which accepts booleans, so a bound can be `true`.
 */
export type RangeRule = { profile: 'bright' | 'cosy' } | { profile: 'custom'; min: number | boolean; max: number | boolean };
export interface CommitData {
  /** `data.get('op', 'set')`, only ever compared with literals. */
  op: StoredValue;
  /** The raw op when it is a string, else `''`: the full-render test's spelling. */
  opText: string;
  records: CommitRecord[];
  via: StoredFact;
  who: StoredValue;
  area: StoredFact;
  receivedAt: StoredFact;
  clearContains: () => (key: string) => boolean;
  power: () => { area: string; on: boolean };
  range: () => { entity: string; rule: RangeRule } | undefined;
  ranges: () => Verbatim | undefined;
  remoteAck: () => { source: string; requestId: StoredValue } | undefined;
  full: () => { reason: StoredValue; lights: StoredValue[] };
}
export interface CommitArgs {
  expectedRevision: StoredFact;
  details: () => CommitData;
}
/** The attributes `ls_commit` writes, in the order it writes them. */
export type OverridesPatch = {
  power?: Record<string, Verbatim | boolean>;
  switch_ranges?: Record<string, Verbatim | RangeRule>;
  range_defaults?: Verbatim;
  remote_ack?: Record<string, StoredValue>;
  overrides?: OpaqueMap;
  last_via?: StoredValue;
  pending_rooms?: Record<string, StoredValue>;
  last_request?: string;
  received_at?: StoredValue;
  full_version?: string;
  full_reason?: StoredValue;
  full_lights?: StoredValue[];
};
/**
 * The `ls_override_block` scope, or a room the house scope expanded to. `record`
 * is the raw scope as the set record stores it (`target ?? null`), `keyText` its
 * `~` spelling for the clear key, and `key` the schedule lookup, which raises for
 * an unhashable scope -- called where the lookup happens, after the dry run.
 */
export interface BlockTarget {
  isHouse: boolean;
  record: Verbatim;
  keyText: string;
  key: () => string | undefined;
}
export interface OverrideBlockArgs { scope: BlockTarget; block: string; via: Verbatim }
export interface ViaArgs { via: Verbatim }
/** The string each schedule key is scheduled to in the dry-run plan, if any. */
export type ScheduledBlocks = (key: string | undefined) => string | undefined;


/** The single override writer, preserving unrelated attributes and channel timestamps. */
/**
 * `ls_commit`'s result, as a discriminated union because that is what it is:
 * the stale-revision refusal answers `{accepted: false}` and nothing else, and
 * the success answers all three fields. Spelling it as one optional-field shape
 * would invent keys on the refusal, and those bytes are compared.
 */
export type CommitResult = { accepted: false } | { accepted: true; revision: string; committed_at: number };

export function commit(ctx: ScriptContext, args: CommitArgs): CommitResult {
  const entity = 'sensor.ls_overrides';
  // Captured: `data.get('expected_revision') in [none, <bare read>]` builds the
  // list whatever the expected revision is, so the read always happens here.
  const currentRevision = overridesRevision(ctx, 'ls_commit');
  if (args.expectedRevision != null && args.expectedRevision !== currentRevision) return { accepted: false };
  const parsed = args.details();
  const before = lenientOverrides(ctx);
  let overrides = before.clone();
  let patch: OverridesPatch = {};
  const op = parsed.op;
  const kept = (entries: StoredEntry[]): OpaqueMap => Object.fromEntries(entries.map(entry => [entry.key, entry.document]));
  if (op === 'clear_all') overrides = {};
  else if (op === 'clear') {
    const contains = parsed.clearContains();
    overrides = kept(before.entries.filter(({ key }) => !contains(key)));
  }
  else if (op === 'clear_room') overrides = kept(before.entries.filter(({ record: r }) => {
    const targetArea = typeof r.target === 'string' ? ctx.areas[r.target] : undefined;
    return !(r.scope === 'room' && r.target === parsed.area || (r.scope === 'lamp' || r.kind === 'light') && targetArea === parsed.area || r.kind === 'block' && r.target === parsed.area);
  }));
  else if (op === 'set') for (const record of parsed.records) {
    const key = record.writeKey(), old = overrideRecord(overrides[key]);
    let value: StoredValue = record.value === undefined ? null : record.value;
    if (record.kind === 'channels' && record.valueIsMapping) {
      const channels = { ...old.channels };
      for (const claim of record.channelClaims()) {
        let written = claim.document;
        if (claim.isEffect && !claim.hasUnderlying) {
          const underlying = underlyingOf(channels[claim.channel]);
          if (underlying !== undefined) written = withFields(claim.document, { underlying });
        }
        channels[claim.channel] = written;
      }
      value = mergedValue(old.value, value, channels);
    }
    // Captured: `old.get('created', old.get('when', now))`, which falls back only
    // on an absent key; an explicit null is kept.
    const created = old.created !== undefined ? old.created : old.when !== undefined ? old.when : ctx.now;
    overrides[key] = withFields(record.document, { value, when: ctx.now, created, who: parsed.who, via: parsed.via ?? null });
  }
  else if (op === 'power') {
    const power = parsed.power();
    patch.power = { ...attributeMapping(ctx, entity, 'power'), [power.area]: power.on };
  }
  else if (op === 'range_set') {
    const range = parsed.range();
    if (range !== undefined) patch.switch_ranges = { ...attributeMapping(ctx, entity, 'switch_ranges'), [range.entity]: range.rule };
  } else if (op === 'range_defaults') {
    const ranges = parsed.ranges();
    if (ranges !== undefined) patch.range_defaults = ranges;
  }
  const remoteAck = parsed.remoteAck();
  if (remoteAck !== undefined) patch.remote_ack = { ...attributeMapping(ctx, entity, 'remote_ack'), [remoteAck.source]: remoteAck.requestId };
  patch = { ...patch, overrides, last_via: parsed.via ?? null };
  const pending: Record<string, StoredValue> = { ...attributeMapping(ctx, entity, 'pending_rooms') };
  const affected: StoredFact[] = [];
  if (jinjaTruthy(parsed.area)) affected.push(parsed.area);
  for (const record of parsed.records) for (const item of [before.lookup(record.lookupKey()), record]) {
    if (item.scope === 'room') affected.push(item.target);
  }
  for (const [index, room] of affected.entries()) {
    pending[affectedRoom(room, index)] = ctx.now;
  }
  patch = { ...patch, pending_rooms: pending, last_request: ctx.now,
    received_at: parsed.receivedAt === undefined ? recordTimestamp(ctx.now) : parsed.receivedAt };
  const full = parsed.via !== 'remote' || ['render_request', 'clear', 'clear_all'].includes(parsed.opText) || parsed.records.some(r => r.kind === 'mode');
  if (full) {
    // Captured: `old != (state_attr(runtime,'handled_full') or none)`. Jinja `or`
    // fires on every falsy value, `[]` and `{}` included, so an empty container
    // becomes none and compares equal to an absent full_version. `|| null` left a
    // container as itself, and a reference comparison against it is always
    // unequal -- which marked the last full render unhandled and resurrected its
    // stale light list.
    const handled = attributeFact(ctx, 'sensor.ls_effects_runtime', 'handled_full');
    const unhandled = (attributeFact(ctx, entity, 'full_version') ?? null) !== (jinjaTruthy(handled) ? handled : null);
    const previousLights = unhandled ? attributeList(ctx, entity, 'full_lights') : [];
    const previousReason = unhandled ? attributeFact(ctx, entity, 'full_reason') : null;
    const fullData = parsed.full();
    let reason = fullData.reason;
    // Captured: `reason=='tick' and previous_reason and previous_reason!='tick'`,
    // Jinja's `and` (`[]`/`{}` falsy, NaN truthy).
    if (reason === 'tick' && jinjaTruthy(previousReason) && previousReason !== 'tick') reason = 'config';
    patch = { ...patch, full_version: ctx.now, full_reason: reason, full_lights: [...new Set([...previousLights, ...fullData.lights])] };
  }
  ctx.emit('variable.update_sensor', { value: ctx.now, attributes: patch, replace_attributes: false }, { entity_id: entity });
  ctx.emit('script.turn_on', {}, { entity_id: 'script.ls_render' });
  return { accepted: true, revision: overridesRevision(ctx, 'ls_commit'), committed_at: recordTimestamp(ctx.now) };
}

export interface StoreProfileArgs {
  entity: string;
  on: boolean | undefined;
  own: boolean | undefined;
  brightness: number | undefined;
  kelvin: number | undefined;
  hs: { h: number; s: number } | undefined;
  // `reject('eq','color')` fires when any of kelvin, mireds or hs was supplied.
  // That is not the same as a kelvin having been computed: kelvin and mireds sit
  // in one `elif`, so supplying both releases the channel once but converts once.
  releasesColour: boolean;
  /** Stored as supplied, and looked up in the catalog by hashable key. */
  effect: StoredValue | undefined;
}

/**
 * The saved profile: the document as stored, `current.get('effect', 'Normal
 * light')`, and `current.get('effect_channels', ...)` -- `'absent'` when the key
 * is, `'non-list'` when it holds something that is not a list.
 */
export interface StoredProfile {
  document: OpaqueMap;
  activeEffect: StoredValue;
  effectChannels: StoredValue[] | 'absent' | 'non-list';
}
/** An effect's catalog channel list; raises for an unhashable effect key. */
export type EffectChannels = (effect: StoredValue) => StoredValue[];
/** The fields `ls_store` writes, in the order it writes them. */
export type ProfilePatch = {
  on?: boolean;
  own?: boolean;
  b?: number;
  m?: 'ct' | 'hs';
  k?: number;
  h?: number;
  s?: number;
  effect?: StoredValue;
  effect_channels?: StoredValue[];
};

/** Writes the profile store and answers nothing; every path returns null. */
export function storeProfile(ctx: ScriptContext, args: StoreProfileArgs): null {
  const entity = args.entity;
  const current = cachedProfile(ctx.get(entity), entity);
  // `catalog.effects.get(key, {}).get('channels', [])`, over the raw result:
  // the `effects_catalog` call is recorded in `scriptRuns`, so it stays a call.
  const catalogChannels = catalogEffectChannels(ctx.run('effects_catalog'));
  const patch: ProfilePatch = {};
  if (args.on !== undefined) patch.on = args.on;
  if (args.own !== undefined) patch.own = args.own;
  if (args.brightness !== undefined) patch.b = args.brightness;
  // Source order: the hs block runs last and overwrites `m`, leaving any kelvin
  // the preceding block set still in the patch.
  if (args.kelvin !== undefined) { patch.m = 'ct'; patch.k = args.kelvin; }
  if (args.hs !== undefined) { patch.m = 'hs'; patch.h = args.hs.h; patch.s = args.hs.s; }
  // Both reads are `dict.get`, which falls back only on an ABSENT key. `??` also
  // fired on an explicit null, so a cached null effect claimed Normal light's
  // channels where the oracle resolves none and yields an empty list.
  let channels: StoredValue[];
  if (current.effectChannels === 'absent') channels = catalogChannels(current.activeEffect);
  else if (current.effectChannels !== 'non-list') channels = current.effectChannels;
  else {
    // Deliberate divergence, under "rework so it's typed and correct instead".
    // The oracle stores a present non-list verbatim when no release filter runs
    // and raises inside `reject` when one does, so the same malformed cache
    // behaves two ways depending on which fields the caller supplied.
    throw new ParseError(`ls_store.store entity ${entity} holds a non-list effect_channels`);
  }
  if (args.effect !== undefined) {
    patch.effect = args.effect;
    channels = catalogChannels(args.effect);
  } else {
    if (args.brightness !== undefined) channels = channels.filter(x => x !== 'brightness');
    if (args.releasesColour) channels = channels.filter(x => x !== 'color');
  }
  patch.effect_channels = channels;
  const value = storedProfileText(current, patch);
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
  ls_commit: typed('ls_commit', { parse: parseCommitArgs, run: commit }),
  // Captured `store` is required; every other field is guarded `is defined and
  // is not none` and carries its own filter (see `parseStoreProfile`). The
  // saved profile's two reads are `dict.get`, so an explicit null is a value.
  ls_store: withParsedArgs({ parse: parseStoreProfile, run: storeProfile }),
  // Captured scope is raw twice (list construction and comparison), block has
  // one `| lower`, and via has two `| default('app')` sites.
  ls_override_block: withParsedArgs({
    parse: parseOverrideBlockArgs,
    run: (ctx, args) => {
    const scheduledTo = scheduledBlocks(ctx.run('ls_apply', { dry_run: true }));
    const scope = args.scope, block = args.block;
    const targets: BlockTarget[] = [scope];
    if (scope.isHouse) {
      const privateAreas = privateRooms(ctx);
      const entities = [...labelled(ctx, 'house_schedule'), ...labelled(ctx, 'on_off')];
      const rooms = entities.map(entity => ctx.areas[entity]).filter(isAreaId).filter(area => !privateAreas.includes(area));
      targets.push(...[...new Set(rooms)].map(roomTarget));
    }
    const scheduled = (target: BlockTarget) => scheduledTo(target.key());
    const set = targets.filter(target => scheduled(target) !== block).map(target => ({ kind: 'block', target: target.record, value: block }));
    const clear = targets.filter(target => scheduled(target) === block).map(target => `block:${target.keyText}`);
    if (set.length) ctx.fire('ls_override', { op: 'set', records: set, via: args.via });
    if (clear.length) ctx.fire('ls_override', { op: 'clear', keys: clear, via: args.via });
    return null;
    },
  }),
  // Captured via has one `| default('app')` site; explicit null/falsy values
  // survive because Jinja default only replaces Undefined.
  ls_clear_overrides: withParsedArgs({
    parse: parseViaArgs,
    run: (ctx, args) => { ctx.fire('ls_override', { op: 'clear_all', via: args.via }); return null; },
  }),
  // Captured via has two `| default('app')` sites with the same semantics.
  ls_sara_mode: withParsedArgs({
    parse: parseViaArgs,
    run: (ctx, args) => {
    ctx.fire('ls_override', lenientOverrides(ctx).has('mode:sara')
      ? { op: 'clear', keys: ['mode:sara'], via: args.via }
      : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: args.via });
    return null;
    },
  }),
};
