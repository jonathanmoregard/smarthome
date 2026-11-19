import { isDeepStrictEqual } from 'node:util';
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { storedEquals, withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { roundEven } from './scale.ts';
import { isAreaId } from './schedule.ts';
import {
  discoveryRows, displayOfColour, lampReading, onOffOnly, parseRangeSaveArgs, parseUiSyncArgs, proxyKelvin,
  proxyShowsRgb, runtimeTargets, storedRangeBounds, uiProfile, uiRows,
} from '../parse/ui-state.ts';
import type { Display, RangeSaveArgs } from '../parse/ui-state.ts';

/**
 * One MQTT message for the UI proxy. Both fields are built here -- the topic
 * only after the row's topics mapping is proved to hold a string for the
 * channel, the payload formatted from locals -- so nothing is passed through
 * from an input document and the published bytes cannot drift from the type.
 */
export type UiMessage = { topic: string; payload: string };

export function uiMessages(ctx: ScriptContext, force: boolean): UiMessage[] {
  const runtime = runtimeTargets(ctx);
  const messages: UiMessage[] = [];
  for (const parseRow of uiRows(ctx)) {
    const { source, proxy, store, members, topic: topicOf } = parseRow();
    const append = (channel: string, payload: string) => {
      const topic = topicOf(channel);
      if (topic === undefined) throw Error(`UI row has no ${channel} topic: ${source}`);
      messages.push({ topic, payload });
    };
    const available = ['on', 'off'].includes(ctx.get(source));
    if (force || available !== ['on', 'off'].includes(ctx.get(proxy))) append('availability', available ? 'online' : 'offline');
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
      const pr = uiProfile(ctx, store);
      const stored = pr.effectChannels.length > 0 ? pr.effect() : undefined;
      effect = stored === undefined ? 'Normal light' : stored;
    }
    if (effect === 'Normal light') effect = 'Normal Light';
    let { brightness: b, colourTemp, kelvin: k, rgb } = lampReading(ctx, source);
    let target = runtime.target(source);
    if (store === undefined && (members.length > 1 || !members.includes(source))) {
      const areas = [...new Set(members.map(e => ctx.areas[e]).filter(isAreaId))];
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
    if (force || ctx.get(proxy) !== ctx.get(source)) append('power', ctx.get(source) === 'on' ? 'ON' : 'OFF');
    if (force || ctx.attr(proxy, 'effect') !== effect) append('effect', effect);
    if (b !== undefined && (force || ctx.attr(proxy, 'brightness') !== roundEven(b))) append('brightness', String(roundEven(b)));
    if (colourTemp && k !== undefined && k > 0) {
      const mired = roundEven(1e6 / k), proxyK = proxyKelvin(ctx, proxy);
      const proxyMired = proxyK > 0 ? roundEven(1e6 / proxyK) : 0;
      if (force || ctx.attr(proxy, 'color_mode') !== 'color_temp' || proxyMired !== mired) append('temperature', String(mired));
    } else if (rgb !== undefined) {
      if (force || ctx.attr(proxy, 'color_mode') !== 'rgb' || !proxyShowsRgb(ctx, proxy, rgb)) append('rgb', rgb.text);
    }
  }
  return messages;
}
function uiCatalog(ctx: ScriptContext): null {
  ctx.run('effects_catalog');
  // Absent means the catalog names no choices, which selects these two; the
  // catalog parse already rejected a present-but-malformed list.
  const choices = ctx.catalog.ui_choices === undefined
    ? ['Normal Light', 'Candle']
    : ctx.catalog.ui_choices;
  for (const row of discoveryRows(ctx)) {
    if (!isDeepStrictEqual(ctx.attr(row.entity, 'effect_list'), choices)) {
      ctx.emit('mqtt.publish', { topic: `homeassistant/light/${row.uniqueId}/config`, payload: JSON.stringify(withFields(row.config, { effect_list: choices })), qos: 0, retain: true });
    }
  }
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

export function rangeSave(ctx: ScriptContext, args: RangeSaveArgs): RangeSaveResult {
  const { entity, profile, dryRun } = args;
  const e = entity;
  const previous = storedRangeBounds(ctx, e);
  const lo = args.minimum === undefined ? previous.min : args.minimum;
  const hi = args.maximum === undefined ? previous.max : args.maximum;
  const errors: string[] = [], config: RangeConfig = { profile };
  const domain = e.split('.')[0];
  const supportedDomain = domain !== undefined && ['switch', 'light'].includes(domain);
  const blocked = /^(switch|light)\.(ls_|ep_)/.test(e) || e.includes('permit_join');
  const devices = ctx.devices === undefined ? {} : ctx.devices;
  const hasDevice = Object.values(devices).some(entities => entities.includes(e));
  if (!supportedDomain || !ctx.state[e] || !hasDevice || blocked) errors.push('Choose a physical on/off lamp or smart plug.');
  else if (domain === 'light') {
    if (!onOffOnly(ctx, e)) errors.push('Choose an on/off lamp; dimmable lamps use the normal lighting settings.');
  }
  if (supportedDomain && ctx.state[e] && ctx.areas[e] === undefined) errors.push('Assign this lamp to a room before configuring its range.');
  // `profile` is already a string from the parse above, so the String() this
  // read used to carry converted nothing.
  if (!['bright', 'cosy', 'custom'].includes(profile)) errors.push('Choose Bright Default, Cosy Default, or Own Range.');
  else if (profile === 'custom') {
    if (typeof lo !== 'number' || typeof hi !== 'number' || !(0 <= lo && lo <= hi && hi <= 100)) errors.push('Enter both ends of Own Range: 0–100%, with From no higher than Through.');
    else { config.min = lo; config.max = hi; }
  }
  const result: RangeSaveResult = { valid: errors.length === 0, errors, entity, config };
  if (dryRun) return result;
  if (errors.length) throw new Error(errors.join(' '));
  ctx.fire('ls_override', { op: 'range_set', entity, profile,
    min: config.min === undefined ? null : config.min,
    max: config.max === undefined ? null : config.max,
    via: 'schedule-ui' });
  return result;
}
export const uiHandlers: ScriptHandlers = {
  effects_ui_catalog: ctx => uiCatalog(ctx),
  effects_ui_sync: withParsedArgs({
    parse: parseUiSyncArgs,
    run: (ctx, args) => {
    if (!args.dryRun) ctx.run('effects_ui_catalog');
    const messages = uiMessages(ctx, args.force);
    if (args.dryRun) return { messages };
    for (const message of messages) ctx.emit('mqtt.publish', { ...message, qos: 0, retain: true });
    return null;
    },
  }),
  // Every argument read is eager in the captured script and none can raise
  // between them, so the arguments parse up front.
  ls_range_save: withParsedArgs({ parse: parseRangeSaveArgs, run: rangeSave }),
};
