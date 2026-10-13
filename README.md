# Smarthome

This repository defines the home-server NixOS system: Home Assistant,
Zigbee2MQTT, Mosquitto, Tailscale, agenix secrets, and the system release
deployer. Home Assistant Adaptive Lighting owns the production lighting
schedule.

## Checks

The development shell provides `age`. Offline checks include the Zigbee pairing
contract, home-server service configuration, system deployer, system activator,
hydration, SSH access, and the standalone host evaluation.

```console
nix flake check -L
nix run .#pair-zigbee
```

Nix commands require a working Nix installation and daemon.

## Deployment

The `release/home-server` ref is promoted only after the signed home-server
closure is published and verified. The host's `system-deploy` timer fetches
that ref, hydrates the system closure from the configured caches, and performs
transactional activation with sustained health checks.

The deployer uses `/var/lib/smarthome-system-deploy` for its source checkout and
markers, and `/nix/var/nix/profiles/system` for the active system profile.
System rollback preserves the exact previous generation and refuses to clobber
an operator-selected rollback.

## Home Assistant and Zigbee

Home Assistant is configured in `nixos/modules/home-assistant.nix`. Pairing is
performed through Zigbee2MQTT with:

```console
nix run .#pair-zigbee
```

The Zigbee channel, PAN ID, extended PAN ID, and encrypted network key are
stable identity data. Do not regenerate them during routine recovery.

See [`docs/home-server/home-assistant.md`](docs/home-server/home-assistant.md),
[`docs/home-server/deployment.md`](docs/home-server/deployment.md), and
[`docs/home-server/recovery.md`](docs/home-server/recovery.md) for operator
procedures.
