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
 */
import { BLOCKS } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type {
  BlockSchedule, BlockTiming, Config, Lamp, OverlayReset, OwnOrHouse, Remote, Room, RoomBlock, Schedule, Switch, WakeLight,
} from '../../domain/config.ts';
import type { BulbInfo } from '../../domain/effect.ts';
import type { BulbId, LampId, RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import type { Colour, RGB, SceneLight } from '../../domain/types/light.ts';
import type { Minutes } from '../../domain/types/overlay.ts';
import type { TimeOfDay, Timezone } from '../../domain/types/time.ts';
import { toBrightness, toBulbId, toColourChannel, toInstant, toKelvin, toLampId, toMinutes, toRoomId, toSwitchId, toTimeOfDay, toTimezone }
  from '../../parse/ids.ts';
import type { Catalog } from '../../runtime/catalog.ts';
import type { EntityState, JsonValue } from '../../runtime/context.ts';
import { isObject, parseFinite } from '../../runtime/parse.ts';
import type { Rooms } from '../../domain/types/rooms.ts';

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
  return {
    timezone: source.timezone === undefined ? DEFAULT_TIMEZONE : toTimezone(source.timezone),
    house: decodeHouse(source),
    rooms: decodeRooms(source, [...Object.values(lamps), ...Object.values(switches), ...Object.values(remotes)].map(thing => thing.room)),
    lamps,
    switches,
    remotes,
    overlayReset: decodeOverlayReset(source),
    warmEnd: decodeWarmEnd(source),
  };
}

function decodeLamps(source: ConfigSource, catalog: Catalog): Record<LampId, Lamp> {
  return Object.fromEntries(Object.entries(catalog.members).map(([lamp, bulbs]) => [toLampId(lamp), {
    room: roomOf(source.rooms.ofId[lamp]),
    bulbs: bulbs.map(bulb => bulbInfo(catalog, bulb)),
  } satisfies Lamp]));
}

/** The switches are the entities labelled on/off that are lights or switches. */
function decodeSwitches(source: ConfigSource): Record<SwitchId, Switch> {
  return Object.fromEntries((source.labels['on_off'] ?? []).filter(entity => /^(light|switch)\./.test(entity)).map(entity =>
    [toSwitchId(entity), { room: roomOf(source.rooms.ofId[entity]) } satisfies Switch]));
}

/** A remote's room is its device's room in the registry; a device in none gives a remote that does nothing. */
function decodeRemotes(source: ConfigSource, catalog: Catalog): Record<RemoteId, Remote> {
  return Object.fromEntries(Object.values(catalog.remotes).map(remote =>
    [remote.device_id, { room: roomOf(source.rooms.ofRemote[remote.device_id]), source: remote.source } satisfies Remote]));
}

function decodeHouse(source: ConfigSource): Schedule {
  return perBlock(block => ({
    ...decodeTiming(source, 'house', block),
    light: decodeBlockLight(source, 'house', block),
    switchesOn: isOn(source, `input_boolean.ls_house_${block}_on_off`),
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

/** An `input_number` state as minutes: a number that is not negative, else the fallback. */
function minutesOf(source: ConfigSource, entity: string, fallback: Minutes): Minutes {
  const value = parseFinite(source.states[entity]?.state);
  return value === undefined || value < 0 ? fallback : toMinutes(value);
}

/** The block's light entity as a scene, and the effect its saved profile names. Absent when the light is missing or unreadable. */
function decodeBlockLight(source: ConfigSource, scope: string, block: Block): SceneLight | undefined {
  const light = source.states[`light.ls_${scope}_${block}`];
  if (light === undefined) return undefined;
  if (light.state === 'off') return { power: 'off' };
  if (light.state !== 'on') return undefined;
  const level = parseFinite(light.attributes['brightness']);
  if (level === undefined || level < 0 || level >= 256) return undefined;
  const effect = savedEffect(source, `input_text.ls_${scope}_${block}`);
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

/** An input_boolean or switch that states `on`; anything else is off. */
function isOn(source: ConfigSource, entity: string): boolean {
  return source.states[entity]?.state === 'on';
}

function decodeRooms(source: ConfigSource, placed: readonly (RoomId | undefined)[]): Record<RoomId, Room> {
  const privateRooms = source.labels['private_room'] ?? [];
  const rooms = new Set(placed.filter(room => room !== undefined));
  return Object.fromEntries([...rooms].map(room => [room, {
    blocks: perBlock(block => decodeRoomBlock(source, room, block)),
    wakeLight: decodeWakeLight(source, room),
    private: privateRooms.includes(room),
  } satisfies Room]));
}

function decodeRoomBlock(source: ConfigSource, room: RoomId, block: Block): RoomBlock {
  const prefix = `ls_${room}_${block}`;
  const ownTiming = isOn(source, `input_boolean.${prefix}_own_timing`);
  // With its own-light flag on, the room's light and its switch rule apply where their helpers hold a state; otherwise the house's do.
  const ownFlag = isOn(source, `input_boolean.${prefix}_own_light`);
  const own = <T>(value: T): OwnOrHouse<T> => ({ follows: 'own', own: value });
  const house: { follows: 'house' } = { follows: 'house' };
  return {
    timing: ownTiming ? own(decodeTiming(source, room, block)) : house,
    light: ownFlag && holdsState(source, `light.${prefix}`) ? own(decodeBlockLight(source, room, block)) : house,
    switchesOn: ownFlag && holdsState(source, `input_boolean.${prefix}_on_off`) ? own(isOn(source, `input_boolean.${prefix}_on_off`)) : house,
  };
}

/** A helper that holds a state: present, and neither `unknown` nor `unavailable`. */
function holdsState(source: ConfigSource, entity: string): boolean {
  const state = source.states[entity]?.state;
  return state !== undefined && state !== 'unknown' && state !== 'unavailable';
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

/** A lit light's colour when it reports one: kelvin in the colour-temperature mode, else its rgb triple. */
function decodeColour(light: EntityState): Colour | undefined {
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
export function bulbTopics(catalog: Catalog): Record<BulbId, string> {
  return Object.fromEntries(Object.values(catalog.members).flat().flatMap(bulb => {
    const topic = catalog.topics[bulb];
    return topic === undefined ? [] : [[bulb, topic]];
  }));
}
