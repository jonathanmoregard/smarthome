/**
 * `schedule`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/legacy/domain/schedule.ts`.
 */
import type { ScriptHandlers } from '../runtime/context.ts';
import { typed } from '../runtime/entrypoints.ts';
import { parseBaseArgs, parseRoomBaseArgs } from '../parse/schedule.ts';
import { scheduledBase } from '../legacy/domain/schedule.ts';

export const scheduleHandlers: ScriptHandlers = {
  ls_base: typed('ls_base', { parse: parseBaseArgs, run: scheduledBase }),
  ls_room_base: typed('ls_room_base', { parse: parseRoomBaseArgs, run: (ctx, args) => scheduledBase(ctx, args, true) }),
};
