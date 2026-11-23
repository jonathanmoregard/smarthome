/**
 * The switch profile codec: a plug's own on/off for one block, read from the
 * store a lamp's profile lives in (`input_text.ls_lamp_<object>_<block>`),
 * as `savedProfile` reads it for a plug: `own` by Jinja truthiness (absent is
 * false) and `on` by Home Assistant's `| bool`, absent or rejected read as off,
 * kept while the plug follows its room. A store that is not a mapping follows
 * the room. Garbage recovers, never raises. Writing keeps the stored text
 * exactly when the profile did not change, and otherwise sets only `own` and
 * `on`, where they changed, over the stored fields, as `ls_store` does.
 */
import type { SwitchProfile } from '../../domain/model.ts';
import { haBooleanOr } from '../../runtime/parse.ts';
import { jinjaTruthy } from '../../runtime/parse.ts';
import { storeOf } from './lamp-profiles.ts';
import { isDeepStrictEqual } from 'node:util';

/** A plug's saved power the store leaves out or the bool filter rejects: off, today's `savedProfile` default. */
const UNSAID_POWER = false;

/** A store that is not a mapping: the plug follows its room's block setting, and its own power is the unsaid one. */
export const FOLLOWS_ROOM_SWITCH: SwitchProfile = { follows: 'room', power: UNSAID_POWER ? 'on' : 'off' };

/** The store's text with this profile written in: the found text when the profile did not change. */
export function encodeSwitchProfile(profile: SwitchProfile, foundText: string): string {
  const before = decodeSwitchProfile(foundText);
  if (isDeepStrictEqual(before, profile)) return foundText;
  const found = storeOf(foundText);
  const own = before.follows === profile.follows ? {} : { own: profile.follows === 'own' };
  const on = before.power === profile.power ? {} : { on: profile.power === 'on' };
  return JSON.stringify({ ...(found === undefined ? {} : found), ...on, ...own });
}

export function decodeSwitchProfile(storeText: string): SwitchProfile {
  const store = storeOf(storeText);
  if (store === undefined) return FOLLOWS_ROOM_SWITCH;
  const on = store['on'] === undefined ? UNSAID_POWER : haBooleanOr(store['on'], UNSAID_POWER);
  return { follows: jinjaTruthy(store['own']) ? 'own' : 'room', power: on ? 'on' : 'off' };
}
