# Home Assistant

Home Assistant (HA) runs on home-server through the NixOS module in
[`nixos/modules/home-assistant.nix`](../../nixos/modules/home-assistant.nix).
Nix owns the service, its integrations, the Adaptive Lighting (AL) component
and the sleep-mode schedule. Accounts, the MQTT connection, AL's settings and
which lamps AL controls live in HA's own state under `/var/lib/hass` and are
changed in the web UI, without a pull request.

## Open it

From a machine on the tailnet: <http://home-server:8123>. Port 8123 is open on
`tailscale0` only.

## First-time setup

Do these steps once per install, in order.

1. **Onboarding.** The first visit asks for an owner account. Create it, then
   add one account per resident under Settings → People.
2. **MQTT.** Go to Settings → Devices & services → Add integration → MQTT.
   Broker `127.0.0.1`, port `1883`, no username or password. Zigbee2MQTT
   devices then appear on their own through MQTT discovery.
3. **Adaptive Lighting.** Go to Settings → Devices & services → Add
   integration → Adaptive Lighting. Name it exactly `House`, because the
   sleep-mode schedule below targets
   `switch.adaptive_lighting_sleep_mode_house`. Then open the integration's
   options and set:

   | Option | Value |
   |---|---|
   | `min_color_temp` / `max_color_temp` | 2200 / 3500 |
   | `min_brightness` / `max_brightness` | 50 / 100 |
   | `sunrise_time` / `sunset_time` | 07:40:00 / 20:00:00 |
   | `sleep_rgb_or_color_temp` | `rgb_color` |
   | `sleep_rgb_color` | 255, 56, 0 |
   | `sleep_brightness` | 1 |
   | `brightness_mode` | `tanh` |
   | `take_over_control` | on |

   50 % is about 400 lm on an 800 lm bulb, the evening level. Daytime peaks
   at 3500 K.

## Add a lamp to the circadian curve

Pair and name the lamp with `house add` as usual. Then, in the AL `House`
options, add the lamp's `light.*` entity under `lights`.

Do not add lamps until house-automationd has been switched off. Until then
the daemon also drives every enabled lamp, and two controllers would fight
over it.

## Sleep mode

Nix switches AL's sleep mode on at 23:00 (dim red) and off at 06:40. Change
the times in `nixos/modules/home-assistant.nix` through a pull request.

## Backups

HA's Backup integration (Settings → System → Backups) covers `/var/lib/hass`.
Zigbee2MQTT's pairing data (`/var/lib/zigbee2mqtt`) and Mosquitto's
persistence (`/var/lib/mosquitto`) are not included yet.
