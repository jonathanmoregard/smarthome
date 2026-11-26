import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'home-assistant-js-websocket';
import type { HaWebSocket } from 'home-assistant-js-websocket';
import { announcedBulb, BRIDGE_EVENT_TOPIC } from '../../src/adapter/codecs/bridge-event.ts';
import { parseCatalog } from '../../src/adapter/codecs/catalog.ts';
import { HomeAssistantClient } from '../../src/adapter/ha-client.ts';
import type { JsonValue } from '../../src/adapter/ha-client.ts';
import { CATALOG } from './fixtures/house-view.ts';

/**
 * A bulb's own power-up, as Zigbee2MQTT announces it on its bridge's event topic and Home Assistant's `mqtt/subscribe`
 * forwards it (closeout r2 A3): the payload is read leniently, as anything that is no announce of a bulb the catalog
 * names is no input.
 */

const catalog = parseCatalog(CATALOG);
/** A catalog whose bulb is reached on Zigbee2MQTT's command topic, its friendly name with a space in it. */
const commandTopics = parseCatalog({ members: { 'light.desk': ['light.desk_1'] }, topics: { 'light.desk_1': 'zigbee2mqtt/desk one/set' } });
const announce = (data: JsonValue): string => JSON.stringify({ type: 'device_announce', data });

test("a bulb's announce names the bulb whose topic carries its friendly name, with or without the command suffix", () => {
  // Break: the friendly name is matched against the bulb id, or the topic's `/set` is kept, so a real catalog's bulb
  // never comes back on through its announce.
  assert.equal(announcedBulb(announce({ friendly_name: 'bulb-a3', ieee_address: '0x0000000000000003' }), catalog), 'bulb-a3');
  assert.equal(announcedBulb(announce({ friendly_name: 'desk one', ieee_address: '0x0000000000000001' }), commandTopics), 'light.desk_1');
});

test('an announce of a device the catalog gives no bulb topic names no bulb', () => {
  // Break: an unknown device (a remote, a plug, a bulb of no lamp) becomes an input for a bulb that is not ours.
  assert.equal(announcedBulb(announce({ friendly_name: 'remote-a', ieee_address: '0x00000000000000ff' }), catalog), undefined);
  assert.equal(announcedBulb(announce({ friendly_name: 'desk one/set' }), commandTopics), undefined);
});

test("the bridge's other events name no bulb", () => {
  // Break: a join, a leave or an interview of a bulb reads as its power-up.
  for (const type of ['device_joined', 'device_interview', 'device_leave', 'device_renamed']) {
    assert.equal(announcedBulb(JSON.stringify({ type, data: { friendly_name: 'bulb-a3' } }), catalog), undefined, type);
  }
});

test('a payload that is not JSON text names no bulb, and raises nothing', () => {
  // Break: a garbled payload throws inside the subscription's callback, or text that is no JSON is read anyway.
  assert.equal(announcedBulb('{"type": "device_announce"', catalog), undefined);
  assert.equal(announcedBulb('', catalog), undefined);
  assert.equal(announcedBulb(null, catalog), undefined);
  assert.equal(announcedBulb(undefined, catalog), undefined);
  assert.equal(announcedBulb({ type: 'device_announce', data: { friendly_name: 'bulb-a3' } }, catalog), undefined, 'an object, not its text');
});

test('an announce of the wrong shape names no bulb', () => {
  // Break: a payload missing its data, or with a friendly name that is no text, reaches the topic lookup.
  for (const payload of ['[]', '"device_announce"', '{"type":"device_announce"}', announce(null), announce('bulb-a3'), announce([]),
    announce({}), announce({ friendly_name: 3 }), announce({ friendly_name: '' }), announce({ friendly_name: null })]) {
    assert.equal(announcedBulb(payload, catalog), undefined, payload);
  }
});

test("the subscription's topic is the one Zigbee2MQTT publishes its bridge events on", () => {
  // Break: a misspelt topic (`bridge/events`, no base) subscribes to nothing, and no announce ever arrives.
  assert.equal(BRIDGE_EVENT_TOPIC, 'zigbee2mqtt/bridge/event');
});

class SocketPort extends EventTarget {
  OPEN = 1; readyState = 1; haVersion = '2026.7.4'; frames: Record<string, unknown>[] = [];
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>; this.frames.push(frame);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, type: 'result', success: true, result: null }) })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test("an MQTT topic is subscribed through Home Assistant's mqtt/subscribe, each message's payload handed on, released on close", async () => {
  // Break: the frame is not Home Assistant's (`mqtt/subscribe` with the topic), the payload is not handed on as sent,
  // or the subscription outlives the client.
  const socket = new SocketPort();
  const connection = await createConnection({ createSocket: async () => socket as unknown as HaWebSocket });
  const client = new HomeAssistantClient(connection);
  const payloads: (JsonValue | undefined)[] = [];
  await client.subscribeMqtt('zigbee2mqtt/bridge/event', payload => { payloads.push(payload); });
  const frame = socket.frames.at(-1);
  assert.deepEqual(frame, { id: frame?.id, type: 'mqtt/subscribe', topic: 'zigbee2mqtt/bridge/event' });
  const text = announce({ friendly_name: 'bulb-a3' });
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', id: frame?.id,
    event: { topic: 'zigbee2mqtt/bridge/event', payload: text, qos: 0, retain: false } }) }));
  assert.deepEqual(payloads, [text]);
  await client.close();
  assert.equal(connection.commands.size, 0);
});
