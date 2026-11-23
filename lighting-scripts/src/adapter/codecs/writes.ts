/**
 * What a turn writes back to Home Assistant: the Model's changes through the
 * M1 codecs (the overrides sensor, each changed remote's helpers, each changed
 * lamp's and plug's profile store, a block light's store saved from the dashboard), and
 * the dashboard view's changes (each scope's block selector, the mode mirror,
 * and the live controls' sync messages, moved from `uiMessages`), and the
 * proxies and discovered lights Home Assistant shows otherwise (the profile
 * editors, each row's availability, the effect list). Nothing is written when
 * nothing changed.
 */
import { isDeepStrictEqual } from 'node:util';
import { BLOCKS } from '../../domain/blocks.ts';
import type { Block } from '../../domain/blocks.ts';
import type { ControlShown, DashboardView } from '../../domain/dashboard.ts';
import type { LampProfileChange, Model } from '../../domain/model.ts';
import { savedLampProfile } from '../../domain/profiles.ts';
import type { RoomId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Instant } from '../../domain/types/time.ts';
import type { JsonObject } from '../ha-client.ts';
import type { HouseView } from './house.ts';
import { roundEven } from '../../domain/blend.ts';
import { lampReading, proxyKelvin, proxyShowsRgb, uiProfile } from './ui-state.ts';
import { object } from './parse.ts';
import { uiRowsOf } from './catalog.ts';
import type { UiRow } from './catalog.ts';
import { blockLightStore } from './config.ts';
import type { BlockLight } from './config.ts';
import { decodeLampProfile, encodeLampProfile } from './lamp-profiles.ts';
import { profileStore } from './model.ts';
import { remoteSources } from './overlay-key.ts';
import { encodeOverrides } from './overrides-sensor.ts';
import { encodeSwitchProfile } from './switch-profiles.ts';
import { remoteHelperEntity, remoteHelperWrites } from './remote-helpers.ts';
import type { HelperValue } from './remote-helpers.ts';
import { nowText } from './time-text.ts';

/** The overrides sensor's revision and the attributes written over its stored ones. */
export type SensorWrite = { entity: string; revision: string; attributes: JsonObject };

/** One remote helper of a room set to a value. */
export type HelperWrite = { entity: string; value: HelperValue };

/** A store helper (a lamp's profile, or a block's light) set to its new text. */
export type StoreWrite = { entity: string; text: string };

/** A block light's store saved from the dashboard: the save written over the stored text. */
export function configStoreWrite(light: BlockLight, change: LampProfileChange, house: HouseView): StoreWrite {
  const entity = blockLightStore(light), found = storeText(house, entity);
  return { entity, text: encodeLampProfile(savedLampProfile(decodeLampProfile(found), change), found) };
}

export type DashboardWrite =
  | { kind: 'block selector'; entity: string; option: string }
  | { kind: 'mode mirror'; entity: string; on: boolean }
  /** One retained MQTT message to a control's proxy. */
  | { kind: 'control sync'; topic: string; payload: string }
  /** A discovered light's config republished, retained, with the catalog's effect choices. */
  | { kind: 'discovery'; topic: string; payload: string };

export const OVERRIDES_SENSOR = 'sensor.ls_overrides';

/**
 * What the proxies and the discovered lights show otherwise, moved from
 * `uiMessages` and `effects_ui_catalog`. It covers:
 * 1. each row's availability, from whether its source reports on or off;
 * 2. each available profile editor's power, effect, brightness and colour,
 *    as its source light shows them;
 * 3. each discovered light's effect list: the catalog's choices (a light Home
 *    Assistant does not report is left until it does).
 *
 * Each is compared with what Home Assistant shows, as today, so nothing is
 * sent when the proxy already shows it. `force` (a start) sends every
 * row's availability and every editor's channels. A live control's channels
 * come from the dashboard view ({@link dashboardWrites}). A malformed row,
 * or a channel a row has no topic for, is passed over.
 */
export function uiSyncWrites(house: HouseView, force: boolean): DashboardWrite[] {
  const writes: DashboardWrite[] = [];
  for (const row of uiRowsOf(house.catalog)) if (row.proxy !== undefined) writes.push(...rowSync(house, row, row.proxy, force));
  const choices = house.catalog.ui_choices === undefined ? DEFAULT_CHOICES : house.catalog.ui_choices;
  for (const row of discoveryRowsOf(house)) {
    if (house.state[row.entity] === undefined || isDeepStrictEqual(house.attr(row.entity, 'effect_list'), choices)) continue;
    const topic = `homeassistant/light/${row.uniqueId}/config`;
    writes.push({ kind: 'discovery', topic, payload: JSON.stringify({ ...row.config, effect_list: [...choices] }) });
  }
  return writes;
}

/** One row's availability and, for an available profile editor, each channel its proxy shows otherwise (today's rules). */
function rowSync(house: HouseView, row: UiRow, proxy: string, force: boolean): DashboardWrite[] {
  const writes: DashboardWrite[] = [];
  const send = (channel: string, payload: string) => {
    const topic = row.topics[channel];
    if (topic !== undefined) writes.push({ kind: 'control sync', topic, payload });
  };
  const source = row.source, available = reportsPower(house.get(source));
  if (force || available !== reportsPower(house.get(proxy))) send('availability', available ? 'online' : 'offline');
  if (!available || row.store === undefined) return writes;
  if (force || house.get(proxy) !== house.get(source)) send('power', house.get(source) === 'on' ? 'ON' : 'OFF');
  const profile = uiProfile(house, row.store);
  const effect = profile.namesEffectChannels && profile.effect !== 'Normal light' ? profile.effect : 'Normal Light';
  if (force || house.attr(proxy, 'effect') !== effect) send('effect', effect);
  const reading = lampReading(house, source);
  if (reading.brightness !== undefined) {
    const level = roundEven(reading.brightness);
    if (force || house.attr(proxy, 'brightness') !== level) send('brightness', `${level}`);
  }
  if (reading.colourTemp && reading.kelvin !== undefined && reading.kelvin > 0) {
    const mired = roundEven(1e6 / reading.kelvin), proxyKelvinShown = proxyKelvin(house, proxy);
    const proxyMired = proxyKelvinShown > 0 ? roundEven(1e6 / proxyKelvinShown) : 0;
    if (force || house.attr(proxy, 'color_mode') !== 'color_temp' || proxyMired !== mired) send('temperature', `${mired}`);
  } else if (reading.rgb !== undefined) {
    if (force || house.attr(proxy, 'color_mode') !== 'rgb' || !proxyShowsRgb(house, proxy, reading.rgb)) send('rgb', reading.rgb.text);
  }
  return writes;
}

/** A source or proxy that reports on or off is available. */
function reportsPower(state: string): boolean {
  return state === 'on' || state === 'off';
}

/** The mode mirror: the dashboard's switch for the mode overlay. */
const MODE_MIRROR = 'input_boolean.ls_sara_mode_mirror';

/** The Model's writes: the overrides sensor, each changed remote's helpers and each changed lamp or plug profile store. */
export type ModelWrites = { sensor: SensorWrite | undefined; helpers: HelperWrite[]; stores: StoreWrite[] };

/**
 * The writes that take Home Assistant from what it holds to `after`. The
 * sensor is written when its attributes, read with the Model written in,
 * differ from the stored ones (the codec keeps every untouched entry's bytes);
 * a remote's helpers when its state changed this turn; a lamp's or a plug's
 * store when its profile did. Every room is the port's: the host keeps to its own share.
 */
export function modelWrites(before: Model, after: Model, house: HouseView, now: Instant): ModelWrites {
  const stored = house.state[OVERRIDES_SENSOR];
  const found: JsonObject = stored === undefined ? {} : stored.attributes;
  const live = new Set<RoomId>(entriesOf(after.config.rooms).map(([room]) => room));
  const written = encodeOverrides(after, found, live, after.config, remoteSources(house.catalog));
  const changed = Object.fromEntries(Object.entries(written).filter(([key, value]) => !isDeepStrictEqual(found[key], value)));
  const sensor = Object.keys(changed).length === 0 ? undefined : { entity: OVERRIDES_SENSOR, revision: nowText(now), attributes: changed };
  const helpers = entriesOf(after.remotes).flatMap(([remote, state]): HelperWrite[] => {
    const was = before.remotes[remote], room = after.config.remotes[remote]?.room;
    if (was === undefined || room === undefined || isDeepStrictEqual(was, state)) return [];
    return remoteHelperWrites(was, state).map(({ helper, value }) => ({ entity: remoteHelperEntity(room, helper), value }));
  });
  const stores = entriesOf(after.lampProfiles).flatMap(([lamp, profiles]) => BLOCKS.flatMap((block): StoreWrite[] => {
    const was = before.lampProfiles[lamp]?.[block], profile = profiles[block];
    if (was === undefined || isDeepStrictEqual(was, profile)) return [];
    const entity = profileStore(lamp, block);
    return [{ entity, text: encodeLampProfile(profile, storeText(house, entity)) }];
  }));
  const switchStores = entriesOf(after.switchProfiles).flatMap(([plug, profiles]) => BLOCKS.flatMap((block): StoreWrite[] => {
    const was = before.switchProfiles[plug]?.[block], profile = profiles[block];
    if (was === undefined || isDeepStrictEqual(was, profile)) return [];
    const entity = profileStore(plug, block);
    return [{ entity, text: encodeSwitchProfile(profile, storeText(house, entity)) }];
  }));
  return { sensor, helpers, stores: [...stores, ...switchStores] };
}

/** A live control's row: its control and the proxy topic of each channel. */
export type ControlRow = { control: string; topics: Partial<Record<string, string>> };

/** The dashboard's effect choices when the catalog names none (today's `uiChoices`). */
const DEFAULT_CHOICES: readonly string[] = ['Normal Light', 'Candle'];

type Channel = 'power' | 'brightness' | 'temperature' | 'rgb' | 'effect';

/** What a control shows, as the proxy's channel payloads: today's `uiMessages` texts. */
function channels(light: ControlShown): Record<Channel, string | undefined> {
  if (light.power === 'off') return { power: 'OFF', brightness: undefined, temperature: undefined, rgb: undefined, effect: undefined };
  const colour = light.colour;
  return {
    power: 'ON',
    brightness: `${light.level}`,
    temperature: colour !== undefined && colour.kind === 'kelvin' ? `${Math.round(1_000_000 / colour.kelvin)}` : undefined,
    rgb: colour !== undefined && colour.kind === 'rgb' ? `${colour.rgb.red},${colour.rgb.green},${colour.rgb.blue}` : undefined,
    effect: light.effect === undefined ? undefined : light.effect === 'Candle' ? 'Candle' : 'Normal Light',
  };
}

/** One discovery row of the catalog: its light, the unique id its config topic is named for, and the config. */
type DiscoveryRow = { entity: string; uniqueId: string; config: JsonObject };

/** The catalog's discovery rows; a row with no entity, or whose config has no unique id, is left out. */
function discoveryRowsOf(house: HouseView): DiscoveryRow[] {
  return (house.catalog.ui_discovery === undefined ? [] : house.catalog.ui_discovery).flatMap(raw => {
    const row = object(raw), config = object(row.config), uniqueId = config.unique_id;
    return typeof row.entity === 'string' && typeof uniqueId === 'string' ? [{ entity: row.entity, uniqueId, config }] : [];
  });
}

/**
 * The dashboard's writes: each block selector and the mode mirror Home
 * Assistant shows otherwise (a selector the house has no helper for is not
 * written), and each live control's channels that changed since `before`, all
 * of them when there is no `before` (a start).
 */
export function dashboardWrites(before: DashboardView | undefined, after: DashboardView, rows: readonly ControlRow[],
  house: HouseView): DashboardWrite[] {
  const writes: DashboardWrite[] = [];
  for (const [scope, block] of entriesOf(after.blockShown)) {
    const entity = `input_select.ls_${scope}_override`, option = blockOption(block), shown = house.state[entity];
    if (shown !== undefined && shown.state !== option) writes.push({ kind: 'block selector', entity, option });
  }
  const mirror = house.state[MODE_MIRROR];
  if (mirror !== undefined && (mirror.state === 'on') !== after.modeOn) writes.push({ kind: 'mode mirror', entity: MODE_MIRROR, on: after.modeOn });
  for (const control of after.controls) {
    const row = rows.find(candidate => candidate.control === control.control);
    const was = before === undefined ? undefined : before.controls.find(earlier => earlier.control === control.control)?.light;
    if (row === undefined) continue;
    for (const [channel, payload] of entriesOf(channels(control.light))) {
      const topic = row.topics[channel];
      if (topic !== undefined && payload !== undefined && (was === undefined || channels(was)[channel] !== payload)) {
        writes.push({ kind: 'control sync', topic, payload });
      }
    }
  }
  return writes;
}

/** The `input_select.ls_<room>_override` option label for a block: the oracle's `| capitalize`. */
export function blockOption(block: Block): string {
  return OPTION[block];
}

const OPTION: Record<Block, string> = { day: 'Day', cosy: 'Cosy', night: 'Night' };

function storeText(house: HouseView, entity: string): string {
  const state = house.state[entity];
  return state === undefined ? '' : state.state;
}
