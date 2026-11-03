import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { TypedResults } from '../runtime/entrypoints.ts';
import type { SwitchDecision, SwitchPlanResult } from '../domain/controller.ts';
import type { AssignResult, EmitResult } from '../domain/transport.ts';
import type { CommitResult } from '../domain/state-store.ts';
import type { CandleMember, CandlePlanResult, GroupCommand, GroupPlanResult, RejectedRow } from '../domain/grouping.ts';
import type { RemoteInputRecord, RemoteModeRecord, RemotePlanOp, RemotePlanResult } from '../domain/remote-input.ts';
import type { LampColor, LampProfile, LampProfileEntry, ScheduleCommand, ScheduleDetails, ScheduleEnvelope, ScheduledBaseResult, TargetEntry } from '../domain/schedule.ts';
import { optionalBlock } from './blocks.ts';
import { ParseError, requireArray, requireBoolean, requireFinite, requireNumber, requireObject, requireString } from '../runtime/parse.ts';

function decodeStrings(container: JsonObject, key: string, context: string): string[] {
  return requireArray(container, key, context)
    .map((value, index) => requireString({ value }, 'value', `${context}.${key}.${index}`));
}

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

function decodeSwitchDecision(value: JsonValue, context: string): SwitchDecision {
  const entry = requireObject({ value }, 'value', context);
  const range = requireArray(entry, 'range', context);
  if (range.length !== 2) throw new ParseError(`${context}.range must have two elements, got ${range.length}`);
  return {
    on: requireBoolean(entry.on, `${context}.on`),
    room: requireString(entry, 'room', context),
    brightness: requireNumber(entry, 'brightness', context),
    range: [requireFinite(range[0], `${context}.range.0`), requireFinite(range[1], `${context}.range.1`)],
  };
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
function decodeSwitchPlan(value: JsonValue, context: string): SwitchPlanResult {
  const result = requireObject({ value }, 'value', context);
  const switches = requireObject(result, 'switches', context);
  return {
    switches: Object.fromEntries(Object.entries(switches)
      .map(([entity, entry]) => [entity, decodeSwitchDecision(entry, `${context}.switches.${entity}`)])),
  };
}

function decodeEmit(value: JsonValue, context: string): EmitResult {
  const result = requireObject({ value }, 'value', context);
  const published = requireArray(result, 'published_at', context);
  return {
    published_at: published.map((at, index) => requireFinite(at, `${context}.published_at.${index}`)),
    completed: requireBoolean(result.completed, `${context}.completed`),
  };
}

/** `generation` must be *present* and may legitimately be null; it is raw. */
function decodeAssign(value: JsonValue, context: string): AssignResult {
  const result = requireObject({ value }, 'value', context);
  if (!Object.hasOwn(result, 'generation')) throw new ParseError(`${context}.generation must be present, got undefined`);
  return { generation: result.generation ?? null };
}

/**
 * Only `accepted` discriminates, and only the success branch carries the other
 * two fields -- so a stub claiming a commit succeeded has to say what it
 * committed, which is the shape the real handler always returns.
 */
function decodeCommit(value: JsonValue, context: string): CommitResult {
  const result = requireObject({ value }, 'value', context);
  if (!requireBoolean(result.accepted, `${context}.accepted`)) return { accepted: false };
  return {
    accepted: true,
    revision: requireString(result, 'revision', context),
    committed_at: requireNumber(result, 'committed_at', context),
  };
}

/**
 * `payload` and `group` are read raw on purpose, matching `GroupCommand`: the
 * payload is the lamp's MQTT body and `group` is the catalog's own id, both
 * compared bytes. `group` must be *present* and may legitimately be null --
 * unicast commands carry `group: null`.
 */
function decodeGroupCommand(value: JsonValue, context: string): GroupCommand {
  const command = requireObject({ value }, 'value', context);
  if (!Object.hasOwn(command, 'group')) throw new ParseError(`${context}.group must be present, got undefined`);
  return {
    topic: requireString(command, 'topic', context),
    payload: requireObject(command, 'payload', context),
    members: decodeStrings(command, 'members', context),
    owners: decodeStrings(command, 'owners', context),
    group: command.group ?? null,
  };
}

/**
 * This decoder replaces a read rather than adding one. `dispatch-render.ts`
 * used to write `batch.commands ?? []` and `transport.ts` wrapped the same
 * field in `list(...).map(object)`; both could only ever fire for a stub,
 * because `planGroups` builds all five fields on every path. The decoder is
 * where that leniency now lives, and it is strict: a stub standing in for a
 * frame plan has to say what it planned.
 */
function decodeGroupPlan(value: JsonValue, context: string): GroupPlanResult {
  const result = requireObject({ value }, 'value', context);
  const commands = requireArray(result, 'commands', context);
  const rejected = requireArray(result, 'rejected', context);
  return {
    commands: commands.map((command, index) => decodeGroupCommand(command, `${context}.commands.${index}`)),
    rejected: rejected.map((row, index) => decodeRejectedRow(row, `${context}.rejected.${index}`)),
    input_count: requireNumber(result, 'input_count', context),
    endpoint_count: requireNumber(result, 'endpoint_count', context),
    command_count: requireNumber(result, 'command_count', context),
  };
}

/** The two shapes `planGroups` pushes, and no third one. */
function decodeRejectedRow(value: JsonValue, context: string): RejectedRow {
  const row = requireObject({ value }, 'value', context);
  const reason = requireString(row, 'reason', context);
  if (reason === 'invalid_endpoint_row') return { reason, index: requireNumber(row, 'index', context) };
  if (reason === 'conflicting_endpoint_rows') return { reason, entity: requireString(row, 'entity', context) };
  throw new ParseError(`${context}.reason must be invalid_endpoint_row or conflicting_endpoint_rows, got ${JSON.stringify(reason)}`);
}

function decodeCandleMember(value: JsonValue, context: string): CandleMember {
  const member = requireObject({ value }, 'value', context);
  return {
    ieee_address: requireString(member, 'ieee_address', context),
    endpoint: requireNumber(member, 'endpoint', context),
  };
}

/**
 * `lamps`, `actual` and `remove` are read raw, matching `CandlePlanResult`:
 * `remove`'s entries are documents the planner only checks, and the selected
 * one is persisted into `candle_pending` and compared.
 */
function decodeCandlePlan(value: JsonValue, context: string): CandlePlanResult {
  const result = requireObject({ value }, 'value', context);
  const decodeMembers = (key: 'members' | 'add'): CandleMember[] =>
    requireArray(result, key, context)
      .map((member, index) => decodeCandleMember(member, `${context}.${key}.${index}`));
  return {
    lamps: Object.fromEntries(Object.entries(requireObject(result, 'lamps', context))
      .map(([lamp, raw]) => [lamp, requireObject({ raw }, 'raw', `${context}.lamps.${lamp}`)])),
    entities: decodeStrings(result, 'entities', context),
    members: decodeMembers('members'),
    actual: requireObject(result, 'actual', context),
    remove: requireArray(result, 'remove', context)
      .map((raw, index) => requireObject({ raw }, 'raw', `${context}.remove.${index}`)),
    add: decodeMembers('add'),
    owners: Object.fromEntries(Object.entries(requireObject(result, 'owners', context))
      .map(([ieee, lamp]) => [ieee, requireString({ lamp }, 'lamp', `${context}.owners.${ieee}`)])),
    fresh: requireBoolean(result.fresh, `${context}.fresh`),
    synchronized: requireBoolean(result.synchronized, `${context}.synchronized`),
    ready: requireBoolean(result.ready, `${context}.ready`),
  };
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
    return { kind, target: requireString(record, 'target', context), value: requireString(record, 'value', context) };
  }
  if (kind === 'input') {
    const scope = requireString(record, 'scope', context);
    if (scope !== 'room') throw new ParseError(`${context}.scope must be "room", got ${JSON.stringify(scope)}`);
    return {
      kind,
      key: requireString(record, 'key', context),
      source: requireString(record, 'source', context),
      scope,
      target: requireString(record, 'target', context),
      // Raw, as `RemoteInputRecord` says: this is the stored override document.
      value: requireObject(record, 'value', context),
    };
  }
  throw new ParseError(`${context}.kind must be mode or input, got ${JSON.stringify(kind)}`);
}

function decodeRemoteOp(result: JsonObject, context: string): RemotePlanOp {
  const op = requireString(result, 'op', context);
  if (op === 'noop') return { op };
  if (op === 'clear') return { op, keys: decodeStrings(result, 'keys', context), via: decodeVia(result, context) };
  if (op === 'clear_room') return { op, area: requireString(result, 'area', context), via: decodeVia(result, context) };
  if (op === 'power') {
    return {
      op,
      area: requireString(result, 'area', context),
      on: requireBoolean(result.on, `${context}.on`),
      targets: decodeStrings(result, 'targets', context),
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

/**
 * The operation is decoded before the envelope, so a stub that gets the
 * operation wrong is told about that rather than about a missing timestamp.
 */
function decodeRemotePlan(value: JsonValue, context: string): RemotePlanResult {
  const result = requireObject({ value }, 'value', context);
  return {
    ...decodeRemoteOp(result, context),
    input_revision: requireString(result, 'input_revision', context),
    received_at: requireNumber(result, 'received_at', context),
    request_id: requireString(result, 'request_id', context),
  };
}

function decodeLampColor(container: JsonObject, key: string, context: string): LampColor {
  const color = requireObject(container, key, `${context}.${key}`);
  // `kelvin` discriminates, and the rgb arm stays raw: `LampColor.rgb` is
  // `JsonValue[]` because it comes from an `rgb_color` attribute.
  if (Object.hasOwn(color, 'kelvin')) return { kelvin: requireNumber(color, 'kelvin', `${context}.${key}`) };
  return { rgb: requireArray(color, 'rgb', `${context}.${key}`) };
}

function decodeLampProfile(container: JsonObject, key: string, context: string): LampProfile {
  const entry = requireObject(container, key, `${context}.${key}`);
  return {
    brightness: requireNumber(entry, 'brightness', `${context}.${key}`),
    color: decodeLampColor(entry, 'color', `${context}.${key}`),
  };
}

/** `effect` and `effect_channels` must be PRESENT, and stay raw once they are. */
function decodeProfileEntry(value: JsonValue, context: string): LampProfileEntry {
  const entry = requireObject({ value }, 'value', context);
  for (const key of ['effect', 'effect_channels'] as const) {
    if (!Object.hasOwn(entry, key)) throw new ParseError(`${context}.${key} must be present, got undefined`);
  }
  return {
    effect: entry.effect ?? null,
    brightness: requireNumber(entry, 'brightness', context),
    on: requireBoolean(entry.on, `${context}.on`),
    period: requireString(entry, 'period', context),
    area: entry.area === null ? null : requireString(entry, 'area', context),
    effect_channels: entry.effect_channels ?? null,
    send: requireBoolean(entry.send, `${context}.send`),
    ignore_overrides: decodeStrings(entry, 'ignore_overrides', context),
  };
}

/** Discriminated on `is_room`, exactly as every consumer of `targets` does. */
function decodeTargetEntry(value: JsonValue, context: string): TargetEntry {
  const entry = requireObject({ value }, 'value', context);
  if (requireBoolean(entry.is_room, `${context}.is_room`)) {
    if (!Object.hasOwn(entry, 'effect')) throw new ParseError(`${context}.effect must be present, got undefined`);
    return {
      brightness: requireNumber(entry, 'brightness', context),
      color: decodeLampColor(entry, 'color', context),
      area: requireString(entry, 'area', context),
      is_room: true,
      period: requireString(entry, 'period', context),
      effect: entry.effect ?? null,
      on: requireBoolean(entry.on, `${context}.on`),
      day: decodeLampProfile(entry, 'day', context),
      cosy: decodeLampProfile(entry, 'cosy', context),
      ignore_overrides: decodeStrings(entry, 'ignore_overrides', context),
    };
  }
  return {
    ...decodeProfileEntry(value, context),
    is_room: false,
    color: decodeLampColor(entry, 'color', context),
    day: decodeLampProfile(entry, 'day', context),
    cosy: decodeLampProfile(entry, 'cosy', context),
    transition: requireNumber(entry, 'transition', context),
    observed: decodeLampProfile(entry, 'observed', context),
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
  if (kind === 'ct') return { kind, brightness, kelvin: requireNumber(command, 'kelvin', context), transition, ids };
  if (kind === 'rgb') return { kind, brightness, rgb: requireArray(command, 'rgb', context), transition, ids };
  throw new ParseError(`${context}.kind must be one of switch, off, ct, rgb, got ${JSON.stringify(kind)}`);
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
function decodeScheduledBase(value: JsonValue, context: string): ScheduledBaseResult {
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
      return { entity: requireString(row, 'entity', at), option: requireString(row, 'option', at) };
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

/**
 * One codec per converted entrypoint.
 *
 * The mapped type is the completeness check: adding a name to
 * {@link TypedResults} breaks this declaration until its codec is written, so
 * the typed surface cannot grow a member that the JSON edge cannot serve.
 */
export const resultCodecs: { [K in keyof TypedResults]: ResultCodec<TypedResults[K]> } = {
  ls_switch_plan: { encode: result => result, decode: decodeSwitchPlan },
  // No decoder: a `ResolvedTarget` is `JsonObject`/`JsonValue` fields plus one
  // string, so a decoder could only check that nine keys are present -- and the
  // three stubs that stand in for this entrypoint declare their shape through
  // `typed()` instead, which states the same thing where a reader will see it.
  effects_resolve: { encode: result => result },
  // No decoder, for the opposite reason: `GradientCurve` is a deep structure
  // and its only JSON stub is `{gradients: {}}`.
  effects_gradient_plan: { encode: result => result },
  // Decoders: both results are small and flat, and `ls_dispatch` reads every
  // field of them, so a drifted stub here would corrupt a dispatch rather than
  // fail loudly.
  effects_emit: { encode: result => result, decode: decodeEmit },
  effects_assign: { encode: result => result, decode: decodeAssign },
  // A decoder here is load-bearing for a real test: `falsy-boundaries` stubs
  // `{accepted: 'yes'}` precisely to assert a non-boolean is refused, and a
  // typed stub could not express that.
  ls_commit: { encode: result => result, decode: decodeCommit },
  // No decoder: nothing stubs `ls_dispatch`, and `null` plus two built fields
  // is not a shape a stub would get subtly wrong without failing loudly.
  ls_dispatch: { encode: result => result },
  // Both names share one result type, so they share its decoder. Both are
  // stubbed in the suite -- `effects_group_plan` by `frame-catalog.test.ts`,
  // which replaces the group planner so its two tests fail only on the
  // renderer boundary they are about, and `effects_frame_plan` by
  // `falsy-boundaries.test.ts`. The decoder is also what now carries the
  // leniency the two call sites used to apply inline.
  effects_group_plan: { encode: result => result, decode: decodeGroupPlan },
  effects_frame_plan: { encode: result => result, decode: decodeGroupPlan },
  // A decoder because `iterate()` reads seven of the ten fields and drives a
  // Zigbee group mutation off them, so a drifted stub would publish the wrong
  // membership rather than fail.
  effects_candle_plan: { encode: result => result, decode: decodeCandlePlan },
  // A decoder, and it is the most load-bearing one here. `ls_remote_command`
  // used to read this result with `requireString(input_revision)`,
  // `requireBoolean(on)` and `requireArray(targets)`, and
  // `falsy-boundaries.test.ts:216` exists to pin that a `power` plan with no
  // `targets` is refused. The decoder is where those reads moved.
  ls_remote_plan: { encode: result => result, decode: decodeRemotePlan },
  // Both names share one decoder, as they share one result type.
  ls_base: { encode: result => result, decode: decodeScheduledBase },
  ls_room_base: { encode: result => result, decode: decodeScheduledBase },
};
