import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject } from '../../src/runtime/context.ts';
import { parseRoomPlanArgs } from '../../src/parse/planning.ts';

/**
 * `ls_room_plan`'s room cache is kept or dropped by the captured script's
 * first-step sanitiser, not by the looser-looking `cache_hit` test. Each case
 * here was rendered through Home Assistant 2026.7.4 with the captured template
 * and gave the same keep/drop. Loosening `validCache` to the `cache_hit` checks
 * would keep caches the original drops.
 *
 * The port also drops a cache whose baseline the plan cannot read, where the
 * captured script keeps it and then raises (`recover-room-cache.test.ts`), so
 * the complete cache here carries the room's `left` and `cur_ts`.
 */
function cache(edit: (c: JsonObject) => void): JsonObject {
  const c: JsonObject = { version: 'v', room: 'studio', dependencies: {}, periods: {}, gradients: {}, catalog: {}, valid_from: 1, valid_until: 2,
    baseline: { targets: { 'room:studio': {} }, schedule: { schedule_details: { studio: { left: 0, cur_ts: 0 } }, profiles: {} } } };
  edit(c);
  return c;
}
const kept = (c: JsonObject) => parseRoomPlanArgs({ room: 'studio', cache: c }).cache !== undefined;
const schedule = (c: JsonObject) => (c.baseline as JsonObject).schedule as JsonObject;

test('a complete room cache is kept', () => {
  assert.equal(kept(cache(() => {})), true);
});

test('a room cache the cache_hit test would accept is dropped when the sanitiser refuses it', () => {
  assert.equal(kept(cache(c => { delete schedule(c).profiles; })), false);
  assert.equal(kept(cache(c => { delete schedule(c).schedule_details; })), false);
  assert.equal(kept(cache(c => { schedule(c).schedule_details = {}; })), false);
  assert.equal(kept(cache(c => { (c.baseline as JsonObject).targets = {}; })), false);
  assert.equal(kept(cache(c => { delete c.dependencies; })), false);
});

test('a room cache with a boolean or text validity bound is dropped', () => {
  assert.equal(kept(cache(c => { c.valid_from = true; })), false);
  assert.equal(kept(cache(c => { c.valid_until = '2'; })), false);
});
