import assert from 'node:assert/strict';
import test from 'node:test';
import { privateRooms } from '../../src/legacy/domain/schedule.ts';

test('the private rooms are the registry\'s private_room label list, none when it is absent or null', () => {
  // Break: the parse step that brands the list stops treating an absent label map, an absent
  // label or a null list as no rooms, or drops, reorders or rewrites a listed room.
  // Tests are not type-checked: the view carries only the label map the read looks at.
  const view = (labels: unknown) => ({ labels });
  assert.deepEqual(privateRooms(view(undefined)), []);
  assert.deepEqual(privateRooms(view(null)), []);
  assert.deepEqual(privateRooms(view({ on_off: ['switch.plug'] })), []);
  assert.deepEqual(privateRooms(view({ private_room: null })), []);
  assert.deepEqual(privateRooms(view({ private_room: ['studio', 'attic', 'studio'] })), ['studio', 'attic', 'studio']);
});
