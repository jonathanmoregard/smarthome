import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardView } from '../../src/domain/dashboard.ts';
import { lightingState } from '../../src/domain/lighting-state.ts';
import { NO_PLANT_OVERRIDES } from '../../src/domain/plant-lights.ts';
import { nextChange, update } from '../../src/domain/update.ts';
import type { Model } from '../../src/domain/update.ts';
import type { Power } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toInstant, toPercentRange, toRemoteId, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * Plant lights in the Model: a plant light's power comes from its timer and
 * its own overrides only (`plantPower`), whatever the lighting does, and the
 * lighting switch beside it is as before.
 *
 * The synthetic house without its overlays, in UTC on Monday 2026-09-21: the
 * day starts at 07:00, so `plantA` in `room-a` follows the timer on from then
 * until 19:00. `switch.plug_a` is the lighting switch beside it.
 */

const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const roomA = toRoomId('room-a'), remoteA = toRemoteId('remote-a');
const plantA = toSwitchId('switch.plant_a'), plugA = toSwitchId('switch.plug_a');
const noon = at('12:00:00');

function house(change: (model: Model) => void = () => {}): Model {
  const model = structuredClone(syntheticHouse());
  model.overlays = { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} };
  model.modeOverlay = { active: false };
  model.config.switches[plantA] = { kind: 'plant light', room: roomA, hours: { follows: 'house' } };
  model.plantOverrides = structuredClone(NO_PLANT_OVERRIDES);
  change(model);
  return model;
}

function power(model: Model, now: Instant): Power | undefined {
  return lightingState(model, now).switches[plantA];
}

test('room power leaves a plant light on', () => {
  // Break: plantPower reads room power, or switchPower covers the plant light.
  assert.equal(power(house(m => { m.overlays.roomPower[roomA] = 'off'; }), noon), 'on');
});

test('a remote\'s toggle and reset leave a plant light on', () => {
  const toggled = update(house(), { kind: 'remotePressed', remote: remoteA, command: 'toggle', anyOn: true, at: noon });
  assert.equal(power(toggled, noon), 'on');
  assert.equal(power(update(toggled, { kind: 'remotePressed', remote: remoteA, command: 'reset', anyOn: false, at: noon }), noon), 'on');
});

test('the mode overlay leaves a plant light on', () => {
  assert.equal(power(update(house(), { kind: 'modeToggled', on: true, at: noon }), noon), 'on');
});

test('a held night block leaves a plant light on', () => {
  const held = [roomA, 'house' as const].reduce((m, over) =>
    update(m, { kind: 'overlayRequested', request: { kind: 'hold block', over, block: 'night' }, at: noon }), house());
  assert.equal(power(held, noon), 'on');
});

test('a clear-all leaves a plant light and its hand switch as they are', () => {
  const pressed = update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: at('10:00:00') });
  const cleared = update(pressed, { kind: 'overlayRequested', request: { kind: 'clear all' }, at: noon });
  assert.equal(power(cleared, noon), 'off');
  assert.equal(power(update(house(), { kind: 'overlayRequested', request: { kind: 'clear all' }, at: noon }), noon), 'on');
});

test('the lighting\'s overlay resets leave a hand switch', () => {
  // The age limit is 180 min and room-a's cosy fade starts 16:45: a lighting overlay set at 10:00 would end by both; a hand switch does not.
  let model = update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: at('10:00:00') });
  for (const time of ['13:30:00', '17:00:00', '18:00:00']) model = update(model, { kind: 'clock', now: at(time) });
  assert.equal(power(model, at('18:00:00')), 'off');
  assert.equal(power(update(model, { kind: 'clock', now: at('07:00:00', 22) }), at('07:00:00', 22)), 'on');
});

test('a range rule and a lighting switch overlay stored for a plant light are ignored', () => {
  const model = house(m => {
    m.switchRanges[plantA] = { kind: 'custom', range: toPercentRange(0, 10) };
    m.overlays.switches[plantA] = { power: 'off', since: at('11:00:00') };
  });
  assert.equal(power(model, noon), 'on');
});

test('a press on a plant light is its hand switch, not a lighting overlay', () => {
  const model = update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: noon });
  assert.deepEqual(model.plantOverrides.handSwitches[plantA], { power: 'off', since: noon });
  assert.equal(model.overlays.switches[plantA], undefined);
});

test('all off set from the dashboard holds, shows on, and is dropped by the clock at the day start', () => {
  const set = update(house(), { kind: 'plantsAllOffSet', on: true, at: noon });
  assert.equal(power(set, at('13:00:00')), 'off');
  assert.equal(dashboardView(set, lightingState(set, noon), noon).plantsAllOff, true);
  const next = update(set, { kind: 'clock', now: at('07:00:00', 22) });
  assert.equal(next.plantOverrides.allOff, undefined);
  assert.equal(dashboardView(next, lightingState(next, at('07:00:00', 22)), at('07:00:00', 22)).plantsAllOff, false);
});

test('the plant light\'s switch-off is a next change', () => {
  // Break: nextChange leaves out plantChanges, so the clock sleeps past 19:00.
  assert.equal(nextChange(house(), at('18:30:00')), at('19:00:00'));
});

test('the lighting switch beside it is as before', () => {
  assert.equal(lightingState(house(), noon).switches[plugA], 'off');
  assert.equal(lightingState(house(), at('20:00:00')).switches[plugA], 'on');
});

test('the dashboard view carries each plant light\'s timer switch-off, whatever holds it', () => {
  // Break: the view leaves the times out, or an override moves them.
  const view = (model: Model) => dashboardView(model, lightingState(model, noon), noon).plantSwitchOff;
  assert.deepEqual(view(house()), { [plantA]: at('19:00:00') });
  const held = update(update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: noon }), { kind: 'plantsAllOffSet', on: true, at: noon });
  assert.deepEqual(view(held), { [plantA]: at('19:00:00') });
});
