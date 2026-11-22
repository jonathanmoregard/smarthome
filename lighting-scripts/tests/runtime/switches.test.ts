import assert from 'node:assert/strict';
import test from 'node:test';
import { lightingState } from '../../src/domain/lighting-state.ts';
import type { Model } from '../../src/domain/model.ts';
import type { SwitchId } from '../../src/domain/types/ids.ts';
import type { Power } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toBrightness, toInstant, toMinutes, toPercentRange, toRoomId, toSwitchId } from '../../src/parse/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * Whether each switch is on (`switchPower`, through the lighting state): a
 * switch overlay that still applies, else the switch's range rule against its
 * room's level, else its block's on/off setting. Moved from `switchPlan` in
 * `src/legacy/domain/controller.ts` and the switch half of `scheduledBase`.
 *
 * The synthetic house without its overlays, in UTC on Monday 2026-09-21:
 * `switch.plug_a` in `room-a` is on from 20 % to 60 % of the room's level.
 * `room-a` shows 220 (86 %) in the day and 90 (35 %) in its cosy from 17:30
 * (fade from 16:45). Switches are on in day and cosy, off at night (22:30,
 * fade from 22:00). The next-block reset is on.
 *
 * Carried from `r4-switch-plan.test.ts` and `ranges.test.ts`: the rule's
 * range read against the room's level, both ends included, and the bright and
 * cosy rules reading the house's range defaults. Their boolean bounds and
 * non-text profiles are the codec's to read (M1 Task 7), so they are not here.
 */

const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const plugA = toSwitchId('switch.plug_a'), roomA = toRoomId('room-a');

function house(change: (model: Model) => void = () => {}): Model {
  const model = structuredClone(syntheticHouse());
  model.overlays = { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} };
  model.modeOverlay = { active: false };
  change(model);
  return model;
}

function power(model: Model, now: Instant, id: SwitchId = plugA): Power | undefined {
  return lightingState(model, now).switches[id];
}

const roomLevel = (brightness: number) => (m: Model) => {
  m.overlays.lamps = [{ over: { kind: 'room', room: roomA }, from: { kind: 'person' }, since: at('11:00:00'),
    brightness: { kind: 'fixed', brightness: toBrightness(brightness), at: at('11:00:00') }, colour: undefined, effect: undefined }];
};

test('a switch with a range rule is on while its room\'s level is inside the range', () => {
  // Break: the rule reads a lamp's level or the house's instead of the room's, or the comparison is the wrong way.
  const model = house();
  assert.equal(power(model, at('12:00:00')), 'off');
  assert.equal(power(model, at('20:00:00')), 'on');
});

test('both ends of the range are inside it', () => {
  // 51 is 20 % and 153 is 60 % of 255. Break: either end is left out of the range.
  assert.equal(power(house(roomLevel(51)), at('12:00:00')), 'on');
  assert.equal(power(house(roomLevel(153)), at('12:00:00')), 'on');
  assert.equal(power(house(roomLevel(154)), at('12:00:00')), 'off');
  assert.equal(power(house(roomLevel(50)), at('12:00:00')), 'off');
});

test('the bright and cosy rules read the house\'s range defaults', () => {
  // Break: a default rule keeps a range of its own, or reads the other default.
  const bright = house(m => { m.switchRanges[plugA] = { kind: 'bright' }; });
  assert.equal(power(bright, at('12:00:00')), 'off');
  bright.rangeDefaults.bright = toPercentRange(80, 100);
  assert.equal(power(bright, at('12:00:00')), 'on');
  const cosy = house(m => { m.switchRanges[plugA] = { kind: 'cosy' }; });
  assert.equal(power(cosy, at('20:00:00')), 'on');
  assert.equal(power(cosy, at('12:00:00')), 'off');
});

test('a switch in a room that is off is off', () => {
  // Break: the rule reads the room's level while the room is switched off.
  assert.equal(power(house(m => { m.overlays.roomPower[roomA] = 'off'; }), at('20:00:00')), 'off');
});

test('a switch with no rule follows its block\'s on/off setting', () => {
  // Review Focus 4. Break: a switch with no rule is left out, or reads another block's setting.
  const model = house(m => { delete m.switchRanges[plugA]; });
  assert.equal(power(model, at('12:00:00')), 'on');
  assert.equal(power(model, at('23:30:00')), 'off');
});

test('while its room\'s fade is moving a switch with no rule is left as it is', () => {
  // Today a moving stage sends a plug nothing (legacy `schedule.ts`, the plug branch). Break: the switch is set
  // to the block it leaves, or to the block it fades into, before the fade is over.
  const model = house(m => { delete m.switchRanges[plugA]; });
  assert.equal(power(model, at('21:55:00')), 'on');
  assert.equal(power(model, at('22:15:00')), undefined);
  assert.equal(power(model, at('22:45:00')), 'off');
});

test('while its room\'s wake fade is moving a switch with no rule is left as it is', () => {
  // `room-a` wakes at 06:00 on Tuesday over 30 minutes. Break: the wake fade sets the switch from the night block.
  const model = house(m => { delete m.switchRanges[plugA]; m.config.rooms[roomA]!.wakeLight = { at: at('06:00:00', 22), fade: toMinutes(30) }; });
  assert.equal(power(model, at('05:30:00', 22)), 'off');
  assert.equal(power(model, at('06:15:00', 22)), undefined);
});

test('a range rule keeps reading its room\'s level through a fade', () => {
  // `room-a` fades from 220 to 90 between 16:45 and 17:30: 69 % at 17:00, 47 % at 17:20. Break: a moving stage
  // leaves a ranged switch alone too, which today's range rule does not.
  const model = house();
  assert.equal(power(model, at('17:00:00')), 'off');
  assert.equal(power(model, at('17:20:00')), 'on');
});

test('a switch overlay holds the switch through a fade', () => {
  // Break: a moving stage leaves a switch the plug's own button set alone.
  const model = house(m => { delete m.switchRanges[plugA]; m.overlays.switches[plugA] = { power: 'off', since: at('22:10:00') }; });
  assert.equal(power(model, at('22:15:00')), 'off');
});

test('a switch with no rule and no on/off setting is left as it is', () => {
  // Break: a block with no setting is read as off (or on), so the switch is switched where nothing says.
  const model = house(m => { delete m.switchRanges[plugA]; m.config.house.day.switchesOn = undefined; });
  assert.equal(power(model, at('12:00:00')), undefined);
});

test('a switch in no room follows the house\'s on/off setting, whatever its rule', () => {
  // A rule needs a room to read. Break: a switch in no room is left out, or its rule reads some room.
  const plugC = toSwitchId('switch.plug_c');
  const model = house(m => { m.config.switches[plugC] = { room: undefined, onOff: true }; m.switchRanges[plugC] = { kind: 'cosy' }; });
  assert.equal(power(model, at('12:00:00'), plugC), 'on');
  assert.equal(power(model, at('23:30:00'), plugC), 'off');
});

test('a held block decides a switch\'s on/off setting', () => {
  // Break: the switch follows the scheduled block under a block overlay.
  const model = house(m => { delete m.switchRanges[plugA]; m.overlays.blocks[roomA] = { block: 'night', since: at('11:00:00') }; });
  assert.equal(power(model, at('12:00:00')), 'off');
});

test('a switch overlay holds the switch against its range rule', () => {
  // Decision 8: the plug's own button. Break: the range rule takes the switch back.
  const model = house(m => { m.overlays.switches[plugA] = { power: 'on', since: at('11:00:00') }; });
  assert.equal(power(model, at('12:00:00')), 'on');
  model.overlays.switches[plugA] = { power: 'off', since: at('19:00:00') };
  assert.equal(power(model, at('20:00:00')), 'off');
});

test('with the next-block rule on, a switch overlay set before the last fade start no longer applies', () => {
  // `room-a`'s cosy fade starts at 16:45. Break: the switch overlay outlives the fade start, or ends with the rule off.
  const model = house(m => { m.overlays.switches[plugA] = { power: 'off', since: at('12:00:00') }; });
  assert.equal(power(model, at('16:00:00')), 'off');
  assert.equal(power(model, at('20:00:00')), 'on');
  model.config.overlayReset.atNextBlock = false;
  assert.equal(power(model, at('20:00:00')), 'off');
});

/** A switch with a saved range rule that no on/off label names, in the room given. */
const ranged = toSwitchId('switch.ranged');
const rangeOnly = (room: typeof roomA | undefined) => (m: Model) => {
  delete m.switchRanges[plugA];
  m.config.switches[ranged] = { room, onOff: false };
  m.switchRanges[ranged] = { kind: 'custom', range: toPercentRange(20, 60) };
};

test('a range-only switch follows its range rule against its room\'s level', () => {
  // Break: only on/off-labelled switches are driven, or the rule of a range-only switch is not read.
  const model = house(rangeOnly(roomA));
  assert.equal(power(model, at('12:00:00'), ranged), 'off');
  assert.equal(power(model, at('20:00:00'), ranged), 'on');
});

test('a range-only switch whose rule decodes to nothing is sent nothing', () => {
  // The block's on/off setting is for on/off-labelled switches. Break: a range-only switch falls through to it.
  const model = house(m => { rangeOnly(roomA)(m); delete m.switchRanges[ranged]; });
  assert.equal(power(model, at('12:00:00'), ranged), undefined);
  assert.equal(power(model, at('23:30:00'), ranged), undefined);
});

test('a range-only switch in no room is sent nothing', () => {
  // A rule needs a room's level. Break: it follows the house's on/off setting, or reads some room.
  const model = house(rangeOnly(undefined));
  assert.equal(power(model, at('12:00:00'), ranged), undefined);
  assert.equal(power(model, at('20:00:00'), ranged), undefined);
});

test('a range-only switch still obeys its own button', () => {
  // Break: the overlay is read for on/off-labelled switches only.
  const model = house(m => { rangeOnly(roomA)(m); m.overlays.switches[ranged] = { power: 'on', since: at('11:00:00') }; });
  assert.equal(power(model, at('12:00:00'), ranged), 'on');
});
