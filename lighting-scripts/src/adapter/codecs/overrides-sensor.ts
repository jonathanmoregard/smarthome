/**
 * The overrides sensor codec: `sensor.ls_overrides`'s attributes read into
 * the overlays, the mode overlay and the saved switch ranges, and the Model's
 * state written back into them.
 *
 * Reading follows today's readers (`ls_base`, `effects_resolve`,
 * `ls_remote_plan`, `ls_switch_plan`). Everything stored here is set by
 * people at run time, so garbage recovers to a named default and never raises
 * (2026-11-21).
 *
 * Writing must keep the old scripts working in the rooms they still drive
 * (`docs/sensor-fields.md` is the checklist). So it changes only what the
 * Model changed: an entry or attribute whose stored form reads back as what
 * the Model holds keeps its stored bytes; a changed one keeps every stored
 * field the Model does not own (`who`, `via`, `created`, an effect's
 * `instance`, the remote's schedule cache, old fields) and sets the ones it
 * does; a new one is written as today's writer of its kind writes it. Entries
 * of rooms that are not live, entries of no known shape and attributes the
 * Model does not own are copied as found.
 */
import { isDeepStrictEqual } from 'node:util';
import { BLOCKS } from '../../domain/blocks.ts';
import type { Config } from '../../domain/config.ts';
import type { Model, RangeDefaults, RangeRule } from '../../domain/model.ts';
import { DEFAULT_STEP_RANGE } from '../../domain/remote.ts';
import type {
  BlockOverlay, BrightnessOverlay, ColourOverlay, EffectOverlay, HeldBlock, LampOverlay, ModeOverlay, Overlays, PresetChoice, RememberedPreset,
  RemoteAdjustment, RemoteOverlay, RemotePreset, StepRange, SwitchOverlay,
} from '../../domain/overlays.ts';
import type { RemoteId, RoomId, SwitchId } from '../../domain/types/ids.ts';
import type { RemoteSource } from './ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Colour, PercentRange, Power } from '../../domain/types/light.ts';
import { overlayKeyText, SARA_MODE } from './overlay-key.ts';
import type { OverlayKey, RemoteSources } from './overlay-key.ts';
import type { RoomOrHouse } from '../../domain/types/schedule.ts';
import type { Instant } from '../../domain/types/time.ts';
import {
  percentRangeOf, stepBoundsOf, toBrightness, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toPercentRange, toRoomId,
  toStep, toStepCount, toSwitchId,
} from './ids.ts';
import { parseOverlayKey } from './overlay-key.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import { isObject, jinjaTruthy } from './parse.ts';
import { dateSeconds } from './time-text.ts';

/** What the overrides sensor holds of the Model. */
export type OverridesState = Pick<Model, 'overlays' | 'modeOverlay' | 'switchRanges' | 'rangeDefaults'>;

/** A `when` that is not a date, today's `as_timestamp(when, 0)`: the next overlay reset ends the overlay. */
export const EPOCH: Instant = toInstant(0);


/** The range defaults when none are saved, or a saved one is out of order: today's built-in `{bright: [90, 100], cosy: [30, 60]}`. */
export const BUILT_IN_RANGE_DEFAULTS: RangeDefaults = { bright: toPercentRange(90, 100), cosy: toPercentRange(30, 60) };

/** An adjustment's anchor when the saved one is none of the three: today's reader treats any other as `current`. */
const DEFAULT_ANCHOR: RemoteAdjustment['from'] = 'current';

/** The effect names a stored effect claim carries. A schedule part has no stored name today; this one reads back as it. */
const EFFECT_NAMES: Record<EffectOverlay['kind'], string> = { candle: 'Candle', normal: 'Normal light', schedule: 'schedule' };

/** How far a stored effect claim's `underlying` is followed through other effects: today's resolver's eight links. */
const UNDERLYING_DEPTH = 8;

/** The fields a remote value keeps its current preset in; a changed preset clears them before writing its own. */
const PRESET_FIELDS = ['selection', 'period', 'period_updated', 'selection_updated', 'selection_input', 'selection_instance', 'legacy_channels'];

/** The preset choices a remote remembers a context for, each under its selection's name. */
const PRESET_CHOICES: readonly PresetChoice[] = ['day', 'cosy', 'candle'];

/**
 * The overlays, the mode overlay and the saved ranges the sensor holds. A
 * remote's overlay saved under a source no remote of the catalog has takes no
 * part, and stays in the sensor as found.
 */
export function decodeOverrides(attributes: JsonObject | undefined, sources: RemoteSources): OverridesState {
  const stored = attributes === undefined ? {} : attributes;
  const entries = decodeEntries(stored['overrides'], sources);
  const mode = entries.find(entry => entry.kind === 'mode');
  return {
    overlays: {
      blocks: Object.fromEntries(entries.flatMap(entry => entry.kind === 'block' ? [[entry.scope, entry.overlay]] : [])),
      remotes: entries.flatMap(entry => entry.kind === 'remote' ? [entry.overlay] : []),
      lamps: entries.flatMap(entry => entry.kind === 'lamp' ? [entry.overlay] : []),
      roomPower: Object.fromEntries(decodeKeyed(stored['power'], toRoomId, decodePower)),
      switches: Object.fromEntries(decodeKeyed(stored['switch_overlays'], toSwitchId, decodeSwitchOverlay)),
    },
    modeOverlay: mode === undefined ? { active: false } : mode.overlay,
    switchRanges: Object.fromEntries(decodeKeyed(stored['switch_ranges'], toSwitchId, decodeRangeRule)),
    rangeDefaults: decodeRangeDefaults(stored['range_defaults']),
  };
}

/**
 * The sensor's attributes with this state written in. Stored overlays of rooms
 * outside `live`, those of no known shape and every attribute the Model does
 * not own come from `found` unchanged; the config says which room each lamp
 * and switch is in. A house-wide overlay (a block over the house, the mode
 * overlay, a lamp in no room) is the Model's to write.
 */
export function encodeOverrides(state: OverridesState, found: JsonObject, live: ReadonlySet<RoomId>, config: Config,
  sources: RemoteSources): JsonObject {
  const liveRoom = (room: RoomId | undefined) => room === undefined || live.has(room);
  const switchLive = (entity: SwitchId) => config.switches[entity] !== undefined && liveRoom(config.switches[entity].room);
  const owned = (entry: StoredOverlay) => entryIsLive(entry, liveRoom, config);
  const written: JsonObject = { ...found };
  const set = (attribute: string, value: JsonValue | undefined) => { if (value !== undefined) written[attribute] = value; };
  set('overrides', encodeEntries(state, found['overrides'], owned, sources));
  set('power', encodeKeyed(state.overlays.roomPower, found['power'], toRoomId, decodePower, power => power === 'on', liveRoom));
  set('switch_ranges', encodeKeyed(state.switchRanges, found['switch_ranges'], toSwitchId, decodeRangeRule, storedRangeRule, switchLive));
  set('range_defaults', isDeepStrictEqual(decodeRangeDefaults(found['range_defaults']), state.rangeDefaults) ? undefined
    : { ...isObject(found['range_defaults']) ? found['range_defaults'] : {}, ...storedRangeDefaults(state.rangeDefaults) });
  set('switch_overlays', encodeKeyed(state.overlays.switches, found['switch_overlays'], toSwitchId, decodeSwitchOverlay,
    overlay => ({ power: overlay.power, when: isoText(overlay.since) }), switchLive));
  return written;
}

/** A mapping attribute read entry by entry; a non-mapping has none, an entry its decoder refuses is dropped. */
function decodeKeyed<K extends string, V>(raw: JsonValue | undefined, key: (text: string) => K,
  decode: (entry: JsonValue) => V | undefined): [K, V][] {
  return isObject(raw) ? Object.entries(raw).flatMap(([text, entry]) => {
    const value = decode(entry);
    return value === undefined ? [] : [[key(text), value]];
  }) : [];
}

/** A room's saved power: a boolean; anything else leaves the room on. */
function decodePower(raw: JsonValue): Power | undefined {
  return typeof raw === 'boolean' ? (raw ? 'on' : 'off') : undefined;
}

/** A switch held by its own button: `{power, when}`, written by this port only; a bad power or when drops it. */
function decodeSwitchOverlay(raw: JsonValue): SwitchOverlay | undefined {
  if (!isObject(raw)) return undefined;
  const power = raw['power'], when = raw['when'];
  const stamp = typeof when === 'string' ? dateSeconds(when) : undefined;
  return (power === 'on' || power === 'off') && stamp !== undefined ? { power, since: toInstant(stamp) } : undefined;
}

/**
 * A switch's saved range rule: `bright` or `cosy`, or `custom` with bounds that
 * pass today's check (`is number`, which admits booleans as 0 and 1, then an
 * ordered pair inside 0..100). Any other rule gives the switch none.
 */
function decodeRangeRule(raw: JsonValue): RangeRule | undefined {
  if (!isObject(raw)) return undefined;
  const profile = raw['profile'];
  if (profile === 'bright' || profile === 'cosy') return { kind: profile };
  if (profile !== 'custom') return undefined;
  const range = percentRangeOf(jinjaNumber(raw['min']), jinjaNumber(raw['max']));
  return range === undefined ? undefined : { kind: 'custom', range };
}

/** Today's `is number`, which admits booleans as 0 and 1; anything else is not a number. */
function jinjaNumber(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The house's range defaults (today's `range_defaults or built-in`); each one out of order is its built-in. */
function decodeRangeDefaults(raw: JsonValue | undefined): RangeDefaults {
  const saved = raw !== undefined && jinjaTruthy(raw) && isObject(raw) ? raw : {};
  const pair = (profile: 'bright' | 'cosy'): PercentRange => {
    const value = saved[profile];
    const range = Array.isArray(value) && value.length === 2 ? percentRangeOf(jinjaNumber(value[0]), jinjaNumber(value[1])) : undefined;
    return range === undefined ? BUILT_IN_RANGE_DEFAULTS[profile] : range;
  };
  return { bright: pair('bright'), cosy: pair('cosy') };
}

/**
 * The `overrides` attribute with the Model's overlays written in, or none when
 * nothing changed (the stored value stays, garbage included).
 */
function encodeEntries(state: OverridesState, found: JsonValue | undefined, owned: (entry: StoredOverlay) => boolean,
  sources: RemoteSources): JsonObject | undefined {
  const wanted = wantedEntries(state, sources);
  const stored = isObject(found) ? found : {};
  const written: JsonObject = {};
  let changed = false;
  for (const [key, raw] of Object.entries(stored)) {
    const before = decodeEntry(key, raw, sources), after = wanted.get(key);
    wanted.delete(key);
    const ours = (before === undefined || owned(before)) && (after === undefined || owned(after));
    if (!ours || after === undefined && before === undefined) written[key] = raw;
    else if (after === undefined) changed = true;
    else if (before !== undefined && isDeepStrictEqual(before, after)) written[key] = raw;
    else {
      written[key] = encodeEntry(after, before?.kind === after.kind ? before : undefined, raw);
      changed = true;
    }
  }
  for (const [key, entry] of wanted) {
    if (!owned(entry)) continue;
    written[key] = encodeEntry(entry, undefined, undefined);
    changed = true;
  }
  return changed ? written : undefined;
}

/**
 * The Model's overlays by the key each is stored under. Two overlays under one
 * key cannot be stored; a remote the catalog gives no source has no key.
 */
function wantedEntries(state: OverridesState, sources: RemoteSources): Map<string, StoredOverlay> {
  const overlays: Overlays = state.overlays;
  const entries: StoredOverlay[] = [];
  for (const [scope, overlay] of Object.entries(overlays.blocks)) {
    if (overlay !== undefined) entries.push({ kind: 'block', scope: scope === 'house' ? 'house' : toRoomId(scope), overlay });
  }
  for (const overlay of overlays.remotes) {
    const source = sources.sourceOf.get(overlay.remote);
    if (source !== undefined) entries.push({ kind: 'remote', overlay, source });
  }
  for (const overlay of overlays.lamps) entries.push({ kind: 'lamp', overlay });
  if (state.modeOverlay.active) entries.push({ kind: 'mode', overlay: state.modeOverlay });
  const wanted = new Map<string, StoredOverlay>();
  for (const entry of entries) {
    const key = overlayKeyText(entryKey(entry));
    if (wanted.has(key)) throw new Error(`Two overlays are stored under one key, ${key}; each key holds one overlay`);
    wanted.set(key, entry);
  }
  return wanted;
}

/**
 * A mapping attribute with the Model's entries written in, or none when
 * nothing changed. An entry whose key is not live stays as found, and so does
 * one that reads back as what the Model holds, garbage included.
 */
function encodeKeyed<K extends string, V>(wanted: Partial<Record<K, V>>, found: JsonValue | undefined, key: (text: string) => K,
  decode: (entry: JsonValue) => V | undefined, encode: (value: V) => JsonValue, live: (key: K) => boolean): JsonObject | undefined {
  const stored = isObject(found) ? found : {};
  const written: JsonObject = {};
  let changed = false;
  for (const [text, raw] of Object.entries(stored)) {
    const id = key(text), after = wanted[id];
    if (!live(id) || isDeepStrictEqual(decode(raw), after)) written[text] = raw;
    else if (after === undefined) changed = true;
    else { written[text] = encode(after); changed = true; }
  }
  for (const [text, value] of Object.entries<V | undefined>(wanted)) {
    if (Object.hasOwn(stored, text) || value === undefined || !live(key(text))) continue;
    written[text] = encode(value);
    changed = true;
  }
  return changed ? written : undefined;
}

/** A range rule as `ls_range_save` saves it. */
function storedRangeRule(rule: RangeRule): JsonObject {
  return rule.kind === 'custom' ? { profile: 'custom', min: rule.range.low, max: rule.range.high } : { profile: rule.kind };
}

function storedRangeDefaults(defaults: RangeDefaults): JsonObject {
  return { bright: [defaults.bright.low, defaults.bright.high], cosy: [defaults.cosy.low, defaults.cosy.high] };
}

/** How a channel's stored values read as its part. */
type ClaimReader<P> = {
  /** A stored value as the fixed part; a value the channel cannot hold hands it back to the schedule. */
  fixed(value: JsonValue | undefined, at: Instant): P;
  /** The level an effect runs at (`intensity`), on the brightness channel only. */
  intensity(claim: JsonObject, at: Instant): P | undefined;
};

/** The constant an effect keeps underneath, followed through other effects; it keeps its own `updated`. */
function underlyingPart<P>(underlying: JsonValue | undefined, reader: ClaimReader<P>): P | undefined {
  let carried = underlying;
  for (let depth = 0; depth < UNDERLYING_DEPTH && isObject(carried) && carried['kind'] === 'effect'; depth++) carried = carried['underlying'];
  if (!isObject(carried) || carried['kind'] !== 'constant' || !boundedNumber(carried['updated'])) return undefined;
  return reader.fixed(carried['value'], toInstant(carried['updated']));
}

/** The brightness channel: a level 0..255 (rounded), or an effect's `intensity`. */
const BRIGHTNESS: ClaimReader<BrightnessOverlay> = {
  fixed: (value, at) => typeof value === 'number' && value >= 0 && value <= 255
    ? { kind: 'fixed', brightness: toBrightness(Math.round(value)), at } : { kind: 'schedule', at },
  intensity: (claim, at) => {
    const intensity = claim['intensity'];
    return typeof intensity === 'number' && intensity >= 0 && intensity <= 255
      ? { kind: 'fixed', brightness: toBrightness(Math.round(intensity)), at } : undefined;
  },
};

/** The colour channel: a stored colour; an effect keeps no colour of its own. */
const COLOUR: ClaimReader<ColourOverlay> = {
  fixed: (value, at) => {
    const colour = storedColour(value);
    return colour === undefined ? { kind: 'schedule', at } : { kind: 'fixed', colour, at };
  },
  intensity: () => undefined,
};

/** A stored overlay entry of a known shape, read into the overlay it is. */
type StoredOverlay =
  | { kind: 'block'; scope: RoomOrHouse; overlay: BlockOverlay }
  | { kind: 'mode'; overlay: Extract<ModeOverlay, { active: true }> }
  /** `source`: what the overlay's key names. */
  | { kind: 'remote'; overlay: RemoteOverlay; source: RemoteSource }
  | { kind: 'lamp'; overlay: LampOverlay };

/** The stored entries of a known shape, in stored order; an `overrides` that is not a mapping holds none. */
function decodeEntries(overrides: JsonValue | undefined, sources: RemoteSources): StoredOverlay[] {
  return isObject(overrides) ? Object.entries(overrides).flatMap(([key, raw]) => {
    const entry = decodeEntry(key, raw, sources);
    return entry === undefined ? [] : [entry];
  }) : [];
}

/**
 * One stored entry, by its key and kind; none when it is of no known shape
 * (old shapes, unknown kinds and keys, garbage) or a remote's whose source no
 * remote of the catalog has.
 */
function decodeEntry(key: string, raw: JsonValue, sources: RemoteSources): StoredOverlay | undefined {
  const parsed = parseOverlayKey(key);
  if (parsed.kind === 'sara mode') return { kind: 'mode', overlay: { active: true, since: isObject(raw) ? savedWhen(raw['when']) : EPOCH } };
  if (!isObject(raw)) return undefined;
  switch (parsed.kind) {
    case 'block': return decodeBlock(parsed.scope, raw);
    case 'remote input': {
      const remote = sources.remoteOf.get(parsed.source);
      return remote === undefined ? undefined : decodeRemote(remote, parsed.source, raw);
    }
    case 'native control': return decodeLamp(nativeOver(parsed.base), { kind: 'person' }, raw);
    case 'dashboard control': return decodeLamp(undefined, { kind: 'dashboard', control: toDashboardControlId(parsed.control) }, raw);
    case 'empty': case 'saved': return undefined;
  }
}

/** `block:<room or house>` holding a block, in any case (`value | string | lower`). */
function decodeBlock(scope: string, raw: JsonObject): StoredOverlay | undefined {
  const value = raw['value'];
  const block = typeof value === 'string' ? BLOCKS.find(known => known === value.toLowerCase()) : undefined;
  if (block === undefined || scope === '') return undefined;
  return { kind: 'block', scope: scope === 'house' ? 'house' : toRoomId(scope), overlay: { block, since: savedWhen(raw['when']) } };
}

/** A remote's input for its room: kind `input`, scope `room`, its room as `target`. */
function decodeRemote(remote: RemoteId, source: RemoteSource, raw: JsonObject): StoredOverlay | undefined {
  const value = raw['value'], target = raw['target'];
  if (raw['kind'] !== 'input' || raw['scope'] !== 'room' || typeof target !== 'string' || target === '' || !isObject(value)) return undefined;
  const since = savedWhen(raw['when']);
  const range = value['step_range'], stored = value['adjustment'], chosen = value['selection'];
  // An effect chosen over an old channels record (`legacy_channels`) claims nothing in today's resolver: not the
  // effect, not its input, and not an adjustment equal to that input.
  const overOldRecord = isObject(value['legacy_channels']) && chosen !== undefined && chosen !== null && chosen !== 'day' && chosen !== 'cosy';
  return {
    kind: 'remote',
    source,
    overlay: {
      remote,
      room: toRoomId(target),
      since,
      stepRange: !Object.hasOwn(value, 'step_range') || !isObject(range) ? DEFAULT_STEP_RANGE
        : stepBoundsOf(range['min'], range['max']) ?? DEFAULT_STEP_RANGE,
      adjustment: !isObject(stored) || overOldRecord && isDeepStrictEqual(stored, value['selection_input']) ? undefined
        : decodeAdjustment(stored, since, value['period']),
      preset: decodePreset(value['selection'], value, since),
      remembered: decodeRemembered(value['preset_contexts'], since),
    },
  };
}

/**
 * A person's or a dashboard control's light on a lamp or a room: kind
 * `channels`, scope `lamp` or `room` with its target, each channel a part.
 * A native key must name the scope and target its entry holds.
 */
function decodeLamp(keyed: LampOverlay['over'] | undefined, from: LampOverlay['from'], raw: JsonObject): StoredOverlay | undefined {
  const value = raw['value'], target = raw['target'], scope = raw['scope'];
  if (raw['kind'] !== 'channels' || !isObject(value) || !isObject(value['channels']) || typeof target !== 'string' || target === '') return undefined;
  const over: LampOverlay['over'] | undefined = scope === 'lamp' ? { kind: 'lamp', lamp: toLampId(target) }
    : scope === 'room' ? { kind: 'room', room: toRoomId(target) } : undefined;
  if (over === undefined || keyed !== undefined && !isDeepStrictEqual(keyed, over)) return undefined;
  const since = savedWhen(raw['when']);
  const channels = value['channels'];
  // A person's or a control's off claims no channel. A stored `power` that is anything else is garbage, and so is
  // an off whose record claims channels again (today's ls_commit merges a light over it, keeping `power`): either
  // record reads as its channels.
  if (value['power'] === 'off' && Object.keys(channels).length === 0) return { kind: 'lamp', overlay: { kind: 'off', over, from, since } };
  const brightness = channelPart('brightness', channels, since, BRIGHTNESS), colour = channelPart('color', channels, since, COLOUR);
  let effect = newest(brightness.effect, colour.effect);
  // A reset to normal light saves the held level and colour and names the pick; it ends a candle.
  if (value['selection'] === 'Normal light' && effect === undefined
    && brightness.part !== undefined && colour.part !== undefined) {
    effect = { kind: 'normal', at: brightness.part.at < colour.part.at ? brightness.part.at : colour.part.at };
  }
  return {
    kind: 'lamp',
    overlay: {
      kind: 'parts', over, from, since,
      brightness: brightness.part,
      colour: colour.part,
      effect,
    },
  };
}

/** Whether the Model writes this entry: its room is live, or it covers the house; a lamp the config does not know is not the Model's. */
function entryIsLive(entry: StoredOverlay, liveRoom: (room: RoomId | undefined) => boolean, config: Config): boolean {
  switch (entry.kind) {
    case 'mode': return true;
    case 'block': return entry.scope === 'house' || liveRoom(entry.scope);
    case 'remote': return liveRoom(entry.overlay.room);
    case 'lamp': {
      const over = entry.overlay.over;
      if (over.kind === 'room') return liveRoom(over.room);
      const lamp = config.lamps[over.lamp];
      return lamp !== undefined && liveRoom(lamp.room);
    }
  }
}

/**
 * One entry written: over the stored entry when there was one of the same
 * kind, setting only the fields that changed; otherwise as today's writer of
 * its kind writes it, through `ls_commit` (`when`, `created`, `who` none, its `via`).
 */
function encodeEntry(entry: StoredOverlay, before: StoredOverlay | undefined, raw: JsonValue | undefined): JsonObject {
  const found = isObject(raw) ? raw : undefined;
  const since = entry.overlay.since;
  const when = before === undefined || before.overlay.since !== since ? { when: isoText(since) } : {};
  const fresh = (record: JsonObject, via: string): JsonObject => ({ ...record, when: isoText(since), created: isoText(since), who: null, via });
  switch (entry.kind) {
    case 'mode': return found === undefined ? fresh({ kind: 'mode', target: 'sara', value: 'on' }, 'app') : { ...found, kind: 'mode', ...when };
    case 'block': {
      const record = { kind: 'block', target: entry.scope, value: entry.overlay.block };
      const value = before?.kind === 'block' && before.overlay.block === entry.overlay.block ? {} : { value: entry.overlay.block };
      return found === undefined ? fresh(record, 'app') : { ...found, kind: 'block', target: entry.scope, ...value, ...when };
    }
    case 'remote': {
      const overlay = entry.overlay;
      const foundValue = found !== undefined && isObject(found['value']) ? found['value'] : {};
      const value = remoteValue(overlay, entry.source, before?.kind === 'remote' ? before.overlay : undefined, foundValue);
      const key = overlayKeyText(entryKey(entry));
      return found === undefined
        ? fresh({ kind: 'input', key, source: entry.source, scope: 'room', target: overlay.room, value }, 'remote')
        : { ...found, kind: 'input', scope: 'room', target: overlay.room, value, ...when };
    }
    case 'lamp': {
      const overlay = entry.overlay;
      const foundValue = found !== undefined && isObject(found['value']) ? found['value'] : {};
      const value = lampValue(overlay, foundValue, found === undefined ? undefined : savedWhen(found['when']));
      const over = overlay.over, key = overlayKeyText(entryKey(entry));
      const target = over.kind === 'room' ? over.room : over.lamp;
      const source = overlay.from.kind === 'dashboard' ? `ui:${overlay.from.control}` : `native:${nativeBase(over)}`;
      return found === undefined
        ? fresh({ kind: 'channels', key, source, scope: over.kind, target, value }, overlay.from.kind === 'dashboard' ? 'effects-house' : 'app')
        : { ...found, kind: 'channels', scope: over.kind, target, value, ...when };
    }
  }
}

/** The key an overlay is stored under. */
function entryKey(entry: StoredOverlay): OverlayKey {
  switch (entry.kind) {
    case 'mode': return SARA_MODE;
    case 'block': return { kind: 'block', scope: entry.scope };
    case 'remote': return { kind: 'remote input', source: entry.source };
    case 'lamp': {
      const { over, from } = entry.overlay;
      return from.kind === 'dashboard' ? { kind: 'dashboard control', control: from.control } : { kind: 'native control', base: nativeBase(over) };
    }
  }
}

/** Today's `as_timestamp(when, 0)`: date text is its instant; anything else, numbers included, is the epoch. */
function savedWhen(value: JsonValue | undefined): Instant {
  const seconds = typeof value === 'string' ? dateSeconds(value) : undefined;
  return seconds === undefined ? EPOCH : toInstant(seconds);
}

/** A native control's key names a lamp, or `room:<room>`. */
function nativeOver(base: string): LampOverlay['over'] {
  return base.startsWith('room:') ? { kind: 'room', room: toRoomId(base.slice('room:'.length)) } : { kind: 'lamp', lamp: toLampId(base) };
}

/**
 * A remote's brighter and dimmer presses: steps -40..40 and both bounds an
 * ordered pair inside -20..20, as the resolver accepts them; none otherwise.
 * An `updated` the adjustment does not hold is the entry's `when`, as today.
 */
function decodeAdjustment(stored: JsonObject, when: Instant, period: JsonValue | undefined): RemoteAdjustment | undefined {
  const count = (key: string) => {
    const value = stored[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= -40 && value <= 40 ? value : undefined;
  };
  const steps = count('steps'), lower = count('lower'), upper = count('upper');
  if (steps === undefined || lower === undefined || upper === undefined || lower < -20 || upper > 20 || lower > upper) return undefined;
  const anchor = stored['anchor'], last = stored['last'];
  return {
    steps: toStepCount(steps),
    lower: toStep(lower),
    upper: toStep(upper),
    from: anchor === 'day' || anchor === 'cosy' ? (period === 'day' || period === 'cosy' ? period : anchor)
      : anchor === 'current' ? anchor : DEFAULT_ANCHOR,
    at: savedStamp(stored['updated'], when),
    lastPress: last === 'up' || last === 'down' ? last : undefined,
    everBrighter: jinjaTruthy(stored['has_up']),
  };
}

/** A stored stamp in seconds: absent is the entry's `when`, as today's readers default it; one that is not a number is the epoch. */
function savedStamp(value: JsonValue | undefined, when: Instant): Instant {
  if (value === undefined) return when;
  return typeof value === 'number' && Number.isFinite(value) ? toInstant(value) : EPOCH;
}

/**
 * What the arrows chose: `day` or `cosy` hold that block since `period_updated`;
 * `Candle` is the candle since `selection_updated`, with the input it started
 * from and the day or cosy block it keeps holding; anything else (none, a
 * removed effect, garbage) is no preset.
 */
function decodePreset(selection: JsonValue | undefined, stored: JsonObject, when: Instant): RemotePreset {
  if (selection === 'day' || selection === 'cosy') return { choice: selection, since: savedStamp(stored['period_updated'], when) };
  if (selection !== 'Candle' || isObject(stored['legacy_channels'])) return { choice: 'none' };
  const period = stored['period'], input = stored['selection_input'];
  return {
    choice: 'candle',
    since: savedStamp(stored['selection_updated'], when),
    adjustment: isObject(input) ? decodeAdjustment(input, when, period) : undefined,
    block: period === 'day' || period === 'cosy' ? { block: period, since: savedStamp(stored['period_updated'], when) } : undefined,
  };
}

/** The presets the remote left, by the name it saved each under; a removed effect's context is not in the Model. */
function decodeRemembered(contexts: JsonValue | undefined, when: Instant): RemoteOverlay['remembered'] {
  if (!isObject(contexts)) return {};
  const remembered: RemoteOverlay['remembered'] = {};
  for (const choice of PRESET_CHOICES) {
    const context = contexts[contextName(choice)];
    const preset = isObject(context) ? decodePreset(contextName(choice), context, when) : undefined;
    if (preset !== undefined && preset.choice !== 'none') remembered[choice] = preset;
  }
  return remembered;
}

/** The name a preset's context is saved under: the selection's own text. */
function contextName(choice: PresetChoice): string {
  return choice === 'candle' ? 'Candle' : choice;
}

/** A channel the entry claims; one it does not claim sets nothing. */
function channelPart<P>(channel: Channel, channels: JsonObject, when: Instant, reader: ClaimReader<P>): ChannelPart<P> {
  return Object.hasOwn(channels, channel) ? decodeClaim(channels[channel]!, when, reader) : { part: undefined, effect: undefined };
}

/**
 * One stored channel claim, as the resolver reads it. A constant with a value
 * is that fixed part, one without a usable value hands the channel back to the
 * schedule. An effect runs (`Candle` the candle, `Normal light` the normal
 * light, any other name the schedule's effect) and holds underneath it the
 * part its `intensity`, else its `underlying`, keeps. A `scale` or `input`
 * claim is an old shape and takes no part; anything else is invalid, which the
 * resolver reads as the schedule. A claim's `updated` that is not a number is
 * the entry's `when`, as the resolver reads it.
 */
function decodeClaim<P>(claim: JsonValue, when: Instant, reader: ClaimReader<P>): ChannelPart<P> {
  if (!isObject(claim)) return { part: reader.fixed(undefined, when), effect: undefined };
  const at = boundedNumber(claim['updated']) ? toInstant(claim['updated']) : when;
  const kind = claim['kind'];
  if (kind === 'scale' || kind === 'input') return { part: undefined, effect: undefined };
  if (kind === 'constant') return { part: reader.fixed(claim['value'], at), effect: undefined };
  const effect = claim['effect'], instance = claim['instance'];
  if (kind !== 'effect' || typeof effect !== 'string' || typeof instance !== 'string' || instance === '') {
    return { part: reader.fixed(undefined, at), effect: undefined };
  }
  const intensity = reader.intensity(claim, at);
  const part = intensity === undefined ? underlyingPart(claim['underlying'], reader) : intensity;
  return { part, effect: { kind: effect === 'Candle' ? 'candle' : effect === 'Normal light' ? 'normal' : 'schedule', at } };
}

function newest(a: EffectOverlay | undefined, b: EffectOverlay | undefined): EffectOverlay | undefined {
  if (a === undefined) return b;
  return b === undefined || a.at >= b.at ? a : b;
}

/** A remote overlay's stored value: the found value with each part the Model changed written in. */
function remoteValue(overlay: RemoteOverlay, source: RemoteSource, before: RemoteOverlay | undefined, found: JsonObject): JsonObject {
  const value: JsonObject = { ...found };
  if (before === undefined || !isDeepStrictEqual(before.stepRange, overlay.stepRange)) {
    value['step_range'] = { min: overlay.stepRange.min, max: overlay.stepRange.max };
  }
  if (before === undefined || !isDeepStrictEqual(before.adjustment, overlay.adjustment)) {
    if (overlay.adjustment === undefined) delete value['adjustment'];
    else value['adjustment'] = storedAdjustment(overlay.adjustment, isObject(found['adjustment']) ? found['adjustment'] : {});
  }
  if (before === undefined || !isDeepStrictEqual(before.preset, overlay.preset)) {
    for (const field of PRESET_FIELDS) delete value[field];
    const preset = overlay.preset;
    if (preset.choice !== 'none') Object.assign(value, { selection: contextName(preset.choice), ...presetFields(preset, source, found) });
  }
  if (before === undefined ? Object.keys(overlay.remembered).length > 0 : !isDeepStrictEqual(before.remembered, overlay.remembered)) {
    value['preset_contexts'] = storedContexts(overlay, source, before === undefined ? {} : before.remembered,
      isObject(found['preset_contexts']) ? found['preset_contexts'] : {});
  }
  return value;
}

/** An adjustment as the remote plan writes it, over the stored one's other fields. */
function storedAdjustment(adjustment: RemoteAdjustment, found: JsonObject): JsonObject {
  const kept: JsonObject = { ...found };
  delete kept['last'];
  return {
    ...kept,
    steps: adjustment.steps, lower: adjustment.lower, upper: adjustment.upper, anchor: adjustment.from, updated: adjustment.at,
    ...adjustment.lastPress === undefined ? {} : { last: adjustment.lastPress },
    has_up: adjustment.everBrighter,
  };
}

/**
 * A preset's stored fields besides its `selection`, as the remote plan saves
 * them, and as a context in `preset_contexts` holds them; a candle keeps the
 * stored `selection_instance`.
 */
function presetFields(preset: RememberedPreset, source: RemoteSource, found: JsonObject): JsonObject {
  switch (preset.choice) {
    case 'day': case 'cosy':
      return { period: preset.choice, period_updated: preset.since, selection_updated: preset.since };
    case 'candle': {
      const instance = found['selection_instance'];
      return {
        ...heldBlockFields(preset.block),
        selection_updated: preset.since,
        ...preset.adjustment === undefined ? {}
          : { selection_input: storedAdjustment(preset.adjustment, isObject(found['selection_input']) ? found['selection_input'] : {}) },
        selection_instance: typeof instance === 'string' && instance !== '' ? instance : `${source}:Candle`,
      };
    }
  }
}

function heldBlockFields(block: HeldBlock | undefined): JsonObject {
  return block === undefined ? {} : { period: block.block, period_updated: block.since };
}

/** The presets the remote left, each saved under its name, where it changed; a stored context the Model does not read stays. */
function storedContexts(overlay: RemoteOverlay, source: RemoteSource, before: RemoteOverlay['remembered'], found: JsonObject): JsonObject {
  const contexts: JsonObject = { ...found };
  for (const choice of PRESET_CHOICES) {
    const name = contextName(choice), remembered = overlay.remembered[choice], stored = contexts[name];
    if (isDeepStrictEqual(before[choice], remembered)) continue;
    if (remembered === undefined) delete contexts[name];
    else contexts[name] = presetFields(remembered, source, isObject(stored) ? stored : {});
  }
  return contexts;
}

/**
 * A lamp overlay's stored value: its two channel claims, each written only
 * when what it says changed.
 *
 * The normal light is written as today's reset writes it: both channels held
 * as constants, a part older than the reset held from the reset's time and a
 * channel with no part claimed with no value (the schedule's), and the pick's
 * name, which reads it back as the normal light. Today's resolver reads a
 * `Normal light` effect claim as no source, so it is never written.
 *
 * Another effect runs on a channel when it is newer than (or as new as) the
 * channel's own part, which it keeps underneath, as `ls_commit` keeps an older
 * constant under a newer effect; otherwise the channel holds its part. An
 * effect older than both parts runs on the brightness channel from that part's
 * time at its level (`intensity`), as today's resolver drops a constant kept
 * under an effect that is newer than the effect.
 */
function lampValue(overlay: LampOverlay, found: JsonObject, foundWhen: Instant | undefined): JsonObject {
  if (overlay.kind === 'off') {
    const value: JsonObject = { ...found, channels: {}, power: 'off' };
    delete value['selection'];
    return value;
  }
  const foundChannels = isObject(found['channels']) ? found['channels'] : {};
  const effect = overlay.effect;
  const wanted = effect?.kind === 'normal' ? heldChannels(overlay, effect.at) : effectChannels(overlay, effect);
  const channels: JsonObject = { ...foundChannels };
  for (const channel of ['brightness', 'color'] as const) {
    const before: ChannelPart<BrightnessOverlay | ColourOverlay> = foundWhen === undefined ? { part: undefined, effect: undefined }
      : channel === 'brightness' ? channelPart(channel, foundChannels, foundWhen, BRIGHTNESS)
        : channelPart(channel, foundChannels, foundWhen, COLOUR);
    if (isDeepStrictEqual(before, wanted[channel])) continue;
    const claim = storedClaim(channel, wanted[channel], foundChannels[channel], overlay);
    if (claim === undefined) delete channels[channel]; else channels[channel] = claim;
  }
  const value: JsonObject = { ...found, channels };
  delete value['power'];
  if (effect?.kind === 'normal') value['selection'] = 'Normal light';
  else if (overlay.from.kind === 'dashboard' && effect?.kind === 'candle') value['selection'] = 'Candle';
  else if (found['selection'] === 'Normal light') delete value['selection'];
  return value;
}

/** The two channels a reset to normal light at `at` holds: each part from the reset's time on, the schedule's where there is none. */
function heldChannels(overlay: PartsOverlay, at: Instant): Record<Channel, ChannelPart<BrightnessOverlay | ColourOverlay>> {
  const brightness: BrightnessOverlay = overlay.brightness === undefined ? { kind: 'schedule', at }
    : overlay.brightness.at < at ? { ...overlay.brightness, at } : overlay.brightness;
  const colour: ColourOverlay = overlay.colour === undefined ? { kind: 'schedule', at }
    : overlay.colour.at < at ? { ...overlay.colour, at } : overlay.colour;
  return { brightness: { part: brightness, effect: undefined }, color: { part: colour, effect: undefined } };
}

/** Which channel runs the overlay's effect (none, the candle or the schedule's): see `lampValue`. */
function effectChannels(overlay: PartsOverlay, effect: EffectOverlay | undefined): Record<Channel, ChannelPart<BrightnessOverlay | ColourOverlay>> {
  const brightness = overlay.brightness, colour = overlay.colour;
  const runs = (part: BrightnessOverlay | ColourOverlay | undefined) => effect !== undefined && (part === undefined || effect.at >= part.at);
  if (effect !== undefined && brightness !== undefined && !runs(brightness) && !runs(colour)) {
    return { brightness: { part: brightness, effect: { ...effect, at: brightness.at } }, color: { part: colour, effect: undefined } };
  }
  return {
    brightness: { part: brightness, effect: runs(brightness) ? effect : undefined },
    color: { part: colour, effect: runs(colour) ? effect : undefined },
  };
}

/** One channel claim, as the controls write it: an effect with what it keeps underneath, or a constant. */
function storedClaim(channel: Channel, wanted: ChannelPart<BrightnessOverlay | ColourOverlay>, found: JsonValue | undefined,
  overlay: LampOverlay): JsonObject | undefined {
  const { part, effect } = wanted;
  if (effect === undefined) return part === undefined ? undefined : constantClaim(part);
  const name = EFFECT_NAMES[effect.kind];
  const foundInstance = isObject(found) && found['kind'] === 'effect' && found['effect'] === name ? found['instance'] : undefined;
  const owner = overlay.from.kind === 'dashboard' ? `ui:${overlay.from.control}` : `native:${nativeBase(overlay.over)}`;
  const under = part === undefined ? {}
    : channel === 'brightness' && part.kind === 'fixed' && 'brightness' in part && part.at === effect.at ? { intensity: part.brightness }
      : { underlying: constantClaim(part) };
  return {
    kind: 'effect', effect: name,
    instance: typeof foundInstance === 'string' && foundInstance !== '' ? foundInstance : `${owner}:${name}`,
    updated: effect.at, ...under,
  };
}

/** A part as a constant claim: its value, or none for the schedule's. */
function constantClaim(part: BrightnessOverlay | ColourOverlay): JsonObject {
  if (part.kind === 'schedule') return { kind: 'constant', updated: part.at };
  const value = 'brightness' in part ? part.brightness : part.colour.kind === 'kelvin' ? { kelvin: part.colour.kelvin }
    : { rgb: [part.colour.rgb.red, part.colour.rgb.green, part.colour.rgb.blue] };
  return { kind: 'constant', value, updated: part.at };
}

function nativeBase(over: LampOverlay['over']): string {
  return over.kind === 'room' ? `room:${over.room}` : over.lamp;
}

/** The two channels a stored lamp entry claims, by their stored names. */
type Channel = 'brightness' | 'color';

/** A lamp overlay that sets parts, which the channels hold; an off claims none. */
type PartsOverlay = Extract<LampOverlay, { kind: 'parts' }>;

/** What one stored channel claim says: the part it sets, and the effect it runs, if any. */
type ChannelPart<P> = { part: P | undefined; effect: EffectOverlay | undefined };

/** A stored colour, `{kelvin}` in 1000..10000 or `{rgb: [r, g, b]}` each 0..255; none otherwise. */
function storedColour(value: JsonValue | undefined): Colour | undefined {
  if (!isObject(value)) return undefined;
  const kelvin = value['kelvin'], rgb = value['rgb'];
  if (Object.hasOwn(value, 'kelvin')) {
    const inRange = typeof kelvin === 'number' && kelvin >= 1000 && kelvin <= 10000;
    return !Object.hasOwn(value, 'rgb') && inRange ? { kind: 'kelvin', kelvin: toKelvin(kelvin) } : undefined;
  }
  if (!Array.isArray(rgb) || rgb.length !== 3) return undefined;
  const [red, green, blue] = rgb;
  const channelOf = (raw: JsonValue | undefined) => typeof raw === 'number' && raw >= 0 && raw <= 255 ? toColourChannel(raw) : undefined;
  const r = channelOf(red), g = channelOf(green), b = channelOf(blue);
  return r === undefined || g === undefined || b === undefined ? undefined : { kind: 'rgb', rgb: { red: r, green: g, blue: b } };
}

/** An instant as the ISO text `when` is stored as, in UTC; microseconds where the instant has them. */
function isoText(instant: Instant): string {
  if (Number.isInteger(instant * 1000)) return new Date(instant * 1000).toISOString();
  let whole = Math.floor(instant), micros = Math.round((instant - whole) * 1e6);
  if (micros === 1e6) { whole += 1; micros = 0; }
  return `${new Date(whole * 1000).toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`;
}

/** A number the resolver accepts as a stamp: finite, within ±1e20. */
function boundedNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && value > -1e20 && value < 1e20;
}

