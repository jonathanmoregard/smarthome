/**
 * `gestures`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/gestures.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { gestureState, parseGestureArgs, parsePowerQuietArgs } from '../parse/gestures.ts';
import { run } from '../runtime/effects.ts';
import * as Gesture from '../domain/gestures.ts';

/**
 * Serialized actor. It never waits for actuator services or the power quiet
 * window. Reads the helpers, runs the reducer, then, for a power press, stamps
 * the token and launches the quiet script with `now` re-read after each write,
 * where the captured script reads it: the clock is live mid-transaction.
 */
export function remoteGesture(ctx: ScriptContext, args: Gesture.GestureArgs): null {
  const { room, msg, sender } = args;
  if (msg === undefined) return null;
  run(ctx, Gesture.update(gestureState(ctx, room), msg, { room, remoteRooms: ctx.rooms.ofRemote, now: ctx.now, sender }));
  if (msg.tag === 'power') {
    run(ctx, Gesture.stampPowerToken(room, ctx.now));
    run(ctx, Gesture.launchPowerQuiet(room, ctx.now));
  }
  return null;
}
export const gestureHandlers: ScriptHandlers = {
  // Captured command is membership-tested, token is length-tested, and payload
  // is dereferenced only by preset. Missing command/token are empty; malformed
  // present values raise, and branch-specific fields retain source order.
  ls_remote_gesture: withParsedArgs({ parse: parseGestureArgs, run: remoteGesture }),
  ls_remote_power_quiet: withParsedArgs({ parse: parsePowerQuietArgs, run: (ctx, args) => run(ctx, Gesture.powerQuiet(args)) }),
};
