/**
 * `dispatch-render`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/dispatch-render.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { typed } from '../runtime/entrypoints.ts';
import { carry } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { perform } from '../runtime/effects.ts';
import { timestamp } from '../parse/accessors.ts';
import type { OpaqueMap, StoredValue } from '../parse/overrides.ts';
import { attributeMapping, overridesRevision } from '../parse/sensors.ts';
import { dispatchPlanOrder, dispatchRuntime, fullPlan, parseDispatchArgs, roomPlanView } from '../parse/dispatch-render.ts';
import {
  bulbStartCommands, cacheWrite, fullLights, fullReason, gradientUpdates, mergeRoomPlan, ordinaryTargets, renderAck, renderOpening,
    roomPlanRequest, roomsPlan, roomsStart, transitionCap,
} from '../domain/dispatch-render.ts';
import type { DispatchDetails, DispatchOutcome, DispatchRequest, RoomsPlan, TransitionCap } from '../domain/dispatch-render.ts';
import { stillCurrent } from '../domain/transport.ts';
import type { EmitOutcome } from '../domain/transport.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { RoomId } from '../domain/types/ids.ts';

const runtime = 'sensor.ls_effects_runtime';

/**
 * Delta output actor: invalidate touched lamps before sending, acknowledge only
 * complete batches. The captured script's order, one step after another: the
 * revision and plan-order stops, the details, the catalog, the lamps to send,
 * `effects_assign`, `effects_frame_plan`, `effects_emit` (the light),
 * `effects_emit` again (the bulb-effect starts), the guarded `applied` record,
 * the switches one by one, the tail and the answer. Every read is made on the
 * house as the call before it left it.
 */
export function dispatch(ctx: ScriptContext, request: DispatchRequest): DispatchOutcome {
  const { revision, planOrder } = request;
  if (revision !== overridesRevision(ctx, 'ls_dispatch') || planOrder < dispatchPlanOrder(ctx)) return null;
  const details = request.details();
  const catalog = carry(ctx.run('effects_catalog'));
  const sent = ordinaryTargets(ctx, details, dispatchRuntime(ctx));
  const { generation } = ctx.call('effects_assign', {
    targets: details.targets, assignments: details.assignments, revision, invalidate: Object.keys(sent), plan_order: planOrder,
  });
  // `object(...)` and `?? []` are gone: `planGroups` builds all five fields on
  // every path, so both could only fire for a stub, and `decodeGroupPlan` is
  // where that case is handled now -- strictly, rather than as an empty batch.
  const batch = ctx.call('effects_frame_plan', {
    targets: sent, catalog, timestamp: timestamp(ctx.now), ...transitionArgs(transitionCap(details)),
  });
  const light = ctx.call('effects_emit', { commands: batch.commands, revision, generation });
  const starts = bulbStartCommands(ctx, details, sent);
  const started: EmitOutcome = starts.length === 0 ? { published_at: [], completed: true }
    : ctx.call('effects_emit', { commands: starts, revision, generation });
  // `requireBoolean(emission.completed)`, `?? null` on the generation and
  // `?? []` on published_at are all gone: `emitCommands` builds both fields
  // every time and `assignEffects` already normalises an absent generation to
  // null, so none of the three could fire for the real handlers.
  if (!stillCurrent(ctx, 'ls_dispatch', revision, generation)) return null;
  const completed = light.completed && started.completed;
  if (Object.keys(sent).length > 0 && completed) recordApplied(ctx, sent, revision, generation);
  for (const parseSwitch of details.switches()) {
    const { entity, on } = parseSwitch();
    const state = on ? 'on' : 'off';
    if (revision === overridesRevision(ctx, 'ls_dispatch') && ctx.get(entity) !== state) {
      perform(ctx, { kind: 'service', service: `homeassistant.turn_${state}`, data: {}, target: { entity_id: entity },
        guard: { revision, generation } });
    }
  }
  if (revision !== overridesRevision(ctx, 'ls_dispatch')) return null;
  performTail(ctx, details, revision, generation);
  return { completed: completed && stillCurrent(ctx, 'ls_dispatch', revision, generation),
    published_at: [...light.published_at, ...started.published_at] };
}

/** The frame plan's transition arguments for a cap. */
function transitionArgs(cap: TransitionCap): { transition_cap: number | null; transition_rooms: StoredValue[] | null } {
  switch (cap.kind) {
    case 'none': return { transition_cap: null, transition_rooms: [] };
    case 'everywhere': return { transition_cap: 0.5, transition_rooms: null };
    case 'rooms': return { transition_cap: 0.5, transition_rooms: cap.rooms };
    default: {
      const unknown: never = cap;
      throw new Error(`Unhandled transition cap ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Record a complete output's lights as applied under the generation, guarded
 * on output success. An incomplete output records nothing, so `applied` keeps
 * what `effects_assign` left: the lamps it sent are not in it, and the next
 * dispatch sends them again, bulb-effect starts included.
 *
 * A member that was off (or unavailable) when its lamp was sent got nothing,
 * but its lamp is recorded: a lamp whose member is permanently dead would
 * otherwise never be recorded, and every sendable dispatch -- each tick of a
 * fade, every non-tick render -- would send the lamp again and restart the
 * candle on its live members. Known gap: such a member, back on while its lamp
 * stays on, waits for the lamp's next send (a target change, a request, or the
 * lamp itself coming back on, which `lamp_on` requests).
 */
function recordApplied(ctx: ScriptContext, sent: OpaqueMap, revision: string, generation: Verbatim): void {
  perform(ctx, { kind: 'service', service: 'variable.update_sensor',
    data: { value: generation, replace_attributes: false, attributes: { applied: { ...attributeMapping(ctx, runtime, 'applied'), ...sent } } },
    target: { entity_id: runtime }, guard: { revision, generation, requiresOutputSuccess: true } });
}

/** The room selects, the Sara mirror and the stale-key clear. Each mirror parses where it is sent. */
function performTail(ctx: ScriptContext, details: DispatchDetails, revision: string, generation: Verbatim): void {
  for (const parseMirror of details.mirrors()) {
    const mirror = parseMirror();
    perform(ctx, { kind: 'service', service: 'input_select.select_option', data: { option: mirror.option }, target: { entity_id: mirror.entity },
      guard: { revision, generation } });
  }
  const saraMirror = details.saraMirror;
  if (saraMirror === 'on' || saraMirror === 'off') {
    perform(ctx, { kind: 'service', service: `input_boolean.turn_${saraMirror}`, data: {}, target: { entity_id: 'input_boolean.ls_sara_mode_mirror' },
      guard: { revision, generation } });
  }
  const staleKeys = details.staleKeys();
  if (staleKeys.length > 0) {
    perform(ctx, { kind: 'event', event: 'ls_override', data: { op: 'clear', keys: staleKeys, via: 'rule_next_block',
      expected_revision: revision } });
  }
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
