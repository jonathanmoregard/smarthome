---
date: 2026-11-22
kind: design
status: draft, awaiting approval
pr: https://github.com/jonathanmoregard/smarthome/pull/39
scope: lighting-scripts/
---
# Lighting port: state, transitions, reconciler

## 1. Goal

Restructure the TypeScript lighting port around the owner's architecture
before PR #39 merges:

1. The domain is lighting state plus pure transitions. No plans, action lists
   or service calls in the domain.
2. An effect is one interface with two implementations, Candle and normal
   colour.
3. An adapter reads Home Assistant (HA) into domain messages, writes changed
   state back, and reconciles the real lamps and switches with the lighting
   state.
4. The host is a minimal wrapper: it wires the adapter to HA and MQTT and runs
   the loop.
5. Names come from the approved vocabulary: schedule, block, transition, wake
   light, effect, bulb, lamp, room, switch, remote, lighting state, overlay
   (the mode overlay is one kind), overlay reset, dashboard, config.

Lamp behaviour stays as it is today, except for the named changes in 1.1.

### 1.1 Named behaviour changes (everything else must match today)

1. Breathe and Colour loop are removed.
2. Reconciliation: any lamp or switch that differs from its target is put
   back, unless the difference is a real input (section 5.3).
3. Earlier approved divergences still apply: re-selecting a running effect
   keeps it running; a bulb coming back on fades in (0.4 s before an effect
   start, 0.2 s otherwise, the existing constants); scheduled fades are
   gradual in both directions; off has no colour; the firmware candle sends
   colour first, then the effect, and nothing after it carries On or a
   brightness move.

### 1.2 Out of scope

1. Moving persisted state out of HA sensors. It stays in HA "for now".
2. Dashboard changes. Dashboards keep reading `sensor.ls_overrides`
   (`switch_ranges`, `range_defaults`) and calling `script.ls_override_block`.
3. Firmware work.

## 2. Layers

| # | Layer | Folder | Knows about | Never knows about |
|---|---|---|---|---|
| 1 | Domain | `src/domain/` | vocabulary types, `Model`, `Msg`, `update`, `lightingState`, `Effect` | HA entity ids, JSON, MQTT, time sources, sends |
| 2 | Adapter | `src/adapter/` | HA state and events, codecs, observed bulb and switch state, reconciler, retries | what a lamp should show (it asks the domain) |
| 3 | Host | `src/host.ts`, `src/main.ts` | sockets, timers, the single-flight loop, the journal file, logging | any rule |

Dependency direction: host → adapter → domain. The domain imports nothing
outside `src/domain/`. The existing guards (`npm run check`) gain one rule
enforcing that.

`src/handlers/`, the script registry, `ctx.run`/`ctx.call`, `ls_*` script
entrypoints as code units, `Plan` types and `runtime/effects.ts`'s
service-call union go away by the end of the migration. The only `ls_*`
script names that survive are the ones HA itself calls (section 6.2).

## 3. Domain

### 3.1 Model

```ts
type Model = {
  config: Config;                       // schedule per house and room, lamps, bulbs, switches, rooms, remotes
  overlays: Overlays;                   // lamp, room and house overlays, with their resets
  modeOverlay: ModeOverlay;             // today's mode switch, as one overlay kind
  remotes: Record<RemoteId, RemoteModel>; // per-remote press state (the gestures Model)
  switchRanges: Record<SwitchId, RangeRule>;
  rangeDefaults: RangeDefaults;
  lampProfiles: Record<LampId, LampProfile>;
};
```

1. Every field is a domain type: tagged sums, branded ids, range types. No
   `Verbatim`, no wire keys, no `?: never` unions, no optional fields that exist
   only because JSON may omit them.
2. `Config` is parsed from the HA helpers (`input_text`, `input_datetime`,
   `input_number`, `input_boolean`) and the catalog. A bulb in two lamps is a
   config error rejected at parse, as `src/runtime/catalog.ts` already does
   today.
3. Derived values (room caches, gradients) are not in `Model`. If a cache is
   still needed for speed, it is a memo inside the adapter, keyed by the
   inputs, never persisted as truth.

### 3.2 Msg and update

```ts
type Msg =
  | { kind: 'clock'; now: Instant }
  | { kind: 'configChanged'; config: Config }
  | { kind: 'overlayRequested'; request: OverlayRequest }     // ls_override events, dashboard block/clear
  | { kind: 'lampChangedByPerson'; lamps: LampId[]; light: RequestedLight } // HA call by a user → hold
  | { kind: 'remotePressed'; remote: RemoteId; press: RemotePress }
  | { kind: 'switchButtonPressed'; switch: SwitchId; power: Power }
  | { kind: 'modeToggled'; on: boolean }
  | { kind: 'rangeSaved'; switch: SwitchId; rule: RangeRule }
  | { kind: 'lampProfileSaved'; lamp: LampId; profile: LampProfile };

function update(model: Model, msg: Msg): Model;
```

1. `update` is total and pure. Overlay resets that fall due are applied on
   `clock`.
2. Today's logic in `state-store.ts`, `remote-input.ts`, `gestures.ts`,
   `native-controls.ts`, `sara-mode.ts`, `overlay-resets.ts` and the range
   save becomes `update` cases, one module per concept (the module map in
   `r6-module-map.md`, section 2, minus every "plan", "dispatch", "render" and
   "bulb-commands" row).

### 3.3 Lighting state

```ts
type LampLight =
  | { power: 'off' }
  | { power: 'on'; level: Level; colour: Colour; effect: Effect; transition: Transition };
type Colour = { kind: 'kelvin'; kelvin: Kelvin } | { kind: 'rgb'; rgb: RGB };
type LightingState = {
  lamps: Record<LampId, LampLight>;
  switches: Record<SwitchId, Power>;
};

function lightingState(model: Model, now: Instant): LightingState;
```

1. This is today's schedule → overlay → resolution pipeline (`schedule.ts`,
   `resolution.ts`, `planning.ts`, `blend.ts`), returning a value instead of a
   plan.
2. `transition` says how to get there (scheduled fade, manual 0.2 s, 0.4 s
   with an effect). It is excluded from equality when the reconciler compares
   states.
3. The adapter also needs "when does this change next" to schedule its next
   wake-up: `nextChange(model, now): Instant | undefined`, pure.

### 3.4 Effect interface

```ts
interface Effect {
  readonly name: EffectName;               // 'Candle' | 'Normal'
  canRunOn(bulb: BulbInfo): boolean;      // Candle: our firmware build; Normal: always
  appearance(light: OnLight, bulb: BulbInfo): BulbAppearance;
}
type BulbAppearance =
  | { power: 'off' }
  | { power: 'on'; level: Level; colour: Colour; firmwareEffect: 'none' | 'candle' };
```

1. Two implementations: `candle` and `normal`. Callers never switch on effect
   names.
2. A lamp whose effect cannot run on one of its bulbs shows `normal` on that
   bulb (today's `candleLamps` rule, moved here).
3. The rule "colour first, then the effect, then nothing with On or a
   brightness move" is a sending rule. It lives in the adapter's encoder for
   `BulbAppearance`, not in the domain.

## 4. Persistence

1. `Model` is stored in the same HA sensors as today, through one codec per
   sensor in `src/adapter/codecs/`. The codec writes the attribute shapes the
   dashboards and the old scripts read, so old and new code can share state
   during the room-by-room rollout.
2. Malformed stored values recover to a named default (the 2026-11-19 and
   2026-11-21 rules), at the codec, never inside the domain.
3. Reconciler bookkeeping (what each bulb was last told, retries) lives in the
   adapter's own journal file, not in HA.
4. **Sharing with the old scripts during the rollout.** Each room is driven by
   exactly one system (`--live-rooms`). The codecs read, change and write
   back: fields of rooms the port does not drive are left exactly as found.
   M1 starts by listing every sensor field the old scripts read for any room
   (including `applied`, revision and generation guards and room caches, which
   the whole-house scripts may read across rooms). The new code keeps each of
   those valid until the last room is cut over, then stops writing them. This
   is a compatibility writer in the adapter, deleted at the end. The domain
   never sees those fields.

## 5. Adapter

### 5.1 Inputs to messages

Each current automation trigger maps to a message, or to the reconciler:

| # | Today's trigger | Becomes |
|---|---|---|
| 1 | time pattern, schedule helper changes, HA start | `clock`, `configChanged` |
| 2 | `ls_override` event, `script.ls_override_block`, `ls_clear_overrides` | `overlayRequested` |
| 3 | `call_service` `light.turn_on` with a user id and a brightness or colour key (the lamp change detector) | `lampChangedByPerson` |
| 4 | remote MQTT actions | `remotePressed` |
| 5 | effect preview MQTT (`house/v1/effect_preview/...`), dashboard sync | `overlayRequested` or `lampProfileSaved` |
| 6 | light and switch `state_changed`, bridge connection state | observation for the reconciler (5.3) |

### 5.2 Loop

The host runs one single-flight loop:

1. Turn the input into `Msg`s; `model = update(model, msg)` for each.
2. If `model` changed, write the changed sensors through the codecs.
3. `target = lightingState(model, now)`.
4. Run the reconciler against `target` and the observed state; perform its
   sends one at a time, updating the journal after each.
5. Sleep until the next input, retry timer or `nextChange`.

### 5.3 Reconciler

1. Pure functions in `src/adapter/reconcile.ts`:
   `nextSends(target, observed, beliefs, now) → { sends, wakeAt }` and
   `afterSend(belief, send, outcome) → Belief`. The belief, retry, park and
   flap rules are those of `reconciler-spec.md`, sections 2 and 3 (backoff
   1 s doubling to 60 s, 5 attempts, then parked; at most 6 re-applies per
   bulb per 10 minutes). The parts about `applied`, guards and the old
   dispatch go.
2. **Observed state** comes from HA `state_changed` for each bulb and switch.
   1. Compared attributes: power, level, and colour (kelvin, or RGB through
      the colour the bulb reports). The firmware effect is not reported by
      the bulb, so it is known only from the belief (what was last sent and
      not since invalidated).
   2. Tolerances are named constants, sized for round-trip loss: level ±2
      steps, kelvin ±50 K (mired rounding), RGB by distance in the bulb's
      reported xy. They are tuned once against a real bulb in M4.
   3. Where both exist, observation wins over belief: a reported value that
      differs from the belief invalidates the belief.
   4. "Still settling" lasts from a send until its transition plus a named
      settle margin (start at 2 s, measured in M4). Reports during that window
      are not differences.
3. **Classifying a difference** between observed and target:
   1. Our own send, still settling: wait.
   2. A switch changed and nothing we sent explains it: the plug's own button.
      The adapter emits `switchButtonPressed`, so the target moves.
   3. A person's HA call: already turned into `lampChangedByPerson` by 5.1
      row 3 before the state change arrives, so the target already matches.
   4. Anything else on a bulb (Zigbee2MQTT frontend, a power-loss reset, a
      stray group command, a missed message): send the target again.
4. A bulb that is unreachable or off at the wall is sent nothing. It is
   reapplied on its power-on event, with the fade from 1.1.3. A parked bulb is
   logged once per episode at info level.
5. Sends use Zigbee groups where every member needs the same appearance
   (today's `grouping.ts`, moved to `src/adapter/`).
6. The per-render timing on the runtime sensor is kept, written by the
   adapter.

### 5.4 Room-by-room rollout

`--live-rooms` stays. The adapter only sends to lamps and switches in live
rooms, and only emits messages for inputs in live rooms. State sensors are
shared with the old scripts, which keep driving the other rooms.

## 6. Acceptance: golden traces and differential fuzzing

### 6.1 What is compared

The end state of every lamp and switch: power, level, colour and firmware
effect per bulb, and switch power, at each checkpoint after the system
settles. For a scheduled fade, the checkpoints sample along the fade. The
exact commands sent are not compared.

### 6.2 HA boundary

Both systems see the same fake HA: helper states, the catalog, events, service
calls and MQTT messages in; light and switch states and the `ls_*` sensors
out. The `ls_*` sensor attributes the dashboards read are compared too.

The dashboards call three scripts: `script.ls_override_block`,
`script.ls_clear_overrides` and `script.ls_range_save`. They stay as HA
scripts that fire the `smarthome_script` event, the mechanism the port
already listens to, and the adapter turns each into a `Msg`. Every other
`ls_*` and `effects_*` script is called only by the old automations and goes
with them when the last room is cut over.

### 6.3 Harness

1. A world simulator: fake HA plus fake bulbs (power, level, colour, firmware
   candle that ends on On or a brightness move, unreachable, power-cycle) and
   fake plugs (with a button).
2. The reference drives today's Jinja scripts and automations through the
   existing preserved-test harness (the `reference` backend, dispatching
   captured automations by trigger). It runs in Python, so the comparison
   harness is Python.
3. The new system runs as its whole host, adapter and domain against the
   same simulator, through a test bridge.
4. **Golden traces:** scenarios written from today's tests and the owner's
   daily use (schedule day, remote presses, dashboard blocks, manual HA
   change then expiry, mode toggle, plug button, wall-switch power cycle,
   HA restart). Recorded once from the reference, checked into the public
   repo without household names or addresses, replayed against the new
   system.
5. **Fuzzing:** a property-based generator (Hypothesis) makes random input
   sequences over a small synthetic house (2–3 rooms, a few lamps with candle
   and non-candle bulbs, a plug, a remote). Each sequence runs on both systems;
   the end states must match, apart from the named changes in 1.1. Failures
   shrink to a minimal sequence, which is added as a golden trace.
6. Inputs that touch Breathe or Colour loop are never generated. Each
   remaining named change has one explicit, counted adjustment in the
   comparator, listed in the report.
7. **Inputs only the new system handles** (a Zigbee2MQTT frontend change, a
   stray group command, a missed message, a power-loss reset) are not
   fuzzed differentially: the old system leaves those lamps wrong by design.
   They are covered by new-system-only tests on the fake world (the cases in
   `reconciler-spec.md` section 6.2), which check that the target comes back.
8. **Fades.** The simulator applies a transition as a straight line from the
   start value to the target over its duration. Checkpoints compare settled
   states exactly (within the 5.3.2 tolerances), and the start, middle and
   end of each scheduled fade within ±1 % level (owner's choice). Both sides
   are deterministic on the same clock, so a miss is a real difference in the
   new code (for example starting a fade at the exact second where the old
   engine starts on the next minute tick) and gets fixed. The gradual off→on fade is
   one of the named adjustments.
9. **What "green" means.** Zero unexplained differences. Each difference found
   is either fixed in the port or recorded as a named divergence that the
   owner has approved. Today's documented baseline failures from the old
   harness are not carried over: the new harness compares behaviour, not
   assertions.
10. **Privacy.** The reference and anything recorded from the live catalog
    stay private, like `reference/` today. The repo holds the harness, the
    simulator, the synthetic house and any traces recorded on it.
11. **Feasibility spike, first in M0.** Prove that the reference harness can
    run a synthetic catalog and a multi-step sequence with time advancing to
    a settled state. If it can't, the fuzz runs on a private, anonymised copy
    of the live catalog instead, and the synthetic house is used only by the
    new-system-only tests.
12. **The old per-script parity is retired at the end of M0,** once the
    golden suite and fuzz pass on today's port. From M1 on, the gate is
    `npm run check`, `npm test`, golden and fuzz. Upstream logic tests worth
    keeping move to `tests/runtime/` as domain tests on `update` and
    `lightingState`.

## 7. Migration (each unit green; test first)

1. **M0, harness.** World simulator, reference driver, golden scenarios,
   fuzz generator, run against the current port (PR #39 at e6fd238). This
   measures how far today's port already matches before anything moves.
2. **M1, domain types.** `Model`, `Msg`, `LampLight`, `Colour`, `Effect`
   with the two implementations; codecs for the sensors. Breathe and Colour
   loop removed.
3. **M2, `lightingState`.** Schedule, overlays and resolution return a value
   computed from `Model`; plans removed. This comes before `update` because
   the script handlers that only read state (planning, render) have no
   message; once they are gone, what is left maps onto messages.
4. **M3, `update`.** One concept at a time, each replacing its script
   handler. Nothing needs keeping alive in between: golden and fuzz test
   the whole system, not the handlers.
5. **M4, reconciler.** `src/adapter/reconcile.ts` with the fake-bulb tests
   from `reconciler-spec.md` section 6.2, then live in the loop.
6. **M5, host cut.** Handlers, registry, `ctx.run`, guards and `applied`
   deleted; `host.ts` split into `src/adapter/` and a small `src/host.ts`.
7. **M6, close-out.** Golden and fuzz green, compatibility writer (4.4) kept
   until the last room is cut over, ARTL review,
   rollout bits (live rooms, heartbeat, watchdog) re-fitted, runbook updated.

## 8. Assumptions

1. The person-change detector's rules stay as today: a user id, a `turn_on`,
   a brightness or colour key, and not caused by a running script.
2. A switch state change that our own send does not explain is treated as the
   plug's button, including a switch toggled from the Zigbee2MQTT frontend.
   Bulbs and switches differ here by the owner's choice.
3. Wall-switch power loss on a smart bulb is not an input: the bulb gets its
   target back on power-on.
4. Rooms the port does not yet drive keep working through the old scripts
   until `--live-rooms` covers them.
