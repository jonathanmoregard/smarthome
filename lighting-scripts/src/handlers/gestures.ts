/**
 * `gestures`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/gestures.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { withFields } from '../runtime/verbatim.ts';
import { gestureState, parseGestureArgs, parsePowerQuietArgs } from '../parse/gestures.ts';
import type { PowerQuietArgs } from '../parse/gestures.ts';
import { run } from '../runtime/effects.ts';
import type { Plan } from '../runtime/effects.ts';
import type { RoomId } from '../domain/types/ids.ts';
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
    run(ctx, launchPowerQuiet(room, ctx.now));
  }
  return null;
}
/**
 * Launch the restartable quiet script. The host runs it; keeping the HA service
 * boundary lets the same recorder and event router execute this actor.
 */
export function* launchPowerQuiet(room: RoomId, now: string): Plan<void> {
  yield {
    kind: 'service', service: 'script.turn_on',
    data: { variables: { token: now } }, target: { entity_id: `script.ls_remote_power_quiet_${room}` },
  };
}
/** The quiet window: schedule `power_done` with the whole argument document carried. */
export function* powerQuiet(args: PowerQuietArgs): Plan<null> {
  yield { kind: 'schedule', script: 'ls_remote_gesture', args: withFields(args.document, { room: args.room, command: 'power_done' }), delayMs: 600 };
  return null;
}
export const gestureHandlers: ScriptHandlers = {
  // Captured command is membership-tested, token is length-tested, and payload
  // is dereferenced only by preset. Missing command/token are empty; malformed
  // present values raise, and branch-specific fields retain source order.
  ls_remote_gesture: withParsedArgs({ parse: parseGestureArgs, run: remoteGesture }),
  ls_remote_power_quiet: withParsedArgs({ parse: parsePowerQuietArgs, run: (ctx, args) => run(ctx, powerQuiet(args)) }),
};
