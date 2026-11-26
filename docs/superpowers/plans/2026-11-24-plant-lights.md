# Plant Lights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow-lamp plugs labelled `plant_light` switch on at their room's day start for a set number of hours, hold a hand switch or the all-off control until the plug's next start (its own start when set, else the room's day start), and follow nothing else of the lighting.

**Architecture:** A switch's kind becomes an explicit union in `Config`. `switchPower` handles lighting switches only. A new concept module, `src/domain/plant-lights.ts`, computes each plant light's power from the clock, the config and two stored overrides, and shares only a day-start lookup with `schedule.ts`. The adapter reads the label and hours helpers into `Config`, stores the overrides in `sensor.ls_overrides`, reads `input_boolean.ls_plants_all_off` into a message and mirrors it back. The reconciler and switch sends are shared and unchanged.

**Tech Stack:** TypeScript run by `node --experimental-strip-types`, `node:test`, the golden gate (`tests/e2e/gate.py`), Home Assistant helpers and labels.

**Spec:** `docs/superpowers/specs/2026-11-24-plant-lights-design.md`

All paths below are relative to `lighting-scripts/` unless they start with `docs/superpowers/`. Run every command from `lighting-scripts/`.

## Global Constraints

Owner's standing rules (`session-constraints.md`), verbatim where quoted:

1. "falsy bugs= bad, use explicit optional types": test absence with `=== undefined`; no `if (x)`, `x || y`, and no `??` where null and absent differ.
2. "Push json to edges and eliminate where not needed": no `JsonObject`/`JsonValue`, HA entity ids or helper names in `src/domain/`.
3. "typed with parser that is flexible and has default" and "we shouldn't break here, we should just recover": helpers and stored values a person can change recover to a named default and never raise.
4. "constrain the values available to the values that you actually expect": hours are a `PlantHours` range type, ids are branded (`SwitchId`, `RoomId`), built only by `...OrThrow` in `src/domain/types/range.ts` and `to...` in `src/adapter/codecs/ids.ts`.
5. "we don't have plans in the domain, we just have the state of lightning": the domain gives each plant light's power; the adapter makes the plugs match.
6. "Use elm conventions, Model and Msg"; Model, Msg and `update` stay in `src/domain/update.ts`; a concept's types, messages and update sit in its one module.
7. "helper functions like parsers and other functions very coupled with just that type should be next to it." Reading order is linted: run `npm run check`; fix order with `npm run fix:item-order`.
8. "Not monkey-patched: an explicit switch kind, its own concept module."
9. "I expect one pr per repo": all work lands on `ts-port/json-edges` (PR #39). The repo is public: no private details in code, commits or PR text.
10. "I'd expect this to be a cp that takes like a min max": only tasks that say so run `npm run e2e`; the rest gate on `npm run check && npm test`.

Project rules for this plan:

11. Workers never run `rm` of any kind (no `rm`, `git rm`, `git clean`, `rmdir`). A file that must go is reported to the controller.
12. Spec anti-goals bind every task: no plant light follows room power, remotes, the mode overlay, block holds, range rules, the block on/off setting, the next-block reset or a clear-all; no stored timer; no kind decided silently inside `switchPower`; no second sender in HA.
13. Baselines: `npm test` is 772 pass, 0 fail (plus known TODOs); `npm run e2e` shows exactly 20 flow differences (mode_toggle 7, next_block_reset 10, person_change_then_expiry 3). No task adds a failure or a difference.
14. If a `npm run check` ceiling (domain-words, domain-types, json-edges) trips, change the code, never the ceiling.
15. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A plug out of reach at its day start (unplugged, Zigbee down) that comes back later: it is sent its computed power, and its return is not read as a hand switch. Test in Task 7.
2. `input_boolean.ls_plants_all_off` is `unavailable`, `unknown` or missing while HA starts: a stored all-off hold stays, and no on or off is read from it. Test in Task 6.
3. The port's "off" write to the all-off control is still waiting or was refused at the releasing day start: the control still showing `on` must not set all-off again for another day. Test in Task 6.
4. No day start in reach (both day-start helpers cleared, or a weekend with no start): a plant light is off unless its hours are 24, and a stored override still applies. Test in Task 2.
5. An hours helper out of range (30, -2), or an own-hours switch on with an unreadable number: clamped to 24 or 0, or the plug follows the default; never a raise. Test in Task 4.

## File Structure

| # | File | Responsibility |
|---|---|---|
| 1 | `src/domain/types/range.ts` (modify) | `PlantHours` and `plantHoursOrThrow` |
| 2 | `src/domain/config.ts` (modify) | `Switch` as a union of kinds; `Config.plantHours` |
| 3 | `src/domain/schedule.ts` (modify) | `dayStarts`, sharing `blockPosition`'s start calculation |
| 4 | `src/domain/switches.ts` (modify) | lighting switches only |
| 5 | `src/domain/plant-lights.ts` (create) | overrides, their message and updates, `plantPower` |
| 6 | `src/domain/update.ts`, `lighting-state.ts`, `dashboard.ts` (modify) | Model slice, Msg, wiring |
| 7 | `src/adapter/codecs/config.ts`, `ids.ts` (modify) | label and hours helpers into `Config` |
| 8 | `src/adapter/codecs/overrides-sensor.ts`, `model.ts` (modify) | stored overrides |
| 9 | `src/adapter/codecs/inputs.ts`, `writes.ts`, `src/adapter/encode.ts`, `outbox.ts`, `live-rooms.ts`, `loop.ts` (modify) | all-off control in and out, put-right, refusals |
| 10 | `docs/sensor-fields.md` (modify) | the two new sensor attributes |

`Switch` stays in `config.ts` (not `plant-lights.ts`) because `plant-lights.ts` reads `Config` and the domain's imports run one way (`scripts/domain-imports.mjs`).

---

### Task 1: A switch's kind, and the day-start lookup

**Files:**
- Modify: `src/domain/types/range.ts`, `src/domain/config.ts`, `src/domain/schedule.ts`, `src/domain/switches.ts`, `src/adapter/codecs/ids.ts`, `src/adapter/codecs/config.ts`
- Modify: `tests/runtime/fixtures/synthetic-house.ts` and every test that builds a `Switch` (the typecheck names them)
- Test: `tests/runtime/schedule.test.ts`, `tests/runtime/switches.test.ts`, `tests/runtime/range-constructors.test.ts`

**Interfaces:**
- Produces:
  - `type PlantHours = Ranged<'PlantHours'>`; `plantHoursOrThrow(raw: number): PlantHours` (0..24, not necessarily whole) in `types/range.ts`; `toPlantHours(raw: number): PlantHours` in `codecs/ids.ts`.
  - In `config.ts`: `type LightingSwitch = { kind: 'lighting'; room: RoomId | undefined; onOff: boolean }`, `type PlantLight = { kind: 'plant light'; room: RoomId | undefined; hours: OwnOrHouse<PlantHours> }`, `type Switch = LightingSwitch | PlantLight`, and `Config.plantHours: PlantHours` (the house default).
  - In `schedule.ts`: `type DayStarts = { last: Instant | undefined; next: Instant | undefined }` and `dayStarts(config: Config, room: RoomId | undefined, now: Instant): DayStarts`. `last` is the newest start of the `day` block at or before `now`, `next` the first after it, over the same days `blockPosition` searches.

- [ ] **Step 1: Write the failing tests**

In `schedule.test.ts` (synthetic config, UTC, `at(time, day = 21)` as in `switches.test.ts`; Monday is the 21st, house day 07:00 weekdays and 09:00 weekends, fade 20 min):

```ts
test('the day starts either side of an instant', () => {
  assert.deepEqual(dayStarts(config, undefined, at('12:00:00')), { last: at('07:00:00'), next: at('07:00:00', 22) });
});
test('a day start is the block start, not its fade start', () => {
  assert.deepEqual(dayStarts(config, undefined, at('06:40:00')), { last: at('09:00:00', 20), next: at('07:00:00') });
});
test('a weekend morning takes the weekend start', () => {
  assert.deepEqual(dayStarts(config, undefined, at('08:00:00', 26)), { last: at('07:00:00', 25), next: at('09:00:00', 26) });
});
test('a room with its own day timing has its own day starts, a room the config does not hold the house\'s', () => {
  // ownDay: room-a's day block with timing { follows: 'own', own: { weekdayStart 08:30, weekendStart 09:00, fade 20 } }
  assert.equal(dayStarts(ownDay, roomA, at('08:00:00')).next, at('08:30:00'));
  assert.equal(dayStarts(ownDay, toRoomId('nowhere'), at('08:00:00')).last, at('07:00:00'));
});
test('with no day start set there is none either side', () => {
  // noDay: house.day.weekdayStart and weekendStart both undefined
  assert.deepEqual(dayStarts(noDay, undefined, at('12:00:00')), { last: undefined, next: undefined });
});
```

In `switches.test.ts` (`plantA = toSwitchId('switch.plant_a')`, added to the config as `{ kind: 'plant light', room: roomA, hours: { follows: 'house' } }`):

```ts
test('a press on a plant light makes no lighting switch overlay', () => {
  const press = { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: at('12:00:00') } as const;
  assert.deepEqual(switchButtonPressed({}, model.config, press), {});
});
test('a range saved for a plant light changes nothing', () => {
  const saved = { kind: 'rangeSaved', switch: plantA, rule: { kind: 'bright' }, room: roomA, at: at('12:00:00') } as const;
  assert.deepEqual(rangeSaved(model.config, model.switchRanges, saved), { config: model.config, switchRanges: model.switchRanges });
});
```

In `range-constructors.test.ts`, following the other constructors: `plantHoursOrThrow` accepts 0, 0.5 and 24, and throws a `RangeError` for -0.5, 24.5 and `NaN`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run check`
Expected: FAIL, type errors naming `dayStarts`, `plantHoursOrThrow` and `kind` on `Switch`.

- [ ] **Step 3: Implement**

1. `PlantHours`, `plantHoursOrThrow`, `toPlantHours`, the `Switch` union and `Config.plantHours` as in Interfaces.
2. `dayStarts`: extract the per-day, per-block start calculation out of `blockPosition`'s loop into one private function both call. Do not copy it. `blockPosition`'s results must not change; the existing `schedule.test.ts` cases stay untouched and green.
3. `switchButtonPressed` returns the overlays unchanged unless `config.switches[press.switch]?.kind === 'lighting'`. `rangeSaved` returns its inputs unchanged for a plant light, and builds a new switch as `{ kind: 'lighting', room, onOff: false }`.
4. `decodeSwitches` gives every switch `kind: 'lighting'`; `decodeConfig` sets `plantHours: DEFAULT_PLANT_HOURS`, a new exported constant `toPlantHours(12)` (Task 4 reads the helper).
5. Add `kind: 'lighting'` and `plantHours: toPlantHours(12)` to the synthetic fixture and to each test the typecheck names.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail, pass count 772 plus the new tests.

Run: `npm run e2e` (this task touches `blockPosition`)
Expected: exactly the 20 baseline flow differences.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(lighting): a switch's kind is explicit; day-start lookup" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The plant-light module

**Files:**
- Create: `src/domain/plant-lights.ts`
- Test: `tests/runtime/plant-lights.test.ts`

**Interfaces:**
- Consumes: `dayStarts`, `PlantLight`, `Config.plantHours` (Task 1); `SwitchButtonPressed` from `switches.ts`.
- Produces, all exported from `plant-lights.ts`:

```ts
type HandSwitch = { power: Power; since: Instant };
type AllOff = { since: Instant };
type PlantOverrides = { handSwitches: Partial<Record<SwitchId, HandSwitch>>; allOff: AllOff | undefined };
const NO_PLANT_OVERRIDES: PlantOverrides;                       // { handSwitches: {}, allOff: undefined }
type PlantsAllOffSet = { kind: 'plantsAllOffSet'; on: boolean; at: Instant };
function plantPower(model: { config: Config; plantOverrides: PlantOverrides }, now: Instant): Record<SwitchId, Power>;
function plantLightSwitched(overrides: PlantOverrides, config: Config, press: SwitchButtonPressed): PlantOverrides;
function plantsAllOffSet(overrides: PlantOverrides, set: PlantsAllOffSet): PlantOverrides;
function plantOverridesReleased(overrides: PlantOverrides, config: Config, now: Instant): PlantOverrides;
function plantChanges(config: Config, now: Instant): Instant[];
```

The rules the signatures do not fix:

1. A plant light's room is its config room where `config.rooms` holds it, else the house (as `switchPower` places a switch). `{ last }` is `dayStarts` for that room.
2. An override set at `since` applies when `last === undefined || since >= last`.
3. Power: a hand switch that applies wins unless an all-off that applies is newer (`allOff.since > hand.since`); then an all-off that applies gives off; else the timer.
4. Timer: hours are the plug's own where `hours.follows === 'own'`, else `config.plantHours`. Hours of 24 are on. With `last === undefined` it is off. Otherwise on while `now < last + hours * 3600`.
5. `plantPower` has an entry for every plant light of the config and for no other switch.
6. `plantLightSwitched` stores `{ power, since: press.at }` for a plant light and returns the overrides unchanged for any other switch.
7. `plantsAllOffSet` on: `allOff = { since: at }` and every hand switch is dropped (the newer hold replaces them, so switching all-off off later goes back to the timer). Off: `allOff` undefined, hand switches kept.
8. `plantOverridesReleased`: drops each hand switch that no longer applies, and drops `allOff` once it applies to no plant light of the config (none at all included).
9. `plantChanges`: for each plant light, its `next` day start and, when later than `now`, its timer's switch-off instant.

- [ ] **Step 1: Write the failing tests**

Fixture: the synthetic config with `plantHours` 12 and two plant lights following the house hours, `plantA` in `room-a` and `plantHouse` (`switch.plant_house`) in no room; `sources(change)` returns `{ config, plantOverrides: NO_PLANT_OVERRIDES }` after `change`; `power(s, now, id = plantA)` is `plantPower(s, now)[id]`.

```ts
test('a plant light is on from the day start for its hours', () => {
  const s = sources();
  assert.equal(power(s, at('06:59:59')), 'off');
  assert.equal(power(s, at('07:00:00')), 'on');
  assert.equal(power(s, at('18:59:59')), 'on');
  assert.equal(power(s, at('19:00:00')), 'off');
});
test('the day block\'s fade does not switch it', () => {
  assert.equal(power(sources(), at('06:40:00')), 'off');
});
test('a weekend day starts at the weekend time', () => {
  const s = sources();
  assert.equal(power(s, at('08:59:59', 26)), 'off');
  assert.equal(power(s, at('09:00:00', 26)), 'on');
  assert.equal(power(s, at('21:00:00', 26)), 'off');
});
test('a plant light follows its room\'s own day timing, one in no room the house\'s', () => {
  const s = sources(ownDayAt0830);                 // room-a's day block: own timing, weekdayStart 08:30
  assert.equal(power(s, at('07:30:00')), 'off');
  assert.equal(power(s, at('08:30:00')), 'on');
  assert.equal(power(s, at('07:30:00'), plantHouse), 'on');
});
test('0 hours is off all the time and 24 hours on all the time', () => {
  const none = sources(s => { s.config.plantHours = toPlantHours(0); });
  assert.equal(power(none, at('07:00:00')), 'off');
  const all = sources(s => { s.config.plantHours = toPlantHours(24); });
  assert.equal(power(all, at('06:59:59')), 'on');
  assert.equal(power(all, at('07:00:00')), 'on');
});
test('own hours win over the default, and the default moves the rest', () => {
  const s = sources(s => { s.config.switches[plantA] = { kind: 'plant light', room: roomA, hours: { follows: 'own', own: toPlantHours(4) } }; });
  assert.equal(power(s, at('10:59:59')), 'on');
  assert.equal(power(s, at('11:00:00')), 'off');
  assert.equal(power(s, at('11:00:00'), plantHouse), 'on');
  s.config.plantHours = toPlantHours(6);
  assert.equal(power(s, at('13:00:00'), plantHouse), 'off');
  assert.equal(power(s, at('10:59:59')), 'on');
});
test('a hand switch holds until the next day start', () => {
  const off = sources(s => { s.plantOverrides.handSwitches[plantA] = { power: 'off', since: at('10:00:00') }; });
  assert.equal(power(off, at('12:00:00')), 'off');
  assert.equal(power(off, at('06:59:59', 22)), 'off');
  assert.equal(power(off, at('07:00:00', 22)), 'on');
  const on = sources(s => { s.plantOverrides.handSwitches[plantA] = { power: 'on', since: at('20:00:00') }; });
  assert.equal(power(on, at('23:00:00')), 'on');
  assert.equal(power(on, at('19:00:00', 22)), 'off');
});
test('all off holds every plant light off until its next day start', () => {
  const s = sources(s => { s.plantOverrides.allOff = { since: at('10:00:00') }; });
  assert.equal(power(s, at('12:00:00')), 'off');
  assert.equal(power(s, at('12:00:00'), plantHouse), 'off');
  assert.equal(power(s, at('07:00:00', 22)), 'on');
});
test('of a hand switch and all off, the newer wins', () => {
  const s = sources(s => { s.plantOverrides = { allOff: { since: at('10:00:00') }, handSwitches: { [plantA]: { power: 'on', since: at('11:00:00') } } }; });
  assert.equal(power(s, at('12:00:00')), 'on');
  assert.equal(power(s, at('12:00:00'), plantHouse), 'off');
  s.plantOverrides.handSwitches[plantA] = { power: 'on', since: at('09:00:00') };
  assert.equal(power(s, at('12:00:00')), 'off');
});
test('rooms with different day starts are released from all off each at its own', () => {
  const s = sources(s => { ownDayAt0830(s); s.plantOverrides.allOff = { since: at('10:00:00') }; });
  assert.equal(power(s, at('07:30:00', 22), plantHouse), 'on');
  assert.equal(power(s, at('07:30:00', 22)), 'off');
  assert.notEqual(plantOverridesReleased(s.plantOverrides, s.config, at('07:30:00', 22)).allOff, undefined);
  assert.equal(plantOverridesReleased(s.plantOverrides, s.config, at('08:30:00', 22)).allOff, undefined);
});
test('the clock drops a hand switch at its day start, not before', () => {
  const held = { handSwitches: { [plantA]: { power: 'off' as const, since: at('10:00:00') } }, allOff: undefined };
  assert.deepEqual(plantOverridesReleased(held, config, at('06:59:59', 22)), held);
  assert.deepEqual(plantOverridesReleased(held, config, at('07:00:00', 22)), NO_PLANT_OVERRIDES);
});
test('all off with no plant light in the house is released at once', () => {
  assert.equal(plantOverridesReleased({ handSwitches: {}, allOff: { since: at('10:00:00') } }, noPlants, at('10:00:01')).allOff, undefined);
});
test('switching all off on drops the hand switches; off keeps a newer one', () => {
  const hand = { handSwitches: { [plantA]: { power: 'on' as const, since: at('09:00:00') } }, allOff: undefined };
  const on = plantsAllOffSet(hand, { kind: 'plantsAllOffSet', on: true, at: at('10:00:00') });
  assert.deepEqual(on, { handSwitches: {}, allOff: { since: at('10:00:00') } });
  const pressed = plantLightSwitched(on, config, { kind: 'switchButtonPressed', switch: plantA, power: 'on', at: at('11:00:00') });
  assert.deepEqual(plantsAllOffSet(pressed, { kind: 'plantsAllOffSet', on: false, at: at('12:00:00') }),
    { handSwitches: { [plantA]: { power: 'on', since: at('11:00:00') } }, allOff: undefined });
});
test('a press on a lighting switch is no plant hand switch', () => {
  const press = { kind: 'switchButtonPressed', switch: plugA, power: 'off', at: at('12:00:00') } as const;
  assert.deepEqual(plantLightSwitched(NO_PLANT_OVERRIDES, config, press), NO_PLANT_OVERRIDES);
});
test('the next changes are the switch-off and the next day start', () => {
  const times = plantChanges(config, at('12:00:00'));
  assert.ok(times.includes(at('19:00:00')) && times.includes(at('07:00:00', 22)));
});
test('Review Focus 4: with no day start in reach a plant light is off unless its hours are 24, and an override still applies', () => {
  const s = sources(noDayStarts);                  // house.day weekdayStart and weekendStart undefined
  assert.equal(power(s, at('12:00:00')), 'off');
  s.config.plantHours = toPlantHours(24);
  assert.equal(power(s, at('12:00:00')), 'on');
  s.plantOverrides.handSwitches[plantA] = { power: 'off', since: at('10:00:00', 19) };
  assert.equal(power(s, at('12:00:00')), 'off');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test --experimental-test-isolation=none tests/runtime/plant-lights.test.ts`
Expected: FAIL, cannot find module `src/domain/plant-lights.ts`.

- [ ] **Step 3: Implement `src/domain/plant-lights.ts`** to the Interfaces block and rules 1 to 9. The file header says what the concept is and that it shares only `dayStarts` with the schedule. Then run `npm run fix:item-order`.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/domain/plant-lights.ts tests/runtime/plant-lights.test.ts
git commit -m "feat(lighting): plant lights, their overrides and their power from the clock" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Model, Msg and the lighting state

**Files:**
- Modify: `src/domain/update.ts`, `src/domain/lighting-state.ts`, `src/domain/switches.ts`, `src/domain/dashboard.ts`, `src/adapter/live-rooms.ts`, `src/adapter/codecs/model.ts`, `tests/runtime/fixtures/synthetic-house.ts`
- Test: `tests/runtime/plant-lights-flow.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces:
  - `Model.plantOverrides: PlantOverrides`; `LightingSources.plantOverrides: PlantOverrides`; `Msg` gains `PlantsAllOffSet`.
  - `DashboardView.plantsAllOff: boolean` (the Model holds an all-off).
  - `lightingState(...).switches` holds lighting switches from `switchPower` and plant lights from `plantPower`.

- [ ] **Step 1: Write the failing tests**

Fixture: `house(change)` as in `switches.test.ts`, plus `plantA` in `room-a` and `model.plantOverrides = NO_PLANT_OVERRIDES`; `power(model, now)` is `lightingState(model, now).switches[plantA]`. At Monday 12:00 the timer says on.

```ts
const noon = at('12:00:00');
test('room power leaves a plant light on', () => {
  assert.equal(power(house(m => { m.overlays.roomPower[roomA] = 'off'; }), noon), 'on');
});
test('a remote\'s toggle and reset leave a plant light on', () => {
  const toggled = update(house(), { kind: 'remotePressed', remote: remoteA, command: 'toggle', anyOn: true, at: noon });
  assert.equal(power(toggled, noon), 'on');
  assert.equal(power(update(toggled, { kind: 'remotePressed', remote: remoteA, command: 'reset', anyOn: false, at: noon }), noon), 'on');
});
test('the mode overlay leaves a plant light on', () => {
  assert.equal(power(update(house(), { kind: 'modeToggled', on: true, at: noon }), noon), 'on');
});
test('a held night block leaves a plant light on', () => {
  const held = [roomA, 'house' as const].reduce((m, over) =>
    update(m, { kind: 'overlayRequested', request: { kind: 'hold block', over, block: 'night' }, at: noon }), house());
  assert.equal(power(held, noon), 'on');
});
test('a clear-all leaves a plant light and its hand switch as they are', () => {
  const pressed = update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: at('10:00:00') });
  const cleared = update(pressed, { kind: 'overlayRequested', request: { kind: 'clear all' }, at: noon });
  assert.equal(power(cleared, noon), 'off');
  assert.equal(power(update(house(), { kind: 'overlayRequested', request: { kind: 'clear all' }, at: noon }), noon), 'on');
});
test('the lighting\'s overlay resets leave a hand switch', () => {
  // The age limit is 180 min and room-a's cosy fade starts 16:45: neither ends a hand switch set at 10:00.
  let model = update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: at('10:00:00') });
  for (const time of ['13:30:00', '17:00:00', '18:00:00']) model = update(model, { kind: 'clock', now: at(time) });
  assert.equal(power(model, at('18:00:00')), 'off');
  assert.equal(power(update(model, { kind: 'clock', now: at('07:00:00', 22) }), at('07:00:00', 22)), 'on');
});
test('a range rule and a lighting switch overlay stored for a plant light are ignored', () => {
  const model = house(m => {
    m.switchRanges[plantA] = { kind: 'custom', range: toPercentRange(0, 10) };
    m.overlays.switches[plantA] = { power: 'off', since: at('11:00:00') };
  });
  assert.equal(power(model, noon), 'on');
});
test('a press on a plant light is its hand switch, not a lighting overlay', () => {
  const model = update(house(), { kind: 'switchButtonPressed', switch: plantA, power: 'off', at: noon });
  assert.deepEqual(model.plantOverrides.handSwitches[plantA], { power: 'off', since: noon });
  assert.equal(model.overlays.switches[plantA], undefined);
});
test('all off set from the dashboard holds, shows on, and is dropped by the clock at the day start', () => {
  const set = update(house(), { kind: 'plantsAllOffSet', on: true, at: noon });
  assert.equal(power(set, at('13:00:00')), 'off');
  assert.equal(dashboardView(set, lightingState(set, noon), noon).plantsAllOff, true);
  const next = update(set, { kind: 'clock', now: at('07:00:00', 22) });
  assert.equal(next.plantOverrides.allOff, undefined);
  assert.equal(dashboardView(next, lightingState(next, at('07:00:00', 22)), at('07:00:00', 22)).plantsAllOff, false);
});
test('the plant light\'s switch-off is a next change', () => {
  assert.equal(nextChange(house(), at('18:30:00')), at('19:00:00'));
});
test('the lighting switch beside it is as before', () => {
  assert.equal(lightingState(house(), noon).switches[plugA], 'off');
  assert.equal(lightingState(house(), at('20:00:00')).switches[plugA], 'on');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run check`
Expected: FAIL, type errors on `plantOverrides`, `plantsAllOffSet` and `plantsAllOff`.

- [ ] **Step 3: Implement**

1. `Model.plantOverrides`, `LightingSources.plantOverrides`, `Msg | PlantsAllOffSet`.
2. `update`: the clock also applies `plantOverridesReleased`; `switchButtonPressed` goes to `plantLightSwitched` when `model.config.switches[msg.switch]?.kind === 'plant light'`, else to the lighting `switchButtonPressed` as today; `plantsAllOffSet` goes to `plantsAllOffSet`.
3. `nextChange` also takes `plantChanges(model.config, now)`.
4. `switchPower` skips a switch whose `kind` is not `'lighting'`, as its first statement in the loop, and its doc comment says it handles lighting switches only.
5. `lightingState`: `switches` is `switchPower`'s record with `plantPower`'s spread over it.
6. `dashboardView`: `plantsAllOff: model.plantOverrides.allOff !== undefined`.
7. `ownPart` (`live-rooms.ts`): `case 'plantsAllOffSet': return msg;` (the control is the port's alone; `sharedLighting` already keeps sends to the rooms the port drives).
8. `decodeModelFrom` (`codecs/model.ts`) sets `plantOverrides: NO_PLANT_OVERRIDES` until Task 5 reads the sensor; the synthetic fixture gets the same field.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail.

Run: `npm run e2e` (the lighting state changed)
Expected: exactly the 20 baseline flow differences.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(lighting): plant overrides in the Model; switchPower is lighting switches only" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The config codec reads the label and the hours

**Files:**
- Modify: `src/adapter/codecs/config.ts`, `src/adapter/codecs/ids.ts`
- Test: `tests/runtime/config-codec.test.ts`

**Interfaces:**
- Consumes: `Switch` union, `Config.plantHours`, `toPlantHours`, `DEFAULT_PLANT_HOURS` (Task 1).
- Produces:
  - Label `plant_light` on a `light.` or `switch.` entity makes it `{ kind: 'plant light', room, hours }`, whatever else is labelled or stored for it.
  - Helpers, `<object>` being the entity id after its domain (as `profileStore` names it): `input_number.ls_plant_hours`, `input_boolean.ls_plant_<object>_own_hours`, `input_number.ls_plant_<object>_hours`.
  - `plantHoursOf(raw: unknown): PlantHours | undefined` in `codecs/ids.ts`: a finite number held to 0..24, anything else undefined.

- [ ] **Step 1: Write the failing tests**

`source(change)` is `syntheticSource()` with `labels.plant_light = ['switch.plant_a']`, `switch.plant_a` in `room-a`, and `change` applied to its states; `plant(config)` is `config.switches[toSwitchId('switch.plant_a')]`.

```ts
test('a plug labelled plant_light is a plant light following the default hours', () => {
  const config = decodeConfig(source(), catalog);
  assert.deepEqual(plant(config), { kind: 'plant light', room: roomA, hours: { follows: 'house' } });
  assert.deepEqual(config.switches[plugA], { kind: 'lighting', room: roomA, onOff: true });
  assert.equal(config.plantHours, 12);
});
test('one kind per plug: plant_light wins over on_off and a saved range', () => {
  const both = source(states => { states['sensor.ls_overrides']!.attributes.switch_ranges = { 'switch.plant_a': { profile: 'bright' } }; });
  both.labels = { ...both.labels, on_off: [plugA, 'switch.plant_a'] };
  assert.equal(plant(decodeConfig(both, catalog))?.kind, 'plant light');
});
test('a plant_light label on something that is no light or switch is skipped', () => {
  const other = source(); other.labels = { ...other.labels, plant_light: ['sensor.soil'] };
  assert.equal(decodeConfig(other, catalog).switches[toSwitchId('sensor.soil')], undefined);
});
test('the default hours come from input_number.ls_plant_hours', () => {
  assert.equal(decodeConfig(source(s => { s['input_number.ls_plant_hours'] = helper('10.5'); }), catalog).plantHours, 10.5);
});
test('own hours need the own-hours switch on', () => {
  const own = (flag: string, hours: string) => plant(decodeConfig(source(s => {
    s['input_boolean.ls_plant_plant_a_own_hours'] = helper(flag); s['input_number.ls_plant_plant_a_hours'] = helper(hours);
  }), catalog));
  assert.deepEqual(own('on', '8')?.kind === 'plant light' && own('on', '8').hours, { follows: 'own', own: 8 });
  assert.deepEqual(own('off', '8')?.kind === 'plant light' && own('off', '8').hours, { follows: 'house' });
});
test('Review Focus 5: unreadable or out-of-range hours recover', () => {
  const hours = (text: string) => decodeConfig(source(s => { s['input_number.ls_plant_hours'] = helper(text); }), catalog).plantHours;
  assert.equal(hours('unknown'), 12);
  assert.equal(hours('30'), 24);
  assert.equal(hours('-2'), 0);
  const own = plant(decodeConfig(source(s => {
    s['input_boolean.ls_plant_plant_a_own_hours'] = helper('on'); s['input_number.ls_plant_plant_a_hours'] = helper('unavailable');
  }), catalog));
  assert.deepEqual(own?.kind === 'plant light' && own.hours, { follows: 'house' });
});
test('a change to an hours helper is a change of the config', () => {
  const { from } = readConfig(source(), catalog);
  for (const entity of ['input_number.ls_plant_hours', 'input_boolean.ls_plant_plant_a_own_hours', 'input_number.ls_plant_plant_a_hours']) {
    assert.equal(readsConfig(from, entity), true, entity);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test --experimental-test-isolation=none tests/runtime/config-codec.test.ts`
Expected: FAIL: the plant plug decodes as absent or as `kind: 'lighting'`.

- [ ] **Step 3: Implement** in `decodeSwitches` and `decodeConfig`. Read every helper through `source.states[...]` (also when absent), so `readConfig` records it. The helper names are built in the codec only.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapter/codecs tests/runtime/config-codec.test.ts
git commit -m "feat(lighting): the config codec reads the plant_light label and the hours helpers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The overrides are stored in `sensor.ls_overrides`

**Files:**
- Modify: `src/adapter/codecs/overrides-sensor.ts`, `src/adapter/codecs/model.ts`, `docs/sensor-fields.md`
- Test: `tests/runtime/overrides-sensor-codec.test.ts`

**Interfaces:**
- Consumes: `PlantOverrides`, `NO_PLANT_OVERRIDES`.
- Produces:
  - `OverridesState` also picks `'plantOverrides'`.
  - Attribute `plant_hand_switches`: a mapping from switch entity id to `{ power: 'on' | 'off', when: <ISO text> }`, the shape of `switch_overlays`.
  - Attribute `plant_all_off`: a mapping with the one key `held`, holding `{ when: <ISO text> }`; no `held` key means none.
  - Both are written by the port only. An absent attribute or key is no override, so stored state from before needs no migration.

- [ ] **Step 1: Write the failing tests**

```ts
test('the stored plant overrides are read', () => {
  const read = decodeOverrides({ plant_hand_switches: { 'switch.plant_a': { power: 'off', when: iso(10) } }, plant_all_off: { held: { when: iso(20) } } }, keys);
  assert.deepEqual(read.plantOverrides, { handSwitches: { [plantA]: { power: 'off', since: at(10) } }, allOff: { since: at(20) } });
});
test('a sensor from before plant lights holds none', () => {
  assert.deepEqual(decodeOverrides(syntheticSource().states['sensor.ls_overrides']!.attributes, keys).plantOverrides, NO_PLANT_OVERRIDES);
});
test('garbage in a stored plant override is dropped, never raised', () => {
  const read = decodeOverrides({ plant_hand_switches: { 'switch.plant_a': { power: 'dim', when: iso(10) }, 'switch.plant_b': 7 }, plant_all_off: { held: { when: 12 } } }, keys);
  assert.deepEqual(read.plantOverrides, NO_PLANT_OVERRIDES);
  assert.deepEqual(decodeOverrides({ plant_hand_switches: 'x', plant_all_off: [] }, keys).plantOverrides, NO_PLANT_OVERRIDES);
});
test('the plant overrides are written and read back, and nothing else moves', () => {
  const state = { ...decoded, plantOverrides: { handSwitches: { [plantA]: { power: 'on' as const, since: at(30) } }, allOff: { since: at(40) } } };
  const written = encodeOverrides(state, found, HOUSE, configWithPlantA, keys);
  assert.deepEqual(decodeOverrides(written, keys).plantOverrides, state.plantOverrides);
  for (const attribute of ['overrides', 'power', 'switch_ranges', 'range_defaults']) assert.deepEqual(written[attribute], found[attribute], attribute);
});
test('a released all-off and hand switch are removed from the sensor', () => {
  const held = encodeOverrides({ ...decoded, plantOverrides: { handSwitches: { [plantA]: { power: 'on', since: at(30) } }, allOff: { since: at(40) } } }, found, HOUSE, configWithPlantA, keys);
  const released = encodeOverrides({ ...decoded, plantOverrides: NO_PLANT_OVERRIDES }, held, HOUSE, configWithPlantA, keys);
  assert.deepEqual(released['plant_hand_switches'], {});
  assert.deepEqual(released['plant_all_off'], {});
});
test('unchanged plant overrides keep the stored bytes', () => {
  const stored = { ...found, plant_all_off: { held: { when: iso(40), note: 'kept' } } };
  const state = { ...decoded, plantOverrides: { handSwitches: {}, allOff: { since: at(40) } } };
  assert.deepEqual(encodeOverrides(state, stored, HOUSE, configWithPlantA, keys)['plant_all_off'], stored.plant_all_off);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test --experimental-test-isolation=none tests/runtime/overrides-sensor-codec.test.ts`
Expected: FAIL: `plantOverrides` is undefined on the decoded state.

- [ ] **Step 3: Implement** with the file's own `decodeKeyed` and `encodeKeyed` for both attributes. A hand switch is live as a switch overlay is (`switchLive`); the `held` key is always the port's. Remove the `plantOverrides: NO_PLANT_OVERRIDES` line Task 3 put in `decodeModelFrom`. Add both attributes to the table in `docs/sensor-fields.md`, as row 6 (`switch_overlays`) is written.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapter/codecs docs/sensor-fields.md tests/runtime/overrides-sensor-codec.test.ts
git commit -m "feat(lighting): plant overrides stored in the overrides sensor" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The all-off control, in and out

**Files:**
- Modify: `src/adapter/codecs/inputs.ts`, `src/adapter/codecs/writes.ts`, `src/adapter/encode.ts`, `src/adapter/outbox.ts`, `src/adapter/loop.ts`, `tests/runtime/fixtures/house-view.ts`
- Test: `tests/runtime/inputs.test.ts`, `tests/runtime/loop.test.ts`

**Interfaces:**
- Consumes: `PlantsAllOffSet`, `DashboardView.plantsAllOff`, the stored overrides (Task 5).
- Produces:
  - `PLANTS_ALL_OFF = 'input_boolean.ls_plants_all_off'` and `plantsAllOffMessages(house: HouseView, held: boolean, now: Instant): Msg[]` in `inputs.ts`. `held` is whether the Model held an all-off before this turn's clock. The control showing `on` while not held gives `[{ kind: 'plantsAllOffSet', on: true, at: now }]`; showing `off` while held gives the same with `on: false`; any other state, or the same as held, gives `[]`.
  - `DashboardWrite` gains `{ kind: 'plants all-off'; entity: string; on: boolean }`; `plantsAllOffWrite(view: DashboardView, house: HouseView): DashboardWrite | undefined` in `writes.ts`: a write when the control holds `on` or `off` and differs from `view.plantsAllOff`.
  - `wantsTurn` is true for `PLANTS_ALL_OFF`.
  - Test fixture: `houseView(states, now, plants: readonly string[] = [])` labels each of `plants` `plant_light` and places it in `room-a`.

- [ ] **Step 1: Write the failing tests**

In `inputs.test.ts`, with `view(state)` a house whose control holds `state` (`undefined` for none):

```ts
test('the all-off control is read against what the Model held', () => {
  assert.deepEqual(plantsAllOffMessages(view('on'), false, now), [{ kind: 'plantsAllOffSet', on: true, at: now }]);
  assert.deepEqual(plantsAllOffMessages(view('off'), true, now), [{ kind: 'plantsAllOffSet', on: false, at: now }]);
  assert.deepEqual(plantsAllOffMessages(view('on'), true, now), []);
  assert.deepEqual(plantsAllOffMessages(view('off'), false, now), []);
});
test('Review Focus 2: a control that holds no power says nothing', () => {
  for (const state of ['unavailable', 'unknown', undefined]) for (const held of [true, false]) {
    assert.deepEqual(plantsAllOffMessages(view(state), held, now), []);
  }
});
```

In `loop.test.ts`: give `House` a constructor option `plants` (passed to `houseView`, each plug seeded `off`), let `turn` take a full ISO instant as well as a time on the Monday, and make `turn` write a taken `plants all-off` output into `states` as it does a `switch` output. `plantOut(turn)` is the turn's `switch` output for `switch.plant_a`; `allOffOut(turn)` its `plants all-off` dashboard output. Each house below has `plants: ['switch.plant_a']` and `input_boolean.ls_plants_all_off` at `off`.

```ts
test('all off from the dashboard switches the plant lights off, and is stored', () => {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  house.states[PLANTS_ALL_OFF] = { state: 'on', attributes: {} };
  const turn = house.turn('12:05:00', { kind: 'wake' });
  assert.equal(plantOut(turn)?.power, 'off');
  assert.notEqual(house.states['sensor.ls_overrides']!.attributes['plant_all_off'], undefined);
  assert.equal(allOffOut(turn), undefined);
});
test('at the next day start the plant lights go on and the control is switched off', () => {
  const house = allOffAt1205();
  const turn = house.turn('2026-09-22T07:00:00', { kind: 'tick' });
  assert.equal(plantOut(turn)?.power, 'on');
  assert.deepEqual(allOffOut(turn), { kind: 'dashboard', write: { kind: 'plants all-off', entity: PLANTS_ALL_OFF, on: false } });
  assert.equal(house.turn('2026-09-22T07:01:00', { kind: 'tick' }).state.model.plantOverrides.allOff, undefined);
});
test('switching all off off by hand ends the hold at once', () => {
  const house = allOffAt1205();
  house.states[PLANTS_ALL_OFF] = { state: 'off', attributes: {} };
  assert.equal(plantOut(house.turn('13:00:00', { kind: 'wake' }))?.power, 'on');
});
test('Review Focus 3: while the control\'s off write has not landed, its on does not set all off again', () => {
  const house = allOffAt1205();
  const failing = (output: Output) => output.kind === 'dashboard' && output.write.kind === 'plants all-off';
  house.turn('2026-09-22T07:00:00', { kind: 'tick' }, failing);
  const next = house.turn('2026-09-22T07:01:00', { kind: 'tick' }, failing);
  assert.equal(next.state.model.plantOverrides.allOff, undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'on');
});
test('Review Focus 2: a start while the control is unavailable keeps a stored all-off', () => {
  const house = allOffAt1205();
  house.state = undefined;                         // the process starts again
  house.states[PLANTS_ALL_OFF] = { state: 'unavailable', attributes: {} };
  const turn = house.turn('12:30:00', { kind: 'started' });
  assert.notEqual(turn.state.model.plantOverrides.allOff, undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'off');
});
test('the control switching is a reason for a turn', () => {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  assert.equal(wantsTurn({ kind: 'running', state: house.state! }, PLANTS_ALL_OFF, { state: 'on', attributes: {} }), true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run check`
Expected: FAIL, type errors naming `plantsAllOffMessages`, `PLANTS_ALL_OFF` and the `plants all-off` write.

- [ ] **Step 3: Implement**

1. `plantsAllOffMessages`, `plantsAllOffWrite` and the new `DashboardWrite` kind as in Interfaces.
2. Add the `plants all-off` case beside each `mode mirror` case: `leftBy` (`writes.ts`), the service call in `encode.ts`, `targetOf` in `outbox.ts`. It is an `input_boolean.turn_on` or `turn_off` on its entity.
3. `handleInput`: the control's messages are read with `held` from `before` (the Model before the clock, so a hold the clock releases this turn is not read as a new "on"), outside the `try`, and go through `ownPart` with the turn's other messages. The control's write is queued whatever the share: the old scripts do not know the control.
4. `wantsTurn`: also true when `entity === PLANTS_ALL_OFF`.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(lighting): the all-plant-lights-off control is read and mirrored back" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Put right, hand switches and refusals through the loop

**Files:**
- Modify: `src/adapter/loop.ts`, `src/adapter/codecs/inputs.ts`
- Test: `tests/runtime/loop.test.ts`

**Interfaces:**
- Consumes: the `House` test options from Task 6; `unexplained` and `nextPlan` in `reconcile.ts`, unchanged.
- Produces: no new exports. Behaviour:
  1. On a `started` or `reconnected` input, a plant light's unexplained change is no press (spec 3.7.5); a lighting switch's stays one, as today.
  2. A range save naming a plant light raises a `ParseError` whose message contains `is a plant light`, so the loop logs and drops it.
  3. Each plant light with a stored range rule or lighting switch overlay is named once in the turn's `errors`, when first found: `lighting: <switch> is a plant light; its saved range rule or switch overlay is ignored`. "First found" is read off the previous turn's Model; no new field in `AdapterState`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a start sends a plant light what the clock says, at any instant', () => {
  const on = plantHouse(); assert.equal(plantOut(on.turn('12:00:00', { kind: 'started' }))?.power, 'on');
  const off = plantHouse(states => { states['switch.plant_a'] = { state: 'on', attributes: {} }; });
  assert.equal(plantOut(off.turn('20:00:00', { kind: 'started' }))?.power, 'off');
});
test('a plant light switched by hand holds until the next day start', () => {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const pressed = house.turn('12:05:00', { kind: 'wake' });
  assert.equal(plantOut(pressed), undefined);
  assert.equal(pressed.state.model.plantOverrides.handSwitches[plantA]?.power, 'off');
  assert.equal(plantOut(house.turn('18:00:00', { kind: 'tick' })), undefined);
  assert.equal(plantOut(house.turn('2026-09-22T07:00:00', { kind: 'tick' }))?.power, 'on');
});
test('a hand switch survives a restart', () => {
  const house = handOffAt1205();
  house.state = undefined;
  assert.equal(plantOut(house.turn('12:30:00', { kind: 'started' })), undefined);
  assert.equal(house.states['switch.plant_a']!.state, 'off');
});
test('a plant light found changed when Home Assistant is back is put right, not held', () => {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const turn = house.turn('12:10:00', { kind: 'reconnected' });
  assert.equal(plantOut(turn)?.power, 'on');
  assert.equal(turn.state.model.plantOverrides.handSwitches[plantA], undefined);
});
test('Review Focus 1: a plug out of reach at its day start is sent its power when it is back, with no hold', () => {
  const house = plantHouse(); house.turn('06:00:00', { kind: 'started' });
  house.states['switch.plant_a'] = { state: 'unavailable', attributes: {} };
  assert.equal(plantOut(house.turn('07:00:00', { kind: 'tick' })), undefined);
  house.states['switch.plant_a'] = { state: 'off', attributes: {} };
  const back = house.turn('07:10:00', { kind: 'wake' });
  assert.equal(plantOut(back)?.power, 'on');
  assert.equal(back.state.model.plantOverrides.handSwitches[plantA], undefined);
});
test('a range save for a plant light is refused and logged', () => {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  const turn = house.turn('12:05:00', bridged('ls_range_save', { entity: 'switch.plant_a', profile: 'bright' }));
  assert.match(turn.dropped ?? '', /is a plant light/);
  assert.equal(turn.state.model.switchRanges[plantA], undefined);
});
test('a range rule stored for a plant light is said once', () => {
  const house = plantHouse(states => { states['sensor.ls_overrides']!.attributes.switch_ranges = { 'switch.plant_a': { profile: 'bright' } }; });
  const said = (turn: Turn) => turn.errors.filter(error => /switch\.plant_a is a plant light/.test(error)).length;
  assert.equal(said(house.turn('12:00:00', { kind: 'started' })), 1);
  assert.equal(said(house.turn('12:01:00', { kind: 'tick' })), 0);
});
test('a lighting switch\'s own button is still an overlay', () => {
  const house = plantHouse(); house.turn('12:00:00', { kind: 'started' });
  house.states['switch.plug_a'] = { state: house.states['switch.plug_a']!.state === 'on' ? 'off' : 'on', attributes: {} };
  assert.notEqual(house.turn('12:05:00', { kind: 'wake' }).state.model.overlays.switches[toSwitchId('switch.plug_a')], undefined);
});
```

For the range-save test the fixture needs `switch.plant_a` under a device in `houseView`'s `devices`, so the save reaches the plant-light check rather than the "not physical" one.

- [ ] **Step 2: Run to verify they fail**

Run: `node --experimental-strip-types --test --experimental-test-isolation=none tests/runtime/loop.test.ts`
Expected: FAIL on the reconnect, range-save and said-once tests; any of the others already passing after Task 6 stays as a regression test and is named as such in the commit body.

- [ ] **Step 3: Implement** the three behaviours in Interfaces. The plant-light check in `rangeSaved` (`inputs.ts`) comes before the other refusals.

- [ ] **Step 4: Verify**

Run: `npm run check && npm test`
Expected: check clean; 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(lighting): plant lights are put right at a start; range saves for them are refused" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Golden gate and whole-suite regression

**Files:** none changed unless a step fails.

- [ ] **Step 1: Run the whole gate**

Run: `npm run verify`
Expected: `check` clean; `npm test` 0 fail with the pass count 772 plus every test added above; `e2e` shows exactly the 20 baseline flow differences (mode_toggle 7, next_block_reset 10, person_change_then_expiry 3) and no other scenario differs. The golden house has no `plant_light` label, so plant lights add no scenario: there is no reference to record one from.

- [ ] **Step 2: If any number differs, stop and report** the scenario and the difference to the controller. Do not adjust a golden file, a named adjustment or a ceiling.

- [ ] **Step 3: The controller pushes**

```bash
git push origin ts-port/json-edges ts-port/json-edges:feature/typescript-lighting-scripts
```

---

### Task 9: Operator: Home Assistant side and the live check

Done by the operator through the Home Assistant MCP tools, after Task 8 is pushed. No code. Read the HA server's `home-assistant-best-practices` skill first, as its instructions require. Create nothing by editing `.storage` or YAML by hand.

- [ ] **Step 1: Ask the owner which plugs are the grow lamps.** Note each plug's entity id; `<object>` below is the id after `switch.`.

- [ ] **Step 2: Check the port will drive them.** Each plug must be in a room the port drives (`--live-rooms`), or the port must run with `--live-rooms all`; a plug in no room is driven only under `all`. If not, stop and ask the owner.

- [ ] **Step 3: Update the port on home-server** to the pushed commit: the server runs a working copy at `/var/lib/lighting-port/src` (see `docs/home-server/lighting-port.md` on `main`, "Reconciling edits into the repository"); bring the pushed branch in as `lighting-port` (`sudo -u lighting-port git -C /var/lib/lighting-port/src pull --ff-only`), and the dev watcher rebuilds and restarts the host by itself. Confirm in `journalctl -u lighting-port` that it is ready again with no errors. A pull that is not a fast-forward: stop and ask.

- [ ] **Step 4: Create the helpers**
  1. `input_number.ls_plant_hours`: min 0, max 24, step 0.5, initial 12, unit `h`.
  2. `input_boolean.ls_plants_all_off`.
  3. Per plug: `input_boolean.ls_plant_<object>_own_hours` (off) and `input_number.ls_plant_<object>_hours` (min 0, max 24, step 0.5, initial 12, unit `h`).
  4. Per plug, its own start: `input_boolean.ls_plant_<object>_own_start` (off) and `input_datetime.ls_plant_<object>_start` (time only, no date). With the switch on and a readable time the plug starts at that time every day of the week, in place of its room's day start; otherwise at the day start.

- [ ] **Step 5: Create the label `plant_light`** and put it on each plug. Do this last, so the helpers exist when the port first reads the plug as a plant light.

- [ ] **Step 6: Add a view called "Plants" to the existing dashboard**, kept the way that dashboard is kept:
  1. the default hours (`input_number.ls_plant_hours`);
  2. one row per plug: the plug's power, its own-start switch and start time, its own-hours switch, its hours, and "switches off at": the port's published `plant_switch_off` attribute on `sensor.ls_overrides` for that plug (ISO time in UTC, no key when the plug has no switch-off), shown as it is, with no recomputation in HA;
  3. `input_boolean.ls_plants_all_off`.

- [ ] **Step 7: Live check**
  1. Within a minute of labelling, each plug shows what the clock says (on between its start, its own or the day start, and that start plus its hours).
  2. Switch `input_boolean.ls_plants_all_off` on: every plug goes off within seconds, and `sensor.ls_overrides` has `plant_all_off.held`. Switch it off: they return to the timer.
  3. Switch one plug by hand in HA: it stays, and `plant_hand_switches` holds it.
  4. Switch a room off from its remote and press a mode toggle: the plugs do not move.
  5. Restart the port: no plug changes.
  6. Next morning: each plug went on at the day start, a hand switch from the day before was released at that plug's start (its own, else the day start), and the plug goes off after its hours. Report the times to the owner.

---

## Self-Review

1. **Spec coverage.** 3.1: Tasks 1, 3, 4. 3.2: Tasks 1, 2. 3.3: Tasks 2, 3, 5, 6, 7. 3.4: Tasks 2, 3. 3.5 and 3.6: Tasks 4, 9. 3.7 calls 1 to 7: Tasks 4/9, 2, 2/6, 3/4/7, 7, 1, 5. Acceptance 1: Task 2, with the restart case in Tasks 5 and 7. Acceptance 2: Task 3. Acceptance 3: Tasks 1, 3, 8. Acceptance 4: Task 9.
2. **Step scan.** Code blocks are test assertions and signatures; the only prose algorithms are the nine rules of Task 2, which the signatures and tests do not fix alone.
3. **Type consistency.** `PlantOverrides.handSwitches` / `allOff`, `PlantsAllOffSet`, `plantsAllOff`, `PLANTS_ALL_OFF` and the write kind `plants all-off` are spelled the same in Tasks 2, 3, 5, 6, 7.
4. **Review Focus.** Each of the five lines has its test in the named task.
5. **Proportion.** Fixed in review: `switchPower`'s skip moved from Task 1 to Task 3, where its failing test lives; a per-plug hand-switch message was dropped in favour of routing `switchButtonPressed` by the config's kind.
