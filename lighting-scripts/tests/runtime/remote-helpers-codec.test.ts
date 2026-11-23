import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRemoteModel, remoteHelperEntity, remoteHelperWrites } from '../../src/adapter/codecs/remote-helpers.ts';
import { IDLE_REMOTE } from '../../src/domain/remote.ts';
import type { ConfigSource } from '../../src/adapter/codecs/config.ts';
import type { RemoteModel } from '../../src/domain/model.ts';
import type { EntityState, JsonObject } from '../../src/runtime/context.ts';
import { toInstant } from '../../src/parse/ids.ts';
import { parseRooms } from '../../src/parse/rooms.ts';
import { id } from './support/ids.ts';

/**
 * A remote's gesture state, read from the room's remote helpers the gesture
 * script reads (`gestureState`, `src/parse/gestures.ts`): `input_number`
 * chord step, power count and preset cursor, the `input_text` power token and
 * the chord `timer`. Today these are per room; the Model keeps them per remote.
 */
const room = id.room('room-a');
const T0 = 1_790_000_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const helper = (state: string, attributes: JsonObject = {}): EntityState => ({ state, attributes });
function source(states: Record<string, EntityState>): ConfigSource {
  return { states, rooms: parseRooms({}), labels: {}, timezone: 'UTC' };
}
const helpers = (fields: { step?: string; timer?: EntityState; count?: string; token?: string; preset?: string }) => source({
  ...fields.step === undefined ? {} : { [`input_number.ls_${room}_remote_chord_step`]: helper(fields.step) },
  ...fields.timer === undefined ? {} : { [`timer.ls_${room}_remote_chord`]: fields.timer },
  ...fields.count === undefined ? {} : { [`input_number.ls_${room}_remote_power_count`]: helper(fields.count) },
  ...fields.token === undefined ? {} : { [`input_text.ls_${room}_remote_power_token`]: helper(fields.token) },
  ...fields.preset === undefined ? {} : { [`input_number.ls_${room}_remote_preset`]: helper(fields.preset) },
});

test('helpers that are missing, unknown or unavailable read as an idle remote', () => {
  // Today's fallbacks: `| int(0)`, an unknown token is empty, `| float(-2)`. Break: a helper in unknown raises or counts as a press.
  assert.deepEqual(decodeRemoteModel(source({}), room, true), IDLE_REMOTE);
  for (const state of ['unknown', 'unavailable']) {
    const all = helpers({ step: state, timer: helper(state), count: state, token: state, preset: state });
    assert.deepEqual(decodeRemoteModel(all, room, true), IDLE_REMOTE, state);
  }
});

test('a chord in progress is its step while the chord timer runs, until the timer finishes', () => {
  // Break: the step is read off by one, or a chord with its timer idle stays in progress.
  const timer = helper('active', { duration: '0:00:03', finishes_at: iso(T0 + 3) });
  const steps: [string, RemoteModel['chord']][] = [
    ['-1', { active: true, progress: 'power', until: toInstant(T0 + 3) }],
    ['1.0', { active: true, progress: 'power power', until: toInstant(T0 + 3) }],
    ['4', { active: true, progress: 'power power left right left', until: toInstant(T0 + 3) }],
    ['0', { active: false }],
    ['7', { active: false }],
  ];
  for (const [step, chord] of steps) assert.deepEqual(decodeRemoteModel(helpers({ step, timer }), room, true).chord, chord, step);
  assert.deepEqual(decodeRemoteModel(helpers({ step: '2', timer: helper('idle') }), room, true).chord, { active: false });
});

test('a burst of power presses is its count until 600 ms after its token', () => {
  // Break: the window is measured from the wrong end, or a count above three is kept.
  const token = '2026-09-21T14:13:20.000Z';
  const until = toInstant(Date.parse(token) / 1000 + 0.6);
  assert.deepEqual(decodeRemoteModel(helpers({ count: '2', token }), room, false).power, { presses: 2, until, anyOn: false });
  assert.deepEqual(decodeRemoteModel(helpers({ count: '5', token }), room, true).power, { presses: 3, until, anyOn: true });
  assert.deepEqual(decodeRemoteModel(helpers({ count: '0', token }), room, true).power, { presses: 0 });
});

test('the preset cursor is one of the five buttons, or none', () => {
  // Break: the table is read the wrong way round, or a fractional cursor is truncated to a button.
  const read = (preset: string) => decodeRemoteModel(helpers({ preset }), room, true).presetButton;
  assert.deepEqual(['0', '1.0', '2', '3', '4', '-1', '2.5', '9'].map(read), ['coolest', 'cool', 'neutral', 'warm', 'warmest', undefined, undefined, undefined]);
});

test('remoteHelperWrites writes only the helpers that changed, in the order today\'s reducer writes them', () => {
  // A power press from idle: the preset cursor resets, the count starts, the chord starts, then the token.
  // Break: an unchanged helper is written, or the writes come out of order.
  const pressed: RemoteModel = {
    chord: { active: true, progress: 'power', until: toInstant(T0 + 3) },
    power: { presses: 1, until: toInstant(T0 + 0.6), anyOn: true },
    presetButton: undefined,
  };
  const before: RemoteModel = { ...IDLE_REMOTE, presetButton: 'warm' };
  assert.deepEqual(remoteHelperWrites(before, before), []);
  assert.deepEqual(remoteHelperWrites(before, pressed), [
    { helper: 'preset', value: { kind: 'number', value: -1 } },
    { helper: 'power count', value: { kind: 'number', value: 1 } },
    { helper: 'chord step', value: { kind: 'number', value: -1 } },
    { helper: 'chord timer', value: { kind: 'timer', running: true, until: toInstant(T0 + 3) } },
    { helper: 'power token', value: { kind: 'text', value: '2026-09-21T14:13:20.000000Z' } },
  ]);
  assert.deepEqual(remoteHelperWrites(pressed, { ...pressed, presetButton: 'cool' }), [{ helper: 'preset', value: { kind: 'number', value: 1 } }]);
  assert.deepEqual(remoteHelperWrites(pressed, IDLE_REMOTE), [
    { helper: 'power count', value: { kind: 'number', value: 0 } },
    { helper: 'chord step', value: { kind: 'number', value: 0 } },
    { helper: 'chord timer', value: { kind: 'timer', running: false } },
    { helper: 'power token', value: { kind: 'text', value: '' } },
  ]);
});

test('the writes decode back to the state they wrote', () => {
  // Break: a helper is written in a form its reader does not read back.
  const pressed: RemoteModel = {
    chord: { active: true, progress: 'power power left', until: toInstant(T0 + 3) },
    power: { presses: 2, until: toInstant(T0 + 0.6), anyOn: true },
    presetButton: 'warmest',
  };
  const states: Record<string, EntityState> = {};
  for (const write of remoteHelperWrites(IDLE_REMOTE, pressed)) {
    const entity = remoteHelperEntity(room, write.helper), value = write.value;
    states[entity] = value.kind === 'timer'
      ? helper(value.running ? 'active' : 'idle', value.running ? { finishes_at: iso(value.until) } : {})
      : helper(String(value.value));
  }
  assert.deepEqual(decodeRemoteModel(source(states), room, true), pressed);
});

test("the power token is written as today's now text, microseconds kept, so the quiet window's token matches it", () => {
  // Review item 5. Today's token is the script's `now` (six fractional digits) and the quiet script compares it by text.
  // Break: the token is written to the millisecond, or read back to the millisecond, so a burst's token no longer matches.
  const token = '2026-09-21T14:13:20.123456Z';
  const read = decodeRemoteModel(helpers({ count: '1', token }), room, true);
  const writes = remoteHelperWrites(IDLE_REMOTE, read);
  assert.deepEqual(writes.find(write => write.helper === 'power token')?.value, { kind: 'text', value: token });
});
