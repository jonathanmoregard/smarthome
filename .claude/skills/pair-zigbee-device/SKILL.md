---
name: pair-zigbee-device
description: Use when someone wants to pair, add, connect or join a Zigbee bulb, lamp, plug, remote or sensor to the home server; asks to "open pairing", "permit join" or "put the server in pairing mode"; or has a bulb without a button that needs resetting before it will pair.
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
   command fails with `Host key verification failed`, ask the person to run
   `! ssh home-server true` once, check the fingerprint against the
   home-server host key recorded in `nixos-config`, and answer `yes`.

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

The authoritative procedure for a model is the "Pairing" section of its
Zigbee2MQTT page, `https://www.zigbee2mqtt.io/devices/<model>.html`; look it
up when the model is known. Common cases:

| Brand | Reset |
|---|---|
| IKEA TRÅDFRI | Toggle off/on 6 times: very short ONs, slightly longer OFFs. Some newer bulbs need more toggles; see the model page. |
| Philips Hue | Recent firmware: starting ON, 5 × (off 2 s, on 8 s). Otherwise the Hue Bluetooth app's reset, or a Hue dimmer held against the bulb (On + Off for about 10 s). |
| Other brands (Innr, Ledvance/Osram, Lidl, Tuya, Gledopto) | Usually a sequence of 3–6 off/on toggles; the exact timing matters, so use the model page. |

If nothing joins, move the device closer to the server, reset it again, and
run the command again.

## Afterwards

- Report vendor, model and the `0x…` address from the summary.
- `Could not identify …`: switch the device off and on once; Zigbee2MQTT
  retries identification.
- `does not support this model yet`: it joined but has no converter; report
  the model.
- The device keeps its `0x…` address as its name until renamed. Naming it and
  adding it to the house configuration are separate changes; ask before
  making them.
- Remind them: a Zigbee bulb only works when its wall switch stays on.
