---
name: add-lamp
description: Use when a new lamp, bulb or smart plug has been paired in Zigbee2MQTT and must join the home lighting schedule — "new lamp in <room>", "add the lamp everywhere", "I paired a bulb", a light entity still named like light.0xa4c1…, or a lamp missing from the room tile, room group, engine trigger or per-lamp settings. Drives Home Assistant through the home-assistant MCP tools; no repository change.
---

# Add a lamp

A scheduled lamp is wired into eight places. Missing any one of them gives a
lamp that mostly works and then fails in one situation (wall power restored,
room tile, per-lamp settings). Do every step, in order. Every step is
idempotent: check first, skip when already done, so the skill can resume a
half-finished lamp.

All of this is Home Assistant / Zigbee2MQTT runtime state. Nothing goes in
the repository.

## Inputs

Settle these before writing anything. Ask the user only for what you cannot
derive.

| Input | Example | How to get it |
|---|---|---|
| New entity | `light.0xa4c138eec10a5f95` | The light whose name is still the IEEE address; `ha_get_device(entity_id=…)` gives `device_id`, `ieee_address`, `friendly_name` |
| Room area | `meditation_mys` | From the user; must be an existing area (`ha_list_floors_areas`) |
| Lamp key | `meditation_ceiling` | `<area prefix>_<what it is>` in English, matching siblings in the room (`ha_search(area_filter=…, domain_filter="light")`) |
| Display name | `Mys taklampa` | Swedish, like siblings |
| Kind | bulb / fixture / plug | One bulb = bulb. Several bulbs in one fixture = fixture. On/off only = plug |

The new entity id becomes `light.<lamp key>`. The per-lamp helpers use the
same key.

## Write-tool gate

`ha_config_set_helper`, `ha_config_set_automation` and
`ha_config_set_dashboard` need `BestPracticeKey`. Read any skill reference
once (`ha_get_skill_guide(file="references/helper-selection.md")`), take the
`Acknowledgment key` from the top, and pass it with `MandatoryBPS=false`.
It rotates hourly. `ha_set_entity`, `ha_set_device` and `ha_call_service`
take no key.

## Zigbee2MQTT requests

Every `zigbee2mqtt/bridge/request/...` goes out with
`ha_call_service("mqtt", "publish", ...)`, which reports success even when
Zigbee2MQTT rejects the request. Check each one's answer:
`ssh -o UserKnownHostsFile=nixos/hosts/home-server/known_hosts home-server 'journalctl -u zigbee2mqtt --since -5min --no-pager | grep bridge/response'`
must show `"status":"ok"`.

Address devices by `ieee_address` (from `ha_get_device`), not by name: the
Home Assistant device name is not always the Zigbee2MQTT friendly name.

## Start with the Verify search

Run Verify step 2 first. What already exists tells you which steps to skip.

## Never switch the lamp from the agent

Any `light.*` call made with the agent's token counts as a person setting the
lamp by hand and records a hold in `sensor.ls_overrides`. Don't call
`light.turn_on`/`turn_off` to test. If one slipped out, clear it in step 8.
Never push lamps out of the Night block for a test in the evening.

## Steps

### 1. Zigbee2MQTT friendly name

Skip if `friendly_name` already equals the display name.

`ha_call_service("mqtt", "publish", data={"topic": "zigbee2mqtt/bridge/request/device/rename", "payload": "{\"from\": \"<ieee>\", \"to\": \"<display name>\", \"homeassistant_rename\": false}"})`

Friendly names reject `#` and `+`. Confirm with the response on
`zigbee2mqtt/bridge/response/device/rename` (`"status":"ok"`), visible with
`ssh home-server journalctl -u zigbee2mqtt --since -5min | grep response`.

### 2. Home Assistant entity and device

One call:
`ha_set_entity("<new entity>", new_entity_id="light.<lamp key>", new_device_name="<display name>", area_id="<area>", labels=[<label>], label_operation="add")`
where label is `house_schedule` (bulb, fixture) or `on_off` (plug). Then
`ha_set_device(<device_id>, area_id="<area>")` so the device sits in the room
too.

**Fixture:** pair every bulb, name them `<display name> #1`, `#2`…, entity
ids `light.<lamp key>_bulb_1`…, put them in the area, hide them
(`hidden=True`) and give them NO label. Then create a Zigbee2MQTT group for
the fixture (`bridge/request/group/add` `{"friendly_name": "<display name>"}`,
then `bridge/request/group/members/add` `{"group": "<display name>", "device": "<bulb friendly name>"}` per bulb). The group's light entity is the
lamp: rename it to `light.<lamp key>`, area, label `house_schedule`.

### 3. Room Zigbee group

Each room has one light that switches the whole room; the room tile on
`/house-lights` points at it. Find the room tile:
`ha_config_get_dashboard(url_path="house-lights")`, section "Rooms" (tiles
are named after the room).

- **Tile points at a Zigbee2MQTT room group** (its state has
  `group_entities` covering the room, e.g. `light.kitchen_all`): add the new
  bulb(s) with `bridge/request/group/members/add`
  `{"group": "<group friendly name>", "device": "<bulb ieee>"}`.
- **Tile points at a Home Assistant light group** (its state has
  `entity_id`, e.g. `light.living_room`): add `light.<lamp key>` to its
  members. `ha_get_entity` → `config_entry_id` →
  `ha_get_integration(entry_id=…, include_options=True)` for the current
  `entities`, `hide_members`, `all` → `ha_config_set_helper(helper_type="group", helper_id=<entry>, config={...all three, entities extended})`.
- **Tile points at a single lamp or at one fixture's group** (a labelled
  `house_schedule` lamp — that is a lamp, not a room group), **or the room has
  no tile:** create a Zigbee2MQTT group named after the room (e.g. `Mysrum`)
  with every bulb in the room (fixture bulbs, not fixture groups). Its HA
  entity appears auto-named (`light.mysrum`): rename it to
  `light.<area>_all`, put entity and device in the area, give it **no**
  label (a labelled room group would be scheduled as a lamp), and point the
  room tile at it (step 7). State `unknown` right after creation is normal.

Bulbs that are offline (wall switch off) cannot be added; Zigbee2MQTT answers
`"status":"error"`. Report which ones and retry when they are powered.

### 4. All Lamps group

`light.home` ("All Lamps" tile) is a Home Assistant light group. Add
`light.<lamp key>` to its members the same way as an HA room group.

### 5. Per-lamp settings helpers

Nine helpers, all labelled `lamp_override`, for each block `day`, `cosy`,
`night`. Plugs skip this step (they use
`input_boolean.ls_<lamp key>_<block>_on_off` instead).

a. `input_text` — `ha_config_set_helper(helper_type="input_text", action="create", name="ls_lamp_<key>_<block>", min_value=0, max_value=255, mode="text", labels=["lamp_override"])`

b. Template light — `helper_type="template"`, `name="ls lamp <key> <block>"`,
`labels=["lamp_override"]`, with `S = input_text.ls_lamp_<key>_<block>`:

```json
{"next_step_id": "light",
 "state": "{{ (states('S') | from_json(default={})).get('on', false) }}",
 "level": "{{ (states('S') | from_json(default={})).get('b', 255) }}",
 "hs": "{% set c = states('S') | from_json(default={}) %}{{ (c.get('h', 0), c.get('s', 0)) if c.get('m') == 'hs' else none }}",
 "temperature": "{% set c = states('S') | from_json(default={}) %}{{ (1000000 / c.get('k', 3500)) | round(0) | int if c.get('m', 'ct') == 'ct' else none }}",
 "turn_off": [{"action": "script.ls_store", "data": {"on": false, "store": "S"}}],
 "turn_on": STORE, "set_level": STORE, "set_hs": STORE, "set_temperature": STORE}
```

where `STORE` is
`[{"action": "script.ls_store", "data": {"brightness": "{{ brightness | default(none) }}", "hs": "{{ hs | default(none) }}", "kelvin": "{{ color_temp_kelvin | default(none) }}", "mireds": "{{ color_temp | default(none) }}", "on": true, "store": "S"}}]`.

c. Override switch — `helper_type="template"`,
`name="ls lamp <key> <block> override"`, `labels=["lamp_override"]`:

```json
{"next_step_id": "switch",
 "value_template": "{{ (states('S') | from_json(default={})).get('own', false) }}",
 "turn_on": [{"action": "script.ls_store", "data": {"own": true, "store": "S"}}],
 "turn_off": [{"action": "script.ls_store", "data": {"own": false, "store": "S"}}]}
```

Resulting ids: `input_text.ls_lamp_<key>_<block>`,
`light.ls_lamp_<key>_<block>`, `switch.ls_lamp_<key>_<block>_override`. When
in doubt, compare with an existing lamp's entries
(`ha_get_integration(domain="template")`).

### 6. Engine power-restore trigger

`automation.lighting_schedule_engine` has a state trigger (`from:
[unavailable, unknown]`, `to: on`, id `lamp_on`) with a static list of every
scheduled lamp. Without the new lamp there, restoring wall power leaves it
at its power-on default until some unrelated re-apply. Read the automation,
then `python_transform` with the `config_hash`: append `light.<lamp key>` to
that trigger's `entity_id` list (find the trigger by `from`, not by index).

### 7. Dashboard

`/house-lights` "Rooms" section: the room tile must point at the room light
from step 3. Find it with
`ha_config_get_dashboard(url_path="house-lights", entity_id="<old entity>")`
and patch its `entity` with a JSON patch guarded by a `test` op. The "Lamps" view is a strategy and picks the lamp up by itself.
`/lighting-schedule` and the per-lamp settings cards select by area and label;
check with `ha_config_get_dashboard(mode="search", query="<sibling lamp key>")`
that no card lists a sibling lamp by hand. If one does, add the new lamp
beside it.

### 8. Clear agent holds

`state_attr('sensor.ls_overrides', 'overrides')` — if it has
`light:light.<lamp key>` (or a room group's lamps) from your own calls, fire
event `ls_override` with `{"op": "clear", "keys": ["light:light.<lamp key>"], "via": "agent"}`
(`ha_call_event`).

## Verify

1. Dry run the engine for the lamp, no lamp changes:
   `ha_call_service("script", "ls_apply", return_response=True, data={"dry_run": true, "debug": true, "reason": "manual", "lights": ["light.<lamp key>"]})`.
   The plan must contain the lamp with the room's current block target.
2. `ha_search("<lamp key>")` lists: the light, 3 input_texts, 3 template
   lights, 3 override switches, and the engine automation.
3. The room group's `group_entities` (or `entity_id`) includes the new bulb or
   lamp; `light.home`'s `entity_id` includes it.
4. Drift check: list `house_schedule` lamps missing from `light.home` or
   from the engine's power-restore trigger:
   `{{ label_entities('house_schedule') | select('match', 'light\.') | reject('in', state_attr('light.home', 'entity_id')) | list }}`.
   Report any other lamp missing; ask before fixing lamps you weren't asked
   about.
5. Report to the user: entity id, room group, anything skipped (offline bulbs).
