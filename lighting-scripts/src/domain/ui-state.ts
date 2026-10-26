import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { object, roundEven } from './scale.ts';
import { list, num, saved, strings } from './schedule.ts';

function rows(ctx: ScriptContext, key: string): JsonValue[] {
  const value = ctx.catalog?.[key];
  if (!Array.isArray(value)) throw new Error(`Missing runtime catalog.${key}`);
  return value;
}

export function uiMessages(ctx: ScriptContext, force: boolean): JsonObject[] {
  const targets = object(ctx.attr('sensor.ls_effects_runtime', 'targets'));
  const assignments = object(ctx.attr('sensor.ls_effects_runtime', 'assignments'));
  const messages: JsonObject[] = [];
  for (const raw of rows(ctx, 'ui_rows')) {
    const row = object(raw), source = String(row.source), proxy = String(row.proxy), store = String(row.store ?? '');
    const members = strings(row.members), topics = object(row.topics);
    const append = (channel: string, payload: string) => {
      if (typeof topics[channel] !== 'string') throw Error(`UI row has no ${channel} topic: ${source}`);
      messages.push({ topic: topics[channel], payload });
    };
    const available = ['on', 'off'].includes(ctx.get(source));
    if (force || available !== ['on', 'off'].includes(ctx.get(proxy))) append('availability', available ? 'online' : 'offline');
    const names: string[] = [], levels: number[] = [], colors: JsonObject[] = [];
    for (const member of members) {
      const entry = object(Object.hasOwn(targets, member) ? targets[member] : assignments[member]);
      for (const channel of ['brightness', 'color']) {
        const claim = object(entry[channel]);
        if (claim.kind === 'effect' && claim.effect) names.push(String(claim.effect));
      }
      if (entry.effect && entry.effect !== 'Normal light') names.push(String(entry.effect));
      if (typeof entry.level === 'number') levels.push(entry.level);
      else if (typeof entry.brightness === 'number') levels.push(entry.brightness);
      const color = object(entry.color);
      if (color.kind === 'constant' && color.value !== null && typeof color.value === 'object' && !Array.isArray(color.value)) colors.push(color.value);
    }
    const unique = names.filter((name, i) => names.findIndex(other => other.toLowerCase() === name.toLowerCase()) === i);
    let effect = unique.length === 1 ? unique[0]! : unique.length > 1 ? '' : 'Normal light';
    if (store) {
      const pr = saved(ctx, store);
      effect = list(pr.effect_channels ?? ['brightness', 'color']).length ? String(pr.effect ?? 'Normal light') : 'Normal light';
    }
    if (effect === 'Normal light') effect = 'Normal Light';
    let b = ctx.attr(source, 'brightness'), k = ctx.attr(source, 'color_temp_kelvin'), rgb = ctx.attr(source, 'rgb_color'), mode = ctx.attr(source, 'color_mode');
    let target = object(targets[source]);
    if (!store && (members.length > 1 || !members.includes(source))) {
      const areas = [...new Set(members.map(e => ctx.areas[e]).filter((a): a is string => Boolean(a)))];
      if (areas.length === 1) target = object(targets[`room:${areas[0]}`]);
    }
    if (!store) {
      if (typeof target.level === 'number') b = target.level;
      else if (levels.length === members.length && levels.length) b = roundEven(levels.reduce((sum, level) => sum + level, 0) / levels.length);
      const color = object(target.color);
      let display: JsonObject = {};
      if (color.kind === 'constant') display = object(color.value);
      else if (!Object.keys(target).length && colors.length === members.length && colors.length && colors.every(c => isDeepStrictEqual(c, colors[0]))) display = colors[0]!;
      if ('kelvin' in display) { mode = 'color_temp'; k = display.kelvin; }
      else if ('rgb' in display) { mode = 'rgb'; rgb = display.rgb; }
    }
    if (!available) continue;
    if (force || ctx.get(proxy) !== ctx.get(source)) append('power', ctx.get(source) === 'on' ? 'ON' : 'OFF');
    if (force || ctx.attr(proxy, 'effect') !== effect) append('effect', effect);
    if (typeof b === 'number' && (force || ctx.attr(proxy, 'brightness') !== roundEven(b))) append('brightness', String(roundEven(b)));
    if (mode === 'color_temp' && typeof k === 'number' && k > 0) {
      const mired = roundEven(1e6 / k), proxyK = num(ctx.attr(proxy, 'color_temp_kelvin'));
      const proxyMired = proxyK > 0 ? roundEven(1e6 / proxyK) : 0;
      if (force || ctx.attr(proxy, 'color_mode') !== 'color_temp' || proxyMired !== mired) append('temperature', String(mired));
    } else if (Array.isArray(rgb) && rgb.length === 3) {
      if (force || ctx.attr(proxy, 'color_mode') !== 'rgb' || !isDeepStrictEqual(list(ctx.attr(proxy, 'rgb_color')), rgb)) append('rgb', rgb.join(','));
    }
  }
  return messages;
}
function uiCatalog(ctx: ScriptContext): null {
  ctx.run('effects_catalog');
  const choices = ctx.catalog?.ui_choices ?? ['Normal Light', 'Candle'];
  for (const raw of rows(ctx, 'ui_discovery')) {
    const row = object(raw), config = object(row.config);
    if (!isDeepStrictEqual(ctx.attr(String(row.entity), 'effect_list'), choices)) {
      ctx.emit('mqtt.publish', { topic: `homeassistant/light/${config.unique_id}/config`, payload: JSON.stringify({ ...config, effect_list: choices }), qos: 0, retain: true });
    }
  }
  return null;
}
export function rangeSave(ctx: ScriptContext, args: JsonObject): JsonObject {
  const entity = args.entity ?? '', profile = args.profile ?? 'bright';
  const e = typeof entity === 'string' ? entity : '';
  const previous = object(object(ctx.attr('sensor.ls_overrides', 'switch_ranges'))[e]);
  const lo = args.minimum ?? previous.min, hi = args.maximum ?? previous.max;
  const errors: string[] = [], config: JsonObject = { profile };
  const domain = e.split('.')[0];
  const blocked = /^(switch|light)\.(ls_|ep_)/.test(e) || e.includes('permit_join') || typeof entity !== 'string';
  const hasDevice = Object.values(ctx.devices ?? {}).some(entities => entities.includes(e));
  if (!['switch', 'light'].includes(domain ?? '') || !ctx.state[e] || !hasDevice || blocked) errors.push('Choose a physical on/off lamp or smart plug.');
  else if (domain === 'light' && !isDeepStrictEqual(ctx.attr(e, 'supported_color_modes') ?? [], ['onoff'])) errors.push('Choose an on/off lamp; dimmable lamps use the normal lighting settings.');
  if (['switch', 'light'].includes(domain ?? '') && ctx.state[e] && ctx.areas[e] === undefined) errors.push('Assign this lamp to a room before configuring its range.');
  if (!['bright', 'cosy', 'custom'].includes(String(profile))) errors.push('Choose Bright Default, Cosy Default, or Own Range.');
  else if (profile === 'custom') {
    if (typeof lo !== 'number' || typeof hi !== 'number' || !(0 <= lo && lo <= hi && hi <= 100)) errors.push('Enter both ends of Own Range: 0–100%, with From no higher than Through.');
    else { config.min = lo; config.max = hi; }
  }
  const result: JsonObject = { valid: errors.length === 0, errors, entity, config };
  if (args.dry_run) return result;
  if (errors.length) throw new Error(errors.join(' '));
  ctx.fire('ls_override', { op: 'range_set', entity, profile, min: config.min ?? null, max: config.max ?? null, via: 'schedule-ui' });
  return result;
}
export const uiHandlers: ScriptHandlers = {
  effects_ui_catalog: ctx => uiCatalog(ctx),
  effects_ui_sync: (ctx, args) => {
    if (!args.dry_run) ctx.run('effects_ui_catalog');
    const messages = uiMessages(ctx, Boolean(args.force));
    if (args.dry_run) return { messages };
    for (const message of messages) ctx.emit('mqtt.publish', { ...message, qos: 0, retain: true });
    return null;
  },
  ls_range_save: rangeSave,
};
