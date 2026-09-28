# Enable House Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run house-automationd on the physical home-server with a base production topology and no devices, and guard Zigbee2MQTT's persistent device-name files.

**Architecture:** A committed `nixos/hosts/home-server/house.toml` holds location, MQTT, one solar-hybrid curve and the upper-floor/upper-hallway room. The host imports it into `homeServer.houseSettings`, which already enables the daemon and its deploy health gate. A Rust test proves the shipped file validates; a module assertion keeps `devices.yaml` / `groups.yaml` as Zigbee2MQTT's device files so runtime renames survive restarts.

**Tech Stack:** NixOS modules, TOML, Rust (`house-automationd` config tests), nix flake checks.

Spec: `docs/superpowers/specs/2026-09-28-runtime-devices-design.md` (rollout step 1).

---

## File Structure

- Create `nixos/hosts/home-server/house.toml` — production base topology, no devices.
- Modify `nixos/hosts/home-server/default.nix` — import `house.toml` into `homeServer.houseSettings`.
- Modify `nix/source.nix` — add the production `house.toml` to the application source so the Rust test can `include_str!` it.
- Modify `house-automationd/tests/config.rs` — invariant: production topology validates.
- Modify `nixos/modules/home-server-services.nix` — assertion on Zigbee2MQTT device/group files.

### Task 1: Production topology validates

**Files:**
- Create: `nixos/hosts/home-server/house.toml`
- Modify: `nix/source.nix:5-12`
- Test: `house-automationd/tests/config.rs` (after line 16)

- [ ] **Step 1: Write the failing test**

Add below `const EXAMPLE` in `house-automationd/tests/config.rs`:

```rust
const PRODUCTION: &str = include_str!("../../nixos/hosts/home-server/house.toml");

#[test]
fn production_topology_validates() {
    ValidatedConfig::parse(PRODUCTION).expect("home-server house.toml must validate");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nix develop -c cargo test -p house-automationd --test config production_topology_validates`
Expected: compile error, `couldn't read .../nixos/hosts/home-server/house.toml`.

- [ ] **Step 3: Create the topology**

`nixos/hosts/home-server/house.toml`:

```toml
schema_version = 1
# Devices are discovered at runtime from Zigbee2MQTT (spec rollout step 2).
devices = []
controls = []

# Approximate coordinates are enough for solar timing.
[location]
latitude = 59.3
longitude = 18.1
time_zone = "Europe/Stockholm"

# Loopback listener is anonymous and ACL-limited; no credentials needed.
[mqtt]
host = "127.0.0.1"
port = 1883
client_id = "house-automationd"

[[floors]]
id = "upper-floor"

[[rooms]]
id = "upper-hallway"
floor = "upper-floor"

# Yellower light by preference: daytime tops out at 3500 K.
[[curves]]
id = "home-day"
kind = "solar_hybrid"
wake_time = "07:00"
bed_time = "23:00"
night_brightness = 0.10
day_brightness = 1.00
night_color_temperature_kelvin = 2200
day_color_temperature_kelvin = 3500
winter_hold = { start = "11-01", end = "01-31", reference = "11-01" }

[[scopes]]
id = "upper-hallway-lights"
kind = "room"
room = "upper-hallway"
curve = "home-day"
```

Add the file to the application source in `nix/source.nix`:

```nix
    (root + "/house-automationd")
    (root + "/nixos/hosts/home-server/house.toml")
  ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `nix develop -c cargo test -p house-automationd --test config production_topology_validates`
Expected: `test production_topology_validates ... ok`

- [ ] **Step 5: Commit**

```bash
git add nixos/hosts/home-server/house.toml nix/source.nix house-automationd/tests/config.rs
git commit -m "feat(home-server): add base house topology"
```

### Task 2: Enable the daemon on home-server

**Files:**
- Modify: `nixos/hosts/home-server/default.nix:13` (after `system.configurationRevision`)

Declarative wiring; the module already gates on `houseSettings != null`, adds
`house-automationd.service` to deploy health units and points the app deploy
health check at `http://127.0.0.1:9876/healthz`. No new test.

- [ ] **Step 1: Import the topology**

```nix
  homeServer.houseSettings = builtins.fromTOML (builtins.readFile ./house.toml);
```

- [ ] **Step 2: Evaluate and build the host**

Run: `nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel`
Expected: exit 0.

Run: `nix eval --raw .#nixosConfigurations.home-server.config.services.app-auto-deploy.serviceName`
Expected: `house-automationd.service`

- [ ] **Step 3: Run the host checks**

Run: `nix build --no-link .#checks.x86_64-linux.standalone-host .#checks.x86_64-linux.home-server-services`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add nixos/hosts/home-server/default.nix
git commit -m "feat(home-server): run house-automationd"
```

### Task 3: Guard persistent device names

**Files:**
- Modify: `nixos/modules/home-server-services.nix` — the `(mkIf zigbeeEnabled { … })` block (starts near line 272), so the assertion only applies when Zigbee is configured.

- [ ] **Step 1: Add the assertion to the `mkIf zigbeeEnabled` block**

```nix
      assertions = [
        {
          # NixOS rewrites configuration.yaml on every start; runtime renames
          # survive only because Zigbee2MQTT keeps them in these files.
          assertion =
            config.services.zigbee2mqtt.settings.devices == "devices.yaml"
            && config.services.zigbee2mqtt.settings.groups == "groups.yaml";
          message = "zigbee2mqtt devices/groups must stay in devices.yaml/groups.yaml so runtime renames persist";
        }
      ];
```

- [ ] **Step 2: Prove it bites**

Temporarily add `services.zigbee2mqtt.settings.devices = lib.mkForce { };` to
`nixos/hosts/home-server/default.nix`, then run:
`nix eval .#nixosConfigurations.home-server.config.system.build.toplevel.drvPath`
Expected: error containing `runtime renames persist`. Remove the override.

- [ ] **Step 3: Evaluate clean**

Run: `nix flake check --no-build`
Expected: `all checks passed!`

- [ ] **Step 4: Commit**

```bash
git add nixos/modules/home-server-services.nix
git commit -m "fix(home-server): keep zigbee2mqtt device names persistent"
```

### Task 4: Deploy verification (after merge)

- [ ] **Step 1:** After merge and auto-deploy, on home-server:
  `systemctl is-active house-automationd zigbee2mqtt` → both `active`;
  `curl -fsS http://127.0.0.1:9876/healthz` → success;
  `systemctl --failed --no-legend` → empty.
