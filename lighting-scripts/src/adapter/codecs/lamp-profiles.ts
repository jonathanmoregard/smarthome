/**
 * The lamp profile codec: a lamp's saved light for one block, the JSON text
 * `ls_store` keeps in `input_text.ls_lamp_<lamp>_<block>` (`on`, `own`, `b`,
 * `m` with `k` or `h`/`s`, `effect`, `effect_channels`), read as `ls_base`
 * reads it.
 *
 * A person edits the store from the dashboard, so garbage recovers to a named
 * default and never raises (2026-11-21). Writing keeps the stored text exactly
 * when the profile did not change, and otherwise sets only the fields the
 * profile changed over the stored ones, as `ls_store` does: the old scripts
 * still read these stores for the rooms they drive.
 */
import type { EffectName } from '../../domain/effect.ts';
import type { LampProfile } from '../../domain/model.ts';
import type { Colour, RGB, SceneLight } from '../../domain/types/light.ts';
import type { JsonObject, JsonValue } from '../../runtime/context.ts';
import { isObject, jinjaInt, jinjaTruthy } from '../../runtime/parse.ts';
import { toBrightness, toColourChannel, toKelvin } from '../../parse/ids.ts';
import { isDeepStrictEqual } from 'node:util';

/** A store that is not JSON, not a mapping, or does not own its light: the lamp follows its room. */
export const FOLLOWS_ROOM: LampProfile = { follows: 'room' };

/** A lit store with no `b`: today's `pr.get('b', 255)`. */
const FULL = 255;

/** What `ls_store` saves as an effect's channels: the catalog's, which name none for the normal light. */
const EFFECT_CHANNELS: Record<EffectName, readonly string[]> = { Candle: ['brightness', 'color'], Normal: [] };
/** The effect names the store saves. */
const STORED_EFFECT: Record<EffectName, string> = { Candle: 'Candle', Normal: 'Normal light' };

/**
 * The store's text with this profile written in: the found text when the
 * profile did not change; otherwise the found fields with the changed ones set.
 */
export function encodeLampProfile(profile: LampProfile, foundText: string): string {
  const before = decodeLampProfile(foundText);
  if (isDeepStrictEqual(before, profile)) return foundText;
  const found = storeOf(foundText) ?? {};
  if (profile.follows === 'room') return JSON.stringify({ ...found, own: false });
  const light = profile.light;
  if (light.power === 'off') return JSON.stringify({ ...found, own: true, on: false });
  const previous = before.follows === 'own' && before.light.power === 'on' ? before.light : undefined;
  const colour = previous !== undefined && isDeepStrictEqual(previous.colour, light.colour) ? {} : storedColour(light.colour);
  const effect = previous !== undefined && previous.effect === light.effect ? {}
    : { effect: STORED_EFFECT[light.effect], effect_channels: [...EFFECT_CHANNELS[light.effect]] };
  return JSON.stringify({ ...found, on: true, own: true, b: light.brightness, ...colour, ...effect });
}

export function decodeLampProfile(storeText: string): LampProfile {
  const store = storeOf(storeText);
  return store === undefined || !jinjaTruthy(store['own']) ? FOLLOWS_ROOM : { follows: 'own', light: storedLight(store) };
}

/** The store as a mapping; none when it is not JSON or not a mapping. */
function storeOf(text: string): JsonObject | undefined {
  let parsed: JsonValue;
  try { parsed = JSON.parse(text) as JsonValue; } catch { return undefined; }
  return isObject(parsed) ? parsed : undefined;
}

/**
 * The light a store owns: off when `on` is Jinja-falsy (absent is on); lit at
 * `b | int` held to 0..255 (absent is full), in the saved colour, running the
 * candle when the effect says `Candle` and the normal light otherwise.
 */
function storedLight(store: JsonObject): SceneLight {
  const on = store['on'] === undefined || jinjaTruthy(store['on']);
  if (!on) return { power: 'off' };
  const level = store['b'] === undefined ? FULL : Math.min(FULL, Math.max(0, jinjaInt(store['b'], 0)));
  const effect: EffectName = store['effect'] === 'Candle' ? 'Candle' : 'Normal';
  return { power: 'on', brightness: toBrightness(level), colour: savedColour(store), effect };
}

/** The saved colour: kelvin in `ct` mode, hue and saturation as rgb in `hs` mode; none otherwise. */
function savedColour(store: JsonObject): Colour | undefined {
  const k = store['k'], h = store['h'], s = store['s'];
  if (store['m'] === 'ct') return typeof k === 'number' && k >= 1000 && k <= 10000 ? { kind: 'kelvin', kelvin: toKelvin(k) } : undefined;
  if (store['m'] !== 'hs' || typeof h !== 'number' || typeof s !== 'number' || !Number.isFinite(h) || s < 0 || s > 100) return undefined;
  return { kind: 'rgb', rgb: hsToRgb(h, s) };
}

/** Home Assistant's `color_hs_to_RGB`: the hue and saturation at full value, each channel rounded. */
function hsToRgb(hue: number, saturation: number): RGB {
  const h = (((hue % 360) + 360) % 360) / 60, s = saturation / 100;
  const sector = Math.floor(h), f = h - sector;
  const p = 1 - s, q = 1 - s * f, t = 1 - s * (1 - f);
  const [red, green, blue] = [[1, t, p], [q, 1, p], [p, 1, t], [p, q, 1], [t, p, 1], [1, p, q]][sector % 6]!;
  const channel = (value: number) => toColourChannel(Math.round(value * 255));
  return { red: channel(red!), green: channel(green!), blue: channel(blue!) };
}

/**
 * The colour fields `ls_store` writes: `m: 'ct'` and `k`, or `m: 'hs'` with `h`
 * and `s`. No colour is a mode of none, which neither reader takes for a colour.
 */
function storedColour(colour: Colour | undefined): JsonObject {
  if (colour === undefined) return { m: null };
  if (colour.kind === 'kelvin') return { m: 'ct', k: colour.kelvin };
  const { hue, saturation } = rgbToHs(colour.rgb);
  return { m: 'hs', h: hue, s: saturation };
}

/** Home Assistant's `color_RGB_to_hs`: hue in degrees and saturation in percent, each to three decimals. */
function rgbToHs(rgb: RGB): { hue: number; saturation: number } {
  const r = rgb.red / 255, g = rgb.green / 255, b = rgb.blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
  const saturation = max === 0 ? 0 : span / max;
  const hue = span === 0 ? 0 : max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { hue: round(((hue * 60) + 360) % 360), saturation: round(saturation * 100) };
}
