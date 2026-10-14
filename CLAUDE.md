# Agent notes for smarthome

Home Assistant customisation (helpers, scripts, automations, dashboards, areas,
labels) is runtime state on the home server, not files in this repository. Change
it through the Home Assistant MCP tools; no pull request is needed. Nix here is
for infrastructure only.

## Lighting model

- Lighting is three fixed blocks per scope: Day, Cosy, Night. There is no curve.
- `script.ls_apply` is the engine. `automation.lighting_schedule_engine` runs it
  every minute and when a setting changes. Test changes with `ls_apply`
  `dry_run: true, debug: true, force_all: true, test_now: <ISO time>`; that
  changes no lamp. Do not move live lamps out of Night in the evening.
- A lamp is scheduled when it (or its device) has the label `house_schedule`
  (dimmable) or `on_off` (plug) and sits in an area.
- Room scopes are derived, never listed: every area holding a scheduled lamp is
  a room. Lamps without an area follow the House scope.
- An area with the label `private_room` is private: the Common Areas buttons
  and house-wide modes skip it. Every other room is a common area.

## Adding a room

1. Create the area (with its floor) and move the lamps into it. A lamp with
   several bulbs becomes one Zigbee2MQTT group (`zigbee2mqtt/bridge/request/group/add`
   and `group/members/add` over `mqtt.publish`); Zigbee2MQTT names reject `#` and `+`.
   Label the group light, hide the member bulbs.
2. Add `private_room` to the area if it is private.
3. The engine picks the room up at once and uses the House settings. For the
   room to get its own settings and dashboard rows, create its helper set, with
   `<area>` the area id and `<block>` each of `day`, `cosy`, `night`:
   - `input_boolean.ls_<area>_<block>_own_light`, `..._own_timing` (off)
   - `input_number.ls_<area>_<block>_fade` (0-120 min, step 1, box)
   - `input_datetime.ls_<area>_<block>_start`, `..._weekend` (time only)
   - `input_text.ls_<area>_<block>` (max 255), holding light JSON such as
     `{"on":true,"b":128,"m":"ct","k":2200}`
   - template light `light.ls_<area>_<block>`: copy an existing room's template
     helper options and swap the `input_text` it reads and stores to
   - `input_select.ls_<area>_override` with options Day, Cosy, Night (display
     mirror of the effective block). Give it the room's icon: templates cannot
     read area icons, so dashboards take the room icon from this helper.

   Copy the starting values from the House helpers. Never set `initial`; it
   resets the value on every restart.
4. Add the room's `ls_<area>_*` start, weekend, fade, input_text, own_timing and
   own_light entities to the `config` trigger of
   `automation.lighting_schedule_engine`, so edits apply instantly.
5. Dashboards are written per room, by copying an existing room:
   - `/house-lights`: a Light Blocks heading row (Day/Cosy/Night buttons calling
     `script.ls_override_block` with `scope: <area>`, highlighted through
     `input_select.ls_<area>_override`) and a tile in the Rooms column.
   - `/lighting-schedule`: the room card with Override Light / Override Time per
     block.
6. Verify with a dry run that the room's lamps report `<area>/<area>` in
   `dbg`, and that a `test_overrides` record `block:<area>` moves only that room.

Calling `light.*` services from the agent counts as setting a lamp by hand and
records a hold in `sensor.ls_overrides`; clear it afterwards. Light calls made
inside a running script (its context) are not holds, so running
`script.ls_apply` by hand is safe.
