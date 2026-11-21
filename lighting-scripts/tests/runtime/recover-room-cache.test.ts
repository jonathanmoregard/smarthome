import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonObject, JsonValue } from '../../src/runtime/context.ts';
import { planningHandlers } from '../../src/handlers/planning.ts';
import { resolutionHandlers } from '../../src/handlers/resolution.ts';
import { controllerHandlers } from '../../src/handlers/controller.ts';
import { nativeHandlers } from '../../src/handlers/native-controls.ts';
import { scheduleHandlers } from '../../src/handlers/schedule.ts';
import { handlers } from '../../src/runtime/registry.ts';
import { context, setCatalog, setHandlers } from './gestures-context.ts';

/**
 * The saved room cache (`sensor.ls_cache_<room>`'s `cache`) recovers, never
 * raises (2026-11-21: corrupt saved data recovers to a default). The captured
 * sanitiser keeps some caches whose baseline the plan then cannot read: a
 * target or profile that is not a mapping, a schedule detail that is not a
 * number, a cached colour or blend end that is not one. The plan used to
 * raise on them where it read them; such a cache is now a miss, the most
 * conservative default: the plan is worked out afresh from the house.
 */
const noon = '2026-10-23T12:00:00+02:00';
function roomPlanner() {
  const ctx = context({ ...scheduleHandlers, ...resolutionHandlers, ...controllerHandlers, ...nativeHandlers, ...planningHandlers });
  ctx.members = ['light.studio']; ctx.areas['light.studio'] = 'studio';
  for (const [block, hour, b, k] of [['day', '08:00', 240, 4500], ['cosy', '18:00', 90, 2500], ['night', '23:00', 10, 2000]] as const) {
    for (const kind of ['start', 'weekend']) ctx.put(`input_datetime.ls_house_${block}_${kind}`, `${hour}:00`);
    ctx.put(`input_number.ls_house_${block}_fade`, '20');
    ctx.put(`light.ls_house_${block}`, 'on', { brightness: b, color_mode: 'color_temp', color_temp_kelvin: k });
    ctx.put(`input_text.ls_house_${block}`, JSON.stringify({ on: true, b, m: 'ct', k }));
  }
  ctx.put('light.studio', 'on', { brightness: 100, color_mode: 'color_temp', color_temp_kelvin: 2500 });
  ctx.put('sensor.ls_overrides', '0', { overrides: {} });
  ctx.now = noon;
  setCatalog(ctx, { effects: {}, processors: {} });
  return ctx;
}
type RoomPlan = { cache_hit: boolean; cache_update: JsonObject | null; plan: JsonObject };
/** A dashboard brightness position on the lamp: the resolver reads the lamp's blend ends for it. */
const scaled: JsonObject = { 'channels:ui:studio': { kind: 'channels', scope: 'lamp', target: 'light.studio', when: noon,
  value: { channels: { brightness: { kind: 'scale', position: 0.5, updated: 1 } } } } };
const plan = (cache?: JsonObject) => roomPlanner().run('ls_room_plan',
  { room: 'studio', overrides: scaled, reason: 'remote', ...(cache === undefined ? {} : { cache }) }) as unknown as RoomPlan;
/** A cache the plan wrote itself, edited. */
function saved(edit: (baseline: { targets: Record<string, JsonObject>; schedule: JsonObject }) => void): JsonObject {
  const cache = structuredClone(plan().cache_update);
  assert.ok(cache !== null);
  edit(cache.baseline as never);
  return cache;
}
const details = (schedule: JsonObject) => (schedule.schedule_details as Record<string, JsonObject>).studio as JsonObject;

test('an unedited saved cache is a hit', () => {
  assert.equal(plan(saved(() => {})).cache_hit, true);
});

const corrupt: Array<[string, (baseline: { targets: Record<string, JsonObject>; schedule: JsonObject }) => void]> = [
  ['a target that is not a mapping', b => { (b.targets as Record<string, JsonValue>)['light.studio'] = 'lamp'; }],
  ['a profile that is not a mapping', b => { (b.schedule.profiles as Record<string, JsonValue>)['light.studio'] = 5; }],
  ['a profile for a lamp with no target', b => { (b.schedule.profiles as Record<string, JsonValue>)['light.gone'] = {}; }],
  ['a last fade start that is not a number', b => { details(b.schedule).last_fs = 'yesterday'; }],
  ['a time left that is not a number', b => { details(b.schedule).left = null; }],
  ['a block start that is missing', b => { delete details(b.schedule).cur_ts; }],
  ['a cached colour that is not one', b => { b.targets['light.studio']!.color = { rgb: ['a', 'b', 'c'] }; }],
  ['a cached blend end that is not one', b => {
    b.targets['light.studio']!.day = { brightness: 'bright', color: { kelvin: 4500 } };
    b.targets['light.studio']!.cosy = { brightness: 90, color: { kelvin: 2500 } };
  }],
];

for (const [label, edit] of corrupt) {
  test(`a saved cache with ${label} is a miss, never a raise`, () => {
    const answer = plan(saved(edit));
    assert.equal(answer.cache_hit, false);
    assert.deepEqual(answer, plan());
  });
}

test("a remote press with a saved cache whose next fade start is not a number plans as with no cache, never a raise", () => {
  // The remote plan reads the room plan's schedule details, which on a hit
  // are the cached ones, so a cached `next_fs` it cannot read used to raise there.
  const press = (cache?: JsonObject) => {
    const ctx = roomPlanner();
    setHandlers(ctx, handlers);
    setCatalog(ctx, { effects: {}, processors: {}, members: { 'light.studio': ['light.bulb'] }, topics: {}, multicast: [] });
    ctx.put('sensor.ls_overrides', '0', { overrides: scaled });
    if (cache !== undefined) ctx.put('sensor.ls_cache_studio', 'x', { cache });
    return ctx.run('ls_remote_plan', { source: 'remote', area: 'studio', command: 'right' });
  };
  for (const next_fs of ['soon', null, [1]] as JsonValue[]) {
    assert.deepEqual(press(saved(b => { details(b.schedule).next_fs = next_fs; })), press(), JSON.stringify(next_fs));
  }
});

test("a remote press with a saved cache whose room period is not text plans as with no cache, never a raise", () => {
  // The preset cycle starts from the room target's period, which on a hit is
  // the cached one, carried through the resolver; one that is not text raised there.
  const press = (cache?: JsonObject) => {
    const ctx = roomPlanner();
    setHandlers(ctx, handlers);
    setCatalog(ctx, { effects: {}, processors: {}, members: { 'light.studio': ['light.bulb'] }, topics: {}, multicast: [] });
    if (cache !== undefined) ctx.put('sensor.ls_cache_studio', 'x', { cache });
    return ctx.run('ls_remote_plan', { source: 'remote', area: 'studio', command: 'right' });
  };
  for (const period of [5, null, ['day']] as JsonValue[]) {
    assert.deepEqual(press(saved(b => { b.targets['room:studio']!.period = period; })), press(), JSON.stringify(period));
  }
});
