import type { HouseView } from '../runtime/effects.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { rgbValue, roundEven } from './scale.ts';
import type { RGB } from './scale.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import { switchRangeIterable } from '../parse/planning.ts';
import { groupChildren, lampKelvinRange, underlyingColour } from '../parse/native-controls.ts';
import type {
  BrightnessRequest, ColourRequest, NativeCatalog, NativeCurrent, NativePlanRequest, PlanTarget, SetRequest,
} from '../parse/native-controls.ts';
import { overlayKeyText } from './types/overlay.ts';
import type { OverlayKey } from './types/overlay.ts';
import type { RoomId } from './types/ids.ts';
import type { Brightness, Kelvin } from './types/light.ts';
import { isAreaId } from './schedule.ts';

// Literal CSS colour names from the deployed native adapter.
const COLOR_NAMES: Record<string, RGB> = {
  "aliceblue": [240, 248, 255],
  "antiquewhite": [250, 235, 215],
  "aqua": [0, 255, 255],
  "aquamarine": [127, 255, 212],
  "azure": [240, 255, 255],
  "beige": [245, 245, 220],
  "bisque": [255, 228, 196],
  "black": [0, 0, 0],
  "blanchedalmond": [255, 235, 205],
  "blue": [0, 0, 255],
  "blueviolet": [138, 43, 226],
  "brown": [165, 42, 42],
  "burlywood": [222, 184, 135],
  "cadetblue": [95, 158, 160],
  "chartreuse": [127, 255, 0],
  "chocolate": [210, 105, 30],
  "coral": [255, 127, 80],
  "cornflowerblue": [100, 149, 237],
  "cornsilk": [255, 248, 220],
  "crimson": [220, 20, 60],
  "cyan": [0, 255, 255],
  "darkblue": [0, 0, 139],
  "darkcyan": [0, 139, 139],
  "darkgoldenrod": [184, 134, 11],
  "darkgray": [169, 169, 169],
  "darkgrey": [169, 169, 169],
  "darkgreen": [0, 100, 0],
  "darkkhaki": [189, 183, 107],
  "darkmagenta": [139, 0, 139],
  "darkolivegreen": [85, 107, 47],
  "darkorange": [255, 140, 0],
  "darkorchid": [153, 50, 204],
  "darkred": [139, 0, 0],
  "darksalmon": [233, 150, 122],
  "darkseagreen": [143, 188, 143],
  "darkslateblue": [72, 61, 139],
  "darkslategray": [47, 79, 79],
  "darkslategrey": [47, 79, 79],
  "darkturquoise": [0, 206, 209],
  "darkviolet": [148, 0, 211],
  "deeppink": [255, 20, 147],
  "deepskyblue": [0, 191, 255],
  "dimgray": [105, 105, 105],
  "dimgrey": [105, 105, 105],
  "dodgerblue": [30, 144, 255],
  "firebrick": [178, 34, 34],
  "floralwhite": [255, 250, 240],
  "forestgreen": [34, 139, 34],
  "fuchsia": [255, 0, 255],
  "gainsboro": [220, 220, 220],
  "ghostwhite": [248, 248, 255],
  "gold": [255, 215, 0],
  "goldenrod": [218, 165, 32],
  "gray": [128, 128, 128],
  "grey": [128, 128, 128],
  "green": [0, 128, 0],
  "greenyellow": [173, 255, 47],
  "honeydew": [240, 255, 240],
  "hotpink": [255, 105, 180],
  "indianred": [205, 92, 92],
  "indigo": [75, 0, 130],
  "ivory": [255, 255, 240],
  "khaki": [240, 230, 140],
  "lavender": [230, 230, 250],
  "lavenderblush": [255, 240, 245],
  "lawngreen": [124, 252, 0],
  "lemonchiffon": [255, 250, 205],
  "lightblue": [173, 216, 230],
  "lightcoral": [240, 128, 128],
  "lightcyan": [224, 255, 255],
  "lightgoldenrodyellow": [250, 250, 210],
  "lightgreen": [144, 238, 144],
  "lightgray": [211, 211, 211],
  "lightgrey": [211, 211, 211],
  "lightpink": [255, 182, 193],
  "lightsalmon": [255, 160, 122],
  "lightseagreen": [32, 178, 170],
  "lightskyblue": [135, 206, 250],
  "lightslategray": [119, 136, 153],
  "lightslategrey": [119, 136, 153],
  "lightsteelblue": [176, 196, 222],
  "lightyellow": [255, 255, 224],
  "lime": [0, 255, 0],
  "limegreen": [50, 205, 50],
  "linen": [250, 240, 230],
  "magenta": [255, 0, 255],
  "maroon": [128, 0, 0],
  "mediumaquamarine": [102, 205, 170],
  "mediumblue": [0, 0, 205],
  "mediumorchid": [186, 85, 211],
  "mediumpurple": [147, 112, 219],
  "mediumseagreen": [60, 179, 113],
  "mediumslateblue": [123, 104, 238],
  "mediumspringgreen": [0, 250, 154],
  "mediumturquoise": [72, 209, 204],
  "mediumvioletred": [199, 21, 133],
  "midnightblue": [25, 25, 112],
  "mintcream": [245, 255, 250],
  "mistyrose": [255, 228, 225],
  "moccasin": [255, 228, 181],
  "navajowhite": [255, 222, 173],
  "navy": [0, 0, 128],
  "oldlace": [253, 245, 230],
  "olive": [128, 128, 0],
  "olivedrab": [107, 142, 35],
  "orange": [255, 165, 0],
  "orangered": [255, 69, 0],
  "orchid": [218, 112, 214],
  "palegoldenrod": [238, 232, 170],
  "palegreen": [152, 251, 152],
  "paleturquoise": [175, 238, 238],
  "palevioletred": [219, 112, 147],
  "papayawhip": [255, 239, 213],
  "peachpuff": [255, 218, 185],
  "peru": [205, 133, 63],
  "pink": [255, 192, 203],
  "plum": [221, 160, 221],
  "powderblue": [176, 224, 230],
  "purple": [128, 0, 128],
  "rebeccapurple": [102, 51, 153],
  "red": [255, 0, 0],
  "rosybrown": [188, 143, 143],
  "royalblue": [65, 105, 225],
  "saddlebrown": [139, 69, 19],
  "salmon": [250, 128, 114],
  "sandybrown": [244, 164, 96],
  "seagreen": [46, 139, 87],
  "seashell": [255, 245, 238],
  "sienna": [160, 82, 45],
  "silver": [192, 192, 192],
  "skyblue": [135, 206, 235],
  "slateblue": [106, 90, 205],
  "slategray": [112, 128, 144],
  "slategrey": [112, 128, 144],
  "snow": [255, 250, 250],
  "springgreen": [0, 255, 127],
  "steelblue": [70, 130, 180],
  "tan": [210, 180, 140],
  "teal": [0, 128, 128],
  "thistle": [216, 191, 216],
  "tomato": [255, 99, 71],
  "turquoise": [64, 224, 208],
  "violet": [238, 130, 238],
  "wheat": [245, 222, 179],
  "white": [255, 255, 255],
  "whitesmoke": [245, 245, 245],
  "yellow": [255, 255, 0],
  "yellowgreen": [154, 205, 50],
};

interface ScopeItem { scope: 'room' | 'lamp'; target: string; base: string; suffix?: string }

/** A claim's `updated`: the native call's raw stamp, or the UI's own epoch. */
type Stamp = Verbatim | number;
/** A colour a claim holds: what a native call or the UI asked for, or the colour a reset returns to. */
export type ClaimColour = { kelvin: Verbatim | number } | { rgb: number[] } | Verbatim;
/** Convert native HA colour payloads to the existing logical RGB/Kelvin form; `undefined` when none is asked for. */
export function nativeColor(view: HouseView, request: ColourRequest, lamp: string): ClaimColour | undefined {
  if (request.kind === 'kelvin') return { kelvin: request.kelvin };
  if (request.kind === 'rgb') return { rgb: request.rgb() };
  if (request.kind === 'hs') {
    const [hue, saturation] = request.hs();
    const wrapped = hue % 360;
    const h = (wrapped < 0 ? wrapped + 360 : wrapped) / 60, c = saturation / 100;
    const x = c * (1 - Math.abs(h % 2 - 1)), m = 1 - c;
    const triplet = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return { rgb: triplet.map(component => roundEven((component + m) * 255)) };
  }
  if (request.kind === 'xy') {
    const [x, y] = request.xy();
    if (y <= 0) return { rgb: [0, 0, 0] };
    const X = x / y, Z = (1 - x - y) / y;
    const linear = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.011530];
    const gamma = linear.map(v => Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    const peak = Math.max(1, ...gamma);
    return { rgb: gamma.map(v => roundEven(v / peak * 255)) };
  }
  if (request.kind === 'rgbw' || request.kind === 'rgbww') {
    const channels = request.channels();
    let white: number[];
    if (channels.length === 4) white = [channels[3]!, channels[3]!, channels[3]!];
    else {
      const range = lampKelvinRange(view, lamp);
      const cold = rgbValue({ kelvin: range.max });
      const warm = rgbValue({ kelvin: range.min });
      white = [0, 1, 2].map(i => (cold[i]! * channels[3]! + warm[i]! * channels[4]!) / 255);
    }
    const mixed = [0, 1, 2].map(i => channels[i]! + white[i]!);
    const peak = Math.max(1, ...mixed), brightness = Math.max(...channels);
    return { rgb: mixed.map(v => roundEven(v / peak * brightness)) };
  }
  if (request.kind === 'name') {
    const color = COLOR_NAMES[request.name.toLowerCase().replaceAll(' ', '')];
    return color ? { rgb: [...color] } : undefined;
  }
  return request.kind === 'white' ? { rgb: [255, 255, 255] } : undefined;
}
/** `value` absent: the claim holds nothing, so the resolver drops the channel to its base (an invalid source). */
export type ConstantClaim = { kind: 'constant'; value?: number | boolean | ClaimColour; updated: Stamp };
export type EffectClaim = { kind: 'effect'; effect: string; instance: string; updated: Stamp; intensity?: number | boolean };
export type ChannelClaim = ConstantClaim | EffectClaim;
/** One `channels` override record, as `ls_override` stores it. */
export type ChannelRecord = {
  kind: 'channels';
  key: string;
  source: string;
  scope: 'room' | 'lamp';
  target: string;
  value: { channels: Record<string, ChannelClaim>; selection?: string };
};
export type PowerEvent = { op: 'power'; area: RoomId; on: boolean; via: string };
export type SetEvent = { op: 'set'; records: ChannelRecord[]; via: string };
type LightData = Record<string, never> | { brightness: Brightness } | { rgb_color: number[] } | { color_temp_kelvin: Kelvin };
export type ControlCommand =
  | { action: 'script.ls_store'; data: { store: string; effect: string }; target: Record<string, never> }
  | {
    action: 'light.turn_off' | 'light.turn_on' | 'homeassistant.turn_on' | 'homeassistant.turn_off';
    target: { entity_id: string | string[] }; data: LightData;
  };
export type NativePlan = { records: ChannelRecord[]; power: PowerEvent[] };

export function planNativeControls(view: HouseView, args: NativePlanRequest): NativePlan {
  const { sd, catalog, areas, devices, labels, requested } = args;
  const members = catalog.members;
  for (const area of areas) requested.push(...Object.keys(view.rooms.ofId).filter(entity => view.rooms.ofId[entity] === area));
  for (const device of devices) requested.push(...view.devices?.[device] ?? []);
  for (const label of labels) requested.push(...view.labels?.[label] ?? []);
  const expanded = [...requested];
  for (const source of requested) expanded.push(...catalog.groups.members(source));
  expanded.push(...expandedEntities(view, requested));
  const lamps = Object.entries(members).filter(([lamp, physical]) => expanded.includes(lamp) || physical.some(entity =>
    expanded.includes(entity))).map(([lamp]) => lamp);
  const roomScopes = [...areas];
  for (const source of requested) {
    if (!catalog.groups.has(source)) continue;
    // Read as text: compared with the catalog's lamp keys, which `Object.keys` gives as text.
    const membersOfGroup: string[] = catalog.groups.members(source);
    for (const area of areasOf(view, membersOfGroup)) if (Object.keys(members).filter(lamp => view.rooms.ofId[lamp] === area).every(lamp =>
      membersOfGroup.includes(lamp))) roomScopes.push(area);
  }
  if (!roomScopes.length && !lamps.length) return { records: [], power: [] };
  // Read as text: a lamp with no room is looked up as `''`, which a requested area of `''` matches.
  const roomScopeTexts: readonly string[] = roomScopes;
  const { baseTargets, resolvedTargets } = args.current();
  const items: ScopeItem[] = unique(roomScopes).sort().filter(area => baseTargets.populatedLeniently(`room:${area}`)).map(area =>
    ({ scope: 'room', target: area, base: `room:${area}` }));
  for (const lamp of lamps) if (!roomScopeTexts.includes(view.rooms.ofId[lamp] ?? '')) items.push({ scope: 'lamp', target: lamp, base: lamp });
  const power: PowerEvent[] = areasOf(view, lamps).sort().map(area => ({ op: 'power', area, on: true, via: 'app' }));
  if (!items.length) return { records: [], power };
  const resolvedTargetMap = resolvedTargets();
  const records: ChannelRecord[] = [];
  for (const item of items) {
    const base = baseTargets.target(item.base, 'effects_native_plan.current.plan.base');
    const resolved = resolvedTargetMap.target(item.base, 'effects_native_plan.current.plan.resolved.targets');
    if (!base.populated || !resolved.populated) continue;
    let channels: Record<string, ChannelClaim> = {};
    let brightness = requestedBrightness(sd.brightness, resolved);
    if (brightness !== undefined) {
      if (Number(brightness) < 0) brightness = 0;
      else if (Number(brightness) > 255) brightness = 255;
      channels.brightness = constant(brightness, args.stamp());
    }
    const color = nativeColor(view, sd.colour, item.target);
    if (color !== undefined) channels.color = constant(color, args.stamp());
    if (sd.effect !== undefined) {
      const requestedEffect = sd.effect.toLowerCase();
      let selected: string | undefined;
      for (const effect of catalog.effects.names) if (effect.toLowerCase() === requestedEffect) selected = effect;
      if (selected) {
        for (const channel of catalog.effects.channels(selected)) channels[channel] = { kind: 'effect', effect: selected,
          instance: `native:${[...requested, ...areas, ...devices, ...labels].sort().join('|')}:${selected}`, updated: args.stamp(),
          ...(brightness !== undefined ? { intensity: brightness } : {}) };
      } else if (['none', 'normal light',
        'off'].includes(requestedEffect)) channels = { ...held(base, resolved, 'effects_native_plan resolved target', args.stamp()), ...channels };
    }
    if (Object.keys(channels).length > 0) records.push({ kind: 'channels', key: overlayKeyText({ kind: 'native control', base: item.base }),
      source: `native:${item.base}`, scope: item.scope, target: item.target, value: { channels } });
  }
  return { records, power };
}
function expandedEntities(view: HouseView, entities: string[]): string[] {
  const pending = [...entities], seen = new Set<string>(), result: string[] = [];
  while (pending.length) {
    const entity = pending.shift()!;
    if (seen.has(entity)) continue;
    seen.add(entity);
    if (!view.state[entity]) continue;
    const sources = view.entitySources;
    const group = entity.startsWith('group.') || sources?.[entity] === 'group';
    const zone = entity.startsWith('zone.');
    if (group || zone) { const children = groupChildren(view, entity, zone); if (children !== undefined) pending.push(...children); }
    else result.push(entity);
  }
  return result;
}
/** The brightness a call asks of one scope item; a computed kind reads the item's resolved level first. */
function requestedBrightness(request: BrightnessRequest, resolved: PlanTarget): number | boolean | undefined {
  const context = 'effects_native_plan resolved target';
  if (request.kind === 'absolute') return request.value;
  if (request.kind === 'percent') return request.percent() * 255 / 100;
  if (request.kind === 'step') return stepFrom(resolved, context) + request.step();
  if (request.kind === 'step percent') return stepFrom(resolved, context) + request.step() * 255 / 100;
  return undefined;
}
/** The level a step starts from: the item's resolved level, or {@link STEP_FROM_OFF} when it has none. */
function stepFrom(resolved: PlanTarget, context: string): number {
  const level = resolved.level(context);
  return level === undefined ? STEP_FROM_OFF : level;
}

export type ControlPlan = {
  valid: boolean; errors: string[]; events: Array<PowerEvent | SetEvent>; commands: ControlCommand[]; records: ChannelRecord[];
};

/**
 * Where a brightness step starts on a lamp that shows no level (it is off):
 * 0, as Home Assistant's own `brightness_step` steps an off light.
 */
const STEP_FROM_OFF = 0;

export function planUIControls(view: HouseView, args: SetRequest, catalog: NativeCatalog, current: NativeCurrent | undefined): ControlPlan {
  const { source, attribute, value } = args;
  const profile = source.startsWith('light.ls_'), members = catalog.members;
  const targets = catalog.groups.has(source) ? catalog.groups.members(source) : [source];
  const stamp = recordTimestamp(view.now);
  const errors: string[] = [], events: Array<PowerEvent | SetEvent> = [], commands: ControlCommand[] = [], records: ChannelRecord[] = [];
  if (!['power', 'brightness', 'rgb', 'temperature', 'effect'].includes(attribute)) errors.push('Unsupported control attribute.');
  if (attribute === 'effect' && value.raw !== 'Normal light' && !catalog.effects.has(value.text)) errors.push('Unknown effect.');
  if (attribute === 'power' && value.raw !== 'ON' && value.raw !== 'OFF') errors.push('Power must be ON or OFF.');
  // These were `jinjaFloat(value, -1)` range checks: a non-numeric input took
  // the -1 fallback and so failed the bound, which is how the captured
  // `| float(-1)` reports it. `inRange` keeps that outcome — the same error
  // string, for the same inputs — without a sentinel standing in for "not a
  // number"; the parsed `brightness` and `kelvin` are defined exactly when
  // their `inRange` check passes (`src/parse/native-controls.ts`). The parity probe found all 14 of the gate's coercion-fallback
  // hits here, every one of them a `null` value, so this is the only site
  // where the leniency was load-bearing at all.
  const { brightness, kelvin } = value;
  if (attribute === 'brightness' && brightness === undefined) errors.push('Brightness must be 0–255.');
  if (attribute === 'temperature' && kelvin === undefined) errors.push('Temperature must be 100–1000 mireds.');
  const rgb = value.components;
  if (attribute === 'rgb') {
    if (rgb === undefined || rgb.length !== 3) errors.push('RGB needs three components.');
    else for (const component of rgb) if (!component.inRange(0, 255)) errors.push('RGB components must be 0–255.');
  }
  // Reached only with no errors, so an rgb control's three components are there.
  const rgbInts = () => rgb!.map(component => component.int);
  if (profile) {
    const store = source.replace('light.', 'input_text.');
    if (!view.state[store]) errors.push('Unknown schedule profile.');
    if (!errors.length) {
      if (attribute === 'effect') commands.push({ action: 'script.ls_store', data: { store, effect: value.string('effects_set') }, target: {} });
      else if (attribute === 'power' && value.raw === 'OFF') commands.push({ action: 'light.turn_off', target: { entity_id: source }, data: {} });
      else {
        // With no errors, a brightness or temperature control's value passed its check, so it is defined here.
        const data: LightData = attribute === 'brightness' && brightness !== undefined ? { brightness } : attribute === 'rgb' ?
          { rgb_color: rgbInts() } : attribute === 'temperature' && kelvin !== undefined ? { color_temp_kelvin: kelvin } : {};
        commands.push({ action: 'light.turn_on', target: { entity_id: source }, data });
      }
    }
  } else {
    if (targets.length === 0 || targets.some(target => !(target in members))) errors.push('Unknown logical lamp or room.');
    const scopes: ScopeItem[] = [], scopeAreas: RoomId[] = [];
    // Read as text, as the lamp loop below looks a lamp with no room up as `''`.
    const scopeAreaTexts: readonly string[] = scopeAreas;
    if (catalog.groups.has(source)) {
      const areas = areasOf(view, targets).sort();
      for (const area of areas) {
        if (Object.keys(members).filter(lamp => view.rooms.ofId[lamp] === area).every(lamp => targets.includes(lamp))) {
          scopes.push({ scope: 'room', target: area, base: `room:${area}`, suffix: areas.length > 1 ? `:${area}` : '' });
          scopeAreas.push(area);
        }
      }
    }
    for (const lamp of targets) if (!scopeAreaTexts.includes(view.rooms.ofId[lamp] ?? '')) scopes.push({ scope: 'lamp', target: lamp, base: lamp,
      suffix: targets.length > 1 ? `:${lamp}` : '' });
    if (!errors.length && attribute === 'power') {
      const powerAreas = value.raw === 'ON' ? areasOf(view, targets) : scopeAreas;
      for (const area of powerAreas) events.push({ op: 'power', area, on: value.raw === 'ON', via: 'effects-house' });
      // A lamp with no area is never in the scope (captured `area_id(L)` is none).
      const ids = [...targets, ...switchRangeIterable(view.attr('sensor.ls_overrides', 'switch_ranges')).filter(lamp => {
        const area = view.rooms.ofId[lamp];
        return area !== undefined && scopeAreas.includes(area);
      })];
      commands.push({ action: value.raw === 'ON' ? 'homeassistant.turn_on' : 'homeassistant.turn_off', target: { entity_id: unique(ids) },
        data: {} });
    } else if (!errors.length) {
      if (current === undefined) throw new Error('effects_set current plan is required for channel controls');
      const { baseTargets, resolvedTargets } = current;
      const effectValue = attribute === 'effect' ? value.string('effects_set') : undefined;
      for (const item of scopes) {
        const base = baseTargets.target(item.base, 'effects_set.current.plan.base');
        const resolved = resolvedTargets.target(item.base, 'effects_set.current.plan.resolved.targets');
        if (!base.populated || !resolved.populated) { errors.push(`Missing resolved lighting state for ${item.target}`); continue; }
        let channels: Record<string, ChannelClaim> = {};
        if (attribute === 'effect' && value.raw !== 'Normal light') {
          const effect = effectValue!;
          for (const channel of catalog.effects.channels(effect)) channels[channel] = { kind: 'effect', effect,
            instance: `ui:${source}:${effect}`, updated: stamp };
        } else if (attribute === 'effect') channels = held(base, resolved, 'effects_set resolved target', stamp);
        else if (attribute === 'brightness') channels = { brightness: constant(value.int, stamp) };
        else if (attribute === 'rgb') channels = { color: constant({ rgb: rgbInts() }, stamp) };
        else if (attribute === 'temperature') channels = { color: constant({ kelvin: roundEven(1000000 / value.float) }, stamp) };
        const key: OverlayKey = { kind: 'dashboard control', control: `${source}${item.suffix ?? ''}` };
        records.push({ kind: 'channels', key: overlayKeyText(key), source: `ui:${source}`, scope: item.scope,
          target: item.target, value: { channels, ...(attribute === 'effect' ? { selection: effectValue! } : {}) } });
      }
      if (records.length && !errors.length) events.push({ op: 'set', records, via: 'effects-house' });
    }
  }
  return { valid: errors.length === 0, errors, events: errors.length ? [] : events, commands: errors.length ? [] : commands,
    records: errors.length ? [] : records };
}

/** The rooms the entities are in, each once; an entity with no room adds none. */
function areasOf(view: HouseView, entities: string[]): RoomId[] {
  return unique(entities.map(entity => view.rooms.ofId[entity]).filter(isAreaId));
}

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }

/**
 * What a reset to normal light holds: the item's level, then its underlying
 * colour. Both channels are always claimed, so the reset outranks older claims;
 * a channel with nothing underneath (an off lamp has no level and no colour) is
 * claimed with no value, which the resolver reads as an invalid source and
 * drops to the schedule -- the spelling the captured reset already wrote for an
 * absent colour.
 */
function held(base: PlanTarget, resolved: PlanTarget, context: string, stamp: Stamp): Record<string, ChannelClaim> {
  const level = resolved.level(context);
  return { brightness: level === undefined ? { kind: 'constant', updated: stamp } : constant(level, stamp),
    color: constant(underlyingColour(base, resolved), stamp) };
}

function constant(value: number | boolean | ClaimColour, stamp: Stamp): ConstantClaim { return { kind: 'constant', value, updated: stamp }; }


