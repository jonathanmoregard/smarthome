import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, jinjaInt, jinjaString, jinjaTruthy, ParseError, parsePythonNumeric, requireArray, requireNumber, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { object, rgbValue, roundEven } from './scale.ts';
import type { RGB } from './scale.ts';
import { recordTimestamp } from './resolution.ts';

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
interface NativePlan extends JsonObject { records: JsonObject[]; power: JsonObject[] }
interface ControlPlan extends JsonObject { valid: boolean; errors: string[]; events: JsonObject[]; commands: JsonObject[]; records: JsonObject[] }
interface NativeCatalog {
  members: Record<string, string[]>;
  groups: JsonObject;
  effects: JsonObject;
}
interface NativeCurrent {
  baseTargets: JsonObject;
  resolvedTargets: JsonObject;
}
interface LazyNativeCurrent {
  baseTargets: JsonObject;
  resolvedTargets: () => JsonObject;
}
interface NativePlanArgs {
  sd: JsonObject;
  areas: string[];
  devices: string[];
  labels: string[];
  requested: string[];
  catalog: NativeCatalog;
  current: () => LazyNativeCurrent;
  stamp: () => JsonValue;
}
interface SetArgs {
  source: string;
  attribute: string;
  value: JsonValue | undefined;
  dryRun: boolean;
}
function lazy<T>(parse: () => T): () => T {
  let parsed = false;
  let value: T;
  return () => {
    if (!parsed) {
      value = parse();
      parsed = true;
    }
    return value;
  };
}
function selector(container: JsonObject, key: string, split = false): string[] {
  const value = container[key];
  if (value === undefined) return [];
  const values = typeof value === 'string' ? (split ? value.split(',') : [value]) : requireArray(container, key, 'effects_native_plan.sd');
  return values.map((item, index) => requireString({ item }, 'item', `effects_native_plan.sd.${key}[${index}]`));
}
function stringArray(value: JsonValue | undefined, context: string): string[] {
  return requireArray({ value: value ?? [] }, 'value', context).map((item, index) =>
    requireString({ item }, 'item', `${context}[${index}]`));
}
function numberArray(container: JsonObject, key: string, length: 2, context: string): [number, number];
function numberArray(container: JsonObject, key: string, length: 3, context: string): RGB;
function numberArray(container: JsonObject, key: string, length: 4 | 5, context: string): number[];
function numberArray(container: JsonObject, key: string, length: number, context: string): number[] {
  const values = requireArray(container, key, context);
  if (values.length !== length) throw new ParseError(`${context}.${key} must contain ${length} values`);
  const parsed = values.map((value, index) => requireNumber({ value }, 'value', `${context}.${key}[${index}]`));
  if (length === 2) return [parsed[0]!, parsed[1]!];
  if (length === 3) return [parsed[0]!, parsed[1]!, parsed[2]!];
  return parsed;
}
function optionalObject(container: JsonObject, key: string, context: string): JsonObject {
  return container[key] === undefined ? {} : requireObject(container, key, context);
}
function parseCatalog(value: JsonValue | undefined, context: string): NativeCatalog {
  const catalog = value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
  const members = requireObject(catalog, 'members', context);
  return {
    members: Object.fromEntries(Object.entries(members).map(([lamp, physical]) =>
      [lamp, stringArray(physical, `${context}.members.${lamp}`)])),
    groups: requireObject(catalog, 'groups', context),
    effects: requireObject(catalog, 'effects', context),
  };
}
function parseCurrent(value: JsonValue | undefined, context: string): NativeCurrent {
  const current = value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
  const plan = requireObject(current, 'plan', context);
  const resolved = requireObject(plan, 'resolved', `${context}.plan`);
  return {
    baseTargets: requireObject(plan, 'base', `${context}.plan`),
    resolvedTargets: requireObject(resolved, 'targets', `${context}.plan.resolved`),
  };
}
function parseLazyCurrent(value: JsonValue | undefined, context: string): LazyNativeCurrent {
  const current = value === undefined ? requireObject({}, 'value', context) : requireObject({ value }, 'value', context);
  const plan = requireObject(current, 'plan', context);
  return {
    baseTargets: requireObject(plan, 'base', `${context}.plan`),
    resolvedTargets: lazy(() => {
      const resolved = requireObject(plan, 'resolved', `${context}.plan`);
      return requireObject(resolved, 'targets', `${context}.plan.resolved`);
    }),
  };
}
function group(catalog: NativeCatalog, source: string): string[] {
  return catalog.groups[source] === undefined ? [] : stringArray(catalog.groups[source], `catalog.groups.${source}`);
}
function effectChannels(catalog: NativeCatalog, effect: string): string[] {
  const definition = requireObject(catalog.effects, effect, 'catalog.effects');
  return stringArray(definition.channels, `catalog.effects.${effect}.channels`);
}
function requiredStringValue(value: JsonValue | undefined, context: string): string {
  return value === undefined ? requireString({}, 'value', context) : requireString({ value }, 'value', context);
}
function requiredValue(container: JsonObject, key: string, context: string): JsonValue {
  const value = container[key];
  if (value === undefined) throw new ParseError(`${context}.${key} is required`);
  return value;
}
/**
 * Is `value` a finite number within `[low, high]`?
 *
 * A non-numeric input is simply out of range rather than being coerced to a
 * sentinel first. `optionalFinite` is not used here because an un-parseable
 * *string* must answer `false` rather than raise: this is a validation that
 * collects error messages, so rejecting is the job.
 *
 * `parsePythonNumeric` rather than `parseFinite` because the oracle accepts
 * `value: true` as brightness 1 — `bool` is an `int` subclass in Python — and
 * a parity test covers it. That is the only inherited numeric quirk left here.
 */
function inRange(value: JsonValue | undefined, low: number, high: number): boolean {
  const parsed = parsePythonNumeric(value);
  return parsed !== undefined && low <= parsed && parsed <= high;
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
function numeric(value: JsonValue | undefined): value is number | boolean { return typeof value === 'number' || typeof value === 'boolean'; }
function populated(value: JsonObject): boolean { return Object.keys(value).length > 0; }
function get(value: JsonObject, key: string, fallback: JsonValue): JsonValue { return value[key] === undefined ? fallback : value[key]; }
function constant(value: JsonValue, stamp: JsonValue): JsonObject { return { kind: 'constant', value, updated: stamp }; }
function areasOf(ctx: ScriptContext, entities: string[]): string[] { return unique(entities.map(entity => ctx.areas[entity] ?? '').filter(Boolean)); }
function expandedEntities(ctx: ScriptContext, entities: string[]): string[] {
  const pending = [...entities], seen = new Set<string>(), result: string[] = [];
  while (pending.length) {
    const entity = pending.shift()!;
    if (seen.has(entity)) continue;
    seen.add(entity);
    if (!ctx.state[entity]) continue;
    const sources = (ctx as ScriptContext & { entitySources?: Record<string, string> }).entitySources;
    const group = entity.startsWith('group.') || sources?.[entity] === 'group';
    const zone = entity.startsWith('zone.');
    const children = ctx.attr(entity, zone ? 'persons' : 'entity_id');
    if (group || zone) { if (Array.isArray(children)) pending.push(...children.map(String)); }
    else result.push(entity);
  }
  return result;
}
function underlyingColor(base: JsonObject, resolved: JsonObject): JsonValue {
  const color = requireObject(resolved, 'color', 'resolved target');
  return color.policy === 'sara' ? base.color! : color.kind === 'effect' ? get(color, 'base', base.color!) : color.value!;
}

/** Convert native HA colour payloads to the existing logical RGB/Kelvin form. */
export function nativeColor(ctx: ScriptContext, data: JsonObject, lamp: string): JsonObject {
  if ('color_temp_kelvin' in data) return { kelvin: data.color_temp_kelvin! };
  if ('kelvin' in data) return { kelvin: data.kelvin! };
  if ('rgb_color' in data) return { rgb: numberArray(data, 'rgb_color', 3, 'effects_native_plan.sd') };
  if ('hs_color' in data) {
    const [hue, saturation] = numberArray(data, 'hs_color', 2, 'effects_native_plan.sd');
    const wrapped = hue % 360;
    const h = (wrapped < 0 ? wrapped + 360 : wrapped) / 60, c = saturation / 100;
    const x = c * (1 - Math.abs(h % 2 - 1)), m = 1 - c;
    const triplet = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return { rgb: triplet.map(component => roundEven((component + m) * 255)) };
  }
  if ('xy_color' in data) {
    const [x, y] = numberArray(data, 'xy_color', 2, 'effects_native_plan.sd');
    if (y <= 0) return { rgb: [0, 0, 0] };
    const X = x / y, Z = (1 - x - y) / y;
    const linear = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.011530];
    const gamma = linear.map(v => Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    const peak = Math.max(1, ...gamma);
    return { rgb: gamma.map(v => roundEven(v / peak * 255)) };
  }
  if ('rgbw_color' in data || 'rgbww_color' in data) {
    const key = 'rgbw_color' in data ? 'rgbw_color' : 'rgbww_color';
    const channels = numberArray(data, key, key === 'rgbw_color' ? 4 : 5, 'effects_native_plan.sd');
    let white: number[];
    if (channels.length === 4) white = [channels[3]!, channels[3]!, channels[3]!];
    else {
      const cold = rgbValue({ kelvin: jinjaInt(ctx.attr(lamp, 'max_color_temp_kelvin'), 6500) });
      const warm = rgbValue({ kelvin: jinjaInt(ctx.attr(lamp, 'min_color_temp_kelvin'), 2000) });
      white = [0, 1, 2].map(i => (cold[i]! * channels[3]! + warm[i]! * channels[4]!) / 255);
    }
    const mixed = [0, 1, 2].map(i => channels[i]! + white[i]!);
    const peak = Math.max(1, ...mixed), brightness = Math.max(...channels);
    return { rgb: mixed.map(v => roundEven(v / peak * brightness)) };
  }
  if ('color_name' in data) {
    const color = COLOR_NAMES[jinjaString(data.color_name).toLowerCase().replaceAll(' ', '')];
    return color ? { rgb: [...color] } : {};
  }
  return 'white' in data ? { rgb: [255, 255, 255] } : {};
}

export function planNativeControls(ctx: ScriptContext, args: NativePlanArgs): NativePlan {
  const { sd, catalog, areas, devices, labels, requested } = args;
  const members = catalog.members;
  for (const area of areas) requested.push(...Object.keys(ctx.areas).filter(entity => ctx.areas[entity] === area));
  for (const device of devices) requested.push(...ctx.devices?.[device] ?? []);
  for (const label of labels) requested.push(...ctx.labels?.[label] ?? []);
  const expanded = [...requested];
  for (const source of requested) expanded.push(...group(catalog, source));
  expanded.push(...expandedEntities(ctx, requested));
  const lamps = Object.entries(members).filter(([lamp, physical]) => expanded.includes(lamp) || physical.some(entity => expanded.includes(entity))).map(([lamp]) => lamp);
  const roomScopes = [...areas];
  for (const source of requested) {
    if (!(source in catalog.groups)) continue;
    const membersOfGroup = group(catalog, source);
    for (const area of areasOf(ctx, membersOfGroup)) if (Object.keys(members).filter(lamp => ctx.areas[lamp] === area).every(lamp => membersOfGroup.includes(lamp))) roomScopes.push(area);
  }
  if (!roomScopes.length && !lamps.length) return { records: [], power: [] };
  const { baseTargets, resolvedTargets } = args.current();
  const items: ScopeItem[] = unique(roomScopes).sort().filter(area => populated(object(baseTargets[`room:${area}`]))).map(area => ({ scope: 'room', target: area, base: `room:${area}` }));
  for (const lamp of lamps) if (!roomScopes.includes(ctx.areas[lamp] ?? '')) items.push({ scope: 'lamp', target: lamp, base: lamp });
  const power = areasOf(ctx, lamps).sort().map(area => ({ op: 'power', area, on: true, via: 'app' }));
  if (!items.length) return { records: [], power };
  const resolvedTargetMap = resolvedTargets();
  const records: JsonObject[] = [];
  for (const item of items) {
    const base = optionalObject(baseTargets, item.base, 'effects_native_plan.current.plan.base');
    const resolved = optionalObject(resolvedTargetMap, item.base, 'effects_native_plan.current.plan.resolved.targets');
    if (!populated(base) || !populated(resolved)) continue;
    let brightness: JsonValue = null, channels: JsonObject = {};
    if ('brightness' in sd) brightness = sd.brightness!;
    else if ('brightness_pct' in sd) brightness = requireNumber(sd, 'brightness_pct', 'effects_native_plan.sd') * 255 / 100;
    else if ('brightness_step' in sd) brightness = requireNumber(resolved, 'level', 'effects_native_plan resolved target') + requireNumber(sd, 'brightness_step', 'effects_native_plan.sd');
    else if ('brightness_step_pct' in sd) brightness = requireNumber(resolved, 'level', 'effects_native_plan resolved target') + requireNumber(sd, 'brightness_step_pct', 'effects_native_plan.sd') * 255 / 100;
    else if ('white' in sd) brightness = sd.white!;
    if (numeric(brightness)) {
      if (Number(brightness) < 0) brightness = 0;
      else if (Number(brightness) > 255) brightness = 255;
      channels.brightness = constant(brightness, args.stamp());
    }
    const color = nativeColor(ctx, sd, item.target);
    if (populated(color)) channels.color = constant(color, args.stamp());
    if ('effect' in sd) {
      const requestedEffect = jinjaString(sd.effect).toLowerCase();
      let selected: string | undefined;
      for (const effect of Object.keys(catalog.effects)) if (effect.toLowerCase() === requestedEffect || (effect === 'Colour loop' && requestedEffect === 'colorloop')) selected = effect;
      if (selected) {
        for (const channel of effectChannels(catalog, selected)) channels[channel] = { kind: 'effect', effect: selected, instance: `native:${[...requested, ...areas, ...devices, ...labels].sort().join('|')}:${selected}`, updated: args.stamp(), ...(numeric(brightness) ? { intensity: brightness } : {}) };
      } else if (['none', 'normal light', 'off'].includes(requestedEffect)) channels = { brightness: constant(requireNumber(resolved, 'level', 'effects_native_plan resolved target'), args.stamp()), color: constant(underlyingColor(base, resolved), args.stamp()), ...channels };
    }
    if (populated(channels)) records.push({ kind: 'channels', key: `channels:native:${item.base}`, source: `native:${item.base}`, scope: item.scope, target: item.target, value: { channels } });
  }
  return { records, power };
}

export function planUIControls(ctx: ScriptContext, args: SetArgs, catalog: NativeCatalog, current: NativeCurrent | undefined): ControlPlan {
  const { source, attribute } = args;
  const value = attribute === 'effect' && args.value === 'Normal Light' ? 'Normal light' : args.value;
  const profile = source.startsWith('light.ls_'), members = catalog.members;
  const targets = source in catalog.groups ? group(catalog, source) : [source];
  const stamp = recordTimestamp(ctx.now);
  const errors: string[] = [], events: JsonObject[] = [], commands: JsonObject[] = [], records: JsonObject[] = [];
  if (!['power', 'brightness', 'rgb', 'temperature', 'effect'].includes(attribute)) errors.push('Unsupported control attribute.');
  if (attribute === 'effect' && value !== 'Normal light' && !(jinjaString(value) in catalog.effects)) errors.push('Unknown effect.');
  if (attribute === 'power' && value !== 'ON' && value !== 'OFF') errors.push('Power must be ON or OFF.');
  // These were `jinjaFloat(value, -1)` range checks: a non-numeric input took
  // the -1 fallback and so failed the bound, which is how the captured
  // `| float(-1)` reports it. `inRange` keeps that outcome — the same error
  // string, for the same inputs — without a sentinel standing in for "not a
  // number". The parity probe found all 14 of the gate's coercion-fallback
  // hits here, every one of them a `null` value, so this is the only site
  // where the leniency was load-bearing at all.
  if (attribute === 'brightness' && !inRange(value, 0, 255)) errors.push('Brightness must be 0–255.');
  if (attribute === 'temperature' && !inRange(value, 100, 1000)) errors.push('Temperature must be 100–1000 mireds.');
  const rgb = typeof value === 'string' ? value.split(',') : value;
  if (attribute === 'rgb') {
    if (!Array.isArray(rgb) || rgb.length !== 3) errors.push('RGB needs three components.');
    else for (const component of rgb) if (!inRange(component, 0, 255)) errors.push('RGB components must be 0–255.');
  }
  if (profile) {
    const store = source.replace('light.', 'input_text.');
    if (!ctx.state[store]) errors.push('Unknown schedule profile.');
    if (!errors.length) {
      if (attribute === 'effect') commands.push({ action: 'script.ls_store', data: { store, effect: requiredStringValue(value, 'effects_set') }, target: {} });
      else if (attribute === 'power' && value === 'OFF') commands.push({ action: 'light.turn_off', target: { entity_id: source }, data: {} });
      else {
        const data = attribute === 'brightness' ? { brightness: jinjaInt(value) } : attribute === 'rgb' ? { rgb_color: (rgb as JsonValue[]).map(v => jinjaInt(v)) } : attribute === 'temperature' ? { color_temp_kelvin: roundEven(1000000 / jinjaFloat(value)) } : {};
        commands.push({ action: 'light.turn_on', target: { entity_id: source }, data });
      }
    }
  } else {
    if (targets.length === 0 || targets.some(target => !(target in members))) errors.push('Unknown logical lamp or room.');
    const scopes: ScopeItem[] = [], scopeAreas: string[] = [];
    if (source in catalog.groups) {
      const areas = areasOf(ctx, targets).sort();
      for (const area of areas) {
        if (Object.keys(members).filter(lamp => ctx.areas[lamp] === area).every(lamp => targets.includes(lamp))) {
          scopes.push({ scope: 'room', target: area, base: `room:${area}`, suffix: areas.length > 1 ? `:${area}` : '' });
          scopeAreas.push(area);
        }
      }
    }
    for (const lamp of targets) if (!scopeAreas.includes(ctx.areas[lamp] ?? '')) scopes.push({ scope: 'lamp', target: lamp, base: lamp, suffix: targets.length > 1 ? `:${lamp}` : '' });
    if (!errors.length && attribute === 'power') {
      const powerAreas = value === 'ON' ? areasOf(ctx, targets) : scopeAreas;
      for (const area of powerAreas) events.push({ op: 'power', area, on: value === 'ON', via: 'effects-house' });
      const ids = [...targets, ...Object.keys(object(ctx.attr('sensor.ls_overrides', 'switch_ranges'))).filter(lamp => scopeAreas.includes(ctx.areas[lamp] ?? ''))];
      commands.push({ action: value === 'ON' ? 'homeassistant.turn_on' : 'homeassistant.turn_off', target: { entity_id: unique(ids) }, data: {} });
    } else if (!errors.length) {
      if (current === undefined) throw new Error('effects_set current plan is required for channel controls');
      const { baseTargets, resolvedTargets } = current;
      const effectValue = attribute === 'effect' ? requiredStringValue(value, 'effects_set') : undefined;
      for (const item of scopes) {
        const base = optionalObject(baseTargets, item.base, 'effects_set.current.plan.base');
        const resolved = optionalObject(resolvedTargets, item.base, 'effects_set.current.plan.resolved.targets');
        if (!populated(base) || !populated(resolved)) { errors.push(`Missing resolved lighting state for ${item.target}`); continue; }
        let channels: JsonObject = {};
        if (attribute === 'effect' && value !== 'Normal light') {
          const effect = effectValue!;
          for (const channel of effectChannels(catalog, effect)) channels[channel] = { kind: 'effect', effect, instance: `ui:${source}:${effect}`, updated: stamp };
        } else if (attribute === 'effect') channels = { brightness: constant(requireNumber(resolved, 'level', 'effects_set resolved target'), stamp), color: constant(underlyingColor(base, resolved), stamp) };
        else if (attribute === 'brightness') channels = { brightness: constant(jinjaInt(value), stamp) };
        else if (attribute === 'rgb') channels = { color: constant({ rgb: (rgb as JsonValue[]).map(v => jinjaInt(v)) }, stamp) };
        else if (attribute === 'temperature') channels = { color: constant({ kelvin: roundEven(1000000 / jinjaFloat(value)) }, stamp) };
        records.push({ kind: 'channels', key: `channels:ui:${source}${item.suffix ?? ''}`, source: `ui:${source}`, scope: item.scope, target: item.target, value: { channels, ...(attribute === 'effect' ? { selection: effectValue! } : {}) } });
      }
      if (records.length && !errors.length) events.push({ op: 'set', records, via: 'effects-house' });
    }
  }
  return { valid: errors.length === 0, errors, events: errors.length ? [] : events, commands: errors.length ? [] : commands, records: errors.length ? [] : records };
}

function setControls(ctx: ScriptContext, args: SetArgs): JsonValue {
  const catalog = parseCatalog(ctx.run('effects_catalog'), 'effects_set.catalog');
  const current = !args.source.startsWith('light.ls_') && args.attribute !== 'power' ? parseCurrent(ctx.run('ls_plan', { reason: 'config' }), 'effects_set.current') : undefined;
  const result = planUIControls(ctx, args, catalog, current);
  if (args.dryRun) return result;
  if (!result.valid) throw new Error(result.errors.join(' '));
  for (const event of result.events) ctx.fire('ls_override', event);
  for (const command of result.commands) {
    const action = String(command.action), data = object(command.data), target = object(command.target);
    if (action === 'script.ls_store') ctx.run('ls_store', data);
    else ctx.emit(action, data, target);
  }
  return result;
}
export const nativeHandlers: ScriptHandlers = {
  // Captured effects_native_plan reads sd/catalog/current/stamp raw (19/8/3/5
  // sites). Selector fields entity_id/area_id/device_id/label_id use missing
  // empty-list fallbacks before iteration; brightness_pct/brightness_step/
  // brightness_step_pct and hs/xy/rgbw/rgbww components are raw arithmetic or
  // indexed values, so they parse strictly. color_temp_kelvin/kelvin are raw
  // pass-through payloads. The two HA Kelvin attributes use `| int(6500)` /
  // `| int(2000)`. Nested members/groups/effects and plan/base/resolved/targets
  // are indexed raw structures. Stamp is a raw pass-through payload; current,
  // its resolved subtree, and stamp stay lazy until selected work needs them.
  effects_native_plan: withParsedArgs({
    parse: args => {
      const sd = requireObject(args, 'sd', 'effects_native_plan');
      return {
        sd,
        areas: selector(sd, 'area_id'),
        devices: selector(sd, 'device_id'),
        labels: selector(sd, 'label_id'),
        requested: selector(sd, 'entity_id', true),
        catalog: parseCatalog(args.catalog, 'effects_native_plan.catalog'),
        current: lazy(() => parseLazyCurrent(args.current, 'effects_native_plan.current')),
        stamp: lazy(() => requiredValue(args, 'stamp', 'effects_native_plan')),
      };
    },
    run: planNativeControls,
  }),
  // Captured effects_set reads source/attribute raw (11/20 sites), value raw
  // 18 times plus `| float(-1)` four times and `| int` twice, and dry_run once
  // through `| default(false)`. Preserve both numeric filters: float for range
  // checks/temperature arithmetic, int for emitted brightness/RGB values.
  effects_set: withParsedArgs({
    parse: args => ({
      source: requireString(args, 'source', 'effects_set'),
      attribute: requireString(args, 'attribute', 'effects_set'),
      value: args.value,
      dryRun: jinjaTruthy(args.dry_run),
    }),
    run: setControls,
  }),
};
