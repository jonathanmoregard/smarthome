/**
 * `planning`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/legacy/domain/planning.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { Resolution } from '../legacy/domain/resolution.ts';
import { privateRooms } from '../legacy/domain/schedule.ts';
import { mappingAttribute, parseRoomBaseline, parseRoomPlanArgs, rangeDefaults, roomCatalog } from '../parse/planning.ts';
import { activeOverrides, missUpdate, refreshBaseline, roomOpening, roomPlanAnswer } from '../legacy/domain/planning.ts';
import type { CacheUpdate, Gradients, RoomBaseline, RoomPlanRequest, RoomPlan } from '../legacy/domain/planning.ts';
import { overlayKeyText, SARA_MODE } from '../adapter/codecs/overlay-key.ts';

/**
 * Plan one room: the opening reads, then the cache hit or the miss's three
 * inter-handler runs, then the refresh, `effects_resolve` and `ls_switch_plan`.
 * Every read after a run is made on the house as that run left it.
 */
export function roomPlan(ctx: ScriptContext, args: RoomPlanRequest): RoomPlan {
  const { room, reason, overrides, cache } = args;
  const opening = roomOpening(ctx, args);
  const { at, warmEnd } = opening;
  const hit = opening.hit;
  let baseline: RoomBaseline, gradients: Gradients, catalog: Verbatim, update: CacheUpdate | null = null;
  if (hit !== undefined) {
    baseline = hit.baseline; gradients = hit.gradients; catalog = hit.catalog;
  } else {
    baseline = parseRoomBaseline(ctx.run('ls_room_base', { room, overrides: overrides.document, test_now: args.testNow.document ?? null,
      reason }), 'ls_room_plan baseline');
    catalog = roomCatalog(ctx.rawCatalog(), () => ctx.run('effects_catalog'));
    gradients = ctx.call('effects_gradient_plan', { base: baseline.targets, warm_end: warmEnd, cached: cache === undefined ?
      {} : cache.gradients });
    update = missUpdate(ctx, args, opening, baseline, gradients, catalog);
  }
  const refreshed = refreshBaseline(ctx, baseline, hit === undefined ? undefined : hit.validFrom, room, opening.deps, overrides, at);
  const active = activeOverrides(overrides, refreshed.stale);
  const resolved: Resolution = ctx.call('effects_resolve', { base: refreshed.targets, overrides: active, catalog,
    sara: Object.hasOwn(active, overlayKeyText(SARA_MODE)), private: privateRooms(ctx),
    power: args.power ?? mappingAttribute(ctx.attr('sensor.ls_overrides', 'power')), warm_end: warmEnd, gradients });
  // `?? {}` on both results is gone, not dropped as decoration: `switchPlan`
  // and `resolveEffects` always return their key, so the fallbacks were
  // unreachable for the real handlers and the types now say so.
  const switches = ctx.call('ls_switch_plan', { targets: resolved.targets,
    ranges: args.ranges ?? mappingAttribute(ctx.attr('sensor.ls_overrides', 'switch_ranges')),
    defaults: args.defaults ?? rangeDefaults(ctx.attr('sensor.ls_overrides', 'range_defaults')) });
  return roomPlanAnswer(ctx, { room, reason, revision: opening.revision, refreshed, active, resolved, gradients, catalog,
    switches, update, hit: hit !== undefined });
}
export const planningHandlers: ScriptHandlers = {
  // Argument parsing, the cache's validity test and every document read live in
  // `src/parse/planning.ts`; see `parseRoomPlanArgs` for the captured sources.
  ls_room_plan: withParsedArgs({ parse: parseRoomPlanArgs, run: roomPlan }),
};
