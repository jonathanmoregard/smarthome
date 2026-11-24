---
kind: inventory
date: 2026-11-22
milestone: M1
---
# The sensor fields the old scripts read

This is the checklist for `encodeOverrides` (`src/adapter/codecs/overrides-sensor.ts`) and, from M6, for the compatibility writer. It has one row per attribute and per stored overlay field of the overrides sensor, the runtime sensor and the room cache sensors. It was built by searching the old scripts, and only field and script names are taken from them.

Columns:

1. `field`: the attribute, or the path inside an overlay entry of `overrides`.
2. `read by`: the old scripts and automations that read it.
3. `across rooms`: `yes` when an old script that drives one room reads the field as another room, or the whole house, left it.
4. `owner`: `Model.<path>` when the Model holds it; `left out: <n>` (reasons 1 to 5 of Task 5's list below) when no lighting rule needs it and no room shares it; `carried` when it is `across rooms: yes` and has no Model owner.

Task 5's reasons for leaving a field out of the Model:

1. Who set an overlay (`who`, `via`) and when it was first made (`created`).
2. An effect's `instance` text.
3. The remote overlay's cache of the schedule (`remote_valid_until`, `remote_timing_revision`).
4. Old stored shapes no code writes any more.
5. Bookkeeping in the overrides and runtime sensors, and the room caches.

Entities are written with `<room>` for a room id.

## Carried: what the M6 compatibility writer keeps valid

The Model owns none of these, and each is read across rooms. The codecs never write them: `encodeOverrides` copies them from the sensor as found. While any room is still driven by the old scripts, each one has to stay in the shape the old scripts expect.

M6 Task 1 found that no compatibility writer is needed for that. With the old-side patch (the old scripts skip a room whose port switch is on), the old scripts keep every row valid themselves as long as the port never writes it, and every write of the port moves the store's revision (row 1): an old render planned before a port write is not marked handled (`ls_render` checks the revision before it records `handled_rooms` and `handled_full`), so the old recovery runs it again. `tests/runtime/live-rooms.test.ts` holds one test per row.

| # | Entity | Field | Why it matters while rooms are shared |
|---|---|---|---|
| 1 | `sensor.ls_overrides` | state and `last_updated` | It is the store's revision. Each write by the port moves it, so an old script's commit planned against the older revision is refused and retried. |
| 2 | `sensor.ls_overrides` | `pending_rooms` | It is the render queue every old render drains. |
| 3 | `sensor.ls_overrides` | `last_request`, `received_at` | These stamp the request the next old render answers. |
| 4 | `sensor.ls_overrides` | `full_version`, `full_reason`, `full_lights` | These are the full-render request that old renders and the pending-output recovery compare with the runtime's `handled_full`. |
| 5 | `sensor.ls_effects_runtime` | `targets`, `assignments`, `applied`, `revision`, `generation`, `plan_order` | These are the house-wide record of what every lamp was sent. |
| 6 | `sensor.ls_effects_runtime` | `handled_full`, `handled_rooms` | These record which render requests have been answered. |
| 7 | `sensor.ls_effects_runtime` | `transport_recovery` | It is the retry ledger for every bulb. |
| 8 | `sensor.ls_effects_runtime` | `candle_group`, `candle_response`, `candle_syncing`, `candle_retry_at`, `candle_error` | These belong to the old software candle's group sync, which runs in the rooms the old scripts still drive. |
| 9 | `sensor.ls_cache_<room>` | `cache.gradients` | A whole-house plan reads every room's cached gradients. |

## `sensor.ls_overrides` attributes

| # | field | read by | across rooms | owner |
|---|---|---|---|---|
| 1 | state and `last_updated` | ls_commit, ls_plan, ls_room_plan, ls_remote_plan, ls_base, ls_room_base, ls_render, ls_dispatch, effects_assign, effects_emit, effects_engine | yes | carried |
| 2 | `overrides` | ls_base, ls_room_base, ls_plan, ls_room_plan, ls_remote_plan, ls_commit, ls_render, `ls_<mode>_mode`, lighting_schedule_end_overrides, `lighting_schedule_<mode>_mode_switch` | yes | `Model.overlays`, `Model.modeOverlay` (each entry: next section) |
| 3 | `power` (room to boolean) | ls_commit, ls_plan, ls_room_plan, ls_remote_plan, effects_candle_plan, effects_emit, effects_engine, lighting_recover_failed_zigbee_commands | no (one key per room) | `Model.overlays.roomPower` |
| 4 | `switch_ranges` (switch to rule) | ls_base, ls_room_base, ls_plan, ls_room_plan, ls_remote_plan, ls_commit, ls_range_save, effects_set | yes (its keys add rooms to every schedule pass) | `Model.switchRanges` |
| 5 | `range_defaults` | ls_plan, ls_room_plan | yes | `Model.rangeDefaults` |
| 6 | `switch_overlays` (new: switch to `{power, when}`) | none (written by the port only) | no | `Model.overlays.switches` |
| 6a | `plant_hand_switches` (new: plant light to `{power, when}`) | none (written by the port only) | no | `Model.plantOverrides.handSwitches` |
| 6b | `plant_all_off` (new: the one key `held`, to `{when}`) | none (written by the port only) | no | `Model.plantOverrides.allOff` |
| 7 | `remote_ack` (source to request id) | ls_commit | no (one key per remote) | left out: 5 |
| 8 | `last_via` | none (ls_commit writes it) | no | left out: 5 |
| 9 | `pending_rooms` | ls_commit, ls_render, lighting_recover_pending_output | yes | carried |
| 10 | `last_request` | ls_commit, ls_render | yes | carried |
| 11 | `received_at` | ls_commit, ls_render | yes | carried |
| 12 | `full_version` | ls_commit, ls_render, lighting_recover_pending_output | yes | carried |
| 13 | `full_reason` | ls_commit, ls_render | yes | carried |
| 14 | `full_lights` | ls_commit, ls_render | yes | carried |

## Fields of an overlay entry in `overrides`

An entry is shared across rooms when its key is `block:house` or `mode:<name>` (`<name>`, and `<mode>` in the old scripts' names, is the house mode's name in the catalog's `"mode"`), or its scope is `house`. Every other entry concerns one room or one lamp, so its fields are `across rooms: no` except where a row says so.

| # | field | read by | across rooms | owner |
|---|---|---|---|---|
| 1 | the entry's key | every reader of `overrides` | yes for `block:house` and `mode:<name>` | each overlay's identity: `blocks[<room or house>]`, `remotes[].source`, `lamps[].over` with `from`, `modeOverlay` |
| 2 | `kind` | ls_base, ls_room_base, ls_room_plan, ls_remote_plan, ls_commit, effects_resolve | no | the overlay kind |
| 3 | `scope`, `target` | ls_base, ls_room_base, ls_room_plan, ls_remote_plan, ls_commit, effects_resolve, effects_native_plan, effects_set | yes for scope `house` | `lamps[].over`, `remotes[].room` (scope `house`: left out: 4) |
| 4 | `value` of a block entry | ls_base, ls_room_base, ls_room_plan | yes for `block:house` | `Model.overlays.blocks[<room or house>].block` |
| 5 | `value` of the mode entry | none (the key's presence is read) | yes | `Model.modeOverlay.active` |
| 6 | `when` | ls_base, ls_room_base, ls_room_plan, ls_remote_plan, ls_commit, effects_resolve, lighting_schedule_end_overrides | yes for house-wide entries | `since` of each overlay |
| 7 | `created` | ls_commit | no | left out: 1 |
| 8 | `who` | ls_commit | no | left out: 1 |
| 9 | `via` | ls_base, ls_room_base, ls_room_plan, ls_remote_plan, ls_commit, effects_resolve | no | left out: 1 (a `channels` entry with via `remote` is the old remote shape: left out: 4) |
| 10 | `key`, `source` inside the entry | ls_commit | no | left out: 1 (the entry's key is the identity) |
| 11 | `value.step_range` (remote) | ls_remote_plan, effects_resolve | no | `remotes[].stepRange` |
| 12 | `value.adjustment.steps`, `.lower`, `.upper` | ls_remote_plan, effects_resolve | no | `remotes[].adjustment.steps`, `.lower`, `.upper` |
| 13 | `value.adjustment.anchor` | ls_remote_plan, effects_resolve | no | `remotes[].adjustment.from` (`day` or `cosy` reads as `value.period` when that is `day` or `cosy`, as the resolver swaps it) |
| 14 | `value.adjustment.updated` | ls_remote_plan, effects_resolve | no | `remotes[].adjustment.at` |
| 15 | `value.adjustment.last` | effects_resolve | no | `remotes[].adjustment.lastPress` |
| 16 | `value.adjustment.has_up` | ls_remote_plan, effects_resolve | no | `remotes[].adjustment.everBrighter` |
| 17 | `value.adjustment.legacy_position` | effects_resolve | no | left out: 4 |
| 18 | `value.selection` (remote) | ls_remote_plan, effects_resolve | no | `remotes[].preset.choice` |
| 19 | `value.period`, `value.period_updated` | ls_base, ls_room_base, ls_room_plan, ls_remote_plan, effects_resolve | no | the day or cosy preset's `since`; the candle preset's `block` |
| 20 | `value.selection_updated` | ls_remote_plan, effects_resolve | no | the candle preset's `since` |
| 21 | `value.selection_input` | ls_remote_plan, effects_resolve | no | the candle preset's `adjustment` |
| 22 | `value.selection_instance` | effects_resolve | no | left out: 2 |
| 23 | `value.preset_contexts` | ls_remote_plan | no | `remotes[].remembered` (an entry for a removed effect: left out: 4) |
| 24 | `value.remote_valid_until`, `value.remote_timing_revision` | ls_remote_plan | no | left out: 3 |
| 25 | `value.legacy_channels`, `value.position` | effects_resolve, ls_remote_plan | no | left out: 4; a `legacy_channels` mapping under a chosen effect makes the preset none and drops an adjustment equal to `selection_input`, as the resolver claims neither; a preset change clears it |
| 26 | `value.channels.brightness`, `value.channels.color` of kind `constant` | effects_resolve, ls_remote_plan (brightness `updated`), ls_commit | no | `lamps[].brightness`, `lamps[].colour` (`fixed` with a value, `schedule` without) |
| 27 | the same, of kind `effect` | effects_resolve, ls_commit | no | `lamps[].effect` (`Candle` is the candle, `Normal light` the normal light, any other name `schedule`); the normal light is written as held constants (row 33), never as an effect claim |
| 28 | the same, of kind `scale` or `input` | effects_resolve | no | left out: 4 |
| 29 | `...effect.instance` | effects_resolve, effects_frame_plan | no | left out: 2 |
| 30 | `...effect.intensity` | effects_resolve, effects_frame_plan | no | `lamps[].brightness` (`fixed`, at the effect's time); an effect older than both parts is written from the level's time at the level |
| 31 | `...effect.underlying` | effects_resolve, ls_commit | no | `lamps[].brightness`, `lamps[].colour` (the part held under the effect) |
| 32 | `...updated` of a channel | effects_resolve, ls_remote_plan, ls_commit | no | the part's `at` |
| 33 | `value.selection` (dashboard effect pick; the port also writes it on a person's reset) | none | no | `Normal light` with both channels held as constants: `lamps[].effect` `normal` at the earlier constant's time, from any control; otherwise left out: 1. Today's person reset (effects_native_plan) writes no `selection`, so a stored one reads as fixed parts only |
| 34 | an entry of kind `light`, or a `channels` entry with scope `house` | ls_base, effects_resolve | yes for scope `house` | left out: 4 |
| 35 | `value.power` `off` of a `channels` entry (new, 2026-11-23: a person's or a control's off is a hold) | none (today's readers see a record with no channel claims) | no | `lamps[]` of kind `off`; the port writes it with empty `channels` and no `selection`; it reads as off only while `channels` is empty (today's ls_commit merges a light over it and keeps `power`); any other value is ignored and the record reads as its channels |

## `sensor.ls_effects_runtime` attributes

| # | field | read by | across rooms | owner |
|---|---|---|---|---|
| 1 | state (the generation) | ls_dispatch | yes | carried (with `generation`) |
| 2 | `targets` | effects_assign, effects_ui_sync, ls_dispatch, ls_render, lighting_recover_failed_zigbee_commands | yes | carried |
| 3 | `assignments` | effects_assign, effects_candle_plan, effects_emit, effects_engine, effects_filter_commands, effects_lifecycle, effects_route, effects_ui_sync, ls_dispatch, ls_render | yes | carried |
| 4 | `applied` | effects_assign, ls_dispatch | yes | carried |
| 5 | `revision` | effects_assign, effects_engine | yes | carried |
| 6 | `generation` | effects_assign, effects_emit, effects_engine, ls_dispatch | yes | carried |
| 7 | `plan_order` | effects_assign, ls_dispatch | yes | carried |
| 8 | `handled_full` | ls_commit, ls_render, lighting_recover_pending_output | yes | carried |
| 9 | `handled_rooms` | ls_render, lighting_recover_pending_output | yes | carried |
| 10 | `last_latency` | none (ls_render writes it) | no | left out: 5 |
| 11 | `transport_recovery` | lighting_recover_failed_zigbee_commands | yes | carried |
| 12 | `candle_group`, `candle_response`, `candle_syncing`, `candle_retry_at`, `candle_error` | effects_candle_plan, effects_candle_sync | yes | carried |

## `sensor.ls_cache_<room>` attributes

| # | field | read by | across rooms | owner |
|---|---|---|---|---|
| 1 | `cache.version`, `cache.room` | ls_room_plan | no | left out: 5 |
| 2 | `cache.dependencies`, `cache.periods` | ls_room_plan | no | left out: 5 |
| 3 | `cache.baseline` | ls_room_plan, ls_remote_plan (forwarded to ls_room_plan) | no | left out: 5 |
| 4 | `cache.gradients` | ls_room_plan, ls_plan | yes (a whole-house plan reads every room's) | carried |
| 5 | `cache.catalog` | ls_room_plan | no | left out: 5 |
| 6 | `cache.valid_from`, `cache.valid_until` | ls_room_plan | no | left out: 5 |
