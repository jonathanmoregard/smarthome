---
name: pair-zigbee-device
description: Use when someone wants to pair, add, connect or join a Zigbee bulb, lamp, plug, remote or sensor to the home server; asks to "open pairing", "permit join" or "put the server in pairing mode"; has a bulb without a button that needs resetting before it will pair; or wants to find out which physical lamp a server device is ("which lamp is this", "make it flash", "identify"), name, move, list or remove a paired device.
---

# Pair a Zigbee device

`pair-zigbee` opens Zigbee pairing on the home server for a limited time,
prints what joins in plain sentences, and closes pairing again. It uses
ordinary SSH over Tailscale to reach the server's private MQTT broker; nothing
new is exposed on the network.

## Before running

1. Ask what the device is (brand and model, or a photo of the label) if you
   do not know. The reset procedure depends on it.
2. The machine needs Tailscale connected, Nix with flakes, and an SSH key the
   server accepts (declared in the private `nixos-config`).
3. The first SSH connection from a machine asks whether to trust the server's
   host key, and the Bash tool has no terminal for that question. If the
   command fails with `Host key verification failed`, compare the server key
   with the one pinned in this repository,
   `nixos/hosts/home-server/known_hosts`. When they match, append that pinned
   line to `~/.ssh/known_hosts`; otherwise stop and tell the person. Never
   accept a key that does not match the pinned one.

## Run

From the repository root:

```console
nix run .#pair-zigbee -- --time 180
```

`--host user@name` or `SMARTHOME_HOST` selects another SSH destination.
`--time` is 1–254 seconds (Zigbee's limit).

The person has to act while it runs, so run it with `run_in_background` and
read the output file every 15 seconds or so, passing each new line on in plain
words. As soon as `Pairing is open` appears, tell them to power on (or reset)
the device, close to the server.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Window ended; summary lists what paired | Report it (below) |
| 64 | Bad arguments | Fix the command |
| 69 | SSH failed, or Zigbee2MQTT is not running | Check Tailscale/SSH; if Zigbee2MQTT is down, the host config needs attention; do not keep retrying |
| 1 | Pairing refused, or connection lost mid-way | Read the message; pairing closes by itself when the window ends |
| 130 / 143 | Interrupted | Pairing was closed |

## Getting the device into pairing mode

A brand-new device pairs by itself the first time it gets power during the
window. A device that was ever paired elsewhere must be factory reset first.
Bulbs without a button are reset with the wall switch or plug. Always finish
in the ON state; the bulb blinks or dims when it has reset.

Counting fast toggles in your head is hard. Tell the person to count out loud
("one": off, on; "two": off, on; …) and to watch for the short blink or dim at
the end: that blink, not the count, confirms the reset.

The authoritative procedure for a model is the "Pairing" section of its
Zigbee2MQTT page, `https://www.zigbee2mqtt.io/devices/<model>.html`; look it
up when the model is known. Common cases:

| Brand | Reset |
|---|---|
| IKEA TRÅDFRI | Toggle off/on 6 times: very short ONs, slightly longer OFFs. Some newer bulbs need more toggles; see the model page. |
| Philips Hue | Recent firmware: starting ON, 5 × (off 2 s, on 8 s). Otherwise the Hue Bluetooth app's reset, or a Hue dimmer held against the bulb (On + Off for about 10 s). |
| Other brands (Innr, Ledvance/Osram, Lidl, Tuya, Gledopto) | Usually a sequence of 3–6 off/on toggles; the exact timing matters, so use the model page. |

If nothing joins, check whether the device reached the server at all:
`ssh home-server 'journalctl -u zigbee2mqtt --since -5min --no-pager | grep -iE "join|interview"'`.
No lines means the reset did not happen or the device is out of range: move it
closer, reset again while the window is still open, and run the command again
if the window has closed.

## Afterwards

- Report vendor, model and the `0x…` address from the summary.
- `Could not identify …`: switch the device off and on once; Zigbee2MQTT
  retries identification.
- `does not support this model yet`: it joined but has no converter; report
  the model.
- A paired light follows the circadian curve right away, even while it still
  has its `0x…` name. No repository change or pull request is needed.
- Naming is optional and only matters for remotes and per-room adjustments.
  Ask the person where the lamp is, then name it `<floor>/<room>/<device>`
  (for example `upper-floor/upper-hallway/lamp`) with `house rename`.
- Remind them: a Zigbee bulb only works when its wall switch stays on.

## Managing paired devices

All of these run from the repository root, need no pull request, and persist
across reboots (Zigbee2MQTT keeps names in `devices.yaml`).

| Task | Command |
|---|---|
| List devices | `nix run .#house -- list` |
| Details and live state | `nix run .#house -- show <name>` |
| Make a lamp flash | `nix run .#house -- identify <name> [--seconds 1-30]` |
| Name or move a device | `nix run .#house -- rename <old> <new>` |
| Remove a device | `nix run .#house -- remove <name>` |
| Pair and name in one go | `nix run .#house -- add [<floor/room/device>]` |

### Which physical lamp is which

When several lamps are unnamed, match them one at a time: run
`house identify <0x…>` (10 s by default), ask the person which lamp flashed and
where it is, then `house rename` it. Unnamed devices appear in `house list` in
pairing order, so the newest `0x…` entry is usually the lamp just paired.

Ask before `house remove`: the device leaves the Zigbee network and must be
reset and paired again to come back.
