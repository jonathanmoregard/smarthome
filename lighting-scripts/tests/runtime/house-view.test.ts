import assert from 'node:assert/strict';
import test from 'node:test';
import { switchPlan } from '../../src/legacy/domain/controller.ts';
import { scheduleDetails } from '../../src/legacy/domain/schedule.ts';
import { uiMessages } from '../../src/legacy/domain/ui-state.ts';
import { parseSwitchPlanArgs } from '../../src/parse/controller.ts';
import { house } from './house-view.ts';

test('switch planning reads only the areas map', () => {
  const plan = switchPlan({ 'switch.lamp': 'studio' }, parseSwitchPlanArgs({
    targets: { 'room:studio': { on: true, level: 255 } },
    ranges: { 'switch.lamp': { profile: 'custom', min: 0, max: 100 } },
    defaults: {},
  }));
  assert.deepEqual(plan, { 'switch.lamp': { on: true, room: 'studio', brightness: 100, range: [0, 100] } });
});

test('schedule details read the house through a plain view', () => {
  const at = Date.parse('2026-10-26T12:00:00+01:00') / 1000;
  const view = house({ 'input_datetime.ls_house_day_start': '07:00:00', 'input_datetime.ls_house_day_weekend': '08:00:00' });
  const details = scheduleDetails(view, 'house', at);
  assert.equal(details.cur, 'day');
});

test('the UI mirror is computed from a plain view', () => {
  const view = house({ 'light.a': ['on', { brightness: 100 }], 'light.p': 'unavailable' }, {
    catalogDocument: { ui_rows: [{ source: 'light.a', proxy: 'light.p', members: ['light.a'], topics: { availability: 't/avail', power: 't/power', effect: 't/fx', brightness: 't/b' } }] },
  });
  assert.deepEqual(uiMessages(view, false), [
    { topic: 't/avail', payload: 'online' },
    { topic: 't/power', payload: 'ON' },
    { topic: 't/fx', payload: 'Normal Light' },
    { topic: 't/b', payload: '100' },
  ]);
});
