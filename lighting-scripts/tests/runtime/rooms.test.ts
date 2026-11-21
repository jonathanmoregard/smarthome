import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRooms } from '../../src/parse/rooms.ts';

const areas = { 'light.lamp': 'studio', remote_device: 'kitchen', 'switch.plug': 'hall' };

test("a device's room is its remote's room; an entity is not a remote", () => {
  // Break: keying ofRemote by every id would let an entity id stand in for a remote.
  assert.deepEqual(parseRooms(areas).ofRemote, { remote_device: 'kitchen' });
});

test('every entity and device keeps its room under its own id', () => {
  // Break: dropping the device entries loses them from "everything in a room".
  assert.deepEqual(parseRooms(areas).ofId, areas);
});
