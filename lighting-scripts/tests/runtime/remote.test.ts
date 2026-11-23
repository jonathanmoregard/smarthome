import assert from 'node:assert/strict';
import test from 'node:test';
import { candle, normal } from '../../src/domain/effect.ts';
import { lightingState, MODE_COLOUR, nextChange } from '../../src/domain/lighting-state.ts';
import type { Model, Msg, PresetButton, RemoteButton } from '../../src/domain/model.ts';
import { CHORD_WINDOW, IDLE_REMOTE, POWER_COMBO_WINDOW } from '../../src/domain/remote.ts';
import { update } from '../../src/domain/update.ts';
import type { LampId, RemoteId } from '../../src/domain/types/ids.ts';
import type { Colour, LampLight, OnLight } from '../../src/domain/types/light.ts';
import type { RemoteCommand } from '../../src/domain/types/remote.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import {
  toBrightness, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toLevel, toRemoteId, toRoomId, toStep,
} from '../../src/parse/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * The remote as `update` cases (M3 Task 2): each test sends a remote's presses
 * through `update`, then reads the lighting state.
 *
 * Carried over from `gestures-reducer.test.ts`, `r4-gestures.test.ts`,
 * `r4-remote-plan.test.ts` and `host-remote.test.ts`: the cases that state a
 * flow (a press, a burst of power presses, a chord, the preset dial, the
 * arrows starting from the room's block). Their cases about helper writes,
 * tokens, the sender thunk and Jinja readings of saved garbage are not carried.
 *
 * The synthetic house without its overlays, in UTC on Monday 2026-09-21: day
 * from 07:00, 220 at 4000 K; `room-a`'s own cosy from 17:30 (its fade from
 * 16:45), 90 in orange with the candle; `light.lamp_a1` has a candle bulb and
 * its own colourless cosy candle at 100; `light.lamp_a2` has none; night from
 * 22:30 is off. `remote-a` is in `room-a`, `remote-b` in no room. The
 * next-block reset is on.
 */

const at = (time: string): Instant => toInstant(Date.parse(`2026-09-21T${time}Z`) / 1000);
const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const rgb = (red: number, green: number, blue: number): Colour =>
  ({ kind: 'rgb', rgb: { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) } });
const shows = (level: number, colour: Colour | undefined, effect: OnLight['effect'] = normal): LampLight =>
  ({ power: 'on', level: toLevel(level), colour, effect, transition: { kind: 'manual' } });
const OFF: LampLight = { power: 'off' };
const ORANGE = rgb(255, 150, 60), WARM_END = rgb(255, 126, 0);
const DAY = shows(220, kelvin(4000)), COSY = shows(90, ORANGE);

const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2'), lampB1 = toLampId('light.lamp_b1');
const roomA = toRoomId('room-a');
const remoteA = toRemoteId('remote-a'), remoteB = toRemoteId('remote-b'), remoteC = toRemoteId('remote-c');

/** The synthetic house with no overlays, the mode overlay off and every remote idle; `change` makes the test's one change. */
function house(change: (model: Model) => void = () => {}): Model {
  const model = structuredClone(syntheticHouse());
  model.overlays = { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} };
  model.modeOverlay = { active: false };
  model.remotes = { [remoteA]: IDLE_REMOTE, [remoteB]: IDLE_REMOTE };
  change(model);
  return model;
}

/** The model after each message in turn. */
function after(model: Model, ...msgs: Msg[]): Model {
  return msgs.reduce(update, model);
}

const lamp = (model: Model, id: LampId, time: string) => lightingState(model, at(time)).lamps[id];
const level = (model: Model, id: LampId, time: string): number => {
  const light = lamp(model, id, time);
  if (light === undefined || light.power === 'off') throw new Error(`${id} is lit at ${time}`);
  return light.level;
};

/** A remote's command; `anyOn` is what the room's lamps and switches report at the press (on, unless the test says). */
const send = (command: RemoteCommand, time: string, remote: RemoteId = remoteA, anyOn = true): Msg =>
  ({ kind: 'remotePressed', remote, command, anyOn, at: at(time) });
const press = (button: RemoteButton, time: string, remote: RemoteId = remoteA, anyOn = true): Msg =>
  ({ kind: 'remoteButtonPressed', remote, button, anyOn, at: at(time) });
const power = (time: string, remote: RemoteId = remoteA, anyOn = true) => press({ kind: 'power' }, time, remote, anyOn);
const arrow = (direction: 'left' | 'right' | 'up' | 'down', time: string) => press({ kind: 'arrow', direction }, time);
const dial = (button: PresetButton | undefined, time: string) => press({ kind: 'preset', button }, time);
const clock = (time: string): Msg => ({ kind: 'clock', now: at(time) });
const holdBlock = (block: 'day' | 'cosy' | 'night', time: string): Msg =>
  ({ kind: 'overlayRequested', request: { kind: 'hold block', over: roomA, block }, at: at(time) });
/** `count` presses of one command, a second apart from `time` (12:00:00 style, minutes and seconds counted on). */
function presses(command: RemoteCommand, count: number, from = '12:00'): Msg[] {
  return Array.from({ length: count }, (_, index) => send(command, `${from}:${String(index).padStart(2, '0')}`));
}
const presetOf = (model: Model) => model.overlays.remotes.find(overlay => overlay.remote === remoteA)?.preset;
const stepsOf = (model: Model, remote: RemoteId = remoteA) => model.overlays.remotes.find(overlay => overlay.remote === remote)?.adjustment?.steps;

// Brighter and dimmer.

test("brighter moves every lamp of the remote's room up the blend, dimmer down", () => {
  // Carried from host-remote.test.ts (a brighter press lights the bulb brighter). Break: the step goes the wrong way,
  // misses a lamp of the room, or reaches another room.
  const brighter = after(house(), send('up', '12:00:00')), dimmer = after(house(), send('down', '12:00:00'));
  assert.ok(level(brighter, lampA2, '12:00:00') > 220);
  assert.ok(level(dimmer, lampA2, '12:00:00') < 220);
  assert.deepEqual(lamp(brighter, lampB1, '12:00:00'), DAY);
});

test('brighter then dimmer returns the room to where it was', () => {
  // Break: dimmer does not undo brighter (a bound or the count moves the wrong way).
  const model = after(house(), send('up', '12:00:00'), send('down', '12:00:01'));
  assert.deepEqual(lamp(model, lampA2, '12:00:02'), DAY);
});

test('presses stop at the end of the step range', () => {
  // From day ten presses reach the top of the blend; any further press changes nothing, and never breaks.
  // Break: the count runs past the range, or past the type's -40..40 and raises.
  const nine = after(house(), ...presses('up', 9)), ten = after(house(), ...presses('up', 10)), many = after(house(), ...presses('up', 45));
  assert.ok(level(nine, lampA2, '12:01:00') < level(ten, lampA2, '12:01:00'));
  assert.deepEqual(lamp(many, lampA2, '12:01:00'), lamp(ten, lampA2, '12:01:00'));
  const down = after(house(), ...presses('down', 45));
  assert.deepEqual(lamp(down, lampA2, '12:01:00'), lamp(after(house(), ...presses('down', 30)), lampA2, '12:01:00'));
});

test('a step restarts from zero under a newer overlay on the room', () => {
  // A dashboard control sets the room's level after three brighter presses; the next press starts from that level.
  // Break: the remote keeps counting from its old presses.
  const control: Msg = {
    kind: 'overlayRequested', at: at('12:05:00'),
    request: { kind: 'dashboard control', control: toDashboardControlId('control-x'), over: { kind: 'room', room: roomA },
      light: { power: 'on', brightness: { kind: 'fixed', brightness: toBrightness(150) }, colour: undefined, effect: undefined } },
  };
  const counted = after(house(), ...presses('up', 3), control, send('up', '12:06:00'));
  const fresh = after(house(), control, send('up', '12:06:00'));
  assert.equal(stepsOf(counted), 1);
  assert.deepEqual(lightingState(counted, at('12:07:00')).lamps, lightingState(fresh, at('12:07:00')).lamps);
});

test("a newer overlay on one lamp does not restart the room's steps", () => {
  // Today only an overlay over the whole room restarts them. Break: a person's change of one lamp restarts the count.
  const person: Msg = { kind: 'lampChangedByPerson', lamps: [lampA2], rooms: [], at: at('12:05:00'),
    light: { power: 'on', brightness: toBrightness(150), colour: undefined, effect: undefined } };
  const model = after(house(), ...presses('up', 3), person, send('up', '12:06:00'));
  assert.equal(stepsOf(model), 4);
  assert.deepEqual(lamp(model, lampA1, '12:07:00'), lamp(after(house(), ...presses('up', 3), send('up', '12:06:00')), lampA1, '12:07:00'));
});

test('a step after a fade start the next-block reset passed starts from zero', () => {
  // The noon presses were set before room-a's cosy fade (from 16:45), so the reset released them.
  // Break: the press carries on from the released overlay's count.
  const model = after(house(), ...presses('up', 3), send('up', '17:40:00'));
  assert.equal(stepsOf(model), 1);
  assert.deepEqual(lightingState(model, at('17:41:00')).lamps, lightingState(after(house(), send('up', '17:40:00')), at('17:41:00')).lamps);
});

test('a remote step does nothing on a lamp running the candle', () => {
  // Carry-over 3, `ignoresRemoteSteps`. Break: the step moves the candle lamp's level.
  const onCandle = after(house(), send('left', '12:00:00'));
  const stepped = after(onCandle, send('up', '12:01:00'));
  assert.deepEqual(lamp(stepped, lampA1, '12:02:00'), lamp(onCandle, lampA1, '12:02:00'));
  assert.ok(level(stepped, lampA2, '12:02:00') > 220);
});

// The presets.

test('right goes day, cosy, candle and round again', () => {
  // The candle keeps the cosy block it came from (carry-over 3, HeldBlock): light.lamp_a2, which cannot run it, stays cosy.
  // Break: the cycle skips a preset, runs the wrong way, or the candle drops its block.
  const one = after(house(), send('right', '12:00:00'));
  const two = after(one, send('right', '12:01:00'));
  const three = after(two, send('right', '12:02:00'));
  const four = after(three, send('right', '12:03:00'));
  assert.deepEqual([one, two, three, four].map(model => presetOf(model)?.choice), ['cosy', 'candle', 'day', 'cosy']);
  assert.deepEqual([lamp(one, lampA2, '12:00:30'), lamp(one, lampA1, '12:00:30')], [COSY, shows(100, WARM_END, candle)]);
  assert.deepEqual([lamp(two, lampA2, '12:01:30'), lamp(two, lampA1, '12:01:30')], [COSY, shows(100, WARM_END, candle)]);
  assert.deepEqual([lamp(three, lampA2, '12:02:30'), lamp(three, lampA1, '12:02:30')], [DAY, DAY]);
  assert.deepEqual(lamp(four, lampA2, '12:03:30'), COSY);
});

test('left from the day block goes to the candle over the schedule', () => {
  // From no preset the candle holds no block: it runs at the scheduled day light. Break: left goes to cosy, or the candle holds a block.
  const model = after(house(), send('left', '12:00:00'));
  const preset = presetOf(model);
  assert.deepEqual(preset?.choice === 'candle' ? [preset.since, preset.block] : preset, [at('12:00:00'), undefined]);
  assert.deepEqual([lamp(model, lampA1, '12:00:30'), lamp(model, lampA2, '12:00:30')], [shows(220, WARM_END, candle), DAY]);
});

test('with no preset, the arrows start from the block the room is in', () => {
  // Carried from r4-remote-plan.test.ts (a missing selection reads as the room's period). At 19:00 room-a is in cosy.
  // Break: the arrows always start from day.
  assert.equal(presetOf(after(house(), send('right', '19:00:00')))?.choice, 'candle');
  assert.equal(presetOf(after(house(), send('right', '12:00:00')))?.choice, 'cosy');
});

test('returning to a preset restores what it held', () => {
  // Cosy chosen at 12:00, then night held over the room at 12:10. Coming back to cosy at 12:30 restores cosy as chosen
  // at 12:00, which the newer night hold still wins over. Break: the return starts cosy afresh, which would win.
  const model = after(house(), send('right', '12:00:00'), holdBlock('night', '12:10:00'), send('right', '12:20:00'), send('left', '12:30:00'));
  assert.deepEqual(presetOf(model), { choice: 'cosy', since: at('12:00:00') });
  assert.deepEqual([lamp(model, lampA1, '12:31:00'), lamp(model, lampA2, '12:31:00')], [OFF, OFF]);
});

// Power, reset, mode.

test('the power toggle switches a lit room off and back on', () => {
  // Carry-over 4: the toggle switches the room's power, as today. Break: the second toggle does not read the saved power.
  const off = after(house(), send('toggle', '12:00:00'));
  assert.deepEqual([lamp(off, lampA1, '12:00:30'), lamp(off, lampA2, '12:00:30'), lamp(off, lampB1, '12:00:30')], [OFF, OFF, DAY]);
  const on = after(off, send('toggle', '12:01:00'));
  assert.deepEqual([lamp(on, lampA1, '12:01:30'), lamp(on, lampA2, '12:01:30')], [DAY, DAY]);
});

test('in a dark room the power toggle switches the room on', () => {
  // With no saved power the toggle goes against whether anything in the room reports on: at night nothing does, so it
  // switches the room on, and a day held afterwards shows. Break: the toggle always switches off first.
  const model = after(house(), send('toggle', '23:00:00', remoteA, false), holdBlock('day', '23:05:00'));
  assert.equal(model.overlays.roomPower[roomA], 'on');
  assert.deepEqual(lamp(model, lampA2, '23:06:00'), DAY);
});

test('a room switched off at the wall is switched on by the toggle, though its schedule is lit', () => {
  // Today the toggle reads what Home Assistant reports, not the light the room is meant to show: at noon the schedule is
  // lit, but the lamps report off, so the press and the single power press both switch the room on.
  // Break: the toggle goes against the lighting state, or a burst forgets what its press reported.
  const sent = after(house(), send('toggle', '12:00:00', remoteA, false));
  const burst = after(house(), power('12:00:00', remoteA, false), clock('12:00:00.600'));
  for (const model of [sent, burst]) {
    assert.equal(model.overlays.roomPower[roomA], 'on');
    assert.deepEqual([lamp(model, lampA1, '12:00:30'), lamp(model, lampA2, '12:00:30')], [DAY, DAY]);
  }
});

test('reset returns the room to the schedule', () => {
  // Break: the room's block hold or the remote's overlay survives the reset.
  const model = after(house(), holdBlock('cosy', '11:00:00'), send('up', '12:00:00'), send('reset', '12:05:00'));
  assert.deepEqual([lamp(model, lampA1, '12:06:00'), lamp(model, lampA2, '12:06:00')], [DAY, DAY]);
  assert.deepEqual([model.overlays.blocks, model.overlays.remotes], [{}, []]);
});

test('the mode press toggles the mode overlay', () => {
  // Break: the press sets the overlay without toggling it, or toggles it twice.
  const on = after(house(), send('mode', '12:00:00'));
  assert.deepEqual(lamp(on, lampA2, '12:00:30'), shows(220, MODE_COLOUR));
  assert.deepEqual(lamp(after(on, send('mode', '12:01:00')), lampA2, '12:01:30'), DAY);
});

test('a remote with no room changes nothing', () => {
  // Review Focus 4: remote-b is in no room. Break: its presses act on some room, or leave gesture state behind.
  const model = house();
  const pressed = after(model, power('12:00:00', remoteB), press({ kind: 'arrow', direction: 'up' }, '12:00:01', remoteB),
    send('toggle', '12:00:02', remoteB), send('mode', '12:00:03', remoteB), send('right', '12:00:04', remoteB), clock('12:01:00'));
  assert.deepEqual(pressed, model);
  assert.deepEqual(lightingState(pressed, at('12:01:00')), lightingState(model, at('12:01:00')));
});

test('an unknown press changes nothing', () => {
  // A preset button naming a temperature outside the table is no command, and a remote the config does not hold presses
  // nothing. Break: the press is read as some command.
  const model = house();
  const pressed = after(model, dial(undefined, '12:00:00'), send('up', '12:00:01', toRemoteId('remote-z')),
    power('12:00:02', toRemoteId('remote-z')), clock('12:01:00'));
  assert.deepEqual(pressed, model);
  assert.deepEqual(lightingState(pressed, at('12:01:00')), lightingState(model, at('12:01:00')));
});

// The gestures: power bursts, the chord and the preset dial.

test("one power press toggles the room when its window closes on the clock", () => {
  // Carried from gestures-reducer.test.ts (power_done completes a single click as a toggle). Break: the toggle goes out at
  // once, or never.
  const pressed = after(house(), power('12:00:00'));
  assert.deepEqual(lamp(pressed, lampA2, '12:00:00.300'), DAY);
  assert.deepEqual(lamp(after(pressed, clock('12:00:00.600')), lampA2, '12:00:01'), OFF);
});

test('two power presses toggle nothing', () => {
  // Break: the burst of two is read as one or three.
  const model = after(house(), power('12:00:00'), power('12:00:00.300'), clock('12:00:00.900'), clock('12:00:05'));
  assert.deepEqual([lamp(model, lampA2, '12:00:05'), model.overlays.roomPower], [DAY, {}]);
});

test('three power presses reset the room', () => {
  // Break: three presses toggle, or a fourth starts a new burst.
  const model = after(house(), holdBlock('cosy', '11:00:00'), power('12:00:00'), power('12:00:00.300'), power('12:00:00.500'),
    clock('12:00:01.100'));
  assert.deepEqual([lamp(model, lampA2, '12:00:02'), model.overlays.blocks], [DAY, {}]);
});

test('a power press after the window closed first completes the old burst', () => {
  // Carried from gestures-reducer.test.ts: no clock ran between the presses, so the second press completes the first
  // (a toggle), then starts its own burst. Break: the two presses are counted as one burst.
  const second = after(house(), power('12:00:00'), power('12:00:01'));
  assert.deepEqual(lamp(second, lampA2, '12:00:01'), OFF);
  assert.deepEqual(lamp(after(second, clock('12:00:01.600')), lampA2, '12:00:02'), DAY);
});

test('power, power, left, right, left, right toggles the mode overlay', () => {
  // Carried from gestures-reducer.test.ts (the fourth chord step sends sara_toggle). The arrows inside the chord move no
  // preset. Break: a chord step is sent as an arrow, or the chord never completes.
  const model = after(house(), power('12:00:00'), power('12:00:00.300'), clock('12:00:00.900'),
    arrow('left', '12:00:01'), arrow('right', '12:00:01.500'), arrow('left', '12:00:02'), arrow('right', '12:00:02.500'));
  assert.equal(model.modeOverlay.active, true);
  assert.equal(presetOf(model), undefined);
  assert.deepEqual(lamp(model, lampA2, '12:00:03'), shows(220, MODE_COLOUR));
});

test('a chord that is not finished in time is dropped on the clock', () => {
  // Each step has three seconds. Break: the chord lives on past its window, so the late arrows complete it.
  const begun = after(house(), power('12:00:00'), power('12:00:00.300'), clock('12:00:00.900'), arrow('left', '12:00:01'));
  const dropped = after(begun, clock('12:00:04'));
  assert.deepEqual(dropped.remotes[remoteA]?.chord, { active: false });
  const late = after(dropped, arrow('right', '12:00:05'), arrow('left', '12:00:05.500'), arrow('right', '12:00:06'));
  assert.equal(late.modeOverlay.active, false);
  assert.deepEqual(lamp(late, lampA2, '12:00:07'), COSY);
});

test('a press that breaks the chord ends it and acts as itself', () => {
  // Break: the wrong press is swallowed by the chord, or the chord survives it.
  const model = after(house(), power('12:00:00'), power('12:00:00.300'), clock('12:00:00.900'), arrow('up', '12:00:01'));
  assert.deepEqual(model.remotes[remoteA]?.chord, { active: false });
  assert.ok(level(model, lampA2, '12:00:02') > 220);
});

test('the preset buttons turn like a dial: the next one is right, the one before is left', () => {
  // Carried from gestures-reducer.test.ts (a canonical preset step to the right navigates right) and r4-gestures.test.ts.
  // Break: the dial's direction is read from the button alone, or a jump of two buttons moves a preset.
  const model = after(house(), dial('coolest', '12:00:00'), dial('cool', '12:00:01'), dial('coolest', '12:00:02'));
  assert.equal(presetOf(model)?.choice, 'cosy');
  const jumped = after(model, dial('warm', '12:00:03'));
  assert.equal(presetOf(jumped)?.choice, 'cosy');
  assert.deepEqual(lamp(jumped, lampA2, '12:00:04'), COSY);
});

test('after a power press the coolest button goes right, the warmest left, and another nowhere', () => {
  // The power press forgets the dial's position. Break: the first button after power is read against the old position.
  const quiet = after(house(), dial('neutral', '11:59:00'), power('12:00:00'), power('12:00:00.300'), clock('12:00:00.900'),
    clock('12:00:04'));
  assert.equal(presetOf(after(quiet, dial('coolest', '12:00:05')))?.choice, 'cosy');
  assert.equal(presetOf(after(quiet, dial('warmest', '12:00:05')))?.choice, 'candle');
  assert.equal(presetOf(after(quiet, dial('cool', '12:00:05'))), undefined);
});

test('the same preset button twice moves once', () => {
  // Break: a repeated button moves the preset again.
  const model = after(house(), dial('coolest', '12:00:00'), dial('coolest', '12:00:01'));
  assert.equal(presetOf(model)?.choice, 'cosy');
});

test('a chord or power burst deadline is when the model next changes', () => {
  // `nextChange` includes both windows, so the clock is there to close them. Break: a window waits for the next minute.
  const pressed = after(house(), power('12:00:00'));
  assert.equal(nextChange(pressed, at('12:00:00')), at('12:00:00.600'));
  const chord = after(pressed, power('12:00:00.300'), clock('12:00:00.900'));
  assert.equal(nextChange(chord, at('12:00:00.900')), at('12:00:03.300'));
  assert.equal(CHORD_WINDOW, 3);
  assert.equal(POWER_COMBO_WINDOW, 0.6);
});

// Two remotes in one room (carry-over 2).

test("a second remote in the room carries on from the first one's steps", () => {
  // Today the room's newest remote input is the one a press starts from, whichever remote saved it.
  // Break: each remote counts on its own overlay, so the room jumps back when the other remote is pressed.
  const two = (model: Model) => { model.config.remotes[remoteC] = { room: roomA }; model.remotes[remoteC] = IDLE_REMOTE; };
  const model = after(house(two), send('up', '12:00:00'), send('up', '12:00:01'), send('up', '12:00:02', remoteC));
  assert.deepEqual([stepsOf(model), stepsOf(model, remoteC)], [2, 3]);
  assert.deepEqual(lightingState(model, at('12:01:00')).lamps, lightingState(after(house(), ...presses('up', 3)), at('12:01:00')).lamps);
});

test('two remotes in one room count their power presses apart', () => {
  // Each remote's gesture state is its own (today each room's gesture script is wired to one remote).
  // Break: the second remote's press joins the first one's burst, which then toggles nothing.
  const two = (model: Model) => { model.config.remotes[remoteC] = { room: roomA }; model.remotes[remoteC] = IDLE_REMOTE; };
  const first = after(house(two), power('12:00:00'), power('12:00:00.300', remoteC), clock('12:00:00.600'));
  assert.deepEqual(lamp(first, lampA2, '12:00:00.700'), OFF);
  assert.deepEqual(lamp(after(first, clock('12:00:00.900')), lampA2, '12:00:01'), DAY);
});

test('the step range a remote keeps is the one its overlay saved', () => {
  // Break: a press resets a narrowed range to the default.
  const narrow = house(model => {
    model.overlays.remotes = [{ remote: remoteA, room: roomA, since: at('11:00:00'), stepRange: { min: toStep(-2), max: toStep(2) },
      adjustment: undefined, preset: { choice: 'none' }, remembered: {} }];
  });
  const model = after(narrow, send('up', '12:00:00'));
  assert.deepEqual(model.overlays.remotes[0]?.stepRange, { min: toStep(-2), max: toStep(2) });
  assert.deepEqual(lamp(model, lampA2, '12:00:30'), lamp(after(narrow, send('up', '12:00:00'), send('up', '12:00:01'), send('up', '12:00:02')),
    lampA2, '12:00:30'));
});
