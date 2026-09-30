# Home Assistant on home-server Implementation Plan (PR 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Home Assistant with Adaptive Lighting on home-server, and loosen
the system-deploy health gate so that PR 2 can switch off house-automationd.

**Architecture:** A new host module `nixos/modules/home-assistant.nix` wraps
`services.home-assistant`. Zigbee2MQTT turns on MQTT discovery and Mosquitto's
loopback ACL admits `homeassistant/#`. The system-deploy gate stops requiring
`house-automationd.service` and `app-deploy.timer` and starts requiring
`home-assistant.service`. Spec:
`docs/superpowers/specs/2026-09-30-home-assistant-design.md`.

**Tech Stack:** NixOS 26.05 (`nixpkgs-system` pin), Home Assistant, the
adaptive_lighting 1.31.0 custom component, Zigbee2MQTT, Mosquitto, and NixOS
VM tests.

---

## File map

- Create `nixos/modules/home-assistant.nix`: the HA service, firewall,
  tmpfiles and the sleep-mode automation.
- Modify `nixos/hosts/home-server/default.nix`: import the module and change
  the health units.
- Modify `nixos/modules/home-server-services.nix`: Z2M discovery and the
  Mosquitto ACL.
- Modify `nixos/modules/system-auto-deploy.nix`: the fixed candidate list and
  the recovery groups.
- Modify tests: `nixos/tests/system-deploy.nix`,
  `nixos/tests/home-server-cd.nix`, `nixos/tests/home-server.nix`,
  `nixos/tests/home-server-services.nix`.
- Modify `nix/house.sh` and `nix/tests/fake-zigbee2mqtt.py`: set
  `homeassistant_rename` to true.
- Create `docs/home-server/home-assistant.md`, and link it from `README.md`.

### Task 1: Loosen the system-deploy health gate

**Files:** `nixos/modules/system-auto-deploy.nix:17-24`,
`nixos/tests/system-deploy.nix:153-159`,
`nixos/tests/home-server-cd.nix:383`

- [ ] **Step 1: Update the test expectations first.**

  In `nixos/tests/system-deploy.nix`, replace the `--unit` loop and the
  app-deploy group line:

  ```bash
  for unit in sshd.service tailscaled.service mosquitto.service system-deploy.timer; do
    grep -qF -- "--unit $unit" "$deploy"
  done
  ! grep -qF -- 'app-deploy.timer' "$deploy"
  ```

  Keep the line
  `grep -qF -- '--recovery-any-unit-group system-deploy.timer,nixos-deploy.timer' "$deploy"`
  and delete the line containing `app-deploy.timer,smarthome-deploy.timer`.

  In `nixos/tests/home-server-cd.nix`, replace the "strict candidate health"
  grep with:

  ```python
  home_server.succeed(
      f"grep -F -- '--unit system-deploy.timer' {quote(system_deploy_executable)} "
      f"&& ! grep -F -- 'app-deploy.timer' {quote(system_deploy_executable)}"
  )
  ```

- [ ] **Step 2: Run the check and confirm it fails.**

  Run `nix build --no-link -L .#checks.x86_64-linux.system-deploy`.
  Expected: FAIL, because the deploy script still contains `app-deploy.timer`.

- [ ] **Step 3: Implement the change.**

  In `nixos/modules/system-auto-deploy.nix`:

  ```nix
  candidateHealthUnits = [
    "system-deploy.timer"
  ];
  baseHealthUnitGroups = [
    [ "system-deploy.timer" "nixos-deploy.timer" ]
  ];
  ```

- [ ] **Step 4: Run the check and confirm it passes.** Same command. Expected: PASS.

- [ ] **Step 5: Commit** with message
  `fix(deploy): stop requiring the app-deploy timer for system health`.

### Task 2: Zigbee2MQTT discovery and the Mosquitto ACL

**Files:** `nixos/modules/home-server-services.nix:235,290`,
`nixos/tests/home-server-services.nix`, `nixos/tests/home-server.nix:267,390`

- [ ] **Step 1: Remove the declaration-restating tests.** These are pure
  option echoes, and the spec forbids that kind of test.
  - In `nixos/tests/home-server-services.nix`, delete the assertion block
    whose message is `"Home Assistant integration must remain disabled"`, and
    the testScript line `assert "enabled: false" in rendered, rendered`.
  - In `nixos/tests/home-server.nix`, delete the contract field
    `zigbeeHomeAssistant` (line 267) and its assert (line 390).

- [ ] **Step 2: Add the runtime ACL test** to the
  `nixos/tests/home-server-services.nix` testScript, right after
  `home_server.wait_for_unit("mosquitto.service")`:

  ```python
  # HA and Zigbee2MQTT exchange discovery and birth messages on
  # homeassistant/# through the anonymous loopback listener.
  home_server.succeed(
      "timeout 10 mosquitto_sub -h 127.0.0.1 -t homeassistant/status -C 1 "
      "> /tmp/ha-status & sleep 1; "
      "mosquitto_pub -h 127.0.0.1 -t homeassistant/status -m online; wait; "
      "grep -Fx online /tmp/ha-status"
  )
  ```

  Add `pkgsSystem.mosquitto` to the node's `environment.systemPackages`.

- [ ] **Step 3: Run the check and confirm it fails.**

  Run `nix build --no-link -L .#checks.x86_64-linux.home-server-services`.
  Expected: FAIL, because the ACL denies the topic and `grep` finds nothing.

- [ ] **Step 4: Implement the change.** In
  `nixos/modules/home-server-services.nix`, change the ACL:

  ```nix
  acl = [
    "topic readwrite zigbee2mqtt/#"
    "topic readwrite house/v1/#"
    "topic readwrite homeassistant/#"
  ];
  ```

  Then set `homeassistant.enabled = true;` in `services.zigbee2mqtt.settings`.

- [ ] **Step 5: Run the check and confirm it passes.** Same command. Expected: PASS.

- [ ] **Step 6: Commit** with message
  `feat(zigbee): publish Home Assistant discovery`.

### Task 3: Home Assistant module and health unit

**Files:** create `nixos/modules/home-assistant.nix`; modify
`nixos/hosts/home-server/default.nix` and
`nixos/tests/home-server-services.nix`

- [ ] **Step 1: Write the failing VM assertions** in the
  `home-server-services` testScript, before the final `systemctl --failed`
  check:

  ```python
  home_server.wait_for_unit("home-assistant.service")
  home_server.wait_until_succeeds(
      "curl -fsS http://127.0.0.1:8123/api/onboarding", timeout=300
  )
  # HA itself must accept the generated configuration, custom component
  # included, or a deploy would ship a config it rejects.
  home_server.succeed(
      "cd /var/lib/hass && sudo -u hass "
      "$(systemctl show home-assistant.service -P ExecStart "
      "| grep -o '/nix/store/[^ ;]*/bin/hass' | head -1) "
      "--script check_config -c /var/lib/hass"
  )
  home_server.succeed(
      "test -L /var/lib/hass/custom_components/adaptive_lighting"
  )
  ```

  In the same test, raise `virtualisation.memorySize` from 2048 to 3072 and
  add `pkgsSystem.curl` to `environment.systemPackages`.

- [ ] **Step 2: Run the check and confirm it fails.** Run the
  `home-server-services` check. Expected: FAIL, because
  `home-assistant.service` does not exist.

- [ ] **Step 3: Create `nixos/modules/home-assistant.nix`:**

  ```nix
  { pkgs, ... }:

  let
    stateDir = "/var/lib/hass";
    sleepSwitch = "switch.adaptive_lighting_sleep_mode_house";
  in
  {
    services.home-assistant = {
      enable = true;
      configDir = stateDir;
      extraComponents = [
        "default_config"
        "met"
        "mqtt"
        "mobile_app"
        "backup"
      ];
      customComponents = [
        pkgs.home-assistant-custom-components.adaptive_lighting
      ];
      config = {
        default_config = { };
        homeassistant = {
          name = "Home";
          # Approximate coordinates are enough for sun-based automations.
          latitude = 59.3;
          longitude = 18.1;
          time_zone = "Europe/Stockholm";
          unit_system = "metric";
        };
        http.server_port = 8123;
        # UI-managed files next to the declarative configuration.
        "automation ui" = "!include automations.yaml";
        "scene ui" = "!include scenes.yaml";
        "script ui" = "!include scripts.yaml";
        # Adaptive Lighting's switch is created in the UI (docs/home-server/
        # home-assistant.md); these do nothing until it exists.
        "automation nix" = [
          {
            id = "house_sleep_mode_on";
            alias = "House sleep mode on";
            triggers = [ { trigger = "time"; at = "23:00:00"; } ];
            actions = [ { action = "switch.turn_on"; target.entity_id = sleepSwitch; } ];
          }
          {
            id = "house_sleep_mode_off";
            alias = "House sleep mode off";
            triggers = [ { trigger = "time"; at = "06:40:00"; } ];
            actions = [ { action = "switch.turn_off"; target.entity_id = sleepSwitch; } ];
          }
        ];
      };
    };

    # Create the UI-owned include files once; never truncate them.
    systemd.tmpfiles.rules = map
      (file: "f ${stateDir}/${file} 0644 hass hass - []")
      [ "automations.yaml" "scenes.yaml" "scripts.yaml" ];

    networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 8123 ];
  }
  ```

  Note: tmpfiles `f` writes its argument only when it creates the file. `[]`
  is a valid empty YAML list for automations. For `scenes.yaml` and
  `scripts.yaml`, HA accepts an empty list, and `{}` is also acceptable for
  scripts. Keep `[]` for all three unless `check_config` rejects it; if it
  does, use `{}` for `scripts.yaml`.

- [ ] **Step 4: Wire it into the host.** In
  `nixos/hosts/home-server/default.nix`, add
  `../../modules/home-assistant.nix` to `imports`, and replace the
  `healthUnits` expression with:

  ```nix
  healthUnits = lib.mkAfter (
    lib.optional (config.homeServer.zigbeeSerialPort != null) "zigbee2mqtt.service"
    ++ [ "home-assistant.service" ]
  );
  ```

- [ ] **Step 5: Run the check and confirm it passes.** Same command. Expected:
  PASS. Also run `nix flake check --no-build`.

- [ ] **Step 6: Commit** with message
  `feat(home-server): run Home Assistant with Adaptive Lighting`.

### Task 4: Renames follow into Home Assistant

**Files:** `nix/house.sh:452,509`, `nix/tests/fake-zigbee2mqtt.py:180`

- [ ] **Step 1: Make the fake bridge strict.** In
  `nix/tests/fake-zigbee2mqtt.py`, make the rename handler reject a request
  whose `homeassistant_rename` is not `true`, replying with an error the way
  it does for other invalid requests. Then echo `True` in the response data.
- [ ] **Step 2: Run the check and confirm it fails.** Run
  `nix build --no-link -L .#checks.x86_64-linux.house`. Expected: FAIL, the
  rename is rejected.
- [ ] **Step 3: Implement the change.** Change `homeassistant_rename: false`
  to `homeassistant_rename: true` in both jq expressions in `nix/house.sh`.
- [ ] **Step 4: Run the check and confirm it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** with message
  `feat(house): rename Home Assistant entities with devices`.

### Task 5: Operator runbook

**Files:** create `docs/home-server/home-assistant.md`; modify `README.md`

- [ ] **Step 1: Write the runbook.**
  - How to reach HA: `http://home-server:8123` over Tailscale.
  - Onboarding: the owner account, then one account per resident.
  - The MQTT integration: Settings → Devices & services → Add → MQTT, broker
    `127.0.0.1`, port 1883, no credentials.
  - The Adaptive Lighting `House` switch, with the spec's settings table.
  - Enrolling lamps in AL options, only after PR 2 deploys.
  - Sleep-mode times live in Nix.
  - Backups use the Backup integration.
- [ ] **Step 2: Link the runbook** from the docs list in `README.md`.
- [ ] **Step 3: Commit** with message `docs: Home Assistant runbook`.

### Task 6: Full gate

- [ ] Run
  `nix build --no-link -L .#checks.x86_64-linux.vm-home-server .#checks.x86_64-linux.vm-home-server-cd .#checks.x86_64-linux.standalone-host .#nixosConfigurations.home-server.config.system.build.toplevel`.
  Expected: PASS. Fix any VM memory pressure by raising `memorySize` in the
  failing test only.
- [ ] Push the branch and open a PR against `main`.
