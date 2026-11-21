import { withFields } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { stateText } from '../runtime/format.ts';
import type { Plan } from '../runtime/effects.ts';
import type { RemoteId, RoomId } from './types/ids.ts';

const presets = [200, 285, 370, 454, 588];
const directions = ['left', 'right', 'up', 'down'];
export const accepted = ['power', 'power_done', 'preset', 'cancel', ...directions];
/** The two preset-payload fields the gesture reads; any other type is `undefined`. */
export interface PresetPayload {
  action: string | undefined;
  preset: number | undefined;
}
export interface GestureArgs {
  room: RoomId;
  command: string;
  token: string;
  payload: () => PresetPayload | undefined;
  delivery: () => { deviceId: RemoteId | undefined; source: string };
}
export interface PowerQuietArgs {
  /** The whole argument document, forwarded into the scheduled `power_done`. */
  document: Verbatim;
  room: RoomId;
}

/**
 * The remote's helper state as this transaction opens it. `powerToken` is the
 * stored token with `unknown`/`unavailable` read as empty; `preset` is the
 * cursor as captured `| float(-2)`.
 */
export interface GestureState {
  chordStep: number;
  chordActive: boolean;
  powerCount: number;
  powerToken: string;
  preset: number;
}
/** A gesture's arguments plus its two snapshot reads: the remotes' rooms and the opening `now`. */
export interface GestureInput extends GestureArgs {
  remoteRooms: Readonly<Record<RemoteId, RoomId>>;
  now: string;
}
type HelperKey = 'chord_step' | 'power_count' | 'power_token' | 'preset';

function helperDomain(key: HelperKey): string { return key === 'power_token' ? 'input_text' : 'input_number'; }
/** Write a helper: the transaction's own view of it first, then the service. */
function* setHelper(room: RoomId, key: HelperKey, value: string | number): Plan<void> {
  const entity = `${helperDomain(key)}.ls_${room}_remote_${key}`;
  yield { kind: 'state', entity, state: stateText(value) };
  yield { kind: 'service', service: `${helperDomain(key)}.set_value`, data: { value }, target: { entity_id: entity } };
}
function* chordTimer(room: RoomId, start: boolean): Plan<void> {
  const chord = `timer.ls_${room}_remote_chord`;
  yield { kind: 'state', entity: chord, state: start ? 'active' : 'idle' };
  yield {
    kind: 'service', service: `timer.${start ? 'start' : 'cancel'}`,
    data: start ? { duration: '00:00:03' } : {}, target: { entity_id: chord },
  };
}

/**
 * The area a remote's commands go to: its device's area, or none. A remote
 * with no device, or whose device has no area (an empty area id is none),
 * has no area, and its gestures send nothing. There is no fallback room.
 */
export function remoteArea(deviceId: RemoteId | undefined, remoteRooms: Readonly<Record<RemoteId, RoomId>>): RoomId | undefined {
  if (deviceId === undefined) return undefined;
  const area = remoteRooms[deviceId];
  return area === undefined || area.length === 0 ? undefined : area;
}

/**
 * The gesture reducer: one remote command against the helper state, as the
 * effects it causes and the state they leave.
 *
 * Effects are yielded explicitly rather than diffed from the state, because
 * repeated writes are observable (`power_count` goes to 0, then to the new
 * count). A `power` press stops before its token: the token and the quiet
 * script both carry `now` as read after these writes, so the caller stamps
 * them with {@link stampPowerToken} and {@link launchPowerQuiet}.
 */
export function* gesture(state: GestureState, input: GestureInput): Plan<GestureState> {
  const room = input.room;
  let command = input.command;
  const next = { ...state };
  if (!accepted.includes(command)) return next;
  const set = function* (key: Exclude<HelperKey, 'power_token'>, value: number): Plan<void> {
    yield* setHelper(room, key, value);
    if (key === 'chord_step') next.chordStep = value;
    else if (key === 'power_count') next.powerCount = value;
    else next.preset = value;
  };
  const clearToken = function* (): Plan<void> {
    yield* setHelper(room, 'power_token', '');
    next.powerToken = '';
  };
  const timer = function* (start: boolean): Plan<void> {
    yield* chordTimer(room, start);
    next.chordActive = start;
  };
  const clearChord = function* (): Plan<void> { yield* set('chord_step', 0); yield* timer(false); };
  const send = function* (logical: string): Plan<void> {
    // The delivery fields raise only here, after the writes that precede the send.
    const { deviceId, source } = input.delivery();
    const area = remoteArea(deviceId, input.remoteRooms);
    if (area === undefined) return;
    yield {
      kind: 'service', service: 'script.turn_on',
      data: { variables: { source, area, command: logical, dry_run: false } }, target: { entity_id: 'script.ls_remote_command' },
    };
  };
  const step = state.chordStep, active = state.chordActive, stored = state.powerToken;
  let clicks = state.powerCount;
  const quietActive = clicks > 0 && stored.length > 0 && Date.parse(stored) + 600 > Date.parse(input.now);
  const complete = function* (): Plan<void> {
    yield* set('power_count', 0);
    yield* clearToken();
    if (clicks === 1 || clicks >= 3) { yield* clearChord(); yield* send(clicks === 1 ? 'toggle' : 'reset'); }
  };
  if (command === 'power_done') {
    if (input.token.length === 0 || input.token !== stored || clicks <= 0) return next;
    yield* complete();
    return next;
  }
  if (command === 'power') {
    yield* set('preset', -1);
    if (clicks > 0 && !quietActive) yield* complete();
    clicks = quietActive ? Math.min(3, clicks + 1) : 1;
    yield* set('power_count', clicks);
    if (clicks === 1) { yield* set('chord_step', -1); yield* timer(true); }
    else if (clicks === 2 && active && step === -1) { yield* set('chord_step', 1); yield* timer(true); }
    else yield* clearChord();
    return next;
  }
  if (command === 'preset') {
    const payload = input.payload();
    if (payload === undefined) return next;
    if (payload.action !== 'color_temperature_move') return next;
    const preset = payload.preset;
    if (preset === undefined || !presets.includes(preset)) { yield* clearChord(); return next; }
    const index = presets.indexOf(preset);
    const previous = state.preset;
    if (index === previous) return next;
    const delta = previous === -1 ? (index === 0 ? 1 : index === 4 ? 4 : -1)
      : [0, 1, 2, 3, 4].includes(previous) ? (index - previous + 5) % 5 : -1;
    yield* set('preset', index);
    command = delta === 1 ? 'right' : delta === 4 ? 'left' : 'cancel';
  }
  if (active && [1, 2, 3, 4].includes(step) && command === ['left', 'right', 'left', 'right'][step - 1]) {
    if (step === 4) { yield* clearChord(); yield* send('sara_toggle'); }
    else { yield* set('chord_step', step + 1); yield* timer(true); }
    return next;
  }
  if (step !== 0 || active) yield* clearChord();
  if (directions.includes(command)) yield* send(command);
  return next;
}

/** A power press's token, stamped with `now` as read after the press's writes. */
export function* stampPowerToken(room: RoomId, now: string): Plan<void> {
  yield* setHelper(room, 'power_token', now);
}
/**
 * Launch the restartable quiet script. The host runs it; keeping the HA service
 * boundary lets the same recorder and event router execute this actor.
 */
export function* launchPowerQuiet(room: RoomId, now: string): Plan<void> {
  yield {
    kind: 'service', service: 'script.turn_on',
    data: { variables: { token: now } }, target: { entity_id: `script.ls_remote_power_quiet_${room}` },
  };
}
/** The quiet window: schedule `power_done` with the whole argument document carried. */
export function* powerQuiet(args: PowerQuietArgs): Plan<null> {
  yield { kind: 'schedule', script: 'ls_remote_gesture', args: withFields(args.document, { room: args.room, command: 'power_done' }), delayMs: 600 };
  return null;
}
