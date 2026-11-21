import assert from 'node:assert/strict';
import test from 'node:test';
import { lampOrRoom } from '../../src/parse/lighting-state.ts';

test("a stored is_room picks a room by Jinja truthiness, not JavaScript's", () => {
  // Break: `isRoom ? ...` treats [] and {} as true; Jinja's `if target.is_room` does not.
  for (const flag of [[], {}, 0, '', false, null, undefined]) {
    assert.deepEqual(lampOrRoom('light.lamp', flag), { kind: 'lamp', lamp: 'light.lamp' }, JSON.stringify(flag));
  }
  for (const flag of [true, 1, 'no', [0], { a: 1 }]) {
    assert.equal(lampOrRoom('room:studio', flag).kind, 'room', JSON.stringify(flag));
  }
});

test("a room's entry names the room its key carries", () => {
  // Break: keeping the `room:` prefix would name a room no registry area has.
  assert.deepEqual(lampOrRoom('room:studio', true), { kind: 'room', room: 'studio' });
  assert.deepEqual(lampOrRoom('studio', true), { kind: 'room', room: 'studio' });
});
