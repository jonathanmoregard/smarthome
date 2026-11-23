/**
 * The config codec: reads the helpers the dashboard edits, the registry's
 * rooms and labels and the catalog into `Config`. Decode only; the port never
 * writes these helpers.
 *
 * Two kinds of input, two behaviours. The catalog is refused at load
 * (`parseCatalog`: a bulb in two lamps, a malformed topic), because CI checks
 * it before it is deployed. A helper a person edits at run time recovers to a
 * named default and never raises (2026-11-21). Helper names are built here,
 * from the room and the block, and appear nowhere in `src/domain/`.
 *
 * One write is foreseen here rather than waited for: a block light's save, as
 * the helpers will show it, so the lamps move in the turn of the save
 * (`blockLightSaved`, Amendment 7.2).
 */
import { BLOCKS } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type {
  BlockSchedule, BlockTiming, Config, Lamp, OverlayReset, OwnOrHouse, Remote, Room, RoomBlock, Schedule, Switch, WakeLight,
} from '../../domain/config.ts';
import type { BulbInfo } from '../../domain/effect.ts';
import type { LampProfileChange } from '../../domain/model.ts';
import type { BulbId, DashboardControlId, LampId, RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import type { LampOrRoom } from '../../domain/types/lighting-state.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Colour, RGB, SceneLight } from '../../domain/types/light.ts';
import type { Minutes } from '../../domain/types/range.ts';
import type { RoomOrHouse } from '../../domain/types/schedule.ts';
import type { TimeOfDay, Timezone } from '../../domain/types/time.ts';
import {
  toBrightness, toBulbId, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toMinutes, toMqttTopic, toRoomId, toSwitchId, toTimeOfDay, toTimezone,
} from './ids.ts';
import type { MqttTopic } from './ids.ts';
import type { Catalog } from './catalog.ts';
import type { EntityState, JsonValue } from '../ha-client.ts';
import { ParseError, isObject, parseFinite } from './parse.ts';
import { decodeLampProfile } from './lamp-profiles.ts';
import type { Rooms } from './rooms.ts';
import { uiRowsOf } from './catalog.ts';
import type { UiRow } from './catalog.ts';

/** The HA state the config is read from: each helper's state and attributes, the registry's rooms, the labels. */
export type ConfigSource = {
  states: Readonly<Record<string, EntityState>>;
  rooms: Rooms;
  labels: Readonly<Record<string, readonly string[]>>;
  timezone: string | undefined;
};

/** A block's fade when its helper is unreadable: today's fallback. */
export const DEFAULT_FADE: Minutes = toMinutes(20);
/** The after-age rule's limit when its helper is unreadable: today's fallback. */
export const DEFAULT_OVERLAY_AGE: Minutes = toMinutes(180);
/** A wake light's fade when its helper is unreadable: today's fallback. */
export const DEFAULT_WAKE_FADE: Minutes = toMinutes(37.5);
/** The zone used when the source names none: today's fallback. */
const DEFAULT_TIMEZONE: Timezone = toTimezone('Europe/Stockholm');
/** The candle's colour when the helper holds no readable one: today's warm end. */
const DEFAULT_WARM_END: RGB = { red: toColourChannel(255), green: toColourChannel(126), blue: toColourChannel(0) };

export function decodeConfig(source: ConfigSource, catalog: Catalog): Config {
  const lamps = decodeLamps(source, catalog), switches = decodeSwitches(source), remotes = decodeRemotes(source, catalog);
  const rooms = decodeRooms(source, [...Object.values(lamps), ...Object.values(switches)].map(thing => thing.room));
  return {
    timezone: source.timezone === undefined ? DEFAULT_TIMEZONE : toTimezone(source.timezone),
    house: decodeHouse(source),
    rooms,
    lamps,
    switches,
    remotes,
    overlayReset: decodeOverlayReset(source),
    controls: decodeControls(catalog, lamps, rooms),
    warmEnd: decodeWarmEnd(source),
  };
}

/** The catalog's live controls (the UI rows with no profile store) that are over a lamp or a room of the house. */
function decodeControls(catalog: Catalog, lamps: Record<LampId, Lamp>, rooms: Record<RoomId, Room>): Record<DashboardControlId, LampOrRoom> {
  return Object.fromEntries(uiRowsOf(catalog).flatMap(row => {
    if (row.store !== undefined) return [];
    const over = controlOver(row, lamps, rooms);
    return over === undefined ? [] : [[toDashboardControlId(row.source), over]];
  }));
}

/** A live control is over the room whose every lamp it holds, else over its source lamp (or its first member lamp). */
function controlOver(row: Pick<UiRow, 'source' | 'members'>, lamps: Record<LampId, Lamp>, rooms: Record<RoomId, Room>): LampOrRoom | undefined {
  const members = row.members.map(toLampId).filter(lamp => lamps[lamp] !== undefined);
  for (const [room] of entriesOf(rooms)) {
    const all = entriesOf(lamps).flatMap(([lamp, placed]) => placed.room === room ? [lamp] : []);
    if (members.length > 1 && all.length > 0 && all.every(lamp => members.includes(lamp))) return { kind: 'room', room };
  }
  const source = toLampId(row.source);
  if (lamps[source] !== undefined) return { kind: 'lamp', lamp: source };
  const [first] = members;
  return first === undefined ? undefined : { kind: 'lamp', lamp: first };
}

/**
 * The lamps are the house_schedule-labelled lights, as the schedule reads them; with no such label, the catalog's.
 * A lamp the catalog does not list has no bulbs.
 */
function decodeLamps(source: ConfigSource, catalog: Catalog): Record<LampId, Lamp> {
  const labelled = source.labels['house_schedule'];
  const lamps = labelled === undefined ? Object.keys(catalog.members) : labelled.filter(entity => entity.startsWith('light.'));
  return Object.fromEntries(lamps.map(lamp => [toLampId(lamp), {
    room: roomOf(source.rooms.ofId[lamp]),
    bulbs: (catalog.members[toLampId(lamp)] ?? []).map(bulb => bulbInfo(catalog, bulb)),
  } satisfies Lamp]));
}

/**
 * The switches are the entities labelled on/off that are lights or switches, and those with a saved range rule
 * (as today's switch plan drives them). A range key that is no light or switch is skipped.
 */
function decodeSwitches(source: ConfigSource): Record<SwitchId, Switch> {
  const isSwitch = (entity: string) => /^(light|switch)\./.test(entity);
  const labelled = (source.labels['on_off'] ?? []).filter(isSwitch);
  const ranged = Object.keys(rangeEntities(source)).filter(isSwitch);
  return Object.fromEntries([...new Set([...labelled, ...ranged])].map(entity =>
    [toSwitchId(entity), { room: roomOf(source.rooms.ofId[entity]), onOff: labelled.includes(entity) } satisfies Switch]));
}

/** The entities with a saved switch range: the keys of `sensor.ls_overrides`'s `switch_ranges`. */
function rangeEntities(source: ConfigSource): Record<string, JsonValue> {
  const ranges = source.states['sensor.ls_overrides']?.attributes['switch_ranges'];
  return isObject(ranges) ? ranges : {};
}

/** A remote's room is its device's room in the registry; a device in none gives a remote that does nothing. */
function decodeRemotes(source: ConfigSource, catalog: Catalog): Record<RemoteId, Remote> {
  const devices = Object.values(catalog.remotes).map(remote => remote.device_id);
  const twice = devices.find((device, index) => devices.indexOf(device) !== index);
  if (twice !== undefined) throw new ParseError(`catalog.remotes: device ${twice} is listed for more than one remote; a device is one remote`);
  return Object.fromEntries(Object.values(catalog.remotes).map(remote =>
    [remote.device_id, { room: roomOf(source.rooms.ofRemote[remote.device_id]) } satisfies Remote]));
}

function decodeHouse(source: ConfigSource): Schedule {
  return perBlock(block => ({
    ...decodeTiming(source, 'house', block),
    light: decodeBlockLight(source, 'house', 'house', block),
    switchesOn: onOff(source, 'house', block),
  }) satisfies BlockSchedule);
}

function decodeTiming(source: ConfigSource, scope: string, block: Block): BlockTiming {
  return {
    weekdayStart: timeOf(source, `input_datetime.ls_${scope}_${block}_start`),
    weekendStart: timeOf(source, `input_datetime.ls_${scope}_${block}_weekend`),
    fade: minutesOf(source, `input_number.ls_${scope}_${block}_fade`, DEFAULT_FADE),
  };
}

/** An `input_datetime` state read as `HH:MM`, seconds ignored; not a time, or hour above 23 or minute above 59, is none. */
function timeOf(source: ConfigSource, entity: string): TimeOfDay | undefined {
  const match = /^(\d\d):(\d\d)/.exec(source.states[entity]?.state ?? '');
  if (match === null) return undefined;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour > 23 || minute > 59 ? undefined : toTimeOfDay(hour, minute);
}

/** An `input_number` state as minutes: a negative number is zero, as the schedule treats it; a non-number is the fallback. */
function minutesOf(source: ConfigSource, entity: string, fallback: Minutes): Minutes {
  const value = parseFinite(source.states[entity]?.state);
  return value === undefined ? fallback : toMinutes(Math.max(value, 0));
}

/**
 * The light entity of `lightScope` as a scene, with the effect the `profileScope` saved profile names.
 * Absent when the light is missing or unreadable.
 */
function decodeBlockLight(source: ConfigSource, lightScope: RoomOrHouse, profileScope: RoomOrHouse, block: Block): SceneLight | undefined {
  const light = source.states[blockLightEntity(lightScope, block)];
  if (light === undefined) return undefined;
  if (light.state === 'off') return { power: 'off' };
  if (light.state !== 'on') return undefined;
  const level = parseFinite(light.attributes['brightness']);
  if (level === undefined || level < 0 || level >= 256) return undefined;
  const effect = savedEffect(source, blockLightStore({ scope: profileScope, block }));
  return { power: 'on', brightness: toBrightness(Math.trunc(level)), colour: decodeColour(light), effect };
}

/** The effect a block's saved profile names: the candle when it says `Candle`, normal light for anything else. */
function savedEffect(source: ConfigSource, entity: string): 'Candle' | 'Normal' {
  const text = source.states[entity]?.state;
  if (text === undefined) return 'Normal';
  let profile: JsonValue;
  try { profile = JSON.parse(text) as JsonValue; } catch { return 'Normal'; }
  return isObject(profile) && profile['effect'] === 'Candle' ? 'Candle' : 'Normal';
}

/** A scope's on/off helper for a block; undefined when it holds no state. */
function onOff(source: ConfigSource, scope: string, block: Block): boolean | undefined {
  const entity = `input_boolean.ls_${scope}_${block}_on_off`;
  return holdsState(source, entity) ? isOn(source, entity) : undefined;
}

/** A helper that holds a state: present, and neither `unknown` nor `unavailable`. */
function holdsState(source: ConfigSource, entity: string): boolean {
  const state = source.states[entity]?.state;
  return state !== undefined && state !== 'unknown' && state !== 'unavailable';
}

/** An input_boolean or switch that states `on`; anything else is off. */
function isOn(source: ConfigSource, entity: string): boolean {
  return source.states[entity]?.state === 'on';
}

/** Only a room with a lamp, a switch or a saved switch range has its own schedule, as the schedule gives them; a remote alone does not. */
function decodeRooms(source: ConfigSource, placed: readonly (RoomId | undefined)[]): Record<RoomId, Room> {
  // A '' private-room label (a lamp in no area) names no room, so Room cannot carry it.
  const privateRooms = source.labels['private_room'] ?? [];
  const ranged = Object.keys(rangeEntities(source)).map(entity => roomOf(source.rooms.ofId[entity]));
  const rooms = new Set([...placed, ...ranged].filter(room => room !== undefined));
  return Object.fromEntries([...rooms].map(room => [room, {
    blocks: perBlock(block => decodeRoomBlock(source, room, block)),
    wakeLight: decodeWakeLight(source, room),
    private: privateRooms.includes(room),
  } satisfies Room]));
}

function decodeRoomBlock(source: ConfigSource, room: RoomId, block: Block): RoomBlock {
  const prefix = `ls_${room}_${block}`;
  const ownTiming = isOn(source, `input_boolean.${prefix}_own_timing`);
  // The own-light flag alone picks the room's saved effect; the light entity and the switch rule are the room's
  // only where their helpers hold a state.
  const ownFlag = isOn(source, `input_boolean.${prefix}_own_light`);
  const own = <T>(value: T): OwnOrHouse<T> => ({ follows: 'own', own: value });
  const house: { follows: 'house' } = { follows: 'house' };
  return {
    timing: ownTiming ? own(decodeTiming(source, room, block)) : house,
    light: !ownFlag ? house : own(decodeBlockLight(source, holdsState(source, blockLightEntity(room, block)) ? room : 'house', room, block)),
    switchesOn: ownFlag && holdsState(source, `input_boolean.${prefix}_on_off`) ? own(onOff(source, room, block)) : house,
  };
}

function decodeWakeLight(source: ConfigSource, room: RoomId): WakeLight | undefined {
  const wake = `input_datetime.ls_${room}_wake`;
  if (!holdsState(source, wake)) return undefined;
  const timestamp = parseFinite(source.states[wake]?.attributes['timestamp']);
  return timestamp === undefined ? undefined
    : { at: toInstant(timestamp), fade: minutesOf(source, `input_number.ls_${room}_wake_fade`, DEFAULT_WAKE_FADE) };
}

function decodeOverlayReset(source: ConfigSource): OverlayReset {
  return {
    atNextBlock: isOn(source, 'input_boolean.ls_ovr_next_block_on'),
    atSetTime: isOn(source, 'input_boolean.ls_ovr_at_on') ? timeOf(source, 'input_datetime.ls_ovr_at') : undefined,
    afterAge: isOn(source, 'input_boolean.ls_ovr_after_on') ? minutesOf(source, 'input_number.ls_ovr_after_min', DEFAULT_OVERLAY_AGE) : undefined,
  };
}

function decodeWarmEnd(source: ConfigSource): RGB {
  return rgbOf(source.states['light.candle_test_rgb_warm_end']?.attributes['rgb_color']) ?? DEFAULT_WARM_END;
}

/** A registry area as a room; none, or the empty area id, is no room. */
function roomOf(area: RoomId | undefined): RoomId | undefined {
  return area === undefined || area === '' ? undefined : toRoomId(area);
}

function bulbInfo(catalog: Catalog, bulb: BulbId): BulbInfo {
  return { bulb: toBulbId(bulb), firmware: catalog.bulbs[bulb]?.candle === true ? 'candle' : 'stock' };
}

function perBlock<T>(make: (block: Block) => T): Record<Block, T> {
  const [day, cosy, night] = BLOCKS;
  return { day: make(day), cosy: make(cosy), night: make(night) };
}

/** A block's light of the house or a room: the store its saved profile is kept in, and the template light over it. */
export type BlockLight = { scope: RoomOrHouse; block: Block };

/**
 * The block light a store is, by its name (the inverse of {@link blockLightStore}): the house's, or any room's,
 * whether or not the config has a lamp in it, so a room's dashboard save is written as the scripts wrote it.
 */
export function blockLightOf(store: string): BlockLight | undefined {
  const match = /^input_text\.ls_(.+)_(day|cosy|night)$/.exec(store);
  const scope = match?.[1], block = BLOCKS.find(known => known === match?.[2]);
  if (scope === undefined || block === undefined) return undefined;
  const light: BlockLight = { scope: scope === 'house' ? 'house' : toRoomId(scope), block };
  return blockLightStore(light) === store ? light : undefined;
}

/** The store a block's light is saved in: `input_text.ls_<scope>_<block>`. */
export function blockLightStore(light: BlockLight): string {
  return `input_text.ls_${light.scope}_${light.block}`;
}

/**
 * The helper states as Home Assistant shows them once a block's light is
 * saved: its store holds `text`, and the template light over it (where Home
 * Assistant has one) shows the power,
 * level and colour the save set, the rest as it was. A light switched on that
 * reports no level or colour takes the store's, as the template reads it. The
 * config read from these is the one the helper echo brings a turn later.
 */
export function blockLightSaved(states: Readonly<Record<string, EntityState>>, target: BlockLight, text: string,
  change: LampProfileChange): Record<string, EntityState> {
  const store = blockLightStore(target), found = states[store];
  const saved: Record<string, EntityState> = { ...states, [store]: { attributes: found === undefined ? {} : found.attributes, state: text } };
  const entity = blockLightEntity(target.scope, target.block), light = states[entity];
  if (light === undefined) return saved;
  const own = decodeLampProfile(text).own, kept = own.power === 'on' ? own.light : own.remembered;
  const shown = light.attributes;
  const brightness = change.brightness !== undefined ? change.brightness
    : parseFinite(shown['brightness']) === undefined ? kept.brightness : undefined;
  const colour = change.colour !== undefined ? change.colour : decodeColour(light) === undefined ? kept.colour : undefined;
  const colourShown = colour === undefined ? {} : colour.kind === 'kelvin'
    ? { color_mode: 'color_temp', color_temp_kelvin: colour.kelvin }
    : { color_mode: 'rgb', rgb_color: [colour.rgb.red, colour.rgb.green, colour.rgb.blue] };
  saved[entity] = {
    ...light,
    state: change.power === undefined ? light.state : change.power,
    attributes: { ...shown, ...brightness === undefined ? {} : { brightness }, ...colourShown },
  };
  return saved;
}

/**
 * The helper states once a store's write lands: a block light's template light shows the stored light too, as
 * {@link blockLightSaved} has it with the whole stored light for the change; any other store only holds its text.
 */
export function storeLanded(states: Readonly<Record<string, EntityState>>, store: string, text: string): Record<string, EntityState> {
  const light = blockLightOf(store), found = states[store];
  if (light === undefined) return { ...states, [store]: { attributes: found === undefined ? {} : found.attributes, state: text } };
  const own = decodeLampProfile(text).own, kept = own.power === 'on' ? own.light : own.remembered;
  return blockLightSaved(states, light, text, { own: undefined, power: own.power, brightness: kept.brightness, colour: kept.colour, effect: undefined });
}

/** A lit light's colour when it reports one: kelvin in the colour-temperature mode, else its rgb triple. */
export function decodeColour(light: EntityState): Colour | undefined {
  if (light.attributes['color_mode'] === 'color_temp') {
    const kelvin = parseFinite(light.attributes['color_temp_kelvin']);
    const whole = kelvin === undefined ? undefined : Math.trunc(kelvin);
    return whole === undefined || whole < 1000 || whole > 10000 ? undefined : { kind: 'kelvin', kelvin: toKelvin(whole) };
  }
  const rgb = rgbOf(light.attributes['rgb_color']);
  return rgb === undefined ? undefined : { kind: 'rgb', rgb };
}

/** Three channel values, each 0..255, as a colour; anything else is none. */
function rgbOf(value: JsonValue | undefined): RGB | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [red, green, blue] = value;
  const channel = (raw: JsonValue | undefined) => typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 255;
  return typeof red === 'number' && typeof green === 'number' && typeof blue === 'number' && channel(red) && channel(green) && channel(blue)
    ? { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) }
    : undefined;
}

/** Where each bulb is reached. Sending is the adapter's, so this is not in Config. */
export function bulbTopics(catalog: Catalog): Record<BulbId, MqttTopic> {
  return Object.fromEntries(Object.values(catalog.members).flat().flatMap(bulb => {
    const topic = catalog.topics[bulb];
    return topic === undefined ? [] : [[bulb, toMqttTopic(topic)]];
  }));
}

/**
 * The bulbs Home Assistant reported changed, from the entity ids it names: a lamp names its bulbs, a bulb itself.
 * An id the config does not know names none.
 */
export function reportedBulbs(entities: readonly string[], config: Config): BulbId[] {
  const named = new Set(entities);
  return entriesOf(config.lamps).flatMap(([lamp, { bulbs }]) => bulbs.flatMap(({ bulb }) => named.has(lamp) || named.has(bulb) ? [bulb] : []));
}

/** The template light over a block's light store: `light.ls_<scope>_<block>`. */
function blockLightEntity(scope: RoomOrHouse, block: Block): string {
  return `light.ls_${scope}_${block}`;
}
