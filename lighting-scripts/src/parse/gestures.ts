/**
 * Parsing for `ls_remote_gesture` and `ls_remote_power_quiet`.
 *
 * Captured command is membership-tested, token is length-tested, and payload is
 * dereferenced only by preset. The command is parsed into the reducer's `Msg`
 * here; any other command is none. Missing command/token are empty; malformed
 * present values raise, and the sender is a thunk so it raises only where a
 * command is sent, in source order.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaFloat, jinjaInt, lazy, ParseError, requireString } from '../runtime/parse.ts';
import { carry } from '../runtime/verbatim.ts';
import type { RoomId } from '../domain/types/ids.ts';
import { toRemoteId, toRoomId } from './ids.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import type { GestureRequest, Model, Msg, PresetPayload } from '../legacy/domain/gestures.ts';

export interface PowerQuietRequest {
  /** The whole argument document, forwarded into the scheduled `power_done`. */
  document: Verbatim;
  room: RoomId;
}

/**
 * The quiet script forwards its whole argument document into the scheduled
 * `power_done`, which is compared, so the document is carried unread.
 */
export function parsePowerQuietArgs(args: JsonObject): PowerQuietRequest {
  return { document: carry(args), room: roomArg(args) };
}

export function parseGestureArgs(args: JsonObject): GestureRequest {
  // Read in the captured order: the command, the room, then the token.
  const command = args.command === undefined ? '' : requireString(args, 'command', 'ls_remote_gesture');
  const room = roomArg(args);
  return {
    room,
    msg: gestureMsg(command, args),
    // A present sender field is still typed, but read only where a command is sent.
    sender: lazy(() => ({
      deviceId: args.device_id === undefined ? undefined : toRemoteId(requireString(args, 'device_id', 'ls_remote_gesture')),
      source: args.source === undefined ? '' : requireString(args, 'source', 'ls_remote_gesture'),
    })),
  };
}

function roomArg(args: JsonObject): RoomId {
  const room = requireString(args, 'room', 'ls_remote_gesture');
  if (!/^[a-z0-9_]+$/.test(room)) throw new ParseError('Gesture room must be a runtime room ID');
  return toRoomId(room);
}

/**
 * A command as the reducer's message. A missing command is empty, and empty
 * or any other text is no message: the captured script tests membership and
 * does nothing. `power_done` is the combo's quiet window closing, and only it
 * reads a token (missing is empty, as under the captured length test).
 */
function gestureMsg(command: string, args: JsonObject): Msg | undefined {
  switch (command) {
    case 'left': case 'right': case 'up': case 'down': return { tag: 'direction', direction: command };
    case 'cancel': return { tag: 'cancel' };
    case 'power': return { tag: 'power' };
    case 'preset': return { tag: 'preset', payload: presetPayload(args.payload) };
    case 'power_done':
      return { tag: 'combo_timeout', token: args.token === undefined ? '' : requireString(args, 'token', 'ls_remote_gesture') };
    default: return undefined;
  }
}

/**
 * A remote publishes whatever JSON it likes, and only a mapping can carry a
 * preset action. The preserved scenario enumerates the real domain -- none,
 * [], {}, and mappings whose action does not match -- and the captured script
 * dispatches nothing for every one of them without raising. So a non-mapping
 * payload is not malformed input to reject; it is an event that is not a
 * preset payload, which is genuine optionality.
 *
 * `action` is only compared with a literal and `action_color_temperature` only
 * passes an `is number` test, so a value of any other type is `undefined`: it
 * fails the comparison and the test exactly as the raw value did. No coercion,
 * so `'200'` stays not-a-preset.
 */
function presetPayload(value: JsonValue | undefined): PresetPayload | undefined {
  if (!isObject(value)) return undefined;
  const action = value.action, preset = value.action_color_temperature;
  return {
    action: typeof action === 'string' ? action : undefined,
    preset: typeof preset === 'number' ? preset : undefined,
  };
}

/**
 * The remote's helpers as the gesture reads them, all before its first write.
 * None of these reads can raise, so reading the preset cursor up front -- the
 * captured script reads it only on the preset branch, before any write there --
 * changes nothing observable.
 */
export function gestureState(ctx: HouseView, room: RoomId): Model {
  const prefix = `ls_${room}_remote_`;
  const saved = ctx.get(`input_text.${prefix}power_token`);
  return {
    chordStep: helperInt(ctx, `input_number.${prefix}chord_step`),
    chordActive: ctx.get(`timer.${prefix}chord`) === 'active',
    powerCount: helperInt(ctx, `input_number.${prefix}power_count`),
    powerToken: ['unknown', 'unavailable'].includes(saved) ? '' : saved,
    // Captured `states(...)|float(-2)`: a fractional cursor is kept, never truncated to an index.
    preset: jinjaFloat(ctx.get(`input_number.${prefix}preset`), -2),
  };
}

/** A gesture helper's state as the captured script reads it: `states(helper) | int(fallback)`. */
export function helperInt(ctx: HouseView, entity: string, fallback = 0): number {
  return jinjaInt(ctx.get(entity), fallback);
}
