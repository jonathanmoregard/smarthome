/**
 * `dispatch-render`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/dispatch-render.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { typed } from '../runtime/entrypoints.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { drive, perform, run } from '../runtime/effects.ts';
import { timestamp } from '../parse/accessors.ts';
import type { StoredValue } from '../parse/overrides.ts';
import { overridesRevision } from '../parse/sensors.ts';
import { fullPlan, parseDispatchArgs, roomPlanView } from '../parse/dispatch-render.ts';
import {
  cacheWrite, dispatchInit, dispatchUpdate, fullLights, fullReason, gradientUpdates, mergeRoomPlan, renderAck, renderOpening,
    roomPlanRequest, roomsPlan, roomsStart,
} from '../domain/dispatch-render.ts';
import type { DispatchRequest, DispatchCmd, DispatchMsg, DispatchOutcome, RoomsPlan } from '../domain/dispatch-render.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { RoomId } from '../domain/types/ids.ts';

/** Delta output actor: invalidate touched lamps before sending, acknowledge only complete batches. */
export function dispatch(ctx: ScriptContext, args: DispatchRequest): DispatchOutcome {
  return drive(dispatchUpdate, dispatchInit(args), { tag: 'start', house: ctx }, (cmd: DispatchCmd): DispatchMsg => {
    switch (cmd.tag) {
      case 'catalog': return { tag: 'catalog', catalog: carry(ctx.run('effects_catalog')), house: ctx };
      case 'assign': return { tag: 'assigned', result: ctx.call('effects_assign', cmd.args), house: ctx };
      case 'frame': return { tag: 'framed', batch: ctx.call('effects_frame_plan', cmd.args), house: ctx };
      // `object(...)` and `?? []` are gone: `planGroups` builds all five fields on
      // every path, so both could only fire for a stub, and `decodeGroupPlan` is
      // where that case is handled now -- strictly, rather than as an empty batch.
      case 'emit': return { tag: 'emitted', result: ctx.call('effects_emit', cmd.args), house: ctx };
      case 'effect': perform(ctx, cmd.effect); return { tag: 'performed', house: ctx };
      case 'plan': run(ctx, cmd.plan); return { tag: 'performed', house: ctx };
      default: {
        const unknown: never = cmd;
        throw new Error(`Unhandled ls_dispatch command ${JSON.stringify(unknown)}`);
      }
    }
  }, model => model.tag === 'done' ? { value: model.answer } : undefined);
}
/**
 * Coalesce pending room versions, preserving unrelated rooms and retrying
 * incomplete output. Read, then the planning runs (`ls_plan` for a full
 * render, one `ls_room_plan` per pending room otherwise), the cache writes,
 * `ls_dispatch`, and the acknowledgement; every read after a run is live.
 */
export function render(ctx: ScriptContext): null {
  const opening = renderOpening(ctx);
  if (opening === undefined) return null;
  const { revision, rooms } = opening;
  let plan: Verbatim | RoomsPlan, lights: StoredValue | StoredValue[] = [], updates: Record<RoomId, Verbatim>;
  if (opening.full) {
    const planned = fullPlan(ctx.run('ls_plan', { reason: fullReason(ctx) }), rooms);
    plan = planned.document;
    lights = fullLights(ctx);
    updates = gradientUpdates(ctx, planned);
  } else {
    let merged = roomsStart(ctx);
    for (const room of rooms) merged = mergeRoomPlan(merged, room, roomPlanView(ctx.run('ls_room_plan', roomPlanRequest(ctx, room))));
    plan = roomsPlan(merged, opening);
    updates = merged.updates;
  }
  if (revision !== overridesRevision(ctx, 'ls_render')) return null;
  for (const [room, cache] of entriesOf(updates)) {
    const write = cacheWrite(ctx, room, cache);
    if (write !== undefined) perform(ctx, write);
  }
  const plannedAt = timestamp(ctx.now);
  const emission = ctx.call('ls_dispatch', { plan, lights });
  const ack = renderAck(ctx, opening, plannedAt, emission);
  if (ack !== undefined) perform(ctx, ack);
  return null;
}
export const dispatchHandlers: ScriptHandlers = {
  ls_dispatch: typed('ls_dispatch', { parse: parseDispatchArgs, run: dispatch }),
  ls_render: ctx => render(ctx),
};
