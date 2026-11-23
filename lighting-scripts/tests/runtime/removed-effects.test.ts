import assert from 'node:assert/strict';
import test from 'node:test';
import { uiChoices } from '../../src/legacy/domain/ui-state.ts';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ScriptHandlers } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';

/**
 * Breathe and Colour loop are gone (spec 1.1.1). The lamps run Candle and
 * their normal light; a saved profile that still names one of the removed
 * effects shows the normal light instead of failing (the codec tests).
 */

const now = '2026-10-26T12:00:00.000Z';
const catalogDocument: JsonObject = {
  effects: { Candle: { channels: ['brightness', 'color'] }, Breathe: { channels: ['brightness'] }, 'Colour loop': { channels: ['color'] },
    'Normal light': { channels: [] } },
  members: { 'light.lamp': ['light.bulb', 'light.second', 'light.off'] },
  topics: { 'light.bulb': 'z2m/bulb/set', 'light.second': 'z2m/second/set', 'light.off': 'z2m/off/set' }, multicast: [],
};
test('the catalog parse drops Breathe and Colour loop, from the effects and from the UI choices', () => {
  const parsed = parseCatalog({ ...catalogDocument, ui_choices: ['Candle', 'Breathe', 'Colour loop', 'Normal light'] });
  assert.deepEqual(Object.keys(parsed.effects), ['Candle', 'Normal light']);
  assert.deepEqual(parsed.ui_choices, ['Candle', 'Normal light']);
});

test('the dashboard and the remote offer no removed effect', () => {
  const listed = ['Candle', 'Breathe', 'Colour loop', 'Normal light'];
  const dashboard = uiChoices(house({}, { catalogDocument: { ui_choices: listed } }));
  assert.deepEqual(dashboard, ['Candle', 'Normal light']);

  const roomPlan: ScriptHandlers = { ls_room_plan: () => ({ plan: { resolved: { targets: { 'room:studio': { period: 'cosy' } } } } }) };
  const next = (selection: string, command: string) => {
    const overrides = { 'channels:remote': { kind: 'input', scope: 'room', target: 'studio', when: now,
      value: { selection, adjustment: { updated: 0, lower: 0, upper: 0, steps: 0 } } } };
    const { result } = execute({ script: 'ls_remote_plan', args: { source: 'remote', area: 'studio', command },
      snapshot: { now, members: ['light.lamp'], areas: { 'light.lamp': 'studio' },
        catalog: { members: { 'light.lamp': ['light.bulb'] }, topics: {}, multicast: [], effects: catalogDocument.effects },
        state: { 'sensor.ls_overrides': { state: '0', last_updated: now, attributes: { overrides } },
          'light.lamp': { state: 'off', attributes: {} } } } }, { ...handlers, ...roomPlan });
    return (((result as JsonObject).records as JsonObject[])[0]!.value as JsonObject).selection;
  };
  assert.equal(next('cosy', 'right'), 'Candle');
  assert.equal(next('Candle', 'right'), 'day', 'past Candle the choices wrap; Breathe and Colour loop are not on the way');
  assert.equal(next('day', 'left'), 'Candle');
});
