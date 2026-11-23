/**
 * What the bulbs and switches report, read from Home Assistant's states: the
 * reconciler compares it with the lighting state. A bulb reports its power,
 * level and colour; the firmware candle is not reported, so the reconciler
 * knows it only from what it sent.
 *
 * Read leniently: a state Home Assistant does not have, or one it holds as
 * `unavailable` or `unknown`, is a bulb or switch that cannot be reached.
 */
import { decodeColour } from './codecs/config.ts';
import type { Config } from '../domain/config.ts';
import type { BulbId, SwitchId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { Colour, Level, Power } from '../domain/types/light.ts';
import type { EntityState } from '../runtime/context.ts';
import { parseFinite } from '../runtime/parse.ts';
import { toLevel } from '../parse/ids.ts';

export type ObservedLight = { power: 'off' } | { power: 'on'; level: Level; colour: Colour | undefined };
export type ObservedBulb = { reach: 'unreachable' } | { reach: 'reachable'; light: ObservedLight };
/** A bulb `on` with its level and colour, or `off`; anything else cannot be reached. */
function observedBulb(state: EntityState | undefined): ObservedBulb {
  if (state?.state === 'off') return { reach: 'reachable', light: { power: 'off' } };
  if (state?.state !== 'on') return { reach: 'unreachable' };
  return { reach: 'reachable', light: { power: 'on', level: levelOf(state), colour: decodeColour(state) } };
}

/**
 * A lit bulb's level: its reported brightness held to 1..254. A light that
 * reports none is a light that does not dim, which is at full.
 */
function levelOf(state: EntityState): Level {
  const brightness = parseFinite(state.attributes['brightness']);
  return toLevel(brightness === undefined ? FULL : Math.min(FULL, Math.max(1, Math.round(brightness))));
}

export type Observed = { bulbs: Record<BulbId, ObservedBulb>; switches: Record<SwitchId, Power | 'unreachable'>; bridgeConnected: boolean };

/** Every bulb of every lamp, every switch, and whether Zigbee2MQTT is connected (`binary_sensor.zigbee2mqtt_bridge_connection_state`). */
export function decodeObserved(states: Readonly<Record<string, EntityState>>, config: Config): Observed {
  const bulbs: Record<BulbId, ObservedBulb> = {};
  for (const [, lamp] of entriesOf(config.lamps)) for (const { bulb } of lamp.bulbs) bulbs[bulb] = observedBulb(states[bulb]);
  const switches: Record<SwitchId, Power | 'unreachable'> = {};
  for (const [plug] of entriesOf(config.switches)) switches[plug] = observedSwitch(states[plug]);
  return { bulbs, switches, bridgeConnected: states['binary_sensor.zigbee2mqtt_bridge_connection_state']?.state === 'on' };
}

function observedSwitch(state: EntityState | undefined): Power | 'unreachable' {
  return state?.state === 'on' || state?.state === 'off' ? state.state : 'unreachable';
}

/** The top of the Zigbee level scale. */
const FULL = 254;
