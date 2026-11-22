/**
 * Parsing for the automation adapters (`automation.*` handlers).
 *
 * An automation's input is an HA trigger document, and almost everything it
 * reads is either compared by identity (`trigger.id === 'start'`) or forwarded
 * into compared bytes (`payload_json`, the writer's event data, `who`). Those
 * values are therefore kept as they arrived: scalars as themselves, containers
 * as `Verbatim` ({@link storedFact}), so every `===` and every forwarded byte is
 * the raw value's. Every strict read raises with the message and at the point
 * the inline read did; reads the captured automation makes only on some path
 * are thunks.
 */
import type { EntityState, JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaTruthy, lazy, object, ParseError, requireObject, requireString } from '../runtime/parse.ts';
import { carry, carryOptional, reveal } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { list, nativeScalar, stateNumberOr } from './accessors.ts';
import { storedFact } from './overrides.ts';
import type { StoredEntry, StoredFact, StoredValue } from './overrides.ts';
import { toRemoteId, toRoomId } from './ids.ts';
import type { RemoteId, RoomId } from '../domain/types/ids.ts';
import type { OverlayKey } from '../domain/types/overlay.ts';

function triggerObject(args: JsonObject, context: string): JsonObject {
  return requireObject(args, 'trigger', context);
}

export type RemoteKind = 'power' | 'directions' | 'preset';
export interface RemoteArgs {
  room: RoomId;
  /** The gesture command: the kind itself, or directions' `trigger.id` as stored. */
  command: StoredValue;
  /** Preset's `trigger.payload_json` as stored, `null` when absent. */
  payload: Verbatim;
  source: string | undefined;
  deviceId: RemoteId | undefined;
}

export function parseRemoteArgs(kind: RemoteKind, args: JsonObject): RemoteArgs {
  const room = toRoomId(requireString(args, 'room', `automation.remote_${kind}`));
  if (!/^[a-z0-9_]+$/.test(room)) throw new ParseError('Remote automation requires a runtime room ID');
  // Center never reads trigger. Directions and preset reach distinct raw
  // fields, so the shared factory must not impose either field on the other.
  const trigger = kind === 'power' ? undefined : triggerObject(args, `automation.remote_${kind}`);
  const id = kind === 'directions' ? trigger!.id : undefined;
  const payload = kind === 'preset' ? trigger!.payload_json : undefined;
  return {
    room,
    // `trigger.id ?? null`: an absent id is forwarded as null.
    command: kind === 'directions' ? storedFact(id === undefined ? null : id) : kind,
    // `payload_json ?? null`: an absent payload is forwarded as null.
    payload: carry(payload === undefined ? null : payload),
    source: typeof args.source === 'string' ? args.source : undefined,
    deviceId: typeof args.device_id === 'string' ? toRemoteId(args.device_id) : undefined,
  };
}

export interface NativeControlsArgs {
  topic: string;
  /** The MQTT payload as received, or absent. */
  payload: Verbatim;
  /** The bridge's alias -> source mapping (parsed on first use); a non-string entry is `undefined`. */
  source: (alias: string) => string | undefined;
}

export function parseNativeControlsArgs(args: JsonObject): NativeControlsArgs {
  const trigger = triggerObject(args, 'automation.effects_native_light_controls');
  const sources = lazy(() => args.sources === undefined
    ? {}
    : requireObject(args, 'sources', 'automation.effects_native_light_controls'));
  return {
    topic: requireString(trigger, 'topic', 'automation.effects_native_light_controls.trigger'),
    payload: carryOptional(trigger.payload),
    // The captured automation always declares this mapping (88 entries).
    // The typed host may instead supply topology through ctx.catalog, so
    // an omitted bridge copy is the empty fallback, not malformed data.
    // A plain-object lookup, so an inherited property is found (and is not a
    // string) exactly as the inline `sources()[alias]` found it.
    source: alias => {
      const value = sources()[alias];
      return typeof value === 'string' ? value : undefined;
    },
  };
}

const CONTROLLED = ['power', 'brightness', 'rgb', 'temperature', 'effect'];
/** A native-control MQTT topic's alias (fourth segment) and attribute (last), when the attribute is one this controls. */
export function controlTopic(topic: string): { alias: string; attribute: string } | undefined {
  const parts = topic.split('/'), alias = parts[3] ?? '', attribute = parts.at(-1) ?? '';
  return CONTROLLED.includes(attribute) ? { alias, attribute } : undefined;
}

/**
 * The UI row whose power topic names `alias`, read leniently from the raw
 * `ui_rows` (never raises, unlike `effects_ui_sync`'s row parse). The last
 * matching row wins. `source` is the row's own value when it is a string, and
 * `undefined` otherwise -- the only thing the caller asks of it.
 */
export function nativeSourceFor(rows: JsonValue[] | undefined, alias: string): { matched: boolean; source: string | undefined } {
  let source: JsonValue | undefined, matched = false;
  for (const raw of list(rows)) {
    const row = object(raw), topic = object(row.topics).power;
    if (typeof topic === 'string' && topic.split('/')[3] === alias) {
      source = row.source;
      matched = true;
    }
  }
  return { matched, source: typeof source === 'string' ? source : undefined };
}

/**
 * The value HA hands `effects_set` for an MQTT payload: the native-template
 * scalar coercion, and an RGB triplet's tuple text read back as a list.
 */
export function nativeControlValue(payload: Verbatim, attribute: string): Verbatim {
  const raw = reveal(payload) as JsonValue | undefined;
  let value = nativeScalar(raw === undefined ? null : raw);
  if (attribute === 'rgb' && typeof value === 'string') {
    // MQTT RGB triplets render as a Python tuple in HA's native templates.
    // Preserve that JSON array boundary without executing template source.
    const text = value.trim();
    try { value = JSON.parse(text.startsWith('[') ?
      text : `[${text.replace(/^\(|\)$/g, '')}]`) as JsonValue; } catch { /* Preserve malformed text for the normal validation path. */ }
  }
  return carry(value);
}

export interface WriterArgs {
  /** The event data, forwarded with `who` replaced. */
  data: Verbatim;
  who: Verbatim;
}

// Writer reads trigger.event.data as a mapping once, data.who raw once in an
// `or` chain, and event.context.user_id raw once. Jinja `or` replaces empty
// containers too, so use jinjaTruthy rather than JavaScript `||`.
export function parseWriterArgs(args: JsonObject): WriterArgs {
  const trigger = triggerObject(args, 'automation.lighting_schedule_override_store_writer');
  const event = requireObject(trigger, 'event', 'automation.lighting_schedule_override_store_writer.trigger');
  const data = requireObject(event, 'data', 'automation.lighting_schedule_override_store_writer.trigger.event');
  const who = jinjaTruthy(data.who) ? data.who! : (() => {
    const eventContext = requireObject(event, 'context', 'automation.lighting_schedule_override_store_writer.trigger.event');
    return jinjaTruthy(eventContext.user_id) ? eventContext.user_id! : null;
  })();
  return { data: carry(data), who: carry(who) };
}

export interface TriggerIdArgs { id: StoredFact }

export function parseTriggerIdArgs(context: string) {
  return (args: JsonObject): TriggerIdArgs => ({ id: storedFact(triggerObject(args, context).id) });
}

export interface ScheduleEngineArgs extends TriggerIdArgs { entityId: StoredFact }

export function parseScheduleEngineArgs(args: JsonObject): ScheduleEngineArgs {
  const trigger = triggerObject(args, 'automation.lighting_schedule_engine');
  return { id: storedFact(trigger.id), entityId: storedFact(trigger.entity_id) };
}

export interface SaraModeArgs extends TriggerIdArgs { who: StoredFact }

export function parseSaraModeArgs(args: JsonObject): SaraModeArgs {
  const trigger = triggerObject(args, 'automation.lighting_schedule_sara_mode_switch');
  const toState = requireObject(trigger, 'to_state', 'automation.lighting_schedule_sara_mode_switch.trigger');
  const stateContext = requireObject(toState, 'context', 'automation.lighting_schedule_sara_mode_switch.trigger.to_state');
  return { id: storedFact(trigger.id), who: storedFact(stateContext.user_id) };
}

export interface LampChangeArgs {
  who: StoredFact;
  details: () => {
    service: StoredFact;
    /** `service_data | default({})`, forwarded to `effects_native_plan` as `sd`. */
    serviceData: () => Verbatim;
    contextId: StoredFact;
  };
}

export function parseLampChangeArgs(args: JsonObject): LampChangeArgs {
  const trigger = triggerObject(args, 'automation.lighting_schedule_lamp_change_detector');
  const event = requireObject(trigger, 'event', 'automation.lighting_schedule_lamp_change_detector.trigger');
  const eventContext = requireObject(event, 'context', 'automation.lighting_schedule_lamp_change_detector.trigger.event');
  return {
    who: storedFact(eventContext.user_id),
    details: lazy(() => {
      const data = requireObject(event, 'data', 'automation.lighting_schedule_lamp_change_detector.trigger.event');
      return {
        service: storedFact(data.service),
        serviceData: lazy(() => carry(data.service_data === undefined
          ? {}
          : requireObject(data, 'service_data', 'automation.lighting_schedule_lamp_change_detector.trigger.event.data'))),
        contextId: storedFact(eventContext.id),
      };
    }),
  };
}

/** A state's `context.id`, read leniently: a missing or non-mapping context has none. */
export function stateContextId(state: EntityState): StoredFact {
  return storedFact(object(state.context).id);
}

/** What the capture reads of `effects_native_plan`'s answer. */
export interface NativeCapture {
  powerAreas: StoredValue[];
  records: () => { document: Verbatim; count: number };
}

/**
 * `effects_native_plan`'s answer as the capture reads it. Read leniently, not
 * through a decoder: tests stub this script with shapes a decoder would refuse.
 * The power list is read at once (a present non-list raises before any event);
 * the records list only after the power events, where the inline read sat.
 */
export function nativeCapture(result: JsonValue): NativeCapture {
  const capture = object(result);
  return {
    // Captured: `"area": "{{ repeat.item.area }}"`. Home Assistant renders an
    // explicit None as None, and a missing area (a non-mapping item included)
    // as '' through its logging undefined.
    powerAreas: list(capture.power).map(power => {
      const area = object(power).area;
      return area === undefined ? '' : storedFact(area);
    }),
    records: lazy(() => {
      const records = list(capture.records);
      return { document: carry(records), count: records.length };
    }),
  };
}

/** An `input_number`'s state, read by {@link stateNumberOr}: anything but a number is `fallback`. */
export function inputNumber(ctx: HouseView, entity: string, fallback: number): number {
  return stateNumberOr(ctx.get(entity), fallback);
}

/**
 * The `when` of every stored override that is a mapping, as `as_timestamp`
 * reads it: date text parses, anything else (numeric Unix seconds included) is
 * `undefined`. A record that is not a mapping is not listed, so it never ages.
 */
export function overrideAges(entries: StoredEntry[]): Array<{ key: OverlayKey; when: number | undefined }> {
  return entries.flatMap(({ key, document }) => {
    const raw = reveal(document);
    if (!isObject(raw)) return [];
    // Native HA as_timestamp accepts date text, not numeric Unix seconds.
    const value = raw.when, parsed = typeof value === 'string' ? Date.parse(value) / 1000 : NaN;
    return [{ key, when: Number.isFinite(parsed) ? parsed : undefined }];
  });
}
