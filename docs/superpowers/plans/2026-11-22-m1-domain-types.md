---
date: 2026-11-22
kind: plan
milestone: M1
status: ready
spec: docs/superpowers/specs/2026-11-22-lighting-architecture-design.md
pr: https://github.com/jonathanmoregard/smarthome/pull/39
scope: lighting-scripts/
---
# M1: Domain Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The lighting port gets its real domain types (`Model`, `Msg`, `LampLight`, `Colour`, `Effect` with Candle and Normal, and above all the overlays) and the codecs that read and write them from the Home Assistant (HA) sensors and helpers; Breathe and Colour loop are removed.

**Architecture:** M1 first makes the golden gate judge the user flow (Task 1) and moves today's script-shaped code out of `src/domain/` into `src/legacy/` (Task 3), so `src/domain/` holds only the new architecture from then on. The rest is additive: new pure types in `src/domain/` (importing nothing outside it), new codecs in `src/adapter/codecs/`. The legacy handlers keep driving the lamps until M2 and M3 replace them, so the only change to what a lamp does is that Breathe and Colour loop go (Task 2). Nothing calls the codecs at run time yet; M2's `lightingState` is their first reader. The care in M1 goes into the overlay types: they must hold everything today's overlay flow reads, and nothing else.

**Tech Stack:** TypeScript 5.9 on Node 22 (`--experimental-strip-types`), `node:test`, the guards in `npm run check`, the M0 golden gate (`npm run e2e`, Python, inside `nix develop`).

**Spec:** `docs/superpowers/specs/2026-11-22-lighting-architecture-design.md`, sections 3, 4 and 7.2. Where "Decisions since the spec" below differs from the spec, the decisions win.

## Decisions since the spec

1. Fuzzing is stopped. The 13 golden scenarios are the acceptance proof. Read "golden and fuzz" in the spec as "golden".
2. Spend with discernment: few sizeable tasks, reviews scaled to risk, no polish tasks, no machinery beyond what M1 needs.
3. Today's algorithms are moved and re-typed in M2, not reinvented. M1 moves none of them.
4. The candle is the bulb's firmware effect, as the port runs it today: the lamp's own level and colour, then `effect: channel_change`. Its level is tuned live later. No candle maths is restored. (Owner, 2026-11-22: "don't sweat about getting candle right, just use fw effect, we will tune as we go. The important thing to get right, here and now, is the general flow of overrides".) This supersedes the earlier "start at the old candle's base brightness".
5. Leaving a candle sends `stop_effect` only.
6. Acceptance is the user flow, not exact values (owner, 2026-11-22: "don't sweat about getting the handle or the fade or whatever exactly right. Just get the general user flow"). The gate fails on flow differences and only notes level differences. Its rules are in Task 1 and bind every later task and milestone.
7. This plan is the first of two. M2 to M6 are in `docs/superpowers/plans/2026-11-22-m2-m6-redesign-build.md`.

## Global Constraints

1. The repo is public. No household names, area ids, entity ids of real devices, device addresses or friendly names in any committed file, test or commit message. Tests use synthetic ids (`room-a`, `lamp-a`, `bulb-a1`, `plug-a`, `remote-a`). The mode overlay is called "mode overlay" in new code and docs.
2. `reference/`, `.runtime/` and `*report.json` are never committed or quoted.
3. Every task leaves `npm run check` and `npm test` green. A guard ceiling that falls is lowered to the new count in the same commit; none may rise.
4. Flow gate (`npm run e2e`, detached with `systemd-run --user` and `~/.claude/scripts/wait-for`, log in `/tmp/v1work/`): after Task 1 it prints `e2e: golden N/N flow agree, flow differences F, noted {...}` and passes only when F is 0. Every task from Task 2 on ends with F = 0. Tasks 4 to 7 add no code the handlers reach; the gate is run once more after Task 7. Noted counts are recorded in the ledger and never block. A task that cannot reach F = 0 stops and reports the flow differences; it does not loosen a rule in `compare.py`.
5. The old per-script parity (`npm run parity`) is no longer a gate and is not run. Its cases start breaking in Task 2 (the Breathe and Colour loop cases) and that is accepted; the suite goes in M5.
6. Vocabulary: schedule, block, transition, wake light, effect, bulb, lamp, room, switch, remote, lighting state, overlay, overlay reset, dashboard, config. No "plan", "dispatch", "render", "intent", "action", "claim" or "record" in a new domain name.
7. Types: tagged sum types, branded ids, range types. No plain `string` or `number` in a new exported domain signature (strings only for free text). No `?: never` unions, no wire keys, no snake_case, no tuples kept because the wire sends one, no `Verbatim`, no optional field that exists only because JSON may omit it. Off has no level and no colour. A missing colour is `Colour | undefined`, never a stand-in.
8. Presence is tested with `=== undefined`. No truthiness, no `??` standing in for "absent". Jinja's `or` goes through `jinjaTruthy`.
9. Parse, don't validate. JSON appears only in `src/adapter/`, `src/parse/`, `src/runtime/` and `src/live.ts`. A codec returns domain types and never the unparsed type.
10. Values a person can change at run time (helpers, dashboard controls, the stores they write) recover to a named default and never raise. The catalog is refused at load when malformed.
11. Reading order (enforced by `scripts/item-order.mjs`): a type first, then the functions coupled to it; a callee below its caller; a single-use helper inside its caller; public entry points first; tables after their types. A function that always throws says so in its name. No args records.
12. A module in `src/domain/` is one concept, named for it.
13. Range and id constructors stay in `src/parse/ids.ts`; only `src/parse/` and `src/adapter/` call them.
14. Workers commit only (one commit per task); the controller pushes. Commit trailers name the model that wrote them. Each worker brief embeds `session-constraints.md` verbatim and is sense-checked by the advisor first.
15. Scope is M1. No `update`, no `lightingState`, no reconciler, no moving of schedule, blend or resolution code.

## The overlay flow the types must carry

This is today's behaviour, read from `schedule.ts`, `resolution.ts`, `remote-input.ts`, `native-controls.ts`, `state-store.ts` (in `src/domain/` today, `src/legacy/domain/` after Task 3) and `src/handlers/automations.ts`. M2 and M3 move it; M1's types must be able to hold all of it.

1. **Schedule.** Each lamp follows its room's schedule (the house's when the room has no own timing, or the lamp is in no room): the current block, and during a fade the transition from the current block's light to the next one's. A wake light replaces the night block's light with a fade to day.
2. **Which block.** A block overlay on the lamp's room (or the house) replaces the scheduled block. So does a remote's day or cosy preset. The newest of them wins.
3. **Brightness and colour, separately.** On each of the two, every overlay that applies to the lamp (its own, its room's, the newest remote overlay of its room) is ordered by when that part was last set; the newest wins. The schedule's light is underneath.
   1. A person's HA change and a dashboard control set a fixed brightness, a fixed colour, the candle, or hand the part back to the schedule.
   2. A remote's brighter and dimmer presses move the lamp along the blend between the room's cosy and day light. The steps restart from zero when a newer overlay applies to the room.
   3. A candle keeps, underneath it, the brightness it runs at.
4. **Mode overlay.** While active, colour is the mode's colour on every lamp outside private rooms and outside the night block.
5. **Room power.** A room switched off from its remote, or on by a person's change, overrides whether its lit lamps are on.
6. **Switches.** A switch follows its range rule against its room's level, or its block's on/off setting; its own button moves it until the range takes it back.
7. **Overlay resets.**
   1. Next block (rule on): an overlay set before the lamp's last fade start no longer applies; during that fade the lamp fades out of the held light into the next block.
   2. After an age (rule on, minutes): an overlay older than the limit is removed.
   3. At the set time (rule on): every overlay is removed.
   4. Dashboard clear removes every overlay; the remote's reset removes its room's.

**Which golden scenario proves each part.** In M1 the scenarios still run the old handlers; from M2 on they run through these types. M1's own proof is the codec tests in Task 7, one per row, on the stored shapes each scenario leaves in the overrides sensor.

| # | Part of the flow | Types | Golden scenario |
|---|---|---|---|
| 1 | A person's HA change holds a lamp across a block start; room power on; removed by the after-age reset | `LampOverlay` (`from: person`), `roomPower`, `OverlayReset.afterAge` | `person_change_then_expiry` |
| 2 | Remote presses: brighter, dimmer, power toggle, reset, mode toggle; removed by the after-age reset | `RemoteOverlay`, `roomPower`, `ModeOverlay` | `remote_presses` |
| 3 | Dashboard block held over the house, then clear all | `BlockOverlay` | `dashboard_block_then_clear` |
| 4 | Mode overlay on, then off | `ModeOverlay` | `mode_toggle` |
| 5 | A switch's range rule against the room's level across blocks | `RangeRule`, `RangeDefaults` | `range_save` |
| 6 | A switch's own button, then the range takes it back | `RangeRule`, `Switch` | `plug_button` |
| 7 | State read back after an HA restart gives the same lighting state | every decoder | `ha_restart_mid_fade` |
| 8 | Blocks, transitions, weekend starts, daylight saving | `Schedule`, `Room` | `schedule_day`, `midnight_weekend`, `dst_spring`, `dst_autumn` |

**Parts no golden scenario covers** (listed, not built):

1. The next-block reset: covered from Task 1 by the added scenario `next_block_reset` (before that no scenario ran with the rule on).
2. The at-set-time reset.
3. A dashboard control's lamp overlay, including the candle chosen for one lamp from the dashboard.
4. The remote's preset arrows (day, cosy, candle) and so the block a preset chooses (M0 ruling 44).
5. The remote's chord and power-combo timing (M0 ruling 50).
6. A block overlay on one room (only the house is held).
7. The wake light: covered from Task 1 by the added scenario `wake_light`.
8. Private rooms being left out of house overlays and the mode overlay; the mode overlay doing nothing at night.
9. Two overlays on the same lamp, and a remote's steps restarting under a newer overlay.
10. A person's change of a whole room (only one lamp is changed).

## Review Focus

1. **Saved state that still names a removed effect.** A lamp profile, an overlay or the runtime sensor holding `Breathe` or `Colour loop` after Task 2: the lamp shows its normal light, an effect it was running is stopped once, and nothing raises. Test in Task 2.
2. **A lit light with no colour.** A block light or lamp profile that is on with a brightness and no colour decodes with `colour: undefined`; an off one has neither level nor colour. No white is invented. Tests in Tasks 6 and 7.
3. **Garbage in the stores.** The overrides sensor's `overrides` not a mapping, a stored overlay of an unknown kind, a `when` that is not a date, a profile store that is not JSON or not a mapping, a helper in `unknown` or `unavailable`: each decodes to its named default and encodes back without loss of the stored bytes. Tests in Tasks 6 and 7.
4. **Rooms the port does not drive.** Encoding a `Model` leaves every stored overlay of a non-live room, and every attribute the `Model` does not own, exactly as found. Test in Task 7.
5. **A candle lamp with a bulb that cannot flicker.** A lamp whose bulbs mix candle and stock firmware shows the candle on the first kind and its normal light on the others. Test in Task 4.

## File map

| # | File | Holds | Task |
|---|---|---|---|
| 1 | `src/domain/types/time.ts` (new) | `Instant`, `Seconds`, `TimeOfDay`, `Timezone` | 4 |
| 2 | `src/domain/types/light.ts` (extend) | `RGB`, `Colour`, `Power`, `Transition`, `SceneLight`, `OnLight`, `LampLight` | 4 |
| 3 | `src/domain/effect.ts` (new) | `Effect`, `EffectName`, `BulbInfo`, `BulbAppearance`, `normal`, `candle`, `bulbAppearance` | 4 |
| 4 | `src/domain/config.ts` (new) | `Config` and its parts | 5 |
| 5 | `src/domain/overlays.ts` (new) | `Overlays`, each overlay kind, `ModeOverlay` | 5 |
| 6 | `src/domain/model.ts` (new) | `Model`, `Msg`, `RemoteModel`, `LampProfile`, `RangeRule`, `RangeDefaults` | 5 |
| 7 | `src/domain/types/lighting-state.ts` (extend) | `LightingState` | 5 |
| 8 | `src/adapter/codecs/config.ts` (new) | helpers and catalog → `Config` | 6 |
| 9 | `src/adapter/codecs/overrides-sensor.ts`, `lamp-profiles.ts`, `remote-helpers.ts`, `model.ts` (new) | sensors and stores ↔ the rest of `Model` | 7 |
| 10 | `scripts/domain-imports.mjs` (new), `scripts/json-edges.mjs` | the domain import rule; `src/adapter/` as a JSON edge | 3, 6 |
| 11 | `tests/e2e/compare.py`, `gate.py`, `golden.py`, `scenarios.py` | the flow gate; two added scenarios | 1 |
| 12 | `src/legacy/domain/` | today's script-shaped modules, moved unchanged | 3 |

After Task 3 the old script-shaped modules are in `src/legacy/domain/` and are deleted in M3 and M5. `src/domain/types/` and `blocks.ts` stay and are shared. The old `EffectName` id in `types/ids.ts` (a catalog name) stays for the legacy code; new code imports the new one from `effect.ts`. Task 2 runs before the move, so its paths are the old ones.

---

### Task 1: The flow gate

The gate every later task is judged by. Worker: `worker-hard`. Review: one Opus pass (it defines acceptance).

**Files:**
- Modify: `tests/e2e/compare.py`, `tests/e2e/gate.py`, `tests/e2e/golden.py`, `tests/e2e/scenarios.py`, `tests/e2e/test_compare.py`, `tests/e2e/test_golden.py`, `lighting-scripts/package.json` (`verify` = `check`, `test`, `e2e`; the `parity` scripts stay runnable but leave `verify`)
- Private output: two new recordings under `.runtime/e2e/golden/`

**Interfaces:**
- Produces in `compare.py`:
  ```python
  LEVEL_BAND = 51          # a fifth of the 1..254 range: bright against dim is flow, the exact level is not
  KELVIN_FAMILY = 0.15     # two colour temperatures within 15 % are the same family
  XY_FAMILY = 0.05         # two RGB colours within this xy distance are the same family
  TICK = 60.0              # one schedule tick of slack on when a change shows

  @dataclass(frozen=True) class FlowComparison:
      flow: tuple[Difference, ...]        # these fail the gate
      noted: Mapping[str, int]            # counted, reported, never fail
      not_ported: Mapping[str, int]
  def compare_flow(reference: Sequence[Checkpoint], port: Sequence[Checkpoint], scenario: Scenario) -> FlowComparison
  ```
- A **settled checkpoint** is the last checkpoint of a step. Flow is judged there. A checkpoint inside a step (a fade tick) is judged for rule 6 only.
- Flow differences (each fails the gate), per bulb or switch at a settled checkpoint:
  1. **Power:** on against off.
  2. **Colour family:** kelvin against RGB; two kelvins more than `KELVIN_FAMILY` apart; two RGBs more than `XY_FAMILY` apart; a lit bulb with no colour on one side only.
  3. **Effect:** candle against none.
  4. **Brightness band:** both on and levels more than `LEVEL_BAND` apart, unless either side is in a fade or runs the candle.
  5. **Dashboard:** `switch_ranges` or `range_defaults` differ.
  6. **Timing:** a rule 1, 2 or 3 difference at a checkpoint inside a step that is still there at the next aligned checkpoint more than `TICK` later. One that is gone within `TICK` is noted as `timing-slack`.
  7. **Reaction:** for each of the scenario's `proves` pairs, the port's two settled checkpoints must differ in that scope by rule 1, 2, 3 or 4, or by a level change of at least 3 steps in the direction the reference moved. For each `holds` pair, the port's must not differ by rule 1, 2, 3 or 4. This is what catches a press, a hold or a reset that the port ignores.
  8. A settled checkpoint that one side lacks.
- Noted, never failing: `level` (a level difference beyond the old tolerance that rule 4 does not fail), `colour-shade` (a colour difference inside its family), `fade-sampling` (a checkpoint inside a step that one side lacks, or a level inside a fade), `candle-level`, `timing-slack`.
- `gate.py` judges with `compare_flow` and prints `e2e: golden N/N flow agree, flow differences F, noted {...}`; exit 0 only when F is 0, every scenario replayed and the unit tests passed. `gate.py --exact` prints the old exact comparison (with `FadeOffToOnGradual`) for information and never fails on it. The report file lists both.
- Two scenarios are added, because the owner named the morning wake light and overlay resets as flow that must be right and no scenario covers them:
  1. `wake_light`: a room's wake time set inside the night block; advance through the wake fade and past it. Proves the room's lamps change before the day block starts.
  2. `next_block_reset`: the next-block rule on; a person's change of one lamp before a block's fade starts; advance past the block start. Proves the lamp is held before the fade and follows the schedule after it.

  Entities by role from `HouseInfo`, never by name. If the reference cannot run one (a missing role or an unsupported trigger), record that as a named gap in the ledger and go on without it.

- [ ] **Step 1: Write failing tests** in `test_compare.py`, one per rule, on synthetic checkpoints: `test_power_differs_is_flow`; `test_kelvin_against_rgb_is_flow`; `test_kelvin_within_family_is_noted` (2700 against 2900) and `test_kelvin_outside_family_is_flow` (2700 against 4000); `test_candle_against_none_is_flow`; `test_level_inside_band_is_noted` (120 against 150) and `test_level_outside_band_is_flow` (40 against 200); `test_level_in_fade_is_never_flow`; `test_candle_level_is_noted`; `test_timing_within_a_tick_is_noted` and `test_timing_beyond_a_tick_is_flow`; `test_port_must_react_where_the_reference_proves` (reference changes, port stays → flow); `test_port_must_hold_where_the_reference_holds`; `test_missing_fade_tick_is_noted` and `test_missing_settled_checkpoint_is_flow`; `test_dashboard_difference_is_flow`. In `test_golden.py`: the two new scenarios are not vacuous.
- [ ] **Step 2:** Run `python3 -m unittest tests/e2e/test_compare.py` → fail.
- [ ] **Step 3:** Implement `compare_flow`; switch `gate.py` and `golden.replay` to it; add the two scenarios and record them (only they need recording: `compare.py`, `gate.py` and `golden.py` are outside the recording hash, and an unchanged scenario stays valid).
- [ ] **Step 4:** Run `npm run e2e` detached on today's port. Expected: flow differences 0; the 114 known differences all land in `noted` (`fade-sampling` and `level` from the gradual fade, `candle-level` 5). Write the noted counts to the ledger as the baseline. If F is not 0, list each flow difference with its scenario, step and rule, and stop: each is a rule that needs a ruling or a real flow difference in today's port.
- [ ] **Step 5:** Commit: `test(e2e): the gate judges the user flow`.

### Task 2: Remove Breathe and Colour loop

A named behaviour change (spec 1.1.1). Worker: `worker-easy`. Review: one Sonnet pass.

**Files:**
- Modify: `src/domain/transport.ts` (`BulbEffectName`, `BulbEffect.stoppedByName`, `bulbEffect`, the stop list in `stopCommands`), `src/parse/transport.ts:99,305`, `src/domain/native-controls.ts:286-287`, `src/domain/remote-input.ts:192`, `src/domain/ui-state.ts` (`uiChoices`), comments in `src/runtime/catalog.ts` and `scripts/json-edges.mjs`
- Delete: `tests/runtime/bulb-effects.test.ts`
- Modify tests: `effect-kind.test.ts`, `transport-plans.test.ts`, `firmware-candle.test.ts`, `r4-candle.test.ts`, `review-B4.test.ts`, `catalog.test.ts`, `grouping-ui.test.ts`
- Test: `tests/runtime/removed-effects.test.ts`

**Interfaces:**
- Produces: `BulbEffectName = 'Candle'`. Leaving the candle sends `{"effect":"stop_effect"}` only. `parse/transport.ts`'s effect-name read answers `'Candle'` or `undefined` for every other name, catalogued or not (the "in the catalog but not an effect the bulbs run" refusal goes: any other name is a normal light).
- The dashboard's effect choices (`uiChoices`, which hands on the catalog's own list) and the remote's preset choices never list `Breathe` or `Colour loop`, whatever the catalog lists.

- [ ] **Step 1: Write failing tests.**
  - `removed-effects.test.ts`:
    - `a saved profile naming Breathe shows the lamp's normal light`: frame plan for a target whose brightness source is `{kind:'effect', effect:'Breathe', intensity: 90}` with `Breathe` in the catalog → payload `{ brightness: <the source's value>, color_temp: …, transition: … }`, no raise, no `effect` publish.
    - `a lamp the runtime sensor says is running Colour loop is told to stop nothing`: previous assignment `{effect:'Colour loop'}` → no stop command.
    - `leaving Candle sends stop_effect once per on bulb`, and no `stop_colorloop`.
    - `the dashboard and the remote offer no removed effect`: catalog effects `Candle, Breathe, Colour loop, Normal light` → choices hold neither removed name.
- [ ] **Step 2:** Run `npm test` → the new tests fail.
- [ ] **Step 3:** Remove the two effects at the sites above; delete or rewrite the listed tests' Breathe and Colour loop cases (count them in the commit message).
- [ ] **Step 4:** Run `npm run check && npm test` → green, ceilings lowered where they fell. Run `npm run e2e` detached → flow differences 0.
- [ ] **Step 5:** Commit: `feat(lighting)!: remove Breathe and Colour loop`.

### Task 3: Move the script-shaped code to `src/legacy/`

Mechanical. No logic changes. Worker: `worker-easy`. Review: the controller reads the diff stat and the gate; no reviewer.

**Files:**
- Move (`git mv`): every file directly in `src/domain/` except `blocks.ts` → `src/legacy/domain/` (the `src/domain/types/` folder stays)
- Modify: every import of a moved file (in `src/` and `tests/runtime/`); `scripts/domain-types.mjs`, `domain-words.mjs`, `item-order.mjs`, `json-edges.mjs`, `effects-edge.mjs`, `stringified.mjs` and their allow and ceiling files; `package.json`
- Create: `scripts/domain-imports.mjs`, `scripts/legacy-files.json`
- Test: `tests/runtime/domain-imports.test.ts`

**Interfaces:**
- Produces: `src/domain/` holds only `blocks.ts` and `types/`. Everything later tasks add there is new architecture.
- Guards after the move: the ratchets that counted old sins in `src/domain/` (`domain-words.ceilings.json`, the ceilings in `domain-types.allow.json`) now see a clean folder; set every ceiling to what it counts there and delete allow entries for moved files. `src/legacy/` is not held to the domain guards: it is deleted in M3 and M5.
- `scripts/domain-imports.mjs` (TypeScript compiler API like the other guards), run by `npm run check`:
  1. a file under `src/domain/` imports only from `src/domain/`;
  2. nothing under `src/domain/` or `src/adapter/` imports from `src/legacy/`, except the files `scripts/legacy-files.json` lists under `bridges` (M2 and M3 name them);
  3. `src/legacy/` holds only the files `scripts/legacy-files.json` lists under `files`. The list may only shrink.

- [ ] **Step 1: Write failing tests** in `domain-imports.test.ts` (against fixture trees, like `item-order.test.ts`): a domain file importing `../runtime/x.ts` fails; one importing `./types/ids.ts` passes; a domain file importing `../legacy/domain/x.ts` fails; a legacy file not on the list fails.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Move the files, fix the imports, write the guard and the list, reset the ceilings.
- [ ] **Step 4:** Run `npm run check && npm test` → green, the same test count as before plus the new file's. Run `npm run e2e` detached → flow differences 0.
- [ ] **Step 5:** Commit: `refactor(lighting): script-shaped modules move to src/legacy`.

### Task 4: Light, time and effect types

Types and two small implementations; no lamp changes. Worker: `worker-easy`. Review: one Sonnet pass.

**Files:**
- Create: `src/domain/types/time.ts`, `src/domain/effect.ts`
- Modify: `src/domain/types/light.ts`, `src/parse/ids.ts` (constructors)
- Test: `tests/runtime/effect.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types/time.ts
  export type Instant = Ranged<'Instant'>;      // seconds since the epoch, finite: the unit today's schedule arithmetic runs on
  export type Seconds = Ranged<'Seconds'>;      // a duration, finite, not negative
  export type TimeOfDay = { readonly hour: Ranged<'Hour'>; readonly minute: Ranged<'Minute'> };   // 0..23, 0..59
  export type Timezone = Id<'Timezone'>;        // an IANA zone id

  // types/light.ts (added)
  export type ColourChannel = Ranged<'ColourChannel'>;   // 0..255, finite; not whole, a blend can land between
  export type RGB = { readonly red: ColourChannel; readonly green: ColourChannel; readonly blue: ColourChannel };
  export type Colour = { kind: 'kelvin'; kelvin: Kelvin } | { kind: 'rgb'; rgb: RGB };
  export type Power = 'on' | 'off';
  export type Transition = { kind: 'scheduled fade'; over: Seconds } | { kind: 'manual' } | { kind: 'effect start' };
  export const MANUAL_FADE: Seconds;        // 0.2
  export const EFFECT_START_FADE: Seconds;  // 0.4
  /** A light as a block or a profile saves it. Brightness is HA's 0..255, as saved; M2 turns it into a Level where today's code does. */
  export type SceneLight = { power: 'off' } | { power: 'on'; brightness: Brightness; colour: Colour | undefined };
  export type OnLight = { power: 'on'; level: Level; colour: Colour; effect: Effect; transition: Transition };
  export type LampLight = { power: 'off' } | OnLight;

  // effect.ts
  export type EffectName = 'Candle' | 'Normal';
  export type Firmware = 'candle' | 'stock';
  export type BulbInfo = { readonly bulb: BulbId; readonly firmware: Firmware };
  export type BulbAppearance = { power: 'off' } | { power: 'on'; level: Level; colour: Colour; firmwareEffect: 'none' | 'candle' };
  export interface Effect {
    readonly name: EffectName;
    canRunOn(bulb: BulbInfo): boolean;
    appearance(light: OnLight, bulb: BulbInfo): BulbAppearance;
  }
  export const normal: Effect;   // level and colour as given, firmwareEffect 'none'; runs on every bulb
  export const candle: Effect;   // level and colour as given, firmwareEffect 'candle'; runs on candle firmware only
  /** What one bulb of a lamp shows: the lamp's effect where the bulb can run it, the normal light where it cannot. */
  export function bulbAppearance(light: LampLight, bulb: BulbInfo): BulbAppearance;
  /** The effect a saved name stands for. The one place a name becomes an effect. */
  export function effectNamed(name: EffectName): Effect;
  ```
- `OnLight.colour` and `LampLight` are as the spec writes them. Whether the lighting state needs a colourless lit lamp or a transition on the off case is decided in M2 with the schedule code in hand, not here.
- `Firmware` is read from the catalog's per-bulb `candle` flag for now. Deriving it from the bulb's reported firmware version is a later change of that one read.
- The sending rule (colour and level first, then the effect, then nothing with On or a brightness move) is the adapter's in M4, not here.

- [ ] **Step 1: Write failing tests** in `effect.test.ts`: `normal shows the light as given`; `candle shows the light as given with the firmware candle`; `a candle lamp shows its normal light on a stock bulb` (Review Focus 5: `bulbAppearance` over one candle and one stock bulb of the same lamp); `an off lamp is off on every bulb`; `effectNamed gives each name its effect`.
- [ ] **Step 2:** Run `npm test` → fail (no module).
- [ ] **Step 3:** Add the types and their constructors (`toInstant`, `toSeconds`, `toTimeOfDay`, `toTimezone`, `toColourChannel` in `src/parse/ids.ts`, each checking its range). Implement `effect.ts`.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(domain): light, time and effect types; Candle and Normal`.

### Task 5: Config, overlays, Model and Msg

Types only, plus the fixture every later test builds on. This is the task that carries the overlay flow. Worker: `worker-hard`. Review: one advisor pass on `overlays.ts` and `model.ts` against the flow section above and Global Constraints 6, 7 and 12.

**Files:**
- Create: `src/domain/config.ts`, `src/domain/overlays.ts`, `src/domain/model.ts`, `tests/runtime/fixtures/synthetic-house.ts`
- Modify: `src/domain/types/lighting-state.ts`, `src/domain/types/ids.ts` and `src/parse/ids.ts` (`DashboardControlId`, `StepCount`), `domain-types.allow.json` only with a stated reason per entry
- Test: `tests/runtime/model.test.ts`

**Interfaces:**
- Consumes: Task 4's types; existing `Block`, `RoomOrHouse`, `Step`, `RemoteSource`, `RemotePress`, `Percent`, `PercentRange`, `Minutes`, `Brightness`.
- Produces, config:
  ```ts
  // config.ts
  export type Config = {
    timezone: Timezone;
    house: Schedule;
    rooms: Record<RoomId, Room>;
    lamps: Record<LampId, Lamp>;
    switches: Record<SwitchId, Switch>;
    remotes: Record<RemoteId, Remote>;
    overlayReset: OverlayReset;
    warmEnd: RGB;                 // the warm end of the cosy-day blend, and the colour a candle holds
  };
  export type Schedule = Record<Block, BlockSchedule>;
  /** A start is absent when its helper holds no time: the block then never starts on those days. */
  export type BlockSchedule = { weekdayStart: TimeOfDay | undefined; weekendStart: TimeOfDay | undefined; fade: Minutes; light: SceneLight | undefined; switchesOn: boolean };
  /** A room follows the house for a block's timing or light unless it has its own. */
  export type OwnOrHouse<T> = { follows: 'house' } | { follows: 'own'; own: T };
  export type BlockTiming = Pick<BlockSchedule, 'weekdayStart' | 'weekendStart' | 'fade'>;
  export type RoomBlock = { timing: OwnOrHouse<BlockTiming>; light: OwnOrHouse<SceneLight | undefined>; switchesOn: OwnOrHouse<boolean> };
  export type Room = { blocks: Record<Block, RoomBlock>; wakeLight: WakeLight | undefined; private: boolean };
  export type WakeLight = { at: Instant; fade: Minutes };
  export type Lamp = { room: RoomId | undefined; bulbs: readonly BulbInfo[] };
  export type Switch = { room: RoomId | undefined };
  export type Remote = { room: RoomId | undefined; source: RemoteSource };   // no room: the remote does nothing
  /** The three rules that end overlays; each is on or off. */
  export type OverlayReset = { atNextBlock: boolean; atSetTime: boolean; afterAge: Minutes | undefined };
  ```
- Produces, overlays. Every field below is one today's code reads; the comment names the stored field and its reader.
  ```ts
  // overlays.ts
  export type Overlays = {
    /** A block held over a room or the house: at most one each. */
    blocks: Partial<Record<RoomOrHouse, BlockOverlay>>;
    /** Each remote's input for its room. Only the newest one per room applies. */
    remotes: readonly RemoteOverlay[];
    /** A light or the candle set on a lamp or a room by a person or from the dashboard. */
    lamps: readonly LampOverlay[];
    /** A room switched off or on. A room not listed is on. */
    roomPower: Partial<Record<RoomId, Power>>;
  };

  /** `since` is when the overlay was last set (stored `when`): what the next-block and after-age resets measure. */
  export type BlockOverlay = { block: Block; since: Instant };

  export type RemoteOverlay = {
    source: RemoteSource;                    // the key: one overlay per remote
    room: RoomId;                            // stored target
    since: Instant;
    stepRange: StepRange;                    // stored step_range; default -20..20
    adjustment: RemoteAdjustment | undefined; // brighter/dimmer; none before the first such press
    preset: RemotePreset;                    // what the left/right arrows chose
    /** What each preset held when the remote last left it (stored preset_contexts), restored on return. */
    remembered: Partial<Record<PresetChoice, RememberedPreset>>;
  };
  export type StepRange = { readonly min: Step; readonly max: Step };   // min not above max
  export type RemoteAdjustment = {
    steps: StepCount;                        // net presses, -40..40; positive is brighter
    lower: Step; upper: Step;                // how far the presses may still go each way
    from: 'day' | 'cosy' | 'current';        // where on the blend step zero sits (stored anchor)
    at: Instant;                             // stored updated: orders it against other overlays
    lastPress: 'up' | 'down' | undefined;
    everBrighter: boolean;                   // stored has_up: the dim-below-cosy rule reads it
  };
  export type PresetChoice = 'day' | 'cosy' | 'candle';
  export type RemotePreset =
    | { choice: 'none' }
    /** Day or cosy: holds that block for the room, like a block overlay (stored period, period_updated). */
    | { choice: 'day' | 'cosy'; since: Instant }
    /** The candle on the room's lamps; `adjustment` is the brightness input it started from (stored selection_input). */
    | { choice: 'candle'; since: Instant; adjustment: RemoteAdjustment | undefined };
  export type RememberedPreset = Exclude<RemotePreset, { choice: 'none' }>;

  export type LampOverlay = {
    over: { kind: 'lamp'; lamp: LampId } | { kind: 'room'; room: RoomId };
    /** A person's HA change (one per lamp or room), or a dashboard control (one per control). */
    from: { kind: 'person' } | { kind: 'dashboard'; control: DashboardControlId };
    since: Instant;
    brightness: BrightnessOverlay | undefined;   // undefined: this overlay leaves brightness alone
    colour: ColourOverlay | undefined;
  };
  /** `at` is when this part was last set (the stored per-channel `updated`): the newest part wins per lamp. */
  export type BrightnessOverlay =
    | { kind: 'fixed'; brightness: Brightness; at: Instant }
    /** The candle. `runsAt` is the brightness it runs at (stored intensity, else the fixed value kept underneath). */
    | { kind: 'candle'; runsAt: Brightness | undefined; at: Instant }
    /** Back to the schedule's brightness, over any older overlay. */
    | { kind: 'schedule'; at: Instant };
  export type ColourOverlay =
    | { kind: 'fixed'; colour: Colour; at: Instant }
    /** The candle's warm colour. */
    | { kind: 'candle'; at: Instant }
    | { kind: 'schedule'; at: Instant };

  /** The mode overlay: one colour on every lamp outside private rooms and outside the night block. */
  export type ModeOverlay = { active: false } | { active: true; since: Instant };
  ```
- Produces, model:
  ```ts
  // model.ts
  export type Model = {
    config: Config; overlays: Overlays; modeOverlay: ModeOverlay;
    remotes: Record<RemoteId, RemoteModel>;
    switchRanges: Record<SwitchId, RangeRule>; rangeDefaults: RangeDefaults;
    lampProfiles: Record<LampId, Record<Block, LampProfile>>;
  };
  export type RangeRule = { kind: 'bright' } | { kind: 'cosy' } | { kind: 'custom'; range: PercentRange };
  export type RangeDefaults = Record<'bright' | 'cosy', PercentRange>;
  /** A lamp's saved light for a block: the room's, or its own with the effect it runs. */
  export type LampProfile = { follows: 'room' } | { follows: 'own'; light: SceneLight; effect: EffectName };
  /** A remote's press state: a chord in progress, the power presses counted so far, and the preset button's position. */
  export type RemoteModel = {
    chord: { active: false } | { active: true; step: Step };
    powerPresses: Ranged<'PowerPresses'>;      // whole, 0 and up
    presetButton: PresetButton | undefined;    // none pressed yet
  };
  /** The preset buttons, warmest last: each stands for one colour temperature (today's `presets` table in gestures.ts). */
  export type PresetButton = 'coolest' | 'cool' | 'neutral' | 'warm' | 'warmest';
  export type Msg =
    | { kind: 'clock'; now: Instant }
    | { kind: 'configChanged'; config: Config }
    | { kind: 'overlayRequested'; request: OverlayRequest }
    | { kind: 'lampChangedByPerson'; lamps: readonly LampId[]; light: RequestedLight }
    | { kind: 'remotePressed'; remote: RemoteId; press: RemotePress }
    | { kind: 'switchButtonPressed'; switch: SwitchId; power: Power }
    | { kind: 'modeToggled'; on: boolean }
    | { kind: 'rangeSaved'; switch: SwitchId; rule: RangeRule }
    | { kind: 'lampProfileSaved'; lamp: LampId; block: Block; profile: LampProfile };
  export type OverlayRequest =
    | { kind: 'hold block'; over: RoomOrHouse; block: Block }
    | { kind: 'clear all' }
    | { kind: 'dashboard control'; overlay: Omit<LampOverlay, 'since'> };
  /** What a person's HA call set: a brightness, a colour, the candle, or back to the normal light. At least one part is present. */
  export type RequestedLight = { brightness: Brightness | undefined; colour: Colour | undefined; effect: EffectName | undefined };

  // types/lighting-state.ts (added)
  export type LightingState = { lamps: Record<LampId, LampLight>; switches: Record<SwitchId, Power> };
  ```
- Left out of the `Model` on purpose, each for a stated reason:
  1. Who set an overlay (`who`, `via`) and when it was first made (`created`): no lighting rule reads them. A remote's overlay is known by its kind, not by `via`.
  2. An effect's `instance` text: it existed to restart a re-selected effect, and re-selecting now keeps it running.
  3. The remote overlay's `remote_valid_until` and `remote_timing_revision`: a cache of the schedule's next fade start.
  4. Old stored shapes no code writes any more (`light` overlays, a remote's `channels` overlay, a `scale` part, `legacy_position`, `legacy_channels`, a house-wide lamp overlay): Task 7's codec leaves them in the bytes and they take no part. An after-age reset removes them like any overlay.
  5. The bookkeeping in the overrides and runtime sensors (`applied`, revision, generation, pending rooms, acknowledgements, room caches): Task 7's codec carries it.
- If the worker finds a stored field that a lighting rule reads and that has no home above, it stops and reports the field and its reader; it does not add a loose field.

- [ ] **Step 1: Write failing tests.**
  - `model.test.ts`: builds `syntheticHouse()` and asserts it type-checks as `Model` and that every `Msg` kind can be built against it (one value per kind, `satisfies Msg`). As `// @ts-expect-error` lines: `an off scene has no brightness`, `an off lamp has no level`, `a day preset has no adjustment of its own`, `a fixed brightness needs a brightness`, `an inactive mode overlay has no since`.
- [ ] **Step 2:** Run `npm test` → fail (no modules).
- [ ] **Step 3:** Write the three domain files and `syntheticHouse(): Model`: two rooms, one private; one room with its own timing and light for one block; three lamps, one with a candle bulb and a stock bulb; one switch with a custom range; one remote with a room and one without. Overlays: a block held over one room; a remote overlay with an adjustment and the candle preset, remembering its day preset; a person's lamp overlay with a fixed brightness and colour; a dashboard lamp overlay with the candle on brightness and the schedule's colour; one room switched off; the mode overlay active.
- [ ] **Step 4:** Run `npm run check && npm test` → green. `node scripts/domain-types.mjs --list` shows no uncovered site in the new files.
- [ ] **Step 5:** Commit: `feat(domain): Config, overlays, Model and Msg`.

### Task 6: Config codec

Worker: `worker-easy` once Task 5's types are merged. Review: one Sonnet pass.

**Files:**
- Create: `src/adapter/codecs/config.ts`
- Modify: `scripts/json-edges.mjs` (`src/adapter/` is an edge)
- Test: `tests/runtime/config-codec.test.ts`

**Interfaces:**
- Consumes: Task 5 `Config` and parts; `Catalog` and `parseCatalog` from `src/runtime/catalog.ts`; `Rooms` from `src/parse/rooms.ts`; the accessors in `src/runtime/parse.ts`; constructors in `src/parse/ids.ts`.
- Produces:
  ```ts
  /** The HA state the config is read from: each helper's state and attributes, the registry's rooms, the labels. */
  export type ConfigSource = { states: Readonly<Record<string, EntityState>>; rooms: Rooms; labels: Readonly<Record<string, readonly string[]>>; timezone: string | undefined };
  export function decodeConfig(source: ConfigSource, catalog: Catalog): Config;
  /** Where each bulb is reached. Sending is the adapter's, so this is not in Config. */
  export function bulbTopics(catalog: Catalog): Record<BulbId, string>;
  export const DEFAULT_FADE: Minutes;          // 20, today's fallback
  export const DEFAULT_OVERLAY_AGE: Minutes;   // 180, today's fallback
  ```
- Helper names are built here from room and block (`ls_<scope>_<block>_start`, `_weekend`, `_fade`, `_own_timing`, `_own_light`, `_on_off`, the block light text, the wake helpers, the three overlay reset helpers), exactly the names `src/legacy/domain/schedule.ts`, `src/parse/schedule.ts` and `src/handlers/automations.ts` read today. No helper name appears in `src/domain/`.
- Rules, each from today's code: a start that is not `HH:MM` with hour ≤ 23 and minute ≤ 59 → `undefined`; a fade that is not a number → `DEFAULT_FADE`; an own-flag helper not `on` → `follows: 'house'`; a block light that is off → `{ power: 'off' }`, on without a colour → `colour: undefined`, missing or unreadable → `undefined`; warm end not three numbers → `255, 126, 0`; timezone absent → today's default zone; a remote whose device has no room → `room: undefined`; the after-age rule off → `afterAge: undefined`, on with an unreadable limit → `DEFAULT_OVERLAY_AGE`; a room is private when the private-rooms label names it. The catalog is strict: a bulb in two lamps is refused by `parseCatalog` as today.
- Decode only. The port never writes these helpers.

- [ ] **Step 1: Write failing tests**, one per rule above, on synthetic ids, with inputs in the wire shapes the existing tests use (`off-lamp-schedule.test.ts`, `r4-schedule-saved.test.ts`, `recover-helpers.test.ts`, `private-rooms.test.ts`): `a start of 24:00 is no start`; `an unreadable fade is twenty minutes`; `a room without its own timing follows the house`; `an off block light has no colour` and `a lit block light with no colour has none` (Review Focus 2); `a helper that is unavailable is its default` (Review Focus 3); `a remote with no room has none`; `each overlay reset rule reads its own helper`; `a bulb in two lamps is refused`; `bulbTopics lists every bulb with a topic`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Implement `decodeConfig` and `bulbTopics`; add `src/adapter` to the JSON-edge guard's edge list.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(adapter): config codec`.

### Task 7: State codecs and the fields shared with the old scripts

Worker: `worker-hard`. Review: one Opus pass (a wrong write here breaks rooms the old scripts still drive, and a wrong read loses part of the overlay flow).

**Files:**
- Create: `lighting-scripts/docs/sensor-fields.md` (YAML front matter: `kind: inventory`, `date`, `milestone: M1`), `src/adapter/codecs/overrides-sensor.ts`, `src/adapter/codecs/lamp-profiles.ts`, `src/adapter/codecs/remote-helpers.ts`, `src/adapter/codecs/model.ts`
- Test: `tests/runtime/overrides-sensor-codec.test.ts`, `lamp-profiles-codec.test.ts`, `remote-helpers-codec.test.ts`

**Interfaces:**
- Consumes: Task 5 `Model`, `Overlays` and each overlay kind, `ModeOverlay`, `RangeRule`, `RangeDefaults`, `LampProfile`, `RemoteModel`; Task 6 `decodeConfig`, `ConfigSource`; `parseOverlayKey` (`src/parse/overlay-key.ts`); live rooms from `src/parse/live-rooms.ts`.
- Produces:
  ```ts
  // overrides-sensor.ts
  export type OverridesState = Pick<Model, 'overlays' | 'modeOverlay' | 'switchRanges' | 'rangeDefaults'>;
  export function decodeOverrides(attributes: JsonObject | undefined, config: Config): OverridesState;
  /** The sensor's attributes with this state written in. Stored overlays of rooms outside `live`, those of no known shape and every attribute the Model does not own come from `found` unchanged. */
  export function encodeOverrides(state: OverridesState, found: JsonObject, live: ReadonlySet<RoomId>): JsonObject;
  // lamp-profiles.ts
  export function decodeLampProfile(storeText: string): LampProfile;
  export function encodeLampProfile(profile: LampProfile, foundText: string): string;
  // remote-helpers.ts
  export function decodeRemoteModel(source: ConfigSource, room: RoomId): RemoteModel;
  export type HelperWrite = { helper: RemoteHelper; value: HelperValue };   // RemoteHelper: a closed union of the four remote helpers
  export function remoteHelperWrites(before: RemoteModel, after: RemoteModel): HelperWrite[];
  // model.ts
  export function decodeModel(source: ConfigSource, catalog: Catalog): Model;
  ```
- Stored overlay → type, by the stored key and kind:

  | # | Stored | Becomes |
  |---|---|---|
  | 1 | key `block:<room or house>`, value a block (any case) | `overlays.blocks[<room or house>]`, `since` = `when` |
  | 2 | kind `input`, key `channels:<remote source>`, scope `room` | a `RemoteOverlay`: `step_range` → `stepRange`; `adjustment` → `adjustment` (`anchor` → `from`, `updated` → `at`, `last` → `lastPress`, `has_up` → `everBrighter`); `selection` `day`/`cosy` with `period_updated` → that preset; `selection` `Candle` with `selection_updated`, `selection_input` → the candle preset; `preset_contexts` → `remembered` |
  | 3 | kind `channels`, key `channels:native:<lamp or room:<room>>` | a `LampOverlay` `from: person`; each of `channels.brightness`, `channels.color`: `constant` with a value → `fixed`, `constant` without → `schedule`, `effect` `Candle` → `candle` (`runsAt` = `intensity`, else the fixed value in `underlying`); `updated` → `at` |
  | 4 | kind `channels`, key `channels:ui:<control>` | the same, `from: dashboard` with the control's id |
  | 5 | key of the mode overlay | `modeOverlay` active, `since` = `when` |
  | 6 | attribute `power` | `overlays.roomPower` |
  | 7 | attributes `switch_ranges`, `range_defaults` | `switchRanges`, `rangeDefaults` |
  | 8 | anything else (rows 4 and 5 of Task 5's left-out list, unknown kinds, unknown keys) | not in the `Model`; kept in the bytes |

- Encoding writes back the stored fields the left-out list names (`who`, `via`, `created`, `instance`, the remote's cache fields) from `found` when the overlay was there before, and with today's writers' values when it is new (`state-store.ts` `planCommit`, `remote-input.ts`, `native-controls.ts`).
- Defaults, named constants beside their decoder: `overrides` not a mapping → no overlays; a `when` or `updated` that is not a date or number → the epoch (today's `as_timestamp(when, 0)`), so the next reset ends it; a saved block that is not a block → the overlay is not in the `Model`; an adjustment whose steps or bounds are out of range → `adjustment: undefined`; an `anchor` that is none of the three → `current`; an effect name that is not `Candle` → that part is `schedule`; a custom range whose bounds are not an ordered pair in 0..100 → the switch has no rule; range defaults out of order → today's defaults; a profile store that is not JSON or not a mapping → `{ follows: 'room' }`; a saved effect that is not `Candle` → `Normal`; a remote helper in `unknown` or `unavailable` → today's fallbacks (`gestureState` in `src/parse/gestures.ts`).
- A custom range bound saved as a boolean (today's `Percent | boolean`) decodes through the same check the old code runs and encodes back as found unless the rule changed.
- `sensor-fields.md` is the checklist for `encodeOverrides`: one row per attribute and per stored overlay field of the overrides sensor, the runtime sensor and the room cache sensors, with columns `field`, `read by` (old script names), `across rooms` (yes/no), `owner` (`Model.<path>`, `left out: <reason number>` or `carried`). Entity names are written with `<room>` and `<lamp>`. It is built by searching the old scripts in `reference/live/` (private; only field and script names leave it). A field that a lighting rule reads and that has no owner stops the task (see Task 5).

- [ ] **Step 1:** Write `sensor-fields.md`. Any field that is `across rooms: yes` and has no `Model` owner is `carried`; list those at the top, they are what the M6 compatibility writer keeps valid.
- [ ] **Step 2: Write failing tests.** Inputs are the stored shapes the existing tests already use (`r4-commit.test.ts`, `r4-remote-plan.test.ts`, the mode overlay's test, `lighting-state.test.ts`, `native-control-effects.test.ts`, `ls-store-boundary.test.ts`, `gestures-reducer.test.ts`), with synthetic ids.
  - One decode test per row of the golden table in "The overlay flow", named for its scenario, on the store that scenario's steps leave: `person change: a fixed brightness and colour on one lamp, the room on`; `remote presses: an adjustment after brighter then dimmer; the room off after the power toggle; nothing after reset; the mode overlay after the mode press`; `dashboard block: the house and each room hold night; clear all leaves none`; `mode toggle: active with its since, then inactive`; `range save: a bright rule on the switch`; `restart: decoding twice from the same attributes gives equal state`.
  - One decode test per part no golden scenario covers that has a stored shape (gaps 3, 4, 6, 9, 10): `a dashboard control's candle on one lamp`; `the candle preset remembers the day preset it left`; `a block held over one room only`; `two overlays on one lamp keep their own times`; `a person's change of a whole room is one room overlay`.
  - Round trip: for a well-formed store holding one overlay of each kind, `encodeOverrides(decodeOverrides(a, config), a, allRooms)` deep-equals `a`; and after one change to one overlay, only that overlay's stored fields differ.
  - `a stored overlay of a room that is not live is left exactly as found` and `attributes the Model does not own are left exactly as found` (Review Focus 4): `JSON.stringify` equal, key order included.
  - Garbage, one test per default above (Review Focus 3), each also asserting the encode keeps the garbage bytes when nothing changed.
  - `an off profile has no brightness and no colour`; `a lit profile with no colour has none` (Review Focus 2); `a saved Breathe is Normal`.
  - `remoteHelperWrites` writes only the helpers that changed, in the order today's reducer writes them.
  - `decodeModel(syntheticSource(), syntheticCatalog())` deep-equals Task 5's `syntheticHouse()` (the fixture gains the wire form it decodes from).
- [ ] **Step 3:** Run `npm test` → fail.
- [ ] **Step 4:** Implement the four codec files.
- [ ] **Step 5:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → flow differences 0.
- [ ] **Step 6:** Commit: `feat(adapter): codecs for the overrides sensor, lamp profiles and remote helpers`.

## After M1

1. The codecs meet real house data for the first time in M2, when `lightingState` reads the `Model` under the golden scenarios. M1 builds no live-data check.
2. M2 to M6 follow in `docs/superpowers/plans/2026-11-22-m2-m6-redesign-build.md`. M2 Task 2 decides whether `LampLight` needs a colourless lit case.
