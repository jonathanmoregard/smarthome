import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptInput } from '../../src/adapter/codecs/inputs.ts';
import { answer, forgetState } from '../../src/rpc.ts';
import type { Snapshot } from '../../src/rpc.ts';
import { CATALOG, syntheticStates } from './fixtures/house-view.ts';

/**
 * The harness's host (`src/rpc.ts`) and the script names it reads into inputs. Carried over from the engine's and
 * the turn handler's tests when they were deleted with `src/runtime/`.
 */

const remotes = { kitchen: { source: 'remote-a' as never, device_id: 'device-a' as never } };
const snapshot = (): Snapshot => ({ state: syntheticStates(), areas: { 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a',
  'light.lamp_b1': 'room-b', 'switch.plug_a': 'room-a', 'remote-a': 'room-a' }, members: [], now: '2026-09-21T12:00:00Z', timezone: 'UTC',
catalog: CATALOG });

test('a name that is not an input fails explicitly', () => {
  // Break: an unknown name runs as some other input, or is quietly ignored, so the harness cannot tell it was not ported.
  assert.throws(() => answer({ script: 'automation.unknown', args: {}, snapshot: snapshot() }), /Unsupported script: automation.unknown/);
  assert.equal(scriptInput('automation.unknown', {}, remotes), 'not ours');
});

test("a room's own gesture script is the shared one, bound to that room's remote; explicit data is kept", () => {
  // Break: the room's script loses the catalog remote's source and device, so its press names no remote, or the
  // press's own command is overwritten.
  assert.deepEqual(scriptInput('ls_remote_gesture_kitchen', { command: 'up' }, remotes),
    { kind: 'remote action', room: 'kitchen', device: 'device-a', source: 'remote-a', button: { kind: 'direction', id: 'up' } });
  assert.deepEqual(scriptInput('ls_remote_gesture_kitchen', { command: 'power', source: 'remote-b' }, remotes),
    { kind: 'remote action', room: 'kitchen', device: 'device-a', source: 'remote-b', button: { kind: 'power' } });
  assert.deepEqual(scriptInput('ls_remote_power_quiet_kitchen', {}, remotes), { kind: 'wake' });
});

test('a dry run changes nothing: it is logged once and dropped', () => {
  // Break: a dry run (the old scripts' "ask, don't touch") reaches the turn and saves the range or sends to the lamps.
  forgetState();
  answer({ script: 'automation.lighting_schedule_engine', args: { trigger: { id: 'start' } }, snapshot: snapshot() });
  for (const [script, args] of [
    ['ls_range_save', { entity: 'switch.plug_a', profile: 'bright', minimum: 10, maximum: 90, dry_run: true }],
    ['ls_apply', { reason: 'config', dry_run: true }],
  ] as const) {
    const lines: string[] = [], original = console.error;
    console.error = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
    try {
      assert.deepEqual(answer({ script, args, snapshot: snapshot() }).calls, [], script);
    } finally {
      console.error = original;
    }
    assert.deepEqual(lines, [`lighting: ${script} is a dry run; dropped`], script);
  }
  forgetState();
});

test("the harness's wake is scheduled only before the next minute's tick", () => {
  // Break: a wake hours away is scheduled, and the harness, which runs every task before its checkpoint, runs it at once.
  forgetState();
  const started = answer({ script: 'automation.lighting_schedule_engine', args: { trigger: { id: 'start' } }, snapshot: snapshot() });
  assert.equal((started.snapshot.scheduled ?? []).some(task => task.script === 'ls_wake'), false);
  assert.ok(started.calls.length > 0);
  forgetState();
});
