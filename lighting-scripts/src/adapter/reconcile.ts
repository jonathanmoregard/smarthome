/**
 * The reconciler's core rule (spec 5.3): make the bulbs and switches show the
 * lighting state. The domain says what each lamp should show; this decides
 * what to send to get the bulbs there, and the encoder turns a send into
 * publishes. The reconciler is also the effect manager: it starts the
 * candle, stops it, and starts it again after a level or colour change.
 *
 * A bulb is sent its target when the target differs from what it is believed
 * to show (what it was last sent), or, once that send has settled, from what
 * it is observed to show, within the tolerances. The candle is not reported,
 * so it is known from the belief only. A bulb that cannot be reached, one that
 * reports off, and every bulb while Zigbee2MQTT is disconnected are sent
 * nothing: today's dispatch sends only to bulbs Home Assistant shows on. A
 * switch is sent its target when it reports otherwise.
 *
 * Retries, parking, the flap limit, the fade for a bulb coming back on and a
 * plug's own button come in M4.
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
import { toInstant, toSeconds } from '../parse/ids.ts';

/** One thing to send. `stopFirst`: the bulb is leaving the candle. */
export type Send =
  | { kind: 'bulb'; bulb: BulbId; appearance: BulbAppearance; over: Seconds; stopFirst: boolean }
  | { kind: 'switch'; switch: SwitchId; power: Power };

/** What a bulb was last sent, and from when its report should show it. */
export type Belief = { shows: BulbAppearance; sentAt: Instant; settlesAt: Instant };
export type Beliefs = { bulbs: Record<BulbId, Belief>; switches: Record<SwitchId, { power: Power; sentAt: Instant }> };

export const NO_BELIEFS: Beliefs = { bulbs: {}, switches: {} };

/** A reported level this many steps from the target is the target: HA's 0..255 against the Zigbee 1..254 round trip. */
export const LEVEL_TOLERANCE = 2;
/** A reported colour temperature this many kelvin from the target is the target: kelvin is sent as whole mireds. */
export const KELVIN_TOLERANCE = 50;
/** A reported RGB colour within this CIE 1931 xy distance of the target is the target. */
export const XY_TOLERANCE = 0.01;
/** How long after a send's transition a report still may not show it. To be measured against a real bulb (M4). */
export const SETTLE_MARGIN: Seconds = toSeconds(2);
/** The fade of a change made at once. */
export const MANUAL_FADE: Seconds = toSeconds(0.2);
/** The fade of a light the candle's start follows. */
export const EFFECT_START_FADE: Seconds = toSeconds(0.4);

/**
 * The beliefs without those of `bulbs`, so the next pass sends them their light, the candle's start included. Today's
 * dispatch sends a lamp it was asked for (switched back on, or handed to the port) whatever it was last sent.
 */
export function forgotten(beliefs: Beliefs, bulbs: readonly BulbId[]): Beliefs {
  const forget = new Set(bulbs);
  return { ...beliefs, bulbs: Object.fromEntries(entriesOf(beliefs.bulbs).filter(([bulb]) => !forget.has(bulb))) };
}

/** What to send now to make the house show `target`, and when to look again (the first send or belief to settle). */
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
  return { sends, wakeAt: firstSettle(sends, beliefs, now) };
}

/** The send one bulb needs, if any. */
function bulbSend(light: LampLight, bulb: BulbInfo, observed: ObservedBulb | undefined, belief: Belief | undefined, now: Instant):
  Send | undefined {
  if (observed === undefined || observed.reach === 'unreachable' || observed.light.power === 'off') return undefined;
  const appearance = bulbAppearance(light, bulb);
  const settled = belief !== undefined && now >= belief.settlesAt;
  const differs = belief === undefined || !sameAppearance(belief.shows, appearance) || (settled && !reportsShowing(observed.light, appearance));
  if (!differs) return undefined;
  const stopFirst = belief !== undefined && runsCandle(belief.shows) && !runsCandle(appearance);
  return { kind: 'bulb', bulb: bulb.bulb, appearance, over: fadeOf(light, appearance), stopFirst };
}

/** Exactly what was sent: the belief is a send, so it is compared as one. */
function sameAppearance(a: BulbAppearance, b: BulbAppearance): boolean {
  if (a.power === 'off' || b.power === 'off') return a.power === b.power;
  return a.level === b.level && a.firmwareEffect === b.firmwareEffect && sameSentColour(a.colour, b.colour);
}

function sameSentColour(a: Colour | undefined, b: Colour | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === 'kelvin') return b.kind === 'kelvin' && a.kelvin === b.kelvin;
  if (b.kind === 'kelvin') return false;
  return a.rgb.red === b.rgb.red && a.rgb.green === b.rgb.green && a.rgb.blue === b.rgb.blue;
}

/** Does the report show the appearance, within the tolerances? A lamp with no colour leaves the bulb's colour out of it. */
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

function runsCandle(appearance: BulbAppearance): boolean {
  return appearance.power === 'on' && appearance.firmwareEffect === 'candle';
}

/**
 * The send's fade: a light the candle's start follows gets the effect start's
 * fade, a step of a scheduled fade its step, anything else (off included) the
 * manual fade.
 */
function fadeOf(light: LampLight, appearance: BulbAppearance): Seconds {
  if (light.power === 'off') return MANUAL_FADE;
  if (runsCandle(appearance)) return EFFECT_START_FADE;
  return light.transition.kind === 'scheduled fade' ? light.transition.over : MANUAL_FADE;
}

/** The first moment a send of this pass, or a belief still settling, can be compared with its report. */
function firstSettle(sends: readonly Send[], beliefs: Beliefs, now: Instant): Instant | undefined {
  const resent = new Set(sends.flatMap(send => send.kind === 'bulb' ? [send.bulb] : []));
  const times = [
    ...sends.flatMap(send => send.kind === 'bulb' ? [settlesAt(now, send.over)] : []),
    ...entriesOf(beliefs.bulbs).flatMap(([bulb, belief]) => !resent.has(bulb) && belief.settlesAt > now ? [belief.settlesAt] : []),
  ];
  return times.length === 0 ? undefined : toInstant(Math.min(...times));
}

function settlesAt(now: Instant, over: Seconds): Instant {
  return toInstant(now + over + SETTLE_MARGIN);
}

/** The beliefs after a send: what was sent is now believed; a failed send leaves them as they were. */
export function afterSend(beliefs: Beliefs, send: Send, outcome: 'sent' | 'failed', now: Instant): Beliefs {
  if (outcome === 'failed') return beliefs;
  switch (send.kind) {
    case 'bulb':
      return { ...beliefs, bulbs: { ...beliefs.bulbs, [send.bulb]: { shows: send.appearance, sentAt: now, settlesAt: settlesAt(now, send.over) } } };
    case 'switch':
      return { ...beliefs, switches: { ...beliefs.switches, [send.switch]: { power: send.power, sentAt: now } } };
  }
}
