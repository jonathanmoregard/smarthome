---
date: 2026-11-22
kind: plan
milestone: M2-M6
status: ready
spec: docs/superpowers/specs/2026-11-22-lighting-architecture-design.md
follows: docs/superpowers/plans/2026-11-22-m1-domain-types.md
pr: https://github.com/jonathanmoregard/smarthome/pull/39
scope: lighting-scripts/
---
# M2 to M6: Lighting Redesign Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The lighting port runs on the owner's architecture: a pure domain (`lightingState`, `update`), an adapter that reads Home Assistant (HA), writes state back and reconciles the bulbs, and a minimal host. The legacy script-shaped code is gone and the branch is ready for the owner's review.

**Architecture:** Each milestone swaps one part of the running port for its new counterpart and is gated by the flow gate, so the system works end to end after every task. M2 computes the lighting state from the `Model` and sends it with a first reconciler. M3 replaces the legacy state writers with `update`. M4 completes the reconciler. M5 deletes the legacy code and cuts the host down. M6 fits the room-by-room rollout back on and closes out. Today's algorithms are moved and re-typed, never rewritten from an idea of what they should do.

**Tech Stack:** TypeScript 5.9 on Node 22 (`--experimental-strip-types`), `node:test`, the guards in `npm run check`, the flow gate (`npm run e2e`, Python, inside `nix develop`).

**Spec:** `docs/superpowers/specs/2026-11-22-lighting-architecture-design.md`. The M1 plan's "Decisions since the spec" (1 to 7) and its section "The overlay flow the types must carry" apply here unchanged; workers read both files.

## Global Constraints

1. Everything in the M1 plan's Global Constraints 1 to 14 applies (public repo, vocabulary, typing, parse-don't-validate, recover-not-raise, reading order, constructors, commits, briefs).
2. **Acceptance is the user flow.** Every task ends with `npm run check`, `npm test` and the flow gate at `flow differences 0` (`npm run e2e`, detached with `systemd-run --user` and `~/.claude/scripts/wait-for`, log in `/tmp/v1work/`). Exact levels, fade shapes and the candle's level are not criteria: they land in the gate's `noted` counts, which go in the ledger and never block. No task spends effort closing a `noted` difference.
3. A task that cannot reach `flow differences 0` stops and reports each flow difference (scenario, step, rule). It never loosens a rule in `tests/e2e/compare.py`, re-records a scenario, or edits a scenario to pass.
4. **Move and re-type.** Each task names the legacy functions it moves. The worker moves the logic line for line onto the new types and deletes only what the new types make impossible (a parse, a default, a null check). A behaviour question the legacy code answers is answered the same way. The five approved divergences stay: a press on a plug's own button is an overlay on that switch (M1 plan, decision 8); re-selecting a running effect keeps it running; a bulb coming back on fades in (0.4 s before an effect start, 0.2 s otherwise); scheduled fades are gradual in both directions; off has no colour.
5. The domain (`src/domain/`) has no HA entity names, no JSON, no MQTT, no clock reads and no sends. It imports only from `src/domain/`. The adapter (`src/adapter/`) never decides what a lamp should show.
6. The harness bridge keeps its wire: `src/rpc.ts` takes `{script, args, snapshot}` and answers the calls made. `tests/parity/adapters.py`, `tests/parity/rpc.py` and the recordings are not edited by this plan.
7. The old per-script parity suite is not a gate and is never run. Its cases break as follows, and that is accepted: M2 Task 3 breaks every case that asserts on commands, plans, dispatch or the runtime sensor; M3 Task 3 breaks the commit, remote and lamp-change cases; M5 Task 1 deletes the suite.
8. Legacy unit tests in `tests/runtime/` are deleted with the legacy code they test, in the task that deletes it. Before deleting one, the worker carries over any case that states user flow (a press, a hold, a reset, a block start, a wake light) as a test on `lightingState` or `update`; cases about bytes, key order, guards, revisions or Jinja coercions are dropped. The commit message counts both.
9. Between M2 and M6 the branch cannot share a house with the old scripts (it stops writing their bookkeeping). Nothing is live, so that is accepted; M6 Task 1 restores sharing.
10. No live cutover, no change to the owner's HA, no bulb is sent anything outside the test harness. M6 ends with the branch ready for the owner's review.

## Review Focus

1. **A restart in the middle of things.** HA restarts, or the port's process restarts, during a fade, with overlays held and a candle running: the lamps end where they were heading and nothing flashes. Golden `ha_restart_mid_fade`; test in M4 Task 1 (`a restart re-sends nothing a bulb already shows`).
2. **A bulb switched off at the wall and back on.** It gets its lamp's current light, not the one from when it lost power, with the short fade, and its candle again. Golden `wall_power_cycle`; test in M4 Task 1.
3. **Two inputs at once.** A remote press arriving while a block fade is ticking, or a person's change during a reset: both take effect, in arrival order, and no overlay is lost. Test in M3 Task 3 (`inputs are applied one at a time in arrival order`).
4. **A room with nothing configured.** A lamp in no room, a room with no own timing, a remote with no room, a switch with no range rule: house schedule, house schedule, nothing happens, block on/off setting. Tests in M2 Task 1 and M3 Task 2.
5. **HA says something we did not ask for.** A helper in `unknown` at start, a state change for an entity not in the config, an event with fields missing: decoded to defaults or ignored, never raised, and the loop keeps running. Test in M3 Task 3 (`an input that cannot be read is logged and dropped`).

## File map (end state)

| # | File | Holds |
|---|---|---|
| 1 | `src/domain/schedule.ts` | where each room is in its blocks at an instant, the wake light, the scheduled light and its transition |
| 2 | `src/domain/blend.ts` | the blend between a room's cosy and day light, and the ramp up from off |
| 3 | `src/domain/lighting-state.ts` | `lightingState`, `nextChange`: the schedule with every overlay over it |
| 4 | `src/domain/switches.ts` | whether each switch is on: range rules, block on/off settings, its own button |
| 5 | `src/domain/overlays.ts` | the overlay types (M1) and their transitions: hold, clear, reset |
| 6 | `src/domain/remote.ts` | a remote's presses: steps, presets, power, reset, chords |
| 7 | `src/domain/lamp-overlays.ts` | a person's change and a dashboard control, as lamp overlays |
| 8 | `src/domain/update.ts` | `update(model, msg)`: one case per message, each calling its concept's module |
| 9 | `src/domain/dashboard.ts` | what the dashboard shows of the model |
| 10 | `src/adapter/codecs/` | sensors, helpers and stores ↔ `Model` (M1) |
| 11 | `src/adapter/inputs.ts` | HA triggers → `Msg`s |
| 12 | `src/adapter/reconcile.ts`, `observed.ts` | observed bulbs and switches, beliefs, `nextSends`, `afterSend` |
| 13 | `src/adapter/encode.ts`, `bulb-groups.ts` | a send as Zigbee2MQTT publishes; group sends |
| 14 | `src/adapter/loop.ts` | `handleInput`: one turn of the loop |
| 15 | `src/host.ts`, `src/main.ts`, `src/rpc.ts` | sockets, timers, the journal file; the harness bridge |

---

## M2: `lightingState`

### M2 Task 1: The schedule

Worker: `worker-hard`. Review: one Sonnet pass.

**Files:**
- Create: `src/domain/schedule.ts`, `src/domain/blend.ts`
- Test: `tests/runtime/schedule.test.ts`, `tests/runtime/blend.test.ts`

**Interfaces:**
- Consumes: M1 `Config`, `Room`, `BlockTiming`, `SceneLight`, `WakeLight`, `Instant`, `Timezone`, `Progress`, `Block`.
- Produces:
  ```ts
  // schedule.ts
  /** Where a room (or the house) is in its blocks at an instant. Today's ScheduleDetails. */
  export type BlockPosition = {
    current: Block; currentSince: Instant;
    fade: { into: Block; progress: Progress } | undefined;   // inside the fade before the next block's start
    lastFadeStart: Instant;                                   // what the next-block reset measures against
    nextFadeStart: Instant | undefined;
    nextStart: Instant | undefined;
    justStarted: boolean;                                     // within 90 s of the current block's start
  };
  export function blockPosition(config: Config, room: RoomId | undefined, now: Instant): BlockPosition;
  /** The light a lamp moves between and how far it has got: a held block, a fade, or the wake light. */
  export type Stage = { from: StageEnd; into: StageEnd; progress: Progress; moving: boolean };
  export type StageEnd = { kind: 'block'; block: Block } | { kind: 'held light' };   // 'held light': fading out of an overlay
  export function wakeStage(room: Room, position: BlockPosition, now: Instant, zone: Timezone): Stage | undefined;
  export function sceneBetween(from: SceneLight, into: SceneLight, progress: Progress): SceneLight;
  export function blockLight(config: Config, room: RoomId | undefined, block: Block): SceneLight | undefined;

  // blend.ts
  export type BlendEnd = SceneLight;
  /** The light at a position on the cosy-day blend, 0 at cosy, 1 at day, beyond both within -2..2. */
  export function blend(day: BlendEnd, cosy: BlendEnd, position: BlendPosition, warmEnd: RGB): SceneLight | undefined;
  export function mixColour(a: Colour, b: Colour, amount: Progress): Colour;
  ```
- Moved from: `scheduleDetails`, `localParts`, `localTime`, `nextMidnight`, `initialStage`, `wakeStage`, `interpolate`, `scopeFor` in `src/legacy/domain/schedule.ts`; `blend`, `scaleValue`, `mixColor`, `rgbValue`, `ramp`, `roundEven`, `clamp`, `OFF_END_LEVEL`, `WARM_END`, `CROSSOVER` in `src/legacy/domain/scale.ts`; `compileGradient` and `sampleGradient` in `src/legacy/domain/gradient.ts` fold into `blend` as its computation (no cache, no signature).
- The constants keep their values: fade default 20 min, wake fade default 37.5 min, the completed-wake hold (within 24 h, wake hour 4 to 10, until a fade into another block), weekend days as `scheduleDetails` picks them, the 90 s `justStarted` window.

- [ ] **Step 1: Write failing tests.** Carry the flow cases of `off-on-fade.test.ts`, `off-lamp-schedule.test.ts`, `off-lamp-blend.test.ts`, `r4-schedule-jinja.test.ts` and `r4-schedule-saved.test.ts` onto the new functions, plus: `a block starts at its weekday time on a weekday and its weekend time at the weekend`; `the fade begins its minutes before the start`; `a block with no start never starts`; `a room without its own timing follows the house` and `a lamp in no room follows the house` (Review Focus 4); `the wake light fades night into day from the wake time`; `after the wake fade the room holds day until the day block`; `a wake time outside the night block does nothing`; `a fade from an off block ramps up in the lit end's colour`; `spring and autumn clock changes keep block starts at local time`; `a blend with an off end takes its colour from the lit end`; `a blend of two off ends is nothing`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Move and re-type.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(domain): the schedule and the blend on the new types`.

### M2 Task 2: Overlays over the schedule: `lightingState`

The heart of the flow. Worker: `worker-hard`. Review: one Opus pass against the M1 plan's flow section, items 1 to 7.

**Files:**
- Create: `src/domain/lighting-state.ts`, `src/domain/switches.ts`
- Test: `tests/runtime/lighting-state-flow.test.ts`, `tests/runtime/switches.test.ts`

**Interfaces:**
- Consumes: M2 Task 1; M1 `Model`, every overlay type, `effectNamed`, `LightingState`, `LampLight`, `Transition`.
- Produces:
  ```ts
  // lighting-state.ts
  export function lightingState(model: Model, now: Instant): LightingState;
  /** The next instant the lighting state changes by itself: a fade start, a fade's next minute, a block start, a wake time, a reset falling due. */
  export function nextChange(model: Model, now: Instant): Instant | undefined;
  /** The overlays that apply to a lamp at an instant, after the next-block reset. One function, used by lightingState and by M3's remote. */
  export function overlaysOn(model: Model, lamp: LampId, now: Instant): AppliedOverlays;
  export const MODE_COLOUR: Colour;   // today's 255, 105, 180

  // switches.ts
  /** A switch overlay that still applies wins over the range rule and the block's on/off setting. */
  export function switchPower(model: Model, lamps: LightingState['lamps'], now: Instant): Record<SwitchId, Power>;
  ```
- Moved from: `scheduledBase` in `src/legacy/domain/schedule.ts` (the chosen block: block overlay against preset, newest wins; the next-block reset's ignored overlays and the fade-out stage; lamp profile against room light; the on/off setting for switches); `resolveEffects`, `latestStream`, `normalPosition`, `lightPatch` and the candle rule in `src/legacy/domain/resolution.ts` (per lamp, brightness and colour separately, overlays ordered by when each part was set; the remote's steps on the blend, including the dim-below-cosy rule; the mode overlay; room power); `switchPlan` in `src/legacy/domain/controller.ts` and `isRangeDefault`.
- Rules that replace legacy plumbing, each a line in the function's doc comment:
  1. A lamp's `transition` is `scheduled fade` over 60 s while its stage is moving, else `manual`. (Amended 2026-11-22: `effect start` is dropped from `Transition`; `lightingState` cannot know what the bulb was already showing. The reconciler picks the 0.4 s fade from its own record when it starts the candle.) (Legacy: 60 on a tick while moving, 0.4 with an effect, 0.2 manual, 3 otherwise; the 3 s case becomes `manual`.)
  2. A lit `SceneLight` with no colour gives the lamp the schedule's colour of the block it is in; if that has none either, the lamp keeps its last block's colour. The worker reports how often this fires on the synthetic house; if `OnLight.colour` cannot be filled honestly, stop and report (M1 left this to M2).
  3. The candle shows on a lamp only where `effectNamed('Candle').canRunOn` some bulb; per-bulb fallback stays in `bulbAppearance`.
  4. The remote's position on the blend is computed each time, not cached.
  5. Old stored shapes (M1 Task 5's left-out list, item 4) take no part.
- `nextChange` during a fade is the next whole minute; that is what makes a fade a series of one-minute moves, as today.

- [ ] **Step 1: Write failing tests** in `lighting-state-flow.test.ts`, on M1's `syntheticHouse()` with one thing changed per test. One test per flow item of the M1 plan and per gap in its list:
  - schedule: `a lamp shows its room's block light`; `during a fade it is between the two`; `a lamp with its own profile shows that`;
  - block overlay: `a block held over a room replaces its scheduled block`; `over the house it reaches every room but not as a room's own`; `a remote's day preset holds day like a block overlay, and the newer of the two wins`;
  - lamp overlays: `a person's fixed brightness holds across a block start while colour follows the schedule`; `a dashboard control's candle shows the candle on that lamp only`; `the newer of two overlays on a lamp wins per part`; `a part handed back to the schedule shows the schedule over older overlays`; `a room overlay reaches every lamp in the room`;
  - remote: `brighter moves every lamp in the room up the blend, dimmer down`; `only the newest remote's overlay in a room applies`; `steps beyond day and below cosy stay inside the step range`;
  - mode overlay: `colours every lamp outside private rooms`; `does nothing in the night block`;
  - room power: `a room switched off is off whatever its overlays say`;
  - resets: `with the next-block rule on, an overlay set before the last fade start no longer applies`; `during that fade the lamp fades out of the held light`; `with the rule off it holds`;
  - wake light: `a room's lamps follow the wake fade before the day block`;
  - candle: `a candle lamp with no candle bulb shows its normal light`;
  - `nextChange`: `is the next fade minute during a fade, else the next fade start, wake time or reset`.
  In `switches.test.ts`: the cases of `r4-switch-plan.test.ts` and `ranges.test.ts`, plus `a switch with no rule follows its block's on/off setting` (Review Focus 4); `a switch overlay holds the switch against its range rule`; `with the next-block rule on, a switch overlay set before the last fade start no longer applies`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Move and re-type.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(domain): lightingState, the schedule with every overlay over it`.

### M2 Task 3: Send the lighting state

The output path is swapped: from here the bulbs get what `lightingState` says. Worker: `worker-hard`. Review: one Opus pass.

**Files:**
- Create: `src/adapter/reconcile.ts`, `src/adapter/observed.ts`, `src/adapter/encode.ts`, `src/adapter/bulb-groups.ts`, `src/adapter/show.ts`, `tests/runtime/fake-bulbs.ts`
- Modify: `src/legacy/handlers/controller.ts` (`ls_apply`), `src/legacy/handlers/dispatch-render.ts` (`ls_render`, `ls_dispatch`), `scripts/legacy-files.json` (`bridges`: `src/adapter/show.ts`)
- Delete: `src/legacy/domain/transport.ts`, `src/legacy/domain/grouping.ts`, `src/legacy/domain/dispatch-render.ts`'s dispatch half, their handlers, parsers and tests (Global Constraint 8)
- Test: `tests/runtime/reconcile.test.ts`, `tests/runtime/encode.test.ts`

**Interfaces:**
- Consumes: M2 Task 2 `lightingState`, `switchPower`; M1 `decodeModel`, `bulbTopics`, `bulbAppearance`, `BulbAppearance`.
- Produces:
  ```ts
  // observed.ts
  export type ObservedBulb = { reach: 'unreachable' } | { reach: 'reachable'; light: { power: 'off' } | { power: 'on'; level: Level; colour: Colour | undefined } };
  export type Observed = { bulbs: Record<BulbId, ObservedBulb>; switches: Record<SwitchId, Power | 'unreachable'>; bridgeConnected: boolean };
  export function decodeObserved(states: Readonly<Record<string, EntityState>>, config: Config): Observed;

  // reconcile.ts
  export type Send =
    | { kind: 'bulb'; bulb: BulbId; appearance: BulbAppearance; over: Seconds; stopFirst: boolean }   // stopFirst: the bulb is leaving the candle
    | { kind: 'switch'; switch: SwitchId; power: Power };
  export type Belief = { shows: BulbAppearance; sentAt: Instant; settlesAt: Instant };
  export type Beliefs = { bulbs: Record<BulbId, Belief>; switches: Record<SwitchId, { power: Power; sentAt: Instant }> };
  export const NO_BELIEFS: Beliefs;
  export function nextSends(target: LightingState, config: Config, observed: Observed, beliefs: Beliefs, now: Instant): { sends: Send[]; wakeAt: Instant | undefined };
  export function afterSend(beliefs: Beliefs, send: Send, outcome: 'sent' | 'failed', now: Instant): Beliefs;
  export const LEVEL_TOLERANCE = 2; export const KELVIN_TOLERANCE = 50; export const XY_TOLERANCE = 0.01; export const SETTLE_MARGIN: Seconds;   // 2 s

  // encode.ts
  export type Publish = { topic: MqttTopic; payload: BulbPayload };   // BulbPayload: a closed type of the Zigbee2MQTT keys we send
  /** One send as publishes, in order: stop_effect when leaving the candle; level and colour (or OFF) with the transition; then the candle's start. Nothing after the start carries On or a brightness. */
  export function publishes(sends: readonly Send[], topics: Record<BulbId, MqttTopic>, groups: BulbGroups): Publish[];

  // show.ts — the one bridge from legacy entry points into the new path, deleted in M3 Task 3
  export function showLightingState(ctx: ScriptContext): void;   // decodeModel → lightingState → nextSends → publishes → ctx.emit; beliefs kept in the process
  ```
- `nextSends` in this task is the core rule only: a bulb is sent its target when the target differs from what it is believed to show, or, once the belief has settled, from what it is observed to show (within the tolerances; the firmware effect is known from the belief only). An unreachable bulb or a disconnected bridge is sent nothing. A switch is sent its target when it differs from its observed power. Retries, parking, the flap limit, the power-on fade and the plug's own button are M4.
- `bulb-groups.ts` moves `planGroups` from `src/legacy/domain/grouping.ts`: bulbs that get the same send and form a whole Zigbee group go as one publish to the group's topic.
- `ls_apply`, `ls_render` and `ls_dispatch` each become one call to `showLightingState`. The legacy plan, room plan and resolution code stay for now: the legacy remote and lamp-change writers still read them (deleted in M3 Task 3). The port stops writing the runtime sensor's `applied`, guards and room caches (Global Constraint 9).

- [ ] **Step 1: Write failing tests.** `fake-bulbs.ts`: bulbs with power, level, colour and firmware effect; a level or On command ends a candle; a publish can be dropped. `reconcile.test.ts`: `a cold start sends each bulb its light, then the candle's start`; `a steady state sends nothing across ten passes`; `a level change under a candle sends the light, then the start again`; `leaving the candle sends the stop first`; `a bulb that reports something else after settling is sent its target again`; `a report inside the settle window is not a difference`; `an unreachable bulb is sent nothing`; `a failed send leaves the belief unchanged`. `encode.test.ts`: `the candle's start comes last and nothing follows it`; `off is sent as OFF with the transition`; `kelvin goes out as mireds, RGB as r,g,b`; `bulbs forming a whole group go as one publish`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Implement; point the three legacy entry points at `showLightingState`; delete the legacy sending code.
- [ ] **Step 4:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → `flow differences 0`. This is the first run of the new domain on real house data: a decode failure here is a codec bug, fixed in the codec with a test.
- [ ] **Step 5:** Commit: `feat(lighting)!: the bulbs get lightingState through the reconciler`.

---

## M3: `update`

### M3 Task 1: Overlays, resets, ranges and profiles

Worker: `worker-hard`. Review: one Opus pass against the M1 plan's flow section, items 2, 3.1, 4, 5 and 7.

**Files:**
- Create: `src/domain/update.ts`, `src/domain/lamp-overlays.ts`; extend `src/domain/overlays.ts`, `src/domain/switches.ts`
- Test: `tests/runtime/update-overlays.test.ts`

**Interfaces:**
- Consumes: M1 `Model`, `Msg`, overlay types; M2 `lightingState`, `overlaysOn`, `blockPosition`.
- Produces:
  ```ts
  // update.ts
  export function update(model: Model, msg: Msg): Model;   // total and pure; this task: every case but remotePressed
  // overlays.ts (added)
  export function holdBlock(overlays: Overlays, over: RoomOrHouse, block: Block, rooms: readonly RoomId[], now: Instant): Overlays;
  export function clearAll(model: Model): Model;
  export function clearRoom(model: Model, room: RoomId): Model;
  /** The overlays an after-age or at-set-time reset removes at this instant. */
  export function resetsDue(model: Model, now: Instant): Model;
  // lamp-overlays.ts
  export function personChanged(model: Model, lamps: readonly LampId[], light: RequestedLight, now: Instant): Model;
  export function dashboardControlSet(model: Model, overlay: Omit<LampOverlay, 'since'>, now: Instant): Model;
  // switches.ts (added)
  /** A press on a plug's own button: an overlay on that switch, replacing any it had. */
  export function switchButtonPressed(model: Model, pressed: SwitchId, power: Power, now: Instant): Model;
  ```
- `Msg` needs the instant an input arrived. This task adds `at: Instant` to every `Msg` case except `clock` (which has `now`) in `src/domain/model.ts`.
- Moved from: `planCommit`, `planOverrideBlock`, the mode toggle, `planStore` in `src/legacy/domain/state-store.ts`; `planNativeControls`, `planUIControls`, `nativeColor`, `held` in `src/legacy/domain/native-controls.ts`; `endOverrides`, the mode switch handler, `lampChangeOverrides`, `houseRangeDefaults` in `src/legacy/handlers/automations.ts`; `expiredOverlays`, the mode change parser, `decideRangeSave`.
- Kept as today: a block held over the house is also held over each room; a person's change of every lamp in a room is one room overlay, otherwise one per lamp, and switches each touched room on; a person's change to the normal light hands both parts back to the schedule; the after-age limit defaults to 180 min; the at-set-time reset removes every overlay; a profile save with a field missing keeps the saved value.
- A switch's own button (M1 plan, decision 8; a named behaviour change, not a move): the press sets `overlays.switches[switch] = { power, since: now }`. It is released by the same rules as every other overlay, through the same functions: the next-block reset (in `switchPower`, M2 Task 2), `resetsDue` (after-age and at-set-time), `clearAll`, and `clearRoom` for the switch's room. A range save for that switch does not remove it. The legacy revert at the next tick is not carried over.

- [ ] **Step 1: Write failing tests**, each `update(model, msg)` then an assertion on `lightingState` (flow) and on the model: `holding a block shows that block's light at once`; `clear all returns every lamp to the schedule`; `a person's brightness change holds the lamp and switches its room on`; `a person's change of a whole room is one room overlay`; `choosing the candle from the dashboard starts it on that lamp`; `choosing the normal light ends it`; `the mode overlay toggles`; `an overlay older than the limit is removed on the next clock`; `the at-set-time reset removes every overlay`; `with both rules off nothing is removed`; `saving a range rule changes when the switch is on`; `saving a lamp profile changes that lamp's block light`; `a switch's own button holds it over its range rule across the next clock`; `the after-age reset releases a switch overlay`; `clear all releases it`; `a reset of its room releases it`; `a second press replaces the first`; `a config change is taken whole`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Move and re-type.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(domain): update for overlays, resets, ranges and profiles`.

### M3 Task 2: The remote

Worker: `worker-hard`. Review: one Opus pass.

**Files:**
- Create: `src/domain/remote.ts`; extend `src/domain/update.ts` (`remotePressed`, and chord and power-combo timeouts on `clock`)
- Test: `tests/runtime/remote.test.ts`

**Interfaces:**
- Consumes: M3 Task 1 `update`, `clearRoom`; M2 `overlaysOn`, `blockPosition`, `lightingState`; M1 `RemoteModel`, `RemoteOverlay`, `RemoteAdjustment`, `RemotePreset`, `RemotePress`.
- Produces:
  ```ts
  export function remotePressed(model: Model, remote: RemoteId, press: RemotePress, now: Instant): Model;
  export function remoteTimeouts(model: Model, now: Instant): Model;   // a chord or a power combo whose window closed
  export const CHORD_WINDOW: Seconds; export const POWER_COMBO_WINDOW: Seconds;   // today's timer lengths
  ```
- `RemoteModel` gains the two deadlines (`chord.until: Instant`, `powerPressesUntil: Instant | undefined`), so timeouts are state and `clock` fires them; `nextChange` includes them. The power token and the HA timers go.
- Moved from: `update` (the gesture reducer), `remoteArea`, `stampPowerToken` in `src/legacy/domain/gestures.ts`; `remoteOpening`, `remoteDecision` in `src/legacy/domain/remote-input.ts`; `acceptedPowerSwitch`, `remoteCommit` in `src/legacy/domain/controller.ts`.
- Kept as today: brighter and dimmer move one step inside the step range and restart from zero when a newer overlay applies to the room; left and right cycle day, cosy, candle, remembering what each held; the power toggle switches the room to the opposite of its saved power, or of whether anything in it is on; reset clears the room's overlays; the mode press toggles the mode overlay; a remote with no room does nothing; a press that is no command does nothing; the preset buttons set a colour temperature from the five-step table.

- [ ] **Step 1: Write failing tests**, each ending in an assertion on `lightingState`: the flow cases of `gestures-reducer.test.ts`, `r4-gestures.test.ts`, `r4-remote-plan.test.ts` and `host-remote.test.ts` carried over, plus `brighter then dimmer returns the room to where it was`; `a step restarts from zero under a newer overlay`; `right goes day, cosy, candle and round again`; `returning to a preset restores what it held`; `the power toggle switches a lit room off and back on`; `reset returns the room to the schedule`; `a remote with no room changes nothing` (Review Focus 4); `an unknown press changes nothing`; `a chord that is not finished in time is dropped on the clock`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Move and re-type.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(domain): the remote as update cases`.

### M3 Task 3: Inputs, the loop, the dashboard; the legacy writers go

Every input now goes HA → `Msg` → `update` → sensors → `lightingState` → bulbs. Worker: `worker-hard`. Review: one Opus pass.

**Files:**
- Create: `src/adapter/inputs.ts`, `src/adapter/loop.ts`, `src/adapter/writes.ts`, `src/domain/dashboard.ts`
- Modify: `src/rpc.ts`, `src/runtime/registry.ts` (every name routes to `handleInput`), `src/adapter/codecs/*` (encode what `update` changes)
- Delete: `src/adapter/show.ts`; `src/legacy/domain/` except what M5 still needs for the live host (list it in the commit); `src/legacy/handlers/`; the parsers in `src/parse/` only legacy used; their tests (Global Constraint 8)
- Test: `tests/runtime/inputs.test.ts`, `tests/runtime/loop.test.ts`, `tests/runtime/dashboard.test.ts`

**Interfaces:**
- Consumes: M3 Tasks 1 and 2 `update`; M2 Task 3 `nextSends`, `afterSend`, `publishes`, `decodeObserved`; M1 codecs.
- Produces:
  ```ts
  // inputs.ts
  export type HaInput =
    | { kind: 'started' } | { kind: 'tick' }
    | { kind: 'helper changed'; entity: HelperEntity }
    | { kind: 'overlay event'; data: JsonObject }                       // the ls_override event
    | { kind: 'dashboard script'; script: 'hold block' | 'clear overlays' | 'save range'; data: JsonObject }
    | { kind: 'service called'; domain: ServiceDomain; service: ServiceName; data: JsonObject; user: UserId | undefined }
    | { kind: 'remote action'; remote: RemoteId; payload: JsonValue }
    | { kind: 'effect preview'; topic: MqttTopic; payload: JsonValue }
    | { kind: 'state changed'; entity: ObservedEntity }
    | { kind: 'wake' };
  export function haInput(script: ScriptName, args: JsonObject): HaInput | undefined;   // the bridge's and the host's names → inputs; undefined: not ours
  export function messages(input: HaInput, model: Model, now: Instant): Msg[];
  // loop.ts
  export type AdapterState = { model: Model; beliefs: Beliefs };
  export type Output = { kind: 'publish'; publish: Publish } | { kind: 'sensor'; write: SensorWrite } | { kind: 'helper'; write: HelperWrite } | { kind: 'dashboard'; write: DashboardWrite };
  /** One turn: read, update, write back what changed, compute the lighting state, reconcile. Pure but for the clock it is handed. */
  export function handleInput(state: AdapterState | undefined, snapshot: Snapshot, input: HaInput): { state: AdapterState; outputs: Output[]; wakeAt: Instant | undefined };
  // dashboard.ts
  export type DashboardView = { blockShown: Record<RoomOrHouse, Block>; modeOn: boolean; controls: readonly DashboardControlView[] };
  export function dashboardView(model: Model, lighting: LightingState, now: Instant): DashboardView;
  ```
- `messages` implements the table in spec 5.1. The person-change detector keeps today's rules (a user id, `light.turn_on`, a brightness or colour key, not caused by a running script): moved from `parseNativeCapture` and the automation trigger parsers in `src/parse/automations.ts` and `src/parse/native-controls.ts`.
- `handleInput` with no state decodes the `Model` from the snapshot (a start, or the first input). After that the in-process `Model` is the truth; a `helper changed` input re-decodes the `Config` only. A `started` input re-decodes everything, which is what makes an HA restart safe.
- `writes.ts` turns a changed `Model` into sensor and helper writes through the M1 codecs, and a changed `DashboardView` into the dashboard's writes: the per-room block selector, the mode mirror, and the control sync messages (moved from `uiMessages`, `uiChoices` in `src/legacy/domain/ui-state.ts` and the `ScheduleMirror` in `schedule.ts`). Nothing is written when nothing changed.
- The bridge: `src/rpc.ts` maps `{script, args, snapshot}` through `haInput` to `handleInput` and returns the outputs as the calls the harness records. `wakeAt` is returned as one scheduled task named `ls_wake`, which the harness runs like today's delayed scripts.
- An input that cannot be read (`haInput` gives `undefined`, or a field is malformed) is logged once and dropped; the loop goes on.

- [ ] **Step 1: Write failing tests.** `inputs.test.ts`: one test per row of spec 5.1 (`a tick is a clock message`, `the override event's hold is an overlay request`, `a person's light.turn_on with a brightness is a lamp change`, `the same call without a user is not`, `a call caused by a script is not`, `a remote's action is a press`, `a helper change re-reads the config`), and `an input that cannot be read is logged and dropped` (Review Focus 5). `loop.test.ts` on the synthetic house and `fake-bulbs.ts`: `a start with no state decodes it and lights the house`; `a remote press changes the model, the sensor and the bulbs in one turn`; `inputs are applied one at a time in arrival order` (Review Focus 3: a press between two ticks of a fade, both take effect); `nothing is written when nothing changed`; `the turn asks to be woken at nextChange`. `dashboard.test.ts`: `the block shown follows a held block`; `the mode mirror follows the mode overlay`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Implement; route every name through `handleInput`; delete the legacy writers and readers.
- [ ] **Step 4:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → `flow differences 0`.
- [ ] **Step 5:** Commit: `feat(lighting)!: every input goes through update; the legacy handlers are gone`.

---

## M4: Reconciler

### M4 Task 1: Retries, power-on, the plug's own button

Worker: `worker-hard`. Review: one Opus pass.

**Files:**
- Modify: `src/adapter/reconcile.ts`, `src/adapter/observed.ts`, `src/adapter/loop.ts`, `src/adapter/inputs.ts`, `tests/runtime/fake-bulbs.ts`
- Test: `tests/runtime/reconcile.test.ts`, `tests/runtime/loop.test.ts`

**Interfaces:**
- Consumes: M2 Task 3 and M3 Task 3.
- Produces (extends, same names):
  ```ts
  export type Belief = { shows: BulbAppearance; sentAt: Instant; settlesAt: Instant; attempts: Attempts; retryAt: Instant | undefined; parked: boolean; reapplies: readonly Instant[] };
  export const RETRY_FIRST: Seconds;    // 1 s, doubling
  export const RETRY_CAP: Seconds;      // 60 s
  export const MAX_ATTEMPTS = 5;
  export const REAPPLY_LIMIT = 6; export const REAPPLY_WINDOW: Seconds;   // 6 per 10 minutes
  /** What an observation that nothing we sent explains means. */
  export type Unexplained = { kind: 'switch pressed'; switch: SwitchId; power: Power } | { kind: 'bulb back on'; bulb: BulbId };
  export function unexplained(before: Observed, after: Observed, beliefs: Beliefs, now: Instant): Unexplained[];
  ```
- Rules (spec 5.3): a failed send is retried after 1 s, doubling to 60 s, five attempts, then the bulb is parked and logged once at info level; a parked bulb is released by its power-on. At most six re-applies per bulb per ten minutes, then parked. A bulb that comes back on (off or unreachable → on) loses its belief and gets its target with the short fade (`MANUAL_FADE`, or `EFFECT_START_FADE` before a candle start). A switch that changes with no send of ours to explain it is the plug's own button: `messages` turns it into `switchButtonPressed`, which holds it as an overlay (M3 Task 1); from this task on the press is no longer taken back at the next tick. This task therefore adds the one `ExpectedDifference` to `EXPECTED` in `tests/e2e/golden.py` (the single permitted edit there, Global Constraint 3 notwithstanding): `name='plug-press-held'`, `scenario='plug_button'`, `role` the subject room's plug, `rule='power'`, `after_step` the press step, `until='next fade start'` (the next-block reset releases an overlay at the next block's fade start), `port_holds=True`. In that window the reference has taken the press back and the port has not, and the port must show the pressed value at every checkpoint in it. At the fade start that closes the window the port lets go, and both must agree again, and everything else in `plug_button` is judged as usual. Any other difference on a bulb is sent its target again. A group send that fails invalidates every member's belief.
- `wakeAt` from `nextSends` is the earliest retry or settle time; `handleInput` returns the earlier of it and `nextChange`.

- [ ] **Step 1: Write failing tests.** In `reconcile.test.ts`, on `fake-bulbs.ts` (which gains unreachable, power-cycle and a failing publish): `a lost start is sent again alone`; `a single bulb power-cycled under a lit lamp gets its light and effect back with the short fade` (Review Focus 2); `a dead bulb gets five sends, then silence`; `a parked bulb is logged once`; `a parked bulb is released when it comes back on`; `flapping is capped at six in ten minutes`; `a group failure invalidates every member`; `a restart re-sends nothing a bulb already shows` (Review Focus 1: empty beliefs, observation matches the target → no sends; the candle, which is not observable, is started once). In `loop.test.ts`: `a plug's own button becomes a switch overlay and is not sent back`; `a switch we just switched is not a button press`; `a bulb changed behind our back is put back`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → `flow differences 0`, `expected {'plug-press-held': n}` with n above 0 (`wall_power_cycle` and `plug_button` are the scenarios that exercise this). If `plug_button` shows any flow difference outside the entry, stop and report it.
- [ ] **Step 5:** Commit: `feat(adapter): the reconciler retries, restores and reads the plug's button`.

---

## M5: Host cut

### M5 Task 1: A minimal host; everything legacy deleted

Worker: `worker-hard`. Review: one Opus pass, plus one advisor pass on the final shape of `src/` against the spec's layer table (section 2).

**Files:**
- Create: `src/host.ts` (replaces `src/runtime/host.ts`), `src/adapter/ha-client.ts`, `src/adapter/journal.ts`
- Modify: `src/main.ts`, `src/live.ts`, `src/rpc.ts`, `scripts/*.mjs` guards, `package.json`, `lighting-scripts/README.md`
- Move: what remains useful of `src/parse/` (`ids.ts`, `accessors.ts`, `blocks.ts`, `overlay-key.ts`, `rooms.ts`, `live-rooms.ts`) and of `src/runtime/` (`parse.ts`, `catalog.ts`, `format.ts`, `live-rooms.ts`) → `src/adapter/`
- Delete: `src/legacy/`, `src/handlers/`, `src/parse/`, `src/runtime/` (registry, engine, entrypoints, effects, context, verbatim), `scripts/legacy-files.json`, `scripts/effects-edge.mjs`, `scripts/stringified.mjs` and its kept list, `tests/parity/` except the modules `tests/e2e/` imports (`adapters.py`, `rpc.py`, `portability.py`, `run.py` and what they import), the `parity` npm scripts, `scripts/export-bridge.py` only if nothing in the rollout notes still calls it (else leave and say so)
- Test: `tests/runtime/host.test.ts` (rewritten), `tests/runtime/journal.test.ts`

**Interfaces:**
- Consumes: M3 Task 3 `handleInput`, `haInput`, `Output`; M4.
- Produces:
  ```ts
  // host.ts — no rule lives here
  export class Host {
    constructor(io: { ha: HaClient; mqtt: MqttClient; journal: Journal; clock: () => Instant; log: Log });
    /** Queue an input; inputs run one at a time, in order. */
    accept(input: HaInput): void;
    close(): Promise<void>;
  }
  // journal.ts
  export function loadBeliefs(text: string | undefined): Beliefs;   // lenient: anything unreadable is NO_BELIEFS
  export function saveBeliefs(beliefs: Beliefs): string;
  ```
- The host: keeps the HA state mirror, turns HA events and MQTT messages into `HaInput`s, runs `handleInput` single-flight, performs the outputs one at a time (saving the journal after each bulb send), and sets one timer for `wakeAt`. Performing a publish reports `sent` or `failed` back through `afterSend`. It holds no lighting rule; `host.ts` stays under 200 lines.
- `npm run check` after this task: `tsc`, `json-edges` (edges: `src/adapter/`, `src/host.ts`, `src/main.ts`, `src/live.ts`, `src/rpc.ts`), `domain-types`, `domain-words` (every ceiling 0 or deleted), `item-order`, `domain-imports` (domain imports only domain; the adapter never imports the host).
- The per-turn timing the runtime sensor showed is written by the host, measured around the sends.

- [ ] **Step 1: Write failing tests.** `host.test.ts` with fake clients: `inputs run one at a time`; `a send's failure reaches afterSend`; `the journal is saved after each bulb send`; `one timer is set for the turn's wake time and replaced by the next turn`; `a restart loads the journal and sends nothing the bulbs already show`. `journal.test.ts`: `round trip`; `an unreadable journal is no beliefs`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Write the host; move the edge helpers; delete everything listed; update the guards and the README's layout section.
- [ ] **Step 4:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → `flow differences 0`. `git grep -n "ctx.run\|Plan<\|Verbatim" -- lighting-scripts/src` prints nothing.
- [ ] **Step 5:** Commit: `refactor(lighting)!: minimal host; the script-shaped code is deleted`.

---

## M6: Close-out

### M6 Task 1: Sharing the house with the old scripts, room by room

Prepared, not switched on. Worker: `worker-hard`. Review: one Opus pass.

**Files:**
- Create: `src/adapter/compatibility.ts`
- Modify: `src/adapter/loop.ts`, `src/adapter/inputs.ts`, `src/adapter/writes.ts`, `src/main.ts` (`--live-rooms`), the heartbeat and watchdog code moved in M5, `lighting-scripts/README.md`; the private runbook in the notes directory (not in the repo)
- Test: `tests/runtime/live-rooms.test.ts` (rewritten), `tests/runtime/compatibility.test.ts`

**Interfaces:**
- Consumes: M5; `lighting-scripts/docs/sensor-fields.md` from M1 Task 7 (its `carried` rows are this task's checklist).
- Produces:
  ```ts
  /** The fields the old scripts read across rooms, kept valid while any room is still theirs. Deleted when the last room is cut over. */
  export function compatibilityWrites(model: Model, lighting: LightingState, found: SensorAttributes, live: ReadonlySet<RoomId>, now: Instant): SensorWrite[];
  ```
- With `--live-rooms`: `messages` drops inputs for rooms that are not live; `nextSends` is given only live rooms' lamps and switches; the codecs leave other rooms' stored overlays as found (M1); `compatibilityWrites` keeps each `carried` field in the shape the old scripts expect. With every room live, `compatibilityWrites` writes nothing.
- The heartbeat and the watchdog work as before the redesign; their tests are carried over.

- [ ] **Step 1: Write failing tests:** `an input for a room that is not live changes nothing`; `a lamp in a room that is not live is sent nothing`; `another room's stored overlays are byte-identical after a turn`; one test per `carried` row of `sensor-fields.md`; `with every room live nothing extra is written`; the heartbeat and watchdog cases.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Implement; update the README and the private runbook's steps to the new process (one room first, the owner's go, rollback).
- [ ] **Step 4:** Run `npm run check && npm test` → green. Run `npm run e2e` detached (every room live, as the harness runs) → `flow differences 0`.
- [ ] **Step 5:** Commit: `feat(adapter): live rooms and the compatibility writer`.

### M6 Task 2: Close-out review; the branch is ready

Controller, not a worker.

- [ ] **Step 1:** Run the close-out review (`advice-refine-test-loop`) over the whole branch diff with Fable reviewers, briefed with the spec, both plans and `session-constraints.md` verbatim. Its focus: the owner's architecture (spec section 2), the typing and vocabulary rules, and this plan's five Review Focus items. Findings about exact levels, fades or the candle's level are noted, not fixed.
- [ ] **Step 2:** Fix what the review finds, each fix with its test; re-run `npm run verify`.
- [ ] **Step 3:** Write the hand-over for the owner as the PR #39 description: what changed in the architecture, the flow gate's last line and its `noted` counts, the gaps no scenario covers (the M1 plan's list, less what was added), and what the rollout needs from the owner (a go, while awake, one room first).
- [ ] **Step 4:** Push. Stop. No cutover, no merge.

## Amendments (2026-11-22, after M1 T5)

1. **Blocks contain effects.** The effect is a property of a lit light: `SceneLight`'s lit case carries `effect` ('Candle' | 'Normal'), so a lamp's, a room's or the house's block light can name the candle. `LampProfile` = `{ follows: 'room' } | { follows: 'own'; light: SceneLight }`. M1 T6/T7 codecs read the saved effect into the light; anything not `Candle` is `Normal`.
2. **The reconciler is the effect manager** (M2 T3, M4 T1): it starts the candle (colour and level, then `effect: channel_change`), stops it (`stop_effect`), and restarts it after a level change or a power-cycle. No effect manager in the domain.
3. **Candle survives a person's brightness or colour change** (owner, 2026-11-22). A hold that changes level or colour on a candle lamp keeps the candle at the new level/colour; only choosing normal light ends it. The reconciler re-sends colour + level, then `channel_change`, because the firmware ends the candle on any On or brightness move.
4. Changing blocks: a lamp keeps the current block's effect through the fade and switches at the block start, as today.

5. **M1 layer check (Fable, 2026-11-22): drifts assigned to later milestones.**
   1. M2: move `src/domain/types/overlay.ts` (the stored key format: `mode:sara`, `channels:ui:`, `saved`, `empty`) to `src/adapter/codecs/`; move `src/domain/types/rooms.ts` (HA registry map) to the adapter. M2 T3: fade constants (`MANUAL_FADE`, `EFFECT_START_FADE`) move from `src/parse/ids.ts` to the adapter's encoder/reconciler.
   2. M3: `types/remote.ts` drops `sara_toggle`, `pressText` and the `unknown` press (the adapter drops unknown presses); key remotes by `RemoteId`, not the wire `RemoteSource`.
   3. M5: `blocks.ts` `blockOption` (an input_select label) and `UserId` leave the domain; `parseCatalog` lands in `src/adapter/codecs/catalog.ts`; extend `json-edges.mjs` to check `src/adapter` outside `codecs/`, and `domain-imports.mjs` to catch `import('…')` type references.

6. **M2 layer check (Fable, 2026-11-23).**
   1. Before M3 T3 deletes legacy on/off (handlers/controller.ts:122): `reconcile.ts` sends nothing to a bulb that reports off. That is the adapter deciding WHAT. A person's off must become domain state, and the reconciler then skips only unreachable bulbs and a disconnected bridge. The shape waits on an owner question (a person's off in HA: a hold released by resets / today's "stays off" / a hold until switched on); M3 T1 carries the answer.
   2. M3 T1: `lighting-state.ts:396-415` tests `=== 'Candle'` for "holds the warm colour" and "ignores remote steps". Make both properties of the `Effect` interface before the remote builds on `overlaysOn`.
   3. M3 T3: the `mqtt.publish` and switch `homeassistant.turn_*` calls built in `show.ts` move into `encode.ts`; `SavedOverlayKey` and `PowerTarget` (`types/ids.ts`) move to `codecs/overlay-key.ts` / legacy.
   4. M3 (with 5.2): the remote tie-break in `lighting-state.ts:110` sorts by the wire `RemoteSource`; key by `RemoteId`.
   5. M5 (with 5.3): `observed.ts` and `bulb-groups.ts` read HA/catalog JSON outside `codecs/`; `codecs/config.ts` imports `MqttTopic` from `encode.ts`.

## Self-review notes

1. Spec coverage: section 3 → M2 Tasks 1 and 2, M3 Tasks 1 and 2; section 4 → M1, M3 Task 3, M5 (journal), M6 Task 1 (4.4); section 5.1 and 5.2 → M3 Task 3; 5.3 → M2 Task 3 and M4; 5.4 → M6 Task 1; section 6 → M1 Task 1 (the flow gate replaces exact comparison and fuzzing by the owner's later decisions); section 7 → the milestones here.
2. Spec items deliberately not built: fuzzing (stopped); the tolerance tuning "against a real bulb in M4" (spec 5.3.2.2) and the settle-margin measurement (no bulb is touched before the owner's go; both are named constants to tune live).
