/**
 * The remote: its buttons, the gestures they make, the remote overlay its
 * commands set on its room, and what that overlay lays over the room's light.
 *
 * A button goes through the gestures first (`buttonPressed`). A burst of
 * power presses is the power toggle (one press) or the room's reset (three)
 * once its window closes (`windowsClosed`); two do nothing more. Power, power,
 * left, right, left, right is the mode toggle. The preset buttons turn like a
 * dial: the next button is right, the one before is left. Any other press
 * ends a chord and is the command it names. `update` takes each command to
 * what it changes: the toggle to the room's power, the reset to the room's
 * overlays, the mode toggle to the mode overlay, and brighter, dimmer, left
 * and right to the remote's overlay here (`remoteSteered`). A remote with no
 * room does nothing.
 *
 * The remote overlay holds the brighter and dimmer steps, placed on the room's
 * blend between its cosy and day light, and the preset the arrows chose: day
 * or cosy, which holds that block over the room, or the candle.
 *
 * Moved from `update`, `remoteArea` and `stampPowerToken` in
 * `src/legacy/domain/gestures.ts` (the gesture reducer; its helpers, its
 * power token and its HA timers become the deadlines in `RemoteModel`, which
 * the clock closes); `remoteOpening` and `remoteDecision` in
 * `src/legacy/domain/remote-input.ts` (what each command does to the room's
 * remote overlay); `acceptedPowerSwitch` and `remoteCommit` in
 * `src/legacy/domain/controller.ts` (the toggle is the room's power; the
 * commit is the Model returned); and `latestStream`, `normalPosition` and the
 * block a lamp is in (`scheduledBase`) in `src/legacy/domain/resolution.ts`
 * and `src/legacy/domain/schedule.ts`.
 */
import { blend, OFF_END_LEVEL } from './blend.ts';
import type { BlockOverlay } from './block-overlays.ts';
import type { EffectOverlay, LampOverlay } from './lamp-overlays.ts';
import type { RemoteId, RoomId } from './types/ids.ts';
import type { Brightness, Colour, RGB, SceneLight } from './types/light.ts';
import {
  blendPositionOrThrow, brightnessOrThrow, instantOrThrow, secondsOrThrow, STEP_BOUNDS, stepCountOrThrow, stepOrThrow,
} from './types/range.ts';
import type { BlendPosition, Step, StepCount } from './types/range.ts';
import type { Block } from './types/schedule.ts';
import type { Instant, Seconds } from './types/time.ts';

/**
 * A remote's gesture state, which `update` owns (the gesture reducer moves
 * into the domain): a chord in progress, the burst of power presses counted so
 * far, and the preset button's position. Each window that can close is a
 * deadline, so a `clock` message closes it.
 */
export type RemoteModel = {
  /** The chord that toggles the mode overlay: power, power, left, right, left, right. */
  chord: { active: false } | { active: true; progress: ChordProgress; until: Instant };
  /**
   * A burst of power presses: one is the power toggle, three the reset, when
   * the burst's window closes. `anyOn` is what the room reported at the
   * burst's last press, which the toggle reads when the window closes.
   */
  power: { presses: 0 } | { presses: 1 | 2 | 3; until: Instant; anyOn: boolean };
  /** None pressed yet, or since the last power press. */
  presetButton: PresetButton | undefined;
};

/** A remote's gesture state; a remote the Model holds none for is idle. */
export function remoteState(remotes: Readonly<Record<RemoteId, RemoteModel>>, remote: RemoteId): RemoteModel {
  const state = remotes[remote];
  return state === undefined ? IDLE_REMOTE : state;
}

/** When each remote's open chord and burst close their window: the clock must come then. */
export function windowDeadlines(remotes: Readonly<Record<RemoteId, RemoteModel>>): Instant[] {
  return Object.values(remotes).flatMap(remote => [
    ...(remote.chord.active ? [remote.chord.until] : []),
    ...(remote.power.presses !== 0 ? [remote.power.until] : []),
  ]);
}

/**
 * A power press: it forgets the preset dial's position and counts into the
 * open burst (at most three), or opens one, keeping what the room reports at
 * this press. The first press of a burst starts the chord; the second keeps it
 * going only while the chord waits for it.
 */
function powerPressed(state: RemoteModel, anyOn: boolean, now: Instant): RemoteModel {
  const burst = state.power;
  const presses = burst.presses === 0 ? 1 : burst.presses === 1 ? 2 : 3;
  const chord: RemoteModel['chord'] = presses === 1 ? { active: true, progress: 'power', until: after(now, CHORD_WINDOW) }
    : presses === 2 && state.chord.active && state.chord.progress === 'power'
      ? { active: true, progress: 'power power', until: after(now, CHORD_WINDOW) }
      : { active: false };
  return { chord, power: { presses, until: after(now, POWER_COMBO_WINDOW), anyOn }, presetButton: undefined };
}

/** The chord's presses so far (today's `chord_step` -1, 1, 2, 3, 4). */
export type ChordProgress = 'power' | 'power power' | 'power power left' | 'power power left right' | 'power power left right left';

/** What a press does during a chord: the step it expects, and where the chord is after it. */
type ChordStep = { expects: 'left' | 'right'; then: ChordProgress | 'complete' };

/** The preset buttons, warmest last: each stands for one colour temperature (today's `presets` table in gestures.ts). */
export type PresetButton = 'coolest' | 'cool' | 'neutral' | 'warm' | 'warmest';

/** A button pressed on a remote, before the gestures turn it into a command. */
export type RemoteButton =
  | { kind: 'arrow'; direction: 'left' | 'right' | 'up' | 'down' }
  /** Ends a chord in progress. */
  | { kind: 'cancel' }
  | { kind: 'power' }
  /** A preset button; undefined when the press named a temperature not in the table, which only ends a chord. */
  | { kind: 'preset'; button: PresetButton | undefined };

/** What a press through the gestures gives: the gesture state after it, and the command it is, if any. */
export type Gestured = { state: RemoteModel; command: Extract<RemoteCommand, 'mode' | 'up' | 'down' | 'left' | 'right'> | undefined };

/**
 * What a burst of power presses does when its window closes: one press
 * toggles the room's power, against what the room reported at the burst's last
 * press (`anyOn`); three reset the room.
 */
export type BurstClosed = { kind: 'toggle'; anyOn: boolean } | { kind: 'reset' };

/**
 * A command a remote's presses send for its room: brighter (`up`) or dimmer
 * (`down`), the presets to the left or right, the power toggle, the room's
 * reset, and the mode overlay's toggle (the old scripts' mode toggle). A press that
 * is no command never reaches the domain: the adapter drops it.
 */
export type RemoteCommand = 'up' | 'down' | 'left' | 'right' | 'toggle' | 'reset' | 'mode';

/**
 * A command a remote's gestures (or another caller) send for its room.
 * `anyOn` is whether anything the room's power toggle switches (its lamps,
 * and its switches with a range rule) reports on at the press: what Home
 * Assistant says, read by the adapter, which the toggle goes against when the
 * room has no saved power (today's `targets.some(id => view.get(id) === 'on')`).
 */
export type RemotePressed = { kind: 'remotePressed'; remote: RemoteId; command: RemoteCommand; anyOn: boolean; at: Instant };

/** A raw button press; `at` starts the chord and power-burst windows. `anyOn` as for `RemotePressed`. */
export type RemoteButtonPressed = { kind: 'remoteButtonPressed'; remote: RemoteId; button: RemoteButton; anyOn: boolean; at: Instant };

export type RemoteOverlay = {
  /** The key: one overlay per remote. */
  remote: RemoteId;
  /** Stored `target`. */
  room: RoomId;
  /** Stored `when`. */
  since: Instant;
  /** Stored `step_range`; default -20..20. */
  stepRange: StepRange;
  /** Brighter and dimmer; none before the first such press. */
  adjustment: RemoteAdjustment | undefined;
  /** What the left and right arrows chose. */
  preset: RemotePreset;
  /** What each preset held when the remote last left it (stored `preset_contexts`), restored on return. */
  remembered: Partial<Record<PresetChoice, RememberedPreset>>;
};

/** The remote overlays on a room: none for a lamp in no room. */
export function remotesOn(remotes: readonly RemoteOverlay[], room: RoomId | undefined): RemoteOverlay[] {
  return room === undefined ? [] : remotes.filter(remote => remote.room === room);
}

/**
 * The newest of a room's remote overlays: only it applies. A tie goes to the
 * remote whose id sorts last (today's key order sorts by the source the
 * overlay is saved under; amendment 6.4 keys it by the remote).
 */
export function newestRemote(remotes: readonly RemoteOverlay[]): RemoteOverlay | undefined {
  let newest: RemoteOverlay | undefined;
  for (const remote of remotes) {
    if (newest === undefined || remote.since > newest.since
      || (remote.since === newest.since && remote.remote.toLowerCase() >= newest.remote.toLowerCase())) newest = remote;
  }
  return newest;
}

/**
 * The block held over a room: its block overlay against its newest remote's
 * preset, the newer winning and the preset winning a tie. A preset is read
 * only from a remote overlay the reset has not released. For a room's own
 * light a released block overlay is passed over; for a lamp it stays in the
 * running, and its caller releases it outside a fade (today's two loops).
 */
export function heldBlock(overlay: BlockOverlay | undefined, remote: RemoteOverlay | undefined, released: (since: Instant) => boolean,
  forLamp: boolean, fading: boolean): { block: Block; setAt: Instant } | undefined {
  let chosen: { block: Block; stamp: Instant; setAt: Instant } | undefined = overlay === undefined || (!forLamp && released(overlay.since))
    ? undefined : { block: overlay.block, stamp: overlay.since, setAt: overlay.since };
  const preset = remote === undefined || released(remote.since) ? undefined : presetBlock(remote);
  if (remote !== undefined && preset !== undefined && (chosen === undefined || preset.stamp >= chosen.stamp)) {
    chosen = { block: preset.block, stamp: preset.stamp, setAt: remote.since };
  }
  return chosen === undefined || (forLamp && !fading && released(chosen.setAt)) ? undefined : { block: chosen.block, setAt: chosen.setAt };
}

/** The block a remote's preset holds: day or cosy, or the block the candle kept from the preset it left; stamped when it was chosen. */
function presetBlock(remote: RemoteOverlay): { block: Block; stamp: Instant } | undefined {
  const preset = remote.preset;
  if (preset.choice === 'day' || preset.choice === 'cosy') return { block: preset.choice, stamp: preset.since };
  if (preset.choice === 'candle' && preset.block !== undefined) return { block: preset.block.block, stamp: preset.block.since };
  return undefined;
}

/**
 * An overlay over the remote's room set after `since`, which restarts its
 * steps (today's restart check): a person's or a control's brightness or
 * effect over the whole room, or another remote's brighter and dimmer
 * presses in it. An overlay on one lamp does not restart them, nor does a
 * held block. Every overlay is read, the ones the next-block reset released
 * too, as today's check reads every stored record.
 */
function newerOnRoom(overlays: { remotes: readonly RemoteOverlay[]; lamps: readonly LampOverlay[] }, remote: RemoteId, room: RoomId,
  since: Instant): boolean {
  const { lamps, remotes } = overlays;
  return lamps.some(overlay => overlay.kind === 'parts' && overlay.over.kind === 'room' && overlay.over.room === room
      && [overlay.brightness, overlay.effect].some(part => part !== undefined && part.at > since))
    || remotes.some(other => other.remote !== remote && other.room === room && other.adjustment !== undefined && other.adjustment.at > since);
}

/** The remote's overlay saved: it replaces the one it had, for whichever room. */
function overlaySaved(remotes: readonly RemoteOverlay[], overlay: RemoteOverlay): RemoteOverlay[] {
  return [...remotes.filter(other => other.remote !== overlay.remote), overlay];
}

/**
 * What a remote's brighter, dimmer, left and right read of its room at the
 * press: the room, the newest remote overlay on it (`carried`) and the block
 * held over it, after the next-block reset (the lighting state works both
 * out), and the block its schedule is in.
 */
export type RoomAtPress = { room: RoomId; carried: RemoteOverlay | undefined; held: Block | undefined; scheduled: Block };

/** A remote overlay's part of the light, with the instant it was set: the candle its preset chose, or its steps on the blend. */
export type RemotePart = { kind: 'effect'; part: EffectOverlay } | { kind: 'step'; step: RemoteAdjustment; range: StepRange };

/** `min` not above `max`. */
export type StepRange = { readonly min: Step; readonly max: Step };

function stepWithin(value: number, range: StepRange): Step {
  return stepOrThrow(Math.max(range.min, Math.min(range.max, value)));
}

export type RemoteAdjustment = {
  /** Net presses; positive is brighter. */
  steps: StepCount;
  /** How far the presses may still go each way. */
  lower: Step;
  upper: Step;
  /** Where on the blend step zero sits (stored `anchor`). */
  from: 'day' | 'cosy' | 'current';
  /** Stored `updated`: orders it against other overlays. */
  at: Instant;
  lastPress: 'up' | 'down' | undefined;
  /** Stored `has_up`: the dim-below-cosy rule reads it. */
  everBrighter: boolean;
};

function sameSteps(a: RemoteAdjustment, b: RemoteAdjustment): boolean {
  return a.steps === b.steps && a.lower === b.lower && a.upper === b.upper && a.from === b.from && a.at === b.at
    && a.lastPress === b.lastPress && a.everBrighter === b.everBrighter;
}

/** The two ends of a lamp's or a room's blend: its light in the day and the cosy block. */
export type BlendEnds = { day: SceneLight | undefined; cosy: SceneLight | undefined };

/** A remote step's place on the blend, and the level it was placed from (the dim-below-cosy rule reads it). */
export type Placed = { position: BlendPosition; from: Brightness };

/** The light a remote step gives: off, or lit at a level and colour; `decidesLit` where one end of the blend is off. */
export type SteppedLight =
  | { power: 'off'; decidesLit: boolean }
  | { power: 'on'; brightness: Brightness; colour: Colour | undefined; decidesLit: boolean };

export type PresetChoice = 'day' | 'cosy' | 'candle';

/** The preset a block stands for; night is none of them. */
function presetOfBlock(block: Block): PresetChoice | undefined {
  return block === 'night' ? undefined : block;
}

export type RemotePreset =
  | { choice: 'none' }
  /** Day or cosy: holds that block for the room, like a block overlay (stored `period`, `period_updated`). */
  | { choice: 'day' | 'cosy'; since: Instant }
  /**
   * The candle on the room's lamps; `adjustment` is the brightness input it
   * started from (stored `selection_input`), `since` is stored `selection_updated`.
   * `block` is the day or cosy block the remote held when it moved onto the
   * candle, which it keeps holding (stored `period`, `period_updated`); none
   * when it came from no preset.
   */
  | { choice: 'candle'; since: Instant; adjustment: RemoteAdjustment | undefined; block: HeldBlock | undefined };

/** A block a remote preset holds for the room, and since when (stored `period`, `period_updated`). */
export type HeldBlock = { block: 'day' | 'cosy'; since: Instant };

export type RememberedPreset = Exclude<RemotePreset, { choice: 'none' }>;

/**
 * One remote's chord and burst, closed where their window has by `now`: the
 * gesture state after (the one given, where nothing closed) and what a closed
 * burst does to the remote's room. A press closes its own remote's first; the
 * clock closes every remote's.
 */
export function windowsClosed(state: RemoteModel, now: Instant): { state: RemoteModel; burst: BurstClosed | undefined } {
  const chord: RemoteModel['chord'] = state.chord.active && now >= state.chord.until ? { active: false } : state.chord;
  const power = state.power;
  if (power.presses === 0 || now < power.until) return { state: chord === state.chord ? state : { ...state, chord }, burst: undefined };
  // One press or three end the chord; two leave it waiting for its next step.
  const closed: RemoteModel = { ...state, power: { presses: 0 }, chord: power.presses === 2 ? chord : { active: false } };
  const burst: BurstClosed | undefined = power.presses === 1 ? { kind: 'toggle', anyOn: power.anyOn }
    : power.presses === 3 ? { kind: 'reset' } : undefined;
  return { state: closed, burst };
}

/**
 * A button through the gestures: the gesture state after the press (the one
 * given, where the press leaves it as it was) and the command it gives, if any.
 */
export function buttonPressed(state: RemoteModel, button: RemoteButton, anyOn: boolean, now: Instant): Gestured {
  switch (button.kind) {
    case 'power': return { state: powerPressed(state, anyOn, now), command: undefined };
    case 'preset': return presetButtonPressed(state, button.button, now);
    case 'arrow': case 'cancel': return chordOrCommand(state, button, now);
  }
}

/**
 * A preset button: one outside the table only ends a chord; the button the
 * dial is already at does nothing; any other turns the dial, right for the
 * next button and left for the one before. A jump further, or the first
 * button after a power press other than the coolest (right) or the warmest
 * (left), turns it nowhere and only ends a chord.
 */
function presetButtonPressed(state: RemoteModel, button: PresetButton | undefined, now: Instant): Gestured {
  if (button === undefined) return chordOrCommand(state, { kind: 'cancel' }, now);
  const previous = state.presetButton;
  if (previous === button) return { state, command: undefined };
  return chordOrCommand({ ...state, presetButton: button }, dialTurn(previous, button), now);
}

/**
 * A press the chord may be waiting for: the step it expects moves the chord
 * on (its last step is the mode toggle); any other press ends the chord and
 * is the command it names, the cancel button none.
 */
function chordOrCommand(state: RemoteModel, button: Extract<RemoteButton, { kind: 'arrow' | 'cancel' }>, now: Instant): Gestured {
  const chord = state.chord;
  const step = chord.active ? CHORD_STEPS[chord.progress] : undefined;
  if (step !== undefined && button.kind === 'arrow' && button.direction === step.expects) {
    if (step.then !== 'complete') {
      return { state: { ...state, chord: { active: true, progress: step.then, until: after(now, CHORD_WINDOW) } }, command: undefined };
    }
    return { state: { ...state, chord: { active: false } }, command: 'mode' };
  }
  const ended: RemoteModel = chord.active ? { ...state, chord: { active: false } } : state;
  return { state: ended, command: button.kind === 'cancel' ? undefined : button.direction };
}

function after(now: Instant, window: Seconds): Instant {
  return instantOrThrow(now + window);
}

/**
 * Where the dial turned, as the arrow it stands for; nowhere is the cancel
 * button's press. No previous button is "after a power press" (today's cursor
 * -1). A named difference from today: a cursor saved unreadable (today's
 * fallback -2, or a fraction) also reads as no button, so it recovers to
 * "after a power press", where today's `float(-2)` turned nowhere for every
 * button.
 */
function dialTurn(previous: PresetButton | undefined, button: PresetButton): Extract<RemoteButton, { kind: 'arrow' | 'cancel' }> {
  const count = PRESET_BUTTONS.length;
  const turn = previous === undefined ? (button === 'coolest' ? 1 : button === 'warmest' ? count - 1 : 0)
    : (PRESET_BUTTONS.indexOf(button) - PRESET_BUTTONS.indexOf(previous) + count) % count;
  return turn === 1 ? { kind: 'arrow', direction: 'right' } : turn === count - 1 ? { kind: 'arrow', direction: 'left' } : { kind: 'cancel' };
}

/**
 * Brighter, dimmer, left or right: the remote's overlay saved for its room
 * (`overlaySaved`), as `stepped` or `presetTurned` make it. The lamp overlays
 * are read, not changed: a newer one over the room restarts the steps.
 */
export function remoteSteered(overlays: { remotes: readonly RemoteOverlay[]; lamps: readonly LampOverlay[] }, at: RoomAtPress,
  remote: RemoteId, press: 'up' | 'down' | 'left' | 'right', now: Instant): RemoteOverlay[] {
  return press === 'up' || press === 'down' ? stepped(overlays, at, remote, press, now) : presetTurned(overlays.remotes, at, remote, press, now);
}

/** A remote overlay's step range until one is saved: today's `{'min':-20,'max':20}`. */
export const DEFAULT_STEP_RANGE: StepRange = { min: stepOrThrow(STEP_BOUNDS.low), max: stepOrThrow(STEP_BOUNDS.high) };

/**
 * Brighter (`up`) or dimmer (`down`): one step from where the room's carried
 * overlay left them, both bounds moving with it inside the step range, the
 * count back to zero where the bounds meet. A newer overlay on the room
 * restarts the steps from zero. The preset and what each preset held carry over.
 */
function stepped(overlays: { remotes: readonly RemoteOverlay[]; lamps: readonly LampOverlay[] }, at: RoomAtPress, remote: RemoteId,
  press: 'up' | 'down', now: Instant): RemoteOverlay[] {
  const carried = at.carried;
  const range = carried === undefined ? DEFAULT_STEP_RANGE : carried.stepRange;
  const start = startingSteps(carried, range);
  const kept = withinRange(newerOnRoom(overlays, remote, at.room, start.at) ? noSteps(range, now) : start, range);
  const delta = press === 'up' ? 1 : -1;
  const lower = stepWithin(kept.lower + delta, range), upper = stepWithin(kept.upper + delta, range);
  const adjustment: RemoteAdjustment = {
    steps: lower === upper ? stepCountOrThrow(0) : countWithin(kept.steps + delta),
    lower, upper, from: kept.from, at: now, lastPress: press, everBrighter: kept.everBrighter || press === 'up',
  };
  const preset: RemotePreset = carried === undefined ? { choice: 'none' } : carried.preset;
  const remembered = carried === undefined ? {} : carried.remembered;
  return overlaySaved(overlays.remotes, { remote, room: at.room, since: now, stepRange: range, adjustment, preset, remembered });
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

/**
 * A count held inside -40..40. Presses alone never reach an end (the bounds
 * meet first); only a saved count already at one does, which today's store
 * would then refuse on its next read.
 */
function countWithin(value: number): StepCount {
  return stepCountOrThrow(Math.max(-2 * STEP_BOUNDS.high, Math.min(2 * STEP_BOUNDS.high, value)));
}

/**
 * Left or right: the next preset that way from the one the room's carried
 * overlay holds, or, with none, from the block the room is in (night starts
 * where day does). The preset left is remembered and a remembered one comes
 * back as it was; one not remembered starts now, the candle at the steps it
 * starts from and holding the day or cosy block the remote held. The steps
 * stay, kept inside the step range.
 */
function presetTurned(remotes: readonly RemoteOverlay[], at: RoomAtPress, remote: RemoteId, press: 'left' | 'right', now: Instant): RemoteOverlay[] {
  const carried = at.carried;
  const range = carried === undefined ? DEFAULT_STEP_RANGE : carried.stepRange;
  const adjustment = withinRange(startingSteps(carried, range), range);
  const preset: RemotePreset = carried === undefined ? { choice: 'none' } : carried.preset;
  const current = preset.choice !== 'none' ? preset.choice : presetOfBlock(at.held !== undefined ? at.held : at.scheduled);
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
  return overlaySaved(remotes, { remote, room: at.room, since: now, stepRange: range, adjustment, preset: chosen, remembered });
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
 * A remote overlay's parts: on the candle, the steps it started from and the
 * candle itself; then its steps, unless they are the ones the candle started
 * from (today's `inputClaims`).
 */
export function remoteParts(remote: RemoteOverlay): RemotePart[] {
  const preset = remote.preset, range = remote.stepRange;
  const parts: RemotePart[] = [];
  const startedFrom = preset.choice === 'candle' ? preset.adjustment : undefined;
  if (preset.choice === 'candle') {
    if (startedFrom !== undefined) parts.push({ kind: 'step', step: startedFrom, range });
    parts.push({ kind: 'effect', part: { kind: 'candle', at: preset.since } });
  }
  const adjustment = remote.adjustment;
  if (adjustment !== undefined && (startedFrom === undefined || !sameSteps(adjustment, startedFrom))) {
    parts.push({ kind: 'step', step: adjustment, range });
  }
  return parts;
}

/**
 * Where a remote step starts on the cosy (0) to day (1) blend, moved from
 * today's `normalPosition`. An off end reads as {@link OFF_END_LEVEL}. Not
 * placed: a missing end, two off ends, a lit end with no colour, or bounds
 * that run backwards.
 */
export function placeOnBlend(step: RemoteAdjustment, range: StepRange, ends: BlendEnds, level: Brightness | undefined): Placed | undefined {
  const { day, cosy } = ends;
  if (day === undefined || cosy === undefined || (day.power === 'off' && cosy.power === 'off')) return undefined;
  if ((day.power === 'on' && day.colour === undefined) || (cosy.power === 'on' && cosy.colour === undefined)) return undefined;
  if (step.lower > step.upper) return undefined;
  const at = levelOrOffEnd(level), dayLevel = endLevel(day), cosyLevel = endLevel(cosy);
  const span = dayLevel - cosyLevel, floor = Math.min(76.5, cosyLevel), slope = Math.max(0, span, (cosyLevel - floor) / 2);
  const seed = step.from === 'day' ? 1
    : step.from === 'cosy' ? 0
      : day.power === 'off' ? (at < cosyLevel && cosyLevel > OFF_END_LEVEL ? (cosyLevel - at) / (cosyLevel - OFF_END_LEVEL) : 0)
        : at > dayLevel && dayLevel < 255 ? 1 + (at - dayLevel) / (255 - dayLevel)
          : at < cosyLevel && slope > 0 ? Math.max(-2, (at - cosyLevel) / slope)
            : span > 0 ? (at - cosyLevel) / span : 1;
  const lower = clamp(step.lower, range.min, range.max), upper = clamp(step.upper, range.min, range.max);
  return { position: blendPositionOrThrow(clamp(clamp(seed * 10 + step.steps, lower, upper) / 10, -2, 2)), from: at };
}

/** A level for placing a position: a light that shows none (an off lamp) reads as {@link OFF_END_LEVEL}. */
function levelOrOffEnd(level: Brightness | undefined): Brightness {
  return level === undefined ? OFF_END_LEVEL : level;
}

/** An end's level for placing a position: an off end reads as {@link OFF_END_LEVEL}. */
function endLevel(end: SceneLight): Brightness {
  return end.power === 'on' ? end.brightness : OFF_END_LEVEL;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * What a remote step gives a lamp or a room: the light at the step's place on
 * its blend, lit or off. Beside an off end the blend decides whether the lamp
 * is lit (`decidesLit`). Dimming from below the cosy level with no brighter
 * press yet never brightens the lamp: `level` is the level it shows before the
 * step. Undefined: the step does nothing, as where it was not placed or the
 * blend has no light to give.
 */
export function steppedLight(step: RemoteAdjustment, placed: Placed | undefined, ends: BlendEnds, warmEnd: RGB,
  level: Brightness | undefined): SteppedLight | undefined {
  const { day, cosy } = ends;
  if (placed === undefined || day === undefined || cosy === undefined) return undefined;
  const sample = blend(day, cosy, placed.position, warmEnd);
  if (sample === undefined) return undefined;
  const decidesLit = !(day.power === 'on' && cosy.power === 'on');
  if (sample.power === 'off') return { power: 'off', decidesLit };
  const dims = step.lastPress === 'down' && !step.everBrighter && placed.from < Math.min(76.5, endLevel(cosy)) && step.from === 'current'
    && step.steps <= 0;
  const brightness = dims ? brightnessOrThrow(Math.min(levelOrOffEnd(level), sample.brightness)) : sample.brightness;
  return { power: 'on', brightness, colour: sample.colour, decidesLit };
}

/** A chord step's window: today's chord timer, `00:00:03`. */
export const CHORD_WINDOW: Seconds = secondsOrThrow(3);

/** A burst of power presses closes this long after its last press: today's quiet script's 600 ms. */
export const POWER_COMBO_WINDOW: Seconds = secondsOrThrow(0.6);

/** A remote nobody has pressed: no chord, no power burst, no preset button. */
export const IDLE_REMOTE: RemoteModel = { chord: { active: false }, power: { presses: 0 }, presetButton: undefined };

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

/** The chord after each of its steps so far. After the first power press it waits for the second, which only power gives. */
const CHORD_STEPS: Readonly<Record<ChordProgress, ChordStep | undefined>> = {
  'power': undefined,
  'power power': { expects: 'left', then: 'power power left' },
  'power power left': { expects: 'right', then: 'power power left right' },
  'power power left right': { expects: 'left', then: 'power power left right left' },
  'power power left right left': { expects: 'right', then: 'complete' },
};
