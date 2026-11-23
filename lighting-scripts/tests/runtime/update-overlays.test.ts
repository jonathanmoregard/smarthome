import assert from 'node:assert/strict';
import test from 'node:test';
import { candle, normal } from '../../src/domain/effect.ts';
import { lightingState, MODE_COLOUR } from '../../src/domain/lighting-state.ts';
import type { Model, Msg, OverlayRequest, RequestedLight } from '../../src/domain/model.ts';
import { clearRoom } from '../../src/domain/overlays.ts';
import { update } from '../../src/domain/update.ts';
import type { LampId, RoomId } from '../../src/domain/types/ids.ts';
import type { Colour, LampLight, OnLight } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import {
  toBrightness, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toLevel, toPercentRange, toRemoteSource,
  toRemoteId, toRoomId, toStep, toSwitchId, toTimeOfDay,
} from '../../src/parse/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * `update` for overlays, resets, ranges and profiles (M3 Task 1): each test
 * sends one message, then reads the lighting state (the flow) and the model.
 *
 * The synthetic house without its overlays, in UTC on Monday 2026-09-21: day
 * 07:00, 220 at 4000 K; `room-a`'s own cosy from 17:30 (fade from 16:45), 90 in
 * orange with the candle; `light.lamp_a1` has a candle bulb and its own
 * colourless cosy candle; `room-b` is private. `switch.plug_a` in `room-a` is
 * on from 20 % to 60 % of the room's level (day's 220 is 86 %, so off at
 * noon). The next-block reset is on; the after-age reset is 180 minutes.
 */

const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const rgb = (red: number, green: number, blue: number): Colour =>
  ({ kind: 'rgb', rgb: { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) } });
const shows = (level: number, colour: Colour | undefined, effect: OnLight['effect'] = normal): LampLight =>
  ({ power: 'on', level: toLevel(level), colour, effect, transition: { kind: 'manual' } });
const OFF: LampLight = { power: 'off' };
const DAY = shows(220, kelvin(4000)), ORANGE = rgb(255, 150, 60), WARM_END = rgb(255, 126, 0);

const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2'), lampB1 = toLampId('light.lamp_b1');
const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const plugA = toSwitchId('switch.plug_a');
const controlX = toDashboardControlId('control-x');
const onLamp = (lamp: LampId) => ({ kind: 'lamp', lamp }) as const;

/** The synthetic house with no overlays and the mode overlay off; `change` makes the test's one change. */
function house(change: (model: Model) => void = () => {}): Model {
  const model = structuredClone(syntheticHouse());
  model.overlays = { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} };
  model.modeOverlay = { active: false };
  change(model);
  return model;
}

/** The model after each message in turn. */
function after(model: Model, ...msgs: Msg[]): Model {
  return msgs.reduce(update, model);
}

const lamp = (model: Model, id: LampId, now: Instant) => lightingState(model, now).lamps[id];
const plug = (model: Model, now: Instant) => lightingState(model, now).switches[plugA];

const requested = (request: OverlayRequest, time: string): Msg => ({ kind: 'overlayRequested', request, at: at(time) });
const clock = (time: string, day = 21): Msg => ({ kind: 'clock', now: at(time, day) });
/** A person's call: the lamps it reaches, and the rooms it named whole (an area, or a group covering the room). */
const person = (lamps: readonly LampId[], light: RequestedLight, time: string, rooms: readonly RoomId[] = []): Msg =>
  ({ kind: 'lampChangedByPerson', lamps, rooms, light, at: at(time) });
const brightness = (lamps: readonly LampId[], value: number, time: string, rooms: readonly RoomId[] = []): Msg =>
  person(lamps, { power: 'on', brightness: toBrightness(value), colour: undefined, effect: undefined }, time, rooms);
const personOff = (lamps: readonly LampId[], time: string, rooms: readonly RoomId[] = []): Msg => person(lamps, { power: 'off' }, time, rooms);
const PLAIN_ON: RequestedLight = { power: 'on', brightness: undefined, colour: undefined, effect: undefined };
const pressed = (power: 'on' | 'off', time: string): Msg => ({ kind: 'switchButtonPressed', switch: plugA, power, at: at(time) });
const control = (light: Extract<OverlayRequest, { kind: 'dashboard control' }>['light'], time: string, over = onLamp(lampA1)) =>
  requested({ kind: 'dashboard control', control: controlX, over, light }, time);

// Holds.

test("holding a block shows that block's light at once", () => {
  // Break: the hold is not written, or written for another room.
  const model = after(house(), requested({ kind: 'hold block', over: roomA, block: 'cosy' }, '12:00:00'));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(90, ORANGE));
  assert.deepEqual(lamp(model, lampB1, at('12:00:00')), DAY);
  assert.deepEqual(model.overlays.blocks, { [roomA]: { block: 'cosy', since: at('12:00:00') } });
});

test('holding the block the schedule is in clears the hold', () => {
  // Today's planOverrideBlock clears a target already scheduled to the block. Break: a day hold is written in the day.
  const model = after(house(), requested({ kind: 'hold block', over: roomA, block: 'cosy' }, '12:00:00'),
    requested({ kind: 'hold block', over: roomA, block: 'day' }, '12:10:00'));
  assert.deepEqual(model.overlays.blocks, {});
  assert.deepEqual(lamp(model, lampA2, at('12:10:00')), DAY);
});

test('a block held over the house is also held over each room but the private one', () => {
  // Carry-over 4, legacy houseRooms. Break: the rooms are not held, so their lamps keep the schedule, or the private room is.
  const model = after(house(), requested({ kind: 'hold block', over: 'house', block: 'cosy' }, '12:00:00'));
  const held = { block: 'cosy', since: at('12:00:00') };
  assert.deepEqual(model.overlays.blocks, { house: held, [roomA]: held });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(90, ORANGE));
  assert.deepEqual(lamp(model, lampB1, at('12:00:00')), DAY);
});

test('clear all returns every lamp to the schedule', () => {
  // Break: an overlay kind survives clear all, or the room's saved power is cleared with them.
  const busy = house(m => { m.overlays.roomPower[roomB] = 'off'; });
  const held = after(busy,
    requested({ kind: 'hold block', over: roomA, block: 'night' }, '11:00:00'),
    brightness([lampA2], 50, '11:10:00'),
    { kind: 'modeToggled', on: true, at: at('11:20:00') },
    pressed('on', '11:30:00'));
  held.overlays.remotes = [{ source: toRemoteSource('remote-a'), room: roomA, since: at('11:40:00'), stepRange: { min: toStep(-20), max: toStep(20) },
    adjustment: undefined, preset: { choice: 'day', since: at('11:40:00') }, remembered: {} }];
  const cleared = after(held, requested({ kind: 'clear all' }, '12:00:00'));
  assert.deepEqual(cleared.overlays, { blocks: {}, remotes: [], lamps: [], roomPower: { [roomB]: 'off', [roomA]: 'on' }, switches: {} });
  assert.deepEqual(cleared.modeOverlay, { active: false });
  assert.deepEqual(lamp(cleared, lampA2, at('12:00:00')), DAY);
  assert.equal(plug(cleared, at('12:00:00')), 'off');
});

// A person's change in Home Assistant.

test("a person's brightness change holds the lamp and switches its room on", () => {
  // Break: the change is not held, holds the other lamp of the room too, or leaves the room off.
  const model = after(house(m => { m.overlays.roomPower[roomA] = 'off'; }), brightness([lampA2], 80, '12:00:00'));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(80, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), DAY);
  assert.deepEqual(model.overlays.roomPower, { [roomA]: 'on' });
  assert.deepEqual(model.overlays.lamps, [{ kind: 'parts', over: onLamp(lampA2), from: { kind: 'person' }, since: at('12:00:00'),
    brightness: { kind: 'fixed', brightness: toBrightness(80), at: at('12:00:00') }, colour: undefined, effect: undefined }]);
});

test("a person's change of a whole room is one room overlay", () => {
  // The call named the room (an area or a group covering it). Break: one overlay per lamp, or the room overlay reaches the other room.
  const model = after(house(), brightness([lampA1, lampA2], 60, '12:00:00', [roomA]));
  assert.deepEqual(model.overlays.lamps.map(overlay => overlay.over), [{ kind: 'room', room: roomA }]);
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(60, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(60, kelvin(4000)));
  assert.deepEqual(lamp(model, lampB1, at('12:00:00')), DAY);
});

test("a call naming each lamp of a room is one overlay per lamp, as today", () => {
  // Only a named area or group gives a room overlay (today's roomScopes). Break: the lamps are folded into a room overlay.
  const model = after(house(), brightness([lampA1, lampA2], 60, '12:00:00'), brightness([lampB1], 60, '12:00:00'));
  assert.deepEqual(model.overlays.lamps.map(overlay => overlay.over), [onLamp(lampA1), onLamp(lampA2), onLamp(lampB1)]);
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(60, kelvin(4000)));
});

test("a person's second change of a lamp keeps the part the first set", () => {
  // Today's ls_commit merges the channels of one native key. Break: the newer change replaces the older one whole.
  const colour = person([lampA2], { power: 'on', brightness: undefined, colour: kelvin(3000), effect: undefined }, '12:10:00');
  const model = after(house(), brightness([lampA2], 80, '12:00:00'), colour);
  assert.equal(model.overlays.lamps.length, 1);
  assert.deepEqual(lamp(model, lampA2, at('12:10:00')), shows(80, kelvin(3000)));
});

test("a person's brightness change on a candle lamp keeps the candle", () => {
  // Owner, 2026-11-22. Break: the brightness hold ends the candle.
  const model = after(house(), control({ power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'candle' } }, '12:00:00'),
    brightness([lampA1], 60, '12:10:00'));
  assert.deepEqual(lamp(model, lampA1, at('12:10:00')), shows(60, WARM_END, candle));
});

test("a person's change to the normal light pins the level and colour the lamp shows, and ends the candle", () => {
  // Today's `held` (review ruling): a dimmed candle switched to the normal light stays dim, at the colour under the
  // candle, and stays there. Break: the parts are handed back to the schedule, or the candle keeps running.
  const candleAt60 = person([lampA1], { power: 'on', brightness: toBrightness(60), colour: undefined, effect: { kind: 'candle' } }, '12:00:00');
  const toNormal = person([lampA1], { power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'normal' } }, '12:10:00');
  const model = after(house(), candleAt60);
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(60, WARM_END, candle));
  const normalLight = after(model, toNormal);
  assert.deepEqual(lamp(normalLight, lampA1, at('12:10:00')), shows(60, kelvin(4000)));
  const pinned = normalLight.overlays.lamps[0];
  assert.deepEqual(pinned?.kind === 'parts' ? [pinned.brightness, pinned.colour, pinned.effect] : undefined, [
    { kind: 'fixed', brightness: toBrightness(60), at: at('12:10:00') },
    { kind: 'fixed', colour: kelvin(4000), at: at('12:10:00') },
    { kind: 'normal', at: at('12:10:00') },
  ]);
});

test('the normal light on a lamp that shows off hands both parts back to the schedule', () => {
  // Today's `held`: an off lamp has no level and no colour to pin. Break: a level or colour is invented for it.
  const model = after(house(m => { m.overlays.roomPower[roomA] = 'off'; }),
    person([lampA2], { power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'normal' } }, '12:00:00'));
  const pinned = model.overlays.lamps[0];
  assert.deepEqual(pinned?.kind === 'parts' ? [pinned.brightness, pinned.colour] : undefined,
    [{ kind: 'schedule', at: at('12:00:00') }, { kind: 'schedule', at: at('12:00:00') }]);
});

// A person's off (owner, 2026-11-23).

test("a person's off holds the lamp off and leaves the room's power alone", () => {
  // Carry-over 1.4. Break: the off is not held, switches the room off, or reaches the other lamp.
  const model = after(house(), personOff([lampA2], '12:00:00'));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), OFF);
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), DAY);
  assert.deepEqual(model.overlays.roomPower, {});
  assert.deepEqual(model.overlays.lamps, [{ kind: 'off', over: onLamp(lampA2), from: { kind: 'person' }, since: at('12:00:00') }]);
});

test("a person's off replaces their earlier light, and a later light replaces the off", () => {
  // Carry-over 1.5. Break: two person overlays pile up on the lamp, or the off keeps the old parts.
  const off = after(house(), brightness([lampA2], 80, '12:00:00'), personOff([lampA2], '12:10:00'));
  assert.deepEqual(off.overlays.lamps, [{ kind: 'off', over: onLamp(lampA2), from: { kind: 'person' }, since: at('12:10:00') }]);
  const relit = after(off, person([lampA2], { power: 'on', brightness: undefined, colour: kelvin(3000), effect: undefined }, '12:20:00'));
  assert.equal(relit.overlays.lamps.length, 1);
  assert.deepEqual(lamp(relit, lampA2, at('12:20:00')), shows(220, kelvin(3000)));
});

test("a person's off of a whole room is one room overlay, released by the next block", () => {
  // Break: the room off is per lamp, or outlives the cosy fade start at 16:45.
  const model = after(house(), personOff([lampA1, lampA2], '12:00:00', [roomA]));
  assert.deepEqual(model.overlays.lamps.map(overlay => [overlay.kind, overlay.over]), [['off', { kind: 'room', room: roomA }]]);
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), OFF);
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(90, ORANGE));
});

test("a dashboard control's off holds the lamp off like a person's", () => {
  // Carry-over 1.8. Break: the control's off is not a hold, or does not replace the control's earlier light.
  const model = after(house(), control({ power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(40) }, colour: undefined, effect: undefined },
    '12:00:00'), control({ power: 'off' }, '12:10:00'));
  assert.deepEqual(lamp(model, lampA1, at('12:10:00')), OFF);
  assert.deepEqual(model.overlays.lamps, [{ kind: 'off', over: onLamp(lampA1), from: { kind: 'dashboard', control: controlX }, since: at('12:10:00') }]);
});

test("a person's plain switch-on ends their off and switches the room on", () => {
  // Review ruling (open question 1, A). Break: the lamp stays held off, or the room's power stays off.
  const model = after(house(m => { m.overlays.roomPower[roomA] = 'off'; }), personOff([lampA2], '12:00:00'), person([lampA2], PLAIN_ON, '12:10:00'));
  assert.deepEqual(lamp(model, lampA2, at('12:10:00')), DAY);
  assert.deepEqual(model.overlays.roomPower, { [roomA]: 'on' });
});

test('switching one lamp of a room held off back on leaves the others off', () => {
  // Break: the plain switch-on ends the whole room's off, or does not reach the lamp under the room's off.
  const model = after(house(), personOff([lampA1, lampA2], '12:00:00', [roomA]), person([lampA2], PLAIN_ON, '12:10:00'));
  assert.deepEqual(lamp(model, lampA2, at('12:10:00')), DAY);
  assert.deepEqual(lamp(model, lampA1, at('12:10:00')), OFF);
});

test("the dashboard's power on does the same, over a person's off too", () => {
  // Review ruling: the dashboard's ON maps to the plain switch-on. Break: the person's off survives the control's ON.
  const model = after(house(m => { m.overlays.roomPower[roomA] = 'off'; }), personOff([lampA1], '12:00:00'),
    control({ power: 'on', brightness: undefined, colour: undefined, effect: undefined }, '12:10:00'));
  assert.deepEqual(lamp(model, lampA1, at('12:10:00')), DAY);
  assert.deepEqual(model.overlays.roomPower, { [roomA]: 'on' });
});

// Dashboard controls.

test('choosing the candle from the dashboard starts it on that lamp', () => {
  // Break: the candle is not held, or reaches the other lamp.
  const model = after(house(), control({ power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'candle' } }, '12:00:00'));
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(220, WARM_END, candle));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), DAY);
});

test('choosing the normal light ends it', () => {
  // Break: the normal light leaves the candle running, or holds the candle's warm colour.
  const model = after(house(), control({ power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'candle' } }, '12:00:00'),
    control({ power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'normal' } }, '12:10:00'));
  assert.deepEqual(lamp(model, lampA1, at('12:10:00')), DAY);
  assert.equal(model.overlays.lamps.length, 1);
});

test("a control's second change keeps the part its first set", () => {
  // Break: the control's overlay is replaced whole, dropping the earlier brightness.
  const model = after(house(), control({ power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(40) }, colour: undefined, effect: undefined },
    '12:00:00'), control({ power: 'on', brightness: undefined, colour: { kind: 'fixed', colour: kelvin(3000) }, effect: undefined }, '12:10:00'));
  assert.deepEqual(lamp(model, lampA1, at('12:10:00')), shows(40, kelvin(3000)));
});

test("a room control's power switches the room off and on", () => {
  // Break: the room's power is not written.
  const off = after(house(), requested({ kind: 'room power', room: roomA, power: 'off' }, '12:00:00'));
  assert.deepEqual(lamp(off, lampA2, at('12:00:00')), OFF);
  const on = after(off, requested({ kind: 'room power', room: roomA, power: 'on' }, '12:10:00'));
  assert.deepEqual(lamp(on, lampA2, at('12:10:00')), DAY);
});

// The mode overlay.

test('the mode overlay toggles', () => {
  // Break: switching it on again restarts its age, or switching it off leaves it on.
  const on = after(house(), { kind: 'modeToggled', on: true, at: at('12:00:00') }, { kind: 'modeToggled', on: true, at: at('12:30:00') });
  assert.deepEqual(on.modeOverlay, { active: true, since: at('12:00:00') });
  assert.deepEqual(lamp(on, lampA2, at('12:30:00')), shows(220, MODE_COLOUR));
  const off = after(on, { kind: 'modeToggled', on: false, at: at('12:40:00') });
  assert.deepEqual(off.modeOverlay, { active: false });
  assert.deepEqual(lamp(off, lampA2, at('12:40:00')), DAY);
});

// Overlay resets.

test('an overlay older than the limit is removed on the next clock', () => {
  // 180 minutes from 12:00 is 15:00, the limit included (today's `>=`). Break: removed early, late, or never.
  const held = after(house(), brightness([lampA2], 50, '12:00:00'), { kind: 'modeToggled', on: true, at: at('13:00:00') });
  const before = after(held, clock('14:59:59'));
  assert.equal(before.overlays.lamps.length, 1);
  const due = after(held, clock('15:00:00'));
  assert.deepEqual(due.overlays.lamps, []);
  assert.deepEqual(due.modeOverlay, { active: true, since: at('13:00:00') });
  assert.deepEqual(lamp(due, lampA2, at('15:00:00')), shows(220, MODE_COLOUR));
});

test('the at-set-time reset removes every overlay', () => {
  // Every overlay set before the reset time, at the first clock after it; one set after it stays.
  // Break: an overlay kind survives the reset, or one set after it is removed.
  const daily = house(m => { m.config.overlayReset = { atNextBlock: true, atSetTime: toTimeOfDay(13, 0), afterAge: undefined }; });
  const held = after(daily,
    requested({ kind: 'hold block', over: roomA, block: 'cosy' }, '12:00:00'),
    brightness([lampA2], 50, '12:10:00'),
    { kind: 'modeToggled', on: true, at: at('12:20:00') },
    pressed('on', '12:30:00'));
  assert.equal(after(held, clock('12:59:00')).overlays.lamps.length, 1);
  const reset = after(held, clock('13:00:00'));
  assert.deepEqual(reset.overlays, { blocks: {}, remotes: [], lamps: [], roomPower: { [roomA]: 'on' }, switches: {} });
  assert.deepEqual(reset.modeOverlay, { active: false });
  const later = after(reset, brightness([lampA2], 40, '13:05:00'), clock('13:10:00'));
  assert.equal(later.overlays.lamps.length, 1);
});

test('with both rules off nothing is removed', () => {
  // Break: a clock removes an overlay while neither the after-age nor the at-set-time rule is on.
  const quiet = house(m => { m.config.overlayReset = { atNextBlock: false, atSetTime: undefined, afterAge: undefined }; });
  const held = after(quiet, brightness([lampA2], 50, '12:00:00'), pressed('on', '12:00:00'), { kind: 'modeToggled', on: true, at: at('12:00:00') });
  assert.deepEqual(after(held, clock('12:00:00', 23)), held);
});

// Ranges and profiles.

test('saving a range rule changes when the switch is on', () => {
  // Day's 86 % is outside 20..60 and inside 80..90. Break: the saved rule is not the one the switch reads.
  const model = house();
  assert.equal(plug(model, at('12:00:00')), 'off');
  const saved = after(model, { kind: 'rangeSaved', switch: plugA, rule: { kind: 'custom', range: toPercentRange(80, 90) }, at: at('12:00:00') });
  assert.equal(plug(saved, at('12:00:00')), 'on');
});

test('saving the range defaults changes a switch on a default rule', () => {
  // Break: the defaults are not saved.
  const bright = house(m => { m.switchRanges[plugA] = { kind: 'bright' }; });
  assert.equal(plug(bright, at('12:00:00')), 'off');
  const saved = after(bright, { kind: 'rangeDefaultsSaved', defaults: { bright: toPercentRange(80, 100), cosy: toPercentRange(30, 60) },
    at: at('12:00:00') });
  assert.equal(plug(saved, at('12:00:00')), 'on');
});

test("saving a lamp profile changes that lamp's block light", () => {
  // Break: the profile is saved for another block or lamp, or not read.
  const model = after(house(), { kind: 'lampProfileSaved', lamp: lampA2, block: 'day', at: at('12:00:00'),
    change: { own: true, power: undefined, brightness: toBrightness(60), colour: kelvin(3000), effect: undefined } });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(60, kelvin(3000)));
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(90, ORANGE));
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), DAY);
});

test('a profile save with a field missing keeps the saved value', () => {
  // Today's ls_store patches the fields it is given. Break: a missing field resets to its default.
  const saved = after(house(), { kind: 'lampProfileSaved', lamp: lampA2, block: 'day', at: at('12:00:00'),
    change: { own: true, power: undefined, brightness: toBrightness(60), colour: kelvin(3000), effect: 'Candle' } });
  const dimmer = after(saved, { kind: 'lampProfileSaved', lamp: lampA2, block: 'day', at: at('12:10:00'),
    change: { own: undefined, power: undefined, brightness: toBrightness(40), colour: undefined, effect: undefined } });
  assert.deepEqual(dimmer.lampProfiles[lampA2]!.day,
    { follows: 'own', light: { power: 'on', brightness: toBrightness(40), colour: kelvin(3000), effect: 'Candle' } });
  const off = after(dimmer, { kind: 'lampProfileSaved', lamp: lampA2, block: 'day', at: at('12:20:00'),
    change: { own: undefined, power: 'off', brightness: undefined, colour: undefined, effect: undefined } });
  assert.deepEqual(lamp(off, lampA2, at('12:20:00')), OFF);
  const room = after(off, { kind: 'lampProfileSaved', lamp: lampA2, block: 'day', at: at('12:30:00'),
    change: { own: false, power: undefined, brightness: undefined, colour: undefined, effect: undefined } });
  assert.deepEqual(room.lampProfiles[lampA2]!.day, { follows: 'room' });
});

test("saving a plug's own on/off profile changes the plug in that block", () => {
  // Carry-over 5. The plug follows its block's setting (on in the day) once it has no range rule.
  // Break: the plug's own profile is not saved, or a save that names no own flag takes the plug off its room.
  const noRule = house(m => { delete m.switchRanges[plugA]; });
  assert.equal(plug(noRule, at('12:00:00')), 'on');
  const own = after(noRule, { kind: 'switchProfileSaved', switch: plugA, block: 'day', change: { own: true, power: 'off' }, at: at('12:00:00') });
  assert.equal(plug(own, at('12:00:00')), 'off');
  const unsaid = after(noRule, { kind: 'switchProfileSaved', switch: plugA, block: 'day', change: { own: undefined, power: 'off' }, at: at('12:00:00') });
  assert.equal(plug(unsaid, at('12:00:00')), 'on');
});

// A switch's own button (decision 8).

test('a switch\'s own button holds it over its range rule across the next clock', () => {
  // The legacy revert at the next tick is not carried over. Break: the press is taken back by the range, or by a clock.
  const model = after(house(), pressed('on', '12:00:00'), clock('12:01:00'));
  assert.equal(plug(model, at('12:01:00')), 'on');
  assert.deepEqual(model.overlays.switches, { [plugA]: { power: 'on', since: at('12:00:00') } });
});

test('a range save for that switch does not release it', () => {
  // Break: saving the rule clears the switch overlay.
  const model = after(house(), pressed('on', '12:00:00'),
    { kind: 'rangeSaved', switch: plugA, rule: { kind: 'cosy' }, at: at('12:10:00') });
  assert.equal(plug(model, at('12:10:00')), 'on');
});

test('the after-age reset releases a switch overlay', () => {
  // Break: the switch overlay outlives its age, so the range never takes the plug back.
  const model = after(house(), pressed('on', '12:00:00'), clock('15:00:00'));
  assert.deepEqual(model.overlays.switches, {});
  assert.equal(plug(model, at('15:00:00')), 'off');
});

test('clear all releases it', () => {
  // Break: clear all leaves the switch overlay.
  const model = after(house(), pressed('on', '12:00:00'), requested({ kind: 'clear all' }, '12:10:00'));
  assert.deepEqual(model.overlays.switches, {});
  assert.equal(plug(model, at('12:10:00')), 'off');
});

test('a reset of its room releases it', () => {
  // A room's reset removes the room's overlays and no other room's. Break: the switch overlay, a lamp overlay
  // or the block of the room survives, or another room's overlay goes.
  const held = after(house(), pressed('on', '12:00:00'), brightness([lampA2], 50, '12:00:00'), brightness([lampB1], 50, '12:00:00'),
    requested({ kind: 'hold block', over: roomA, block: 'cosy' }, '12:00:00'));
  const reset = clearRoom(held, roomA);
  assert.deepEqual(reset.overlays.switches, {});
  assert.deepEqual(reset.overlays.blocks, {});
  assert.deepEqual(reset.overlays.lamps.map(overlay => overlay.over), [onLamp(lampB1)]);
  assert.equal(plug(reset, at('12:10:00')), 'off');
  assert.deepEqual(lamp(reset, lampA2, at('12:10:00')), DAY);
});

test('a second press replaces the first', () => {
  // The range 80..90 says on at noon, so only the second press can hold it off. Break: the first press wins, or both are kept.
  const onAtNoon = house(m => { m.switchRanges[plugA] = { kind: 'custom', range: toPercentRange(80, 90) }; });
  const model = after(onAtNoon, pressed('on', '12:00:00'), pressed('off', '12:05:00'));
  assert.deepEqual(model.overlays.switches, { [plugA]: { power: 'off', since: at('12:05:00') } });
  assert.equal(plug(model, at('12:05:00')), 'off');
});

// The config and the remote.

test('a config change is taken whole', () => {
  // Break: the old config, or part of it, stays.
  const config = structuredClone(house().config);
  config.house.day.light = { power: 'on', brightness: toBrightness(100), colour: kelvin(5000), effect: 'Normal' };
  const model = after(house(), { kind: 'configChanged', config, at: at('12:00:00') });
  assert.equal(model.config, config);
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(100, kelvin(5000)));
});

test('a remote press changes nothing yet (M3 Task 2)', () => {
  // Break: update raises on, or acts on, a message M3 Task 2 has not built yet.
  const model = house();
  assert.equal(after(model, { kind: 'remotePressed', remote: toRemoteId('remote-a'), press: { kind: 'command', command: 'up' }, at: at('12:00:00') }),
    model);
});
