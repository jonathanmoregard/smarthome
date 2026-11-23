import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetAdapterState } from '../../src/adapter/turn.ts';
import { execute } from '../../src/runtime/engine.ts';
import { handlers } from '../../src/runtime/registry.ts';
import type { JsonObject, Snapshot } from '../../src/runtime/context.ts';
import { CATALOG, syntheticStates, world, writeBack } from './fixtures/house-view.ts';
import { syntheticSource } from './fixtures/synthetic-house.ts';

/**
 * The turn as Home Assistant runs it, by input name (M3 Task 3): an input
 * that cannot be read is logged once and dropped (plan, "an input that cannot
 * be read is logged once and dropped"), and the turn writes nothing for it.
 */

function snapshot(): Snapshot {
  const states = syntheticStates();
  writeBack(world(), states);
  return {
    state: states, members: [], now: '2026-09-21T12:00:00Z', timezone: syntheticSource().timezone, catalog: CATALOG,
    areas: { 'light.lamp_a1': 'room-a', 'light.lamp_a2': 'room-a', 'light.lamp_b1': 'room-b', 'switch.plug_a': 'room-a', 'remote-a': 'room-a' },
    labels: { on_off: ['switch.plug_a'], private_room: ['room-b'] }, devices: { 'device-plug-a': ['switch.plug_a'] },
  };
}

/** What the turn logs for one input, run on a turn that has already started. */
function logged(script: string, args: JsonObject): string[] {
  forgetAdapterState();
  execute({ script: 'automation.lighting_schedule_engine', args: { trigger: { id: 'start' } }, snapshot: snapshot() }, handlers);
  const lines: string[] = [], original = console.error;
  console.error = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try {
    execute({ script, args, snapshot: snapshot() }, handlers);
  } finally {
    console.error = original;
    forgetAdapterState();
  }
  return lines;
}

test('a range save that fails its checks is logged once and dropped', () => {
  // Break: a failed save raises out of the turn, is dropped with no word, or is logged more than once.
  const lines = logged('ls_range_save', { entity: 'light.lamp_a1', profile: 'bright' });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /ls_range_save: .*Choose a physical on\/off lamp or smart plug\..*; dropped$/);
});

test('an override operation the turn does not read is logged once and dropped', () => {
  // Break: an unread operation is dropped with no word, or logged more than once.
  const lines = logged('ls_commit', { data: { op: 'lamp_channels', lamps: ['light.lamp_a1'] } });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /ls_commit: .*operation lamp_channels is not read here; dropped$/);
});

test('an override set with a record the turn does not read is logged once and dropped', () => {
  // Break: the unread record is passed over with no word, so a lamp's record from an old writer vanishes unseen.
  const lines = logged('ls_commit', { data: { op: 'set', records: [{ kind: 'lamp', target: 'light.lamp_a1', value: 40 }] } });
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0]!, /ls_commit: .*record lamp is not read here; dropped$/);
});

test('a dry run changes nothing: it is logged once and dropped', () => {
  // Break: a dry run (the old scripts' "ask, don't touch") reaches the turn and saves the range or sends to the lamps.
  for (const [script, args] of [
    ['ls_range_save', { entity: 'switch.plug_a', profile: 'bright', minimum: 10, maximum: 90, dry_run: true }],
    ['ls_apply', { reason: 'config', dry_run: true }],
  ] as const) {
    forgetAdapterState();
    execute({ script: 'automation.lighting_schedule_engine', args: { trigger: { id: 'start' } }, snapshot: snapshot() }, handlers);
    const lines: string[] = [], original = console.error;
    console.error = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
    try {
      const outcome = execute({ script, args, snapshot: snapshot() }, handlers);
      assert.deepEqual(outcome.calls, [], script);
    } finally {
      console.error = original;
      forgetAdapterState();
    }
    assert.deepEqual(lines, [`lighting: ${script} is a dry run; dropped`], script);
  }
});

test('a bulb given up on is logged once, at info level', () => {
  // Owner, 2026-11-20: a bulb given up on is logged once per episode at info level, never per retry. Here the house
  // never shows what it is sent, so each bulb is put back each minute until it is parked. Break: a parked bulb is
  // logged every turn, as an error, or not at all.
  forgetAdapterState();
  const lines: string[] = [], errors: string[] = [], info = console.info, error = console.error;
  console.info = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  console.error = (...parts: unknown[]) => { errors.push(parts.join(' ')); };
  try {
    execute({ script: 'automation.lighting_schedule_engine', args: { trigger: { id: 'start' } }, snapshot: snapshot() }, handlers);
    for (let minute = 1; minute <= 9; minute++) {
      execute({ script: 'automation.lighting_schedule_engine', args: { trigger: { id: 'tick' } },
        snapshot: { ...snapshot(), now: `2026-09-21T12:0${minute}:00Z` } }, handlers);
    }
  } finally {
    console.info = info;
    console.error = error;
    forgetAdapterState();
  }
  assert.deepEqual(errors, []);
  const bulbs = lines.map(line => /lighting: (\S+) is parked/.exec(line)?.[1]);
  assert.ok(bulbs.length > 0 && bulbs.every(bulb => bulb !== undefined), lines.join('\n'));
  assert.equal(new Set(bulbs).size, bulbs.length, lines.join('\n'));
});
