/**
 * Zigbee2MQTT's bridge events, as Home Assistant's `mqtt/subscribe` forwards them (closeout r2 A3). A bulb announces
 * itself when it powers up, its wall power back, whether or not Home Assistant ever saw it unavailable; the announce
 * names the bulb by the friendly name its topic carries. Read leniently: anything that is no announce of a bulb the
 * catalog gives a topic is none, never an error.
 */
import type { BulbId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { JsonValue } from '../ha-client.ts';
import type { Catalog } from './catalog.ts';
import { bulbTopics } from './config.ts';
import type { MqttTopic } from './ids.ts';
import { ZIGBEE2MQTT_BASE } from './ids.ts';
import { isObject } from './parse.ts';

/** The topic Zigbee2MQTT publishes its bridge's events on. */
export const BRIDGE_EVENT_TOPIC = `${ZIGBEE2MQTT_BASE}/bridge/event`;

/**
 * The bulb a bridge event announces: its payload, JSON text, is `{type: 'device_announce', data: {friendly_name}}`
 * and the name is the one a bulb's topic carries. None for a payload that is no text, no JSON or another event, or
 * for a device the catalog gives no bulb topic.
 */
export function announcedBulb(payload: JsonValue | undefined, catalog: Catalog): BulbId | undefined {
  const event = typeof payload === 'string' ? jsonOf(payload) : undefined;
  if (!isObject(event) || event.type !== 'device_announce' || !isObject(event.data)) return undefined;
  const name = event.data.friendly_name;
  if (typeof name !== 'string' || name === '') return undefined;
  const found = entriesOf(bulbTopics(catalog)).find(([, topic]) => friendlyName(topic) === name);
  return found === undefined ? undefined : found[0];
}

/** JSON text read; none for text that is no JSON. */
function jsonOf(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The friendly name a bulb's topic reaches it by: the topic under the base, its command suffix dropped; none outside the base. */
function friendlyName(topic: MqttTopic): string | undefined {
  const base = `${ZIGBEE2MQTT_BASE}/`, command = '/set';
  if (!topic.startsWith(base)) return undefined;
  const name = topic.slice(base.length);
  return name.endsWith(command) ? name.slice(0, -command.length) : name;
}
