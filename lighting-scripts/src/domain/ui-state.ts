import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { requireArray, requireBoolean, requireString, withParsedArgs } from '../runtime/parse.ts';
import { object, roundEven } from './scale.ts';
import { isAreaId, list, num, saved, strings } from './schedule.ts';

function rows(ctx: ScriptContext, key: string): JsonValue[] {
  const value = ctx.catalog?.[key];
  if (!Array.isArray(value)) throw new Error(`Missing runtime catalog.${key}`);
  return value;
}

function requireStringValue(value: JsonValue | undefined, context: string): string {
  return requireString({ value: value === undefined ? null : value }, 'value', context);
}

function requireStringArray(value: JsonValue | undefined, context: string): string[] {
  const items = requireArray({ value: value === undefined ? null : value }, 'value', context);
  return items.map((item, index) => requireStringValue(item, `${context}[${index}]`));
}

/** Captured rows use an absent key or an empty string to mean no profile store. */
function optionalStoreId(value: JsonValue | undefined, context: string): string | undefined {
  if (value === undefined) return undefined;
  const store = requireStringValue(value, context);
  return store.length === 0 ? undefined : store;
}

/** HA uses null for an entity attribute with no value; present values must be arrays. */
function optionalAttributeArray(value: JsonValue | undefined, context: string): JsonValue[] {
  if (value === undefined || value === null) return [];
  return requireArray({ value }, 'value', context);
}

export function uiMessages(ctx: ScriptContext, force: boolean): JsonObject[] {
  const targets = object(ctx.attr('sensor.ls_effects_runtime', 'targets'));
  const assignments = object(ctx.attr('sensor.ls_effects_runtime', 'assignments'));
  const messages: JsonObject[] = [];
  for (const raw of rows(ctx, 'ui_rows')) {
    const row = object(raw), source = String(row.source), proxy = String(row.proxy);
    const store = optionalStoreId(row.store, 'effects_ui_sync.row.store');
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
    if (store !== undefined) {
      const pr = saved(ctx, store);
      const effectChannels = pr.effect_channels === undefined
        ? ['brightness', 'color']
        : requireStringArray(pr.effect_channels, 'effects_ui_sync.profile.effect_channels');
      effect = effectChannels.length
        ? pr.effect === undefined ? 'Normal light' : requireStringValue(pr.effect, 'effects_ui_sync.profile.effect')
        : 'Normal light';
    }
    if (effect === 'Normal light') effect = 'Normal Light';
    let b = ctx.attr(source, 'brightness'), k = ctx.attr(source, 'color_temp_kelvin'), rgb = ctx.attr(source, 'rgb_color'), mode = ctx.attr(source, 'color_mode');
    let target = object(targets[source]);
    if (store === undefined && (members.length > 1 || !members.includes(source))) {
      const areas = [...new Set(members.map(e => ctx.areas[e]).filter(isAreaId))];
      if (areas.length === 1) target = object(targets[`room:${areas[0]}`]);
    }
    if (store === undefined) {
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
  const rawChoices = ctx.catalog?.ui_choices;
  const choices = rawChoices === undefined
    ? ['Normal Light', 'Candle']
    : requireStringArray(rawChoices, 'effects_ui_catalog.ui_choices');
  for (const raw of rows(ctx, 'ui_discovery')) {
    const row = object(raw), config = object(row.config);
    if (!isDeepStrictEqual(ctx.attr(String(row.entity), 'effect_list'), choices)) {
      ctx.emit('mqtt.publish', { topic: `homeassistant/light/${config.unique_id}/config`, payload: JSON.stringify({ ...config, effect_list: choices }), qos: 0, retain: true });
    }
  }
  return null;
}
export function rangeSave(ctx: ScriptContext, args: JsonObject): JsonObject {
  const entity = args.entity === undefined ? '' : requireString(args, 'entity', 'ls_range_save');
  const profile = args.profile === undefined ? 'bright' : requireString(args, 'profile', 'ls_range_save');
  const dryRun = args.dry_run === undefined ? false : requireBoolean(args.dry_run, 'ls_range_save.dry_run');
  const e = entity;
  const previous = object(object(ctx.attr('sensor.ls_overrides', 'switch_ranges'))[e]);
  const lo = args.minimum === undefined ? previous.min : args.minimum;
  const hi = args.maximum === undefined ? previous.max : args.maximum;
  const errors: string[] = [], config: JsonObject = { profile };
  const domain = e.split('.')[0];
  const supportedDomain = domain !== undefined && ['switch', 'light'].includes(domain);
  const blocked = /^(switch|light)\.(ls_|ep_)/.test(e) || e.includes('permit_join');
  const devices = ctx.devices === undefined ? {} : ctx.devices;
  const hasDevice = Object.values(devices).some(entities => entities.includes(e));
  if (!supportedDomain || !ctx.state[e] || !hasDevice || blocked) errors.push('Choose a physical on/off lamp or smart plug.');
  else if (domain === 'light') {
    const modes = optionalAttributeArray(ctx.attr(e, 'supported_color_modes'), `ls_range_save.${e}.supported_color_modes`);
    if (!isDeepStrictEqual(modes, ['onoff'])) errors.push('Choose an on/off lamp; dimmable lamps use the normal lighting settings.');
  }
  if (supportedDomain && ctx.state[e] && ctx.areas[e] === undefined) errors.push('Assign this lamp to a room before configuring its range.');
  if (!['bright', 'cosy', 'custom'].includes(String(profile))) errors.push('Choose Bright Default, Cosy Default, or Own Range.');
  else if (profile === 'custom') {
    if (typeof lo !== 'number' || typeof hi !== 'number' || !(0 <= lo && lo <= hi && hi <= 100)) errors.push('Enter both ends of Own Range: 0–100%, with From no higher than Through.');
    else { config.min = lo; config.max = hi; }
  }
  const result: JsonObject = { valid: errors.length === 0, errors, entity, config };
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
    parse: args => ({
      dryRun: args.dry_run === undefined ? false : requireBoolean(args.dry_run, 'effects_ui_sync.dry_run'),
      force: args.force === undefined ? false : requireBoolean(args.force, 'effects_ui_sync.force'),
    }),
    run: (ctx, args) => {
    if (!args.dryRun) ctx.run('effects_ui_catalog');
    const messages = uiMessages(ctx, args.force);
    if (args.dryRun) return { messages };
    for (const message of messages) ctx.emit('mqtt.publish', { ...message, qos: 0, retain: true });
    return null;
    },
  }),
  ls_range_save: rangeSave,
};
