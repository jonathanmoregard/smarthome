import assert from 'node:assert/strict';
import test from 'node:test';
import { stopCommands } from '../../src/domain/transport.ts';
import { uiChoices } from '../../src/domain/ui-state.ts';
import { parseAssignArgs, runtimeState } from '../../src/parse/transport.ts';
import { parseCatalog } from '../../src/runtime/catalog.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, ScriptHandlers, Snapshot } from '../../src/runtime/context.ts';
import { house } from './house-view.ts';

/**
 * Breathe and Colour loop are gone (spec 1.1.1). The lamps run Candle and
 * their normal light; a saved profile that still names one of the removed
 * effects shows the normal light instead of failing.
 */

const now = '2026-10-26T12:00:00.000Z';
const runtime = 'sensor.ls_effects_runtime';
const catalogDocument: JsonObject = {
  effects: { Candle: { channels: ['brightness', 'color'] }, Breathe: { channels: ['brightness'] }, 'Colour loop': { channels: ['color'] },
    'Normal light': { channels: [] } },
  members: { 'light.lamp': ['light.bulb', 'light.second', 'light.off'] },
  topics: { 'light.bulb': 'z2m/bulb/set', 'light.second': 'z2m/second/set', 'light.off': 'z2m/off/set' }, multicast: [],
};
const steady: JsonObject = { on: true, brightness: { kind: 'constant', value: 100 }, color: { kind: 'constant', value: { kelvin: 2500 } } };
const effect = (name: string): JsonObject => ({ kind: 'effect', effect: name, instance: `base:light.lamp:${name}`, intensity: 90, value: 80, updated: 1 });
const running = (name: string): JsonObject => ({ on: true, brightness: effect(name), color: effect(name) });

const snapshot: Snapshot = { now, members: ['light.lamp'], areas: { 'light.lamp': 'room' }, state: {
  'light.candle_test_rgb_warm_end': { state: 'on', attributes: { rgb_color: [255, 110, 4] } },
  'light.lamp': { state: 'on', attributes: {} }, 'light.bulb': { state: 'on', attributes: {} },
} };

test("a saved profile naming Breathe shows the lamp's normal light", () => {
  const target = { on: true, area: 'room', brightness: effect('Breathe'),
    color: { kind: 'constant', value: { kelvin: 2500 } } };
  const result = execute({ script: 'effects_frame_plan', snapshot,
    args: { targets: { 'light.lamp': target }, timestamp: 0,
      catalog: { ...catalogDocument, members: { 'light.lamp': ['light.bulb'] }, topics: { 'light.bulb': 'zigbee2mqtt/bulb/set' } } } }, handlers).result as JsonObject;
  assert.deepEqual((result.commands as JsonObject[]).map(command => command.payload),
    [{ brightness: 80, color_temp: 400, transition: 0.4 }]);
});

const stops = (previous: JsonObject, next: JsonObject, extra: Record<string, string> = {}) => {
  const view = house({ [runtime]: ['g0', { assignments: { 'light.lamp': previous }, targets: { 'light.lamp': previous } }],
    'light.bulb': 'on', 'light.second': 'on', 'light.off': 'off', ...extra });
  const parsed = parseAssignArgs({ targets: { 'light.lamp': next }, assignments: {}, invalidate: [], revision: now }).details();
  return stopCommands(view, parseCatalog(catalogDocument), parsed.targetViews(), runtimeState(view))
    .map(command => ({ topic: command.topic, effect: command.payload.effect }));
};

test('a lamp the runtime sensor says is running Colour loop is told to stop nothing', () => {
  assert.deepEqual(stops({ effect: 'Colour loop', ...running('Colour loop') }, steady), []);
  assert.deepEqual(stops({ effect: 'Breathe', ...running('Breathe') }, steady), []);
});

test('leaving Candle sends stop_effect once per on bulb, and no stop_colorloop', () => {
  assert.deepEqual(stops({ effect: 'Candle', ...running('Candle') }, steady), [
    { topic: 'z2m/bulb/set', effect: 'stop_effect' },
    { topic: 'z2m/second/set', effect: 'stop_effect' },
  ]);
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
