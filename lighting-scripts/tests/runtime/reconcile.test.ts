import assert from 'node:assert/strict';
import test from 'node:test';
import type { BulbGroups } from '../../src/adapter/bulb-groups.ts';
import { publishes } from '../../src/adapter/encode.ts';
import type { MqttTopic, Publish } from '../../src/adapter/encode.ts';
import { afterSend, EFFECT_START_FADE, forgotten, MANUAL_FADE, NO_BELIEFS, nextSends, SETTLE_MARGIN } from '../../src/adapter/reconcile.ts';
import type { Beliefs, Send } from '../../src/adapter/reconcile.ts';
import type { Config } from '../../src/domain/config.ts';
import { candle, normal } from '../../src/domain/effect.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { LightingState } from '../../src/domain/types/lighting-state.ts';
import type { Colour, LampLight, OnLight } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import {
  toBulbId, toColourChannel, toInstant, toKelvin, toLampId, toLevel, toMqttTopic, toSeconds, toSwitchId,
} from '../../src/parse/ids.ts';
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
const OFF: LampLight = { power: 'off' };

/** The evening: `light.lamp_a1` runs the candle in the warm end, `light.lamp_a2` is lit plainly, `light.lamp_b1` is off. */
const EVENING: LightingState = {
  lamps: { [lampA1]: on(100, WARM, candle), [lampA2]: on(150, kelvin(3000)), [lampB1]: OFF },
  switches: { [plugA]: 'on' },
};

const at = (seconds: number): Instant => toInstant(1_790_000_000 + seconds);

/** One pass: observe, send what differs, apply the publishes the bulbs did not lose, record each send. */
function pass(bulbs: FakeBulbs, target: LightingState, beliefs: Beliefs, now: Instant,
  lost: (publish: Publish) => boolean = () => false): { beliefs: Beliefs; sends: Send[]; sent: Publish[] } {
  const { sends } = nextSends(target, config, bulbs.observed(), beliefs, now);
  const sent = publishes(sends, topics, NO_GROUPS);
  bulbs.apply(sent, lost);
  let after = beliefs;
  for (const send of sends) {
    const failed = send.kind === 'bulb' && sent.some(publish => publish.topic === topics[send.bulb] && lost(publish));
    after = afterSend(after, send, failed ? 'failed' : 'sent', now);
  }
  return { beliefs: after, sends, sent };
}

/** A steady house: one pass from cold, every switch reporting its target. */
function steady(target: LightingState = EVENING): { bulbs: FakeBulbs; beliefs: Beliefs } {
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'on');
  return { bulbs, beliefs: pass(bulbs, target, NO_BELIEFS, at(0)).beliefs };
}

const sentTo = (sent: readonly Publish[], bulb: BulbId) => sent.filter(publish => publish.topic === topics[bulb]).map(publish => publish.payload);

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
  assert.deepEqual(sends.map(send => send.kind === 'bulb' ? send.bulb : send.switch), [bulbA1, bulbA2]);
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
  assert.deepEqual(sends.map(send => send.kind === 'bulb' ? send.bulb : send.switch), [bulbA3]);
  assert.deepEqual(bulbs.shows(bulbA3), { reach: 'reachable', light: lit(150, kelvin(3003)) });
});

test('a report inside the settle window is not a difference', () => {
  // Break: a bulb still moving to what it was sent is sent it again.
  const bulbs = new FakeBulbs(topics);
  bulbs.switches.set(plugA, 'on');
  const { beliefs } = pass(bulbs, EVENING, NO_BELIEFS, at(0));
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(200, kelvin(3003)) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(1)).sends, []);
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(3)).sends.map(send => send.kind === 'bulb' ? send.bulb : send.switch), [bulbA3]);
});

test('a report within the tolerances is not a difference', () => {
  // Break: the level, kelvin or xy tolerance is not applied, so mired rounding re-sends a bulb forever.
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(152, kelvin(3040)) });
  bulbs.set(bulbA2, { reach: 'reachable', light: lit(98, { kind: 'rgb', rgb: { red: toColourChannel(255), green: toColourChannel(128), blue: toColourChannel(2) } }) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends, []);
  bulbs.set(bulbA3, { reach: 'reachable', light: lit(150, kelvin(3100)) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(120)).sends.map(send => send.kind === 'bulb' ? send.bulb : send.switch), [bulbA3]);
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
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends.map(send => send.kind === 'bulb' ? send.bulb : send.switch), [bulbA3]);
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

test('a bulb whose belief is forgotten is sent its light again, the candle\'s start included', () => {
  // Break: a lamp switched back on (today's `lamp_on`, which names it) keeps its old belief, so its candle is never restarted.
  const { bulbs, beliefs } = steady();
  bulbs.set(bulbA1, { reach: 'reachable', light: lit(100, WARM) });
  assert.deepEqual(pass(bulbs, EVENING, beliefs, at(60)).sends, []);
  const { sent } = pass(bulbs, EVENING, forgotten(beliefs, [bulbA1]), at(60));
  assert.deepEqual(sentTo(sent, bulbA1).map(payload => 'effect' in payload ? payload.effect : 'light'), ['light', 'channel_change']);
  assert.deepEqual(bulbs.shows(bulbA1), { reach: 'reachable', light: lit(100, WARM, 'candle') });
});

test('a disconnected bridge sends the bulbs nothing', () => {
  // Break: publishes go out while Zigbee2MQTT is away, and are lost.
  const bulbs = new FakeBulbs(topics);
  const { sends } = nextSends(EVENING, config, bulbs.observed(false), NO_BELIEFS, at(0));
  assert.equal(sends.some(send => send.kind === 'bulb'), false);
});

test('a failed send leaves the belief unchanged', () => {
  // Break: a lost send is recorded as shown, so the bulb is never sent its light again.
  const bulbs = new FakeBulbs(topics);
  const lost = (publish: Publish) => publish.topic === topics[bulbA3];
  const first = pass(bulbs, EVENING, NO_BELIEFS, at(0), lost);
  const sendA3 = first.sends.find(send => send.kind === 'bulb' && send.bulb === bulbA3);
  assert.ok(sendA3 !== undefined);
  assert.deepEqual(afterSend(NO_BELIEFS, sendA3, 'failed', at(0)), NO_BELIEFS);
  assert.deepEqual(pass(bulbs, EVENING, first.beliefs, at(60)).sends.map(send => send.kind === 'bulb' ? send.bulb : send.switch), [bulbA3]);
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

test('the next wake is when the first send settles, and a steady house asks for none', () => {
  // Break: the reconciler does not ask to look again once what it sent has settled, or wakes for nothing.
  const bulbs = new FakeBulbs(topics);
  const { wakeAt } = nextSends(EVENING, config, bulbs.observed(), NO_BELIEFS, at(0));
  assert.equal(wakeAt, at(0) + MANUAL_FADE + SETTLE_MARGIN);
  const settling = pass(bulbs, EVENING, NO_BELIEFS, at(0)).beliefs;
  const inWindow = nextSends(EVENING, config, bulbs.observed(), settling, at(1));
  assert.deepEqual([inWindow.sends, inWindow.wakeAt], [[], at(0) + MANUAL_FADE + SETTLE_MARGIN]);
  const { bulbs: settled, beliefs } = steady();
  assert.equal(nextSends(EVENING, config, settled.observed(), beliefs, at(60)).wakeAt, undefined);
});

test('the fades are 0.2 s for a manual change and 0.4 s into an effect start', () => {
  assert.equal(MANUAL_FADE, 0.2);
  assert.equal(EFFECT_START_FADE, 0.4);
});
