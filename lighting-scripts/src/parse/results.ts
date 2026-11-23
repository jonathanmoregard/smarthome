import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { TypedResults } from '../runtime/entrypoints.ts';
import type { SwitchDecision } from '../legacy/domain/controller.ts';
import type { CommitOutcome } from '../legacy/domain/state-store.ts';
import type { RemoteInputRecord, RemoteModeRecord, RemotePlanOp, RemotePlan } from '../legacy/domain/remote-input.ts';
import type { LampColor, LampProfile, LampProfileEntry, ProfileLevel, ScheduleCommand, ScheduleDetails, ScheduleEnvelope, ScheduledBase,
  ScheduleMirror, TargetEntry } from '../legacy/domain/schedule.ts';
import { optionalBlock, requireBlock } from './blocks.ts';
import { BLOCKS, blockOption } from '../domain/blocks.ts';
import { ParseError, requireArray, requireBoolean, requireFinite, requireNumber, requireObject, requireString } from '../runtime/parse.ts';
import { assembledMap, storedFact } from './overrides.ts';
import { toPowerTarget, toRemoteSource, toRoomId, toSwitchId } from './ids.ts';
import { overlayKeyText, remoteInputKey, SARA_MODE } from '../adapter/codecs/overlay-key.ts';
import type { RemoteSource, SwitchId } from '../domain/types/ids.ts';

/**
 * The JSON edge of one converted entrypoint's result.
 *
 * `encode` serves the name-keyed shim: Home Assistant and the parity harness
 * compare these bytes, so it must reproduce exactly what the handler returned
 * before conversion. Where the domain type is already JSON data -- a type alias
 * of plain fields, which is what criterion 3 made them -- encode is the
 * identity and there is nothing to serialise. That is the goal, not a shortcut:
 * a representation that needs converting is a representation that can drift.
 *
 * `decode` is the reverse, and runs **only** when a name-keyed override answers
 * instead of the registered handler: a unit test's stub, or the parity
 * harness's literal `ls_plan` dependency. The real handler's result never
 * passes through it.
 *
 * `decode` is therefore **optional**, and leaving it out is a real choice
 * rather than laziness. Write one where it is cheap and catches a stub that has
 * drifted from the shape it stands in for. Leave it out where the result type
 * is rich enough that a faithful decoder would be a second implementation of
 * the handler's output format -- `GradientCurve` is forty lines of structure
 * whose only JSON-returning stub is `{gradients: {}}`, and a decoder that
 * accepted that and nothing else would be theatre. Without one, a
 * JSON-returning override gets a precise error naming the two ways forward, so
 * the gap cannot pass silently.
 */
export interface ResultCodec<R> {
  encode(result: R): JsonValue;
  decode?(value: JsonValue, context: string): R;
}

/** `ls_remote_command`'s answer: the plan as its document, or `null` when it has none. */
export function remoteAnswerDocument(answer: RemotePlan | null): JsonObject | null {
  return answer === null ? null : remotePlanDocument(answer);
}

const bound = (v: JsonValue | undefined, context: string): number | boolean => typeof v === 'boolean' ? v : requireFinite(v, context);
/** A bound as the switch range compares it: a boolean is 0 or 1. */
const boundNumber = (v: number | boolean): number => typeof v === 'boolean' ? (v === true ? 1 : 0) : v;
/**
 * The operation is decoded before the envelope, so a stub that gets the
 * operation wrong is told about that rather than about a missing timestamp.
 */
/**
 * A remote plan (or the commit built on it) as the document it leaves as: a
 * clear's keys and an input record's key (its source's, derived) written as
 * their saved text, the input record's key second, where it always sat. Every
 * other field is already its wire value, and every key keeps its place.
 */
export function remotePlanDocument<P extends RemotePlanOp>(plan: P): JsonObject {
  if (plan.op === 'clear') return { ...plan, keys: plan.keys.map(overlayKeyText) };
  if (plan.op !== 'set') return { ...plan };
  return { ...plan, records: plan.records.map(record => record.kind === 'input'
    ? { kind: record.kind, key: overlayKeyText(remoteInputKey(record.source)), source: record.source, scope: record.scope,
      target: record.target, value: record.value }
    : record) };
}

/**
 * Stricter than the two call sites it replaces, deliberately and only on the
 * stub path.
 *
 * `ls_plan` raised on a missing `switches` (`requireObject`) while
 * `ls_room_plan` defaulted it to `{}`, so no single reader reproduces both. The
 * difference was unreachable for the real handler -- `switchPlan` always
 * returns `{switches}` and builds every field itself -- so it could only ever
 * have fired for a stub, and the strict reading is the one that catches a stub
 * that has drifted from the shape it stands in for.
 */
function decodeSwitchPlan(value: JsonValue, context: string): Record<SwitchId, SwitchDecision> {
  const result = requireObject({ value }, 'value', context);
  const switches = requireObject(result, 'switches', context);
  return Object.fromEntries(Object.entries(switches)
    .map(([entity, entry]) => [toSwitchId(entity), decodeSwitchDecision(entry, `${context}.switches.${entity}`)]));
}

/**
 * `switchPlan`'s decision, as it can emit one: its range is `switchRange`'s,
 * two bounds with 0 <= low <= high <= 100, and the switch is on only when the
 * room's brightness lies within it.
 */
function decodeSwitchDecision(value: JsonValue, context: string): SwitchDecision {
  const entry = requireObject({ value }, 'value', context);
  const range = requireArray(entry, 'range', context);
  if (range.length !== 2) throw new ParseError(`${context}.range must have two elements, got ${range.length}`);
  const on = requireBoolean(entry.on, `${context}.on`);
  const room = toRoomId(requireString(entry, 'room', context));
  const brightness = entry.brightness === undefined ? undefined : requireNumber(entry, 'brightness', context);
  // A bound may be a boolean: captured `is number` admits it (see `switchRange`).
  const stored: [number | boolean, number | boolean] = [bound(range[0], `${context}.range.0`), bound(range[1], `${context}.range.1`)];
  const low = boundNumber(stored[0]), high = boundNumber(stored[1]);
  if (!(0 <= low && low <= high && high <= 100)) {
    throw new ParseError(`${context}.range must be two bounds with 0 <= low <= high <= 100, got ${JSON.stringify(stored)}`);
  }
  if (on && (brightness === undefined || brightness < low || brightness > high)) {
    const shown = brightness === undefined ? 'no brightness' : `brightness ${brightness}`;
    throw new ParseError(`${context}.on is true only with a brightness within its range, got ${shown}`);
  }
  return { on, room, ...(brightness === undefined ? {} : { brightness }), range: stored };
}

/**
 * Only `accepted` discriminates, and only the success branch carries the other
 * two fields -- so a stub claiming a commit succeeded has to say what it
 * committed, which is the shape the real handler always returns.
 */
function decodeCommit(value: JsonValue, context: string): CommitOutcome {
  const result = requireObject({ value }, 'value', context);
  if (!requireBoolean(result.accepted, `${context}.accepted`)) return { accepted: false };
  return {
    accepted: true,
    revision: requireString(result, 'revision', context),
    committed_at: requireNumber(result, 'committed_at', context),
  };
}

function decodeRemotePlan(value: JsonValue, context: string): RemotePlan {
  const result = requireObject({ value }, 'value', context);
  const op = decodeRemoteOp(result, context);
  const input_revision = requireString(result, 'input_revision', context);
  const received_at = requireNumber(result, 'received_at', context);
  const request_id = requireString(result, 'request_id', context);
  const source = requestSource(request_id, received_at, context);
  // The producer's input record comes from the request's own source.
  if (op.op === 'set') op.records.forEach((record, index) => {
    if (record.kind === 'input' && record.source !== source) {
      throw new ParseError(`${context}.records.${index}.source must be ${JSON.stringify(source)}, the request's source, `
        + `got ${JSON.stringify(record.source)}`);
    }
  });
  return { ...op, input_revision, received_at, request_id };
}

function decodeRemoteOp(result: JsonObject, context: string): RemotePlanOp {
  const op = requireString(result, 'op', context);
  if (op === 'noop') return { op };
  if (op === 'clear') {
    // The one producer of a clear is `sara_toggle` with Sara mode on: it clears Sara mode and nothing else.
    const keys = decodeStrings(result, 'keys', context), sara = overlayKeyText(SARA_MODE);
    if (keys.length !== 1 || keys[0] !== sara) throw new ParseError(`${context}.keys must be ${JSON.stringify([sara])}, got ${JSON.stringify(keys)}`);
    return { op, keys: [SARA_MODE], via: decodeVia(result, context) };
  }
  if (op === 'clear_room') return { op, area: toRoomId(requireString(result, 'area', context)), via: decodeVia(result, context) };
  if (op === 'power') {
    return {
      op,
      area: toRoomId(requireString(result, 'area', context)),
      on: requireBoolean(result.on, `${context}.on`),
      targets: decodeStrings(result, 'targets', context).map(toPowerTarget),
      via: decodeVia(result, context),
    };
  }
  if (op === 'set') {
    return {
      op,
      records: requireArray(result, 'records', context)
        .map((record, index) => decodeRemoteRecord(record, `${context}.records.${index}`)),
      via: decodeVia(result, context),
    };
  }
  throw new ParseError(`${context}.op must be one of noop, clear, clear_room, power, set, got ${JSON.stringify(op)}`);
}

function decodeStrings(container: JsonObject, key: string, context: string): string[] {
  return requireArray(container, key, context)
    .map((value, index) => requireString({ value }, 'value', `${context}.${key}.${index}`));
}

/** Every operation but `noop` is tagged `via: 'remote'`; the literal is checked. */
function decodeVia(result: JsonObject, context: string): 'remote' {
  const via = requireString(result, 'via', context);
  if (via !== 'remote') throw new ParseError(`${context}.via must be "remote", got ${JSON.stringify(via)}`);
  return via;
}

function decodeRemoteRecord(value: JsonValue, context: string): RemoteModeRecord | RemoteInputRecord {
  const record = requireObject({ value }, 'value', context);
  const kind = requireString(record, 'kind', context);
  if (kind === 'mode') {
    // Sara mode switched on is the only mode record a producer writes.
    const target = requireString(record, 'target', context);
    if (target !== 'sara') throw new ParseError(`${context}.target must be "sara", got ${JSON.stringify(target)}`);
    const value = requireString(record, 'value', context);
    if (value !== 'on') throw new ParseError(`${context}.value must be "on", got ${JSON.stringify(value)}`);
    return { kind, target, value };
  }
  if (kind === 'input') {
    const scope = requireString(record, 'scope', context);
    if (scope !== 'room') throw new ParseError(`${context}.scope must be "room", got ${JSON.stringify(scope)}`);
    // The key is derived from the source, so the document's key must be exactly that one.
    const keyText = requireString(record, 'key', context);
    const source = toRemoteSource(requireString(record, 'source', context));
    const sourceKey = overlayKeyText(remoteInputKey(source));
    if (keyText !== sourceKey) {
      throw new ParseError(`${context}.key must be ${JSON.stringify(sourceKey)}, the key of its source, got ${JSON.stringify(keyText)}`);
    }
    return {
      kind,
      source,
      scope,
      target: toRoomId(requireString(record, 'target', context)),
      // Carried, as `RemoteInputRecord` says: this is the stored override document.
      value: assembledMap(requireObject(record, 'value', context)),
    };
  }
  throw new ParseError(`${context}.kind must be mode or input, got ${JSON.stringify(kind)}`);
}

/**
 * The source a request id names. The producer builds the id as
 * `${source}:${received_at}`, so an id that does not end in its own
 * `received_at`, or names no source before it, is no producer's.
 */
function requestSource(requestId: string, receivedAt: number, context: string): RemoteSource {
  const suffix = `:${receivedAt}`;
  if (!requestId.endsWith(suffix) || requestId.length === suffix.length) {
    throw new ParseError(`${context}.request_id must be ${JSON.stringify(`<source>${suffix}`)}, got ${JSON.stringify(requestId)}`);
  }
  return toRemoteSource(requestId.slice(0, -suffix.length));
}

/**
 * `ls_base`/`ls_room_base`'s decoder, which is where `ls_plan`'s
 * `requiredResultObject(...)`, its two `requireObject`s and its
 * `list(schedule.stale_keys)` went. `falsy-boundaries.test.ts:219` stubs
 * `ls_base` with `targets` deliberately absent and asserts that rejection, so
 * `targets` being required here is load-bearing, not defensive.
 *
 * `dbg` is copied only when present: the producer adds it under
 * `includeDebug`, and an absent key is not the same bytes as a null one.
 */
function decodeScheduledBase(value: JsonValue, context: string): ScheduledBase {
  const result = requireObject({ value }, 'value', context);
  const targets = requireObject(result, 'targets', context);
  const schedule = requireObject(result, 'schedule', context);
  const details = requireObject(schedule, 'schedule_details', `${context}.schedule`);
  const sched = requireObject(schedule, 'sched', `${context}.schedule`);
  const saraMirror = schedule.sara_mirror ?? null;
  if (saraMirror !== null && saraMirror !== 'off') {
    throw new ParseError(`${context}.schedule.sara_mirror must be "off" or null, got ${JSON.stringify(saraMirror)}`);
  }
  const envelope: ScheduleEnvelope = {
    cmds: requireArray(schedule, 'cmds', `${context}.schedule`)
      .map((command, index) => decodeScheduleCommand(command, `${context}.schedule.cmds.${index}`)),
    profiles: Object.fromEntries(Object.entries(requireObject(schedule, 'profiles', `${context}.schedule`))
      .map(([lamp, entry]) => [lamp, decodeProfileEntry(entry ?? null, `${context}.schedule.profiles.${lamp}`)])),
    revision: requireString(schedule, 'revision', `${context}.schedule`),
    stale_keys: decodeStrings(schedule, 'stale_keys', `${context}.schedule`),
    sched: Object.fromEntries(Object.entries(sched)
      .map(([scope, block]) => [scope, optionalBlock(block, `${context}.schedule.sched.${scope}`) ?? null])),
    schedule_details: Object.fromEntries(Object.keys(details)
      .map(scope => [scope, decodeScheduleDetails(details, scope, `${context}.schedule.schedule_details`)])),
    mirror: requireArray(schedule, 'mirror', `${context}.schedule`).map((entry, index) => {
      const at = `${context}.schedule.mirror.${index}`;
      const row = requireObject({ entry }, 'entry', at);
      return mirrorRow(requireString(row, 'entity', at), requireString(row, 'option', at), Object.keys(sched), at);
    }),
    sara_mirror: saraMirror,
  };
  if (Object.hasOwn(schedule, 'dbg')) envelope.dbg = decodeStrings(schedule, 'dbg', `${context}.schedule`);
  return {
    targets: Object.fromEntries(Object.entries(targets)
      .map(([lamp, entry]) => [lamp, decodeTargetEntry(entry ?? null, `${context}.targets.${lamp}`)])),
    schedule: envelope,
  };
}

function decodeScheduleCommand(value: JsonValue, context: string): ScheduleCommand {
  const command = requireObject({ value }, 'value', context);
  const kind = requireString(command, 'kind', context);
  const ids = decodeStrings(command, 'ids', context);
  if (kind === 'switch') return { kind, service: requireString(command, 'service', context), ids };
  const transition = requireNumber(command, 'transition', context);
  if (kind === 'off') return { kind, transition, ids };
  const brightness = requireNumber(command, 'brightness', context);
  if (kind === 'brightness') return { kind, brightness, transition, ids };
  if (kind === 'ct') return { kind, brightness, kelvin: requireNumber(command, 'kelvin', context), transition, ids };
  if (kind === 'rgb') return { kind, brightness, rgb: requireArray(command, 'rgb', context).map(value => storedFact(value)), transition, ids };
  throw new ParseError(`${context}.kind must be one of switch, off, brightness, ct, rgb, got ${JSON.stringify(kind)}`);
}

/** `effect` and `effect_channels` must be PRESENT, and stay raw once they are. */
function decodeProfileEntry(value: JsonValue, context: string): LampProfileEntry {
  const entry = requireObject({ value }, 'value', context);
  for (const key of ['effect', 'effect_channels'] as const) {
    if (!Object.hasOwn(entry, key)) throw new ParseError(`${context}.${key} must be present, got undefined`);
  }
  return {
    effect: storedFact(entry.effect ?? null),
    ...decodeProfileLevel(entry, context),
    // `scheduledBase` gives every lamp a block as its period.
    period: requireBlock(entry.period, `${context}.period`),
    area: entry.area === null ? null : toRoomId(requireString(entry, 'area', context)),
    effect_channels: storedFact(entry.effect_channels ?? null),
    send: requireBoolean(entry.send, `${context}.send`),
    ignore_overrides: decodeStrings(entry, 'ignore_overrides', context),
  };
}

/** `on`, and the level only a lit lamp has: an off lamp's entry carries no `brightness`. */
function decodeProfileLevel(entry: JsonObject, context: string): ProfileLevel {
  if (requireBoolean(entry.on, `${context}.on`)) return { brightness: requireNumber(entry, 'brightness', context), on: true };
  requireNothingShown(entry, context);
  return { on: false };
}

/** An off entry carries no level or colour; a stub that gives it one has drifted from the shape. */
function requireNothingShown(entry: JsonObject, context: string): void {
  for (const key of ['brightness', 'color']) {
    if (entry[key] !== undefined) throw new ParseError(`${context}.${key} must be absent when off, got ${JSON.stringify(entry[key])}`);
  }
}

function decodeScheduleDetails(container: JsonObject, key: string, context: string): ScheduleDetails {
  const at = `${context}.${key}`;
  const details = requireObject(container, key, at);
  return {
    cur: optionalBlock(details.cur, `${at}.cur`) ?? null,
    nxt: optionalBlock(details.nxt, `${at}.nxt`) ?? null,
    fading: requireBoolean(details.fading, `${at}.fading`),
    p: requireNumber(details, 'p', at),
    edge: requireBoolean(details.edge, `${at}.edge`),
    last_fs: requireNumber(details, 'last_fs', at),
    next_fs: requireNumber(details, 'next_fs', at),
    left: requireNumber(details, 'left', at),
    cur_ts: requireNumber(details, 'cur_ts', at),
  };
}

/** `scheduledBase` mirrors a scope's block into that scope's override select, as the block's option. */
function mirrorRow(entity: string, option: string, scopes: string[], context: string): ScheduleMirror {
  if (!scopes.some(scope => entity === `input_select.ls_${scope}_override`)) {
    throw new ParseError(`${context}.entity must be input_select.ls_<scope>_override for a scope in sched, got ${JSON.stringify(entity)}`);
  }
  if (!BLOCK_OPTIONS.includes(option)) {
    throw new ParseError(`${context}.option must be one of ${BLOCK_OPTIONS.join('/')}, got ${JSON.stringify(option)}`);
  }
  return { entity, option };
}

/** Discriminated on `is_room`, exactly as every consumer of `targets` does; an off target carries no level or colour. */
function decodeTargetEntry(value: JsonValue, context: string): TargetEntry {
  const entry = requireObject({ value }, 'value', context);
  if (requireBoolean(entry.is_room, `${context}.is_room`)) {
    if (!Object.hasOwn(entry, 'effect')) throw new ParseError(`${context}.effect must be present, got undefined`);
    const lit = requireBoolean(entry.on, `${context}.on`);
    const room = {
      area: toRoomId(requireString(entry, 'area', context)),
      is_room: true as const,
      period: requireBlock(entry.period, `${context}.period`),
      effect: storedFact(entry.effect ?? null),
    };
    const scenes = { ...decodeLampProfile(entry, 'day', context), ...decodeLampProfile(entry, 'cosy', context),
      ignore_overrides: decodeStrings(entry, 'ignore_overrides', context) };
    if (!lit) requireNothingShown(entry, context);
    return lit
      ? { brightness: requireNumber(entry, 'brightness', context), ...decodeOptionalColor(entry, context), ...room, on: true, ...scenes }
      : { ...room, on: false, ...scenes };
  }
  const profile = decodeProfileEntry(value, context);
  const colour = profile.on ? decodeOptionalColor(entry, context) : {};
  const rest = {
    ...decodeLampProfile(entry, 'day', context),
    ...decodeLampProfile(entry, 'cosy', context),
    transition: requireNumber(entry, 'transition', context),
    ...decodeLampProfile(entry, 'observed', context),
  };
  return profile.on ? { ...profile, is_room: false, ...colour, ...rest } : { ...profile, is_room: false, ...rest };
}

/**
 * A scene or observed light (`day`, `cosy`, `observed`): absent is no key;
 * `{on: false}` is off and carries nothing else; lit is `{brightness, color?}`.
 */
function decodeLampProfile(container: JsonObject, key: string, context: string): { [k: string]: LampProfile } {
  if (container[key] === undefined) return {};
  const entry = requireObject(container, key, `${context}.${key}`);
  if (entry.on !== undefined) {
    if (entry.on !== false) throw new ParseError(`${context}.${key}.on must be false when present, got ${JSON.stringify(entry.on)}`);
    return { [key]: { on: false } };
  }
  return { [key]: { brightness: requireNumber(entry, 'brightness', `${context}.${key}`), ...decodeOptionalColor(entry, `${context}.${key}`) } };
}

/** Each block as the override select shows it. */
const BLOCK_OPTIONS = BLOCKS.map(blockOption);

/** A colour that may be absent: a lit lamp whose light reports none carries no `color` key. */
function decodeOptionalColor(container: JsonObject, context: string): { color?: LampColor } {
  return container.color === undefined ? {} : { color: decodeLampColor(container, 'color', context) };
}

function decodeLampColor(container: JsonObject, key: string, context: string): LampColor {
  const color = requireObject(container, key, `${context}.${key}`);
  // `kelvin` discriminates, and the rgb arm stays as stored: `LampColor.rgb`
  // is a list of stored values because it comes from an `rgb_color` attribute.
  if (Object.hasOwn(color, 'kelvin')) return { kelvin: requireNumber(color, 'kelvin', `${context}.${key}`) };
  return { rgb: requireArray(color, 'rgb', `${context}.${key}`).map(value => storedFact(value)) };
}

/**
 * One codec per converted entrypoint.
 *
 * The mapped type is the completeness check: adding a name to
 * {@link TypedResults} breaks this declaration until its codec is written, so
 * the typed surface cannot grow a member that the JSON edge cannot serve.
 */
export const resultCodecs: { [K in keyof TypedResults]: ResultCodec<TypedResults[K]> } = {
  // The wire answer is a mapping, so the switches go out under `switches`.
  ls_switch_plan: { encode: switches => ({ switches }), decode: decodeSwitchPlan },
  // No decoder: a `ResolvedTarget` is `JsonObject`/`JsonValue` fields plus one
  // string, so a decoder could only check that nine keys are present -- and the
  // three stubs that stand in for this entrypoint declare their shape through
  // `typed()` instead, which states the same thing where a reader will see it.
  effects_resolve: { encode: result => result },
  // No decoder, for the opposite reason: `GradientCurve` is a deep structure
  // and its only JSON stub is `{gradients: {}}`.
  effects_gradient_plan: { encode: gradients => ({ gradients }) },
  // A decoder here is load-bearing for a real test: `falsy-boundaries` stubs
  // `{accepted: 'yes'}` precisely to assert a non-boolean is refused, and a
  // typed stub could not express that.
  ls_commit: { encode: result => result, decode: decodeCommit },
  // A decoder, and it is the most load-bearing one here. `ls_remote_command`
  // used to read this result with `requireString(input_revision)`,
  // `requireBoolean(on)` and `requireArray(targets)`, and
  // `falsy-boundaries.test.ts:216` exists to pin that a `power` plan with no
  // `targets` is refused. The decoder is where those reads moved.
  ls_remote_plan: { encode: remotePlanDocument, decode: decodeRemotePlan },
  // Both names share one decoder, as they share one result type.
  ls_base: { encode: result => result, decode: decodeScheduledBase },
  ls_room_base: { encode: result => result, decode: decodeScheduledBase },
};
