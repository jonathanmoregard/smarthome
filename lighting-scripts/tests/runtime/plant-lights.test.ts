import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../../src/domain/config.ts';
import {
  NO_PLANT_OVERRIDES, plantChanges, plantLightSwitched, plantOverridesReleased, plantPower, plantsAllOffSet,
} from '../../src/domain/plant-lights.ts';
import type { PlantOverrides } from '../../src/domain/plant-lights.ts';
import type { SwitchId } from '../../src/domain/types/ids.ts';
import type { Power } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toInstant, toMinutes, toPlantHours, toRoomId, toSwitchId, toTimeOfDay } from '../../src/adapter/codecs/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * Plant lights: each is on from its room's day start for its hours, and a hand
 * switch or the all-off hold keeps it as set until its next day start. Only
 * `dayStarts` is shared with the schedule.
 *
 * The synthetic house in UTC from Monday 2026-09-21: the day starts at 07:00
 * (09:00 at the weekend; the 26th is a Saturday). Plant hours are 12. `plantA`
 * is in `room-a`, `plantHouse` in no room, both following the house's hours.
 */

const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const roomA = toRoomId('room-a');
const plantA = toSwitchId('switch.plant_a'), plantHouse = toSwitchId('switch.plant_house'), plugA = toSwitchId('switch.plug_a');

type Sources = { config: Config; plantOverrides: PlantOverrides };

function sources(change: (s: Sources) => void = () => {}): Sources {
  const config = structuredClone(syntheticHouse().config);
  config.plantHours = toPlantHours(12);
  config.switches[plantA] = { kind: 'plant light', room: roomA, hours: { follows: 'house' } };
  config.switches[plantHouse] = { kind: 'plant light', room: undefined, hours: { follows: 'house' } };
  const s: Sources = { config, plantOverrides: structuredClone(NO_PLANT_OVERRIDES) };
  change(s);
  return s;
}

const ownDayAt0830 = (s: Sources): void => {
  const room = s.config.rooms[roomA];
  if (room === undefined) throw new Error('the synthetic house has room-a');
  s.config.rooms[roomA] = { ...room, blocks: { ...room.blocks, day: { ...room.blocks.day,
    timing: { follows: 'own', own: { weekdayStart: toTimeOfDay(8, 30), weekendStart: toTimeOfDay(8, 30), fade: toMinutes(20) } } } } };
};
const noDayStarts = (s: Sources): void => {
  s.config.house.day.weekdayStart = undefined;
  s.config.house.day.weekendStart = undefined;
};

const power = (s: Sources, now: Instant, id: SwitchId = plantA): Power | undefined => plantPower(s, now)[id];
const config = sources().config;
const noPlants = sources(s => { delete s.config.switches[plantA]; delete s.config.switches[plantHouse]; }).config;

test('a plant light is on from the day start for its hours', () => {
  // Break: the timer starts at the fade, or the end is off by one.
  const s = sources();
  assert.equal(power(s, at('06:59:59')), 'off');
  assert.equal(power(s, at('07:00:00')), 'on');
  assert.equal(power(s, at('18:59:59')), 'on');
  assert.equal(power(s, at('19:00:00')), 'off');
});
test('the day block\'s fade does not switch it', () => {
  // Break: the timer reads the fade start.
  assert.equal(power(sources(), at('06:40:00')), 'off');
});
test('a weekend day starts at the weekend time', () => {
  // Break: the weekday start is read at the weekend.
  const s = sources();
  assert.equal(power(s, at('08:59:59', 26)), 'off');
  assert.equal(power(s, at('09:00:00', 26)), 'on');
  assert.equal(power(s, at('21:00:00', 26)), 'off');
});
test('a plant light follows its room\'s own day timing, one in no room the house\'s', () => {
  // Break: every plant light reads the house's day start, or the room's.
  const s = sources(ownDayAt0830);
  assert.equal(power(s, at('07:30:00')), 'off');
  assert.equal(power(s, at('08:30:00')), 'on');
  assert.equal(power(s, at('07:30:00'), plantHouse), 'on');
});
test('0 hours is off all the time and 24 hours on all the time', () => {
  // Break: 24 hours ends at the next day start's fade, or 0 hours is on for an instant.
  const none = sources(s => { s.config.plantHours = toPlantHours(0); });
  assert.equal(power(none, at('07:00:00')), 'off');
  const all = sources(s => { s.config.plantHours = toPlantHours(24); });
  assert.equal(power(all, at('06:59:59')), 'on');
  assert.equal(power(all, at('07:00:00')), 'on');
});
test('own hours win over the default, and the default moves the rest', () => {
  // Break: the default hours override a plug's own, or a plug without its own keeps the old default.
  const s = sources(s => { s.config.switches[plantA] = { kind: 'plant light', room: roomA, hours: { follows: 'own', own: toPlantHours(4) } }; });
  assert.equal(power(s, at('10:59:59')), 'on');
  assert.equal(power(s, at('11:00:00')), 'off');
  assert.equal(power(s, at('11:00:00'), plantHouse), 'on');
  s.config.plantHours = toPlantHours(6);
  assert.equal(power(s, at('13:00:00'), plantHouse), 'off');
  assert.equal(power(s, at('10:59:59')), 'on');
});
test('a hand switch holds until the next day start', () => {
  // Break: a hand switch holds past the day start, or releases before it.
  const off = sources(s => { s.plantOverrides.handSwitches[plantA] = { power: 'off', since: at('10:00:00') }; });
  assert.equal(power(off, at('12:00:00')), 'off');
  assert.equal(power(off, at('06:59:59', 22)), 'off');
  assert.equal(power(off, at('07:00:00', 22)), 'on');
  const on = sources(s => { s.plantOverrides.handSwitches[plantA] = { power: 'on', since: at('20:00:00') }; });
  assert.equal(power(on, at('23:00:00')), 'on');
  assert.equal(power(on, at('19:00:00', 22)), 'off');
});
test('all off holds every plant light off until its next day start', () => {
  // Break: all off skips the house's plant lights, or never lets go.
  const s = sources(s => { s.plantOverrides.allOff = { since: at('10:00:00') }; });
  assert.equal(power(s, at('12:00:00')), 'off');
  assert.equal(power(s, at('12:00:00'), plantHouse), 'off');
  assert.equal(power(s, at('07:00:00', 22)), 'on');
});
test('of a hand switch and all off, the newer wins', () => {
  // Break: all off always wins, or the hand switch always does.
  const s = sources(s => { s.plantOverrides = { allOff: { since: at('10:00:00') }, handSwitches: { [plantA]: { power: 'on', since: at('11:00:00') } } }; });
  assert.equal(power(s, at('12:00:00')), 'on');
  assert.equal(power(s, at('12:00:00'), plantHouse), 'off');
  s.plantOverrides.handSwitches[plantA] = { power: 'on', since: at('09:00:00') };
  assert.equal(power(s, at('12:00:00')), 'off');
});
test('rooms with different day starts are released from all off each at its own', () => {
  // Break: all off is released at the house's day start for every room, or only at the last one's.
  const s = sources(s => { ownDayAt0830(s); s.plantOverrides.allOff = { since: at('10:00:00') }; });
  assert.equal(power(s, at('07:30:00', 22), plantHouse), 'on');
  assert.equal(power(s, at('07:30:00', 22)), 'off');
  assert.notEqual(plantOverridesReleased(s.plantOverrides, s.config, at('07:30:00', 22)).allOff, undefined);
  assert.equal(plantOverridesReleased(s.plantOverrides, s.config, at('08:30:00', 22)).allOff, undefined);
});
test('the clock drops a hand switch at its day start, not before', () => {
  // Break: a hand switch is dropped early, or kept after its day start.
  const held = { handSwitches: { [plantA]: { power: 'off' as const, since: at('10:00:00') } }, allOff: undefined };
  assert.deepEqual(plantOverridesReleased(held, config, at('06:59:59', 22)), held);
  assert.deepEqual(plantOverridesReleased(held, config, at('07:00:00', 22)), NO_PLANT_OVERRIDES);
});
test('all off with no plant light in the house is released at once', () => {
  // Break: all off with nothing to hold stays saved.
  assert.equal(plantOverridesReleased({ handSwitches: {}, allOff: { since: at('10:00:00') } }, noPlants, at('10:00:01')).allOff, undefined);
});
test('switching all off on drops the hand switches; off keeps a newer one', () => {
  // Break: on keeps the older hand switches, or off drops the newer one.
  const hand = { handSwitches: { [plantA]: { power: 'on' as const, since: at('09:00:00') } }, allOff: undefined };
  const on = plantsAllOffSet(hand, { kind: 'plantsAllOffSet', on: true, at: at('10:00:00') });
  assert.deepEqual(on, { handSwitches: {}, allOff: { since: at('10:00:00') } });
  const pressed = plantLightSwitched(on, config, { kind: 'switchButtonPressed', switch: plantA, power: 'on', at: at('11:00:00') });
  assert.deepEqual(plantsAllOffSet(pressed, { kind: 'plantsAllOffSet', on: false, at: at('12:00:00') }),
    { handSwitches: { [plantA]: { power: 'on', since: at('11:00:00') } }, allOff: undefined });
});
test('a press on a lighting switch is no plant hand switch', () => {
  // Break: every press is stored as a plant hand switch.
  const press = { kind: 'switchButtonPressed', switch: plugA, power: 'off', at: at('12:00:00') } as const;
  assert.deepEqual(plantLightSwitched(NO_PLANT_OVERRIDES, config, press), NO_PLANT_OVERRIDES);
});
test('plant power has an entry for each plant light and no other switch', () => {
  // Break: the plug's lighting switch is given a plant power.
  assert.deepEqual(Object.keys(plantPower(sources(), at('12:00:00'))).sort(), [plantA, plantHouse].sort());
});
test('the next changes are the switch-off and the next day start', () => {
  // Break: the switch-off or the next day start is left out.
  const times = plantChanges(config, at('12:00:00'));
  assert.ok(times.includes(at('19:00:00')) && times.includes(at('07:00:00', 22)));
});
test('with no day start in reach a plant light is off unless its hours are 24, and an override still applies', () => {
  // Break: no day start is read as the epoch, so the timer runs from it.
  const s = sources(noDayStarts);
  assert.equal(power(s, at('12:00:00')), 'off');
  s.config.plantHours = toPlantHours(24);
  assert.equal(power(s, at('12:00:00')), 'on');
  s.plantOverrides.handSwitches[plantA] = { power: 'off', since: at('10:00:00', 19) };
  assert.equal(power(s, at('12:00:00')), 'off');
});
