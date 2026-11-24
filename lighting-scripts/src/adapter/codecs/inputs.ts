/**
 * Home Assistant's inputs, read into messages (spec 5.1). `haInput` names
 * what a script or automation run is and reads its fields, once, into the
 * input's own types; `messages` reads the input into the Model's messages,
 * against the Model and the house as Home Assistant shows them at the input.
 *
 * Moved here from the old shells: the person-change detector's rules (a
 * user, a light call, not caused by a running script) from the lamp-change
 * automation, the remote presses from the gesture scripts, the range save's
 * checks from `decideRangeSave`, the dashboard's scripts and the override
 * event's operations from `ls_commit`, and the native controls from
 * `effects_set`.
 *
 * A field that cannot be read makes the run `unreadable`, and one the house
 * refuses (a store no lamp has, a room with no remote) raises a `ParseError`
 * in `messages`; either way the loop logs it and drops the input.
 */
import type { EffectName } from '../../domain/effect.ts';
import type { DashboardControlId, LampId, RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Brightness, Colour, PercentRange, Power } from '../../domain/types/light.ts';
import type { Block, RoomOrHouse } from '../../domain/types/schedule.ts';
import type { Instant } from '../../domain/types/time.ts';
import { onOffOnly, ownRange, storedRangeBounds } from './ui-state.ts';
import type { RangeBound } from './ui-state.ts';
import type { ContextId, EntityId, RemoteSource } from './ids.ts';
import {
  percentRangeOf, toBrightness, toBrightnessStep, toColourChannel, toContextId, toDashboardControlId, toEntityId, toKelvin, toLampId,
  toRemoteId, toRemoteSource, toRoomId, toSwitchId,
} from './ids.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import type { HouseView } from './house.ts';
import { blockLightOf } from './config.ts';
import type { BlockLight } from './config.ts';
import { ParseError, describe, isObject, jinjaString, object, requireBoolean, requireString } from './parse.ts';
import { configSource, reportsOn } from './model.ts';
import { callColour, callReach, callTargets, parseCallColour } from './native-call.ts';
import type { CallColour, CallTargets } from './native-call.ts';
import type { Unexplained } from '../reconcile.ts';
import type { Catalog, HouseMode } from './catalog.ts';
import { uiRowsOf } from './catalog.ts';
import type { UiRow } from './catalog.ts';
import { overlayKeyText } from './overlay-key.ts';
import { BLOCKS } from '../../domain/types/schedule.ts';
import type { ControlLight, RequestedBrightness, RequestedEffect, RequestedLight } from '../../domain/lamp-overlays.ts';
import type { LampProfileChange } from '../../domain/profiles.ts';
import type { Model, Msg, OverlayRequest } from '../../domain/update.ts';
import type { PresetButton, RemoteButton, RemoteCommand } from '../../domain/remote.ts';
import type { RangeDefaults, RangeRule } from '../../domain/switches.ts';

/** What happened in Home Assistant, as a script or automation run names it. Fields are read by `messages`. */
export type HaInput =
  /** Home Assistant started: everything is read again. */
  | { kind: 'started' }
  /** The minute's clock. */
  | { kind: 'tick' }
  /** A wake the loop asked for, or a render request: the clock at the instant. */
  | { kind: 'wake' }
  /**
   * Home Assistant is back (the connection, or Home Assistant itself started again), its house read afresh: the
   * config and the profiles are read again, every parked bulb is unparked, and the house is reconciled anew.
   */
  | { kind: 'reconnected' }
  /** A helper the config or a profile is read from changed: the config and the profiles are read again. */
  | { kind: 'helper changed' }
  /** Lamps switched back on from outside (wall power, or a named apply): their bulbs are sent their light again. */
  | { kind: 'state changed'; entities: readonly EntityId[] }
  /** The `ls_override` event, as `ls_commit` and the store writer took it. */
  | { kind: 'overlay event'; event: OverlayEvent }
  | { kind: 'dashboard script'; script: DashboardScript }
  /** A `call_service` event: a person's light call, by the detector's rules; none when the call is no person's light call. */
  | { kind: 'service called'; call: LightCall | undefined }
  /** The mode mirror switched in the dashboard; `byPerson`, by a user. */
  | { kind: 'mode switched'; on: boolean; byPerson: boolean }
  /** A remote's button, as the automation or gesture script that saw it reports it; none when it is no button the remote has. */
  | { kind: 'remote action'; from: PressFrom; button: RemoteButton | undefined }
  /** A command sent for a room's remote (`ls_remote_command`). */
  | { kind: 'remote command'; from: PressFrom; command: RemoteCommand }
  /**
   * A dashboard control's set: by its row's source (`effects_set`), or by the alias its MQTT set topic names
   * (`effects_native_light_controls`).
   */
  | { kind: 'control set'; control: ControlNamed; value: ControlValue }
  /** A profile store save (`ls_store`): the store, and what the save sets. */
  | { kind: 'store saved'; store: EntityId; change: LampProfileChange }
  /** A run of ours with a field that cannot be read, and why: the loop logs it once and drops it, and the turn goes on. */
  | { kind: 'unreadable'; why: string };

/**
 * A script or automation run Home Assistant's bridge forwards, read as an input: a dry run asks and changes nothing
 * (the bridge never forwards one; the old scripts answered it), and a name that is not one of ours is no input. A
 * room's own gesture script (`ls_remote_gesture_<room>`, `ls_remote_power_quiet_<room>`) is the shared one, bound to
 * that room's remote in the catalog; the mode's script and switch are the ones the catalog's mode names.
 */
export function scriptInput(script: string, args: JsonObject, catalog: Pick<Catalog, 'remotes' | 'mode'>): HaInput | 'dry run' | 'not ours' {
  if (args.dry_run === true) return 'dry run';
  const named = ROOM_GESTURE.exec(script);
  const room = named === null ? undefined : named[2];
  const remote = room === undefined ? undefined : catalog.remotes[room];
  const input = named === null || room === undefined ? haInput(script, args, catalog.mode)
    : haInput(`${named[1]}`, { ...(remote === undefined ? {} : { device_id: remote.device_id, source: remote.source }), ...args, room },
      catalog.mode);
  return input === undefined ? 'not ours' : input;
}

/**
 * The input a script or automation run is, its fields read; undefined when the
 * name is not one of ours, and `unreadable` when a field cannot be read. Never
 * raises. The mode's script and switch are the ones `mode` names; a catalog
 * that names no mode has neither.
 */
export function haInput(script: string, args: JsonObject, mode: HouseMode | undefined): HaInput | undefined {
  try {
    return readInput(script, args, mode);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return { kind: 'unreadable', why: `${script}: ${error.message}` };
  }
}

function readInput(script: string, args: JsonObject, mode: HouseMode | undefined): HaInput | undefined {
  const trigger = object(args.trigger);
  const remote = REMOTE_AUTOMATION.exec(script);
  if (remote !== null) return remoteAutomation(remote[1], args, trigger);
  if (mode !== undefined && script === mode.switched) {
    const user = object(object(trigger.to_state).context).user_id;
    const on = powerNamed(trigger.id, 'on', 'off', 'the mode switch') === 'on';
    return { kind: 'mode switched', on, byPerson: typeof user === 'string' && user !== '' };
  }
  if (mode !== undefined && script === mode.script) return { kind: 'dashboard script', script: { kind: 'toggle mode' } };
  switch (script) {
    case 'automation.lighting_schedule_engine': return scheduleEngine(trigger);
    case 'automation.lighting_schedule_end_overrides':
    case 'automation.lighting_recover_pending_output':
    case 'automation.effects_refresh_native_light_controls': return { kind: 'tick' };
    case 'automation.switch_lamps_validate_house_defaults': return { kind: 'helper changed' };
    case 'automation.lighting_schedule_lamp_change_detector': return { kind: 'service called', call: lightCall(object(trigger.event)) };
    case 'automation.lighting_schedule_override_store_writer':
      return { kind: 'overlay event', event: overlayEventOf(object(object(trigger.event).data), mode) };
    case 'automation.effects_native_light_controls': return previewSet(optionalText(trigger.topic), trigger.payload);
    case 'ls_commit': return { kind: 'overlay event', event: overlayEventOf(object(args.data), mode) };
    case 'ls_override_block': return { kind: 'dashboard script', script: heldBlock(requireString(args, 'scope', 'ls_override_block'), args.block) };
    case 'ls_clear_overrides': return { kind: 'dashboard script', script: { kind: 'clear overlays' } };
    case 'ls_range_save': return { kind: 'dashboard script',
      script: { kind: 'save range', save: rangeSaveOf(optionalText(args.entity), args.profile, args.minimum, args.maximum) } };
    case 'ls_remote_gesture': return gesture(args);
    case 'ls_remote_command': return remoteCommandOf(args);
    case 'effects_set': return { kind: 'control set', control: { kind: 'row', source: toDashboardControlId(requireString(args, 'source', 'effects_set')) },
      value: controlValue(requireString(args, 'attribute', 'effects_set'), args.value) };
    case 'ls_store': return storeSaved(args);
    case 'ls_apply': return Array.isArray(args.lights) ? { kind: 'state changed', entities: texts(args.lights).map(toEntityId) } : { kind: 'wake' };
    case 'ls_remote_power_quiet': case 'ls_render': case 'ls_dispatch': case 'ls_wake': case 'effects_ui_sync': case 'effects_ui_catalog':
      return { kind: 'wake' };
    default: return undefined;
  }
}

function remoteAutomation(kind: string | undefined, args: JsonObject, trigger: JsonObject): HaInput {
  const button = kind === 'center' ? { kind: 'power' } as const : kind === 'directions' ? arrowOf(trigger.id) : presetOf(trigger.payload_json);
  return { kind: 'remote action', from: pressFrom(args.device_id, args.room, args.source), button };
}

/** The schedule engine's triggers: the minute, the start, a lamp back on, and the config helpers. */
function scheduleEngine(trigger: JsonObject): HaInput {
  switch (trigger.id) {
    case 'tick': return { kind: 'tick' };
    case 'start': return { kind: 'started' };
    case 'lamp_on': return { kind: 'state changed', entities: typeof trigger.entity_id === 'string' ? [toEntityId(trigger.entity_id)] : [] };
    default: return { kind: 'helper changed' };
  }
}

/** A control's MQTT set (`effects_native_light_controls`): the alias and the attribute its topic names, and the payload. */
function previewSet(topic: string | undefined, payload: JsonValue | undefined): HaInput {
  if (topic === undefined) throw new ParseError('A control set with no topic');
  const parts = topic.split('/'), alias = parts[3], attribute = parts.at(-1);
  if (alias === undefined || attribute === undefined) throw new ParseError(`Not a control topic: ${topic}`);
  return { kind: 'control set', control: { kind: 'topic', alias }, value: controlValue(attribute, payload) };
}

/** A gesture script's command; `power_done` is the burst's window closing, which the clock closes now. */
function gesture(args: JsonObject): HaInput {
  const from = pressFrom(args.device_id, args.room, args.source);
  switch (args.command) {
    case 'power': return { kind: 'remote action', from, button: { kind: 'power' } };
    case 'cancel': return { kind: 'remote action', from, button: { kind: 'cancel' } };
    case 'preset': return { kind: 'remote action', from, button: presetOf(args.payload) };
    case 'left': case 'right': case 'up': case 'down': return { kind: 'remote action', from, button: arrowOf(args.command) };
    default: return { kind: 'wake' };
  }
}

/** A command for a room's remote (`ls_remote_command`), the room named `area`. */
function remoteCommandOf(data: JsonObject): HaInput {
  const command = COMMANDS.find(known => known === data.command);
  if (command === undefined) throw new ParseError(`ls_remote_command: ${jinjaString(data.command)} is not a command`);
  return { kind: 'remote command', from: pressFrom(data.device_id, data.area, data.source), command };
}

/** An `ls_store` call: the store, and the fields it sets. */
function storeSaved(data: JsonObject): HaInput {
  const store = toEntityId(requireString(data, 'store', 'ls_store'));
  const kelvin = typeof data.kelvin === 'number' ? data.kelvin : typeof data.mireds === 'number' && data.mireds > 0 ? 1_000_000 / data.mireds
    : undefined;
  return {
    kind: 'store saved', store,
    change: {
      own: typeof data.own === 'boolean' ? data.own : undefined,
      power: typeof data.on === 'boolean' ? powerOf(data.on) : undefined,
      brightness: typeof data.brightness === 'number' ? toBrightness(Math.round(Math.min(255, Math.max(0, data.brightness)))) : undefined,
      colour: kelvin === undefined ? undefined : { kind: 'kelvin', kelvin: toKelvin(Math.round(kelvin)) },
      effect: typeof data.effect === 'string' ? effectName(data.effect) : undefined,
    },
  };
}

/**
 * The messages an input sends, read against the Model and the house at `now`.
 * The clock is the loop's; these are the input's own. Raises a `ParseError`
 * for a field that cannot be read.
 */
export function messages(input: HaInput, model: Model, now: Instant, house: HouseView): Msg[] {
  switch (input.kind) {
    case 'started': case 'tick': case 'wake': case 'reconnected': case 'helper changed': case 'state changed': return [];
    case 'overlay event': return overlayEvent(input.event, model, now, house);
    case 'dashboard script': return dashboardScript(input.script, model, now, house);
    case 'service called': return input.call === undefined ? [] : personCall(input.call, model, now, house);
    case 'mode switched': return input.byPerson ? [{ kind: 'modeToggled', on: input.on, at: now }] : [];
    case 'remote action': return remoteAction(input, model, now, house);
    case 'remote command': return remoteCommand(input, model, now, house);
    case 'control set': return controlSet(input.control, input.value, model, now, house);
    case 'store saved': return profileSaved(storeSaveOf(input.store, input.change, model), now);
    case 'unreadable': throw new ParseError(input.why);
  }
}

/**
 * A remote's button: the remote is the press's device, else its room's; a
 * room the config holds no remote for drops the press. `anyOn` is what the
 * room reports at the press.
 */
function remoteAction(input: Extract<HaInput, { kind: 'remote action' }>, model: Model, now: Instant, house: HouseView): Msg[] {
  const button = input.button;
  if (button === undefined) return [];
  const remote = remoteOf(input.from, model, house);
  return [{ kind: 'remoteButtonPressed', remote, button, anyOn: roomReportsOn(model, remote, house), at: now }];
}

function remoteCommand(input: Extract<HaInput, { kind: 'remote command' }>, model: Model, now: Instant, house: HouseView): Msg[] {
  const remote = remoteOf(input.from, model, house);
  return [{ kind: 'remotePressed', remote, command: input.command, anyOn: roomReportsOn(model, remote, house), at: now }];
}

function texts(values: readonly JsonValue[]): string[] {
  return values.flatMap(value => typeof value === 'string' ? [value] : []);
}

/** An arrow, by the id its automation or gesture script gives it; none for any other id. */
function arrowOf(id: JsonValue | undefined): RemoteButton | undefined {
  return id === 'up' || id === 'down' || id === 'left' || id === 'right' ? { kind: 'arrow', direction: id } : undefined;
}

/** A preset button, by the colour temperature move its payload reports; none for any other payload. */
function presetOf(payload: JsonValue | undefined): RemoteButton | undefined {
  if (!isObject(payload) || payload.action !== 'color_temperature_move') return undefined;
  const mireds = payload.action_color_temperature;
  return { kind: 'preset', button: PRESETS.find(([preset]) => preset === mireds)?.[1] };
}

function powerOf(on: boolean): Power {
  return on ? 'on' : 'off';
}

/**
 * A dashboard control set (today's `effects_set`): on a lamp's profile row,
 * the profile saved for its block; on a live control, a control overlay on
 * the lamp, or on the room it covers whole, whose power switches the room.
 * The OFF of a lamp's control is its off hold, the ON the hold's end.
 */
function controlSet(control: ControlNamed, value: ControlValue, model: Model, now: Instant, house: HouseView): Msg[] {
  const row = controlRow(control, house);
  if (row === undefined) {
    throw new ParseError(control.kind === 'row' ? `effects_set: no dashboard control for ${control.source}` : `No dashboard control for ${control.alias}`);
  }
  if (row.store !== undefined) return profileSaved(storeSaveOf(toEntityId(row.store), profileChange(value), model), now);
  const source = toDashboardControlId(row.source), over = model.config.controls[source];
  if (over === undefined) throw new ParseError(`effects_set: ${row.source} is over no lamp of the house`);
  const light = controlLight(value);
  if (value.attribute === 'power' && over.kind === 'room') {
    return [{ kind: 'overlayRequested', request: { kind: 'room power', room: over.room, power: light.power }, at: now }];
  }
  return [{ kind: 'overlayRequested', request: { kind: 'dashboard control', control: source, over, light }, at: now }];
}

/** A room's own gesture script: the shared script's name, then the room. */
const ROOM_GESTURE = /^(ls_remote_gesture|ls_remote_power_quiet)_(.+)$/;

function roomReportsOn(model: Model, remote: RemoteId, house: HouseView): boolean {
  const room = model.config.remotes[remote]?.room;
  return room !== undefined && reportsOn(configSource(house), model.config, model.switchRanges, room);
}

/** The `ls_override` event's operations the Model holds: clear all, a room's power, records set or cleared, a switch's range, the range defaults. */
export type OverlayEvent =
  | { op: 'clear all' }
  | { op: 'room power'; room: RoomId; power: Power }
  /** Records set: the mode on, or a block held. */
  | { op: 'set'; records: readonly ({ kind: 'mode' } | HeldBlock)[] }
  /** Records cleared; `mode`, the mode's among them. */
  | { op: 'clear'; mode: boolean }
  | { op: 'range set'; save: RangeSave }
  | { op: 'range defaults'; defaults: RangeDefaults };

/** The remote automations, by the kind their name ends in: the center button, the arrows, the preset buttons. */
const REMOTE_AUTOMATION = /^automation\.(?:.*_)?remote_(center|directions|preset)(?:_arrows)?$/;

/** The override event's operations, as messages. */
function overlayEvent(event: OverlayEvent, model: Model, now: Instant, house: HouseView): Msg[] {
  switch (event.op) {
    case 'clear all': return [{ kind: 'overlayRequested', request: { kind: 'clear all' }, at: now }];
    case 'room power': return [{ kind: 'overlayRequested', request: { kind: 'room power', room: event.room, power: event.power }, at: now }];
    case 'set': return event.records.map((record): Msg => record.kind === 'mode' ? { kind: 'modeToggled', on: true, at: now }
      : { kind: 'overlayRequested', request: record, at: now });
    case 'clear': return event.mode ? [{ kind: 'modeToggled', on: false, at: now }] : [];
    case 'range set': return rangeSaved(event.save, model, now, house);
    case 'range defaults': return [{ kind: 'rangeDefaultsSaved', defaults: event.defaults, at: now }];
  }
}

/**
 * The override event's operations the Model holds, read: clear all, a room's
 * power, a block held, the mode on or off, a switch's range and the range
 * defaults. Other operations, and a set's other records (a lamp's channels, a
 * remote's records), are not read here: they raise, so the input is logged
 * once and dropped.
 */
function overlayEventOf(data: JsonObject, mode: HouseMode | undefined): OverlayEvent {
  switch (data.op) {
    case 'clear_all': return { op: 'clear all' };
    case 'power': return { op: 'room power', room: toRoomId(requireString(data, 'area', 'ls_override')),
      power: requireBoolean(data.on, 'ls_override.on') ? 'on' : 'off' };
    case 'set': return { op: 'set', records: (Array.isArray(data.records) ? data.records : []).map(raw => {
      const record = object(raw);
      if (record.kind === 'mode' && mode !== undefined && record.target === mode.name) return { kind: 'mode' } as const;
      if (record.kind !== 'block' || typeof record.target !== 'string') {
        throw new ParseError(`ls_override: record ${jinjaString(record.kind === undefined ? null : record.kind)} is not read here`);
      }
      return heldBlock(record.target, record.value);
    }) };
    case 'clear': return { op: 'clear',
      mode: mode !== undefined && Array.isArray(data.keys) && data.keys.includes(overlayKeyText({ kind: 'mode', name: mode.name })) };
    case 'range_set': return { op: 'range set',
      save: rangeSaveOf(requireString(data, 'entity', 'ls_override'), data.profile, data.min, data.max) };
    case 'range_defaults': return { op: 'range defaults', defaults: rangeDefaults(object(data.ranges)) };
    default: throw new ParseError(`ls_override: operation ${jinjaString(data.op)} is not read here`);
  }
}

/** The override event's range defaults: both ranges, each a valid pair of percents. */
function rangeDefaults(ranges: JsonObject): RangeDefaults {
  const pair = (name: 'bright' | 'cosy'): PercentRange => {
    const ends = ranges[name];
    const range = Array.isArray(ends) ? percentRangeOf(ends[0], ends[1]) : undefined;
    if (range === undefined) throw new ParseError(`ls_override: range_defaults.${name} is not a range`);
    return range;
  };
  return { bright: pair('bright'), cosy: pair('cosy') };
}

/** A block held over a room or the house, as the Model is asked to hold it. */
type HeldBlock = Extract<OverlayRequest, { kind: 'hold block' }>;

function heldBlock(scope: string, block: JsonValue | undefined): HeldBlock {
  return { kind: 'hold block', over: scope === 'house' ? 'house' : toRoomId(scope), block: blockOf(block) };
}

function blockOf(value: JsonValue | undefined): Block {
  const block = BLOCKS.find(known => typeof value === 'string' && known === value.toLowerCase());
  if (block === undefined) throw new ParseError(`Not a block: ${jinjaString(value)}`);
  return block;
}

/** The dashboard's scripts: hold a block, clear every overlay, save a switch's range, toggle the mode. */
export type DashboardScript = HeldBlock | { kind: 'clear overlays' } | { kind: 'toggle mode' } | { kind: 'save range'; save: RangeSave };

function dashboardScript(script: DashboardScript, model: Model, now: Instant, house: HouseView): Msg[] {
  switch (script.kind) {
    case 'hold block': return [{ kind: 'overlayRequested', request: script, at: now }];
    case 'clear overlays': return [{ kind: 'overlayRequested', request: { kind: 'clear all' }, at: now }];
    case 'toggle mode': return [{ kind: 'modeToggled', on: !model.modeOverlay.active, at: now }];
    case 'save range': return rangeSaved(script.save, model, now, house);
  }
}

/**
 * A switch's range save, as the dashboard or the override event gives it: the entity it names (none when it names
 * none), the profile (none when it is one the dashboard does not offer; absent is bright), and Own Range's two ends.
 * Whether the entity is a physical switch in a room is the house's to say, where the save is read.
 */
export type RangeSave = { entity: EntityId | undefined; profile: RangeProfile | undefined; minimum: RangeEnd; maximum: RangeEnd };

/** A range save, as the dashboard and the override event give it: the profile absent is bright; an end not given keeps the saved one. */
function rangeSaveOf(entity: string | undefined, profile: JsonValue | undefined, minimum: JsonValue | undefined,
  maximum: JsonValue | undefined): RangeSave {
  return {
    entity: entity === undefined ? undefined : toEntityId(entity),
    profile: typeof profile === 'string' ? RANGE_PROFILES.find(known => known === profile) : 'bright',
    minimum: rangeEnd(minimum), maximum: rangeEnd(maximum),
  };
}

function rangeSaved(save: RangeSave, model: Model, now: Instant, house: HouseView): Msg[] {
  if (save.entity === undefined) throw new ParseError(NOT_PHYSICAL);
  const entity = save.entity, domain = entity.split('.')[0];
  const physical = (domain === 'switch' || domain === 'light') && house.state[entity] !== undefined
    && Object.values(house.devices === undefined ? {} : house.devices).some(entities => entities.includes(entity))
    && !/^(switch|light)\.(ls_|ep_)/.test(entity) && !entity.includes('permit_join');
  if (!physical) throw new ParseError(NOT_PHYSICAL);
  if (domain === 'light' && !onOffOnly(house, entity)) {
    throw new ParseError('Choose an on/off lamp; dimmable lamps use the normal lighting settings.');
  }
  const room = house.rooms.ofId[entity];
  if (room === undefined) throw new ParseError('Assign this lamp to a room before configuring its range.');
  const rule = rangeRule(save.profile, entity, save.minimum, save.maximum, house);
  return [{ kind: 'rangeSaved', switch: toSwitchId(entity), rule, room, at: now }];
}

/**
 * A switch's range rule saved, after today's checks (`decideRangeSave`): a
 * physical switch or on/off-only light with a device, in a room, and a rule
 * that is bright, cosy, or an own range in order inside 0..100. A missing
 * own-range end keeps the saved one. A save that fails a check raises.
 */
/** Today's refusal of a range save that names no physical switch or on/off lamp. */
const NOT_PHYSICAL = 'Choose a physical on/off lamp or smart plug.';

function rangeRule(profile: RangeProfile | undefined, entity: EntityId, minimum: RangeEnd, maximum: RangeEnd, house: HouseView): RangeRule {
  if (profile === 'bright' || profile === 'cosy') return { kind: profile };
  if (profile !== 'custom') throw new ParseError('Choose Bright Default, Cosy Default, or Own Range.');
  const saved = storedRangeBounds(house, entity);
  const range = ownRange(endOf(minimum, saved.min), endOf(maximum, saved.max));
  if (range === undefined) throw new ParseError('Enter both ends of Own Range: 0–100%, with From no higher than Through.');
  return { kind: 'custom', range };
}

type RangeProfile = 'bright' | 'cosy' | 'custom';

const RANGE_PROFILES: readonly RangeProfile[] = ['bright', 'cosy', 'custom'];

/** An Own Range end as a save gives it: a number; `saved`, none given, so the switch's saved end is kept; or not a number, refused. */
type RangeEnd = number | 'saved' | 'not a number';

/** An end given: a number is itself; text or a boolean is no number; anything else (absent, null, a list) gives none. */
function rangeEnd(value: JsonValue | undefined): RangeEnd {
  if (typeof value === 'number') return value;
  return typeof value === 'string' || typeof value === 'boolean' ? 'not a number' : 'saved';
}

/** An end as Own Range reads it: the saved end when none was given; no number refuses the range. */
function endOf(end: RangeEnd, saved: RangeBound): RangeBound {
  return end === 'saved' ? saved : end === 'not a number' ? undefined : end;
}

/** A person's light call: its context (to tell a running script's), what it targets, and the light it asks for. */
export type LightCall = { context: ContextId | undefined; targets: CallTargets; light: CallLight };

/**
 * A person's light call (the lamp-change detector), not caused by a running
 * script, over the lamps it reaches and the rooms it names whole. A switch-on
 * with no part named is a plain switch-on.
 */
function personCall(call: LightCall, model: Model, now: Instant, house: HouseView): Msg[] {
  const id = call.context;
  const byScript = id !== undefined && Object.entries(house.state).some(([entity, state]) =>
    entity.startsWith('script.') && state.state === 'on' && object(state.context).id === id);
  if (byScript) return [];
  const { lamps, rooms } = callReach(call.targets, model.config, house);
  if (lamps.length === 0) return [];
  const [first] = lamps, asked = call.light;
  const light: RequestedLight = asked.power === 'off' ? { power: 'off' }
    : { ...asked, colour: asked.colour === undefined ? undefined : callColour(asked.colour, house, first) };
  return [{ kind: 'lampChangedByPerson', lamps, rooms, light, at: now }];
}

/**
 * A `call_service` event read as a person's light call: a user's `light.turn_on` or `light.turn_off`; none for any
 * other call. A switch-on reads its brightness (absolute, a percent, or a step the domain resolves per lamp), its
 * colour and its effect.
 */
function lightCall(event: JsonObject): LightCall | undefined {
  const context = object(event.context), data = object(event.data);
  if (typeof context.user_id !== 'string' || context.user_id === '') return undefined;
  if (data.domain !== undefined && data.domain !== 'light') return undefined;
  if (data.service !== 'turn_on' && data.service !== 'turn_off') return undefined;
  const sd = object(data.service_data), targets = callTargets(sd);
  return {
    context: typeof context.id === 'string' ? toContextId(context.id) : undefined, targets,
    light: data.service === 'turn_off' ? { power: 'off' }
      : { power: 'on', brightness: requestedBrightness(sd), colour: parseCallColour(sd), effect: requestedEffect(sd.effect) },
  };
}

/** A step is held to ±255: from any level 0 to 255 a larger one comes to the same light. */
function requestedBrightness(sd: JsonObject): RequestedBrightness | undefined {
  const number = (key: string) => {
    const value = sd[key];
    if (typeof value !== 'number') throw new ParseError(`light.turn_on: ${key} is not a number`);
    return value;
  };
  const fixed = (raw: number): RequestedBrightness => ({ kind: 'fixed', brightness: toBrightness(Math.round(Math.min(255, Math.max(0, raw)))) });
  const step = (raw: number): RequestedBrightness => ({ kind: 'step', by: toBrightnessStep(Math.min(255, Math.max(-255, raw))) });
  return 'brightness' in sd ? fixed(number('brightness')) : 'brightness_pct' in sd ? fixed(number('brightness_pct') * 255 / 100)
    : 'brightness_step' in sd ? step(number('brightness_step'))
      : 'brightness_step_pct' in sd ? step(number('brightness_step_pct') * 255 / 100)
        : typeof sd.white === 'number' ? fixed(sd.white) : undefined;
}

/** The candle by name (any case); any other effect named is the normal light. */
function requestedEffect(value: JsonValue | undefined): RequestedEffect | undefined {
  if (typeof value !== 'string') return undefined;
  return value.toLowerCase() === 'candle' ? { kind: 'candle' } : { kind: 'normal' };
}

/** What a light call asks for: off, or on with the brightness, the colour (as the call holds it) and the effect it names. */
type CallLight =
  | { power: 'off' }
  | { power: 'on'; brightness: RequestedBrightness | undefined; colour: CallColour | undefined; effect: RequestedEffect | undefined };

/** Where a press or a command comes from, as far as its run names it: the remote's device, the room, the remote's source. */
export type PressFrom = { device: RemoteId | undefined; room: RoomId | undefined; source: RemoteSource | undefined };

/** The preset buttons, coolest first, by the colour temperature (in mireds) each sends: today's `presets` table. */
const PRESETS: ReadonlyArray<readonly [number, PresetButton]> = [[200, 'coolest'], [285, 'cool'], [370, 'neutral'], [454, 'warm'],
  [588, 'warmest']];

/** Where a press is from, as its run names it; empty text names nothing. */
function pressFrom(device: JsonValue | undefined, room: JsonValue | undefined, source: JsonValue | undefined): PressFrom {
  const named = (value: JsonValue | undefined) => optionalText(value);
  const [remote, area, text] = [named(device), named(room), named(source)];
  return { device: remote === undefined ? undefined : toRemoteId(remote), room: area === undefined ? undefined : toRoomId(area), source: pressSource(text) };
}

/** The remote a press or command is from: the named device, else the remote with the source, else the room's. */
function remoteOf(from: PressFrom, model: Model, house: HouseView): RemoteId {
  const remotes = entriesOf(model.config.remotes), { device, room, source } = from;
  if (device !== undefined && model.config.remotes[device] !== undefined) return device;
  const bySource = Object.values(house.catalog.remotes).find(remote => source !== undefined && remote.source === source);
  if (bySource !== undefined && model.config.remotes[bySource.device_id] !== undefined) return bySource.device_id;
  if (room === undefined) throw new ParseError('The press names no remote and no room');
  const inRoom = remotes.find(([, placed]) => placed.room === room);
  if (inRoom === undefined) throw new ParseError(`No remote of the house is in room ${room}`);
  return inRoom[0];
}

/** A press's source; one spelling a dashboard or native control's key is no catalog remote's (the catalog refuses it), so it names none. */
function pressSource(text: string | undefined): RemoteSource | undefined {
  if (text === undefined) return undefined;
  try {
    return toRemoteSource(text);
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}

/** A dashboard control, as its set names it: by its row's source, or by its set topic's alias. */
export type ControlNamed = { kind: 'row'; source: DashboardControlId } | { kind: 'topic'; alias: string };

/** The catalog's row a control set names: by its source, or by the alias in its power topic. */
function controlRow(control: ControlNamed, house: HouseView): UiRow | undefined {
  return uiRowsOf(house.catalog).find(candidate => control.kind === 'row' ? candidate.source === control.source
    : candidate.topics.power?.split('/')[3] === control.alias);
}

/** The commands a room's remote sends (`ls_remote_command`). */
const COMMANDS: readonly RemoteCommand[] = ['up', 'down', 'left', 'right', 'toggle', 'reset', 'mode'];

/** A control's set value, read by the attribute it sets. */
export type ControlValue =
  | { attribute: 'power'; power: Power }
  | { attribute: 'brightness'; brightness: Brightness }
  | { attribute: 'temperature'; colour: Colour }
  | { attribute: 'rgb'; colour: Colour }
  | { attribute: 'effect'; effect: EffectName };

function controlLight(value: ControlValue): ControlLight {
  const none = { brightness: undefined, colour: undefined, effect: undefined };
  switch (value.attribute) {
    case 'power': return value.power === 'off' ? { power: 'off' } : { power: 'on', ...none };
    case 'brightness': return { power: 'on', ...none, brightness: { kind: 'fixed', brightness: value.brightness } };
    case 'temperature': case 'rgb': return { power: 'on', ...none, colour: { kind: 'fixed', colour: value.colour } };
    case 'effect': return { power: 'on', ...none, effect: value.effect === 'Candle' ? { kind: 'candle' } : { kind: 'normal' } };
  }
}

/** A control's set value, read as text (as the old scripts' templates read it) by the attribute it sets. */
function controlValue(attribute: string, value: JsonValue | undefined): ControlValue {
  const text = jinjaString(value === undefined ? null : value);
  switch (attribute) {
    case 'power': return { attribute, power: powerNamed(text, 'ON', 'OFF', 'a control\'s power') };
    case 'brightness': return { attribute, brightness: toBrightness(wholeNumber(text, 0, 255)) };
    case 'temperature': return { attribute, colour: miredsColour(text) };
    case 'rgb': return { attribute, colour: rgbColour(text) };
    case 'effect': return { attribute, effect: effectName(text) };
    default: throw new ParseError(`effects_set: ${attribute} is not a control`);
  }
}

/** A control's value as the profile change `ls_store` makes of it. */
function profileChange(value: ControlValue): LampProfileChange {
  const none = { own: undefined, power: undefined, brightness: undefined, colour: undefined, effect: undefined };
  switch (value.attribute) {
    case 'power': return { ...none, power: value.power };
    case 'brightness': return { ...none, brightness: value.brightness };
    case 'temperature': return { ...none, colour: value.colour };
    case 'effect': return { ...none, effect: value.effect };
    case 'rgb': throw new ParseError(`effects_set: ${value.attribute} is not saved in a profile`);
  }
}

function wholeNumber(text: string, low: number, high: number): number {
  const number = Number(text);
  if (text.trim() === '' || !Number.isFinite(number) || number < low || number > high) throw new ParseError(`${text} is not ${low}..${high}`);
  return Math.round(number);
}

function miredsColour(text: string): Colour {
  return { kind: 'kelvin', kelvin: toKelvin(Math.round(1_000_000 / wholeNumber(text, 100, 1000))) };
}

function rgbColour(text: string): Colour {
  const parts = text.split(',').map(part => toColourChannel(wholeNumber(part, 0, 255)));
  const [red, green, blue] = parts;
  if (parts.length !== 3 || red === undefined || green === undefined || blue === undefined) throw new ParseError('RGB needs three components.');
  return { kind: 'rgb', rgb: { red, green, blue } };
}

/** A store save (today's `ls_store`): the profile or block light the store is, and the fields it sets. */
export type StoreSave = { target: StoreTarget; change: LampProfileChange };

/** A store save, its store read against the config and its name. Raises a `ParseError` for a store that is neither. */
function storeSaveOf(store: EntityId, change: LampProfileChange, model: Model): StoreSave {
  const profile = profileStoreOf(store, model), light = profile === undefined ? blockLightOf(store) : undefined;
  const target: StoreTarget | undefined = profile ?? (light === undefined ? undefined : { kind: 'block light', ...light });
  if (target === undefined) throw new ParseError(`ls_store: ${store} is no lamp's or plug's profile and names no block's light`);
  return { target, change };
}

/**
 * A lamp's or a plug's store save is its profile for the block, saved through
 * the Model; a plug's save keeps only `own` and `on`. A block light's save is
 * a config helper, which the loop writes as it is and reads as the config the
 * helpers will hold: no message here.
 */
function profileSaved(save: StoreSave, now: Instant): Msg[] {
  const found = save.target;
  if (found.kind === 'block light') return [];
  if (found.kind === 'lamp') return [{ kind: 'lampProfileSaved', lamp: found.lamp, block: found.block, change: save.change, at: now }];
  const change = { own: save.change.own, power: save.change.power };
  return [{ kind: 'switchProfileSaved', switch: found.switch, block: found.block, change, at: now }];
}

/** What a store is: a lamp's or a plug's profile for a block, or the house's or a room's light for a block. */
export type StoreTarget = ProfileStore | ({ kind: 'block light' } & BlockLight);

/** A store that is a profile: a lamp's or a plug's, for a block. */
export type ProfileStore = { kind: 'lamp'; lamp: LampId; block: Block } | { kind: 'switch'; switch: SwitchId; block: Block };

/** The lamp or plug of the config and the block a store is the profile of: `input_text.ls_lamp_<object>_<block>`. */
function profileStoreOf(store: string, model: Model): ProfileStore | undefined {
  const match = /^input_text\.ls_lamp_(.+)_(day|cosy|night)$/.exec(store);
  const object = match?.[1], block = BLOCKS.find(known => known === match?.[2]);
  if (object === undefined || block === undefined) return undefined;
  const lamp = toLampId(`light.${object}`), plug = toSwitchId(`switch.${object}`);
  if (model.config.lamps[lamp] !== undefined) return { kind: 'lamp', lamp, block };
  return model.config.switches[plug] === undefined ? undefined : { kind: 'switch', switch: plug, block };
}

/** What the host makes of a bridge run: an input to run, the echo of a call of ours (dropped quietly), or dropped, and why. */
export type BridgeVerdict = { kind: 'input'; input: HaInput } | { kind: 'echo' } | { kind: 'dropped'; why: string };

/** What the host knows of its own calls: the context ids of the recent ones, and whether one failed as the run came. */
export type OwnCalls = { contexts: readonly string[]; callFailed: boolean };

/** A bridge event (`smarthome_script`): the script or automation it forwards, and its arguments. */
export function bridgeRunOf(data: JsonObject): { script: string; args: JsonObject } {
  return { script: String(data.script), args: object(data.args) };
}

/**
 * A bridge run, read against our own calls: a run our own call may trigger is that call's echo when its context is
 * one of ours, and is dropped when it came as a call failed, since it cannot be told from a person's. Otherwise it is
 * an input, or dropped: a dry run, or a name that is not an input.
 */
export function bridgeVerdict(script: string, args: JsonObject, catalog: Pick<Catalog, 'remotes' | 'mode'>, own: OwnCalls): BridgeVerdict {
  if (echoed(script, catalog.mode)) {
    if (own.callFailed) return { kind: 'dropped', why: `${script} came as a call failed` };
    const context = echoContext(args);
    if (context !== undefined && own.contexts.includes(context)) return { kind: 'echo' };
  }
  const input = scriptInput(script, args, catalog);
  if (input === 'dry run') return { kind: 'dropped', why: `${script} is a dry run` };
  if (input === 'not ours') return { kind: 'dropped', why: `${script} is not an input` };
  return { kind: 'input', input };
}

/**
 * The bridge runs that may be the echo of a call of ours: a mode switch or a lamp change our own write made comes
 * back through the bridge, and is not a person's. Each carries the context of the change that triggered it.
 */
function echoed(script: string, mode: HouseMode | undefined): boolean {
  return script === 'automation.lighting_schedule_lamp_change_detector' || (mode !== undefined && script === mode.switched);
}

/** The context id of the change that triggered a bridge run: its new state's, or its event's; none when it carries none. */
function echoContext(args: JsonObject): string | undefined {
  const trigger = object(args.trigger);
  const context = object(object(trigger.to_state).context).id ?? object(object(trigger.event).context).id;
  return typeof context === 'string' ? context : undefined;
}

/**
 * What the reconciler saw change with no send of ours to explain it, as messages: a switch that changed is its own
 * button pressed (owner, 2026-11-22: an override). A bulb back on is the reconciler's own business, no message.
 */
export function unexplainedMessages(found: readonly Unexplained[], now: Instant): Msg[] {
  return found.flatMap((change): Msg[] => change.kind === 'switch pressed'
    ? [{ kind: 'switchButtonPressed', switch: change.switch, power: change.power, at: now }] : []);
}

/**
 * The store save an input makes: an `ls_store` call, or a dashboard control
 * set on a profile row. Undefined for any other input.
 */
export function storeSaveIn(input: HaInput, house: HouseView, model: Model): StoreSave | undefined {
  if (input.kind === 'store saved') return storeSaveOf(input.store, input.change, model);
  if (input.kind !== 'control set') return undefined;
  const row = controlRow(input.control, house);
  return row === undefined || row.store === undefined ? undefined : storeSaveOf(toEntityId(row.store), profileChange(input.value), model);
}

/** A power by the text the wire names it with, `on` for on and `off` for off; any other value is not a power. */
function powerNamed(value: JsonValue | undefined, on: string, off: string, context: string): Power {
  if (value === on) return 'on';
  if (value === off) return 'off';
  throw new ParseError(`${context}: ${describe(value)} is not on or off`);
}

function optionalText(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function effectName(text: string): EffectName {
  return text.toLowerCase() === 'candle' ? 'Candle' : 'Normal';
}
