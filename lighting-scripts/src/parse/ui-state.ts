/**
 * The UI sync's and the range save's reads of Home Assistant state: what a
 * proxy or lamp reports, a row's saved profile, a switch's stored range, each
 * with the exact type test the captured mirror applied, so nothing compares
 * differently.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import type { HouseView } from '../runtime/effects.ts';
import { isObject, jinjaOr, jinjaTruthy, object, parseFinite } from '../runtime/parse.ts';
import { carry, reveal } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { jinjaListOf, saved } from './accessors.ts';
import { percentRangeOf } from './ids.ts';
import type { PercentRange } from '../domain/types/light.ts';

/** A display colour as the mirror reads it: an rgb triple and its MQTT text. */
export interface Rgb { text: string; value: Verbatim }

/**
 * Does the proxy show this triple? Captured `(state_attr(proxy,'rgb_color') or []) | list == rgb | list`:
 * a proxy showing no colour shows no triple.
 */
export function proxyShowsRgb(ctx: HouseView, proxy: string, rgb: Rgb): boolean {
  const shown = proxyRgb(ctx, proxy);
  return shown !== undefined && isDeepStrictEqual(shown, reveal(rgb.value));
}

function rgbOf(value: JsonValue | undefined): Rgb | undefined {
  return Array.isArray(value) && value.length === 3 ? { text: value.join(','), value: carry(value) } : undefined;
}

/**
 * The colour the proxy reports, or none. Home Assistant reports `rgb_color:
 * null` for a light showing no colour (off, or not in a colour mode); the
 * captured `rgb_color or ...` treats every Jinja-falsy value that way, and a
 * reported value goes through Jinja's `list`.
 */
function proxyRgb(ctx: HouseView, proxy: string): JsonValue[] | undefined {
  const reported = ctx.attr(proxy, 'rgb_color');
  // A value Jinja cannot list shows no triple either (the captured `| list` raises on it).
  return reported === undefined || !jinjaTruthy(reported) ? undefined : jinjaListOf(reported);
}

/** What a light entity's attributes say, read with the mirror's type tests. */
export interface LampReading {
  brightness: number | undefined;
  colourTemp: boolean;
  kelvin: number | undefined;
  rgb: Rgb | undefined;
}

/** A proxy colour temperature that is not a number: 0, the captured read's default for no value. */
const NO_PROXY_KELVIN = 0;

export function lampReading(ctx: HouseView, entity: string): LampReading {
  const brightness = ctx.attr(entity, 'brightness'), kelvin = ctx.attr(entity, 'color_temp_kelvin');
  return {
    brightness: typeof brightness === 'number' ? brightness : undefined,
    colourTemp: ctx.attr(entity, 'color_mode') === 'color_temp',
    kelvin: typeof kelvin === 'number' ? kelvin : undefined,
    rgb: rgbOf(ctx.attr(entity, 'rgb_color')),
  };
}

/** A row's stored profile: whether it names effect channels, and its effect. */
export interface UiProfile {
  namesEffectChannels: boolean;
  effect: string;
}

export function uiProfile(ctx: HouseView, store: string): UiProfile {
  const pr = saved(ctx, store);
  return {
    namesEffectChannels: namesEffectChannels(pr),
    effect: savedEffect(pr),
  };
}

/**
 * Does a saved profile name any effect channels? A saved value, read
 * leniently with a default (user directive 2026-11-19): the captured mirror
 * reads `profile.get('effect_channels', ['brightness','color'])` under Jinja
 * truthiness, so an absent key takes the default (true), and any present value
 * -- null, a non-list, a list of non-strings -- is its Jinja truthiness. It
 * never raises.
 */
function namesEffectChannels(profile: JsonObject): boolean {
  const channels = Object.hasOwn(profile, 'effect_channels') ? profile.effect_channels : DEFAULT_PROFILE_EFFECT_CHANNELS;
  return jinjaTruthy(channels);
}

/** The effect a saved profile with no usable `effect` shows (the captured `.get` default). */
const DEFAULT_PROFILE_EFFECT = 'Normal light';

/**
 * A saved profile's effect. A saved value, read leniently with a default (user
 * directive 2026-11-19): an absent key is the captured
 * `profile.get('effect','Normal light')` default, and a present non-string
 * (null, a number, a boolean, a list, a mapping) takes the same default rather
 * than raising. The captured mirror would publish such a value as its Python
 * repr, which no effect list holds; a non-string names no catalog effect, so the
 * lamp's own resolver claims no effect channels for it, and 'Normal light' is
 * what the lamp actually shows. It never raises.
 */
function savedEffect(profile: JsonObject): string {
  return typeof profile.effect === 'string' ? profile.effect : DEFAULT_PROFILE_EFFECT;
}

/** The channels a saved profile with no `effect_channels` key claims (the captured `.get` default). */
const DEFAULT_PROFILE_EFFECT_CHANNELS: JsonValue = ['brightness', 'color'];

/** A range bound as given: absent, or the stored value (only a number is a bound). */
export type RangeBound = string | number | boolean | null | Verbatim | undefined;

/**
 * Own Range's ends, as a percent range: both numbers (a boolean is not one
 * here, unlike Jinja's `is number`), with `0 <= low <= high <= 100`; otherwise
 * `undefined`, and the request is refused.
 */
export function ownRange(low: RangeBound, high: RangeBound): PercentRange | undefined {
  return percentRangeOf(low, high);
}

/** A switch's stored range bounds, read leniently from `sensor.ls_overrides`. */
export function storedRangeBounds(ctx: HouseView, entity: string): { min: RangeBound; max: RangeBound } {
  const previous = object(object(ctx.attr('sensor.ls_overrides', 'switch_ranges'))[entity]);
  return { min: bound(previous.min), max: bound(previous.max) };
}

function bound(value: JsonValue | undefined): RangeBound {
  return Array.isArray(value) || isObject(value) ? carry(value) : value;
}

/**
 * The proxy's `color_temp_kelvin`: a number (or numeric text) is itself, and
 * anything else -- absent, `null`, unreadable -- is {@link NO_PROXY_KELVIN}
 * (2026-11-21: a value a person can edit recovers to a default). Never raises.
 */
export function proxyKelvin(ctx: HouseView, proxy: string): number {
  const kelvin = parseFinite(ctx.attr(proxy, 'color_temp_kelvin'));
  return kelvin === undefined ? NO_PROXY_KELVIN : kelvin;
}

/**
 * Is the light on/off only? Captured `(state_attr(e,'supported_color_modes') or []) != ['onoff']`:
 * absent or Jinja-falsy is no modes, and any other value is on/off only exactly
 * when it equals `['onoff']` -- a non-list simply compares unequal, nothing raises.
 */
export function onOffOnly(ctx: HouseView, entity: string): boolean {
  return isDeepStrictEqual(jinjaOr(ctx.attr(entity, 'supported_color_modes'), []), ['onoff']);
}
