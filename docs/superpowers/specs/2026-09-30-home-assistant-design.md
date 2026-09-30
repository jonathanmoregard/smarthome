# Home Assistant on home-server

Date: 2026-09-30

## Why

The custom Rust daemon covers circadian lighting only. The household also
wants modes, a dashboard, phone-alarm wake-up, notification flashes and
music. Rebuilding those around the daemon costs far more than adopting Home
Assistant (HA). The user chose full HA with Adaptive Lighting (AL) and
authorized removing the Rust parts; this supersedes the 2026-09-13 directive
"Omit Home Assistant".

## Decision

Run HA through the NixOS `services.home-assistant` module on home-server.
Zigbee2MQTT publishes MQTT discovery so every paired device appears in HA. AL
drives the circadian curve. house-automationd stops controlling lights.

Rejected:

- Hybrid (Rust daemon writes lights, HA does UX): two writers to the same
  lamps and a doubled command surface.
- Stay custom: every wanted feature becomes bespoke code.
- HA OS or a container: loses the declarative, CI-built, cache-deployed host
  that the repo already owns.

## Delivery in two pull requests

The deploy script that activates a new generation belongs to the generation
already running, and it checks the candidate against its own health list. The
running generation requires `house-automationd.service` and
`app-deploy.timer`, so a change that removes either one fails its own health
check and rolls back. Each deploy may only drop what the previous generation
no longer requires:

1. **Add HA, loosen the health gate** (this spec's scope). The system-deploy
   gate stops requiring `house-automationd.service` and `app-deploy.timer`.
   The daemon and the app track keep running, unchanged.
2. **Switch the daemon off and delete the Rust workspace and the app track**,
   after PR 1 is deployed: crates, `nix/package.nix`, `nix/module.nix`,
   `house.toml`, the app-deploy module and tests, the publish workflow's app
   job, CI's app job and path classifier branch, and `house control`. It gets
   its own spec.

Between the two deploys the daemon still controls every enabled light it
discovers. The only lamp is released (disabled in Zigbee2MQTT), so neither the
daemon nor HA touches it. No lamp is enrolled in AL before PR 2 deploys.

## Components (PR 1)

### Home Assistant service

- `services.home-assistant.enable = true`, from `nixpkgs-system` like the rest
  of the host. CI builds the closure; the server only substitutes it.
- `extraComponents`: `default_config`, `met`, `mqtt`, `mobile_app`, `backup`.
- `customComponents`: `adaptive_lighting` (nixpkgs
  `home-assistant-custom-components.adaptive_lighting`, 1.31.0 at the pinned
  revision).
- `config.homeassistant`: name "Home", latitude 59.3, longitude 18.1, time
  zone Europe/Stockholm, metric. The same approximate coordinates house.toml
  already commits.
- UI-editable files: `automation ui`, `scene ui` and `script ui` include
  `automations.yaml`, `scenes.yaml` and `scripts.yaml` in `/var/lib/hass`,
  created empty by systemd-tmpfiles when absent (`f`, never truncated).
- Port 8123 opens on `tailscale0` only, like SSH and the Zigbee2MQTT frontend.
- `home-assistant.service` joins the health gate (below), so any later
  generation where HA fails to start rolls back.

### Zigbee2MQTT and Mosquitto

- `homeassistant.enabled = true`. Devices disabled in Zigbee2MQTT are not
  discovered, so `house control NAME off` still hides a lamp from HA.
- The loopback listener ACL adds `topic readwrite homeassistant/#`, the
  discovery and HA birth topics. Z2M and HA both use the anonymous loopback
  listener, as the daemon did.
- `house rename` sends `homeassistant_rename: true`, so HA entity IDs follow
  a device's new name.

### Health gate

- On the host, `services.system-deploy.healthUnits` drops
  `house-automationd.service` and gains `home-assistant.service`.
- `system-auto-deploy.nix` drops `app-deploy.timer` from its fixed candidate
  list and its recovery groups, keeping `system-deploy.timer` (or the legacy
  `nixos-deploy.timer` during recovery).

### Adaptive Lighting (runtime, not Nix)

AL's light list is static per switch: `change_switch_settings` skips
`lights`, a YAML-configured switch is read-only in the options UI, and light
groups expand once at setup. To add a lamp without a pull request, AL is
created through the UI config flow, and a new lamp is ticked in its options.
This relaxes the 2026-09-28 rule "every lamp follows the curve as soon as
paired" for now; automatic enrolment is a follow-up.

One switch named `House`, so its entities are `switch.adaptive_lighting_house`
and `switch.adaptive_lighting_sleep_mode_house`. Settings, mapped from the
2026-09-29 daily schedule spec's evidence values:

| Setting | Value | Why |
|---|---|---|
| `min_color_temp` / `max_color_temp` | 2200 / 3500 K | cosy floor, yellower daytime ceiling |
| `min_brightness` / `max_brightness` | 50 / 100 % | ≈400 lm evening on an 800 lm lamp |
| `sunrise_time` / `sunset_time` | 07:40 / 20:00 | the schedule's day and cosy anchors |
| `sleep_rgb_or_color_temp` | `rgb_color` | red at night |
| `sleep_rgb_color` / `sleep_brightness` | [255, 56, 0] / 1 % | ≈ the spec's 5 lm red |
| `brightness_mode` | `tanh` | smooth evening ramp |
| `take_over_control` | on | manual changes pause AL per lamp |

### Sleep mode schedule (Nix)

A declarative automation (`automation nix`) turns
`switch.adaptive_lighting_sleep_mode_house` on at 23:00 and off at 06:40. It
does nothing until the AL switch exists, so it is safe before onboarding.

## Operator runbook

`docs/home-server/home-assistant.md` covers, once per install: HA onboarding
(owner account), adding the MQTT integration (broker `127.0.0.1`, port 1883,
no credentials), creating the AL `House` switch with the table above, adding
lamps to it (only after PR 2 deploys), and accounts for other residents. Backups use HA's built-in
Backup integration; off-box copies of `/var/lib/hass`, `/var/lib/zigbee2mqtt`
and `/var/lib/mosquitto` are a follow-up.

## Testing

- `home-assistant-config` check: runs `hass --script check_config` against
  the host's generated configuration directory, so a config HA rejects fails
  CI instead of the deploy.
- VM (`home-server-services` test): `home-assistant.service` becomes active
  and answers `GET /api/onboarding` on 8123; an anonymous loopback client
  round-trips a message on `homeassistant/status`, proving the ACL lets HA
  and Z2M talk discovery.
- No assertions restating declarations (package present, option values).

## Out of scope

PR 2, automatic AL enrolment, modes, dashboards, wake-up from the phone
alarm, notification flashes, Music Assistant and off-box backups.
