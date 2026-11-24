import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardView } from '../../src/domain/dashboard.ts';
import type { DashboardControl } from '../../src/domain/dashboard.ts';
import { lightingState } from '../../src/domain/lighting-state.ts';
import { IDLE_REMOTE } from '../../src/domain/remote.ts';
import { update } from '../../src/domain/update.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toDashboardControlId, toInstant, toKelvin, toLampId, toLevel, toRemoteId, toRoomId } from '../../src/adapter/codecs/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';
import type { Model, Msg } from '../../src/domain/update.ts';

/**
 * The dashboard view (M3 Task 3): what the dashboard shows of the Model, the
 * block selectors, the mode switch and the live controls. The synthetic house
 * as in update-overlays.test.ts: day from 07:00, 220 at 4000 K; `room-a`'s own
 * cosy from 17:30; `room-b` is private.
 */

const at = (time: string): Instant => toInstant(Date.parse(`2026-09-21T${time}Z`) / 1000);
const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const lampA1 = toLampId('light.lamp_a1');
const NOON = at('12:00:00');

function house(): Model {
  const model = structuredClone(syntheticHouse());
  model.overlays = { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} };
  model.modeOverlay = { active: false };
  model.remotes = { [toRemoteId('remote-a')]: IDLE_REMOTE, [toRemoteId('remote-b')]: IDLE_REMOTE };
  return model;
}

function view(model: Model, now: Instant) {
  return dashboardView(model, lightingState(model, now), now);
}

/** The house with these live controls in its config. */
function withControls(model: Model, controls: readonly DashboardControl[]): Model {
  return { ...model, config: { ...model.config, controls: Object.fromEntries(controls.map(({ control, over }) => [control, over])) } };
}

const send = (model: Model, ...msgs: Msg[]) => msgs.reduce(update, model);

test('the block shown follows a held block', () => {
  const before = view(house(), NOON);
  assert.equal(before.blockShown.house, 'day');
  assert.equal(before.blockShown[roomA], 'day');
  const held = send(house(), { kind: 'overlayRequested', request: { kind: 'hold block', over: roomA, block: 'night' }, at: NOON });
  const shown = view(held, NOON);
  assert.equal(shown.blockShown[roomA], 'night');
  assert.equal(shown.blockShown.house, 'day');
  assert.equal(shown.blockShown[roomB], 'day');
});

test('the mode mirror follows the mode overlay', () => {
  assert.equal(view(house(), NOON).modeOn, false);
  const on = send(house(), { kind: 'modeToggled', on: true, at: NOON });
  assert.equal(view(on, NOON).modeOn, true);
  assert.equal(view(send(on, { kind: 'modeToggled', on: false, at: NOON }), NOON).modeOn, false);
});

test("a control shows the light of what it is over, the config's controls in their order", () => {
  // Break: the view's controls come from anywhere but the config (the fourth argument it took before).
  const lamp = toDashboardControlId('control-lamp'), room = toDashboardControlId('control-room');
  const controls: DashboardControl[] = [{ control: lamp, over: { kind: 'lamp', lamp: lampA1 } }, { control: room, over: { kind: 'room', room: roomA } }];
  const shown = view(withControls(house(), controls), NOON).controls;
  const day = { power: 'on', level: toLevel(220), colour: { kind: 'kelvin', kelvin: toKelvin(4000) }, effect: 'Normal' };
  assert.deepEqual(shown, [{ control: lamp, over: controls[0]!.over, light: day }, { control: room, over: controls[1]!.over, light: day }]);
  const off = send(house(), { kind: 'overlayRequested', request: { kind: 'room power', room: roomA, power: 'off' }, at: NOON });
  assert.deepEqual(view(withControls(off, controls), NOON).controls.map(control => control.light), [{ power: 'off' }, { power: 'off' }]);
});
