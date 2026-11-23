/**
 * Fake bulbs for the reconciler tests: each bulb's power, level, colour and
 * firmware effect, moved by the publishes it receives the way the candle
 * firmware moves them. A level or an On command ends a running candle; Off
 * ends it too. A publish can be dropped, as a lost Zigbee message is, or
 * fail, as a publish Home Assistant refuses does: the bulb never gets it and
 * the sender is told. A bulb's wall power can be cut and restored: it comes
 * back showing what it showed, without the candle.
 *
 * What a bulb reports is its power, level and colour, never its effect: the
 * firmware does not report the candle.
 */
import type { BulbGroups } from '../../src/adapter/bulb-groups.ts';
import type { MqttTopic, Publish } from '../../src/adapter/encode.ts';
import type { Observed, ObservedBulb } from '../../src/adapter/observed.ts';
import type { BulbId, SwitchId } from '../../src/domain/types/ids.ts';
import { entriesOf } from '../../src/domain/types/ids.ts';
import type { Colour, Level, Power } from '../../src/domain/types/light.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import { toKelvin, toColourChannel, toLevel } from '../../src/parse/ids.ts';

export type FakeLight = { power: 'off' } | { power: 'on'; level: Level; colour: Colour | undefined; effect: 'none' | 'candle' };
export type FakeBulb = { reach: 'unreachable' } | { reach: 'reachable'; light: FakeLight };

/** A lit bulb as a test writes it. */
export function lit(level: number, colour: Colour | undefined, effect: 'none' | 'candle' = 'none'): FakeLight {
  return { power: 'on', level: toLevel(level), colour, effect };
}

export class FakeBulbs {
  private readonly bulbs = new Map<BulbId, FakeBulb>();
  /** What each bulb whose power is cut showed, to come back to. */
  private readonly unpowered = new Map<BulbId, FakeLight>();
  private readonly byTopic = new Map<MqttTopic, readonly BulbId[]>();
  readonly switches = new Map<SwitchId, Power | 'unreachable'>();
  /** When each switch last changed, as HA's `last_changed` reports it; a switch not in it reports none (the harness). */
  readonly switchChanged = new Map<SwitchId, Instant>();
  /** Every publish that reached a bulb, in order, with the bulbs it reached. */
  readonly received: { publish: Publish; bulbs: readonly BulbId[] }[] = [];

  /** Every bulb starts on, at full, with no colour ever sent. */
  constructor(topics: Readonly<Record<BulbId, MqttTopic>>, groups: BulbGroups = []) {
    for (const [bulb, topic] of entriesOf(topics)) {
      this.bulbs.set(bulb, { reach: 'reachable', light: lit(254, undefined) });
      this.byTopic.set(topic, [bulb]);
    }
    for (const group of groups) this.byTopic.set(group.topic, group.members);
  }

  /** Each publish in order, except those `dropped` says were lost and those `failing` says failed; the failed ones are returned. */
  apply(publishes: readonly Publish[], dropped: (publish: Publish) => boolean = () => false,
    failing: (publish: Publish) => boolean = () => false): Publish[] {
    const failed: Publish[] = [];
    for (const publish of publishes) {
      if (failing(publish)) { failed.push(publish); continue; }
      if (dropped(publish)) continue;
      const reached = this.byTopic.get(publish.topic);
      if (reached === undefined) throw new Error(`No bulb listens on ${publish.topic}`);
      this.received.push({ publish, bulbs: reached });
      for (const bulb of reached) {
        const now = this.bulbs.get(bulb);
        if (now?.reach === 'reachable') this.bulbs.set(bulb, { reach: 'reachable', light: received(now.light, publish) });
      }
    }
    return failed;
  }

  /** The wall power to `bulb` goes: it cannot be reached, and keeps what it showed, without the candle, to come back to. */
  cut(bulb: BulbId): void {
    const shown = this.shows(bulb);
    if (shown.reach === 'unreachable') throw new Error(`${bulb} has no power to cut`);
    this.unpowered.set(bulb, shown.light.power === 'off' ? shown.light : { ...shown.light, effect: 'none' });
    this.bulbs.set(bulb, { reach: 'unreachable' });
  }

  /** The wall power to `bulb` comes back: it shows what it showed when it was cut. */
  restore(bulb: BulbId): void {
    const light = this.unpowered.get(bulb);
    if (light === undefined) throw new Error(`${bulb} has power already`);
    this.unpowered.delete(bulb);
    this.bulbs.set(bulb, { reach: 'reachable', light });
  }

  /** What the bulb shows, the candle included. */
  shows(bulb: BulbId): FakeBulb {
    const shown = this.bulbs.get(bulb);
    if (shown === undefined) throw new Error(`No fake bulb ${bulb}`);
    return shown;
  }

  /** A change made behind the reconciler's back, or a report that differs from what the bulb was sent. */
  set(bulb: BulbId, shown: FakeBulb): void {
    this.bulbs.set(bulb, shown);
  }

  /** What the bulbs and switches report, as the reconciler observes them. */
  observed(bridgeConnected = true): Observed {
    const bulbs: Record<BulbId, ObservedBulb> = {};
    for (const [bulb, shown] of this.bulbs) bulbs[bulb] = reported(shown);
    return { bulbs, switches: Object.fromEntries(this.switches), switchChanged: Object.fromEntries(this.switchChanged), bridgeConnected };
  }
}

/** A bulb's light after one publish, as the candle firmware takes it. */
function received(light: FakeLight, publish: Publish): FakeLight {
  const payload = publish.payload;
  if ('effect' in payload) {
    if (light.power === 'off') return light;
    return { ...light, effect: payload.effect === 'channel_change' ? 'candle' : 'none' };
  }
  if ('state' in payload) return { power: 'off' };
  // A level ends the candle, and turns an off bulb on.
  const colour = 'color_temp' in payload ? { kind: 'kelvin' as const, kelvin: toKelvin(Math.round(1e6 / payload.color_temp)) }
    : 'color' in payload ? rgbOf(payload.color.rgb)
      : light.power === 'on' ? light.colour : undefined;
  return { power: 'on', level: payload.brightness, colour, effect: 'none' };
}

function rgbOf(text: string): Colour {
  const [red, green, blue] = text.split(',').map(part => toColourChannel(Number(part)));
  if (red === undefined || green === undefined || blue === undefined) throw new Error(`Not r,g,b: ${text}`);
  return { kind: 'rgb', rgb: { red, green, blue } };
}

/** A bulb's report: its power, level and colour; the effect is not reported. */
function reported(shown: FakeBulb): ObservedBulb {
  if (shown.reach === 'unreachable') return shown;
  const light = shown.light;
  return { reach: 'reachable', light: light.power === 'off' ? light : { power: 'on', level: light.level, colour: light.colour } };
}
