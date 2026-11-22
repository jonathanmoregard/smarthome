/**
 * The remote helpers codec: a remote's gesture state, read from and written to
 * the helpers the gesture script keeps per room (`ls_<room>_remote_*`): the
 * chord step, the chord timer, the power count, the power token and the preset
 * cursor.
 *
 * Today these helpers belong to a room, and the Model keeps the state per
 * remote. A remote reads its room's helpers; two remotes in one room read the
 * same helpers, as they share them today (M3 Task 2 decides what each does).
 *
 * The helpers are values a person's presses change at run time, so a helper in
 * `unknown` or `unavailable`, or holding garbage, reads as today's fallback
 * (`gestureState`, `src/parse/gestures.ts`) and never raises.
 */
import type { ChordProgress, PresetButton, RemoteModel } from '../../domain/model.ts';
import type { RoomId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { Instant } from '../../domain/types/time.ts';
import { toInstant } from '../../parse/ids.ts';
import { jinjaFloat, jinjaInt } from '../../runtime/parse.ts';
import type { ConfigSource } from './config.ts';
import { dateSeconds, nowText } from './time-text.ts';

/** A remote nobody has pressed: no chord, no power burst, no preset button. */
export const IDLE_REMOTE: RemoteModel = { chord: { active: false }, power: { presses: 0 }, presetButton: undefined };

/** The helpers one room's remotes keep their gesture state in. */
export type RemoteHelper = 'preset' | 'power count' | 'chord step' | 'chord timer' | 'power token';

/** The entity a remote helper is for one room. */
export function remoteHelperEntity(room: RoomId, helper: RemoteHelper): string {
  return HELPER_ENTITY[helper](room);
}

/** What a helper is set to: a number or text helper's value, or the chord timer started until a time, or stopped. */
export type HelperValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'timer'; running: true; until: Instant }
  | { kind: 'timer'; running: false };

/** The chord's steps as today's `chord_step` counts them. */
const CHORD_STEPS: Readonly<Record<ChordProgress, number>> = {
  'power': -1, 'power power': 1, 'power power left': 2, 'power power left right': 3, 'power power left right left': 4,
};

/** The preset buttons in today's `presets` order, coolest first: the cursor is the index. */
const PRESET_BUTTONS: readonly PresetButton[] = ['coolest', 'cool', 'neutral', 'warm', 'warmest'];

/** The cursor today's gesture writes when the power button is pressed: no preset button since. */
const NO_PRESET_CURSOR = -1;

/** A burst of power presses stays open this long after its token: today's 600 ms. */
const POWER_WINDOW_SECONDS = 0.6;

/** The epoch: a chord timer that runs with no readable end has ended, so the next clock closes it. */
const EPOCH: Instant = toInstant(0);

const HELPER_ENTITY: Readonly<Record<RemoteHelper, (room: RoomId) => string>> = {
  'preset': room => `input_number.ls_${room}_remote_preset`,
  'power count': room => `input_number.ls_${room}_remote_power_count`,
  'chord step': room => `input_number.ls_${room}_remote_chord_step`,
  'chord timer': room => `timer.ls_${room}_remote_chord`,
  'power token': room => `input_text.ls_${room}_remote_power_token`,
};

/** The order the writes go out in: the power press's, today's most common gesture (see `remoteHelperWrites`). */
const WRITE_ORDER: readonly RemoteHelper[] = ['preset', 'power count', 'chord step', 'chord timer', 'power token'];

function sameValue(a: HelperValue, b: HelperValue): boolean {
  if (a.kind === 'timer' || b.kind === 'timer') {
    return a.kind === 'timer' && b.kind === 'timer' && (a.running ? b.running && a.until === b.until : !b.running);
  }
  return a.kind === b.kind && a.value === b.value;
}

export type HelperWrite = { helper: RemoteHelper; value: HelperValue };

/**
 * The helper writes that take a remote from one state to the next: only the
 * helpers whose value changed. Today's reducer writes them in an order that
 * depends on the gesture; these follow the power press (preset, count, chord
 * step, chord timer, then the token). A burst that completes writes its token
 * before the chord today; the order between the two helpers carries no
 * meaning, since each is set on its own.
 */
export function remoteHelperWrites(before: RemoteModel, after: RemoteModel): HelperWrite[] {
  const was = helperValues(before), now = helperValues(after);
  return WRITE_ORDER.filter(helper => !sameValue(was[helper], now[helper])).map(helper => ({ helper, value: now[helper] }));
}

/** Each helper's value for a state, as the gesture writes it: the token is the press's `now` text. */
function helperValues(model: RemoteModel): Record<RemoteHelper, HelperValue> {
  const chord = model.chord, power = model.power;
  const token = power.presses === 0 ? '' : nowText(toInstant(power.until - POWER_WINDOW_SECONDS));
  return {
    'preset': { kind: 'number', value: model.presetButton === undefined ? NO_PRESET_CURSOR : PRESET_BUTTONS.indexOf(model.presetButton) },
    'power count': { kind: 'number', value: power.presses },
    'chord step': { kind: 'number', value: chord.active ? CHORD_STEPS[chord.progress] : 0 },
    'chord timer': chord.active ? { kind: 'timer', running: true, until: chord.until } : { kind: 'timer', running: false },
    'power token': { kind: 'text', value: token },
  };
}

/** A remote's gesture state, read from its room's helpers. */
export function decodeRemoteModel(source: ConfigSource, room: RoomId): RemoteModel {
  const state = (helper: RemoteHelper) => source.states[remoteHelperEntity(room, helper)];
  const readable = (helper: RemoteHelper) => {
    const text = state(helper)?.state;
    return text === undefined || text === 'unknown' || text === 'unavailable' ? undefined : text;
  };
  return {
    chord: decodeChord(jinjaInt(readable('chord step'), 0), state('chord timer')?.state === 'active',
      state('chord timer')?.attributes['finishes_at']),
    power: decodePower(jinjaInt(readable('power count'), 0), readable('power token')),
    presetButton: decodePresetButton(jinjaFloat(readable('preset'), -2)),
  };
}

/** A chord is in progress while its timer runs and its step is one of the chord's. */
function decodeChord(step: number, running: boolean, finishesAt: unknown): RemoteModel['chord'] {
  const progress = entriesOf(CHORD_STEPS).find(([, counted]) => counted === step)?.[0];
  if (!running || progress === undefined) return { active: false };
  const end = typeof finishesAt === 'string' ? Date.parse(finishesAt) : NaN;
  return { active: true, progress, until: Number.isNaN(end) ? EPOCH : toInstant(end / 1000) };
}

/**
 * A burst of power presses: today's count stops at three, and the burst is
 * open until 600 ms after its token, read to the microsecond it was written
 * with. A count with no readable token has closed.
 */
function decodePower(count: number, token: string | undefined): RemoteModel['power'] {
  if (count <= 0) return { presses: 0 };
  const stamp = token === undefined ? undefined : dateSeconds(token);
  const until = stamp === undefined ? EPOCH : toInstant(stamp + POWER_WINDOW_SECONDS);
  return { presses: count >= 3 ? 3 : count === 2 ? 2 : 1, until };
}

/** The cursor as a button; any cursor that is not one of the five (`-1` after a power press, `-2` unreadable) is none. */
function decodePresetButton(cursor: number): PresetButton | undefined {
  return Number.isInteger(cursor) ? PRESET_BUTTONS[cursor] : undefined;
}
