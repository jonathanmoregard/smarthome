/**
 * A person's light call read as today's native-control plan reads it
 * (`planNativeControls` and `nativeColor` in
 * `src/legacy/domain/native-controls.ts`, moved): the lamps the call reaches
 * and the rooms it names whole, and the colour it asks for.
 *
 * The targets: the entities named (a text list split on commas), every entity
 * in each area, each device's entities and each label's. They reach a lamp
 * when they name the lamp or one of its bulbs, directly, through a catalog
 * group, or through a Home Assistant group or zone (nested, and only an
 * entity Home Assistant reports). An area names its room whole, and so does a
 * catalog group holding every lamp of a room; a Home Assistant group does
 * not. A target that is not text raises.
 *
 * The colour: the first colour key the call holds, in today's order; a key
 * whose value cannot be read raises. `color_temp` (mireds) is read after
 * `kelvin`, which today's plan left to Home Assistant.
 */
import { roundEven } from '../domain/blend.ts';
import type { Config } from '../domain/config.ts';
import type { LampId, RoomId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { Colour } from '../domain/types/light.ts';
import { COLOUR_NAMES } from '../parse/colour-names.ts';
import { toColourChannel, toKelvin, toLampId, toRoomId } from '../parse/ids.ts';
import { groupChildren, lampKelvinRange } from '../parse/native-controls.ts';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { ParseError, jinjaString, requireArray, requireNumber, requireString } from '../runtime/parse.ts';

type Rgb = readonly [number, number, number];

/** One channel of an rgbww colour's white: the cold white by the first white channel, the warm by the second. */
function whiteOf(cold: Rgb, warm: Rgb, channels: readonly number[], index: 0 | 1 | 2): number {
  return (cold[index] * nth(channels, 3) + warm[index] * nth(channels, 4)) / 255;
}

/** A colour temperature as rgb (today's `rgbValue`, Tanner Helland's fit). */
function kelvinRgb(kelvin: number): Rgb {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * ((t - 60) ** -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * ((t - 60) ** -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamped = (value: number) => Math.min(255, Math.max(0, value));
  return [roundEven(clamped(r)), roundEven(clamped(g)), roundEven(clamped(b))];
}

/** The lamps a call reaches, in the config's order, and the rooms of the config it names whole. */
export function callReach(sd: JsonObject, config: Config, house: HouseView): { lamps: LampId[]; rooms: RoomId[] } {
  const areas = selector(sd, 'area_id'), requested = selector(sd, 'entity_id', true);
  const devices = selector(sd, 'device_id'), labels = selector(sd, 'label_id');
  const rooms = house.rooms.ofId;
  for (const area of areas) requested.push(...Object.keys(rooms).filter(entity => rooms[entity] === area));
  for (const device of devices) requested.push(...listed(house.devices, device));
  for (const label of labels) requested.push(...listed(house.labels, label));
  const expanded = new Set([...requested, ...requested.flatMap(source => catalogGroup(house, source)), ...expandedEntities(house, requested)]);
  const lamps = entriesOf(config.lamps).flatMap(([lamp, placed]) =>
    expanded.has(lamp) || placed.bulbs.some(({ bulb }) => expanded.has(bulb)) ? [lamp] : []);
  const named = [...areas];
  for (const source of requested) {
    if (house.catalog.groups[source] === undefined) continue;
    const members = catalogGroup(house, source);
    for (const area of new Set(members.flatMap(member => rooms[member] === undefined ? [] : [rooms[member]]))) {
      if (entriesOf(config.lamps).every(([lamp]) => rooms[lamp] !== area || members.includes(lamp))) named.push(area);
    }
  }
  const whole = [...new Set(named)].map(toRoomId).filter(room => config.rooms[room] !== undefined);
  return { lamps, rooms: whole };
}

/** A call's selector: absent, none; text, itself (the entity list split on commas); else a list of texts. */
function selector(sd: JsonObject, key: string, split = false): string[] {
  const value = sd[key];
  if (value === undefined) return [];
  const values = typeof value === 'string' ? (split ? value.split(',') : [value]) : requireArray(sd, key, 'light call');
  return values.map((item, index) => requireString({ item }, 'item', `light call ${key}[${index}]`));
}

function listed(lists: Record<string, string[]> | undefined, key: string): string[] {
  const list = lists === undefined ? undefined : lists[key];
  return list === undefined ? [] : list;
}

/** A catalog group's lamps; a source that is no catalog group has none. */
function catalogGroup(house: HouseView, source: string): LampId[] {
  const members = house.catalog.groups[source];
  return members === undefined ? [] : members.map(toLampId);
}

/** The entities Home Assistant reports among `entities`, each group and zone replaced by its children, nested. */
function expandedEntities(house: HouseView, entities: readonly string[]): string[] {
  const pending = [...entities], seen = new Set<string>(), result: string[] = [];
  for (let entity = pending.shift(); entity !== undefined; entity = pending.shift()) {
    if (seen.has(entity)) continue;
    seen.add(entity);
    if (house.state[entity] === undefined) continue;
    const sources = house.entitySources;
    const zone = entity.startsWith('zone.');
    const group = entity.startsWith('group.') || (sources !== undefined && sources[entity] === 'group');
    if (!group && !zone) { result.push(entity); continue; }
    const children = groupChildren(house, entity, zone);
    if (children !== undefined) pending.push(...children);
  }
  return result;
}

/** The colour a call asks for, by its first colour key; `lamp` is the lamp whose white range an rgbww colour mixes. */
export function callColour(sd: JsonObject, house: HouseView, lamp: LampId | undefined): Colour | undefined {
  if ('color_temp_kelvin' in sd) return kelvinColour(requireNumber(sd, 'color_temp_kelvin', 'light call'));
  if ('kelvin' in sd) return kelvinColour(requireNumber(sd, 'kelvin', 'light call'));
  if ('color_temp' in sd) {
    const mireds = requireNumber(sd, 'color_temp', 'light call');
    if (mireds <= 0) throw new ParseError('light call: color_temp is not a colour temperature');
    return kelvinColour(1_000_000 / mireds);
  }
  if ('rgb_color' in sd) return rgbColour(numbers(sd, 'rgb_color', 3));
  if ('hs_color' in sd) {
    const hs = numbers(sd, 'hs_color', 2);
    return rgbColour(hsRgb(nth(hs, 0), nth(hs, 1)));
  }
  if ('xy_color' in sd) {
    const xy = numbers(sd, 'xy_color', 2);
    return rgbColour(xyRgb(nth(xy, 0), nth(xy, 1)));
  }
  if ('rgbw_color' in sd) return rgbColour(whiteMixed(numbers(sd, 'rgbw_color', 4), house, lamp));
  if ('rgbww_color' in sd) return rgbColour(whiteMixed(numbers(sd, 'rgbww_color', 5), house, lamp));
  if ('color_name' in sd) {
    const named = COLOUR_NAMES[jinjaString(sd.color_name).toLowerCase().replaceAll(' ', '')];
    return named === undefined ? undefined : rgbColour([...named]);
  }
  return 'white' in sd ? rgbColour([255, 255, 255]) : undefined;
}

function kelvinColour(kelvin: number): Colour {
  return { kind: 'kelvin', kelvin: toKelvin(Math.round(kelvin)) };
}

function rgbColour(channels: readonly number[]): Colour {
  const channel = (index: number) => toColourChannel(Math.round(nth(channels, index)));
  return { kind: 'rgb', rgb: { red: channel(0), green: channel(1), blue: channel(2) } };
}

/** The value at `index` of a list whose length was checked. */
function nth(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) throw new ParseError(`light call: no value at ${index}`);
  return value;
}

/** A key's list of exactly `length` numbers, or a raise. */
function numbers(sd: JsonObject, key: string, length: number): number[] {
  const values = requireArray(sd, key, 'light call');
  if (values.length !== length) throw new ParseError(`light call: ${key} must contain ${length} values`);
  return values.map((value: JsonValue, index) => requireNumber({ value }, 'value', `light call ${key}[${index}]`));
}

/** The colour wheel: hue (degrees, wrapped) and saturation (percent) at full value. */
function hsRgb(hue: number, saturation: number): number[] {
  const wrapped = hue % 360;
  const h = (wrapped < 0 ? wrapped + 360 : wrapped) / 60, c = saturation / 100;
  const x = c * (1 - Math.abs(h % 2 - 1)), m = 1 - c;
  const triplet = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return triplet.map(component => roundEven((component + m) * 255));
}

/** A lamp that reports no white range: today's `| int(6500)` and `| int(2000)` defaults. */
const UNKNOWN_WHITE_RANGE = { max: 6500, min: 2000 };

/** CIE 1931 xy at full luminance to sRGB, scaled to its peak; a y of zero or less is black. */
function xyRgb(x: number, y: number): number[] {
  if (y <= 0) return [0, 0, 0];
  const X = x / y, Z = (1 - x - y) / y;
  const linear = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.011530];
  const gamma = linear.map(v => Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  const peak = Math.max(1, ...gamma);
  return gamma.map(v => roundEven(v / peak * 255));
}

/**
 * An rgbw or rgbww colour as rgb: the white (the w channel on each colour; for
 * rgbww the lamp's coldest and warmest white, mixed by the two channels) added
 * to the colour, scaled to its peak at the brightest channel.
 */
function whiteMixed(channels: readonly number[], house: HouseView, lamp: LampId | undefined): number[] {
  const RGB_INDEX = [0, 1, 2] as const;
  let white: Rgb;
  if (channels.length === 4) white = [nth(channels, 3), nth(channels, 3), nth(channels, 3)];
  else {
    const range = lamp === undefined ? UNKNOWN_WHITE_RANGE : lampKelvinRange(house, lamp);
    const cold = kelvinRgb(range.max), warm = kelvinRgb(range.min);
    white = [whiteOf(cold, warm, channels, 0), whiteOf(cold, warm, channels, 1), whiteOf(cold, warm, channels, 2)];
  }
  const mixed = RGB_INDEX.map(i => nth(channels, i) + white[i]);
  const peak = Math.max(1, ...mixed), brightness = Math.max(...channels);
  return mixed.map(value => roundEven(value / peak * brightness));
}
