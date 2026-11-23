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
 * It also builds the Home Assistant call that carries each of a turn's
 * outputs: a publish (`mqtt.publish`), a switch's power
 * (`homeassistant.turn_on`/`turn_off`), and the helper, sensor, store and
 * dashboard writes.
 */
import type { BulbGroups } from './codecs/bulb-groups.ts';
import type { Outcome, Send } from './reconcile.ts';
import { roundEven } from '../domain/blend.ts';
import type { BulbAppearance } from '../domain/effect.ts';
import type { BulbId, SwitchId } from '../domain/types/ids.ts';
import type { MqttTopic } from './codecs/ids.ts';
import type { Colour, Level, Power } from '../domain/types/light.ts';
import type { Instant, Seconds } from '../domain/types/time.ts';
import type { ServiceCall } from './ha-client.ts';
import type { LiveRooms } from './live-rooms.ts';
import type { HelperValue } from './codecs/remote-helpers.ts';
import type { DashboardWrite, HelperWrite, SensorWrite, StoreWrite } from './codecs/writes.ts';

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

/** Two payloads are the same publish when they go out as the same text. */
function payloadText(payload: BulbPayload): string {
  return JSON.stringify(payload);
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

/** The publishes for one round of bulbs: each whole group whose members all get the same payload as one, the rest one by one. */
export function groupedPublishes(rows: readonly BulbPublish[], groups: BulbGroups): Publish[] {
  const byBulb = new Map(rows.map(row => [row.bulb, row]));
  const used = new Set<BulbId>();
  const sent: Publish[] = [];
  for (const group of groups) {
    const members = group.members.map(bulb => byBulb.get(bulb));
    const first = members[0];
    if (first === undefined || group.members.some(bulb => used.has(bulb))
      || members.some(row => row === undefined || payloadText(row.payload) !== payloadText(first.payload))) continue;
    sent.push({ topic: group.topic, payload: first.payload });
    for (const bulb of group.members) used.add(bulb);
  }
  for (const row of [...byBulb.values()].sort((a, b) => compare(a.bulb, b.bulb))) {
    if (!used.has(row.bulb)) sent.push({ topic: row.topic, payload: row.payload });
  }
  return sent;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A send to a bulb: its light, or its candle's start alone. */
export type BulbSend = Exclude<Send, { kind: 'switch' }>;

/** Leaving the candle: the Innr firmware's stop. */
const STOP: BulbPayload = { effect: 'stop_effect' };
/** The candle's start: Identify TriggerEffect 0x0b on the candle firmware. */
const START = { effect: 'channel_change' } as const satisfies BulbPayload;

/** One thing a turn asks Home Assistant to do, in the order it is asked. */
export type Output =
  | { kind: 'publish'; publish: Publish }
  | { kind: 'switch'; switch: SwitchId; power: Power }
  | { kind: 'sensor'; write: SensorWrite }
  | { kind: 'helper'; write: HelperWrite }
  | { kind: 'store'; write: StoreWrite }
  | { kind: 'dashboard'; write: DashboardWrite };

/** An output as the Home Assistant call that carries it out, at the turn's clock `now`. */
export function outputCall(output: Output, now: Instant): ServiceCall {
  switch (output.kind) {
    case 'publish': return publishCall(output.publish);
    case 'switch': return switchCall(output.switch, output.power);
    case 'sensor': {
      const { entity, revision, attributes, basis } = output.write;
      return { service: 'variable.update_sensor', target: { entity_id: entity }, data: { value: revision, attributes, replace_attributes: false },
        ...basis === undefined ? {} : { guard: { entity, lastUpdated: basis } } };
    }
    case 'helper': return helperCall(output.write.entity, output.write.value, now);
    case 'store': return { service: 'input_text.set_value', data: { value: output.write.text }, target: { entity_id: output.write.entity } };
    case 'dashboard': return dashboardCall(output.write);
  }
}

/** A switch's power as Home Assistant's `homeassistant.turn_on` or `homeassistant.turn_off` on the switch. */
export function switchCall(target: SwitchId, power: Power): ServiceCall {
  return { service: `homeassistant.turn_${power}`, data: {}, target: { entity_id: target } };
}

/** A remote helper's write, as the gesture script made it: a value set, or the chord timer started or cancelled. */
function helperCall(entity: string, value: HelperValue, now: Instant): ServiceCall {
  const target = { entity_id: entity };
  switch (value.kind) {
    case 'number': return { service: 'input_number.set_value', data: { value: value.value }, target };
    case 'text': return { service: 'input_text.set_value', data: { value: value.value }, target };
    case 'timer': return value.running
      ? { service: 'timer.start', data: { duration: duration(value.until - now) }, target }
      : { service: 'timer.cancel', data: {}, target };
  }
}

/** A timer's duration in whole seconds, as `HH:MM:SS`: the chord's three seconds are `00:00:03`. */
function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const two = (part: number) => `${part}`.padStart(2, '0');
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}`;
}

function dashboardCall(write: DashboardWrite): ServiceCall {
  switch (write.kind) {
    case 'block selector': return { service: 'input_select.select_option', data: { option: write.option }, target: { entity_id: write.entity } };
    case 'mode mirror': return { service: `input_boolean.turn_${write.on ? 'on' : 'off'}`, data: {}, target: { entity_id: write.entity } };
    case 'control sync': case 'discovery': return mqttPublishCall(write.topic, write.payload, true);
  }
}

/** An MQTT message as Home Assistant's `mqtt.publish` call, at QoS 0; a dashboard control's state is retained. */
/** One bulb's wanted publish. */
export type BulbPublish = { bulb: BulbId; topic: MqttTopic; payload: BulbPayload };

/** Does `publish` carry part of `send`: is it to the bulb's own topic, or to a Zigbee group the bulb is in? */
export function carries(send: BulbSend, publish: Publish, topics: Readonly<Record<BulbId, MqttTopic>>, groups: BulbGroups): boolean {
  return publish.topic === topics[send.bulb] || groups.some(group => group.topic === publish.topic && group.members.includes(send.bulb));
}

/**
 * How a bulb's send went, from the publishes carrying it that failed (see {@link carries}). Its light (or OFF)
 * failed: `failed`, every member of a failed group publish alike. Only its candle's start failed: `start failed`, or
 * `failed` for a start sent alone. A failed stop alone is no failure: the light after it ends the candle too.
 */
export function outcomeOf(send: BulbSend, failed: readonly Publish[]): Outcome {
  const startFailed = failed.some(publish => 'effect' in publish.payload && publish.payload.effect === START.effect);
  if (send.kind === 'start') return startFailed ? 'failed' : 'sent';
  if (failed.some(publish => !('effect' in publish.payload))) return 'failed';
  return startFailed ? 'start failed' : 'sent';
}

/** The time a turn's sends took, in seconds, as the runtime sensor shows it (`last_latency`). */
export function timingCall(seconds: number): ServiceCall {
  return { service: 'variable.update_sensor', target: { entity_id: RUNTIME_SENSOR },
    data: { attributes: { last_latency: Math.round(seconds * 1000) / 1000 }, replace_attributes: false } };
}

export function mqttPublishCall(topic: string, payload: string, retain: boolean): ServiceCall {
  return { service: 'mqtt.publish', data: { topic, payload, qos: 0, retain } };
}

/** The sensor that shows how the lighting runs. */
const RUNTIME_SENSOR = 'sensor.ls_effects_runtime';

/** The text helper the port's heartbeat writes. */
const HEARTBEAT = 'input_text.ls_port_heartbeat';

/**
 * The port's heartbeat: `<unix seconds>|<live rooms>`. Home Assistant's
 * watchdog turns off every port switch on for a room this does not name, or
 * every one once it stops changing, so a port that stopped, crashed or was
 * started without a room hands those rooms back to the old scripts. The time
 * makes every beat a change; staleness is judged by Home Assistant's own
 * clock. A port with no live room beats nothing, so it sends nothing at all.
 */
export function heartbeatCall(live: LiveRooms, nowMs: number): ServiceCall | undefined {
  if (live.size === 0) return undefined;
  return { service: 'input_text.set_value', data: { value: `${Math.floor(nowMs / 1000)}|${[...live].sort().join(',')}` },
    target: { entity_id: HEARTBEAT } };
}
