/**
 * The schedule: where a room (or the house) is in its blocks at an instant,
 * the morning wake light, each block's light, and the light part way through a
 * fade between two blocks.
 *
 * Moved from `src/legacy/domain/schedule.ts` (`scheduleDetails`,
 * `initialStage`, `wakeStage`, `interpolate`, `scopeFor`, `localParts`,
 * `localTime`, `nextMidnight`). Block starts are wall-clock times in the
 * config's zone, so they stay at their local time across clock changes.
 */
import { BLOCKS, DEFAULT_BLOCK } from './blocks.ts';
import type { Block } from './blocks.ts';
import { mixColour, OFF_END_LEVEL, rampUp, roundEven } from './blend.ts';
import type { BlockTiming, Config, Room, RoomBlock } from './config.ts';
import type { RoomId } from './types/ids.ts';
import type { Colour, SceneLight } from './types/light.ts';
import { brightnessOrThrow, instantOrThrow, kelvinOrThrow, progressOrThrow, secondsOrThrow } from './types/range.ts';
import type { Progress } from './types/schedule.ts';
import type { Instant, Seconds, Timezone } from './types/time.ts';

/**
 * Where a room (or the house) is in its blocks at an instant (today's
 * `ScheduleDetails`). The search looks at block starts from two evenings
 * before to the evening after the local date; a block whose start is absent on
 * a day does not start that day.
 */
export type BlockPosition = {
  /** The block that started last; the default block when none started in reach. */
  current: Block;
  /** When the current block started; undefined when none started in reach, so the current block is the default. */
  currentSince: Instant | undefined;
  /** Inside the fade before the next block's start: the block faded into and how far the fade has got. */
  fade: { into: Block; progress: Progress } | undefined;
  /** The last fade start at or before the instant, which the next-block reset measures against; undefined when none in reach. */
  lastFadeStart: Instant | undefined;
  nextFadeStart: Instant | undefined;
  nextStart: Instant | undefined;
  /** Within {@link JUST_STARTED} of the current block's start. */
  justStarted: boolean;
};

/**
 * Where a room is in its blocks at `now`. A room follows the house's timing
 * for each block it has no own timing for; no room, or a room the config does
 * not hold (a lamp in no room), follows the house.
 *
 * Day starts in the morning after each evening; cosy and night start that
 * evening, or after midnight when their time is before noon. Day takes its
 * weekend time on Saturday and Sunday mornings; cosy and night take theirs on
 * Friday and Saturday evenings, so a night past midnight into Saturday is
 * Friday's. A block fades into the next over the next block's fade, ending at
 * its start; a fade of zero minutes, or into the block already current, is no fade.
 */
export function blockPosition(config: Config, room: RoomId | undefined, now: Instant): BlockPosition {
  const zone = config.timezone;
  const today = localParts(now, zone);
  let started: Block | undefined, currentSince: Instant | undefined;
  let next: Block | undefined, nextStart: Instant | undefined, nextFade = 0;
  let lastFadeStart: Instant | undefined, nextFadeStart: Instant | undefined;
  for (const offset of [-2, -1, 0, 1]) {
    const eve = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    for (const block of BLOCKS) {
      const timing = timingOf(config, room, block);
      const isDay = block === 'day';
      const weekday = (eve.getUTCDay() + (isDay ? 1 : 0)) % 7;
      const weekend = isDay ? weekday === 6 || weekday === 0 : weekday === 5 || weekday === 6;
      const time = weekend ? timing.weekendStart : timing.weekdayStart;
      if (time === undefined) continue;
      const start = instantOrThrow(localTime(eve.getUTCFullYear(), eve.getUTCMonth() + 1,
        eve.getUTCDate() + (isDay || time.hour < 12 ? 1 : 0), time.hour, time.minute, zone));
      const fade = timing.fade * 60;
      const fadeStart = instantOrThrow(start - fade);
      if (start <= now && (currentSince === undefined || start > currentSince)) { started = block; currentSince = start; }
      if (start > now && (nextStart === undefined || start < nextStart)) { next = block; nextStart = start; nextFade = fade; }
      if (fadeStart > now && (nextFadeStart === undefined || fadeStart < nextFadeStart)) nextFadeStart = fadeStart;
      if (fadeStart <= now && (lastFadeStart === undefined || fadeStart > lastFadeStart)) lastFadeStart = fadeStart;
    }
  }
  const left = nextStart === undefined ? undefined : nextStart - now;
  const fade = next !== undefined && left !== undefined && nextFade > 0 && left < nextFade && next !== started
    ? { into: next, progress: progressOrThrow(1 - left / nextFade) }
    : undefined;
  return {
    current: started === undefined ? DEFAULT_BLOCK : started,
    currentSince,
    fade,
    lastFadeStart,
    nextFadeStart,
    nextStart,
    justStarted: currentSince !== undefined && now - currentSince < JUST_STARTED,
  };
}

/** A block's timing for the room: its own where it has one, the house's otherwise. */
function timingOf(config: Config, room: RoomId | undefined, block: Block): BlockTiming {
  const placed = roomBlock(config, room, block);
  return placed !== undefined && placed.timing.follows === 'own' ? placed.timing.own : config.house[block];
}

/** How long after its start a block counts as just started. */
const JUST_STARTED: Seconds = secondsOrThrow(90);

/** The light a lamp moves between and how far it has got: a held block, a fade, or the wake light. */
export type Stage = { from: StageEnd; into: StageEnd; progress: Progress; moving: boolean };

/** One end of a stage: a block's light, or the light an overlay held, which the lamp fades out of. */
export type StageEnd = { kind: 'block'; block: Block } | { kind: 'held light' };

/** The stage the blocks alone give: the current block held, or the fade into the next. */
export function scheduledStage(position: BlockPosition): Stage {
  const from: StageEnd = { kind: 'block', block: position.current };
  return position.fade === undefined
    ? { from, into: from, progress: progressOrThrow(0), moving: false }
    : { from, into: { kind: 'block', block: position.fade.into }, progress: position.fade.progress, moving: true };
}

/**
 * The wake light's stage, where it replaces the room's night: from the wake
 * time, night fades into day over the wake fade. Once the fade is done the
 * room holds day until the day block (or a fade into another block), for a
 * wake from 04:00 to 10:59 and within 24 hours of it. Undefined where the
 * room has no wake light, is not in a night that started by the wake time,
 * or the wake is neither fading nor holding.
 */
export function wakeStage(room: Room, position: BlockPosition, now: Instant, zone: Timezone): Stage | undefined {
  const wake = room.wakeLight;
  if (wake === undefined) return undefined;
  if (position.current !== 'night' || position.currentSince === undefined || position.currentSince > wake.at) return undefined;
  const duration = wake.fade * 60;
  const elapsed = now - wake.at;
  if (elapsed >= 0 && elapsed < duration) {
    const progress = progressOrThrow(elapsed / duration);
    return { from: { kind: 'block', block: 'night' }, into: { kind: 'block', block: 'day' }, progress, moving: true };
  }
  const hour = localParts(wake.at, zone).hour;
  const held = elapsed >= duration && elapsed < WAKE_HOLD.within && hour >= WAKE_HOLD.fromHour && hour < WAKE_HOLD.beforeHour;
  if (held && (position.fade === undefined || position.fade.into === 'day')) {
    return { from: { kind: 'block', block: 'day' }, into: { kind: 'block', block: 'day' }, progress: progressOrThrow(0), moving: false };
  }
  return undefined;
}

/**
 * The completed wake's hold: within a day of the wake, and only for a wake hour
 * from 4 up to 11 (today's deployed hold, separate from the alarm's 05-12 input).
 */
const WAKE_HOLD = { within: secondsOrThrow(86400), fromHour: 4, beforeHour: 11 };

/**
 * The light `progress` of the way through a moving stage from one light into
 * another. Off into lit switches the lamp on at {@link OFF_END_LEVEL} in the
 * lit end's colour and ramps the level up to the lit end's; lit into off dims
 * towards level 1 and stays lit (the lamp goes off when the next block starts
 * and the stage stops moving); lit into lit mixes level and colour, an end
 * with no colour giving the colour there is, the destination's first. Both
 * off: off. The light keeps the effect of the lit light it leaves; out of an
 * off light, the lit end's.
 *
 * Divergence from today's scripts, named (2026-11-20, "Scheduled fades are
 * gradual in both directions"): they jump an off-into-lit fade straight to the lit end.
 */
export function sceneBetween(from: SceneLight, into: SceneLight, progress: Progress): SceneLight {
  if (from.power === 'off') {
    if (into.power === 'off') return into;
    return { ...into, brightness: brightnessOrThrow(Math.max(OFF_END_LEVEL, rampUp(into.brightness, progress))) };
  }
  if (into.power === 'off') {
    return { ...from, brightness: brightnessOrThrow(Math.max(OFF_END_LEVEL, roundEven(from.brightness * (1 - progress)))) };
  }
  return {
    power: 'on',
    brightness: brightnessOrThrow(roundEven(from.brightness + (into.brightness - from.brightness) * progress)),
    colour: colourBetween(from.colour, into.colour, progress),
    effect: from.effect,
  };
}

/** Two colours part way, a colour temperature rounded half to even; where one end has none, the other's, the destination's first. */
function colourBetween(from: Colour | undefined, into: Colour | undefined, progress: Progress): Colour | undefined {
  if (from === undefined || into === undefined) return into === undefined ? from : into;
  const mixed = mixColour(from, into, progress);
  return mixed.kind === 'kelvin' ? { kind: 'kelvin', kelvin: kelvinOrThrow(roundEven(mixed.kelvin)) } : mixed;
}

/**
 * A block's light for a room: the room's own where it has one for the block,
 * the house's otherwise and for no room. Undefined when the light is missing
 * or unreadable. A lamp's own profile is read over this, by its caller.
 */
export function blockLight(config: Config, room: RoomId | undefined, block: Block): SceneLight | undefined {
  const placed = roomBlock(config, room, block);
  return placed !== undefined && placed.light.follows === 'own' ? placed.light.own : config.house[block].light;
}

/** The room's settings for a block; undefined for no room, or a room the config does not hold. */
function roomBlock(config: Config, room: RoomId | undefined, block: Block): RoomBlock | undefined {
  const placed = room === undefined ? undefined : config.rooms[room];
  return placed === undefined ? undefined : placed.blocks[block];
}

/** The next local midnight after `at`. */
export function nextMidnight(at: Instant, zone: Timezone): Instant {
  const today = localParts(at, zone);
  return instantOrThrow(localTime(today.year, today.month, today.day + 1, 0, 0, zone));
}

/**
 * The instant a wall-clock time in `zone` names, as Python's ZoneInfo reads it
 * by default: a time the clock shows twice (autumn) is its first showing; a
 * time it skips (spring) is read with the offset before the change.
 * The day may run past the month's end; `Date.UTC` carries it over.
 */
function localTime(year: number, month: number, day: number, hour: number, minute: number, zone: Timezone): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const offsets = new Set([-86400, 0, 86400].map(delta => {
    const shown = localParts(wall + delta, zone);
    return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second) / 1000 - wall - delta;
  }));
  const candidates = [...offsets].map(offset => wall - offset);
  const valid = candidates.filter(candidate => {
    const shown = localParts(candidate, zone);
    return Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) / 1000 === wall;
  });
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

/** An instant as the wall clock in `zone` shows it. */
function localParts(at: number, zone: Timezone): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = formatterFor(zone).formatToParts(new Date(at * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(p => p.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}

function formatterFor(zone: Timezone): Intl.DateTimeFormat {
  const known = FORMATTERS.get(zone);
  if (known !== undefined) return known;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  FORMATTERS.set(zone, formatter);
  return formatter;
}

/** One formatter per zone: building one is slow, and the schedule asks many times a pass. */
const FORMATTERS = new Map<Timezone, Intl.DateTimeFormat>();
