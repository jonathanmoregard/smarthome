import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILT_IN_RANGE_DEFAULTS, DEFAULT_STEP_RANGE, EPOCH, decodeOverrides, encodeOverrides } from '../../src/adapter/codecs/overrides-sensor.ts';
import type { OverridesState } from '../../src/adapter/codecs/overrides-sensor.ts';
import type { LampOverlay, RemoteAdjustment, RemoteOverlay } from '../../src/domain/overlays.ts';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { toBrightness, toDashboardControlId, toInstant, toKelvin, toPercentRange, toRemoteSource, toStep, toStepCount } from '../../src/parse/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';
import { id } from './support/ids.ts';

/**
 * The overrides sensor's codec. The stored shapes are the ones today's writers
 * leave (`ls_commit` over the records of `ls_override_block`, the remote plan,
 * the native and dashboard controls and the mode toggle), as the existing
 * tests build them (`r4-commit`, `r4-remote-plan`, `native-control-effects`,
 * `r4-sara-mode`), with synthetic ids. `when` is ISO text; a channel's and an
 * adjustment's `updated` and a preset's `period_updated` are seconds.
 */
const config = syntheticHouse().config;
const roomA = id.room('room-a'), roomB = id.room('room-b');
const lampA1 = id.lamp('light.lamp_a1'), plugA = id.switch('switch.plug_a');
const sourceA = toRemoteSource('remote-a');
const allRooms = new Set([roomA, roomB]);

const T0 = 1_790_000_000;
const sec = (minute: number) => T0 + minute * 60;
const at = (minute: number) => toInstant(sec(minute));
const iso = (minute: number) => new Date(sec(minute) * 1000).toISOString();
const kelvin = (value: number) => ({ kind: 'kelvin', kelvin: toKelvin(value) }) as const;

const stamped = (minute: number, via: string): JsonObject => ({ when: iso(minute), created: iso(minute), who: null, via });
const blockEntry = (target: string, value: JsonValue, minute: number): JsonObject =>
  ({ kind: 'block', target, value, ...stamped(minute, 'app') });
const modeEntry = (minute: number): JsonObject => ({ kind: 'mode', target: 'sara', value: 'on', ...stamped(minute, 'app') });
const nativeEntry = (scope: 'lamp' | 'room', target: string, channels: JsonObject, minute: number): JsonObject => {
  const base = scope === 'room' ? `room:${target}` : target;
  return { kind: 'channels', key: `channels:native:${base}`, source: `native:${base}`, scope, target, value: { channels }, ...stamped(minute, 'app') };
};
const uiEntry = (control: string, scope: 'lamp' | 'room', target: string, value: JsonObject, minute: number): JsonObject =>
  ({ kind: 'channels', key: `channels:ui:${control}`, source: `ui:${control}`, scope, target, value, ...stamped(minute, 'effects-house') });
const inputEntry = (value: JsonObject, minute: number, source = 'remote-a', target = 'room-a'): JsonObject =>
  ({ kind: 'input', key: `channels:${source}`, source, scope: 'room', target, value, ...stamped(minute, 'remote') });
const constant = (value: JsonValue, minute: number): JsonObject => ({ kind: 'constant', value, updated: sec(minute) });
const candleClaim = (instance: string, minute: number, extra: JsonObject = {}): JsonObject =>
  ({ kind: 'effect', effect: 'Candle', instance, updated: sec(minute), ...extra });

/** An adjustment as the remote plan writes it. */
const storedAdjustment = (steps: number, lower: number, upper: number, minute: number, last: string): JsonObject =>
  ({ steps, lower, upper, anchor: 'current', updated: sec(minute), last, has_up: true });
const adjustment = (steps: number, lower: number, upper: number, minute: number, lastPress: 'up' | 'down'): RemoteAdjustment =>
  ({ steps: toStepCount(steps), lower: toStep(lower), upper: toStep(upper), from: 'current', at: at(minute), lastPress, everBrighter: true });

const decode = (overrides: JsonValue, extra: JsonObject = {}) => decodeOverrides({ overrides, ...extra });
/** Encode the decoded state back over the same attributes, every room live: nothing changed, so nothing may move. */
const reencoded = (attributes: JsonObject) => encodeOverrides(decodeOverrides(attributes), attributes, allRooms, config);
const assertKept = (attributes: JsonObject) => assert.equal(JSON.stringify(reencoded(attributes)), JSON.stringify(attributes));

// The golden scenarios, each on the store its steps leave.

test('person change: a fixed brightness and colour on one lamp, the room on', () => {
  // Break: a constant claim is read as no part, or the room's saved power is not read.
  const state = decode({ [`channels:native:${lampA1}`]: nativeEntry('lamp', lampA1, { brightness: constant(90, 5), color: constant({ kelvin: 3000 }, 5) }, 5) },
    { power: { [roomA]: true } });
  assert.deepEqual(state.overlays.lamps, [{
    over: { kind: 'lamp', lamp: lampA1 }, from: { kind: 'person' }, since: at(5),
    brightness: { kind: 'fixed', brightness: toBrightness(90), at: at(5) },
    colour: { kind: 'fixed', colour: kelvin(3000), at: at(5) },
    effect: undefined,
  } satisfies LampOverlay]);
  assert.deepEqual(state.overlays.roomPower, { [roomA]: 'on' });
});

test('remote presses: an adjustment after brighter then dimmer', () => {
  // Brighter from the full range moves both bounds up, held at the top; dimmer moves both down again.
  // Break: an adjustment field is read from the wrong stored key (anchor, updated, last, has_up).
  const value = { step_range: { min: -20, max: 20 }, adjustment: storedAdjustment(0, -20, 19, 12, 'down'), remote_valid_until: sec(600), remote_timing_revision: 0 };
  const state = decode({ 'channels:remote-a': inputEntry(value, 12) });
  assert.deepEqual(state.overlays.remotes, [{
    source: sourceA, room: roomA, since: at(12), stepRange: { min: toStep(-20), max: toStep(20) },
    adjustment: adjustment(0, -20, 19, 12, 'down'), preset: { choice: 'none' }, remembered: {},
  } satisfies RemoteOverlay]);
});

test('remote presses: the room off after the power toggle', () => {
  // Break: a saved false is read as on, or as absent.
  assert.deepEqual(decode({}, { power: { [roomA]: false } }).overlays.roomPower, { [roomA]: 'off' });
});

test('remote presses: nothing after reset', () => {
  // The reset clears the room's entries; its saved power stays, as today's clear_room leaves it.
  // Break: an empty store decodes to some overlay.
  const state = decode({}, { power: { [roomA]: false } });
  assert.deepEqual([state.overlays.remotes, state.overlays.lamps, state.overlays.blocks], [[], [], {}]);
});

test('remote presses: the mode overlay after the mode press', () => {
  // Break: the mode entry's presence is not read, or its since is not its when.
  assert.deepEqual(decode({ 'mode:sara': { ...modeEntry(20), via: 'remote' } }).modeOverlay, { active: true, since: at(20) });
});

test('dashboard block: the house and each room hold night; clear all leaves none', () => {
  // Break: a room's block entry lands on the house, or a capitalised block is not read.
  const held = decode({ 'block:house': blockEntry('house', 'night', 3), [`block:${roomA}`]: blockEntry(roomA, 'night', 3), [`block:${roomB}`]: blockEntry(roomB, 'Night', 3) });
  assert.deepEqual(held.overlays.blocks, { house: { block: 'night', since: at(3) }, [roomA]: { block: 'night', since: at(3) }, [roomB]: { block: 'night', since: at(3) } });
  assert.deepEqual(decode({}).overlays.blocks, {});
});

test('mode toggle: active with its since, then inactive', () => {
  assert.deepEqual(decode({ 'mode:sara': modeEntry(7) }).modeOverlay, { active: true, since: at(7) });
  assert.deepEqual(decode({}).modeOverlay, { active: false });
});

test('range save: a bright rule on the switch', () => {
  // Break: the profile is read from the wrong key, or a bright rule is read as custom.
  assert.deepEqual(decode({}, { switch_ranges: { [plugA]: { profile: 'bright' } } }).switchRanges, { [plugA]: { kind: 'bright' } });
});

test('restart: decoding twice from the same attributes gives equal state', () => {
  const attributes = fullStore();
  assert.deepEqual(decodeOverrides(structuredClone(attributes)), decodeOverrides(attributes));
});

// Parts no golden scenario covers.

test("a dashboard control's candle on one lamp", () => {
  // Break: the candle is read as a brightness or colour kind, or the control's id is lost.
  const value = { channels: { brightness: candleClaim('ui:control-a:Candle', 8), color: candleClaim('ui:control-a:Candle', 8) }, selection: 'Candle' };
  assert.deepEqual(decode({ 'channels:ui:control-a': uiEntry('control-a', 'lamp', lampA1, value, 8) }).overlays.lamps, [{
    over: { kind: 'lamp', lamp: lampA1 }, from: { kind: 'dashboard', control: toDashboardControlId('control-a') }, since: at(8),
    brightness: undefined, colour: undefined, effect: { kind: 'candle', at: at(8) },
  } satisfies LampOverlay]);
});

test('a candle keeps the brightness it runs at: its intensity, else the fixed value kept under it', () => {
  // Carry-over 1. Break: the candle drops the level it runs at, or reads the underlying over the intensity.
  const withIntensity = nativeEntry('lamp', lampA1, { brightness: candleClaim('native:x:Candle', 9, { intensity: 150, underlying: constant(40, 2) }) }, 9);
  const underOnly = nativeEntry('lamp', lampA1, {
    brightness: candleClaim('native:x:Candle', 9, { underlying: constant(40, 2) }),
    color: candleClaim('native:x:Candle', 9, { underlying: constant({ rgb: [255, 120, 0] }, 2) }),
  }, 9);
  const [intensity] = decode({ [`channels:native:${lampA1}`]: withIntensity }).overlays.lamps;
  assert.deepEqual(intensity?.brightness, { kind: 'fixed', brightness: toBrightness(150), at: at(9) });
  assert.deepEqual(intensity?.effect, { kind: 'candle', at: at(9) });
  const [under] = decode({ [`channels:native:${lampA1}`]: underOnly }).overlays.lamps;
  assert.deepEqual(under?.brightness, { kind: 'fixed', brightness: toBrightness(40), at: at(2) });
  assert.deepEqual(under?.colour?.kind === 'fixed' ? under.colour.colour.kind : 'none', 'rgb');
});

test("today's dashboard Normal light: the held level and colour, and the normal light over a candle", () => {
  // Carry-over 1: the pick saves fixed values. They decode as fixed parts; the saved pick also ends a candle.
  // Break: the held values are lost, or the pick does not end the candle the lamp ran.
  const value = { channels: { brightness: constant(120, 6), color: constant({ kelvin: 2700 }, 6) }, selection: 'Normal light' };
  const [overlay] = decode({ 'channels:ui:control-n': uiEntry('control-n', 'lamp', lampA1, value, 6) }).overlays.lamps;
  assert.deepEqual([overlay?.brightness, overlay?.colour, overlay?.effect], [
    { kind: 'fixed', brightness: toBrightness(120), at: at(6) }, { kind: 'fixed', colour: kelvin(2700), at: at(6) }, { kind: 'normal', at: at(6) }]);
});

test('the candle preset remembers the day preset it left', () => {
  // Break: the remembered day loses its time, or the candle drops the day block it holds.
  const selectionInput = storedAdjustment(3, -17, 20, 50, 'up');
  const value = {
    step_range: { min: -20, max: 20 }, selection: 'Candle', adjustment: selectionInput,
    preset_contexts: { day: { period: 'day', period_updated: sec(40), selection_updated: sec(40) } },
    period: 'day', period_updated: sec(40), selection_updated: sec(55), selection_input: selectionInput, selection_instance: 'remote-a:Candle',
  };
  const [overlay] = decode({ 'channels:remote-a': inputEntry(value, 55) }).overlays.remotes;
  assert.deepEqual(overlay?.preset, { choice: 'candle', since: at(55), adjustment: adjustment(3, -17, 20, 50, 'up'), block: { block: 'day', since: at(40) } });
  assert.deepEqual(overlay?.remembered, { day: { choice: 'day', since: at(40) } });
});

test('a candle preset whose stored period is not day or cosy holds no block', () => {
  // Carry-over 2. Break: night (or garbage) is read as a held block.
  for (const period of ['night', 'Day', 7, null] as JsonValue[]) {
    const [overlay] = decode({ 'channels:remote-a': inputEntry({ selection: 'Candle', period, period_updated: sec(4), selection_updated: sec(5) }, 5) }).overlays.remotes;
    assert.deepEqual(overlay?.preset, { choice: 'candle', since: at(5), adjustment: undefined, block: undefined }, JSON.stringify(period));
  }
});

test('a block held over one room only', () => {
  assert.deepEqual(decode({ [`block:${roomB}`]: blockEntry(roomB, 'cosy', 4) }).overlays.blocks, { [roomB]: { block: 'cosy', since: at(4) } });
});

test('two overlays on one lamp keep their own times', () => {
  // Break: the two entries are merged, or one takes the other's times.
  const overrides = {
    'channels:ui:control-a': uiEntry('control-a', 'lamp', lampA1, { channels: { brightness: candleClaim('ui:control-a:Candle', 30), color: candleClaim('ui:control-a:Candle', 30) } }, 30),
    [`channels:native:${lampA1}`]: nativeEntry('lamp', lampA1, { brightness: constant(90, 35) }, 35),
  };
  const lamps = decode(overrides).overlays.lamps;
  assert.deepEqual(lamps.map(overlay => [overlay.from.kind, overlay.since, overlay.effect?.at, overlay.brightness?.at]),
    [['dashboard', at(30), at(30), undefined], ['person', at(35), undefined, at(35)]]);
});

test("a person's change of a whole room is one room overlay", () => {
  // Break: a room entry is read as a lamp, or split per lamp.
  const lamps = decode({ [`channels:native:room:${roomA}`]: nativeEntry('room', roomA, { brightness: constant(60, 2) }, 2) }).overlays.lamps;
  assert.deepEqual(lamps.map(overlay => [overlay.over, overlay.from]), [[{ kind: 'room', room: roomA }, { kind: 'person' }]]);
});

// Round trip: the old scripts read what the port writes.

/** One overlay of each kind and every attribute the overrides sensor holds, as today's writers leave them. */
function fullStore(): JsonObject {
  const selectionInput = storedAdjustment(3, -17, 20, 50, 'up');
  return {
    overrides: {
      'block:house': blockEntry('house', 'cosy', 1),
      [`block:${roomA}`]: blockEntry(roomA, 'Night', 2),
      'channels:remote-a': inputEntry({
        step_range: { min: -20, max: 20 }, selection: 'Candle', adjustment: selectionInput,
        preset_contexts: { day: { period: 'day', period_updated: sec(40), selection_updated: sec(40) }, Breathe: { selection_updated: sec(30) } },
        period: 'day', period_updated: sec(40), selection_updated: sec(55), selection_input: selectionInput, selection_instance: 'remote-a:Candle',
        remote_valid_until: sec(600), remote_timing_revision: 0,
      }, 55),
      [`channels:native:${lampA1}`]: nativeEntry('lamp', lampA1, {
        brightness: candleClaim('native:light.lamp_a1:Candle', 9, { intensity: 150 }),
        color: candleClaim('native:light.lamp_a1:Candle', 9, { underlying: constant({ kelvin: 2200 }, 3) }),
      }, 9),
      'channels:ui:control-a': uiEntry('control-a', 'room', roomA, { channels: { brightness: constant(80, 11) } }, 11),
      'mode:sara': modeEntry(12),
      'light:old': { kind: 'light', target: lampA1, value: { brightness: 10 }, when: iso(1) },
    },
    power: { [roomA]: false, [roomB]: true },
    switch_ranges: { [plugA]: { profile: 'custom', min: 20, max: 60 }, 'switch.plug_b': { profile: 'cosy' } },
    range_defaults: { bright: [80, 100], cosy: [20, 50] },
    switch_overlays: { [plugA]: { power: 'on', when: iso(13) } },
    remote_ack: { 'remote-a': 'remote-a:1790000000' },
    last_via: 'remote',
    pending_rooms: { [roomA]: iso(12) },
    last_request: iso(12),
    received_at: sec(12),
    full_version: iso(11),
    full_reason: 'config',
    full_lights: [],
  };
}

test('a store with one overlay of each kind encodes back exactly', () => {
  // Break: any encoder rewrites an entry or attribute it decoded unchanged.
  assertKept(fullStore());
});

test('after one change to one overlay, only that overlay\'s stored fields differ', () => {
  // Break: a change rewrites other entries, or rewrites fields of the changed one it did not change.
  const found = fullStore();
  const state = decodeOverrides(found);
  const changed: OverridesState = { ...state, overlays: { ...state.overlays, blocks: { ...state.overlays.blocks, [roomA]: { block: 'day', since: at(14) } } } };
  const written = encodeOverrides(changed, found, allRooms, config);
  const before = found.overrides as JsonObject, after = written.overrides as JsonObject;
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const key of Object.keys(before)) if (key !== `block:${roomA}`) assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), key);
  assert.deepEqual(after[`block:${roomA}`], { ...(before[`block:${roomA}`] as JsonObject), value: 'day', when: new Date(sec(14) * 1000).toISOString() });
  for (const key of Object.keys(found)) if (key !== 'overrides') assert.equal(JSON.stringify(written[key]), JSON.stringify(found[key]), key);
});

test('a stored overlay of a room that is not live is left exactly as found', () => {
  // Review Focus 4. Break: the encoder drops or rewrites an overlay of a room the old scripts still drive.
  const found = fullStore();
  const state = decodeOverrides(found);
  const cleared: OverridesState = { ...state, overlays: { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} }, modeOverlay: { active: false } };
  const written = encodeOverrides(cleared, found, new Set([roomB]), config);
  const before = found.overrides as JsonObject, after = written.overrides as JsonObject;
  for (const key of [`block:${roomA}`, 'channels:remote-a', `channels:native:${lampA1}`, 'channels:ui:control-a']) {
    assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), key);
  }
  assert.equal(after['block:house'], undefined, 'the house-wide block is the Model\'s to clear');
  assert.equal(after['mode:sara'], undefined, 'the mode overlay is the Model\'s to clear');
  assert.equal(JSON.stringify(written.power), JSON.stringify({ [roomA]: false }), 'a live room\'s power is the Model\'s');
  assert.equal(JSON.stringify(written.switch_ranges), JSON.stringify(found.switch_ranges), 'the switch is in a room that is not live');
});

test('attributes the Model does not own are left exactly as found', () => {
  // Review Focus 4: key order included. Break: a bookkeeping attribute is dropped, rewritten or moved.
  const found = fullStore();
  const state = decodeOverrides(found);
  const written = encodeOverrides({ ...state, modeOverlay: { active: false } }, found, allRooms, config);
  assert.deepEqual(Object.keys(written), Object.keys(found));
  for (const key of ['remote_ack', 'last_via', 'pending_rooms', 'last_request', 'received_at', 'full_version', 'full_reason', 'full_lights']) {
    assert.equal(JSON.stringify(written[key]), JSON.stringify(found[key]), key);
  }
  assert.equal(JSON.stringify((written.overrides as JsonObject)['light:old']), JSON.stringify((found.overrides as JsonObject)['light:old']));
});

test("the Model's overlays written into an empty store decode back to the same overlays", () => {
  // Every overlay of the synthetic house, including the combinations no writer makes today (a level hold newer than
  // a candle, a Normal over a room). Break: an encoder writes a part the decoder reads back differently.
  const house = syntheticHouse();
  const state: OverridesState = { overlays: house.overlays, modeOverlay: house.modeOverlay, switchRanges: house.switchRanges, rangeDefaults: house.rangeDefaults };
  const written = encodeOverrides(state, {}, allRooms, config);
  assert.deepEqual(decodeOverrides(written), state);
  const level = { ...state.overlays.lamps[1]!, effect: { kind: 'candle', at: at(30) } } satisfies LampOverlay;
  const mixed: OverridesState = { ...state, overlays: { ...state.overlays, lamps: [level] } };
  assert.deepEqual(decodeOverrides(encodeOverrides(mixed, {}, allRooms, config)).overlays.lamps, [level]);
});

test('a new overlay is written as today\'s writers write it', () => {
  // Break: a new entry misses a field the old scripts read (kind, scope, target, when, via) or gets the wrong key.
  const state: OverridesState = {
    ...decodeOverrides({}),
    overlays: {
      blocks: { [roomA]: { block: 'night', since: at(1) } },
      remotes: [{ source: sourceA, room: roomA, since: at(2), stepRange: DEFAULT_STEP_RANGE, adjustment: adjustment(1, -19, 20, 2, 'up'), preset: { choice: 'none' }, remembered: {} }],
      lamps: [{ over: { kind: 'lamp', lamp: lampA1 }, from: { kind: 'person' }, since: at(3), brightness: { kind: 'fixed', brightness: toBrightness(90), at: at(3) }, colour: undefined, effect: undefined }],
      roomPower: { [roomA]: 'off' },
      switches: {},
    },
    modeOverlay: { active: true, since: at(4) },
  };
  const written = encodeOverrides(state, {}, allRooms, config);
  assert.deepEqual(written.overrides, {
    [`block:${roomA}`]: blockEntry(roomA, 'night', 1),
    'channels:remote-a': inputEntry({ step_range: { min: -20, max: 20 }, adjustment: { steps: 1, lower: -19, upper: 20, anchor: 'current', updated: sec(2), last: 'up', has_up: true } }, 2),
    [`channels:native:${lampA1}`]: nativeEntry('lamp', lampA1, { brightness: constant(90, 3) }, 3),
    'mode:sara': modeEntry(4),
  });
  assert.deepEqual(written.power, { [roomA]: false });
});

// Garbage: each saved value a person can change recovers to its default, and the encoder keeps its bytes.

test('an overrides attribute that is not a mapping holds no overlays', () => {
  for (const overrides of ['x', [], 3, null] as JsonValue[]) {
    const state = decode(overrides);
    assert.deepEqual([state.overlays.blocks, state.overlays.remotes, state.overlays.lamps, state.modeOverlay], [{}, [], [], { active: false }]);
    assertKept({ overrides });
  }
});

test('a when that is not a date is the epoch, so the next reset ends it', () => {
  // Today's as_timestamp(when, 0): numbers included.
  for (const when of ['soon', 1_790_000_000, null, ['x']] as JsonValue[]) {
    const overrides = { [`block:${roomA}`]: { ...blockEntry(roomA, 'night', 1), when } };
    assert.deepEqual(decode(overrides).overlays.blocks[roomA], { block: 'night', since: EPOCH }, JSON.stringify(when));
    assertKept({ overrides });
  }
});

test("a channel's updated that is not a number is the entry's when, as the resolver reads it", () => {
  const overrides = { [`channels:native:${lampA1}`]: nativeEntry('lamp', lampA1, { brightness: { kind: 'constant', value: 90, updated: 'later' } }, 6) };
  assert.deepEqual(decode(overrides).overlays.lamps[0]?.brightness, { kind: 'fixed', brightness: toBrightness(90), at: at(6) });
  assertKept({ overrides });
});

test('a saved block that is not a block is not in the Model', () => {
  for (const value of ['purple', 3, null, ['night']] as JsonValue[]) {
    const overrides = { [`block:${roomA}`]: blockEntry(roomA, value, 1) };
    assert.deepEqual(decode(overrides).overlays.blocks, {}, JSON.stringify(value));
    assertKept({ overrides });
  }
});

test('an adjustment whose steps or bounds are out of range is none', () => {
  for (const bad of [{ steps: 41 }, { lower: -21 }, { upper: 21 }, { lower: 5, upper: 2 }, { steps: 'x' }] as JsonObject[]) {
    const overrides = { 'channels:remote-a': inputEntry({ adjustment: { ...storedAdjustment(0, -20, 20, 3, 'up'), ...bad } }, 3) };
    assert.equal(decode(overrides).overlays.remotes[0]?.adjustment, undefined, JSON.stringify(bad));
    assertKept({ overrides });
  }
});

test('an anchor that is none of the three is current', () => {
  const overrides = { 'channels:remote-a': inputEntry({ adjustment: { ...storedAdjustment(0, -20, 20, 3, 'up'), anchor: 'middle' } }, 3) };
  assert.equal(decode(overrides).overlays.remotes[0]?.adjustment?.from, 'current');
  assertKept({ overrides });
});

test('a step range that is not an ordered pair inside -20..20 is the default', () => {
  const overrides = { 'channels:remote-a': inputEntry({ step_range: { min: 5, max: -5 } }, 3) };
  assert.deepEqual(decode(overrides).overlays.remotes[0]?.stepRange, DEFAULT_STEP_RANGE);
  assertKept({ overrides });
});

test('an effect name that is not Candle is the schedule\'s effect', () => {
  // Review Focus 1: a saved Breathe shows the normal light.
  for (const effect of ['Breathe', 'Colour loop', 'Sparkle']) {
    const overrides = { [`channels:native:${lampA1}`]: nativeEntry('lamp', lampA1, { brightness: { ...candleClaim('native:x', 2), effect } }, 2) };
    assert.deepEqual(decode(overrides).overlays.lamps[0]?.effect, { kind: 'schedule', at: at(2) }, effect);
    assertKept({ overrides });
  }
});

test('a custom range whose bounds are not an ordered pair in 0..100 gives the switch no rule', () => {
  for (const rule of [{ profile: 'custom', min: 60, max: 20 }, { profile: 'custom', min: -1, max: 20 }, { profile: 'custom', min: 'a', max: 20 }, { profile: 'warm' }, 'bright'] as JsonValue[]) {
    const extra = { switch_ranges: { [plugA]: rule } };
    assert.deepEqual(decode({}, extra).switchRanges, {}, JSON.stringify(rule));
    assertKept({ overrides: {}, ...extra });
  }
});

test('a custom bound saved as a boolean passes the same check and encodes back as found', () => {
  // Today's `is number` admits booleans as 0 and 1.
  const extra = { switch_ranges: { [plugA]: { profile: 'custom', min: false, max: 60 } } };
  assert.deepEqual(decode({}, extra).switchRanges, { [plugA]: { kind: 'custom', range: toPercentRange(0, 60) } });
  assertKept({ overrides: {}, ...extra });
});

test('range defaults out of order are today\'s defaults', () => {
  for (const range_defaults of [{ bright: [100, 90], cosy: [30, 60] }, 'x', { bright: [90] }] as JsonValue[]) {
    const state = decode({}, { range_defaults });
    assert.deepEqual(state.rangeDefaults.bright, BUILT_IN_RANGE_DEFAULTS.bright, JSON.stringify(range_defaults));
    assertKept({ overrides: {}, range_defaults });
  }
});

test('a saved power that is not a boolean leaves the room on', () => {
  const extra = { power: { [roomA]: 'off', [roomB]: 0 } };
  assert.deepEqual(decode({}, extra).overlays.roomPower, {});
  assertKept({ overrides: {}, ...extra });
});

test('switch overlays that are not a mapping are none; an entry with a bad power or when is dropped', () => {
  for (const switch_overlays of ['x', [1]] as JsonValue[]) {
    assert.deepEqual(decode({}, { switch_overlays }).overlays.switches, {});
    assertKept({ overrides: {}, switch_overlays });
  }
  const switch_overlays = { [plugA]: { power: 'on', when: iso(3) }, 'switch.plug_b': { power: 'dim', when: iso(3) }, 'switch.plug_c': { power: 'off', when: 'soon' } };
  assert.deepEqual(decode({}, { switch_overlays }).overlays.switches, { [plugA]: { power: 'on', since: at(3) } });
  assertKept({ overrides: {}, switch_overlays });
});

test('an entry of no known shape is not in the Model and is kept as found', () => {
  // Unknown kinds and keys, the old `light` entries, a remote's old `channels` shape, a house-wide lamp entry.
  const overrides = {
    'someday:thing': { kind: 'wish' },
    'light:old': { kind: 'light', target: lampA1, value: { brightness: 10 }, when: iso(1) },
    'channels:remote-a': { kind: 'channels', scope: 'room', target: roomA, via: 'remote', value: { position: 0.5 }, when: iso(1) },
    'channels:native:house': { kind: 'channels', scope: 'house', target: 'house', value: { channels: { brightness: constant(5, 1) } }, when: iso(1) },
    'channels:ui:control-z': 'not a mapping',
  };
  const state = decode(overrides);
  assert.deepEqual([state.overlays.remotes, state.overlays.lamps, state.overlays.blocks], [[], [], {}]);
  assertKept({ overrides });
});
