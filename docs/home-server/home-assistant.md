# Home Assistant

Home Assistant (HA) runs on home-server through the NixOS module in
[`nixos/modules/home-assistant.nix`](../../nixos/modules/home-assistant.nix).
Nix owns only infrastructure: the service, its built-in integrations, HACS and
HTTPS access. Everything residents may want to change lives in HA's own state
under `/var/lib/hass` and is changed in the web UI, without a pull request:
accounts, home name, location and time zone, the MQTT connection, HACS
integrations, and the lighting schedule with its helpers, scripts,
automations and dashboards.

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
3. **HACS.** Go to Settings → Devices & services → Add integration → HACS and
   finish the GitHub device login. Through HACS, install **Variables+History**
   (`variable`) and restart HA; it provides the override store
   `sensor.ls_overrides`. A HACS integration's Python requirements must first
   be added to `extraPackages` in the Nix module, since NixOS cannot
   pip-install them.
4. **Lighting schedule.** The schedule's helpers, scripts, automations and
   dashboards are runtime state in `/var/lib/hass`, restored from HA's backup.
   See [Lighting schedule](#lighting-schedule).

## Lighting schedule

The day is split into three blocks: **Day**, **Cosy** and **Night**. Each block
has a start time (with separate weekend times), a fade length, and one fixed
light setting per scope: House, or a room when that room's own toggle is on.
A lamp shows its current block's setting. During the fade before a block
starts, it crossfades from the previous block's setting to the next one.

| Part | Role |
|---|---|
| `ls_*` helpers | Block start and weekend times, fade minutes, per-room own-timing and own-light toggles, block light values |
| `script.ls_apply` | The engine: picks each lamp's block from the clock and helpers and sends that block's setting |
| `automation.lighting_schedule_engine` | Runs the engine every minute, at lamp switch-on and on setting changes |
| `sensor.ls_overrides` | Override store: `block:<scope>` forces a block, `light:<entity>` holds a lamp changed by hand |
| `automation.lighting_schedule_override_store_writer` | Only writer of the store, fed by `ls_override` events |
| `script.ls_override_block` | The Day/Cosy/Night chips on the dashboards |
| `automation.lighting_schedule_lamp_change_detector` | Turns a resident's manual lamp change into a hold |
| `automation.lighting_schedule_end_overrides` | Ends overrides after the set duration or at the set time |

Dashboards: `/lighting-schedule` (every resident: block times and light per
room, when overrides end) and `/house-lights` (Day/Cosy/Night chips). Personal
wake-light settings live on an admin-only dashboard.

Test engine changes without touching lamps: call `script.ls_apply` with
`dry_run: true`, `test_now: <ISO time>` and `debug: true`.

## Pair a device from the UI

Zigbee2MQTT owns the radio, so Home Assistant's own Add device flow (ZHA)
does not apply. Pair through Zigbee2MQTT's bridge entity instead:

1. Settings → Devices & services → MQTT → device **Zigbee2MQTT Bridge** →
   switch **Permit join** on. It closes by itself after 254 seconds.
2. Factory-reset the device close to the server while the window is open.
3. Once the interview completes, the device appears under the MQTT
   integration. Rename it there, then switch **Permit join** off.

`nix run .#pair-zigbee` from the repository does the same from a terminal.

## Add a lamp to the schedule

1. Complete the pairing steps above and open the new device under Settings →
   Devices & services → MQTT.
2. Label the device `house_schedule` for a dimmable lamp, or `on_off` for a
   plug that can only switch.
3. Assign it to its room's area. A lamp outside the scheduled rooms follows
   the House blocks.

The lamp gets its block's setting at its next switch-on. No repository change
is needed.

## Backups

HA's Backup integration (Settings → System → Backups) covers `/var/lib/hass`.
Zigbee2MQTT's pairing data (`/var/lib/zigbee2mqtt`) and Mosquitto's
persistence (`/var/lib/mosquitto`) are not included yet.
