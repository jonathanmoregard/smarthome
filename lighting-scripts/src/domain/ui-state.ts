import type { Effect, HouseView, Plan } from '../runtime/effects.ts';
import { storedEquals, withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { roundEven } from './scale.ts';
import { isAreaId } from './schedule.ts';
import {
  displayOfColour, lampReading, onOffOnly, proxyKelvin, proxyShowsRgb, runtimeTargets, storedRangeBounds, uiProfile, uiRows,
} from '../parse/ui-state.ts';
import type { DiscoveryRow, Display, RangeSaveArgs } from '../parse/ui-state.ts';
import { payloadNumber } from '../runtime/format.ts';

/**
 * One MQTT message for the UI proxy. Both fields are built here -- the topic
 * only after the row's topics mapping is proved to hold a string for the
 * channel, the payload formatted from locals -- so nothing is passed through
 * from an input document and the published bytes cannot drift from the type.
 */
export type UiMessage = { topic: string; payload: string };

export function uiMessages(view: HouseView, force: boolean): UiMessage[] {
  const runtime = runtimeTargets(view);
  const messages: UiMessage[] = [];
  for (const parseRow of uiRows(view)) {
    const { source, proxy, store, members, topic: topicOf } = parseRow();
    const append = (channel: string, payload: string) => {
      const topic = topicOf(channel);
      if (topic === undefined) throw Error(`UI row has no ${channel} topic: ${source}`);
      messages.push({ topic, payload });
    };
    const available = ['on', 'off'].includes(view.get(source));
    if (force || available !== ['on', 'off'].includes(view.get(proxy))) append('availability', available ? 'online' : 'offline');
    const names: string[] = [], levels: number[] = [], colors: Verbatim[] = [];
    for (const member of members) {
      const entry = runtime.member(member);
      names.push(...entry.claimEffects);
      if (entry.effect !== undefined) names.push(entry.effect);
      if (entry.level !== undefined) levels.push(entry.level);
      else if (entry.brightness !== undefined) levels.push(entry.brightness);
      if (entry.constantColour !== undefined) colors.push(entry.constantColour);
    }
    const unique = names.filter((name, i) => names.findIndex(other => other.toLowerCase() === name.toLowerCase()) === i);
    let effect = unique.length === 1 ? unique[0]! : unique.length > 1 ? '' : 'Normal light';
    if (store !== undefined) {
      const pr = uiProfile(view, store);
      const stored = pr.effectChannels.length > 0 ? pr.effect() : undefined;
      effect = stored === undefined ? 'Normal light' : stored;
    }
    if (effect === 'Normal light') effect = 'Normal Light';
    let { brightness: b, colourTemp, kelvin: k, rgb } = lampReading(view, source);
    let target = runtime.target(source);
    if (store === undefined && (members.length > 1 || !members.includes(source))) {
      const areas = [...new Set(members.map(e => view.areas[e]).filter(isAreaId))];
      if (areas.length === 1) target = runtime.target(`room:${areas[0]}`);
    }
    if (store === undefined) {
      if (target.level !== undefined) b = target.level;
      else if (levels.length === members.length && levels.length) b = roundEven(levels.reduce((sum, level) => sum + level, 0) / levels.length);
      let display: Display = { kind: 'neither' };
      if (target.display !== undefined) display = target.display;
      else if (!target.populated && colors.length === members.length && colors.length > 0 && colors.every(c => storedEquals(c, colors[0]))) display = displayOfColour(colors[0]!);
      if (display.kind === 'kelvin') { colourTemp = true; k = display.kelvin; }
      else if (display.kind === 'rgb') { colourTemp = false; rgb = display.rgb; }
    }
    if (!available) continue;
    if (force || view.get(proxy) !== view.get(source)) append('power', view.get(source) === 'on' ? 'ON' : 'OFF');
    if (force || view.attr(proxy, 'effect') !== effect) append('effect', effect);
    if (b !== undefined && (force || view.attr(proxy, 'brightness') !== roundEven(b))) append('brightness', payloadNumber(roundEven(b)));
    if (colourTemp && k !== undefined && k > 0) {
      const mired = roundEven(1e6 / k), proxyK = proxyKelvin(view, proxy);
      const proxyMired = proxyK > 0 ? roundEven(1e6 / proxyK) : 0;
      if (force || view.attr(proxy, 'color_mode') !== 'color_temp' || proxyMired !== mired) append('temperature', payloadNumber(mired));
    } else if (rgb !== undefined) {
      if (force || view.attr(proxy, 'color_mode') !== 'rgb' || !proxyShowsRgb(view, proxy, rgb)) append('rgb', rgb.text);
    }
  }
  return messages;
}
/** The UI's effect choices: the catalog's, or these two when it names none (a malformed list was already rejected). */
export function uiChoices(view: HouseView): string[] {
  return view.catalog.ui_choices === undefined ? ['Normal Light', 'Candle'] : view.catalog.ui_choices;
}
/** Republish one discovery row's config with the choices as its effect list. */
export function discoveryPublish(row: DiscoveryRow, choices: string[]): Effect {
  return {
    kind: 'service', service: 'mqtt.publish',
    data: {
      topic: `homeassistant/light/${row.uniqueId}/config`,
      payload: JSON.stringify(withFields(row.config, { effect_list: choices })), qos: 0, retain: true,
    },
  };
}
/** Publish the UI mirror's messages, retained. */
export function* publishUi(messages: UiMessage[]): Plan<null> {
  for (const message of messages) yield { kind: 'service', service: 'mqtt.publish', data: { ...message, qos: 0, retain: true } };
  return null;
}
/**
 * One switch's stored range rule. `min`/`max` are present only for the
 * `custom` profile, and this object is serialised into compared JSON, so an
 * absent bound must stay absent rather than become an explicit null.
 */
export type RangeConfig = { profile: string; min?: number; max?: number };
export type RangeSaveResult = {
  valid: boolean;
  errors: string[];
  entity: string;
  config: RangeConfig;
};

/**
 * Decide a switch's range rule. Not a generator: it reads the house through
 * the view, and the colour-mode read raises on a malformed list, so it is read
 * only on the branch that needs it.
 */
export function decideRangeSave(view: HouseView, args: RangeSaveArgs): RangeSaveResult {
  const { entity, profile } = args;
  const e = entity;
  const previous = storedRangeBounds(view, e);
  const lo = args.minimum === undefined ? previous.min : args.minimum;
  const hi = args.maximum === undefined ? previous.max : args.maximum;
  const errors: string[] = [], config: RangeConfig = { profile };
  const domain = e.split('.')[0];
  const supportedDomain = domain !== undefined && ['switch', 'light'].includes(domain);
  const blocked = /^(switch|light)\.(ls_|ep_)/.test(e) || e.includes('permit_join');
  const devices = view.devices === undefined ? {} : view.devices;
  const hasDevice = Object.values(devices).some(entities => entities.includes(e));
  if (!supportedDomain || !view.state[e] || !hasDevice || blocked) errors.push('Choose a physical on/off lamp or smart plug.');
  else if (domain === 'light') {
    if (!onOffOnly(view, e)) errors.push('Choose an on/off lamp; dimmable lamps use the normal lighting settings.');
  }
  if (supportedDomain && view.state[e] && view.areas[e] === undefined) errors.push('Assign this lamp to a room before configuring its range.');
  // `profile` is already a string from the parse above, so the String() this
  // read used to carry converted nothing.
  if (!['bright', 'cosy', 'custom'].includes(profile)) errors.push('Choose Bright Default, Cosy Default, or Own Range.');
  else if (profile === 'custom') {
    if (typeof lo !== 'number' || typeof hi !== 'number' || !(0 <= lo && lo <= hi && hi <= 100)) {
      errors.push('Enter both ends of Own Range: 0–100%, with From no higher than Through.');
    } else { config.min = lo; config.max = hi; }
  }
  return { valid: errors.length === 0, errors, entity, config };
}
/** Save a decided rule: refuse an invalid one, else fire the range override. */
export function* saveRange(result: RangeSaveResult): Plan<RangeSaveResult> {
  if (result.errors.length) throw new Error(result.errors.join(' '));
  const config = result.config;
  yield { kind: 'event', event: 'ls_override', data: { op: 'range_set', entity: result.entity, profile: config.profile,
    min: config.min === undefined ? null : config.min,
    max: config.max === undefined ? null : config.max,
    via: 'schedule-ui' } };
  return result;
}
