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
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { isObject, object } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';

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

/** `.get(key, {})`-style leniency: a non-mapping is `{}`; every entry is carried. */
export function opaqueMap(value: JsonValue | undefined): OpaqueMap {
  return Object.fromEntries(Object.entries(object(value)).map(([key, entry]) => [key, carry(entry)]));
}

/** The `overrides` attribute as one mapping of records. */
export interface StoredOverrides {
  /** The mapping as stored. */
  document: OpaqueMap;
  /** `key in overrides`: an own key, as `Object.hasOwn` tests it. */
  has(key: string): boolean;
}

export function storedOverrides(value: JsonObject): StoredOverrides {
  return {
    document: opaqueMap(value),
    has: key => Object.hasOwn(value, key),
  };
}
