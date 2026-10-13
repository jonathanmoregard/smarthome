# Home Assistant Adaptive Lighting cutover plan

## Changes

1. Set the production host's `homeServer.houseSettings` to `null`. This keeps
   the daemon package and app-profile publication available, but removes the
   `house-automationd.service` unit and makes app activation skip its restart,
   database, and health checks.
2. Keep `nixos/hosts/home-server/house.toml` as a dormant reference for the
   former `home-day` policy and for the existing daemon config-compatibility
   check. The production host will no longer import it.
3. Keep Adaptive Lighting's `House` entry UI-created. Its schedule options and
   lamp membership therefore remain visible and editable under Settings,
   Devices & services; declarative YAML would make those options code-owned.
   Keep the existing Nix sleep-mode automation targeting the UI-created
   `switch.adaptive_lighting_sleep_mode_house` entity.
4. Update the production-host evaluation assertions and operator docs. Explain
   how to create/configure `House`, add `light.*` entities, edit it later, and
   how its fixed AL transition approximates the former solar-hybrid curve.

## Unchanged

1. Keep the daemon implementation, NixOS module, app publication/activation,
   daemon-specific VM fixtures, and tests intact.
2. Keep Zigbee2MQTT, MQTT discovery, radio identity, secrets, and deployment
   trust unchanged.

## Risks and differences

1. The deploy stops the old controller but cannot create HA's UI-owned `House`
   entry or select lamps; an operator must complete those UI steps afterward.
2. AL's documented profile is an approximation: 2200--3500 K and a 50--100%
   normal curve, with the existing 23:00--06:40 sleep mode providing the
   overnight dim-red state. The daemon used a 10%/2200 K night target, a
   07:00 wake time, solar-derived daily anchors, and a November--January
   `winter_hold`. AL has no equivalent winter hold; fixed 07:40/20:00
   transition times trade seasonal movement for a stable UI-editable profile.
3. Adding lamps before the cutover generation is active would briefly give two
   controllers ownership, so the runbook will retain that ordering warning.

## Checks

1. Evaluate the production contract and flake with `nix flake check --no-build`.
2. Run focused evals confirming production has null house settings, no
   `house-automationd` systemd unit, app activation service/health set to `-`,
   and no daemon in system-deploy health units.
3. Review the final diff and commit the scoped changes.
