# Zigbee pairing command

## Goal

One command, runnable from any tailnet machine with SSH access to the home
server, that opens Zigbee pairing for a bounded window, shows what joins in
plain language, and always closes pairing again. A repository skill lets a
Claude session drive the same command for someone who does not know MQTT.

## Decisions

- **Transport: ordinary OpenSSH over the tailnet.** The host runbook disabled
  Tailscale SSH on purpose (it intercepts OpenSSH and weakens the root-login
  invariant). The command forwards a private local Unix socket to the server's
  loopback-only Mosquitto (`127.0.0.1:1883`). Nothing new listens on the
  network and no MQTT credential is needed.
- **Host stays a parameter.** Default destination is `home-server` (MagicDNS),
  overridable with `--host` or `SMARTHOME_HOST`, so the repository still
  carries no host identity. SSH user, keys, and host-key trust come from the
  caller's normal SSH configuration.
- **Zigbee2MQTT 2.x bridge API only.** Readiness is the retained
  `zigbee2mqtt/bridge/state` `{"state":"online"}`. Pairing is
  `bridge/request/permit_join` `{"time":N,"transaction":T}`; the matching
  `bridge/response/permit_join` must report `"status":"ok"`. Joins and
  interviews arrive on `bridge/event`. Windows are 1–254 seconds
  (zigbee-herdsman rejects longer); default 180.
- **Always close.** Normal end, Ctrl-C, and termination publish
  `{"time":0}`. If the tunnel is already gone, the command says pairing
  closes by itself when the window expires.
- **Ctrl-C semantics.** The SSH tunnel is started as an asynchronous child of a
  non-interactive shell, so it inherits an ignored SIGINT and survives the
  terminal's Ctrl-C long enough for the close request.

## Behaviour

| Situation | Output | Exit |
|---|---|---|
| Invalid arguments | usage | 64 |
| SSH cannot connect | `could not connect to <host> over SSH` + SSH's reason | 69 |
| No retained bridge state within 5 s, or state not online | `Zigbee2MQTT is not running on <host>` | 69 |
| Request rejected or no response within 10 s | Zigbee2MQTT's error | 1 |
| Window ends | per-device lines, `Pairing closed.`, summary | 0 |
| Ctrl-C / SIGTERM | `Pairing closed.` | 130 / 143 |
| Tunnel or bridge lost mid-window | reason + automatic-close note | 1 |

Event lines: `New device joined: <name>`, `Paired: <vendor> <model> - <description> (<name>)`,
unsupported-device and failed-interview hints, `Device left: <name>`.

## Packaging

`nix/pair-zigbee.sh` is packaged with `writeShellApplication` (ShellCheck at
build) with `openssh`, `mosquitto`, `jq`, and `coreutils` as runtime inputs,
exposed as `packages.pair-zigbee` and `apps.pair-zigbee`. The service package
and its Cachix publication are unchanged.

## Skill

`.claude/skills/pair-zigbee-device/SKILL.md`: prerequisites, how to run the
command in the background and relay its lines, and factory-reset procedures
for bulbs without a button (power-cycle sequences by brand; Hue needs its app,
a dimmer, or touchlink).

## Testing

`checks.pair-zigbee` is a two-node NixOS VM test: a server with OpenSSH,
production-shaped anonymous loopback Mosquitto, and a fake Zigbee2MQTT bridge
(Python/paho) that records requests and emits a join plus successful
interview; a client runs the packaged command. Cases: happy path with exact
request sequence (`time:N` then `time:0`), SIGINT to the whole process group
mid-window closes pairing and leaves no processes, bridge offline and
never-started refuse without publishing a request, rejected request, tunnel
loss mid-window, unreachable host, and argument validation.
