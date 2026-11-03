/**
 * The runtime catalog, parsed once at the edge.
 *
 * The catalog is the lighting system's registry document: it maps each logical
 * lamp to its physical members, names the effect renderers, carries the MQTT
 * topic per member, and records the remotes. It enters the system as JSON from
 * three edges -- the catalog file read by `main.ts`, the HA snapshot, and the
 * parity harness RPC -- and that is the only place JSON belongs.
 *
 * Before this module, ten domain files traversed the raw document and four
 * separate partial validators re-checked overlapping subsets of it
 * (`main.ts`'s three `record()` calls, `native-controls`'s `parseCatalog`,
 * `transport`'s `parseFrameCatalog`, `grouping`'s `effects_candle_plan` parse).
 * Each one checked a shape and then threw the knowledge away by handing on a
 * `JsonObject`, so every consumer re-derived it with a lenient accessor. One
 * parse, one type.
 *
 * ## Two views over one document
 *
 * `Catalog` is a **projection**: it carries the fields the lighting logic
 * reads, with concrete types. It is deliberately not a mirror of the file --
 * unknown and unread fields (`budget`, anything added later) are absent from
 * it. The unparsed document survives alongside it and is what the name-keyed
 * `effects_catalog` shim serves, so the HA and parity edges keep seeing the
 * document byte-for-byte and the oracle stays valid.
 *
 * ## Why some fields stay unvalidated
 *
 * `multicast`, `ui_rows` and `ui_discovery` are heterogeneous candidate lists
 * whose consumers filter them with `continue`: `effects_group_plan` skips an
 * unverified group, a group with a non-string topic, and a group with one
 * member. That leniency is load-bearing behaviour -- a catalog mid-pairing
 * legitimately contains pending groups -- so parsing their elements strictly
 * here would turn a silent skip into a raise and break grouping. They are
 * typed as the lists they are; their elements are parsed by the consumer that
 * knows which records it may ignore.
 *
 * Everywhere else the rule is the opposite: parse to a concrete type and raise
 * at load time. A catalog whose `topics` hold a number is an authoring error,
 * and failing on the file beats publishing to the topic `7`.
 */
import { ParseError, describe, requireArray, requireBoolean, requireObject, requireString } from './parse.ts';
import type { JsonObject, JsonValue, ScriptContext } from './context.ts';

/** A renderer script name plus the channels the effect drives. */
export interface CatalogEffect {
  renderer: string;
  /** Absent in the document means "drives no channel explicitly", not an error. */
  channels: string[];
}

/**
 * Only the remote-adjustment strategy is read. The document's processor records
 * also carry `animated` and `channels`, and they are deliberately absent here:
 * no lighting logic reads either, captured fixtures omit `animated` entirely,
 * and parsing a field nobody consumes only invents a way to fail. They remain
 * in the raw document for the shim.
 */
export interface CatalogProcessor {
  /** Absent is legal: `resolution` defaults the strategy per processor name. */
  remote_adjustment: string | undefined;
}

export interface CatalogRemote {
  device_id: string;
  source: string;
}

/** Both fields are independently optional; `effects_candle_sync` defaults each. */
export interface CatalogCandleGroup {
  friendly_name: string | undefined;
  id: number | undefined;
}

export interface Catalog {
  /** Effect name to renderer. Required: a lamp cannot be driven without it. */
  effects: Record<string, CatalogEffect>;
  /** Logical lamp to its physical member entities. Required. */
  members: Record<string, string[]>;
  /** Group name to its member entities. Required. */
  groups: Record<string, string[]>;
  /** Group entity to the members it stands in for, when packing commands. */
  baseline_groups: Record<string, string[]>;
  /** Member entity to its MQTT topic. */
  topics: Record<string, string>;
  /** Lamp to the phase name handed to an effect renderer. */
  phases: Record<string, string>;
  processors: Record<string, CatalogProcessor>;
  /** Room to the remote that controls it; spread into the gesture arguments. */
  remotes: Record<string, CatalogRemote>;
  /** Absent means "publish the built-in two choices", which is not the same as none. */
  ui_choices: string[] | undefined;
  /** Absent in every catalog so far; absence selects the built-in group name and id. */
  candle_group: CatalogCandleGroup | undefined;
  /** Candidate multicast groups, filtered by `effects_group_plan`. */
  multicast: JsonValue[];
  /**
   * Proxy light rows, parsed per consumer.
   *
   * Optional, unlike the other collections, because absence is not emptiness
   * here: `effects_ui_sync` raises `Missing runtime catalog.ui_rows` when the
   * document names no rows, while `ls_native_controls` reads the same field
   * leniently and treats absence as no rows. Defaulting to `[]` would erase the
   * first behaviour, so the parser keeps absence visible and each consumer
   * states what it means.
   */
  ui_rows: JsonValue[] | undefined;
  /** MQTT discovery payloads; optional for the same reason as {@link Catalog.ui_rows}. */
  ui_discovery: JsonValue[] | undefined;
}

function stringList(value: JsonValue | undefined, context: string): string[] {
  if (!Array.isArray(value)) throw new ParseError(`${context} must be an array of strings, got ${describe(value)}`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ParseError(`${context}[${index}] must be a string, got ${describe(entry)}`);
    }
    return entry;
  });
}

/** `{}` when the key is absent, because every consumer only iterates these. */
function stringListMap(document: JsonObject, key: string, context: string): Record<string, string[]> {
  if (document[key] === undefined) return {};
  const mapping = requireObject(document, key, context);
  return Object.fromEntries(Object.entries(mapping).map(([name, value]) =>
    [name, stringList(value, `${context}.${key}.${name}`)]));
}

function stringMap(document: JsonObject, key: string, context: string): Record<string, string> {
  if (document[key] === undefined) return {};
  const mapping = requireObject(document, key, context);
  return Object.fromEntries(Object.keys(mapping).map(name =>
    [name, requireString(mapping, name, `${context}.${key}`)]));
}

function recordMap<T>(document: JsonObject, key: string, context: string,
  parse: (record: JsonObject, context: string) => T): Record<string, T> {
  if (document[key] === undefined) return {};
  const mapping = requireObject(document, key, context);
  return Object.fromEntries(Object.keys(mapping).map(name =>
    [name, parse(requireObject(mapping, name, `${context}.${key}`), `${context}.${key}.${name}`)]));
}

/** An absent list is an empty one; a present non-list is an error. */
function valueList(document: JsonObject, key: string, context: string): JsonValue[] {
  return document[key] === undefined ? [] : requireArray(document, key, context);
}

function parseEffect(effect: JsonObject, context: string): CatalogEffect {
  return {
    renderer: requireString(effect, 'renderer', context),
    channels: effect.channels === undefined ? [] : stringList(effect.channels, `${context}.channels`),
  };
}

function parseProcessor(processor: JsonObject, context: string): CatalogProcessor {
  return {
    remote_adjustment: processor.remote_adjustment === undefined
      ? undefined
      : requireString(processor, 'remote_adjustment', context),
  };
}

function parseRemote(remote: JsonObject, context: string): CatalogRemote {
  return {
    device_id: requireString(remote, 'device_id', context),
    source: requireString(remote, 'source', context),
  };
}

function parseCandleGroup(group: JsonObject, context: string): CatalogCandleGroup {
  return {
    friendly_name: group.friendly_name === undefined ? undefined : requireString(group, 'friendly_name', context),
    id: group.id === undefined ? undefined : requireNumberAt(group, 'id', context),
  };
}

function requireNumberAt(container: JsonObject, key: string, context: string): number {
  const value = container[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ParseError(`${context}.${key} must be a finite number, got ${describe(value)}`);
  }
  return value;
}

/**
 * The catalog a context holds when no catalog was supplied.
 *
 * Most scripts never read it, and the unit suite drives them with snapshots
 * that omit it. Naming the empty state lets `ScriptContext.catalog` be a real
 * `Catalog` instead of an optional one, which is what removes the `object(...)`
 * and `?.` from every domain read site.
 */
export function emptyCatalog(): Catalog {
  return {
    effects: {}, members: {}, groups: {}, baseline_groups: {}, topics: {}, phases: {},
    processors: {}, remotes: {}, ui_choices: undefined, candle_group: undefined,
    multicast: [], ui_rows: undefined, ui_discovery: undefined,
  };
}

/**
 * The registry, for a script that the captured original had call
 * `script.effects_catalog` first.
 *
 * The call is kept and its result discarded, which looks redundant and is not:
 * the parity harness compares the sequence of script calls each run makes
 * (`adapters.py` extends `script_runs` from the backend's `scriptRuns`), so
 * dropping the call would diverge from the reference even though no value
 * changes. What the call used to provide -- a raw document to traverse -- now
 * comes from the parsed view instead.
 *
 * Sites that pass the document *onward* as JSON (into scheduled task arguments
 * or another script's arguments, both of which are persisted and compared) use
 * {@link ScriptContext.rawCatalog} and keep the raw bytes.
 */
export function catalogOf(ctx: ScriptContext): Catalog {
  ctx.run('effects_catalog');
  return ctx.catalog;
}

/**
 * Parse a catalog document. Raises on anything the lighting logic would later
 * mis-read; see the module comment for which fields are deliberately lenient.
 */
export function parseCatalog(document: JsonValue | undefined): Catalog {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ParseError(`catalog must be an object, got ${describe(document)}`);
  }
  const at = 'catalog';
  // Nothing is required here. Whether a *deployed* catalog must name members,
  // groups and effects is a question for the edge that loads one: `main.ts`
  // and `live.ts` both already refuse to start without them, and say so in
  // terms of the registry. Repeating it here would only reject the partial
  // catalogs that tests and single-script snapshots legitimately carry, and no
  // consumer of this parsed view raises on an absent collection -- they all
  // iterate or look up, so absent and empty are the same to them.
  return {
    effects: recordMap(document, 'effects', at, parseEffect),
    members: stringListMap(document, 'members', at),
    groups: stringListMap(document, 'groups', at),
    baseline_groups: stringListMap(document, 'baseline_groups', at),
    topics: stringMap(document, 'topics', at),
    phases: stringMap(document, 'phases', at),
    processors: recordMap(document, 'processors', at, parseProcessor),
    remotes: recordMap(document, 'remotes', at, parseRemote),
    ui_choices: document.ui_choices === undefined
      ? undefined
      : stringList(document.ui_choices, `${at}.ui_choices`),
    candle_group: document.candle_group === undefined
      ? undefined
      : parseCandleGroup(requireObject(document, 'candle_group', at), `${at}.candle_group`),
    multicast: valueList(document, 'multicast', at),
    ui_rows: document.ui_rows === undefined ? undefined : requireArray(document, 'ui_rows', at),
    ui_discovery: document.ui_discovery === undefined ? undefined : requireArray(document, 'ui_discovery', at),
  };
}
