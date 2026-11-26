---
date: 2026-11-24
kind: design
status: approved 2026-11-24
pr: https://github.com/jonathanmoregard/smarthome/pull/39
scope: lighting-scripts/
---
# Plant lights

## 1. Intent

Sara has bought grow lamps for the house plants. They hang on smart plugs.
The plants want a fixed daily photoperiod: on when the day starts, then on
for a set number of hours, 12 by default. The owner wants this inside the
lighting port as a proper concept, not a special case bolted onto the
lighting switches ("so we don't just monkey patch it").

Owner, verbatim (2026-11-24):

- "these on-off switches Start in the day, and then they are on for a set of
  time until they are switched off. And the default for that amount of time
  is 12 hours, but I want that to be configurable individually per lamp, and
  I also want the default to be configurable."
- "I want the plant lights to keep running even though you turned the rest of
  them off. So the only real thing that they share with the rest of the
  schedule is the start time for the day."
- On a plug switched by hand: "I'd say reset each morning."
- "Would also like a plant dash in HA where I can set default H and H per
  lamp, and also an override for turning them all off"
- On the all-off override: "hand control back for next morning".

## 2. Goals, non-goals, anti-goals

Goals:

1. A plant light is on from its day start for its hours, and off the rest of
   the day.
2. Hours: one house default (12 to start), and an optional own value per plant
   light.
3. A person switching a plant light by hand (its own button, or in HA) holds
   that power until the plug's next start (its own start when set, else the
   room's day start).
4. One "all plant lights off" control holds every plant light off until each
   plug's next start (its own start when set, else the room's day start).
5. A "Plants" view in HA to set the default hours, each plant light's hours,
   and the all-off control, and to see each plant light's state.

Non-goals:

1. Light intensity, dimming, sunrise ramps or DLI. Plant lights are plain
   on/off plugs.
2. (Superseded 2026-11-26: a plant light can have its own start, one time every day, in place of the day start; see the plan's Task 9 helpers.) Per-plant start times that differ by weekday.
3. Seasons, grow phases, or schedules that change by date.

Anti-goals (failures even if it technically works):

1. A plant light that follows anything of the lighting except the day start:
   room power, remotes, the mode overlay (Sara mode), block holds, range
   rules, the block on/off setting, the next-block reset or a clear-all.
2. Timer state that a restart (port, HA, server, power cut) loses or skews.
   After any restart a plant light must show what the clock says it should.
3. A fourth branch in today's `switchPower` chain that silently decides a
   plug's kind from which settings happen to exist.
4. A second sender for the plugs (an HA automation or blueprint next to the
   port).

## 3. Decided design

### 3.1 A switch's kind is explicit

Today `switchPower` (`src/domain/switches.ts:102`) works a switch's
behaviour out of which settings exist: an overlay, else a range rule, else
the `on_off` label, else nothing. Plant lights make that an explicit choice.

The config gives each switch a kind:

- a lighting switch: today's behaviour, unchanged (overlay, range rule, the
  plug's profile, the block's on/off setting);
- a plant light: section 3.2.

The config codec decides the kind from HA labels: a plug labelled
`plant_light` is a plant light. The existing `on_off` label and range rules
keep making lighting switches.

`switchPower` handles lighting switches only. Plant lights get their own
function, in their own module (3.4). The reconciler and the HA writes for a
switch's power are shared: once a power is decided, sending it is the same
for both kinds.

### 3.2 When a plant light is on

The rule is computed from the clock, never stored or counted down:

1. Its start is its own start where it has one (one time every day of the week,
   `ls_plant_<object>_own_start` on and `ls_plant_<object>_start` readable);
   else its day start, which is the day start of the plug's room: the room's own day
   timing where the room has one, else the house's, with the weekday and
   weekend times exactly as the lamps use them (`blockPosition` /
   `timingOf` in `schedule.ts`). A plug in no room uses the house's.
2. Its hours are its own hours where it has them, else the house default.
3. It is on from the most recent day start for its hours, and off from then
   until the next day start. 24 hours or more is on all the time. 0 hours is
   off all the time.
4. A plant light is never touched by a scheduled fade: it switches at the
   instant the day block starts (the block start, not the fade start).

### 3.3 Overrides, both reset at the plug's next start

1. **Hand switch.** A plant light's power changed by a person (its own
   button, or switched in HA; the reconciler already reports such a change as
   `switchButtonPressed`) holds that power until that plug's next start (its
   own start when set, else the room's day start). Then the timer rule applies again.
2. **All off.** The all-off control, switched on, holds every plant light off
   until each plug's next start. At that start control goes back to the timer
   (each plug's own start when set, else its room's day start, if they differ)
   and the control shows off again.
3. If both apply, the newer one wins: switching one plug on by hand after
   "all off" turns that one plug on.

Both overrides are stored where today's overlays are (`sensor.ls_overrides`),
with the instant they were set, so they survive restarts. Whether one still
applies is computed from that instant and the clock. The lighting's overlay
resets (next block, age limit, set time, clear-all) do not apply to them.

### 3.4 Where it lives

A new domain module, `src/domain/plant-lights.ts`, per the owner's rule "one
module per concept; a type's coupled functions sit next to it". It holds the
plant light types, the hours setting, the overrides, their messages and
update, and the function that gives each plant light's power at an instant.
It shares only the day-start lookup with `schedule.ts`.

The Model gains the plant overrides. The Msg union gains the messages for
the all-off control and the hours saved, with the same shape as today's
range and profile saves. The adapter reads the labels and helpers into
Config, reads the dashboard's control into the new messages, and writes the
all-off control's mirror back.

### 3.5 Settings in HA

Same patterns as the existing helpers (`ls_` prefix; "own or house" as
today's room timing uses it):

1. `input_number.ls_plant_hours`: the house default, 0 to 24, step 0.5,
   initially 12.
2. Per plant light: an "own hours" on/off and an hours number, both named
   after the plug. Off means the plug follows the default.
3. `input_boolean.ls_plants_all_off`: the all-off control. The person turns it
   on; the port turns it off again at the day start that releases it.

### 3.6 The Plants view

A view called "Plants" on the existing dashboard:

1. The default hours.
2. One row per plant light: its power now, its own-hours switch and hours,
   and when it switches off today.
3. The all-off control.

A plug appears there once it has the `plant_light` label.

### 3.7 Designer's calls (made by the designer, for the owner to check)

1. **Helpers are made, not provisioned by the port.** When a plug becomes a
   plant light, the operator (Claude, through the HA tools) adds its label,
   its two hours helpers and its row in the Plants view. The port only reads
   helpers: a plant light with no hours helpers, or with its own-hours switch
   off, follows the default.
2. **All off, rooms with different day starts.** Each plant light is held off
   until its own next start (its own start when set, else its room's day start). The control shows on while any plant light is
   still held by it, and the port turns it off when the last one is released.
3. **Turning all off off by hand** ends the hold at once: every plant light
   goes back to its timer (a hand switch newer than the all-off still holds).
4. **One kind per plug.** A plug labelled `plant_light` is a plant light,
   whatever else is stored for it: a range rule or a lighting overlay saved for
   it is ignored, logged once, and a range save from the dashboard for it is
   refused and logged. It never becomes a lighting switch while labelled.
5. **A plug found in the wrong state is put right, not held.** A plug whose
   power differs from its computed power at a start, or after HA or the bridge
   comes back, is sent its computed power. Only a change the reconciler sees
   happen while it runs, and cannot explain by its own send (today's
   `switchButtonPressed` path), is a hand switch.
6. **The day start** is the start of the `day` block, the first of the three
   blocks (day, cosy, night), which every room has through its own timing or
   the house's.
7. **Stored overrides** are new keys in `sensor.ls_overrides`; an absent key
   means none, so stored state from before needs no migration.

## 4. Left to the builder

1. Exact helper names per plug (slug from the entity id, as other per-entity
   helpers are named), and whether the "switches off at" time is a template
   sensor or computed by the port and written to a helper.
2. How the Plants view is created: through the HA MCP dashboard tools or a
   stored YAML, consistent with how the existing dashboard is kept.
3. The test layout, following `tests/runtime/` and the golden harness.

## 5. Acceptance

1. Unit tests on the plant-light module: on and off at the day start plus the
   hours, weekday and weekend, a room with its own day timing, hours 0 and 24,
   the default versus own hours, a hand switch held until the plug's next start,
   all-off held until the plug's next start and the newer of the two winning,
   and a restart at any instant giving the same power (no stored timer).
2. Room power, remotes, the mode overlay, block holds and a clear-all leave a
   plant light's power unchanged (one test each).
3. Today's lighting switches behave exactly as before: the existing switch
   tests and the golden replay show no new differences.
4. Live: a plug labelled `plant_light` goes on at its next start, off
   after its hours, and the Plants view sets the hours and the all-off control.
