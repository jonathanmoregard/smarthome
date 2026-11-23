/**
 * The remote: what a remote's presses do to the Model.
 *
 * A button (`remoteButtonPressed`) goes through the gestures first. A burst of
 * power presses is the power toggle (one press) or the room's reset (three)
 * once its window closes; two do nothing more. Power, power, left, right,
 * left, right is the mode toggle. The preset buttons turn like a dial: the
 * next button is right, the one before is left. Any other press ends a chord
 * and is the command it names. A command (`remotePressed`) acts on the
 * remote's room at once. A remote with no room does nothing.
 *
 * Moved from `update`, `remoteArea` and `stampPowerToken` in
 * `src/legacy/domain/gestures.ts` (the gesture reducer; its helpers, its
 * power token and its HA timers become the deadlines in `RemoteModel`, which
 * the clock closes); `remoteOpening` and `remoteDecision` in
 * `src/legacy/domain/remote-input.ts` (what each command does to the room's
 * remote overlay); and `acceptedPowerSwitch` and `remoteCommit` in
 * `src/legacy/domain/controller.ts` (the toggle is the room's power; the
 * commit is the Model returned).
 */
import type { Block } from './blocks.ts';
import { lightingState, roomOverlays } from './lighting-state.ts';
import type { ChordProgress, Model, PresetButton, RemoteButton, RemoteModel } from './model.ts';
import { clearRoom, setModeOverlay, setRoomPower } from './overlays.ts';
import type { HeldBlock, PresetChoice, RememberedPreset, RemoteAdjustment, RemoteOverlay, RemotePreset, StepRange } from './overlays.ts';
import { blockPosition } from './schedule.ts';
import type { RemoteId, RoomId } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Power } from './types/light.ts';
import { instantOrThrow, secondsOrThrow, STEP_BOUNDS, stepCountOrThrow, stepOrThrow } from './types/range.ts';
import type { RemoteCommand, Step, StepCount } from './types/remote.ts';
import type { Instant, Seconds } from './types/time.ts';

/** A chord step's window: today's chord timer, `00:00:03`. */
export const CHORD_WINDOW: Seconds = secondsOrThrow(3);

/** A burst of power presses closes this long after its last press: today's quiet script's 600 ms. */
export const POWER_COMBO_WINDOW: Seconds = secondsOrThrow(0.6);

/** A remote nobody has pressed: no chord, no power burst, no preset button. */
export const IDLE_REMOTE: RemoteModel = { chord: { active: false }, power: { presses: 0 }, presetButton: undefined };

/** A remote overlay's step range until one is saved: today's `{'min':-20,'max':20}`. */
export const DEFAULT_STEP_RANGE: StepRange = { min: stepOrThrow(STEP_BOUNDS.low), max: stepOrThrow(STEP_BOUNDS.high) };

/**
 * When the steps of a remote that has saved none were set: before every other
 * part, so the lighting state folds them in first (today's
 * `as_timestamp(when, 0)` of a record that is not there).
 */
const OLDEST: Instant = instantOrThrow(0);

/** The preset buttons in today's `presets` order, coolest first: the dial turns along it and round. */
const PRESET_BUTTONS: readonly PresetButton[] = ['coolest', 'cool', 'neutral', 'warm', 'warmest'];

/** Right goes day, cosy, candle and round again; left the other way. */
const RIGHT_OF: Readonly<Record<PresetChoice, PresetChoice>> = { day: 'cosy', cosy: 'candle', candle: 'day' };
const LEFT_OF: Readonly<Record<PresetChoice, PresetChoice>> = { day: 'candle', cosy: 'day', candle: 'cosy' };

/** What a press does during a chord: the step it expects, and where the chord is after it. */
type ChordStep = { expects: 'left' | 'right'; then: ChordProgress | 'complete' };

/** The chord after each of its steps so far. After the first power press it waits for the second, which only power gives. */
const CHORD_STEPS: Readonly<Record<ChordProgress, ChordStep | undefined>> = {
  'power': undefined,
  'power power': { expects: 'left', then: 'power power left' },
  'power power left': { expects: 'right', then: 'power power left right' },
  'power power left right': { expects: 'left', then: 'power power left right left' },
  'power power left right left': { expects: 'right', then: 'complete' },
};

/**
 * A button pressed on a remote. The windows of this remote that closed before
 * the press are closed first, as today's timers would have, then the press
 * goes through the gestures.
 */
export function remoteButtonPressed(model: Model, remote: RemoteId, button: RemoteButton, now: Instant): Model {
  const room = model.config.remotes[remote]?.room;
  if (room === undefined) return model;
  const caught = windowsClosed(model, remote, room, now);
  const state = remoteState(caught, remote);
  switch (button.kind) {
    case 'power': return powerPressed(caught, remote, state, now);
    case 'preset': return presetButtonPressed(caught, remote, room, state, button.button, now);
    case 'arrow': case 'cancel': return chordOrCommand(caught, remote, room, state, button, now);
  }
}

/** One remote's chord and burst, closed where their window has. A burst of one or three acts only for a remote in a room. */
function windowsClosed(model: Model, remote: RemoteId, room: RoomId | undefined, now: Instant): Model {
  const state = remoteState(model, remote);
  const chord: RemoteModel['chord'] = state.chord.active && now >= state.chord.until ? { active: false } : state.chord;
  const power = state.power;
  if (power.presses === 0 || now < power.until) return chord === state.chord ? model : withRemoteState(model, remote, { ...state, chord });
  // One press or three end the chord; two leave it waiting for its next step.
  const closed = withRemoteState(model, remote, { ...state, power: { presses: 0 }, chord: power.presses === 2 ? chord : { active: false } });
  if (power.presses === 2 || room === undefined) return closed;
  return roomCommand(closed, remote, room, power.presses === 1 ? 'toggle' : 'reset', now);
}

/** A remote's gesture state; a remote the Model holds none for is idle. */
function remoteState(model: Model, remote: RemoteId): RemoteModel {
  const state = model.remotes[remote];
  return state === undefined ? IDLE_REMOTE : state;
}

function withRemoteState(model: Model, remote: RemoteId, state: RemoteModel): Model {
  return { ...model, remotes: { ...model.remotes, [remote]: state } };
}

/**
 * What each command does to its room: the mode press toggles the mode
 * overlay; the power toggle switches the room's power; the reset clears the
 * room's overlays; brighter and dimmer move one step; left and right turn the
 * presets.
 */
function roomCommand(model: Model, remote: RemoteId, room: RoomId, command: RemoteCommand, now: Instant): Model {
  switch (command) {
    case 'mode': return setModeOverlay(model, !model.modeOverlay.active, now);
    case 'toggle': return setRoomPower(model, room, toggledPower(model, room, now));
    case 'reset': return clearRoom(model, room);
    case 'up': case 'down': return stepped(model, remote, room, command, now);
    case 'left': case 'right': return presetTurned(model, remote, room, command, now);
  }
}

/**
 * The power the toggle switches the room to: the opposite of its saved
 * power, or, with none saved, of whether anything in it is lit: a lamp, or a
 * switch with a range rule. Today that reads what Home Assistant says the
 * lamps show; the lighting state is what they are made to show.
 */
function toggledPower(model: Model, room: RoomId, now: Instant): Power {
  const saved = model.overlays.roomPower[room];
  if (saved !== undefined) return saved === 'on' ? 'off' : 'on';
  const lighting = lightingState(model, now);
  const lit = entriesOf(model.config.lamps).some(([lamp, placed]) => placed.room === room && lighting.lamps[lamp]?.power === 'on')
    || entriesOf(model.switchRanges).some(([plug]) => model.config.switches[plug]?.room === room && lighting.switches[plug] === 'on');
  return lit ? 'off' : 'on';
}

/**
 * Brighter (`up`) or dimmer (`down`): one step from where the room's carried
 * overlay left them, both bounds moving with it inside the step range, the
 * count back to zero where the bounds meet. A newer overlay on the room
 * restarts the steps from zero. The preset and what each preset held carry over.
 */
function stepped(model: Model, remote: RemoteId, room: RoomId, press: 'up' | 'down', now: Instant): Model {
  const carried = roomOverlays(model, room, now).remote;
  const range = carried === undefined ? DEFAULT_STEP_RANGE : carried.stepRange;
  const start = startingSteps(carried, range);
  const kept = withinRange(newerOnRoom(model, remote, room, start.at) ? noSteps(range, now) : start, range);
  const delta = press === 'up' ? 1 : -1;
  const lower = stepWithin(kept.lower + delta, range), upper = stepWithin(kept.upper + delta, range);
  const adjustment: RemoteAdjustment = {
    steps: lower === upper ? stepCountOrThrow(0) : countWithin(kept.steps + delta),
    lower, upper, from: kept.from, at: now, lastPress: press, everBrighter: kept.everBrighter || press === 'up',
  };
  const preset: RemotePreset = carried === undefined ? { choice: 'none' } : carried.preset;
  const remembered = carried === undefined ? {} : carried.remembered;
  return overlaySaved(model, { remote, room, since: now, stepRange: range, adjustment, preset, remembered });
}

/**
 * The steps a press goes on from: the carried overlay's brighter and dimmer
 * presses, else the ones its candle started from (today's `adjustment`, else
 * `selection_input`), else none yet, set when the overlay was.
 */
function startingSteps(carried: RemoteOverlay | undefined, range: StepRange): RemoteAdjustment {
  if (carried === undefined) return noSteps(range, OLDEST);
  if (carried.adjustment !== undefined) return carried.adjustment;
  if (carried.preset.choice === 'candle' && carried.preset.adjustment !== undefined) return carried.preset.adjustment;
  return noSteps(range, carried.since);
}

/** No presses yet: zero steps across the whole range, placed from the level the room shows. */
function noSteps(range: StepRange, at: Instant): RemoteAdjustment {
  return { steps: stepCountOrThrow(0), lower: range.min, upper: range.max, from: 'current', at, lastPress: undefined, everBrighter: false };
}

/** Steps with both bounds held inside the step range, the count back to zero where they meet. */
function withinRange(adjustment: RemoteAdjustment, range: StepRange): RemoteAdjustment {
  const lower = stepWithin(adjustment.lower, range), upper = stepWithin(adjustment.upper, range);
  return { ...adjustment, lower, upper, steps: lower === upper ? stepCountOrThrow(0) : adjustment.steps };
}

function stepWithin(value: number, range: StepRange): Step {
  return stepOrThrow(Math.max(range.min, Math.min(range.max, value)));
}

/**
 * An overlay over the remote's room set after `since`, which restarts its
 * steps (today's restart check): a person's or a control's brightness or
 * effect over the whole room, or another remote's brighter and dimmer
 * presses in it. An overlay on one lamp does not restart them, nor does a
 * held block. Every overlay is read, the ones the next-block reset released
 * too, as today's check reads every stored record.
 */
function newerOnRoom(model: Model, remote: RemoteId, room: RoomId, since: Instant): boolean {
  const { lamps, remotes } = model.overlays;
  return lamps.some(overlay => overlay.kind === 'parts' && overlay.over.kind === 'room' && overlay.over.room === room
      && [overlay.brightness, overlay.effect].some(part => part !== undefined && part.at > since))
    || remotes.some(other => other.remote !== remote && other.room === room && other.adjustment !== undefined && other.adjustment.at > since);
}

/**
 * A count held inside -40..40. Presses alone never reach an end (the bounds
 * meet first); only a saved count already at one does, which today's store
 * would then refuse on its next read.
 */
function countWithin(value: number): StepCount {
  return stepCountOrThrow(Math.max(-2 * STEP_BOUNDS.high, Math.min(2 * STEP_BOUNDS.high, value)));
}

/** The remote's overlay saved: it replaces the one it had, for whichever room. */
function overlaySaved(model: Model, overlay: RemoteOverlay): Model {
  const remotes = [...model.overlays.remotes.filter(other => other.remote !== overlay.remote), overlay];
  return { ...model, overlays: { ...model.overlays, remotes } };
}

/**
 * Left or right: the next preset that way from the one the room's carried
 * overlay holds, or, with none, from the block the room is in (night starts
 * where day does). The preset left is remembered and a remembered one comes
 * back as it was; one not remembered starts now, the candle at the steps it
 * starts from and holding the day or cosy block the remote held. The steps
 * stay, kept inside the step range.
 */
function presetTurned(model: Model, remote: RemoteId, room: RoomId, press: 'left' | 'right', now: Instant): Model {
  const onRoom = roomOverlays(model, room, now);
  const carried = onRoom.remote;
  const range = carried === undefined ? DEFAULT_STEP_RANGE : carried.stepRange;
  const adjustment = withinRange(startingSteps(carried, range), range);
  const preset: RemotePreset = carried === undefined ? { choice: 'none' } : carried.preset;
  const current = preset.choice !== 'none' ? preset.choice
    : presetOfBlock(onRoom.block !== undefined ? onRoom.block : blockPosition(model.config, room, now).current);
  const remembered: RemoteOverlay['remembered'] = carried === undefined ? {} : { ...carried.remembered };
  // A preset read from the room's block holds nothing of its own: today it is saved empty, which comes back as it starts.
  if (preset.choice !== 'none') remembered[preset.choice] = preset;
  else if (current !== undefined) delete remembered[current];
  const from = current === undefined ? 'day' : current;
  const selected = press === 'right' ? RIGHT_OF[from] : LEFT_OF[from];
  const restored = remembered[selected];
  const chosen: RememberedPreset = restored !== undefined ? restored
    : selected === 'candle' ? { choice: 'candle', since: now, adjustment, block: heldBlockOf(preset) }
      : { choice: selected, since: now };
  return overlaySaved(model, { remote, room, since: now, stepRange: range, adjustment, preset: chosen, remembered });
}

/** The preset a block stands for; night is none of them. */
function presetOfBlock(block: Block): PresetChoice | undefined {
  return block === 'night' ? undefined : block;
}

/** The day or cosy block a preset holds, which a candle chosen from it keeps holding. */
function heldBlockOf(preset: RemotePreset): HeldBlock | undefined {
  switch (preset.choice) {
    case 'day': case 'cosy': return { block: preset.choice, since: preset.since };
    case 'candle': return preset.block;
    case 'none': return undefined;
  }
}

/**
 * A power press: it forgets the preset dial's position and counts into the
 * open burst (at most three), or opens one. The first press of a burst starts
 * the chord; the second keeps it going only while the chord waits for it.
 */
function powerPressed(model: Model, remote: RemoteId, state: RemoteModel, now: Instant): Model {
  const burst = state.power;
  const presses = burst.presses === 0 ? 1 : burst.presses === 1 ? 2 : 3;
  const chord: RemoteModel['chord'] = presses === 1 ? { active: true, progress: 'power', until: after(now, CHORD_WINDOW) }
    : presses === 2 && state.chord.active && state.chord.progress === 'power'
      ? { active: true, progress: 'power power', until: after(now, CHORD_WINDOW) }
      : { active: false };
  return withRemoteState(model, remote, { chord, power: { presses, until: after(now, POWER_COMBO_WINDOW) }, presetButton: undefined });
}

function after(now: Instant, window: Seconds): Instant {
  return instantOrThrow(now + window);
}

/**
 * A preset button: one outside the table only ends a chord; the button the
 * dial is already at does nothing; any other turns the dial, right for the
 * next button and left for the one before. A jump further, or the first
 * button after a power press other than the coolest (right) or the warmest
 * (left), turns it nowhere and only ends a chord.
 */
function presetButtonPressed(model: Model, remote: RemoteId, room: RoomId, state: RemoteModel, button: PresetButton | undefined,
  now: Instant): Model {
  if (button === undefined) return chordOrCommand(model, remote, room, state, { kind: 'cancel' }, now);
  const previous = state.presetButton;
  if (previous === button) return model;
  const turned = { ...state, presetButton: button };
  return chordOrCommand(withRemoteState(model, remote, turned), remote, room, turned, dialTurn(previous, button), now);
}

/**
 * A press the chord may be waiting for: the step it expects moves the chord
 * on (its last step toggles the mode overlay); any other press ends the chord
 * and is the command it names, the cancel button none.
 */
function chordOrCommand(model: Model, remote: RemoteId, room: RoomId, state: RemoteModel,
  button: Extract<RemoteButton, { kind: 'arrow' | 'cancel' }>, now: Instant): Model {
  const chord = state.chord;
  const step = chord.active ? CHORD_STEPS[chord.progress] : undefined;
  if (step !== undefined && button.kind === 'arrow' && button.direction === step.expects) {
    if (step.then !== 'complete') {
      return withRemoteState(model, remote, { ...state, chord: { active: true, progress: step.then, until: after(now, CHORD_WINDOW) } });
    }
    return roomCommand(withRemoteState(model, remote, { ...state, chord: { active: false } }), remote, room, 'mode', now);
  }
  const ended = chord.active ? withRemoteState(model, remote, { ...state, chord: { active: false } }) : model;
  return button.kind === 'cancel' ? ended : roomCommand(ended, remote, room, button.direction, now);
}

/** Where the dial turned, as the arrow it stands for; nowhere is the cancel button's press. */
function dialTurn(previous: PresetButton | undefined, button: PresetButton): Extract<RemoteButton, { kind: 'arrow' | 'cancel' }> {
  const count = PRESET_BUTTONS.length;
  const turn = previous === undefined ? (button === 'coolest' ? 1 : button === 'warmest' ? count - 1 : 0)
    : (PRESET_BUTTONS.indexOf(button) - PRESET_BUTTONS.indexOf(previous) + count) % count;
  return turn === 1 ? { kind: 'arrow', direction: 'right' } : turn === count - 1 ? { kind: 'arrow', direction: 'left' } : { kind: 'cancel' };
}

/** A command a remote sends for its room (from its gestures, or another caller). A remote with no room does nothing. */
export function remotePressed(model: Model, remote: RemoteId, command: RemoteCommand, now: Instant): Model {
  const room = model.config.remotes[remote]?.room;
  return room === undefined ? model : roomCommand(model, remote, room, command, now);
}

/**
 * The chords and power bursts whose window closed by `now`, closed: a chord
 * is dropped; a burst of one press toggles its room's power, of three resets
 * the room. The clock closes them; a press closes its own remote's first.
 */
export function remoteTimeouts(model: Model, now: Instant): Model {
  return entriesOf(model.remotes).reduce((closed, [remote]) => windowsClosed(closed, remote, closed.config.remotes[remote]?.room, now), model);
}
