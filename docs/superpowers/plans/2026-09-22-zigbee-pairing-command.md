# Zigbee Pairing Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `pair-zigbee`, a flake app that opens Zigbee2MQTT pairing on the home server over an SSH-forwarded Unix socket, plus a repository skill that drives it.

**Architecture:** One Bash script packaged with `writeShellApplication`. It forwards a private Unix socket to the server's loopback Mosquitto, checks the retained bridge state, sends a transaction-tagged `permit_join`, streams `bridge/event` through `jq` into plain sentences, and always sends `{"time":0}` on exit. A two-node NixOS VM test drives the packaged binary against a fake Zigbee2MQTT bridge.

**Tech Stack:** Bash, OpenSSH, Mosquitto clients, jq, NixOS test driver, Python paho-mqtt (fake bridge only). Design: `docs/superpowers/specs/2026-09-22-zigbee-pairing-command-design.md`.

---

### Task 1: Failing VM test against a stub command

**Files:**
- Create: `nix/tests/pair-zigbee.nix`
- Create: `nix/pair-zigbee.nix`, `nix/pair-zigbee.sh` (stub: prints usage, exits 0)
- Modify: `flake.nix` (`packages.pair-zigbee`, `apps.pair-zigbee`, `checks.pair-zigbee`)

- [ ] **Step 1:** Server node: OpenSSH with a snakeoil authorized key for `jonathan`; Mosquitto listener identical to production loopback (`127.0.0.1:1883`, anonymous, ACL `zigbee2mqtt/#`); `fake-zigbee2mqtt.service` (paho) that subscribes, then publishes retained `{"state":"online"}`, appends every `permit_join` payload to `/var/lib/fake-zigbee2mqtt/requests.jsonl`, answers with the request's `transaction` (`status:error` when `/run/fake-zigbee2mqtt/reject` exists), and for `time > 0` emits `device_joined`, `device_interview` started and successful (IKEA LED2201G8).
- [ ] **Step 2:** Client node: packaged command, snakeoil private key for root, `ssh_config` with `User jonathan` and `StrictHostKeyChecking accept-new` for `server`.
- [ ] **Step 3:** Test script cases: argument validation (64), unreachable host (69), happy path (`time:5` then `time:0`, `Paired: IKEA LED2201G8`, `Pairing closed.`, exit 0), SIGINT to the unit's whole cgroup mid-window (exit 130, last request `time:0`, no leftover `ssh`/`mosquitto_sub`), rejected request (exit 1, only one request), bridge offline and never-started (exit 69, no request), tunnel loss mid-window (exit 1, message).
- [ ] **Step 4:** Run `nix build -L .#checks.x86_64-linux.pair-zigbee`. Expected: FAIL at the first behavioural assertion.
- [ ] **Step 5:** Commit test + stub.

### Task 2: Implement the command

**Files:**
- Modify: `nix/pair-zigbee.sh`

- [ ] **Step 1:** Argument parsing and validation; `SMARTHOME_HOST` default `home-server`; reject hosts starting with `-`.
- [ ] **Step 2:** Tunnel: `ssh -N -o ExitOnForwardFailure=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -L "$socket:127.0.0.1:1883" -- "$host" &`; wait for the socket while the process lives, else exit 69 with SSH's last lines.
- [ ] **Step 3:** One `mosquitto_sub -F '%t %p'` on `bridge/state`, `bridge/event`, `bridge/response/permit_join` into a FIFO; the retained state proves the subscription is live before anything is published.
- [ ] **Step 4:** Transaction-tagged request, response wait (10 s), event loop until the window ends, summary; `cleanup` trap closes pairing, stops children, removes the temporary directory, preserves the exit status.
- [ ] **Step 5:** Run the VM check. Expected: PASS. Commit.

### Task 3: Skill, docs, full gate

**Files:**
- Create: `.claude/skills/pair-zigbee-device/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1:** Skill: triggers, prerequisites, background run + relay, brand reset table, what to report afterwards.
- [ ] **Step 2:** README "Pairing a Zigbee device" section.
- [ ] **Step 3:** `nix flake check -L`; interactive smoke of the built command against the real server (tunnel + bridge-state refusal until the coordinator PR deploys); commit, push, PR, CI.
