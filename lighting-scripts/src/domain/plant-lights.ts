/**
 * Plant lights: a plant light is on from its start for its hours (its own,
 * else the house's default), whatever the rest of the lights do. Its start is
 * its own time, the same every day of the week, or else its room's day start.
 * A hand switch or the all-off hold keeps it as set until its next start.
 * It shares only the day start and the clock with the schedule: no block, fade,
 * room power, remote, overlay or mode reaches it.
 *
 * Changing an own start mid-day takes effect at once, since the start in force is
 * the last one before now: moved later than now, `last` becomes yesterday's, so
 * the timer may switch the plug off now until the new start; moved earlier, a
 * hand switch made before the new `last` is released at once.
 */
import type { Config, PlantLight } from './config.ts';
import type { DayStarts } from './schedule.ts';
import { dayStarts, fixedDayStarts } from './schedule.ts';
import type { SwitchButtonPressed } from './switches.ts';
import type { RoomId, SwitchId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Power } from './types/light.ts';
import type { PlantHours } from './types/range.ts';
import { instantOrThrow } from './types/range.ts';
import type { Instant } from './types/time.ts';

/** A plant light switched on or off by hand, held until its next start. */
export type HandSwitch = { power: Power; since: Instant };

/** Every plant light held off from the dashboard, until each one's next start. */
export type AllOff = { since: Instant };

/** What holds plant lights over their timer: a hand switch each, and all off. */
export type PlantOverrides = { handSwitches: Partial<Record<SwitchId, HandSwitch>>; allOff: AllOff | undefined };

export const NO_PLANT_OVERRIDES: PlantOverrides = { handSwitches: {}, allOff: undefined };

/**
 * Whether each plant light is on, and no other switch has an entry. A hand
 * switch that still applies wins, unless an all off that applies is newer;
 * then an all off that applies gives off; else the timer.
 */
export function plantPower(model: { config: Config; plantOverrides: PlantOverrides }, now: Instant): Record<SwitchId, Power> {
  const { config, plantOverrides } = model;
  const power: Record<SwitchId, Power> = {};
  for (const [id, placed] of plantLightsOf(config)) {
    const { last } = startsOf(config, placed, now);
    const hand = plantOverrides.handSwitches[id], allOff = plantOverrides.allOff;
    const heldByHand = hand !== undefined && holds(hand.since, last) ? hand : undefined;
    const heldByAllOff = allOff !== undefined && holds(allOff.since, last) ? allOff : undefined;
    if (heldByHand !== undefined && (heldByAllOff === undefined || heldByAllOff.since <= heldByHand.since)) power[id] = heldByHand.power;
    else if (heldByAllOff !== undefined) power[id] = 'off';
    else power[id] = timerPower(config, placed, last, now);
  }
  return power;
}

/** A press on a plant light's own button holds it as pressed, replacing its last; a press on any other switch is left alone. */
export function plantLightSwitched(overrides: PlantOverrides, config: Config, press: SwitchButtonPressed): PlantOverrides {
  if (config.switches[press.switch]?.kind !== 'plant light') return overrides;
  return { ...overrides, handSwitches: { ...overrides.handSwitches, [press.switch]: { power: press.power, since: press.at } } };
}

/**
 * The clock's release: each hand switch that no longer applies is dropped, and
 * all off once it applies to no plant light of the config (none at all
 * included).
 */
export function plantOverridesReleased(overrides: PlantOverrides, config: Config, now: Instant): PlantOverrides {
  const lastOf = (placed: PlantLight): Instant | undefined => startsOf(config, placed, now).last;
  const handSwitches: Partial<Record<SwitchId, HandSwitch>> = {};
  for (const [id, hand] of entriesOf(overrides.handSwitches)) {
    const placed = config.switches[id];
    if (hand !== undefined && placed?.kind === 'plant light' && holds(hand.since, lastOf(placed))) handSwitches[id] = hand;
  }
  const allOff = overrides.allOff;
  return { handSwitches, allOff: allOff !== undefined && allOffHolds(config, allOff.since, now) ? allOff : undefined };
}

/**
 * Whether all off set at `since` still holds at `now`: it applies to some plant light of the config, until that one's
 * next start. An all off switched on before the start that released it holds nothing.
 */
export function allOffHolds(config: Config, since: Instant, now: Instant): boolean {
  return plantLightsOf(config).some(([, placed]) => holds(since, startsOf(config, placed, now).last));
}

/** A hold set at `since` still applies from the start that last passed, or where none has. */
function holds(since: Instant, last: Instant | undefined): boolean {
  return last === undefined || since >= last;
}

/** On from the last start for its hours; 24 hours is on throughout, and with no start it is off. */
function timerPower(config: Config, placed: PlantLight, last: Instant | undefined, now: Instant): Power {
  if (hoursOf(config, placed) === 24) return 'on';
  const off = switchOffAt(config, placed, last);
  return off !== undefined && now < off ? 'on' : 'off';
}

/** All plant lights switched off from the dashboard, or handed back to their timers. */
export type PlantsAllOffSet = { kind: 'plantsAllOffSet'; on: boolean; at: Instant };

/**
 * All off switched on: every plant light is held off, and the newer hold
 * replaces the hand switches, so switching all off off goes back to the
 * timers. Switched off: the hold goes and the hand switches stay.
 */
export function plantsAllOffSet(overrides: PlantOverrides, set: PlantsAllOffSet): PlantOverrides {
  if (set.on) return { handSwitches: {}, allOff: { since: set.at } };
  return { ...overrides, allOff: undefined };
}

/** The instants a plant light changes next: each one's next start, and its timer's switch-off when that is still to come. */
export function plantChanges(config: Config, now: Instant): Instant[] {
  const times: Instant[] = [];
  for (const [, placed] of plantLightsOf(config)) {
    const { last, next } = startsOf(config, placed, now);
    if (next !== undefined) times.push(next);
    const off = switchOffAt(config, placed, last);
    if (off !== undefined && off > now) times.push(off);
  }
  return times;
}

/**
 * When each plant light's timer switches it off in the current day period, kept shown after it has passed until the
 * next start. A light with no switch-off has no entry: no start in reach, 24 hours (never off) or 0 hours (never on).
 */
export function plantSwitchOffTimes(config: Config, now: Instant): Partial<Record<SwitchId, Instant>> {
  const times: Partial<Record<SwitchId, Instant>> = {};
  for (const [id, placed] of plantLightsOf(config)) {
    if (hoursOf(config, placed) === 0) continue;
    const off = switchOffAt(config, placed, startsOf(config, placed, now).last);
    if (off !== undefined) times[id] = off;
  }
  return times;
}

/** The plant lights of the config, each with its id. */
function plantLightsOf(config: Config): [SwitchId, PlantLight][] {
  const lights: [SwitchId, PlantLight][] = [];
  for (const [id, placed] of entriesOf(config.switches)) if (placed.kind === 'plant light') lights.push([id, placed]);
  return lights;
}

/** The starts of a plant light either side of `now`: its own time every day where it has one, else its room's day start. */
function startsOf(config: Config, placed: PlantLight, now: Instant): DayStarts {
  return placed.start.follows === 'own'
    ? fixedDayStarts(config.timezone, placed.start.own, now)
    : dayStarts(config, roomOf(config, placed), now);
}

/** A plant light's room is its config room where the config holds that room, else the house, as a switch's is. */
function roomOf(config: Config, placed: PlantLight): RoomId | undefined {
  return placed.room !== undefined && config.rooms[placed.room] !== undefined ? placed.room : undefined;
}

/** When the timer switches off: its hours after the last start. Undefined with no start, or at 24 hours, which never switches off. */
function switchOffAt(config: Config, placed: PlantLight, last: Instant | undefined): Instant | undefined {
  const hours = hoursOf(config, placed);
  if (last === undefined || hours === 24) return undefined;
  return instantOrThrow(last + hours * 3600);
}

/** Its own hours where it keeps its own, else the house's default. */
function hoursOf(config: Config, placed: PlantLight): PlantHours {
  return placed.hours.follows === 'own' ? placed.hours.own : config.plantHours;
}
