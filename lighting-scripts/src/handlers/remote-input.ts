/**
 * `remote-input`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/remote-input.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { catalogOf, emptyCatalog } from '../runtime/catalog.ts';
import { typed } from '../runtime/entrypoints.ts';
import { parseRemotePlanArgs, remoteRoomPlan } from '../parse/remote-input.ts';
import { roomText } from '../parse/rooms.ts';
import { remoteDecision, remoteOpening } from '../domain/remote-input.ts';
import { pressCommand } from '../domain/types/remote.ts';
import type { RemotePlanRequest, RemotePlan } from '../domain/remote-input.ts';

/**
 * Store button-domain intent; rendered brightness/color belong to the resolver.
 *
 * Read, then the two inter-handler runs the command needs (the room plan for
 * its context, the catalog for three commands), then decide on the house as
 * it stands after them.
 */
export function remotePlan(ctx: ScriptContext, args: RemotePlanRequest): RemotePlan {
  const opening = remoteOpening(ctx, args);
  const plan = remoteRoomPlan(opening.needsContext ? ctx.run('ls_room_plan', { room: roomText(opening.room), overrides: opening.overrides.document,
    cache: opening.cache, reason: 'remote' }) : undefined);
  // The captured script calls effects_catalog only for these three commands.
  const command = pressCommand(args.command);
  const catalog = command === 'toggle' || command === 'left' || command === 'right' ? catalogOf(ctx) : emptyCatalog();
  return remoteDecision(ctx, args, opening, plan, catalog);
}
export const remoteInputHandlers: ScriptHandlers = {
  ls_remote_plan: typed('ls_remote_plan', { parse: parseRemotePlanArgs, run: remotePlan }),
};
