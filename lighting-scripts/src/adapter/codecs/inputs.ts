/**
 * Home Assistant's inputs, read into messages (spec 5.1). `haInput` names
 * what a script or automation run is, reading no more than the trigger needs
 * to tell; `messages` reads the rest into the Model's messages, against the
 * Model and the house as Home Assistant shows them at the input.
 *
 * Moved here from the old shells: the person-change detector's rules (a
 * user, a light call, not caused by a running script) from the lamp-change
 * automation, the remote presses from the gesture scripts, the range save's
 * checks from `decideRangeSave`, the dashboard's scripts and the override
 * event's operations from `ls_commit`, and the native controls from
 * `effects_set`.
 *
 * A field that cannot be read raises a `ParseError`; the loop logs it and
 * drops the input.
 */
import type { Block } from '../../domain/blocks.ts';
import { BLOCKS } from '../../domain/blocks.ts';
import type { EffectName } from '../../domain/effect.ts';
import type {
  ControlLight, LampProfileChange, Model, Msg, PresetButton, RangeDefaults, RangeRule, RemoteButton, RequestedBrightness, RequestedEffect,
  RequestedLight,
} from '../../domain/model.ts';
import type { LampId, RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Colour, PercentRange, Power } from '../../domain/types/light.ts';
import type { LampOrRoom } from '../../domain/types/lighting-state.ts';
import type { RemoteCommand } from '../../domain/types/remote.ts';
import type { RoomOrHouse } from '../../domain/types/schedule.ts';
import type { Instant } from '../../domain/types/time.ts';
import { onOffOnly, ownRange, storedRangeBounds } from './ui-state.ts';
import type { RangeBound } from './ui-state.ts';
import {
  percentRangeOf, toBrightness, toBrightnessStep, toColourChannel, toDashboardControlId, toKelvin, toLampId, toRemoteId, toRoomId, toSwitchId,
} from './ids.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import type { HouseView } from './house.ts';
import { ParseError, isObject, jinjaString, object, requireBoolean, requireString } from './parse.ts';
import { configSource, reportsOn } from './model.ts';
import { callColour, callReach } from './native-call.ts';
import type { Unexplained } from '../reconcile.ts';
import type { CatalogRemote } from './catalog.ts';

/** What happened in Home Assistant, as a script or automation run names it. Fields are read by `messages`. */
export type HaInput =
  /** Home Assistant started: everything is read again. */
  | { kind: 'started' }
  /** The minute's clock. */
  | { kind: 'tick' }
  /** A wake the loop asked for, or a render request: the clock at the instant. */
  | { kind: 'wake' }
  /** A helper the config or a profile is read from changed: the config and the profiles are read again. */
  | { kind: 'helper changed' }
  /** Lamps switched back on from outside (wall power, or a named apply): their bulbs are sent their light again. */
  | { kind: 'state changed'; entities: readonly string[] }
  /** The `ls_override` event, as `ls_commit` and the store writer took it. */
  | { kind: 'overlay event'; data: JsonObject }
  | { kind: 'dashboard script'; script: 'hold block' | 'clear overlays' | 'save range' | 'toggle mode'; data: JsonObject }
  /** A `call_service` event: a person's light call, read by the detector's rules. */
  | { kind: 'service called'; event: JsonObject }
  /** The mode mirror switched in the dashboard. */
  | { kind: 'mode switched'; on: boolean; user: JsonValue | undefined }
  /** A remote's button: the kind of automation or gesture script that saw it, and its trigger. */
  | { kind: 'remote action'; room: string | undefined; device: string | undefined; source: string | undefined; button: RemoteAction }
  /** A command sent for a room's remote (`ls_remote_command`). */
  | { kind: 'remote command'; data: JsonObject }
  /** A dashboard control's MQTT set topic (`effects_native_light_controls`). */
  | { kind: 'effect preview'; topic: string | undefined; payload: JsonValue | undefined }
  /** A dashboard control's set, by its row's source (`effects_set`). */
  | { kind: 'control set'; data: JsonObject }
  /** A profile store save (`ls_store`). */
  | { kind: 'store saved'; data: JsonObject };

/**
 * A script or automation run Home Assistant's bridge forwards, read as an input: a dry run asks and changes nothing
 * (the bridge never forwards one; the old scripts answered it), and a name that is not one of ours is no input. A
 * room's own gesture script (`ls_remote_gesture_<room>`, `ls_remote_power_quiet_<room>`) is the shared one, bound to
 * that room's remote in the catalog.
 */
export function scriptInput(script: string, args: JsonObject, remotes: Readonly<Record<string, CatalogRemote>>): HaInput | 'dry run' | 'not ours' {
  if (args.dry_run === true) return 'dry run';
  const named = ROOM_GESTURE.exec(script);
  const room = named === null ? undefined : named[2];
  const remote = room === undefined ? undefined : remotes[room];
  const input = named === null || room === undefined ? haInput(script, args)
    : haInput(`${named[1]}`, { ...(remote === undefined ? {} : { device_id: remote.device_id, source: remote.source }), ...args, room });
  return input === undefined ? 'not ours' : input;
}

/** A room's own gesture script: the shared script's name, then the room. */
const ROOM_GESTURE = /^(ls_remote_gesture|ls_remote_power_quiet)_(.+)$/;

/**
 * The input a script or automation run is; undefined when the name is not one
 * of ours. Reads only what tells the inputs apart, and never raises.
 */
export function haInput(script: string, args: JsonObject): HaInput | undefined {
  const trigger = object(args.trigger);
  const remote = REMOTE_AUTOMATION.exec(script);
  if (remote !== null) return remoteAutomation(remote[1], args, trigger);
  switch (script) {
    case 'automation.lighting_schedule_engine': return scheduleEngine(trigger);
    case 'automation.lighting_schedule_end_overrides':
    case 'automation.lighting_recover_pending_output':
    case 'automation.effects_refresh_native_light_controls': return { kind: 'tick' };
    case 'automation.switch_lamps_validate_house_defaults': return { kind: 'helper changed' };
    case 'automation.lighting_schedule_sara_mode_switch':
      return { kind: 'mode switched', on: trigger.id === 'on', user: object(object(trigger.to_state).context).user_id };
    case 'automation.lighting_schedule_lamp_change_detector': return { kind: 'service called', event: object(trigger.event) };
    case 'automation.lighting_schedule_override_store_writer': return { kind: 'overlay event', data: object(object(trigger.event).data) };
    case 'automation.effects_native_light_controls':
      return { kind: 'effect preview', topic: optionalText(trigger.topic), payload: trigger.payload };
    case 'ls_commit': return { kind: 'overlay event', data: object(args.data) };
    case 'ls_override_block': return { kind: 'dashboard script', script: 'hold block', data: args };
    case 'ls_clear_overrides': return { kind: 'dashboard script', script: 'clear overlays', data: args };
    case 'ls_range_save': return { kind: 'dashboard script', script: 'save range', data: args };
    case 'ls_sara_mode': return { kind: 'dashboard script', script: 'toggle mode', data: args };
    case 'ls_remote_gesture': return gesture(args);
    case 'ls_remote_command': return { kind: 'remote command', data: args };
    case 'effects_set': return { kind: 'control set', data: args };
    case 'ls_store': return { kind: 'store saved', data: args };
    case 'ls_apply': return Array.isArray(args.lights) ? { kind: 'state changed', entities: texts(args.lights) } : { kind: 'wake' };
    case 'ls_remote_power_quiet': case 'ls_render': case 'ls_dispatch': case 'ls_wake': case 'effects_ui_sync': case 'effects_ui_catalog':
      return { kind: 'wake' };
    default: return undefined;
  }
}

function remoteAutomation(kind: string | undefined, args: JsonObject, trigger: JsonObject): HaInput {
  const button: RemoteAction = kind === 'center' ? { kind: 'power' }
    : kind === 'directions' ? { kind: 'direction', id: trigger.id } : { kind: 'preset', payload: trigger.payload_json };
  return { kind: 'remote action', room: optionalText(args.room), device: optionalText(args.device_id), source: optionalText(args.source), button };
}

/** The remote automations, by the kind their name ends in: the center button, the arrows, the preset buttons. */
const REMOTE_AUTOMATION = /^automation\.(?:.*_)?remote_(center|directions|preset)(?:_arrows)?$/;

/** The schedule engine's triggers: the minute, the start, a lamp back on, and the config helpers. */
function scheduleEngine(trigger: JsonObject): HaInput {
  switch (trigger.id) {
    case 'tick': return { kind: 'tick' };
    case 'start': return { kind: 'started' };
    case 'lamp_on': return { kind: 'state changed', entities: typeof trigger.entity_id === 'string' ? [trigger.entity_id] : [] };
    default: return { kind: 'helper changed' };
  }
}

/** A gesture script's command; `power_done` is the burst's window closing, which the clock closes now. */
function gesture(args: JsonObject): HaInput {
  const room = optionalText(args.room), device = optionalText(args.device_id), source = optionalText(args.source);
  switch (args.command) {
    case 'power': return { kind: 'remote action', room, device, source, button: { kind: 'power' } };
    case 'cancel': return { kind: 'remote action', room, device, source, button: { kind: 'cancel' } };
    case 'preset': return { kind: 'remote action', room, device, source, button: { kind: 'preset', payload: args.payload } };
    case 'left': case 'right': case 'up': case 'down':
      return { kind: 'remote action', room, device, source, button: { kind: 'direction', id: args.command } };
    default: return { kind: 'wake' };
  }
}

/**
 * The messages an input sends, read against the Model and the house at `now`.
 * The clock is the loop's; these are the input's own. Raises a `ParseError`
 * for a field that cannot be read.
 */
export function messages(input: HaInput, model: Model, now: Instant, house: HouseView): Msg[] {
  switch (input.kind) {
    case 'started': case 'tick': case 'wake': case 'helper changed': case 'state changed': return [];
    case 'overlay event': return overlayEvent(input.data, model, now, house);
    case 'dashboard script': return dashboardScript(input.script, input.data, model, now, house);
    case 'service called': return personCall(input.event, model, now, house);
    case 'mode switched': return typeof input.user === 'string' && input.user !== '' ? [{ kind: 'modeToggled', on: input.on, at: now }] : [];
    case 'remote action': return remoteAction(input, model, now, house);
    case 'remote command': return remoteCommand(input.data, model, now, house);
    case 'effect preview': return effectPreview(input.topic, input.payload, model, now, house);
    case 'control set': return controlSet(requireString(input.data, 'source', 'effects_set'),
      requireString(input.data, 'attribute', 'effects_set'), input.data.value, model, now, house);
    case 'store saved': return profileSaved(storeSaveOf(input.data), model, now);
  }
}

/**
 * A remote's button: the remote is the press's device, else its room's; a
 * room the config holds no remote for drops the press. `anyOn` is what the
 * room reports at the press.
 */
function remoteAction(input: Extract<HaInput, { kind: 'remote action' }>, model: Model, now: Instant, house: HouseView): Msg[] {
  const button = remoteButton(input.button);
  if (button === undefined) return [];
  const remote = remoteOf(input.device, input.room, input.source, model, house);
  return [{ kind: 'remoteButtonPressed', remote, button, anyOn: roomReportsOn(model, remote, house), at: now }];
}

function optionalText(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The override event's operations the Model holds: clear all, a room's power,
 * a block held, the mode on or off, a switch's range and the range defaults.
 * Other operations, and a set's other records (a lamp's channels, a remote's
 * records), are not read here: they raise, so the input is logged once and
 * dropped.
 */
function overlayEvent(data: JsonObject, model: Model, now: Instant, house: HouseView): Msg[] {
  switch (data.op) {
    case 'clear_all': return [{ kind: 'overlayRequested', request: { kind: 'clear all' }, at: now }];
    case 'power': {
      const room = toRoomId(requireString(data, 'area', 'ls_override'));
      const power: Power = requireBoolean(data.on, 'ls_override.on') ? 'on' : 'off';
      return [{ kind: 'overlayRequested', request: { kind: 'room power', room, power }, at: now }];
    }
    case 'set': return (Array.isArray(data.records) ? data.records : []).flatMap((raw): Msg[] => {
      const record = object(raw);
      if (record.kind === 'mode' && record.target === 'sara') return [{ kind: 'modeToggled', on: true, at: now }];
      if (record.kind !== 'block' || typeof record.target !== 'string') {
        throw new ParseError(`ls_override: record ${jinjaString(record.kind === undefined ? null : record.kind)} is not read here`);
      }
      return [{ kind: 'overlayRequested', request: { kind: 'hold block', over: scopeOf(record.target), block: blockOf(record.value) }, at: now }];
    });
    case 'clear': return Array.isArray(data.keys) && data.keys.includes('mode:sara') ? [{ kind: 'modeToggled', on: false, at: now }] : [];
    case 'range_set': return rangeSet(data, model, now, house);
    case 'range_defaults': return [{ kind: 'rangeDefaultsSaved', defaults: rangeDefaults(object(data.ranges)), at: now }];
    default: throw new ParseError(`ls_override: operation ${jinjaString(data.op)} is not read here`);
  }
}

function scopeOf(text: string): RoomOrHouse {
  return text === 'house' ? 'house' : toRoomId(text);
}

function blockOf(value: JsonValue | undefined): Block {
  const block = BLOCKS.find(known => typeof value === 'string' && known === value.toLowerCase());
  if (block === undefined) throw new ParseError(`Not a block: ${jinjaString(value)}`);
  return block;
}

/** A switch's range from the override event: as `ls_range_save` sends it, checked again. */
function rangeSet(data: JsonObject, model: Model, now: Instant, house: HouseView): Msg[] {
  return rangeSaved(requireString(data, 'entity', 'ls_override'), typeof data.profile === 'string' ? data.profile : 'bright',
    bound(data.min), bound(data.max), model, now, house);
}

/**
 * A switch's range rule saved, after today's checks (`decideRangeSave`): a
 * physical switch or on/off-only light with a device, in a room, and a rule
 * that is bright, cosy, or an own range in order inside 0..100. A missing
 * own-range end keeps the saved one. A save that fails a check raises.
 */
/** Today's refusal of a range save that names no physical switch or on/off lamp. */
const NOT_PHYSICAL = 'Choose a physical on/off lamp or smart plug.';

function rangeSaved(named: string | undefined, profile: string, minimum: RangeBound, maximum: RangeBound, model: Model, now: Instant,
  house: HouseView): Msg[] {
  if (named === undefined) throw new ParseError(NOT_PHYSICAL);
  const entity = named, domain = entity.split('.')[0];
  const physical = (domain === 'switch' || domain === 'light') && house.state[entity] !== undefined
    && Object.values(house.devices === undefined ? {} : house.devices).some(entities => entities.includes(entity))
    && !/^(switch|light)\.(ls_|ep_)/.test(entity) && !entity.includes('permit_join');
  if (!physical) throw new ParseError(NOT_PHYSICAL);
  if (domain === 'light' && !onOffOnly(house, entity)) {
    throw new ParseError('Choose an on/off lamp; dimmable lamps use the normal lighting settings.');
  }
  const room = house.rooms.ofId[entity];
  if (room === undefined) throw new ParseError('Assign this lamp to a room before configuring its range.');
  const rule = rangeRule(profile, entity, minimum, maximum, house);
  return [{ kind: 'rangeSaved', switch: toSwitchId(entity), rule, room, at: now }];
}

function rangeRule(profile: string, entity: string, minimum: RangeBound, maximum: RangeBound, house: HouseView): RangeRule {
  if (profile === 'bright' || profile === 'cosy') return { kind: profile };
  if (profile !== 'custom') throw new ParseError('Choose Bright Default, Cosy Default, or Own Range.');
  const saved = storedRangeBounds(house, entity);
  const range = ownRange(minimum === undefined || minimum === null ? saved.min : minimum,
    maximum === undefined || maximum === null ? saved.max : maximum);
  if (range === undefined) throw new ParseError('Enter both ends of Own Range: 0–100%, with From no higher than Through.');
  return { kind: 'custom', range };
}

function bound(value: JsonValue | undefined): RangeBound {
  return value === undefined || value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
    ? value : undefined;
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

/** The dashboard's scripts: hold a block, clear every overlay, save a switch's range, toggle the mode. */
function dashboardScript(script: 'hold block' | 'clear overlays' | 'save range' | 'toggle mode', data: JsonObject, model: Model, now: Instant,
  house: HouseView): Msg[] {
  switch (script) {
    case 'hold block': return [{ kind: 'overlayRequested', at: now,
      request: { kind: 'hold block', over: scopeOf(requireString(data, 'scope', 'ls_override_block')), block: blockOf(data.block) } }];
    case 'clear overlays': return [{ kind: 'overlayRequested', request: { kind: 'clear all' }, at: now }];
    case 'toggle mode': return [{ kind: 'modeToggled', on: !model.modeOverlay.active, at: now }];
    case 'save range': return rangeSaved(optionalText(data.entity),
      typeof data.profile === 'string' ? data.profile : 'bright', bound(data.minimum), bound(data.maximum), model, now, house);
  }
}

/**
 * A person's light call (the lamp-change detector): a user's `light.turn_on`
 * or `light.turn_off`, not caused by a running script, over the lamps it
 * reaches and the rooms it names whole. A switch-on reads its brightness,
 * colour and effect; with none it is a plain switch-on.
 */
function personCall(event: JsonObject, model: Model, now: Instant, house: HouseView): Msg[] {
  const context = object(event.context), data = object(event.data);
  if (typeof context.user_id !== 'string' || context.user_id === '') return [];
  if (data.domain !== undefined && data.domain !== 'light') return [];
  if (data.service !== 'turn_on' && data.service !== 'turn_off') return [];
  const id = context.id;
  const byScript = typeof id === 'string' && Object.entries(house.state).some(([entity, state]) =>
    entity.startsWith('script.') && state.state === 'on' && object(state.context).id === id);
  if (byScript) return [];
  const sd = object(data.service_data);
  const { lamps, rooms } = callReach(sd, model.config, house);
  if (lamps.length === 0) return [];
  const light: RequestedLight = data.service === 'turn_off' ? { power: 'off' } : requestedLight(sd, lamps, house);
  return [{ kind: 'lampChangedByPerson', lamps, rooms, light, at: now }];
}

/** What a switch-on sets: a brightness (absolute, a percent, or a step the domain resolves per lamp), a colour, an effect. */
function requestedLight(sd: JsonObject, lamps: readonly LampId[], house: HouseView): RequestedLight {
  const [first] = lamps;
  return { power: 'on', brightness: requestedBrightness(sd), colour: callColour(sd, house, first), effect: requestedEffect(sd.effect) };
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

function remoteCommand(data: JsonObject, model: Model, now: Instant, house: HouseView): Msg[] {
  const command = COMMANDS.find(known => known === data.command);
  if (command === undefined) throw new ParseError(`ls_remote_command: ${jinjaString(data.command)} is not a command`);
  const remote = remoteOf(optionalText(data.device_id), optionalText(data.area), optionalText(data.source), model, house);
  return [{ kind: 'remotePressed', remote, command, anyOn: roomReportsOn(model, remote, house), at: now }];
}

/** The remote a press or command is from: the named device, else the remote with the source, else the room's. */
function remoteOf(device: string | undefined, room: string | undefined, source: string | undefined, model: Model, house: HouseView): RemoteId {
  const remotes = entriesOf(model.config.remotes);
  if (device !== undefined && model.config.remotes[toRemoteId(device)] !== undefined) return toRemoteId(device);
  const bySource = Object.values(house.catalog.remotes).find(remote => source !== undefined && remote.source === source);
  if (bySource !== undefined && model.config.remotes[bySource.device_id] !== undefined) return bySource.device_id;
  if (room === undefined) throw new ParseError('The press names no remote and no room');
  const inRoom = remotes.find(([, placed]) => placed.room === room);
  if (inRoom === undefined) throw new ParseError(`No remote of the house is in room ${room}`);
  return inRoom[0];
}

/** The preset buttons, coolest first, by the colour temperature (in mireds) each sends: today's `presets` table. */
const PRESETS: ReadonlyArray<readonly [number, PresetButton]> = [[200, 'coolest'], [285, 'cool'], [370, 'neutral'], [454, 'warm'],
  [588, 'warmest']];

function roomReportsOn(model: Model, remote: RemoteId, house: HouseView): boolean {
  const room = model.config.remotes[remote]?.room;
  return room !== undefined && reportsOn(configSource(house), model.config, model.switchRanges, room);
}

/** A dashboard control's MQTT set: the row its topic's alias names, then as `effects_set`. */
function effectPreview(topic: string | undefined, payload: JsonValue | undefined, model: Model, now: Instant, house: HouseView): Msg[] {
  if (topic === undefined) throw new ParseError('A control set with no topic');
  const parts = topic.split('/'), alias = parts[3], attribute = parts.at(-1);
  if (alias === undefined || attribute === undefined) throw new ParseError(`Not a control topic: ${topic}`);
  const row = uiRowsOf(house).find(candidate => candidate.topics.power?.split('/')[3] === alias);
  if (row === undefined) throw new ParseError(`No dashboard control for ${alias}`);
  return controlSet(row.source, attribute, payload, model, now, house);
}

/**
 * A dashboard control set (today's `effects_set`): on a lamp's profile row,
 * the profile saved for its block; on a live control, a control overlay on
 * the lamp, or on the room it covers whole, whose power switches the room.
 * The OFF of a lamp's control is its off hold, the ON the hold's end.
 */
function controlSet(source: string, attribute: string, value: JsonValue | undefined, model: Model, now: Instant, house: HouseView): Msg[] {
  const row = uiRowsOf(house).find(candidate => candidate.source === source);
  if (row === undefined) throw new ParseError(`effects_set: no dashboard control for ${source}`);
  if (row.store !== undefined) return profileSaved(storeSaveOf({ store: row.store, ...storeField(attribute, value) }), model, now);
  const over = controlOver(row, model);
  if (over === undefined) throw new ParseError(`effects_set: ${source} is over no lamp of the house`);
  const light = controlLight(attribute, value);
  if (attribute === 'power' && over.kind === 'room') {
    return [{ kind: 'overlayRequested', request: { kind: 'room power', room: over.room, power: light.power }, at: now }];
  }
  return [{ kind: 'overlayRequested', request: { kind: 'dashboard control', control: toDashboardControlId(source), over, light }, at: now }];
}

/** The commands a room's remote sends (`ls_remote_command`). */
const COMMANDS: readonly RemoteCommand[] = ['up', 'down', 'left', 'right', 'toggle', 'reset', 'mode'];

function controlLight(attribute: string, value: JsonValue | undefined): ControlLight {
  const text = jinjaString(value === undefined ? null : value);
  const none = { brightness: undefined, colour: undefined, effect: undefined };
  switch (attribute) {
    case 'power': return text === 'OFF' ? { power: 'off' } : { power: 'on', ...none };
    case 'brightness': return { power: 'on', ...none, brightness: { kind: 'fixed', brightness: toBrightness(wholeNumber(text, 0, 255)) } };
    case 'temperature': return { power: 'on', ...none, colour: { kind: 'fixed', colour: miredsColour(text) } };
    case 'rgb': return { power: 'on', ...none, colour: { kind: 'fixed', colour: rgbColour(text) } };
    case 'effect': return { power: 'on', ...none, effect: text.toLowerCase() === 'candle' ? { kind: 'candle' } : { kind: 'normal' } };
    default: throw new ParseError(`effects_set: ${attribute} is not a control`);
  }
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

/** A remote button as its automation or gesture script reports it, before it is read. */
export type RemoteAction =
  | { kind: 'power' } | { kind: 'cancel' }
  | { kind: 'direction'; id: JsonValue | undefined }
  | { kind: 'preset'; payload: JsonValue | undefined };

function remoteButton(action: RemoteAction): RemoteButton | undefined {
  switch (action.kind) {
    case 'power': return { kind: 'power' };
    case 'cancel': return { kind: 'cancel' };
    case 'direction': {
      const id = action.id;
      return id === 'up' || id === 'down' || id === 'left' || id === 'right' ? { kind: 'arrow', direction: id } : undefined;
    }
    case 'preset': {
      if (!isObject(action.payload) || action.payload.action !== 'color_temperature_move') return undefined;
      const mireds = action.payload.action_color_temperature;
      return { kind: 'preset', button: PRESETS.find(([preset]) => preset === mireds)?.[1] };
    }
  }
}

/** A UI row of the catalog: the control's source, its proxy, its profile store (none for a live control), its members and topics. */
export type UiRow = {
  source: string; proxy: string | undefined; store: string | undefined; members: string[]; topics: Partial<Record<string, string>>;
};

/** The catalog's UI rows; a row without a source is left out. */
export function uiRowsOf(house: Pick<HouseView, 'catalog'>): UiRow[] {
  return (house.catalog.ui_rows === undefined ? [] : house.catalog.ui_rows).flatMap(raw => {
    const row = object(raw);
    if (typeof row.source !== 'string') return [];
    const store = typeof row.store === 'string' && row.store !== '' ? row.store : undefined;
    const topics = Object.fromEntries(Object.entries(object(row.topics)).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []));
    const proxy = typeof row.proxy === 'string' ? row.proxy : undefined;
    return [{ source: row.source, proxy, store, members: Array.isArray(row.members) ? texts(row.members) : [], topics }];
  });
}

/** A live control is over the room whose every lamp it holds, else over its source lamp (or its first member lamp). */
export function controlOver(row: Pick<UiRow, 'source' | 'members'>, model: Model): LampOrRoom | undefined {
  const config = model.config;
  const members = row.members.map(toLampId).filter(lamp => config.lamps[lamp] !== undefined);
  for (const [room] of entriesOf(config.rooms)) {
    const all = entriesOf(config.lamps).flatMap(([lamp, placed]) => placed.room === room ? [lamp] : []);
    if (members.length > 1 && all.length > 0 && all.every(lamp => members.includes(lamp))) return { kind: 'room', room };
  }
  const source = toLampId(row.source);
  if (config.lamps[source] !== undefined) return { kind: 'lamp', lamp: source };
  const [first] = members;
  return first === undefined ? undefined : { kind: 'lamp', lamp: first };
}

/** A profile store save: the store and the fields it sets (today's `ls_store`). */
export type StoreSave = { store: string; change: LampProfileChange };

function storeSaveOf(data: JsonObject): StoreSave {
  const store = requireString(data, 'store', 'ls_store');
  const kelvin = typeof data.kelvin === 'number' ? data.kelvin : typeof data.mireds === 'number' && data.mireds > 0 ? 1_000_000 / data.mireds
    : undefined;
  return {
    store,
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
 * A lamp's or a plug's store save is its profile for the block, saved through
 * the Model; a plug's save keeps only `own` and `on`. Any other store is a
 * config helper (a block's light), which the loop writes as it is and reads
 * as the config the helpers will hold: no message here.
 */
function profileSaved(save: StoreSave, model: Model, now: Instant): Msg[] {
  const found = profileStoreOf(save.store, model);
  if (found === undefined) return [];
  if (found.kind === 'lamp') return [{ kind: 'lampProfileSaved', lamp: found.lamp, block: found.block, change: save.change, at: now }];
  const change = { own: save.change.own, power: save.change.power };
  return [{ kind: 'switchProfileSaved', switch: found.switch, block: found.block, change, at: now }];
}

function powerOf(on: boolean): Power {
  return on ? 'on' : 'off';
}

function effectName(text: string): EffectName {
  return text.toLowerCase() === 'candle' ? 'Candle' : 'Normal';
}

/** A store that is a profile: a lamp's or a plug's, for a block. */
export type ProfileStore = { kind: 'lamp'; lamp: LampId; block: Block } | { kind: 'switch'; switch: SwitchId; block: Block };

/** The lamp or plug of the config and the block a store is the profile of: `input_text.ls_lamp_<object>_<block>`. */
export function profileStoreOf(store: string, model: Model): ProfileStore | undefined {
  const match = /^input_text\.ls_lamp_(.+)_(day|cosy|night)$/.exec(store);
  const object = match?.[1], block = BLOCKS.find(known => known === match?.[2]);
  if (object === undefined || block === undefined) return undefined;
  const lamp = toLampId(`light.${object}`), plug = toSwitchId(`switch.${object}`);
  if (model.config.lamps[lamp] !== undefined) return { kind: 'lamp', lamp, block };
  return model.config.switches[plug] === undefined ? undefined : { kind: 'switch', switch: plug, block };
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
export function storeSaveIn(input: HaInput, house: HouseView): StoreSave | undefined {
  if (input.kind === 'store saved') return storeSaveOf(input.data);
  const set = input.kind === 'control set' ? input.data
    : input.kind === 'effect preview' && input.topic !== undefined ? previewSet(input.topic, input.payload, house) : undefined;
  if (set === undefined || typeof set.source !== 'string' || typeof set.attribute !== 'string') return undefined;
  const source = set.source;
  const row = uiRowsOf(house).find(candidate => candidate.source === source);
  return row === undefined || row.store === undefined ? undefined : storeSaveOf({ store: row.store, ...storeField(set.attribute, set.value) });
}

/** A control topic's set as `effects_set` takes it: the row's source, the attribute and the value. */
function previewSet(topic: string, payload: JsonValue | undefined, house: HouseView): JsonObject | undefined {
  const parts = topic.split('/'), alias = parts[3], attribute = parts.at(-1);
  const row = uiRowsOf(house).find(candidate => alias !== undefined && candidate.topics.power?.split('/')[3] === alias);
  return row === undefined || attribute === undefined ? undefined : { source: row.source, attribute, value: payload === undefined ? null : payload };
}

/** A control's value as the store field `ls_store` takes for it. */
function storeField(attribute: string, value: JsonValue | undefined): JsonObject {
  const text = jinjaString(value === undefined ? null : value);
  switch (attribute) {
    case 'power': return { on: text !== 'OFF' };
    case 'brightness': return { brightness: wholeNumber(text, 0, 255) };
    case 'temperature': return { mireds: wholeNumber(text, 100, 1000) };
    case 'effect': return { effect: text };
    default: throw new ParseError(`effects_set: ${attribute} is not saved in a profile`);
  }
}

function wholeNumber(text: string, low: number, high: number): number {
  const number = Number(text);
  if (text.trim() === '' || !Number.isFinite(number) || number < low || number > high) throw new ParseError(`${text} is not ${low}..${high}`);
  return Math.round(number);
}

function texts(values: readonly JsonValue[]): string[] {
  return values.flatMap(value => typeof value === 'string' ? [value] : []);
}
