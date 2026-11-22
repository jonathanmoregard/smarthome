/**
 * The switch profile codec: a plug's own on/off for one block, read from the
 * store a lamp's profile lives in (`input_text.ls_lamp_<object>_<block>`),
 * as `savedProfile` reads it for a plug: `own` by Jinja truthiness (absent is
 * false) and `on` by Home Assistant's `| bool`, absent or rejected read as off.
 * A store that is not a mapping follows the room. Garbage recovers, never raises.
 */
import type { SwitchProfile } from '../../domain/model.ts';
import { haBooleanOr } from '../../parse/state-store.ts';
import { jinjaTruthy } from '../../runtime/parse.ts';
import { storeOf } from './lamp-profiles.ts';

/** A store that does not own the plug's setting: the plug follows its room's block setting. */
export const FOLLOWS_ROOM_SWITCH: SwitchProfile = { follows: 'room' };

/** A plug's saved power the store leaves out or the bool filter rejects: off, today's `savedProfile` default. */
const UNSAID_POWER = false;

export function decodeSwitchProfile(storeText: string): SwitchProfile {
  const store = storeOf(storeText);
  if (store === undefined || !jinjaTruthy(store['own'])) return FOLLOWS_ROOM_SWITCH;
  const on = store['on'] === undefined ? UNSAID_POWER : haBooleanOr(store['on'], UNSAID_POWER);
  return { follows: 'own', power: on ? 'on' : 'off' };
}
