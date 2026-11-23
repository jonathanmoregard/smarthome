/**
 * The reconciler (spec 5.3): make the bulbs and switches show the lighting
 * state. The domain says what each lamp should show; this decides what to
 * send to get the bulbs there, and the encoder turns a send into publishes.
 * The reconciler is also the effect manager: it starts the candle, stops it,
 * and starts it again after a level or colour change.
 *
 * A bulb is sent its target when the target differs from what it is believed
 * to show (what it was last sent), or, once that send has settled, from what
 * it is observed to show, within the tolerances. The candle is not reported,
 * so it is known from the belief only, and a bulb believed to run it is
 * checked against its report for its power only. With no belief (a restart,
 * a forgotten or a failed send) the report is all there is: a bulb that shows
 * its target is sent nothing, and the candle, which no report shows, is
 * started alone; a candle-firmware bulb under a normal lit target is sent the
 * stop and its light, since a leftover candle's flicker hides in its report.
 * Only a bulb that cannot be reached (switched off at the wall) and every
 * bulb while Zigbee2MQTT is disconnected are sent nothing. A switch is sent
 * its target when it reports otherwise.
 *
 * Retries, parking and the flap limit (reconciler spec, sections 2 and 3): a
 * failed send is sent again after 1 s, doubling up to 60 s; the fifth failure
 * in a row parks the bulb. A bulb sent the same light again six times in ten
 * minutes is parked too. A parked bulb is sent nothing until it comes back on
 * from out of reach (its wall power) or its light changes, and is logged once:
 * a parked bulb's off to on in reach is the echo of the put-back that parked
 * it, or someone else's, and either way not ours to fight. A bulb that comes
 * back on (from off or out of reach, and nothing we sent explains it) is sent
 * its light with the short fade, then the candle's start.
 */
import type { Observed, ObservedBulb, ObservedLight } from './observed.ts';
import type { Config } from '../domain/config.ts';
import { bulbAppearance } from '../domain/effect.ts';
import type { BulbAppearance, BulbInfo } from '../domain/effect.ts';
import type { BulbId, SwitchId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { LightingState } from '../domain/types/lighting-state.ts';
import type { Colour, LampLight, Power, RGB } from '../domain/types/light.ts';
import type { Instant, Seconds } from '../domain/types/time.ts';
import { toInstant, toSeconds } from './codecs/ids.ts';

/**
 * One thing to send: a bulb's light (`stopFirst`: it is leaving the candle,
 * or may run one from before), the candle's start alone on a bulb that
 * already shows the candle's light, or a switch's power.
 */
export type Send =
  | { kind: 'bulb'; bulb: BulbId; appearance: BulbAppearance; over: Seconds; stopFirst: boolean }
  | { kind: 'start'; bulb: BulbId; appearance: LitAppearance }
  | { kind: 'switch'; switch: SwitchId; power: Power };

/**
 * The send a bulb nothing is held about needs: nothing when it shows its target; the candle's start alone when it
 * shows the candle's light; the stop and its light for a candle-firmware bulb under a normal lit target, whose report
 * cannot tell a leftover candle; its light otherwise, with the stop first when it may run a candle.
 */
function unknownSend(appearance: BulbAppearance, bulb: BulbInfo, reported: ObservedLight, full: (stopFirst: boolean) => Send,
  start: Send | undefined): Send | undefined {
  if (start !== undefined && runsCandle(appearance)) return reportsShowing(reported, appearance) ? start : full(false);
  // The one exception to "a restart sends nothing a bulb already shows": a candle-firmware bulb under a normal lit
  // target is sent the stop and its light even when its report shows that light, since a candle left running from
  // before cannot be told from its report (its flicker hides in the level and colour).
  if (bulb.firmware === 'candle' && appearance.power === 'on') return full(true);
  return reportsShowing(reported, appearance) ? undefined : full(bulb.firmware === 'candle');
}

/** A send's transition: a start alone has none. */
function overOf(send: Extract<Send, { kind: 'bulb' | 'start' }>): Seconds {
  return send.kind === 'bulb' ? send.over : SWITCHED;
}

export type LitAppearance = Extract<BulbAppearance, { power: 'on' }>;

function sameLight(a: LitAppearance, b: LitAppearance): boolean {
  return a.level === b.level && sameSentColour(a.colour, b.colour);
}

function sameSentColour(a: Colour | undefined, b: Colour | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'kelvin') return b.kind === 'kelvin' && a.kelvin === b.kelvin;
  if (b.kind === 'kelvin') return false;
  return a.rgb.red === b.rgb.red && a.rgb.green === b.rgb.green && a.rgb.blue === b.rgb.blue;
}

/** How a send went: every publish went out; its light (or off) failed; or its light went out and the candle's start failed. */
export type Outcome = 'sent' | 'failed' | 'start failed';

/** A reported level this many steps from the target is the target: HA's 0..255 against the Zigbee 1..254 round trip. */
export const LEVEL_TOLERANCE = 2;
/** A reported colour temperature this many kelvin from the target is the target: kelvin is sent as whole mireds. */
export const KELVIN_TOLERANCE = 50;
/** A reported RGB colour within this CIE 1931 xy distance of the target is the target. */
export const XY_TOLERANCE = 0.01;
/** How long after a send's transition a report still may not show it. To be measured against a real bulb (M4). */
export const SETTLE_MARGIN: Seconds = toSeconds(2);
/** The fade of a change made at once, and of a bulb coming back on. */
export const MANUAL_FADE: Seconds = toSeconds(0.2);
/** The fade of an off by a room's power switch: none, as today's `homeassistant.turn_off`. */
export const SWITCHED: Seconds = toSeconds(0);
/** The fade of a light the candle's start follows. */
export const EFFECT_START_FADE: Seconds = toSeconds(0.4);
/** The wait after a first failed send; it doubles with each failure after it. */
export const RETRY_FIRST: Seconds = toSeconds(1);
/** The longest wait between two sends of a failing bulb. */
export const RETRY_CAP: Seconds = toSeconds(60);
/** The failed sends in a row that park a bulb. */
export const MAX_ATTEMPTS = 5;
/** The put-backs within {@link REAPPLY_WINDOW} that park a bulb. */
export const REAPPLY_LIMIT = 6;
export const REAPPLY_WINDOW: Seconds = toSeconds(600);

/**
 * What the reconciler holds about one bulb.
 * 1. `sent`: it was sent `shows` at `sentAt`, and its report should show it from `settlesAt`. `reapplies` are the
 *    times within the flap window it was sent that same light again because it reported something else.
 * 2. `retrying`: its last `attempts` sends failed, and it is sent again from `retryAt`. `shows` is the light it is
 *    known to show when only the candle's start failed; otherwise what it shows is not known.
 * 3. `parked`: given up on, after too many failed sends or put-backs: sent nothing until it comes back on from out
 *    of reach or its light changes from `lastSent`.
 * 4. `back on`: it came back on, and is owed its light with the short fade.
 * No belief at all is a bulb never sent anything, or whose belief was forgotten.
 */
export type Belief =
  | { kind: 'sent'; shows: BulbAppearance; sentAt: Instant; settlesAt: Instant; reapplies: readonly Instant[] }
  | { kind: 'retrying'; shows: LitAppearance | undefined; attempts: Attempts; retryAt: Instant }
  | { kind: 'parked'; lastSent: BulbAppearance }
  | { kind: 'back on' };

/** The failed sends in a row so far: fewer than {@link MAX_ATTEMPTS}, whose failure parks the bulb. */
export type Attempts = 1 | 2 | 3 | 4;

/** Each bulb's belief, and each switch sent its power that has not yet been seen to show it. */
export type Beliefs = { bulbs: Record<BulbId, Belief>; switches: Record<SwitchId, SwitchSent> };

/**
 * The beliefs without those of `bulbs`, so the next pass sends them what they do not show, the candle's start
 * included. Today's dispatch sends a lamp it was asked for (switched back on, or handed to the port).
 */
export function forgotten(beliefs: Beliefs, bulbs: readonly BulbId[]): Beliefs {
  const forget = new Set(bulbs);
  return { ...beliefs, bulbs: Object.fromEntries(entriesOf(beliefs.bulbs).filter(([bulb]) => !forget.has(bulb))) };
}

export const NO_BELIEFS: Beliefs = { bulbs: {}, switches: {} };

/** The beliefs with `bulbs` back on: each is owed its light with the short fade, and is no longer parked. */
export function backOn(beliefs: Beliefs, bulbs: readonly BulbId[]): Beliefs {
  const back: Record<BulbId, Belief> = { ...beliefs.bulbs };
  for (const bulb of bulbs) back[bulb] = { kind: 'back on' };
  return { ...beliefs, bulbs: back };
}

/**
 * The beliefs without the switch sends that are over: one `observed` shows landed (the switch shows what we sent,
 * changed at or after the send, or with no `last_changed` to say when), and one whose power the target has moved off
 * (it may never have landed, and a later change to its power must not be taken for ours). Past either, a change of
 * the switch is not ours.
 */
export function switchesSeen(beliefs: Beliefs, observed: Observed, target: Readonly<Record<SwitchId, Power>>): Beliefs {
  return { ...beliefs, switches: Object.fromEntries(entriesOf(beliefs.switches).filter(([plug, sent]) => {
    const changed = observed.switchChanged[plug];
    const landed = observed.switches[plug] === sent.power && (changed === undefined || changed >= sent.sentAt);
    return !landed && target[plug] === sent.power;
  })) };
}

/** The bulbs parked in `after` that were not in `before`: each is logged once, when it is given up on. */
export function newlyParked(before: Beliefs, after: Beliefs): BulbId[] {
  return entriesOf(after.bulbs).flatMap(([bulb, belief]) => belief.kind === 'parked' && before.bulbs[bulb]?.kind !== 'parked' ? [bulb] : []);
}

/** The first retry due after `now`, if any bulb is being retried. */
export function nextRetry(beliefs: Beliefs, now: Instant): Instant | undefined {
  const due = entriesOf(beliefs.bulbs).flatMap(([, belief]) => belief.kind === 'retrying' && belief.retryAt > now ? [belief.retryAt] : []);
  return due.length === 0 ? undefined : toInstant(Math.min(...due));
}

/**
 * The bulbs whose power-on between two observations a send of ours explains: off and in reach before, on now, and
 * last sent a light (the put-back that parked it included). Its report is our own put-back's, so what is held about
 * it stays: its put-backs, or its parking.
 */
export function litByUs(before: Observed, after: Observed, beliefs: Beliefs): BulbId[] {
  return entriesOf(after.bulbs).flatMap(([bulb, now]) => {
    const was = before.bulbs[bulb], belief = beliefs.bulbs[bulb];
    const lit = was !== undefined && was.reach === 'reachable' && was.light.power === 'off' && now.reach === 'reachable'
      && now.light.power === 'on';
    const sentLit = belief !== undefined && (belief.kind === 'sent' ? belief.shows.power === 'on'
      : belief.kind === 'parked' && belief.lastSent.power === 'on');
    return lit && sentLit ? [bulb] : [];
  });
}

/** A switch we sent `power` at `sentAt`, not yet seen to land. */
export type SwitchSent = { power: Power; sentAt: Instant };

/**
 * Is a switch showing `power` its own button pressed? Only one that could be reached at the last look: a switch back
 * from out of reach has a fresh `last_changed`, and is a return, sent its target as usual (Amendment 8.1).
 * 1. With a send of ours still open and HA's `last_changed`: when it shows another power than we sent, changed after
 *    the send. A switch showing what we sent is ours, whenever it changed. This catches a press made between our
 *    send and the next look, which the last look alone cannot (it may show the same power as before the send).
 * 2. Otherwise, as before `last_changed` was read (the harness sends none): when it changed since the last look to a
 *    power no open send of ours asked for.
 * M5 may replace the first rule with a switch change as a live input of its own (option A of the M4 review), once
 * the host owns HA's event stream.
 */
function switchPressed(was: Power | 'unreachable' | undefined, power: Power, sent: SwitchSent | undefined,
  changed: Instant | undefined): boolean {
  if (was === undefined || was === 'unreachable') return false;
  if (sent !== undefined && changed !== undefined) return power !== sent.power && changed > sent.sentAt;
  return was !== power && (sent === undefined || sent.power !== power);
}

/** What an observation that nothing we sent explains means. */
export type Unexplained = { kind: 'switch pressed'; switch: SwitchId; power: Power } | { kind: 'bulb back on'; bulb: BulbId };

/** What to send now to make the house show `target`, and when to look again: the first retry due, if any. */
export function nextSends(target: LightingState, config: Config, observed: Observed, beliefs: Beliefs, now: Instant):
  { sends: Send[]; wakeAt: Instant | undefined } {
  const sends: Send[] = [];
  if (observed.bridgeConnected) {
    for (const [lamp, light] of entriesOf(target.lamps)) {
      const info = config.lamps[lamp];
      if (info === undefined) continue;
      for (const bulb of info.bulbs) {
        const send = bulbSend(light, bulb, observed.bulbs[bulb.bulb], beliefs.bulbs[bulb.bulb], now);
        if (send !== undefined) sends.push(send);
      }
    }
  }
  for (const [plug, power] of entriesOf(target.switches)) {
    const reported = observed.switches[plug];
    if (reported !== undefined && reported !== 'unreachable' && reported !== power) sends.push({ kind: 'switch', switch: plug, power });
  }
  return { sends, wakeAt: firstRetry(sends, beliefs, now) };
}

/** The send one bulb needs, if any, by what is held about it. */
function bulbSend(light: LampLight, bulb: BulbInfo, observed: ObservedBulb | undefined, belief: Belief | undefined, now: Instant):
  Send | undefined {
  if (observed === undefined || observed.reach === 'unreachable') return undefined;
  const appearance = bulbAppearance(light, bulb);
  const full = (stopFirst: boolean, over: Seconds = fadeOf(light, appearance)): Send =>
    ({ kind: 'bulb', bulb: bulb.bulb, appearance, over, stopFirst });
  const start = appearance.power === 'on' ? { kind: 'start' as const, bulb: bulb.bulb, appearance } : undefined;
  if (belief === undefined) return unknownSend(appearance, bulb, observed.light, full, start);
  switch (belief.kind) {
    case 'back on': return full(false, runsCandle(appearance) ? EFFECT_START_FADE : MANUAL_FADE);
    case 'parked': return sameAppearance(belief.lastSent, appearance) ? undefined : unknownSend(appearance, bulb, observed.light, full, start);
    case 'retrying':
      if (now < belief.retryAt) return undefined;
      return start !== undefined && belief.shows !== undefined && startsOnly(belief.shows, appearance) ? start
        : full(bulb.firmware === 'candle' && !runsCandle(appearance));
    case 'sent': {
      const settled = now >= belief.settlesAt;
      if (sameAppearance(belief.shows, appearance) && !(settled && !reportsSettled(observed.light, appearance))) return undefined;
      if (start !== undefined && startsOnly(belief.shows, appearance) && (!settled || reportsShowing(observed.light, appearance))) return start;
      return full(runsCandle(belief.shows) && !runsCandle(appearance));
    }
  }
}

/**
 * The send's fade: an off by a room's power switch none, a light the candle's
 * start follows the effect start's fade, a step of a scheduled fade its step,
 * anything else (any other off included) the manual fade.
 */
function fadeOf(light: LampLight, appearance: BulbAppearance): Seconds {
  if (light.power === 'off') return light.transition.kind === 'switch' ? SWITCHED : MANUAL_FADE;
  if (runsCandle(appearance)) return EFFECT_START_FADE;
  return light.transition.kind === 'scheduled fade' ? light.transition.over : MANUAL_FADE;
}

function runsCandle(appearance: BulbAppearance): boolean {
  return appearance.power === 'on' && appearance.firmwareEffect === 'candle';
}

/** Exactly what was sent: the belief is a send, so it is compared as one. */
function sameAppearance(a: BulbAppearance, b: BulbAppearance): boolean {
  if (a.power === 'off' || b.power === 'off') return a.power === b.power;
  return sameLight(a, b) && a.firmwareEffect === b.firmwareEffect;
}

/** The bulb shows the candle's light without the candle: the start alone gets it there. */
function startsOnly(shows: BulbAppearance, appearance: BulbAppearance): boolean {
  return runsCandle(appearance) && shows.power === 'on' && appearance.power === 'on' && shows.firmwareEffect === 'none'
    && sameLight(shows, appearance);
}

/**
 * Does a settled bulb's report show the appearance? A bulb running the candle is checked for its power only: the
 * candle is known from the belief, and its flicker moves the reported level and colour.
 */
function reportsSettled(reported: ObservedLight, appearance: BulbAppearance): boolean {
  return runsCandle(appearance) ? reported.power === 'on' : reportsShowing(reported, appearance);
}

/** Does the report show the appearance's light, within the tolerances? A lamp with no colour leaves the bulb's colour out of it. */
function reportsShowing(reported: ObservedLight, appearance: BulbAppearance): boolean {
  if (appearance.power === 'off' || reported.power === 'off') return appearance.power === reported.power;
  if (Math.abs(reported.level - appearance.level) > LEVEL_TOLERANCE) return false;
  return appearance.colour === undefined || closeColour(reported.colour, appearance.colour);
}

function closeColour(reported: Colour | undefined, wanted: Colour): boolean {
  if (reported === undefined) return false;
  if (wanted.kind === 'kelvin') return reported.kind === 'kelvin' && Math.abs(reported.kelvin - wanted.kelvin) <= KELVIN_TOLERANCE;
  if (reported.kind === 'kelvin') return false;
  const [x1, y1] = chromaticity(reported.rgb), [x2, y2] = chromaticity(wanted.rgb);
  return Math.hypot(x1 - x2, y1 - y2) <= XY_TOLERANCE;
}

/**
 * sRGB to CIE 1931 xy (IEC 61966-2-1): undo the transfer curve, to XYZ with
 * the D65 matrix, then x = X/(X+Y+Z), y = Y/(X+Y+Z). Black has no
 * chromaticity and takes the D65 white point.
 */
function chromaticity(rgb: RGB): readonly [number, number] {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(rgb.red), g = linear(rgb.green), b = linear(rgb.blue);
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const total = x + y + z;
  return total === 0 ? [0.3127, 0.3290] : [x / total, y / total];
}

/** The attempts after one more failure, by the failures before it; past the table, the bulb is parked. */
const NEXT_ATTEMPT: readonly (Attempts | undefined)[] = [1, 2, 3, 4, undefined];

/**
 * The first retry due after `now` of a bulb this pass does not send to. A settling send asks for no wake: the
 * minute's tick compares it with its report, as today's scripts did (a wake seconds after every send would move the
 * house's clock under the harness's checkpoints, M3 T3-A).
 */
function firstRetry(sends: readonly Send[], beliefs: Beliefs, now: Instant): Instant | undefined {
  const resent = new Set(sends.flatMap(send => send.kind === 'switch' ? [] : [send.bulb]));
  return nextRetry({ ...beliefs, bulbs: Object.fromEntries(entriesOf(beliefs.bulbs).filter(([bulb]) => !resent.has(bulb))) }, now);
}

/**
 * The beliefs after a send. Sent: what was sent is believed, and a send of the light the bulb was already believed
 * to show is a put-back, the sixth of which within the window parks it. Failed: what it shows is no longer known
 * (every member of a failed group publish), and it is retried after the backoff, the fifth failure parking it; when
 * only the candle's start failed, its light is still known. A switch's failed send is left for the next pass.
 */
export function afterSend(beliefs: Beliefs, send: Send, outcome: Outcome, now: Instant): Beliefs {
  switch (send.kind) {
    case 'bulb': case 'start':
      return { ...beliefs, bulbs: { ...beliefs.bulbs, [send.bulb]: bulbAfter(beliefs.bulbs[send.bulb], send, outcome, now) } };
    case 'switch':
      return outcome === 'sent' ? { ...beliefs, switches: { ...beliefs.switches, [send.switch]: { power: send.power, sentAt: now } } } : beliefs;
  }
}

function bulbAfter(before: Belief | undefined, send: Extract<Send, { kind: 'bulb' | 'start' }>, outcome: Outcome, now: Instant): Belief {
  if (outcome === 'sent') {
    const recent = before?.kind === 'sent' ? before.reapplies.filter(at => now - at < REAPPLY_WINDOW) : [];
    const putBack = before?.kind === 'sent' && sameAppearance(before.shows, send.appearance);
    const reapplies = putBack ? [...recent, now] : recent;
    if (reapplies.length >= REAPPLY_LIMIT) return { kind: 'parked', lastSent: send.appearance };
    return { kind: 'sent', shows: send.appearance, sentAt: now, settlesAt: settlesAt(now, overOf(send)), reapplies };
  }
  const attempts = NEXT_ATTEMPT[before?.kind === 'retrying' ? before.attempts : 0];
  if (attempts === undefined) return { kind: 'parked', lastSent: send.appearance };
  const known = outcome === 'start failed' || send.kind === 'start';
  return { kind: 'retrying', shows: known && send.appearance.power === 'on' ? { ...send.appearance, firmwareEffect: 'none' } : undefined,
    attempts, retryAt: toInstant(now + Math.min(RETRY_CAP, RETRY_FIRST * 2 ** (attempts - 1))) };
}

function settlesAt(now: Instant, over: Seconds): Instant {
  return toInstant(now + over + SETTLE_MARGIN);
}

/**
 * What changed between two observations that nothing we sent explains. A switch that changed to a power no send of
 * ours still waiting to be seen asked for is the plug's own button (see {@link switchPressed}). A bulb that came on from out of reach, or from
 * off where no send of ours lit it, came back on.
 */
export function unexplained(before: Observed, after: Observed, beliefs: Beliefs): Unexplained[] {
  const found: Unexplained[] = [];
  for (const [plug, power] of entriesOf(after.switches)) {
    if (power !== 'unreachable' && switchPressed(before.switches[plug], power, beliefs.switches[plug], after.switchChanged[plug])) {
      found.push({ kind: 'switch pressed', switch: plug, power });
    }
  }
  const ours = new Set(litByUs(before, after, beliefs));
  for (const [bulb, now] of entriesOf(after.bulbs)) {
    const was = before.bulbs[bulb];
    if (was === undefined || now.reach === 'unreachable' || now.light.power === 'off' || ours.has(bulb)) continue;
    if (was.reach === 'unreachable' || was.light.power === 'off') found.push({ kind: 'bulb back on', bulb });
  }
  return found;
}
