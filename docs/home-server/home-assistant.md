# Home Assistant

Home Assistant (HA) runs on home-server through the NixOS module in
[`nixos/modules/home-assistant.nix`](../../nixos/modules/home-assistant.nix).
Nix owns the service, its integrations, the Adaptive Lighting (AL) component
and HTTPS access. Everything residents may want to change lives in HA's own
state under `/var/lib/hass` and is changed in the web UI, without a pull
request: accounts, home name, location and time zone, the MQTT connection,
AL's settings, which lamps AL controls, and every automation, including the
sleep-mode schedule. AL is the only controller changing lamp brightness and
color temperature on a schedule.

## Open it

From a machine on the tailnet: <https://home-server.tailbebb40.ts.net>.
Tailscale Serve terminates TLS with a certificate Tailscale issues for that
name, so browsers accept a password and `Secure` cookies. Home Assistant
listens on loopback only, and port 443 is open on `tailscale0` only: there is
no plain-HTTP path and nothing is exposed to the public Internet. Do not enable
Funnel.

One-time, in the Tailscale admin console: DNS, then enable **HTTPS
Certificates**. Until then `tailscale-serve-home-assistant.service` fails and
retries every 30 s. Check it with
`systemctl status tailscale-serve-home-assistant`.

## Give a housemate access, isolated from your other machines

Use node sharing, not an invite into your tailnet. The housemate keeps their own
tailnet and sees only `home-server`. They cannot see your laptops or any deploy
target, even if a policy is misconfigured.

1. Admin console, Machines, `home-server`, Share. Send the link to the
   housemate's own Tailscale account.
2. In the tailnet policy, limit what shared users may reach to HTTPS only:

   ```json
   "grants": [
     {
       "src": ["autogroup:shared"],
       "dst": ["100.87.199.107"],
       "ip":  ["tcp:443"]
     }
   ]
   ```

   Port 22 stays unreachable to them, so SSH access described in
   [`access.md`](access.md) remains operator-only.
3. The housemate accepts the share and opens the same URL. Create their HA
   account under Settings, People first: sharing grants reachability, not a
   login.

Revoke by removing the share. Their reachability ends at once.

## Phones

1. Install the Tailscale app and sign in. Housemates accept the node share in
   their own Tailscale account instead. Keep Tailscale connected; always-on VPN
   is optional.
2. Install the Home Assistant Companion app (iOS or Android). Enter the server
   URL `https://home-server.tailbebb40.ts.net` and log in with your HA account.
3. The mobile browser works at the same URL.

The app reaches HA only while Tailscale is connected. The `mobile_app`
integration is already enabled in Nix.

## First-time setup

Do these steps once per install, in order.

1. **Onboarding.** The first visit asks for an owner account. Create it, then
   add one account per resident under Settings → People.
2. **MQTT.** Go to Settings → Devices & services → Add integration → MQTT.
   Broker `127.0.0.1`, port `1883`, no username or password. Zigbee2MQTT
   devices then appear on their own through MQTT discovery.
3. **Adaptive Lighting.** Go to Settings → Devices & services → Add
   integration → Adaptive Lighting. Name it `House`; the automations below
   then target `switch.adaptive_lighting_house` and
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
4. **Verify the schedule.** On Settings → Devices & services, open Adaptive
   Lighting and select **Configure** on `House`. The options above and the
   `lights` selector are the production schedule: changes saved here take
   effect without a repository change or deployment.
5. **Automations.** Create the UI automations listed under
   [Automations to create once](#automations-to-create-once).

## Automations to create once

These live in HA's UI, not in the repository. Their YAML is in the linked
sections.

- [Sleep mode](#sleep-mode) (required): dims `House` lamps red overnight.
- [Hand control back on a schedule](#hand-control-back-on-a-schedule)
  (optional): returns hand-adjusted lamps to the curve at set times.

## How the former home-day curve maps to House

The UI-owned `House` entry replaces the former daemon's `home-day` curve. It is
an approximation rather than a byte-for-byte translation:

| Former daemon `home-day` curve | Adaptive Lighting `House` | Difference |
|---|---|---|
| 2200 K night / 3500 K day | `min_color_temp` 2200 / `max_color_temp` 3500 | Same temperature range |
| 10 % night / 100 % day | 50 % normal minimum / 100 % maximum; sleep mode is 1 % dim red | The normal evening floor is brighter, while scheduled sleep mode is dimmer and redder |
| Wake 07:00 / bed 23:00 | Fixed sunrise 07:40 / sunset 20:00; sleep mode starts 23:00 and ends 06:40 | AL splits the normal transition from the sleep window |
| Solar-derived anchors with `winter_hold` from 11-01 through 01-31 | Fixed UI times with `brightness_mode` `tanh` | AL has no `winter_hold`; the fixed times intentionally stay the same all year |
| Former daemon owned every discovered compatible lamp | Only entities selected under `lights` | Membership is explicit and editable in the UI |

To change the approximation later, return to Settings → Devices & services →
Adaptive Lighting → `House` → **Configure**.

## Pair a device from the UI

Zigbee2MQTT owns the radio, so Home Assistant's own Add device flow (ZHA)
does not apply. Pair through Zigbee2MQTT's bridge entity instead:

1. Settings → Devices & services → MQTT → device **Zigbee2MQTT Bridge** →
   switch **Permit join** on. It closes by itself after 254 seconds.
2. Factory-reset the device close to the server while the window is open.
3. Once the interview completes, the device appears under the MQTT
   integration. Rename it there, then switch **Permit join** off.

`nix run .#pair-zigbee` from the repository does the same from a terminal.

## Add a lamp to the circadian curve

1. Complete the pairing steps above and open the new device under Settings →
   Devices & services → MQTT.
2. Note the lamp's `light.*` entity. Sensors, update entities and the device
   name itself are not valid AL light targets.
3. Go to Settings → Devices & services → Adaptive Lighting → `House` →
   **Configure**, add that entity under `lights`, and save.
4. Return to the same **Configure** screen whenever the lamp membership or
   schedule should change.

AL is the only lighting controller, so a lamp listed under `lights` is not
contested by any other automation.

## Sleep mode

Sleep mode turns `House` lamps dim red. A UI automation switches it on at
23:00 and off at 06:40. Create it once under Settings → Automations & scenes →
Create automation → ⋮ → Edit in YAML, paste, and save:

```yaml
alias: House sleep mode
triggers:
  - trigger: time
    at: "23:00:00"
    id: "on"
  - trigger: time
    at: "06:40:00"
    id: "off"
actions:
  - action: switch.turn_{{ trigger.id }}
    target:
      entity_id: switch.adaptive_lighting_sleep_mode_house
```

Change the times in the automation editor whenever the household wants to.
Another AL entry has its own sleep-mode switch; add it to `entity_id` to share
this schedule, or give it its own automation.

## Hand control back on a schedule

With `take_over_control` on, a lamp changed by hand or remote stops following
the curve until it is turned off and on again. To hand every `House` lamp back
at set times as well, add this automation the same way:

```yaml
alias: House hand back to schedule
triggers:
  - trigger: time
    at: "06:40:00"
  - trigger: time
    at: "17:00:00"
actions:
  - action: adaptive_lighting.set_manual_control
    data:
      entity_id: switch.adaptive_lighting_house
      manual_control: false
```

Listing `lights:` under `data` limits it to those lamps.

## Backups

HA's Backup integration (Settings → System → Backups) covers `/var/lib/hass`.
Zigbee2MQTT's pairing data (`/var/lib/zigbee2mqtt`) and Mosquitto's
persistence (`/var/lib/mosquitto`) are not included yet.
