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

**Goal:** The lighting port gets its real domain types (`Model`, `Msg`, `LampLight`, `Colour`, `Effect` with Candle and Normal) and the codecs that read and write them from the Home Assistant (HA) sensors and helpers; Breathe and Colour loop are removed.

**Architecture:** M1 is additive beside the running port. New pure types go in `src/domain/` (importing nothing outside it), new codecs in `src/adapter/codecs/`. The script handlers keep driving the lamps until M2 and M3 replace them, so only two things change what a lamp does: Breathe and Colour loop go (Task 1) and the firmware candle starts at the old candle's level (Task 2). Nothing calls the codecs at run time yet; M2's `lightingState` is their first reader.

**Tech Stack:** TypeScript 5.9 on Node 22 (`--experimental-strip-types`), `node:test`, the guards in `npm run check`, the M0 golden gate (`npm run e2e`, Python, inside `nix develop`).

**Spec:** `docs/superpowers/specs/2026-11-22-lighting-architecture-design.md`, sections 3, 4 and 7.2. Decisions made after approval are in section "Decisions since the spec" below; where they differ from the spec, they win.

## Decisions since the spec

1. Fuzzing is stopped. The 13 golden scenarios are the acceptance proof. Read "golden and fuzz" in the spec as "golden".
2. Spend with discernment: few sizeable tasks, reviews scaled to risk, no polish tasks, no machinery beyond what M1 needs.
3. Today's algorithms are moved and re-typed in M2, not reinvented. M1 moves none of them except the candle level (Task 2).
4. The firmware candle starts at the old software candle's level, computed with the old candle renderer's maths. Colour and level first, then `effect: channel_change`.

## Global Constraints

1. The repo is public. No household names, area ids, entity ids of real devices, device addresses or friendly names in any committed file, test or commit message. Tests use synthetic ids (`room-a`, `lamp-a`, `bulb-a1`, `plug-a`, `remote-a`). The mode overlay is called "mode overlay" in new code and docs.
2. `reference/`, `.runtime/` and `*report.json` are never committed or quoted.
3. Every task leaves `npm run check` and `npm test` green. A guard ceiling that falls is lowered to the new count in the same commit; none may rise.
4. Golden gate (`npm run e2e`, detached with `systemd-run --user` and `~/.claude/scripts/wait-for`, log in `/tmp/v1work/`): today 13 scenarios, 114 raw differences = 109 under the approved `fade-off-to-on-gradual` adjustment + 5 unexplained (the candle lamp's level, all in `candle_lamp_evening`). After Task 1: unchanged (5). After Task 2: 0 unexplained. Tasks 3 to 5 add no code the handlers reach; the gate is run once more after Task 5 and must still read 0. The adjustment count stays 109. A number that gets worse stops the task.
5. The old per-script parity (`npm run parity`) is no longer a gate and is not run.
6. Vocabulary: schedule, block, transition, wake light, effect, bulb, lamp, room, switch, remote, lighting state, overlay, overlay reset, dashboard, config. No "plan", "dispatch", "render", "intent" or "action" in a new name.
7. Types: tagged sum types, branded ids, range types. No plain `string` or `number` in a new exported domain signature (strings only for free text). No `?: never` unions, no wire keys, no snake_case, no tuples kept because the wire sends one, no `Verbatim`, no optional field that exists only because JSON may omit it. Off has no level and no colour. A missing colour is `Colour | undefined`, never a stand-in.
8. Presence is tested with `=== undefined`. No truthiness, no `??` standing in for "absent". Jinja's `or` goes through `jinjaTruthy`.
9. Parse, don't validate. JSON appears only in `src/adapter/`, `src/parse/`, `src/runtime/` and `src/live.ts`. A codec returns domain types and never the unparsed type.
10. Values a person can change at run time (helpers, dashboard controls, the stores they write) recover to a named default and never raise. The catalog is refused at load when malformed.
11. Reading order (enforced by `scripts/item-order.mjs`): a type first, then the functions coupled to it; a callee below its caller; a single-use helper inside its caller; public entry points first; tables after their types. A function that always throws says so in its name. No args records.
12. A module in `src/domain/` is one concept, named for it.
13. Range and id constructors stay in `src/parse/ids.ts`; only `src/parse/` and `src/adapter/` call them.
14. Workers commit only (one commit per task unless a step names its own); the controller pushes. Commit trailers name the model that wrote them. Each worker brief embeds `session-constraints.md` verbatim and is sense-checked by the advisor first.
15. Scope is M1. No `update`, no `lightingState`, no reconciler, no moving of schedule, blend or resolution code.

## Review Focus

1. **Saved state that still names a removed effect.** A lamp profile, an overlay or the runtime sensor holding `Breathe` or `Colour loop` after Task 1: the lamp shows its normal light, an effect it was running is stopped once, and nothing raises. Test in Task 1.
2. **A lit light with no colour.** A block light or lamp profile that is on with a brightness and no colour decodes with `colour: undefined`; an off one has neither level nor colour. No white is invented. Tests in Tasks 4 and 5.
3. **Garbage in the stores.** The overrides sensor's `overrides` not a mapping, a record of an unknown kind, a `when` that is not a date, a profile store that is not JSON or not a mapping, a helper in `unknown` or `unavailable`: each decodes to its named default and encodes back without loss of the stored bytes. Tests in Tasks 4 and 5.
4. **Rooms the port does not drive.** Encoding a `Model` leaves every record of a non-live room, and every attribute the `Model` does not own, exactly as found. Test in Task 5.
5. **A candle lamp with a bulb that cannot flicker.** A lamp whose bulbs mix candle and stock firmware shows the candle on the first kind and its normal light on the others. Test in Task 2.

## File map

| # | File | Holds | Task |
|---|---|---|---|
| 1 | `src/domain/types/time.ts` (new) | `Instant`, `Seconds`, `TimeOfDay`, `Timezone` | 2 |
| 2 | `src/domain/types/light.ts` (extend) | `RGB`, `Colour`, `Power`, `Transition`, `SceneLight`, `OnLight`, `LampLight` | 2 |
| 3 | `src/domain/effect.ts` (new) | `Effect`, `EffectName`, `BulbInfo`, `BulbAppearance`, `normal`, `bulbAppearance` | 2 |
| 4 | `src/domain/candle.ts` (new) | `candle`, `CandleStart`, `candleStartLevel` | 2 |
| 5 | `src/domain/config.ts` (new) | `Config` and its parts | 3 |
| 6 | `src/domain/overlays.ts` (new) | `Overlays`, each overlay kind, `ModeOverlay` | 3 |
| 7 | `src/domain/model.ts` (new) | `Model`, `Msg`, `RemoteModel`, `LampProfile`, `RangeRule`, `RangeDefaults` | 3 |
| 8 | `src/domain/types/lighting-state.ts` (extend) | `LightingState` | 3 |
| 9 | `src/adapter/codecs/config.ts` (new) | helpers and catalog → `Config` | 4 |
| 10 | `src/adapter/codecs/overrides-sensor.ts`, `lamp-profiles.ts`, `remote-helpers.ts` (new) | sensors and stores ↔ the rest of `Model` | 5 |
| 11 | `scripts/domain-imports.mjs` (new), `scripts/json-edges.mjs` | the domain import rule; `src/adapter/` as a JSON edge | 3, 4 |

Existing files keep their names until M2 and M3 delete them. The old `EffectName` id in `types/ids.ts` (a catalog name) and the old `Model`/`Msg` in `gestures.ts` stay where they are; new code imports the new ones from `effect.ts` and `model.ts`.

---

### Task 1: Remove Breathe and Colour loop

A named behaviour change (spec 1.1.1). Worker: `worker-easy`. Review: one Sonnet pass.

**Files:**
- Modify: `src/domain/transport.ts` (`BulbEffectName`, `BulbEffect.stoppedByName`, `bulbEffect`, the stop list in `stopCommands`), `src/parse/transport.ts:99,305`, `src/domain/native-controls.ts:286-287`, `src/domain/remote-input.ts:192`, `src/domain/ui-state.ts` (`uiChoices`), comments in `src/runtime/catalog.ts` and `scripts/json-edges.mjs`
- Delete: `tests/runtime/bulb-effects.test.ts`
- Modify tests: `effect-kind.test.ts`, `transport-plans.test.ts`, `firmware-candle.test.ts`, `r4-candle.test.ts`, `review-B4.test.ts`, `catalog.test.ts`, `grouping-ui.test.ts`
- Test: `tests/runtime/removed-effects.test.ts`

**Interfaces:**
- Produces: `BulbEffectName = 'Candle'`. Leaving the candle sends `{"effect":"stop_effect"}` only. `parse/transport.ts`'s effect-name read answers `'Candle'` or `undefined` for every other name, catalogued or not (the "in the catalog but not an effect the bulbs run" refusal goes: any other name is a normal light).
- The dashboard's effect choices (`uiChoices`, which hands on the catalog's own list) and the remote's preset choices never list `Breathe` or `Colour loop`, whatever the catalog lists.

- [ ] **Step 1: Write failing tests** in `removed-effects.test.ts`:
  - `a saved profile naming Breathe shows the lamp's normal light`: frame plan for a target whose brightness source is `{kind:'effect', effect:'Breathe', intensity: 90}` with `Breathe` in the catalog → payload `{ brightness: <the source's value>, color_temp: …, transition: … }`, no raise, no `effect` publish.
  - `a lamp the runtime sensor says is running Colour loop is not told to stop anything it is not running`: previous assignment `{effect:'Colour loop'}` → no stop command.
  - `leaving Candle sends stop_effect once per on bulb`, and no `stop_colorloop`.
  - `the dashboard and the remote offer no removed effect`: catalog effects `Candle, Breathe, Colour loop, Normal light` → choices hold neither removed name.
- [ ] **Step 2:** Run `npm test` → the new tests fail.
- [ ] **Step 3:** Remove the two effects at the sites above; delete or rewrite the listed tests' Breathe and Colour loop cases (count them in the commit message).
- [ ] **Step 4:** Run `npm run check && npm test` → green, ceilings lowered where they fell. Run `npm run e2e` detached → 5 unexplained, 109 adjusted.
- [ ] **Step 5:** Commit: `feat(lighting)!: remove Breathe and Colour loop`.

### Task 2: Light and effect types; the candle starts at the old candle's level

Worker: `worker-hard`. Review: one Opus pass (it changes what a candle lamp shows).

**Files:**
- Create: `src/domain/types/time.ts`, `src/domain/effect.ts`, `src/domain/candle.ts`
- Modify: `src/domain/types/light.ts`, `src/parse/ids.ts` (constructors), `src/domain/transport.ts` (`frameLevel`, `FrameEffect`), `src/parse/transport.ts`, `src/runtime/catalog.ts` (the lamp → candle seed table)
- Test: `tests/runtime/effect.test.ts`, `tests/runtime/candle-level.test.ts`; update `firmware-candle.test.ts`

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
  export const normal: Effect;
  /** What one bulb of a lamp shows: the lamp's effect where the bulb can run it, the normal light where it cannot. */
  export function bulbAppearance(light: LampLight, bulb: BulbInfo): BulbAppearance;

  // candle.ts
  export type CandleSeed = Id<'CandleSeed'>;        // names a lamp's flicker sequence; the catalog's entry for the lamp, else the lamp's id
  export type CandleNoise = Ranged<'CandleNoise'>;  // finite, as the noise helper holds it; CANDLE_NOISE_DEFAULT = 0.8
  export type CandleStart = { readonly at: Instant; readonly seed: CandleSeed; readonly noise: CandleNoise };
  export function candle(start: CandleStart): Effect;
  export function candleStartLevel(setting: Level, start: CandleStart): Level;
  ```
- `OnLight.colour` and `LampLight` are as the spec writes them. Whether the lighting state needs a colourless lit lamp or a transition on the off case is decided in M2 with the schedule code in hand, not here.
- `Effect` values hold functions. Callers compare `BulbAppearance` values, never `Effect` values.
- `candleStartLevel` is the brightness maths of the old `effect_candle_frame` renderer, restored from `git show b00e10a^:lighting-scripts/src/domain/frames.ts` unchanged: `setting` is its `brightness`, `at` its `timestamp`, `seed` its `phase`, `noise` its noise read. It needs SHA-256, so `candle.ts` imports `createHash` from `node:crypto`; that is the one import outside `src/domain/` the Task 3 guard allows, with this reason.
- `candle(start).appearance(light, bulb)` → `{ power: 'on', level: candleStartLevel(light.level, start), colour: light.colour, firmwareEffect: 'candle' }`; `canRunOn` is `bulb.firmware === 'candle'`. `normal.appearance` → level and colour as given, `firmwareEffect: 'none'`; `canRunOn` always true.
- `Firmware` is read from the catalog's per-bulb `candle` flag for now. Deriving it from the bulb's reported firmware version is a later change of that one read.
- M2 seam: `lightingState` chooses the `CandleStart.at` it gives a lamp's candle. M1's send path passes the send instant, as the old renderer was called.

- [ ] **Step 1: Write failing tests.**
  - `candle-level.test.ts`, vectors from the old renderer (`setting, at, seed, noise → level`): `150, 1800000000, 'seed-a', 0.8 → 127`; `150, 1800000000.15, 'seed-a', 0.8 → 118`; `150, 1800000000, 'seed-b', 0.8 → 108`; `120, 1800000000, 'seed-a', 0.8 → 102`; `150, 1800000000, 'seed-a', 0 → 117`; `2, 1800000000, 'seed-a', 0.8 → 2`; `254, 1800000000, 'seed-a', 1 → 220`. Plus `the level is never above the setting and never below a quarter of it` over 200 instants. If a vector disagrees with the code restored verbatim, the restored code wins; report the vector.
  - `effect.test.ts`: `normal shows the light as given`; `candle shows the start level, the light's colour and the firmware candle`; `a candle lamp shows its normal light on a stock bulb` (Review Focus 5: `bulbAppearance` over one candle and one stock bulb); `an off lamp is off on every bulb`.
  - `firmware-candle.test.ts`: the candle's first publish carries `brightness: candleStartLevel(setting, …)` for the test's fixed clock, then `{"effect":"channel_change"}`; nothing after it carries `state` or `brightness`.
- [ ] **Step 2:** Run `npm test` → the new tests fail.
- [ ] **Step 3:** Add the types and their constructors (`toInstant`, `toSeconds`, `toTimeOfDay`, `toTimezone`, `toColourChannel`, `toCandleSeed`, `toCandleNoise` in `src/parse/ids.ts`, each checking its range). Implement `effect.ts` and `candle.ts`.
- [ ] **Step 4:** Commit: `feat(domain): light, time and effect types; Candle and Normal`.
- [ ] **Step 5 (behaviour fix, own commit):** In `src/domain/transport.ts`, the bulb-effect brightness becomes `candleStartLevel(<the intensity as a Level>, { at: <the send instant>, seed, noise })`. The seed comes from the catalog's lamp → phase table (parse it again in `src/runtime/catalog.ts`; absent entry → the lamp's id), the noise from the helper the old renderer read (not a number → 0.8). Check both reads against the call at `b00e10a^:lighting-scripts/src/domain/transport.ts:203-206`.
- [ ] **Step 6:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → 0 unexplained, 109 adjusted. If the candle differences are not 0 after this one change, do not iterate: report the reference and port levels per checkpoint and stop.
- [ ] **Step 7:** Commit: `fix(lighting): the firmware candle starts at the old candle's level`.

### Task 3: Config, overlays, Model and Msg

Types only, plus the fixture every later test builds on. Worker: `worker-hard`. Review: one advisor pass on the types against Global Constraints 6, 7 and 12 (the owner reads these files first).

**Files:**
- Create: `src/domain/config.ts`, `src/domain/overlays.ts`, `src/domain/model.ts`, `scripts/domain-imports.mjs`, `domain-imports.legacy.json`, `tests/runtime/fixtures/synthetic-house.ts`
- Modify: `src/domain/types/lighting-state.ts`, `package.json` (`check` runs `domain-imports.mjs`), `domain-types.allow.json` only with a stated reason per entry
- Test: `tests/runtime/model.test.ts`, `tests/runtime/domain-imports.test.ts`

**Interfaces:**
- Consumes: Task 2's types.
- Produces:
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
    warmEnd: RGB;                 // the colour a candle holds
    candleNoise: CandleNoise;
  };
  export type Schedule = Record<Block, BlockSchedule>;
  /** A start is absent when its helper holds no time: the block then never starts on those days. */
  export type BlockSchedule = { weekdayStart: TimeOfDay | undefined; weekendStart: TimeOfDay | undefined; fade: Minutes; light: SceneLight | undefined; switchesOn: boolean };
  /** A room follows the house for a block's timing or light unless it has its own. */
  export type OwnOrHouse<T> = { follows: 'house' } | { follows: 'own'; own: T };
  export type BlockTiming = Pick<BlockSchedule, 'weekdayStart' | 'weekendStart' | 'fade'>;
  export type RoomBlock = { timing: OwnOrHouse<BlockTiming>; light: OwnOrHouse<SceneLight | undefined>; switchesOn: boolean };
  export type Room = { blocks: Record<Block, RoomBlock>; wakeLight: WakeLight | undefined; private: boolean };
  export type WakeLight = { at: Instant; fade: Minutes };
  export type Lamp = { room: RoomId | undefined; bulbs: readonly BulbInfo[]; candleSeed: CandleSeed };
  export type Switch = { room: RoomId | undefined };
  export type Remote = { room: RoomId | undefined; source: RemoteSource };   // no room: the remote does nothing
  export type OverlayReset = { atNextBlock: boolean; atSetTime: boolean; afterAge: Minutes | undefined };

  // overlays.ts
  export type Via = 'remote' | 'dashboard' | 'person';   // who set an overlay; the codec maps each stored `via` text today's writers produce onto one of these
  export type Overlays = {
    blocks: readonly BlockOverlay[];     // a block held over a room or the house
    remotes: readonly RemoteOverlay[];   // a remote's brighter/dimmer and preset input for its room
    lamps: readonly LampOverlay[];       // a light or effect a person set on a lamp, a room or the house
    roomPower: Record<RoomId, Power>;    // a room switched off or on from its remote
  };
  export type BlockOverlay = { over: RoomOrHouse; block: Block; since: Instant; via: Via };
  export type RemoteOverlay = { room: RoomId; source: RemoteSource; since: Instant; input: RemoteInput };
  export type LampOverlay = { over: LampOverlayScope; since: Instant; via: Via; brightness: BrightnessClaim | undefined; colour: ColourClaim | undefined };
  export type LampOverlayScope = { kind: 'lamp'; lamp: LampId } | { kind: 'room'; room: RoomId } | { kind: 'house' };
  export type ModeOverlay = { active: false } | { active: true; since: Instant; via: Via };

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
  export type RemoteModel = { chord: { active: false } | { active: true; step: Step }; powerPresses: PowerPresses; preset: Preset };
  export type Msg = /* the nine cases of spec 3.2, verbatim, with these payload types */;
  export type OverlayRequest = { kind: 'hold block'; over: RoomOrHouse; block: Block } | { kind: 'clear'; over: RoomOrHouse } | { kind: 'clear all' };
  export type RequestedLight = { brightness: Brightness | undefined; colour: Colour | undefined };   // what a person's HA call set; at least one is present

  // types/lighting-state.ts (added)
  export type LightingState = { lamps: Record<LampId, LampLight>; switches: Record<SwitchId, Power> };
  ```
- The types named above and not spelled out (`RemoteInput`, `BrightnessClaim`, `ColourClaim`, `PowerPresses`, `Preset`) are defined in this task by one rule: each holds exactly the facts today's readers take from the stored record, in domain types. The readers are `InputFacts` and `Claim` in `src/domain/resolution.ts`, `RemoteInputRecord` and `Adjustment` in `src/domain/remote-input.ts`, and the `Model` and `presets` table in `src/domain/gestures.ts`. A stored field no reader uses is not in the `Model`. `Preset` is a labelled union of the preset positions (the labels say what each number is), not a number. A claim's effect case names an `EffectName`, never text.
- The bookkeeping in the overrides and runtime sensors (`applied`, revision, generation, pending rooms, acknowledgements, room caches) is not in the `Model`. Task 5's codec carries it.
- Import rule (`scripts/domain-imports.mjs`, TypeScript compiler API like the other guards): a file under `src/domain/` imports only from `src/domain/`. `domain-imports.legacy.json` lists the files that break the rule today, each `{ file, reason: 'replaced in M2' | 'replaced in M3' }`; an entry whose file is gone or now clean fails. The list only shrinks: it carries a `ceiling` equal to its length, and a longer list fails like the other ratchets. One allowance: `node:crypto` in `candle.ts`.

- [ ] **Step 1: Write failing tests.**
  - `domain-imports.test.ts` (against fixture trees, like `item-order.test.ts`): a domain file importing `../runtime/x.ts` fails; one importing `./types/ids.ts` passes; `node:crypto` passes only in `candle.ts`; a legacy entry for a clean file fails.
  - `model.test.ts`: builds `syntheticHouse()` and asserts it type-checks as `Model` and that every `Msg` kind can be built against it (one value per kind, `satisfies Msg`); `an off scene has no brightness and no colour` and `Off has no level` as `// @ts-expect-error` lines.
- [ ] **Step 2:** Run `npm test` → fail (no modules).
- [ ] **Step 3:** Write the three domain files, the guard, the legacy list and `syntheticHouse(): Model` (two rooms; one room with its own timing and light for one block; three lamps, one with a candle bulb and a stock bulb; one switch with a custom range; one remote with a room and one without; one overlay of each kind; the mode overlay active).
- [ ] **Step 4:** Run `npm run check && npm test` → green. `node scripts/domain-types.mjs --list` shows no uncovered site in the new files.
- [ ] **Step 5:** Commit: `feat(domain): Config, overlays, Model and Msg`.

### Task 4: Config codec

Worker: `worker-easy` once Task 3's types are merged. Review: one Sonnet pass.

**Files:**
- Create: `src/adapter/codecs/config.ts`
- Modify: `scripts/json-edges.mjs` (`src/adapter/` is an edge), the `tsconfig`/test globs only if needed
- Test: `tests/runtime/config-codec.test.ts`

**Interfaces:**
- Consumes: Task 3 `Config` and parts; `Catalog` and `parseCatalog` from `src/runtime/catalog.ts`; `Rooms` from `src/parse/rooms.ts`; the accessors in `src/runtime/parse.ts`; constructors in `src/parse/ids.ts`.
- Produces:
  ```ts
  /** The HA state the config is read from: each helper's state and attributes, the registry's rooms, the labels. */
  export type ConfigSource = { states: Readonly<Record<string, EntityState>>; rooms: Rooms; labels: Readonly<Record<string, readonly string[]>>; timezone: string | undefined };
  export function decodeConfig(source: ConfigSource, catalog: Catalog): Config;
  /** Where each bulb is reached. Sending is the adapter's, so this is not in Config. */
  export function bulbTopics(catalog: Catalog): Record<BulbId, string>;
  export const DEFAULT_FADE: Minutes;   // 20, today's fallback
  ```
- Helper names are built here from room and block (`ls_<scope>_<block>_start`, `_weekend`, `_fade`, `_own_timing`, `_own_light`, `_on_off`, the block light text, the wake helpers, the overlay reset helpers), exactly the names `src/domain/schedule.ts` and `src/parse/schedule.ts` read today. No helper name appears in `src/domain/`.
- Rules, each from today's code: a start that is not `HH:MM` with hour ≤ 23 and minute ≤ 59 → `undefined`; a fade that is not a number → `DEFAULT_FADE`; an own-flag helper not `on` → `follows: 'house'`; a block light that is off → `{ power: 'off' }`, on without a colour → `colour: undefined`, missing or unreadable → `undefined`; warm end not three numbers → `255, 126, 0`; timezone absent → today's default zone; a remote whose device has no room → `room: undefined`. The catalog is strict: a bulb in two lamps is refused by `parseCatalog` as today.
- Decode only. The port never writes these helpers.

- [ ] **Step 1: Write failing tests**, one per rule above, on synthetic ids, with inputs in the wire shapes the existing tests use (`off-lamp-schedule.test.ts`, `r4-schedule-saved.test.ts`, `recover-helpers.test.ts`): `a start of 24:00 is no start`; `an unreadable fade is twenty minutes`; `a room without its own timing follows the house`; `an off block light has no colour` and `a lit block light with no colour has none` (Review Focus 2); `a helper that is unavailable is its default` (Review Focus 3); `a remote with no room has none`; `a bulb in two lamps is refused`; `bulbTopics lists every bulb with a topic`.
- [ ] **Step 2:** Run `npm test` → fail.
- [ ] **Step 3:** Implement `decodeConfig` and `bulbTopics`; add `src/adapter` to the JSON-edge guard's edge list.
- [ ] **Step 4:** Run `npm run check && npm test` → green.
- [ ] **Step 5:** Commit: `feat(adapter): config codec`.

### Task 5: State codecs and the fields shared with the old scripts

Worker: `worker-hard`. Review: one Opus pass (a wrong write here breaks rooms the old scripts still drive).

**Files:**
- Create: `lighting-scripts/docs/sensor-fields.md` (YAML front matter: `kind: inventory`, `date`, `milestone: M1`), `src/adapter/codecs/overrides-sensor.ts`, `src/adapter/codecs/lamp-profiles.ts`, `src/adapter/codecs/remote-helpers.ts`, `src/adapter/codecs/model.ts`
- Test: `tests/runtime/overrides-sensor-codec.test.ts`, `lamp-profiles-codec.test.ts`, `remote-helpers-codec.test.ts`

**Interfaces:**
- Consumes: Task 3 `Model`, `Overlays`, `ModeOverlay`, `RangeRule`, `RangeDefaults`, `LampProfile`, `RemoteModel`; Task 4 `decodeConfig`, `ConfigSource`; `parseOverlayKey` (`src/parse/overlay-key.ts`); live rooms from `src/parse/live-rooms.ts`.
- Produces:
  ```ts
  // overrides-sensor.ts
  export type OverridesState = Pick<Model, 'overlays' | 'modeOverlay' | 'switchRanges' | 'rangeDefaults'>;
  export function decodeOverrides(attributes: JsonObject | undefined, config: Config): OverridesState;
  /** The sensor's attributes with this state written in. Records of rooms outside `live`, records of no known shape and every attribute the Model does not own come from `found` unchanged. */
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
- Defaults, named constants beside their decoder: `overrides` not a mapping → no overlays; a record of unknown kind or unknown key shape → not in the `Model`, kept in the bytes; a `when` that is not a date → the epoch (today's `as_timestamp(when, 0)`); a saved block that is not a block → `night` (the existing `savedBlock` rule); a custom range whose bounds are not an ordered pair in 0..100 → the switch has no rule; range defaults out of order → today's defaults; a profile store that is not JSON or not a mapping → `{ follows: 'room' }`; a saved effect that is not `Candle` → `Normal`; a stored `via` that no writer produces → `dashboard` (today's absent-`via` default); a remote helper in `unknown` or `unavailable` → today's fallbacks (`gestureState` in `src/parse/gestures.ts`).
- A custom range bound saved as a boolean (today's `Percent | boolean`) decodes through the same check the old code runs and encodes back as found unless the rule changed.
- `sensor-fields.md` is the checklist for `encodeOverrides`: one row per attribute and per record field of the overrides sensor, the runtime sensor and the room cache sensors, with columns `field`, `read by` (old script names), `across rooms` (yes/no), `owner` (`Model.<path>` or `carried`). Entity names are written with `<room>` and `<lamp>`. It is built by searching the old scripts in `reference/live/` (private; only field and script names leave it).

- [ ] **Step 1:** Write `sensor-fields.md`. Any field that is `across rooms: yes` and has no owner is `carried`; list those at the top, they are what the M6 compatibility writer keeps valid.
- [ ] **Step 2: Write failing tests.** Inputs are the stored shapes the existing tests already use (`r4-commit.test.ts`, `r4-remote-plan.test.ts`, the mode overlay's test, `lighting-state.test.ts`, `ls-store-boundary.test.ts`, `gestures-reducer.test.ts`), with synthetic ids.
  - Round trip: for a well-formed store holding one record of each kind, `encodeOverrides(decodeOverrides(a, config), {}, allRooms)` deep-equals `a` restricted to the fields `sensor-fields.md` gives a `Model` owner.
  - `a record of a room that is not live is left exactly as found` and `attributes the Model does not own are left exactly as found` (Review Focus 4): encode after changing a live room's overlay; the other room's records and the carried attributes are identical objects by `assert.deepStrictEqual`, key order included (`JSON.stringify` equal).
  - Garbage, one test per default above (Review Focus 3), each also asserting the encode keeps the garbage bytes when nothing changed.
  - `an off profile has no brightness and no colour`; `a lit profile with no colour has none` (Review Focus 2); `a saved Breathe is Normal`.
  - `remoteHelperWrites` writes only the helpers that changed, in the order today's reducer writes them.
  - `decodeModel(syntheticSource(), syntheticCatalog())` deep-equals Task 3's `syntheticHouse()` (the fixture gains the wire form it decodes from).
- [ ] **Step 3:** Run `npm test` → fail.
- [ ] **Step 4:** Implement the four codec files.
- [ ] **Step 5:** Run `npm run check && npm test` → green. Run `npm run e2e` detached → 0 unexplained, 109 adjusted.
- [ ] **Step 6:** Commit: `feat(adapter): codecs for the overrides sensor, lamp profiles and remote helpers`.

## After M1

1. The codecs meet real house data for the first time in M2, when `lightingState` reads the `Model` under the golden scenarios. M1 builds no live-data check.
2. Write the M2 plan (`lightingState`): move and re-type schedule, overlays, resolution and blend onto these types, and decide there whether `LampLight` needs a colourless lit case or a transition on off.
