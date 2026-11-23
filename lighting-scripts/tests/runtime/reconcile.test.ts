import assert from 'node:assert/strict';
import test from 'node:test';
import type { BulbGroups } from '../../src/adapter/codecs/bulb-groups.ts';
import { carries, outcomeOf, publishes } from '../../src/adapter/encode.ts';
import type { Publish } from '../../src/adapter/encode.ts';
import type { MqttTopic } from '../../src/adapter/codecs/ids.ts';
import type { Observed } from '../../src/adapter/codecs/observed.ts';
import {
  afterSend, backOn, EFFECT_START_FADE, forgotten, MANUAL_FADE, NO_BELIEFS, newlyParked, nextSends, REAPPLY_LIMIT, REAPPLY_WINDOW, reportedChanged, RETRY_FIRST,
  switchesSeen, unexplained,
} from '../../src/adapter/reconcile.ts';
import type { Beliefs, Send } from '../../src/adapter/reconcile.ts';
import type { Config } from '../../src/domain/config.ts';
import { candle, normal } from '../../src/domain/effect.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { LightingState } from '../../src/domain/types/lighting-state.ts';
import type { Colour, LampLight, OnLight } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import {
  toBulbId, toColourChannel, toInstant, toKelvin, toLampId, toLevel, toMqttTopic, toSeconds, toSwitchId,
} from '../../src/adapter/codecs/ids.ts';
import { FakeBulbs, lit } from './fake-bulbs.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * The reconciler's core rule, on the synthetic house's bulbs (`light.lamp_a1`:
 * `bulb-a1` runs the candle firmware, `bulb-a2` does not; `light.lamp_a2`:
 * `bulb-a3`; `light.lamp_b1`: `bulb-b1`) and fake bulbs that behave as the
 * candle firmware does. Each pass observes the bulbs, sends what differs, and
 * records what was sent.
 */

const config: Config = syntheticHouse().config;
const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2'), lampB1 = toLampId('light.lamp_b1');
const bulbA1 = toBulbId('bulb-a1'), bulbA2 = toBulbId('bulb-a2'), bulbA3 = toBulbId('bulb-a3'), bulbB1 = toBulbId('bulb-b1');
const plugA = toSwitchId('switch.plug_a');
const topics: Record<BulbId, MqttTopic> = Object.fromEntries([bulbA1, bulbA2, bulbA3, bulbB1].map(bulb =>
  [bulb, toMqttTopic(`zigbee2mqtt/${bulb}/set`)]));
const NO_GROUPS: BulbGroups = [];

const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const WARM: Colour = { kind: 'rgb', rgb: { red: toColourChannel(255), green: toColourChannel(126), blue: toColourChannel(0) } };
const MANUAL = { kind: 'manual' } as const;
const on = (level: number, colour: Colour | undefined, effect: OnLight['effect'] = normal, transition: OnLight['transition'] = MANUAL): LampLight =>
  ({ power: 'on', level: toLevel(level), colour, effect, transition });
const OFF: LampLight = { power: 'off', transition: MANUAL };

/** The evening: `light.lamp_a1` runs the candle in the warm end, `light.lamp_a2` is lit plainly, `light.lamp_b1` is off. */
const EVENING: LightingState = {
  lamps: { [lampA1]: on(100, WARM, candle), [lampA2]: on(150, kelvin(3000)), [lampB1]: OFF },
  switches: { [plugA]: 'on' },
};

const at = (seconds: number): Instant => toInstant(1_790_000_000 + seconds);

/**
 * One pass: observe, send what differs, apply the publishes the bulbs did not lose, record each send with how its
 * publishes went (`lost` ones went out and never arrived; `failing` ones failed, and the sender is told).
 */
function pass(bulbs: FakeBulbs, target: LightingState, beliefs: Beliefs, now: Instant,
  { lost = () => false, failing = () => false, groups = NO_GROUPS }: {
    lost?: (publish: Publish) => boolean; failing?: (publish: Publish) => boolean; groups?: BulbGroups;
  } = {}): { beliefs: Beliefs; sends: Send[]; sent: Publish[] } {
  const { sends } = nextSends(target, config, bulbs.observed(), beliefs, now);
  const sent = publishes(sends, topics, groups);
  const failed = bulbs.apply(sent, lost, failing);
  let after = beliefs;
  for (const send of sends) {
    after = afterSend(after, send, send.kind === 'switch' ? 'sent'
      : outcomeOf(send, failed.filter(publish => carries(send, publish, topics, groups))), now);
  }
  return { beliefs: after, sends, sent };
}

/** The bulb or switch a send goes to. */
const to = (send: Send) => send.kind === 'switch' ? send.switch : send.bulb;
/** What each publish to `bulb` carried: the stop, the light, or the candle's start. */
const kinds = (sent: readonly Publish[], bulb: BulbId) => sentTo(sent, bulb).map(payload => 'effect' in payload ? payload.effect : 'light');

/** A steady house: one pass from cold, every switch reporting its target. */
function steady(target: LightingState = EVENING): { bulbs: FakeBulbs; beliefs: Beliefs } {
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'on');
  return { bulbs, beliefs: pass(bulbs, target, NO_BELIEFS, at(0)).beliefs };
}

function sentTo(sent: readonly Publish[], bulb: BulbId) {
  return sent.filter(publish => publish.topic === topics[bulb]).map(publish => publish.payload);
}

test('a cold start sends each bulb its light, then the candle\'s start', () => {
  // Break: the start is sent before the light (the light would end it), a stock bulb is started, or a bulb is skipped.
  const bulbs = new FakeBulbs(topics);
  const { sent } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
  assert.deepEqual(bulbs.shows(bulbA2), { reach: 'reachable', light: lit(100, WARM) });
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
  assert.deepEqual(bulbs.shows(bulbB1), { reach: 'reachable', light: { power: 'off' } });
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['light', 'channel_change']);
});

test('a steady state sends nothing across ten passes', () => {
  // Break: a belief is not recorded, or an observation inside the tolerances counts as a difference.
  let { bulbs, beliefs } = steady();
  for (let n = 1; n <= 10; n++) {
    const next = pass(bulbs, EVENING, beliefs, at(n * 60));
    assert.deepEqual(next.sends, [], `pass ${n}`);
    beliefs = next.beliefs;
  }
});

test('a level change under a candle sends the light, then the start again', () => {
  // Break: the level is sent alone (the firmware ends the candle on it), or the start is not sent again.
  const { bulbs, beliefs } = steady();
  const brighter: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(120, WARM, candle) } };
  const { sends, sent } = pass(bulbs, brighter, beliefs, at(60));
  assert.deepEqual(sends.map(send => to(send)), [bulbA1, bulbA2]);
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['light', 'channel_change']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(120, WARM, 'candle') });
});

test('re-selecting the running candle keeps it running', () => {
  // Break: an unchanged candle is started again (the owner: "keep running").
  const { bulbs, beliefs } = steady();
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends, []);
  assert.equal(bulbs.received.filter(({ publish }) => 'effect' in publish.payload).length, 1);
});

test('leaving the candle sends the stop first', () => {
  // Break: the stop is left out, or sent after the light.
  const { bulbs, beliefs } = steady();
  const plain: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(100, WARM) } };
  const { sends, sent } = pass(bulbs, plain, beliefs, at(60));
  assert.deepEqual(sends.map(send => send.kind === 'bulb' ? [send.bulb, send.stopFirst] : []), [[bulbA1, true]]);
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['stop_effect', 'light']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM) });
});

test('a candle bulb with no belief is sent the stop before normal light; a stock bulb is not', () => {
  // Break: the stop needs a belief, so a candle left running from before a restart, or under a forgotten belief, runs on.
  const plain: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(100, WARM) } };
  const bulbs = new FakeBulbs(topics);
  bulbs.set(bulbA1, { reach: 'reachable', light: lit(100, WARM, 'candle') });
  const { sends, sent } = pass(bulbs, plain, NO_BELIEFS, at(0));
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['stop_effect', 'light']);
  assert.deepEqual(sentTo(sent, bulbA2).map(payload => 'effect' in payload ? payload.effect : 'light'), ['light']);
  assert.deepEqual(sends.flatMap(send => send.kind === 'bulb' && send.stopFirst ? [send.bulb] : []), [bulbA1]);
  const { beliefs } = steady();
  const forgottenPass = pass(bulbs, plain, forgotten(beliefs, [bulbA1]), at(60));
  assert.deepEqual(sentTo(forgottenPass.sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['stop_effect', 'light']);
});

test('a colour change under a candle sends the light, then the start again', () => {
  // Break: the colour is sent alone (the firmware ends the candle on it), or the start is not sent again.
  const { bulbs, beliefs } = steady();
  const deeper: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(100, kelvin(2200), candle) } };
  const { sent } = pass(bulbs, deeper, beliefs, at(60));
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['light', 'channel_change']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, kelvin(2198), 'candle') });
});

test('a running candle whose reported level and colour flicker is left running', () => {
  // Break: a settled candle bulb is checked against its report, so the firmware's flicker restarts the candle every pass.
  let { bulbs, beliefs } = steady();
  for (const [n, level, green] of [[1, 80, 110], [2, 112, 140], [3, 60, 90]] as const) {
    bulbs.set(bulbA1, { reach: 'reachable', light: lit(level, { kind: 'rgb', rgb: { red: toColourChannel(255),
      green: toColourChannel(green), blue: toColourChannel(0) } }, 'candle') });
    const next = pass(bulbs, EVENING, beliefs, at(n * 60));
    assert.deepEqual(next.sends, [], `pass ${n}`);
    beliefs = next.beliefs;
  }
  assert.equal(bulbs.received.filter(({ publish }) => 'effect' in publish.payload).length, 1);
});

test('a bulb that reports something else after settling is sent its target again', () => {
  // Break: the observation is never compared, so a bulb changed behind our back stays wrong.
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, kelvin(3003)) });
  const { sends } = pass(bulbs, EVENING, beliefs, at(60));
  assert.deepEqual(sends.map(send => to(send)), [bulbA3]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
});

test('a report inside the settle window is not a difference', () => {
  // Break: a bulb still moving to what it was sent is sent it again.
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'on');
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(200, kelvin(3003)) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(1)).sends, []);
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(3)).sends.map(send => to(send)), [bulbA3]);
});

test('a report within the tolerances is not a difference', () => {
  // Break: the level, kelvin or xy tolerance is not applied, so mired rounding re-sends a bulb forever.
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(152, kelvin(3040)) });
  bulbs.set(bulbA2, { reach: 'reachable', light: lit(98, { kind: 'rgb', rgb: { red: toColourChannel(255), green: toColourChannel(128), blue: toColourChannel(2) } }) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends, []);
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(150, kelvin(3100)) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(120)).sends.map(send => to(send)), [bulbA3]);
});

test('an unreachable bulb is sent nothing', () => {
  // Break: a bulb switched off at the wall is sent its light, which it cannot receive.
  const bulbs = new FakeBulbs(topics);
  bulbs.set(bulbA3, { reach: 'unreachable' });
  const { sends } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  assert.equal(sends.some(send => send.kind === 'bulb' && send.bulb === bulbA3), false);
  assert.equal(sends.some(send => send.kind === 'bulb' && send.bulb === bulbA1), true);
});

test('a reachable bulb that reports off under a lit target is sent its light', () => {
  // Break: a reachable bulb reporting off is skipped. The owner (2026-11-23): only unreachable bulbs and a disconnected
  // bridge are left alone; a person's off is a hold in the lighting state, so anything else leaving a bulb off is undone.
  const cold = new FakeBulbs(topics);
  cold.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
  assert.equal(pass(cold, EVENING, NO_BELIEFS, at(0)).sends.some(send => send.kind === 'bulb' && send.bulb === bulbA3), true);
  assert.deepEqual(cold.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends.map(send => to(send)), [bulbA3]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
});

test('a candle bulb switched off from outside is sent its light, then the start again', () => {
  // Break: power is not compared for a bulb believed to run the candle, so a candle switched off stays off.
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA1, { reach: 'reachable', light: { power: 'off' } });
  const { sends, sent } = pass(bulbs, EVENING, beliefs, at(60));
  assert.deepEqual(sends.map(send => send.kind === 'bulb' ? [send.bulb, send.stopFirst] : []), [[bulbA1, false]]);
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['light', 'channel_change']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
});

test('a lamp with a bulb out of reach does not restart the candle on its live bulb', () => {
  // Break: a lamp counts as unsent while one bulb cannot be reached, so every pass restarts the candle on the others.
  const bulbs = new FakeBulbs(topics);
  bulbs.set(bulbA2, { reach: 'unreachable' });
  let { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  for (let n = 1; n <= 3; n++) {
    const next = pass(bulbs, EVENING, beliefs, at(n * 60));
    assert.deepEqual(next.sends.filter(send => send.kind === 'bulb'), [], `pass ${n}`);
    beliefs = next.beliefs;
  }
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
});

test('a bulb whose belief is forgotten is sent what it does not show, the candle\'s start included', () => {
  // Break: a lamp switched back on (today's `lamp_on`, which names it) keeps its old belief, so its candle is never restarted.
  // With no belief, the light it reports is not sent again (M4: a restart re-sends nothing a bulb already shows).
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA1, { reach: 'reachable', light: lit(100, WARM) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends, []);
  const { sent } = pass(bulbs, EVENING, forgotten(beliefs, [bulbA1]), at(60));
  assert.deepEqual(kinds(sent, bulbA1), ['channel_change']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
});

test('a bulb reported changed is forgotten, but not one our own put-back lit', () => {
  // Amendment 8.2. Break: a bulb Home Assistant reports switched on keeps its old belief (its candle never restarts), or
  // the report of our own put-back forgets the put-backs, so a bulb that keeps going off is never parked.
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
  const dark = bulbs.observed();
  const putBack = pass(bulbs, EVENING, beliefs, at(60)).beliefs;
  const after = reportedChanged(putBack, dark, bulbs.observed(), [bulbA1, bulbA3]);
  assert.equal(after.bulbs[bulbA1], undefined);
  assert.deepEqual(after.bulbs[bulbA3], putBack.bulbs[bulbA3]);
  assert.deepEqual(after.bulbs[bulbA2], putBack.bulbs[bulbA2]);
});

test('a disconnected bridge sends the bulbs nothing', () => {
  // Break: publishes go out while Zigbee2MQTT is away, and are lost.
  const bulbs = new FakeBulbs(topics);
  const { sends } = nextSends(EVENING, config, bulbs.observed(false), NO_BELIEFS, at(0));
  assert.equal(sends.some(send => send.kind === 'bulb'), false);
});

test('a failed send is sent again once its first backoff has passed, and is not taken as shown', () => {
  // Break: a failed send is recorded as shown (the bulb is never sent its light again), or retried at once, every pass.
  const bulbs = new FakeBulbs(topics);
  const failing = (publish: Publish) => publish.topic === topics[bulbA3];
  const first = pass(bulbs, EVENING, NO_BELIEFS, at(0), { failing });
  assert.ok(first.sends.some(send => to(send) === bulbA3));
  assert.deepEqual(pass(bulbs, EVENING, first.beliefs, at(0.5)).sends.filter(send => to(send) === bulbA3), []);
  assert.deepEqual(pass(bulbs, EVENING, first.beliefs, at(1)).sends.map(to), [bulbA3]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
});

test('a lamp with no colour is sent its level alone, and its bulbs\' colour is no difference', () => {
  // Break: a colour is invented for the lamp, or the colour the bulb keeps counts as a difference.
  const { bulbs, beliefs } = steady();
  const colourless: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA2]: on(80, undefined) } };
  const first = pass(bulbs, colourless, beliefs, at(60));
  assert.deepEqual(sentTo(first.sent, bulbA3), [{ brightness: 80, transition: MANUAL_FADE }]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(80, kelvin(3003)) });
  assert.deepEqual(pass(bulbs, colourless, first.beliefs, at(120)).sends, []);
});

test('a switch is sent its target when it reports otherwise, and an unreachable one nothing', () => {
  // Break: a switch is never compared with its report, or one that cannot be reached is sent a command.
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'off');
  assert.deepEqual(nextSends(EVENING, config, bulbs.observed(), NO_BELIEFS, at(0)).sends.filter(send => send.kind === 'switch'),
    [{ kind: 'switch', switch: plugA, power: 'on' }]);
  bulbs.switches.set(plugA, 'on');
  assert.deepEqual(nextSends(EVENING, config, bulbs.observed(), NO_BELIEFS, at(0)).sends.filter(send => send.kind === 'switch'), []);
  bulbs.switches.set(plugA, 'unreachable');
  assert.deepEqual(nextSends(EVENING, config, bulbs.observed(), NO_BELIEFS, at(0)).sends.filter(send => send.kind === 'switch'), []);
});

test('a scheduled fade goes out over its step, a manual change over the manual fade, the candle over the effect start\'s fade', () => {
  // Break: a fade step is sent at once, or a candle lamp's light does not get the effect start's fade.
  const bulbs = new FakeBulbs(topics);
  const fading: LightingState = {
    lamps: { [lampA1]: on(100, WARM, candle), [lampA2]: on(150, kelvin(3000), normal, { kind: 'scheduled fade', over: toSeconds(60) }), [lampB1]: on(90, WARM) },
    switches: {},
  };
  const over = Object.fromEntries(nextSends(fading, config, bulbs.observed(), NO_BELIEFS, at(0)).sends.flatMap(send =>
    send.kind === 'bulb' ? [[send.bulb, send.over]] : []));
  assert.deepEqual(over, { [bulbA1]: EFFECT_START_FADE, [bulbA2]: MANUAL_FADE, [bulbA3]: 60, [bulbB1]: MANUAL_FADE });
});

test('an off by a room\'s power switch goes out with no fade; any other off over the manual fade', () => {
  // Break: the room's switch fades where today's homeassistant.turn_off is at once, or every off loses its fade.
  const { bulbs, beliefs } = steady();
  const target: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: { power: 'off', transition: { kind: 'switch' } }, [lampA2]: OFF } };
  const { sends } = pass(bulbs, target, beliefs, at(10));
  const over = Object.fromEntries(sends.flatMap(send => send.kind === 'bulb' ? [[send.bulb, send.over]] : []));
  assert.deepEqual(over, { [bulbA1]: 0, [bulbA2]: 0, [bulbA3]: MANUAL_FADE });
});

test('the next wake is a retry only: a settling send asks for none, the minute tick looks again', () => {
  // Review fix 4. Break: nextSends asks to be woken when a send settles (a wake the loop does not use: it would move
  // the house's clock under the harness's checkpoints), or forgets the retry a failed send is owed.
  const bulbs = new FakeBulbs(topics);
  assert.equal(nextSends(EVENING, config, bulbs.observed(), NO_BELIEFS, at(0)).wakeAt, undefined);
  const settling = pass(bulbs, EVENING, NO_BELIEFS, at(0)).beliefs;
  assert.deepEqual(nextSends(EVENING, config, bulbs.observed(), settling, at(1)), { sends: [], wakeAt: undefined });
  const failing = (publish: Publish) => publish.topic === topics[bulbA3];
  const failed = pass(new FakeBulbs(topics), EVENING, NO_BELIEFS, at(0), { failing }).beliefs;
  assert.equal(nextSends(EVENING, config, bulbs.observed(), failed, at(0.5)).wakeAt, at(0) + RETRY_FIRST);
});

test('the fades are 0.2 s for a manual change and 0.4 s into an effect start', () => {
  assert.equal(MANUAL_FADE, 0.2);
  assert.equal(EFFECT_START_FADE, 0.4);
});

// --- M4: retries, parking, the flap limit, power-on, restart -------------------------------------------------------

const toStart = (publish: Publish) => 'effect' in publish.payload && publish.payload.effect === 'channel_change';

test('a lost start is sent again alone', () => {
  // Break: the start's failure fails the whole send (the light goes out again), or it is taken as running.
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'on');
  const first = pass(bulbs, EVENING, NO_BELIEFS, at(0), { failing: publish => publish.topic === topics[bulbA1] && toStart(publish) });
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM) });
  assert.deepEqual(pass(bulbs, EVENING, first.beliefs, at(0.5)).sends, [], 'not before its backoff');
  const retry = pass(bulbs, EVENING, first.beliefs, at(1));
  assert.deepEqual(retry.sent, [{ topic: topics[bulbA1], payload: { effect: 'channel_change' } }]);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
  assert.deepEqual(pass(bulbs, EVENING, retry.beliefs, at(60)).sends, []);
});

test('a single bulb power-cycled under a lit lamp gets its light and effect back with the short fade', () => {
  // Review Focus 2. Break: the bulb keeps the light it had when it lost power (its belief says it shows the light,
  // the candle included, which it lost), or comes back over the scheduled fade's step instead of the short fade.
  let { bulbs, beliefs } = steady();
  const step = { kind: 'scheduled fade', over: toSeconds(60) } as const;
  const fading = (level: number): LightingState => ({ ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(level, WARM, candle, step),
    [lampA2]: on(level, kelvin(3000), normal, step) } });
  beliefs = pass(bulbs, fading(100), beliefs, at(30)).beliefs;
  bulbs.cut(bulbA1);
  bulbs.cut(bulbA3);
  const dark = bulbs.observed();
  beliefs = pass(bulbs, fading(110), beliefs, at(60)).beliefs;
  bulbs.restore(bulbA1);
  bulbs.restore(bulbA3);
  const back = bulbs.observed();
  const found = unexplained(dark, back, beliefs);
  assert.deepEqual(found, [{ kind: 'bulb back on', bulb: bulbA1 }, { kind: 'bulb back on', bulb: bulbA3 }]);
  const { sends, sent } = pass(bulbs, fading(120), backOn(beliefs, [bulbA1, bulbA3]), at(90));
  const over = Object.fromEntries(sends.flatMap(send => send.kind === 'bulb' ? [[send.bulb, send.over]] : []));
  assert.deepEqual(over, { [bulbA1]: EFFECT_START_FADE, [bulbA2]: 60, [bulbA3]: MANUAL_FADE });
  assert.deepEqual(kinds(sent, bulbA1), ['light', 'channel_change']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(120, WARM, 'candle') });
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(120, kelvin(3003)) });
});

test('a bulb we switched on is not back on; one switched on from outside is', () => {
  // Break: our own switch-on reads as a power-on (sent again with the short fade), or an outside one is missed.
  const offA3: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA2]: OFF } };
  const { bulbs, beliefs } = steady(offA3);
  const before = bulbs.observed();
  const lighting = pass(bulbs, EVENING, beliefs, at(60));
  assert.deepEqual(unexplained(before, bulbs.observed(), lighting.beliefs), []);
  const outside = bulbs.observed();
  bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'off' } });
  const offAgain = bulbs.observed();
  assert.deepEqual(unexplained(outside, offAgain, lighting.beliefs), []);
  const offBelief = pass(bulbs, offA3, lighting.beliefs, at(120)).beliefs;
  bulbs.set(bulbA3, { reach: 'reachable', light: { power: 'on', level: toLevel(254), colour: undefined, effect: 'none' } });
  assert.deepEqual(unexplained(offAgain, bulbs.observed(), offBelief), [{ kind: 'bulb back on', bulb: bulbA3 }]);
});

test('a dead bulb gets five sends, then silence', () => {
  // Break: a failing bulb is sent every pass, never given up on, or given up on before its fifth send.
  const bulbs = new FakeBulbs(topics);
  const failing = (publish: Publish) => publish.topic === topics[bulbA3];
  let beliefs = NO_BELIEFS;
  const sentAt: number[] = [];
  for (const time of [0, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 31, 60, 600, 3600]) {
    const next = pass(bulbs, EVENING, beliefs, at(time), { failing });
    if (next.sends.some(send => to(send) === bulbA3)) sentAt.push(time);
    beliefs = next.beliefs;
  }
  assert.deepEqual(sentAt, [0, 1, 3, 7, 15]);
});

test('a parked bulb is logged once', () => {
  // Break: the bulb is reported every pass it stays parked, or never.
  const bulbs = new FakeBulbs(topics);
  const failing = (publish: Publish) => publish.topic === topics[bulbA3];
  let beliefs = NO_BELIEFS;
  const parked: BulbId[] = [];
  for (let second = 0; second <= 120; second++) {
    const next = pass(bulbs, EVENING, beliefs, at(second), { failing });
    parked.push(...newlyParked(beliefs, next.beliefs));
    beliefs = next.beliefs;
  }
  assert.deepEqual(parked, [bulbA3]);
});

/** A3 failing until parked, at 15 s. */
function parkedA3(bulbs: FakeBulbs): Beliefs {
  const failing = (publish: Publish) => publish.topic === topics[bulbA3];
  let beliefs = NO_BELIEFS;
  for (const time of [0, 1, 3, 7, 15]) beliefs = pass(bulbs, EVENING, beliefs, at(time), { failing }).beliefs;
  assert.deepEqual(newlyParked(NO_BELIEFS, beliefs), [bulbA3]);
  return beliefs;
}

test('a parked bulb is released when it comes back on', () => {
  // Break: a parked bulb stays parked after its power-on, so a bulb given up on while off at the wall is never lit again.
  const bulbs = new FakeBulbs(topics);
  const parked = parkedA3(bulbs);
  bulbs.cut(bulbA3);
  const dark = bulbs.observed();
  bulbs.restore(bulbA3);
  const found = unexplained(dark, bulbs.observed(), parked);
  assert.deepEqual(found, [{ kind: 'bulb back on', bulb: bulbA3 }]);
  const { sends } = pass(bulbs, EVENING, backOn(parked, [bulbA3]), at(60));
  assert.deepEqual(sends.map(to), [bulbA3]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
});

test('a parked bulb is released when its light changes', () => {
  // Reconciler spec 3.8. Break: a bulb given up on misses every later block until it is power-cycled.
  const bulbs = new FakeBulbs(topics);
  const parked = parkedA3(bulbs);
  assert.deepEqual(pass(bulbs, EVENING, parked, at(60)).sends.filter(send => to(send) === bulbA3), []);
  const dimmer: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA2]: on(90, kelvin(3000)) } };
  assert.deepEqual(pass(bulbs, dimmer, parked, at(120)).sends.map(to), [bulbA3]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(90, kelvin(3003)) });
});

test('flapping is capped at six in ten minutes', () => {
  // Break: a bulb something keeps changing is put back forever, or the cap counts put-backs older than the window.
  const putBack = (every: number, times: number): number => {
    let { bulbs, beliefs } = steady();
    let count = 0;
    for (let n = 1; n <= times; n++) {
      bulbs.set(bulbA3, { reach: 'reachable', light: lit(40, kelvin(3003)) });
      const next = pass(bulbs, EVENING, beliefs, at(n * every));
      if (next.sends.some(send => to(send) === bulbA3)) count++;
      beliefs = next.beliefs;
    }
    return count;
  };
  assert.equal(putBack(60, 12), REAPPLY_LIMIT);
  assert.equal(putBack(REAPPLY_WINDOW / (REAPPLY_LIMIT - 1), 12), 12, 'spread out, every put-back goes');
});

test('a group failure invalidates every member', () => {
  // Break: a failed group publish leaves its members' beliefs as they were, so a member that may run a leftover candle
  // is not stopped, or only one member is sent again.
  const group = { topic: toMqttTopic('zigbee2mqtt/group-a1/set'), members: [bulbA1, bulbA2] };
  const groups: BulbGroups = [group];
  const plain = (level: number): LightingState => ({ ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(level, WARM) } });
  const bulbs = new FakeBulbs(topics, groups);
  bulbs.switches.set(plugA, 'on');
  let { beliefs } = pass(bulbs, plain(100), NO_BELIEFS, at(0), { groups });
  const failed = pass(bulbs, plain(120), beliefs, at(60), { groups, failing: publish => publish.topic === group.topic });
  assert.ok(failed.sent.some(publish => publish.topic === group.topic), 'the two went as one group publish');
  beliefs = failed.beliefs;
  const again = pass(bulbs, plain(120), beliefs, at(61), { groups });
  assert.deepEqual(again.sends.flatMap(send => send.kind === 'bulb' ? [[send.bulb, send.stopFirst]] : []), [[bulbA1, true], [bulbA2, false]]);
  assert.deepEqual(bulbs.shows(bulbA2), { reach: 'reachable', light: lit(120, WARM) });
});

test('a restart re-sends nothing a bulb already shows', () => {
  // Review Focus 1. Break: with no beliefs every bulb is sent its light again (a flash mid-fade), or the candle, which
  // is not reported, is never started, or started every pass.
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'on');
  bulbs.set(bulbA1, { reach: 'reachable', light: lit(100, WARM, 'candle') });
  bulbs.set(bulbA2, { reach: 'reachable', light: lit(100, WARM) });
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(150, kelvin(3003)) });
  bulbs.set(bulbB1, { reach: 'reachable', light: { power: 'off' } });
  const restart = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  assert.deepEqual(restart.sent, [{ topic: topics[bulbA1], payload: { effect: 'channel_change' } }]);
  assert.deepEqual(pass(bulbs, EVENING, restart.beliefs, at(60)).sends, []);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
  // The one exception: a candle-firmware bulb under a normal lit target is sent the stop and its light though it reports
  // that light, since a candle left running from before cannot be told from its report.
  const plain: LightingState = { ...EVENING, lamps: { ...EVENING.lamps, [lampA1]: on(100, WARM) } };
  bulbs.set(bulbA1, { reach: 'reachable', light: lit(100, WARM) });
  assert.deepEqual(kinds(pass(bulbs, plain, NO_BELIEFS, at(120)).sent, bulbA1), ['stop_effect', 'light']);
});

// --- Review fixes 1 and 2: a press read from the switch's last_changed (option B) -------------------------------

/** The plug at `power`, as HA last changed it at `changed` (or with no last_changed, as the harness reports it). */
function plugShows(bulbs: FakeBulbs, power: 'on' | 'off', changed: Instant | undefined): Observed {
  bulbs.switches.set(plugA, power);
  if (changed === undefined) bulbs.switchChanged.delete(plugA); else bulbs.switchChanged.set(plugA, changed);
  return bulbs.observed();
}

test('a press seconds after our own switching, before the next look, is a press', () => {
  // The review's timeline: the block switches the plug on at 18:00, a person presses it off at 18:00:20, and the next
  // look (the minute's tick) sees off, as before our send. Break: the press is read against the last look (off ==
  // off), our on is sent again, and the press is lost.
  const bulbs = new FakeBulbs(topics);
  const before = plugShows(bulbs, 'off', at(-3600));
  const { beliefs, sends } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  assert.deepEqual(sends.filter(send => send.kind === 'switch'), [{ kind: 'switch', switch: plugA, power: 'on' }]);
  const pressed = plugShows(bulbs, 'off', at(20));
  assert.deepEqual(unexplained(before, pressed, beliefs), [{ kind: 'switch pressed', switch: plugA, power: 'off' }]);
  const held: LightingState = { ...EVENING, switches: { [plugA]: 'off' } };
  assert.deepEqual(switchesSeen(beliefs, pressed, held.switches).switches, {}, 'the press ends our send');
});

test('a send that landed is ours, and a later press is a press', () => {
  // Break: our own landing is taken for a press, or the record of it outlives the landing and hides the next press.
  const bulbs = new FakeBulbs(topics);
  const before = plugShows(bulbs, 'off', at(-3600));
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  const landed = plugShows(bulbs, 'on', at(1));
  assert.deepEqual(unexplained(before, landed, beliefs), []);
  const kept = switchesSeen(beliefs, landed, EVENING.switches);
  assert.deepEqual(kept.switches, {}, 'landed: the record is dropped');
  const pressed = plugShows(bulbs, 'off', at(300));
  assert.deepEqual(unexplained(landed, pressed, kept), [{ kind: 'switch pressed', switch: plugA, power: 'off' }]);
});

test('a send that never landed is dropped when the target moves off it, and a later press to that power is a press', () => {
  // Review fix 2. Break: the record of the lost on stays, so a person's press to on is read as ours and sent back off.
  const bulbs = new FakeBulbs(topics);
  const before = plugShows(bulbs, 'off', at(-3600));
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0), { lost: () => true });
  assert.deepEqual(beliefs.switches[plugA]?.power, 'on');
  const offTarget: LightingState = { ...EVENING, switches: { [plugA]: 'off' } };
  const dropped = switchesSeen(beliefs, before, offTarget.switches);
  assert.deepEqual(dropped.switches, {});
  const pressed = plugShows(bulbs, 'on', at(600));
  assert.deepEqual(unexplained(before, pressed, dropped), [{ kind: 'switch pressed', switch: plugA, power: 'on' }]);
  const held: LightingState = { ...EVENING, switches: { [plugA]: 'on' } };
  assert.deepEqual(nextSends(held, config, pressed, dropped, at(600)).sends.filter(send => send.kind === 'switch'), [],
    'held on by the press: not sent back');
});

test('a plug that drops out and comes back while our send is open is a return, not a press, and gets its target', () => {
  // Amendment 8.1. A plug back from unavailable has a fresh last_changed. Break: it is read as changed after our send
  // and held as a press, so the reconciler never sends it its target.
  const bulbs = new FakeBulbs(topics);
  plugShows(bulbs, 'off', at(-3600));
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0), { lost: () => true });
  bulbs.switches.set(plugA, 'unreachable');
  bulbs.switchChanged.set(plugA, at(10));
  const away = bulbs.observed();
  const back = plugShows(bulbs, 'off', at(30));
  assert.deepEqual(unexplained(away, back, beliefs), [], 'a return');
  assert.deepEqual(nextSends(EVENING, config, back, beliefs, at(30)).sends.filter(send => send.kind === 'switch'),
    [{ kind: 'switch', switch: plugA, power: 'on' }], 'it is sent its target');
  const pressed = plugShows(bulbs, 'off', at(40));
  const reachable = plugShows(bulbs, 'off', at(30));
  assert.deepEqual(unexplained(reachable, pressed, beliefs), [{ kind: 'switch pressed', switch: plugA, power: 'off' }],
    'reachable before and after: still a press');
});

test('with no last_changed, a switch is read as before: against the last look and our send', () => {
  // The harness reports no last_changed, so the golden replay keeps today's reading. Break: an absent time is taken
  // as "changed after our send" (every unlanded send a press) or as "before it" (every press ours).
  const bulbs = new FakeBulbs(topics);
  const before = plugShows(bulbs, 'off', undefined);
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  assert.deepEqual(unexplained(before, plugShows(bulbs, 'off', undefined), beliefs), [], 'off == off: not seen as a press');
  const landed = plugShows(bulbs, 'on', undefined);
  assert.deepEqual(unexplained(before, landed, beliefs), [], 'ours');
  assert.deepEqual(switchesSeen(beliefs, landed, EVENING.switches).switches, {}, 'seen: dropped');
  assert.deepEqual(switchesSeen(beliefs, before, EVENING.switches).switches, beliefs.switches, 'not seen: kept');
});

test('a switch that changed with no send of ours is a press; one we switched is not', () => {
  // Break: a plug's own button is taken for a difference to undo, or our own switching for a press.
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'off');
  const before: Observed = bulbs.observed();
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  bulbs.switches.set(plugA, 'on');
  assert.deepEqual(unexplained(before, bulbs.observed(), beliefs), [], 'we switched it on');
  const shown = bulbs.observed();
  bulbs.switches.set(plugA, 'off');
  assert.deepEqual(unexplained(shown, bulbs.observed(), beliefs), [{ kind: 'switch pressed', switch: plugA, power: 'off' }]);
});
