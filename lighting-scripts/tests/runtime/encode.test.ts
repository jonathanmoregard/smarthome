import assert from 'node:assert/strict';
import test from 'node:test';
import { bulbGroups } from '../../src/adapter/codecs/bulb-groups.ts';
import type { BulbGroups } from '../../src/adapter/codecs/bulb-groups.ts';
import { mqttPublishCall, publishCall, publishes, switchCall } from '../../src/adapter/encode.ts';
import type { MqttTopic } from '../../src/adapter/codecs/ids.ts';
import type { Send } from '../../src/adapter/reconcile.ts';
import type { BulbAppearance } from '../../src/domain/effect.ts';
import type { BulbId } from '../../src/domain/types/ids.ts';
import type { Colour } from '../../src/domain/types/light.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import { toBulbId, toColourChannel, toKelvin, toLevel, toMqttTopic, toSeconds, toSwitchId } from '../../src/adapter/codecs/ids.ts';

/** A send as Zigbee2MQTT publishes: what each payload carries, and in which order they go. */

const bulbA = toBulbId('bulb-a'), bulbB = toBulbId('bulb-b'), bulbC = toBulbId('bulb-c');
const topic = (name: string): MqttTopic => toMqttTopic(`zigbee2mqtt/${name}/set`);
const topics: Record<BulbId, MqttTopic> = { [bulbA]: topic('bulb-a'), [bulbB]: topic('bulb-b'), [bulbC]: topic('bulb-c') };
const NO_GROUPS: BulbGroups = [];

const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const rgb = (red: number, green: number, blue: number): Colour =>
  ({ kind: 'rgb', rgb: { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) } });
const shows = (level: number, colour: Colour | undefined, firmwareEffect: 'none' | 'candle' = 'none'): BulbAppearance =>
  ({ power: 'on', level: toLevel(level), colour, firmwareEffect });
const send = (bulb: BulbId, appearance: BulbAppearance, over = 0.4, stopFirst = false): Send =>
  ({ kind: 'bulb', bulb, appearance, over: toSeconds(over), stopFirst, reported: { power: 'off' } });

test('the candle\'s start comes last and nothing follows it', () => {
  // Break: a start is sent before a light, or a light after a start (the firmware ends the candle on a level).
  const sent = publishes([send(bulbA, shows(100, rgb(255, 126, 0), 'candle'), 0.4, true), send(bulbB, shows(100, kelvin(2700))),
    send(bulbC, shows(90, rgb(255, 126, 0), 'candle'))], topics, NO_GROUPS);
  assert.deepEqual(sent.map(publish => [publish.topic, 'effect' in publish.payload ? publish.payload.effect : 'light']), [
    [topics[bulbA], 'stop_effect'],
    [topics[bulbA], 'light'], [topics[bulbB], 'light'], [topics[bulbC], 'light'],
    [topics[bulbA], 'channel_change'], [topics[bulbC], 'channel_change'],
  ]);
  assert.deepEqual(sent.at(-1)?.payload, { effect: 'channel_change' });
});

test('off is sent as OFF with the transition', () => {
  // Break: off carries a level or colour, or loses its transition.
  assert.deepEqual(publishes([send(bulbA, { power: 'off' }, 0.2)], topics, NO_GROUPS),
    [{ topic: topics[bulbA], payload: { state: 'OFF', transition: 0.2 } }]);
});

test('kelvin goes out as mireds, RGB as r,g,b', () => {
  // Break: kelvin is sent as kelvin, a fractional channel goes out unrounded, or the level is lost.
  assert.deepEqual(publishes([send(bulbA, shows(120, kelvin(2700)), 60), send(bulbB, shows(80, rgb(255, 126.4, 0.6)), 0.2)], topics, NO_GROUPS), [
    { topic: topics[bulbA], payload: { brightness: 120, color_temp: 370, transition: 60 } },
    { topic: topics[bulbB], payload: { brightness: 80, color: { rgb: '255,126,1' }, transition: 0.2 } },
  ]);
});

test('a light with no colour goes out as its level alone', () => {
  // Break: a colour is invented for a lamp the schedule names none for.
  assert.deepEqual(publishes([send(bulbA, shows(120, undefined), 0.2)], topics, NO_GROUPS),
    [{ topic: topics[bulbA], payload: { brightness: 120, transition: 0.2 } }]);
});

test('bulbs forming a whole group go as one publish', () => {
  // Break: a group is sent a light only some of its members need, or a whole group is sent bulb by bulb.
  const groups = bulbGroups(parseCatalog({ multicast: [
    { id: 'group-ab', topic: 'zigbee2mqtt/group-ab/set', members: [bulbA, bulbB], verified: true },
    { id: 'pending', topic: 'zigbee2mqtt/pending/set', members: [bulbB, bulbC], verified: false },
  ] }));
  const light = shows(150, kelvin(3000));
  assert.deepEqual(publishes([send(bulbA, light, 0.2), send(bulbB, light, 0.2), send(bulbC, light, 0.2)], topics, groups), [
    { topic: topic('group-ab'), payload: { brightness: 150, color_temp: 333, transition: 0.2 } },
    { topic: topics[bulbC], payload: { brightness: 150, color_temp: 333, transition: 0.2 } },
  ]);
  assert.deepEqual(publishes([send(bulbA, light, 0.2), send(bulbB, shows(90, kelvin(3000)), 0.2)], topics, groups).map(publish => publish.topic),
    [topics[bulbA], topics[bulbB]]);
});

test('a bulb with no topic is sent nothing', () => {
  // Break: a publish goes to a topic the catalog never gave the bulb.
  assert.deepEqual(publishes([send(toBulbId('bulb-unlisted'), shows(100, undefined))], topics, NO_GROUPS), []);
});

test('only verified groups on a set topic with two or more distinct members are used', () => {
  // Break: a pending group, a group on another topic, a one-bulb group or one listing a bulb twice is used.
  const groups = bulbGroups(parseCatalog({ multicast: [
    { topic: 'zigbee2mqtt/ok/set', members: [bulbA, bulbB], verified: true },
    { topic: 'zigbee2mqtt/pending/set', members: [bulbA, bulbB], verified: false },
    { topic: 'zigbee2mqtt/state', members: [bulbA, bulbB], verified: true },
    { topic: 'zigbee2mqtt/one/set', members: [bulbA], verified: true },
    { topic: 'zigbee2mqtt/twice/set', members: [bulbA, bulbA], verified: true },
    'not a group',
  ] }));
  assert.deepEqual(groups, [{ topic: topic('ok'), members: [bulbA, bulbB] }]);
});

test('a publish goes to Home Assistant as mqtt.publish: its payload as JSON text, QoS 0, not retained', () => {
  // Break: another service, the payload passed as an object, or a bulb command retained (the broker would replay it).
  assert.deepEqual(publishCall({ topic: topic('bulb-a'), payload: { brightness: toLevel(100), transition: toSeconds(0.4) } }), {
    service: 'mqtt.publish',
    data: { topic: 'zigbee2mqtt/bulb-a/set', payload: '{"brightness":100,"transition":0.4}', qos: 0, retain: false },
  });
});

test('a dashboard message is published as given, retained when asked', () => {
  // Break: the retain flag is dropped, so a control's state is lost when Home Assistant reconnects.
  assert.deepEqual(mqttPublishCall('lighting/ui/lamp/power/state', 'ON', true),
    { service: 'mqtt.publish', data: { topic: 'lighting/ui/lamp/power/state', payload: 'ON', qos: 0, retain: true } });
});

test('a switch goes to Home Assistant as homeassistant.turn_on or turn_off on its entity', () => {
  // Break: the power is not the service, or the switch is not the target.
  const plug = toSwitchId('switch.plug');
  assert.deepEqual(switchCall(plug, 'on'), { service: 'homeassistant.turn_on', data: {}, target: { entity_id: 'switch.plug' } });
  assert.deepEqual(switchCall(plug, 'off'), { service: 'homeassistant.turn_off', data: {}, target: { entity_id: 'switch.plug' } });
});
