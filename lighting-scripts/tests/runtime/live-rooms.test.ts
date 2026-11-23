import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import { parseRooms } from '../../src/adapter/codecs/rooms.ts';
import { parseLiveRooms, readLiveRoomsFlag, refuseUnlessWholeHouse } from '../../src/adapter/live-rooms.ts';

/**
 * The rooms the live port drives, from its command line. Until rooms can be shared with the old scripts again
 * (M6), the list must be the whole house. The sharing tests went with `src/runtime/live-rooms.ts`; M6 rebuilds them.
 */

/** A made-up house: two rooms with one lamp each, a lamp the registry puts in no room, and a room with only a remote. */
const catalog = parseCatalog({ members: { 'light.studio': ['light.studio_bulb'], 'light.den': ['light.den_bulb'],
  'light.loose': ['light.loose_bulb'] } });
const rooms = parseRooms({ 'light.studio': 'studio', 'light.den': 'den', 'remote-s': 'studio', 'remote-x': 'porch' });

test('the live rooms are refused when the setting is missing, so a missing list never means every room', () => {
  assert.throws(() => parseLiveRooms(undefined), /--live-rooms/);
  assert.throws(() => readLiveRoomsFlag(['--live', '--config', 'catalog.json']), /--live-rooms/);
  assert.throws(() => readLiveRoomsFlag(['--live-rooms', '--live']), /--live-rooms/);
});

test('an empty live-room setting is an empty list, and a list names its rooms', () => {
  assert.equal(parseLiveRooms('').size, 0);
  assert.equal(readLiveRoomsFlag(['--live-rooms', '']).size, 0);
  assert.deepEqual([...parseLiveRooms('studio,den')].sort(), ['den', 'studio']);
  assert.deepEqual([...readLiveRoomsFlag(['--live-rooms', 'studio'])], ['studio']);
});

test('a live-room list with an empty entry is refused', () => {
  assert.throws(() => parseLiveRooms('studio,,den'), /empty room/);
  assert.throws(() => parseLiveRooms('studio,'), /empty room/);
});

test("a live room that holds no lamp of the house is refused, naming it and the house's rooms", () => {
  // Break: a misspelt room is driven by neither system; a room with only a remote counts as a room the port drives.
  assert.doesNotThrow(() => refuseUnlessWholeHouse(parseLiveRooms('studio,den'), catalog, rooms));
  assert.throws(() => refuseUnlessWholeHouse(parseLiveRooms('studio,den,stduio'), catalog, rooms),
    { message: '--live-rooms names stduio, which holds no lamp of the house; its rooms are den, studio' });
  assert.throws(() => refuseUnlessWholeHouse(parseLiveRooms('studio,den,porch'), catalog, rooms), /names porch/);
});

test('a live-room list that leaves out a room of the house is refused until rooms can be shared again', () => {
  // Break: the port drives part of the house while nothing stops the old scripts driving it too.
  assert.throws(() => refuseUnlessWholeHouse(parseLiveRooms('studio'), catalog, rooms), /leaves out den/);
  assert.throws(() => refuseUnlessWholeHouse(parseLiveRooms(''), catalog, rooms), /leaves out den, studio/);
});
