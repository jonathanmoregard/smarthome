/**
 * A reconciler's sends as Zigbee2MQTT publishes. The sending rule for the
 * candle lives here (spec 3.4.3): the candle's colour and level first, then
 * `effect: channel_change`, and nothing after the start carries On or a
 * brightness, because the firmware ends the candle on either. Leaving the
 * candle sends `stop_effect` first.
 *
 * Moved from `frameRows`, `bulbEffect`, `stopCommands` and
 * `bulbStartCommands` (the deleted `src/legacy/domain/transport.ts` and the
 * dispatch half of `dispatch-render.ts`): the payload keys and their rounding,
 * the stops before the lights and the starts after them. The publishes go in
 * three rounds, every stop, then every light, then every start, as today's
 * dispatch sends them, so no bulb receives a light after its own start.
 *
 * It also builds the Home Assistant calls that carry a publish
 * (`mqtt.publish`) and a switch's power (`homeassistant.turn_on`/`turn_off`),
 * which `turn.ts` used to build inline.
 */
import { groupedPublishes } from './bulb-groups.ts';
import type { BulbGroups } from './bulb-groups.ts';
import type { Outcome, Send } from './reconcile.ts';
import { roundEven } from '../domain/blend.ts';
import type { BulbAppearance } from '../domain/effect.ts';
import type { BulbId, Id, SwitchId } from '../domain/types/ids.ts';
import type { Colour, Level, Power } from '../domain/types/light.ts';
import type { Seconds } from '../domain/types/time.ts';
import type { ServiceCall } from './ha-client.ts';

/** A Zigbee2MQTT command topic: a bulb's (`zigbee2mqtt/<bulb>/set`) or a Zigbee group's. */
export type MqttTopic = Id<'MqttTopic'>;

/**
 * The Zigbee2MQTT keys a bulb is sent, closed: an effect command, Off, or a
 * level with the colour when the lamp has one. Wire keys, because this is the
 * wire: `color_temp` is in mireds, `color.rgb` is `r,g,b` text.
 */
export type BulbPayload =
  | { effect: 'stop_effect' }
  | { effect: 'channel_change' }
  | { state: 'OFF'; transition: Seconds }
  | { brightness: Level; transition: Seconds }
  | { brightness: Level; color_temp: number; transition: Seconds }
  | { brightness: Level; color: { rgb: string }; transition: Seconds };

/** What the bulb is to show, with its transition: OFF, or its level and, when the lamp has one, its colour. */
function lightPayload(appearance: BulbAppearance, transition: Seconds): BulbPayload {
  if (appearance.power === 'off') return { state: 'OFF', transition };
  const brightness = appearance.level, colour = appearance.colour;
  if (colour === undefined) return { brightness, transition };
  return { brightness, ...colourKeys(colour), transition };
}

/** A colour's keys: kelvin as whole mireds, RGB as whole channels joined `r,g,b`. */
function colourKeys(colour: Colour): { color_temp: number } | { color: { rgb: string } } {
  switch (colour.kind) {
    case 'kelvin': return { color_temp: roundEven(1_000_000 / colour.kelvin) };
    case 'rgb': return { color: { rgb: [colour.rgb.red, colour.rgb.green, colour.rgb.blue].map(channel => Math.round(channel)).join(',') } };
  }
}

export type Publish = { topic: MqttTopic; payload: BulbPayload };

/** A publish as Home Assistant's `mqtt.publish` call: the payload as JSON text, not retained. */
export function publishCall(publish: Publish): ServiceCall {
  return mqttPublishCall(publish.topic, JSON.stringify(publish.payload), false);
}

/** An MQTT message as Home Assistant's `mqtt.publish` call, at QoS 0; a dashboard control's state is retained. */
export function mqttPublishCall(topic: string, payload: string, retain: boolean): ServiceCall {
  return { service: 'mqtt.publish', data: { topic, payload, qos: 0, retain } };
}

/**
 * The sends as publishes, in three rounds: stop_effect for each bulb leaving the candle; each light (level and colour,
 * or OFF) with its transition; then each candle's start, a start sent alone included. Nothing after a start carries
 * On or a brightness. A bulb with no topic is sent nothing.
 */
export function publishes(sends: readonly Send[], topics: Readonly<Record<BulbId, MqttTopic>>, groups: BulbGroups): Publish[] {
  const round = (payloadOf: (send: Extract<Send, { kind: 'bulb' | 'start' }>) => BulbPayload | undefined): Publish[] =>
    groupedPublishes(sends.flatMap(send => {
      if (send.kind === 'switch') return [];
      const topic = topics[send.bulb], payload = payloadOf(send);
      return topic === undefined || payload === undefined ? [] : [{ bulb: send.bulb, topic, payload }];
    }), groups);
  return [
    ...round(send => send.kind === 'bulb' && send.stopFirst ? STOP : undefined),
    ...round(send => send.kind === 'bulb' ? lightPayload(send.appearance, send.over) : undefined),
    ...round(send => send.appearance.power === 'on' && send.appearance.firmwareEffect === 'candle' ? START : undefined),
  ];
}

/**
 * How one send went, from the publishes that failed: a publish to the bulb's topic, or to a Zigbee group it is in,
 * carries its part. Its light (or OFF) failed: `failed`, every member of a failed group publish alike. Only its
 * candle's start failed: `start failed`, or `failed` for a start sent alone. A failed stop alone is no failure: the
 * light after it ends the candle too. A switch's power is no publish.
 */
export function outcomeOf(send: Send, failed: readonly Publish[], topics: Readonly<Record<BulbId, MqttTopic>>, groups: BulbGroups): Outcome {
  if (send.kind === 'switch') return 'sent';
  const bulb = send.bulb;
  const carried = failed.filter(publish => publish.topic === topics[bulb]
    || groups.some(group => group.topic === publish.topic && group.members.includes(bulb)));
  const startFailed = carried.some(publish => 'effect' in publish.payload && publish.payload.effect === START.effect);
  if (send.kind === 'start') return startFailed ? 'failed' : 'sent';
  if (carried.some(publish => !('effect' in publish.payload))) return 'failed';
  return startFailed ? 'start failed' : 'sent';
}

/** Leaving the candle: the Innr firmware's stop. */
const STOP: BulbPayload = { effect: 'stop_effect' };
/** The candle's start: Identify TriggerEffect 0x0b on the candle firmware. */
const START = { effect: 'channel_change' } as const satisfies BulbPayload;

/** A switch's power as Home Assistant's `homeassistant.turn_on` or `homeassistant.turn_off` on the switch. */
export function switchCall(target: SwitchId, power: Power): ServiceCall {
  return { service: `homeassistant.turn_${power}`, data: {}, target: { entity_id: target } };
}
