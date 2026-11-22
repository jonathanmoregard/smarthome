import assert from 'node:assert/strict';
import test from 'node:test';
import { stampPowerToken, update } from '../../src/legacy/domain/gestures.ts';
import type { Model } from '../../src/legacy/domain/gestures.ts';
import { gestureHandlers, launchPowerQuiet, powerQuiet } from '../../src/handlers/gestures.ts';
import type { Effect, Plan } from '../../src/runtime/effects.ts';
import { carry } from '../../src/runtime/verbatim.ts';
import { context } from './gestures-context.ts';

const idle: Model = { chordStep: 0, chordActive: false, powerCount: 0, powerToken: '', preset: -2 };
const NOW = '2026-10-26T12:00:00+01:00';
type Remote = Parameters<typeof update>[2];
function remote(extra: Partial<Remote> = {}): Remote {
  return {
    room: 'studio',
    sender: () => ({ deviceId: 'studio_remote', source: 'remote_ieee' }),
    remoteRooms: { studio_remote: 'studio' }, now: NOW, ...extra,
  };
}
/** Drain a plan: its effects in yield order, and its answer. */
function drain<R>(plan: Plan<R>): { effects: Effect[]; result: R } {
  const effects: Effect[] = [];
  for (;;) {
    const step = plan.next();
    if (step.done) return { effects, result: step.value };
    effects.push(step.value);
  }
}
const helper = (key: string, value: number) => [
  { kind: 'state', entity: `input_number.ls_studio_remote_${key}`, state: String(value) },
  { kind: 'service', service: 'input_number.set_value', data: { value }, target: { entity_id: `input_number.ls_studio_remote_${key}` } },
];
const token = (value: string) => [
  { kind: 'state', entity: 'input_text.ls_studio_remote_power_token', state: value },
  { kind: 'service', service: 'input_text.set_value', data: { value }, target: { entity_id: 'input_text.ls_studio_remote_power_token' } },
];
const timer = (start: boolean) => [
  { kind: 'state', entity: 'timer.ls_studio_remote_chord', state: start ? 'active' : 'idle' },
  { kind: 'service', service: `timer.${start ? 'start' : 'cancel'}`, data: start ? { duration: '00:00:03' } : {}, target: { entity_id: 'timer.ls_studio_remote_chord' } },
];
const command = (logical: string, area = 'studio', source = 'remote_ieee') => ({
  kind: 'service', service: 'script.turn_on',
  data: { variables: { source, area, command: logical, dry_run: false } }, target: { entity_id: 'script.ls_remote_command' },
});

test('a first power press resets the preset, counts one click and arms the chord; the token is the shell\'s', () => {
  const { effects, result } = drain(update(idle, { tag: 'power' }, remote()));
  assert.deepEqual(effects, [...helper('preset', -1), ...helper('power_count', 1), ...helper('chord_step', -1), ...timer(true)]);
  assert.deepEqual(result, { chordStep: -1, chordActive: true, powerCount: 1, powerToken: '', preset: -1 });
});

test('a power press after the quiet window first completes the old burst', () => {
  const state: Model = { ...idle, powerCount: 1, powerToken: '2026-10-26T11:59:00+01:00' };
  const { effects } = drain(update(state, { tag: 'power' }, remote()));
  assert.deepEqual(effects, [
    ...helper('preset', -1), ...helper('power_count', 0), ...token(''), ...helper('chord_step', 0), ...timer(false), command('toggle'),
    ...helper('power_count', 1), ...helper('chord_step', -1), ...timer(true),
  ]);
});

test('power_done with the stored token completes a single click as a toggle', () => {
  const state: Model = { ...idle, powerCount: 1, powerToken: NOW };
  const { effects, result } = drain(update(state, { tag: 'combo_timeout', token: NOW }, remote()));
  assert.deepEqual(effects, [...helper('power_count', 0), ...token(''), ...helper('chord_step', 0), ...timer(false), command('toggle')]);
  assert.deepEqual(result, { ...idle, preset: -2 });
});

test('power_done with a stale token does nothing', () => {
  const state: Model = { ...idle, powerCount: 1, powerToken: NOW };
  assert.deepEqual(drain(update(state, { tag: 'combo_timeout', token: 'older' }, remote())).effects, []);
});

test('the sender thunk raises only where the send happens, after the chord is cleared', () => {
  const state: Model = { ...idle, powerCount: 3, powerToken: NOW };
  const plan = update(state, { tag: 'combo_timeout', token: NOW }, remote({ sender: () => { throw new Error('source must be a string'); } }));
  const seen: Effect[] = [];
  assert.throws(() => { for (const effect of plan) seen.push(effect); }, /source must be a string/);
  assert.deepEqual(seen, [...helper('power_count', 0), ...token(''), ...helper('chord_step', 0), ...timer(false)]);
});

test('a device area resolves through the remotes\' rooms; an unknown device sends nothing', () => {
  const at = (deviceId: string) => remote({ sender: () => ({ deviceId, source: 's' }), remoteRooms: { remote_device: 'kitchen' } });
  assert.deepEqual(drain(update(idle, { tag: 'direction', direction: 'up' }, at('remote_device'))).effects, [command('up', 'kitchen', 's')]);
  assert.deepEqual(drain(update(idle, { tag: 'direction', direction: 'up' }, at('missing'))).effects, []);
});

test('a remote with no device has no area, so its gesture sends nothing', () => {
  // Break: falling back to the gesture's room (the generalised form of the
  // oracle kitchen remote's `area_id(device) or 'kitchen'`) sends a command
  // for an area the remote's configuration never named.
  const plan = update(idle, { tag: 'direction', direction: 'up' }, remote({ sender: () => ({ deviceId: undefined, source: 's' }) }));
  assert.deepEqual(drain(plan).effects, []);
});

test('a canonical preset step to the right navigates right', () => {
  const state: Model = { ...idle, preset: 0 };
  const payload = { action: 'color_temperature_move', preset: 285 };
  const { effects, result } = drain(update(state, { tag: 'preset', payload }, remote()));
  assert.deepEqual(effects, [...helper('preset', 1), command('right')]);
  assert.equal(result.preset, 1);
});

test('the fourth chord step sends sara_toggle', () => {
  const state: Model = { ...idle, chordStep: 4, chordActive: true };
  assert.deepEqual(drain(update(state, { tag: 'direction', direction: 'right' }, remote())).effects, [...helper('chord_step', 0), ...timer(false), command('sara_toggle')]);
});

test('an unaccepted command does nothing', () => {
  // An unaccepted command is no message, so it never reaches the reducer; the handler performs nothing for it.
  const ctx = context(gestureHandlers);
  ctx.run('ls_remote_gesture', { room: 'studio', command: 'dance' });
  assert.deepEqual([ctx.calls, ctx.state], [[], {}]);
});

test('the shell stamps the power token and launches the quiet script from a live now', () => {
  assert.deepEqual([...stampPowerToken('studio', 'T1')], token('T1'));
  assert.deepEqual([...launchPowerQuiet('studio', 'T2')], [
    { kind: 'service', service: 'script.turn_on', data: { variables: { token: 'T2' } }, target: { entity_id: 'script.ls_remote_power_quiet_studio' } },
  ]);
});

test('the quiet window schedules power_done with the document carried', () => {
  const document = carry({ token: 'T', command: 'x', room: 'studio' });
  assert.deepEqual([...powerQuiet({ document, room: 'studio' })], [
    { kind: 'schedule', script: 'ls_remote_gesture', args: { token: 'T', command: 'power_done', room: 'studio' }, delayMs: 600 },
  ]);
});
