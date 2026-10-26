import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptHandlers } from '../runtime/context.ts';
import { gradientSignature, planGradients, sampleGradient, validGradient } from './gradient.ts';
import type { GradientCurve } from './gradient.ts';
import { anchor, boundedNumber, canonicalColor, clamp, isObject, object, scaleValue, validColor, WARM_END } from './scale.ts';
import type { RGB, Scaled } from './scale.ts';

const CHANNELS = ['brightness', 'color'] as const;
type Channel = typeof CHANNELS[number];
interface Candidate { key: string; updated: number; source: JsonValue | undefined; baselineOnly: boolean }
interface InputPosition { position: number; level: number }
export interface ResolvedTarget extends JsonObject {
  brightness: JsonObject;
  color: JsonObject;
  period: JsonValue;
  on: JsonValue;
  area: string;
  is_room: JsonValue;
  level: JsonValue;
  owners: JsonObject;
  transition: JsonValue;
}
export interface ResolutionResult extends JsonObject { targets: Record<string, ResolvedTarget>; assignments: Record<string, ResolvedTarget> }
function sortedEntries(o: JsonObject): [string, JsonValue][] {
  return Object.entries(o).sort(([a], [b]) => lexical(a, b));
}
function lexical(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}
function truth(value: JsonValue | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : Boolean(value);
}
export function recordTimestamp(value: JsonValue | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  // Date.parse truncates sub-millisecond precision; HA record order uses microseconds.
  const fraction = /(?:T| )\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1];
  const timestamp = Date.parse(fraction ? value.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1') : value);
  return Number.isNaN(timestamp) ? 0 : timestamp / 1000 + (fraction ? Number('0.' + fraction.slice(0, 6)) : 0);
}
export function latestRemoteKey(records: JsonObject, room: string): string {
  let key = '', stamp = -1;
  for (const [candidate, record] of sortedEntries(records)) {
    if (!isObject(record) || record.scope !== 'room' || record.target !== room || !(record.kind === 'input' || (record.kind === 'channels' && record.via === 'remote'))) continue;
    const timestamp = recordTimestamp(record.when);
    if (timestamp >= stamp) { key = candidate; stamp = timestamp; }
  }
  return key;
}
export function normalPosition(input: JsonObject, item: JsonObject, level: number): number {
  const day = anchor(item.day), cosy = anchor(item.cosy);
  const d = day.brightness - cosy.brightness;
  const floor = Math.min(76.5, cosy.brightness);
  const slope = Math.max(0, d, (cosy.brightness - floor) / 2);
  let seed: number;
  if (input.anchor === 'day') seed = 1;
  else if (input.anchor === 'cosy') seed = 0;
  else if (typeof input.legacy_position === 'number' || typeof input.legacy_position === 'boolean') seed = Number(input.legacy_position);
  else if (level > day.brightness && day.brightness < 255) seed = 1 + (level - day.brightness) / (255 - day.brightness);
  else if (level < cosy.brightness && slope > 0) seed = Math.max(-2, (level - cosy.brightness) / slope);
  else seed = d > 0 ? (level - cosy.brightness) / d : 1;
  return clamp(seed * 10 + (input.steps as number), input.lower as number, input.upper as number) / 10;
}
export function inputClaims(value: JsonObject, key: string, stamp: number): JsonObject[] {
  const claims: JsonObject[] = [];
  const preset = value.selection === 'day' || value.selection === 'cosy' || value.selection == null;
  const claimInput = (input: JsonObject): JsonObject => ({
    kind: 'input',
    input: { ...input, step_range: defaulted(value, 'step_range', { min: -20, max: 20 }), anchor: ['day', 'cosy'].includes(String(input.anchor)) && ['day', 'cosy'].includes(String(value.period)) ? value.period! : defaulted(input, 'anchor', 'current') },
    updated: defaulted(input, 'updated', stamp),
  });
  if (!preset && !isObject(value.legacy_channels)) {
    if (isObject(value.selection_input)) claims.push(claimInput(value.selection_input));
    claims.push({ kind: 'effect', effect: value.selection!, instance: defaulted(value, 'selection_instance', `${key}:${String(value.selection)}`), updated: defaulted(value, 'selection_updated', stamp) });
  }
  if (isObject(value.adjustment) && (preset || !isDeepStrictEqual(value.adjustment, value.selection_input))) claims.push(claimInput(value.adjustment));
  return claims;
}
function effectChannels(catalog: JsonObject, name: JsonValue | undefined): Channel[] {
  const definition = typeof name === 'string' ? object(object(catalog.effects)[name]) : {};
  const channels = definition.channels;
  return Array.isArray(channels) && channels.length > 0 && channels.every(c => c === 'brightness' || c === 'color') ? channels as Channel[] : [];
}
function defaulted(o: JsonObject, key: string, fallback: JsonValue): JsonValue { return o[key] === undefined ? fallback : o[key]; }

/** Pure resolution of independent channel claims, room input and effect ownership. */
export function resolveEffects(args: JsonObject): ResolutionResult {
  const base = object(args.base), overrides = object(args.overrides), catalog = object(args.catalog);
  const privateRooms = Array.isArray(args.private) ? args.private : [];
  const power = object(args.power), gradients = object(args.gradients);
  const warmEnd = (args.warm_end ?? WARM_END) as RGB;
  const targets: Record<string, ResolvedTarget> = {}, assignments: Record<string, ResolvedTarget> = {};
  const inputs = new Map<string, InputPosition>(), streams = new Map<string, string>();
  const entries = sortedEntries(base);
  const order = [...entries.filter(([, item]) => truth(object(item).is_room)), ...entries.filter(([, item]) => !truth(object(item).is_room))];
  for (const [target, rawItem] of order) {
    const item = object(rawItem), area = String(item.area), isRoom = defaulted(item, 'is_room', false);
    if (!streams.has(area)) streams.set(area, latestRemoteKey(overrides, area));
    const ignored = Array.isArray(item.ignore_overrides) ? item.ignore_overrides : [];
    const observed = object(item.observed);
    const candidates: Record<Channel, Candidate[]> = { brightness: [], color: [] };
    const sources = { brightness: {}, color: {} } as Record<Channel, JsonObject>;
    const owners: JsonObject = {}, underlying: JsonObject = {};
    let gradientChecked = false, curve: GradientCurve | undefined;
    const samples = new Map<number, Scaled>();
    for (const [key, record] of sortedEntries(overrides)) {
      if (!isObject(record) || ignored.includes(key)) continue;
      const value = record.value;
      const scope = defaulted(record, 'scope', record.kind === 'light' ? 'lamp' : '');
      let applies = (scope === 'house' && record.target === 'house' && !privateRooms.includes(area)) ||
        (scope === 'room' && record.target === area) || (scope === 'lamp' && !truth(isRoom) && record.target === target);
      if (record.scope === 'room' && (record.kind === 'input' || (record.kind === 'channels' && record.via === 'remote')) && key !== streams.get(area)) applies = false;
      if (!applies) continue;
      const stamp = recordTimestamp(record.when);
      let patch: JsonObject = {};
      if (record.kind === 'input' && isObject(value)) {
        patch = object(value.legacy_channels);
        for (const claim of inputClaims(value, key, stamp)) {
          for (const channel of CHANNELS) {
            if (claim.kind === 'input' || effectChannels(catalog, claim.effect).includes(channel)) candidates[channel].push({ key, updated: claim.updated as number, source: claim, baselineOnly: false });
          }
        }
      } else if (record.kind === 'channels' && isObject(value) && isObject(value.channels)) patch = value.channels;
      else if (record.kind === 'light') {
        if (value == null) {
          patch = { brightness: { kind: 'constant', value: defaulted(observed, 'brightness', item.brightness!) }, color: { kind: 'constant', value: defaulted(observed, 'color', item.color!) } };
        } else if (isObject(value)) {
          const effect = value.effect, declared = effectChannels(catalog, effect);
          if (effect != null && effect !== 'Normal light') {
            for (const channel of declared) patch[channel] = { kind: 'effect', effect, instance: key, ...('brightness' in value ? { intensity: value.brightness! } : {}) };
            if (declared.length === 0) patch = { brightness: { kind: 'constant', value: item.brightness! }, color: { kind: 'constant', value: item.color! } };
            else if ('brightness' in value && !declared.includes('brightness')) patch.brightness = { kind: 'constant', value: value.brightness! };
          } else if (effect === 'Normal light') {
            patch = { brightness: { kind: 'constant', value: defaulted(value, 'brightness', defaulted(observed, 'brightness', item.brightness!)) }, color: { kind: 'constant', value: defaulted(observed, 'color', item.color!) } };
          } else if ('brightness' in value) patch.brightness = { kind: 'constant', value: value.brightness! };
        }
      }
      for (const channel of CHANNELS) {
        if (!(channel in patch)) continue;
        let source = patch[channel];
        if (record.via === 'remote' && isObject(source) && source.kind === 'scale') source = { kind: 'input', input: { steps: 0, lower: -20, upper: 20, legacy_position: source.position! }, updated: defaulted(source, 'updated', stamp) };
        const rawUpdate = isObject(source) ? defaulted(source, 'updated', stamp) : stamp;
        const updated = boundedNumber(rawUpdate) ? rawUpdate : stamp;
        candidates[channel].push({ key, updated, source, baselineOnly: false });
        if (isObject(source) && source.kind === 'effect' && effectChannels(catalog, source.effect).includes(channel) && typeof source.instance === 'string' && source.instance.length > 0) {
          let carried = source.underlying;
          for (let depth = 0; depth < 8; depth++) if (isObject(carried) && carried.kind === 'effect') carried = carried.underlying;
          if (isObject(carried) && (carried.kind === 'constant' || carried.kind === 'scale') && boundedNumber(carried.updated) && carried.updated <= updated) candidates[channel].push({ key, updated: carried.updated, source: carried, baselineOnly: true });
        }
      }
    }
    const baselineEffect = defaulted(item, 'effect', 'Normal light'), declared = effectChannels(catalog, baselineEffect);
    const enabled = item.effect_channels === undefined ? declared : Array.isArray(item.effect_channels) ? item.effect_channels : [];
    for (const channel of CHANNELS) {
      const initial = channel === 'color' ? canonicalColor(item[channel]) : item[channel]!;
      let currentUnderlying: JsonValue = initial;
      let current: JsonObject = { kind: 'constant', value: initial, updated: -1 }, owner = 'base';
      if (declared.includes(channel) && enabled.includes(channel) && (baselineEffect !== 'Candle' || target === 'light.living_room_yellow_retro_lamp')) {
        current = { kind: 'effect', effect: baselineEffect, instance: defaulted(item, 'effect_instance', `base:${target}:${String(baselineEffect)}`), updated: -1 };
        owner = `base:${String(baselineEffect)}`;
      }
      candidates[channel].sort((a, b) => lexical(a.key, b.key)).sort((a, b) => a.updated - b.updated);
      for (const candidate of candidates[channel]) {
        const source = candidate.source;
        if (target !== 'light.living_room_yellow_retro_lamp' && isObject(source) && source.kind === 'effect' && source.effect === 'Candle') continue;
        let valid = false, ignore = false, value = initial;
        let selected: JsonObject = {};
        if (isObject(source)) {
          if (source.kind === 'constant') {
            const v = source.value;
            valid = channel === 'brightness' ? typeof v === 'number' && v >= 0 && v <= 255 : validColor(v);
            if (valid) value = channel === 'color' ? canonicalColor(v) : v!;
          } else if (source.kind === 'scale' || source.kind === 'input') {
            let p = source.position;
            let input: JsonObject = {}, position: InputPosition | undefined;
            if (source.kind === 'input') {
              input = object(source.input);
              let validInput = isObject(source.input) && isObject(item.day) && isObject(item.cosy);
              for (const field of ['steps', 'lower', 'upper']) {
                const v = input[field];
                if (typeof v !== 'number' || !Number.isFinite(v) || v < -40 || v > 40) validInput = false;
              }
              const bounds = input.step_range === undefined ? { min: -20, max: 20 } : object(input.step_range);
              if (validInput && (input.lower as number) >= -20 && (input.lower as number) <= (input.upper as number) && (input.upper as number) <= 20 && typeof bounds.min === 'number' && typeof bounds.max === 'number' && -20 <= bounds.min && bounds.min <= bounds.max && bounds.max <= 20) {
                input = { ...input, lower: clamp(input.lower as number, bounds.min, bounds.max), upper: clamp(input.upper as number, bounds.min, bounds.max) };
                const ref = `${candidate.key}:${candidate.updated}`;
                position = inputs.get(ref);
                if (!position) {
                  const level = channel === 'brightness' ? currentUnderlying as number : defaulted(underlying, 'brightness', item.brightness!) as number;
                  position = { position: normalPosition(input, item, level), level };
                  if (truth(isRoom)) inputs.set(ref, position);
                }
                p = position.position;
                const processor = current.kind === 'effect' ? String(current.effect) : 'Normal light';
                const strategy = defaulted(object(object(catalog.processors)[processor]), 'remote_adjustment', processor === 'Normal light' ? 'gradient' : 'ignore');
                ignore = strategy !== 'gradient';
              } else ignore = true;
            }
            if (!ignore && boundedNumber(p) && isObject(item.day) && isObject(item.cosy)) {
              const day = anchor(item.day), cosy = anchor(item.cosy);
              if (!gradientChecked) {
                const cached = gradients[target];
                if (validGradient(cached, gradientSignature(day, cosy, warmEnd))) curve = cached.curve;
                gradientChecked = true;
              }
              const coordinate = clamp(p, -2, 2);
              let sample = samples.get(coordinate);
              if (!sample) { sample = curve ? sampleGradient(curve, coordinate) : scaleValue(day, cosy, coordinate, warmEnd); samples.set(coordinate, sample); }
              valid = true; value = sample[channel];
              if (source.kind === 'input' && channel === 'brightness' && input.last === 'down' && !truth(input.has_up) && position && position.level < Math.min(76.5, cosy.brightness) && defaulted(input, 'anchor', 'current') === 'current' && (input.steps as number) <= 0) value = Math.min(currentUnderlying as number, value as number);
              selected = { origin: 'scale', position: sample.position };
            }
          } else if (source.kind === 'effect' && effectChannels(catalog, source.effect).includes(channel) && typeof source.instance === 'string' && source.instance.length > 0) {
            valid = true;
            selected = { kind: 'effect', effect: source.effect!, instance: source.instance, updated: candidate.updated };
            if (channel === 'brightness' && typeof source.intensity === 'number' && source.intensity >= 0 && source.intensity <= 255) currentUnderlying = source.intensity;
          }
        }
        if (!ignore) {
          if (candidate.baselineOnly) { if (valid) currentUnderlying = value; }
          else if (valid && selected.kind === 'effect') current = selected;
          else {
            currentUnderlying = valid ? value : initial;
            current = { kind: 'constant', value: currentUnderlying, updated: candidate.updated, ...selected };
            if (!valid) current.origin = 'invalid_source';
          }
          if (!candidate.baselineOnly) owner = candidate.key;
        }
      }
      sources[channel] = current; owners[channel] = owner; underlying[channel] = currentUnderlying;
    }
    for (const channel of CHANNELS) if (sources[channel].kind === 'effect') sources[channel] = { ...sources[channel], base: underlying[channel]!, intensity: underlying.brightness! };
    if (truth(args.sara) && !ignored.includes('mode:sara') && !privateRooms.includes(area) && item.period !== 'night') {
      sources.color = { kind: 'constant', value: { rgb: [255, 105, 180] }, updated: 0, policy: 'sara' };
      owners.color = 'mode:sara';
    }
    const on = defaulted(item, 'on', true);
    const resolved: ResolvedTarget = { ...sources, period: item.period!, on: truth(on) ? defaulted(power, area, true) : on, area, is_room: isRoom, level: underlying.brightness!, owners, transition: defaulted(item, 'transition', 3) };
    targets[target] = resolved;
    if (!truth(isRoom) && (resolved.brightness.kind === 'effect' || resolved.color.kind === 'effect')) assignments[target] = resolved;
  }
  return { targets, assignments };
}

export const resolutionHandlers: ScriptHandlers = {
  effects_resolve: (_context, args) => resolveEffects(args),
  effects_scale: (_context, args) => scaleValue(anchor(args.day), anchor(args.cosy), args.position as number, (args.warm_end ?? WARM_END) as RGB),
  effects_gradient_plan: (_context, args) => planGradients(args),
};
