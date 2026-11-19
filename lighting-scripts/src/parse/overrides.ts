/**
 * The override records `sensor.ls_overrides` stores, as the domain reads them.
 *
 * **A stored fact is the stored value, typed so it cannot be traversed.** The
 * captured scripts compare `kind`, `scope`, `target`, `via`, `when` and
 * `created` with `==` against literals, against each other and against
 * arguments, and copy them into compared output. A scalar is therefore kept as
 * itself, and a container is carried as `Verbatim`, which at runtime is the very
 * same reference: every `===`, `??` and spread the domain applies produces the
 * bytes it produced on the raw value, and a container still compares unequal to
 * everything but itself. Nothing is narrowed, so nothing can compare
 * differently (THE INVARIANT in `tasks/mission.md`).
 *
 * `ls_commit`'s argument parsing lives here too, since its records are the
 * documents it writes.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { isObject, jinjaTruthy, lazy, object, ParseError, requireArray, requireObject, requireString } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { CommitArgs, CommitData, CommitRecord } from '../domain/state-store.ts';
import { concatString, haBoolean, mappingKey } from './state-store.ts';

/** A stored value compared by identity: scalars as themselves, containers opaque. */
export type StoredValue = string | number | boolean | null | Verbatim;
/** A {@link StoredValue}, or `undefined` for an absent key. */
export type StoredFact = StoredValue | undefined;

export function storedFact(value: JsonValue): StoredValue;
export function storedFact(value: JsonValue | undefined): StoredFact;
export function storedFact(value: JsonValue | undefined): StoredFact {
  return Array.isArray(value) || isObject(value) ? carry(value) : value;
}

/** A documents map whose entries are carried unread: `{...map}` is the stored bytes. */
export type OpaqueMap = Record<string, Verbatim>;

/**
 * A document assembled from stored pieces: stored values as they are, and
 * mappings of them the domain builds or re-spreads. What a planner writes when
 * it rebuilds a stored document -- the keys it sets, plus the stored ones
 * carried unread, in place.
 */
export type Assembled = StoredValue | AssembledMap;
export type AssembledMap = { [key: string]: Assembled };

/** A mapping's entries as stored facts, in stored order: `{...map}` is the stored bytes. */
export function assembledMap(value: JsonObject): AssembledMap {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, storedFact(entry)]));
}

/** `.get(key, {})`-style leniency: a non-mapping is `{}`; every entry is carried. */
export function opaqueMap(value: JsonValue | undefined): OpaqueMap {
  return Object.fromEntries(Object.entries(object(value)).map(([key, entry]) => [key, carry(entry)]));
}

/**
 * One stored override record, read leniently: a non-mapping record has no
 * facts, as `object(record)` read it. `value` is `object(record.value)` and
 * `channels` a copy of `object(value.channels)` -- the two levels the channel
 * merge reads, each a non-mapping read as empty.
 */
export interface OverrideRecord {
  kind: StoredFact;
  scope: StoredFact;
  target: StoredFact;
  when: StoredFact;
  created: StoredFact;
  value: Verbatim;
  channels: OpaqueMap;
}

/**
 * A record as the domain holds it: stored, or written earlier in the same
 * commit. A plain-object lookup can also land on an inherited property, which
 * `object()` reads as `{}`, as it always did.
 */
export function overrideRecord(document: Verbatim | undefined): OverrideRecord {
  return recordView(document);
}

function recordView(entry: unknown): OverrideRecord {
  const r = object(entry), value = object(r.value);
  return {
    kind: storedFact(r.kind),
    scope: storedFact(r.scope),
    target: storedFact(r.target),
    when: storedFact(r.when),
    created: storedFact(r.created),
    value: carry(value),
    channels: opaqueMap(value.channels),
  };
}

export interface StoredEntry { key: string; document: Verbatim; record: OverrideRecord }

/** The `overrides` attribute as one mapping of records. */
export interface StoredOverrides {
  /** The mapping as stored. */
  document: OpaqueMap;
  /** `key in overrides`: an own key, as `Object.hasOwn` tests it. */
  has(key: string): boolean;
  /** Every stored entry, in stored order, with its lenient record view. */
  entries: StoredEntry[];
  /** `overrides.get(key)` read as a record; a miss (or no key) is `{}`. */
  lookup(key: string | undefined): OverrideRecord;
  /** A deep copy of the mapping, for a writer that replaces entries. */
  clone(): OpaqueMap;
}

export function storedOverrides(value: JsonObject): StoredOverrides {
  return {
    document: opaqueMap(value),
    has: key => Object.hasOwn(value, key),
    entries: Object.entries(value).map(([key, entry]) => ({ key, document: carry(entry), record: recordView(entry) })),
    lookup: key => recordView(key === undefined ? undefined : value[key]),
    clone: () => opaqueMap(structuredClone(value)),
  };
}

/**
 * What an effect claim with no `underlying` of its own inherits from the
 * claim it replaces: that claim itself when it is a constant or a scale, else
 * its own `underlying` -- only ever a mapping. `String(kind)` is the captured
 * spelling's JavaScript coercion and is kept, so `['constant']` still counts.
 */
export function underlyingOf(previous: Verbatim | undefined): Verbatim | undefined {
  const p = object(previous);
  const underlying = ['constant', 'scale'].includes(String(p.kind)) ? p : p.underlying;
  return isObject(underlying) ? carry(underlying) : undefined;
}

/** `{ ...prior, ...value, channels }`: the merged channels value, spread semantics exactly. */
export function mergedValue(prior: Verbatim, value: StoredValue, channels: OpaqueMap): Verbatim {
  return carry({ ...object(prior), ...object(value), channels });
}

/** A room the commit marks pending: a string, or the captured `affected` refusal. */
export function affectedRoom(room: StoredFact, index: number): string {
  return requireString({ room: room ?? null }, 'room', `ls_commit affected[${index}]`);
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
      document: carry(record),
      lookupKey: () => mappingKey(key, `${recordContext}.key`),
      writeKey: lazy(() => record.key === undefined ? fallbackKey : requireString(record, 'key', recordContext)),
      kind: storedFact(record.kind),
      scope: storedFact(record.scope),
      target: storedFact(record.target),
      value: storedFact(value),
      valueIsMapping: isObject(value),
      channelClaims: lazy(() => {
        if (!isObject(value)) return [];
        const channels = value.channels === undefined ? {} : requireObject(value, 'channels', `${recordContext}.value`);
        return Object.entries(channels).map(([channel, raw]) => {
          const claim = requireObject({ claim: raw }, 'claim', `${recordContext}.value.channels.${channel}`);
          return { channel, document: carry(claim), isEffect: claim.kind === 'effect', hasUnderlying: Object.hasOwn(claim, 'underlying') };
        });
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

function validRangePair(value: JsonValue | undefined, context: string): boolean {
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
  const via = storedFact(data.via);
  const who = data.who;
  return {
    op: data.op === undefined ? 'set' : storedFact(data.op),
    opText: typeof data.op === 'string' ? data.op : '',
    records,
    via,
    who: who !== undefined && jinjaTruthy(who) ? storedFact(who) : null,
    area: storedFact(data.area),
    receivedAt: storedFact(data.received_at),
    clearContains: lazy(() => membership(data.keys, 'ls_commit.data.keys')),
    power: lazy(() => ({
      area: requireString(data, 'area', 'ls_commit.data'),
      on: haBoolean(data.on, 'ls_commit.data.on'),
    })),
    range: lazy(() => {
      const profile = data.profile;
      if (profile === 'bright' || profile === 'cosy') {
        return { entity: requireString(data, 'entity', 'ls_commit.data'), rule: { profile } };
      }
      if (profile !== 'custom') return undefined;
      const min = testedNumber(data.min), max = testedNumber(data.max);
      if (min === undefined || max === undefined || min.numeric < 0 || min.numeric > max.numeric || max.numeric > 100) return undefined;
      return { entity: requireString(data, 'entity', 'ls_commit.data'), rule: { profile, min: min.raw, max: max.raw } };
    }),
    ranges: lazy(() => {
      const ranges = data.ranges === undefined ? {} : requireObject(data, 'ranges', 'ls_commit.data');
      return validRangePair(ranges.bright, 'ls_commit.data.ranges.bright') && validRangePair(ranges.cosy, 'ls_commit.data.ranges.cosy') ?
        carry(ranges) : undefined;
    }),
    remoteAck: lazy(() => {
      const requestId = data.request_id;
      if (via !== 'remote' || !jinjaTruthy(data.source) || requestId === undefined || !jinjaTruthy(requestId)) return undefined;
      return { source: requireString(data, 'source', 'ls_commit.data'), requestId: storedFact(requestId) };
    }),
    full: lazy(() => ({
      reason: data.reason === undefined ? (via === 'remote' ? 'remote' : 'config') : storedFact(data.reason),
      lights: data.lights === undefined ? [] : requireArray(data, 'lights', 'ls_commit.data').map(light => storedFact(light)),
    })),
  };
}

/**
 * Captured `data` is accessed as a mapping throughout; see `stateStoreHandlers`
 * for the per-field read counts. The stale-revision stop runs ahead of every
 * other parse, so the details are one lazy parse the domain triggers after it,
 * and operation-specific strict fields are lazy inside that, matching the
 * captured short-circuit order.
 */
export function parseCommitArgs(args: JsonObject): CommitArgs {
  const data = requireObject(args, 'data', 'ls_commit');
  return {
    expectedRevision: storedFact(data.expected_revision),
    details: lazy(() => parseCommitData(data)),
  };
}
