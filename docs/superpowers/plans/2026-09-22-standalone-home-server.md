# Standalone Home Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (default) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `smarthome` own, publish, deploy, and test the complete physical `home-server` NixOS system with no post-cutover dependency on `nixos-config` or Dellan.

**Architecture:** Keep application and system releases as separate Nix profiles promoted through `release/app` and `release/home-server`. GitHub builds and verifies both closures; server fetches public Git refs, accepts only signed Cachix paths, and has all builders disabled. Bootstrap once from `nixos-config`, prove live reboot and rollback, then remove old ownership in a separate cleanup PR.

**Tech Stack:** Nix flakes, NixOS modules/tests, systemd, Bash, GitHub Actions, Cachix, agenix, OpenSSH, Tailscale, Mosquitto, Zigbee2MQTT

---

## File map

- `flake.nix`, `flake.lock`: retain app pin, add exact live system pin and agenix, export host/config/checks.
- `nixos/hosts/home-server/*`: physical hardware, identity, imports, and coordinator configuration.
- `nixos/profiles/home-server-base.nix`: minimal boot, network, SSH, Nix, GC, disk, locale, and admin policy.
- `nixos/modules/home-server-services.nix`: MQTT, Zigbee2MQTT, PostgreSQL, Synapse, TellStick, app and deployment composition.
- `nixos/modules/house-automation-service.nix`: profile-backed daemon and config rendering.
- `nixos/modules/app-auto-deploy.nix`: promoted application release polling.
- `nixos/modules/system-auto-deploy.nix`: promoted system release polling and activation.
- `nixos/modules/activate-app.sh`: atomic app switch, health rollback, start-limit recovery, pruning.
- `nixos/modules/activate-system.sh`: atomic system switch, rollback, health, manual-drift guard, pruning.
- `nixos/modules/hydrate-release-paths.sh`: signed-cache closure verification and copy with builders disabled.
- `nixos/secrets/zigbee2mqtt-network-key.age`: host-decryptable runtime ciphertext only.
- `nixos/tests/*`: focused contracts plus full-host and CD NixOS VM lanes.
- `nix/ci/classify-paths.sh`: fail-closed app/system change classifier.
- `nix/ci/push-closure.sh`: bounded explicit-path Cachix publication.
- `nix/ci/promote-release-ref.sh`: monotonic release-ref promotion.
- `.github/workflows/ci.yml`: selective PR gates with one stable summary.
- `.github/workflows/publish.yml`: independent app/system build, publish, verify, promote DAGs.
- `README.md`, `docs/home-server/*`: bootstrap, deploy, rollback, recovery, access, secrets, pairing, and disk operations.

## Phase A: repair current production path

### Task 1: Land and prove complete application publication

**Files:**
- Existing PR: `smarthome#7`
- Existing probe: `/home/jonathan/.local/state/claude-tasks/smarthome/direct-deploy-smoke`

- [ ] **Step 1: Require hosted PR checks to pass**

Run:

```bash
gh pr checks 7 --watch
```

Expected: every check passes; PR head is exact `804fb15bf0deefdb90b9e24f10878eb54778be47`.

- [ ] **Step 2: Hand off human merge**

Expected: user merges PR #7. Do not advance until `gh pr view 7 --json state,mergeCommit` reports `MERGED`.

- [ ] **Step 3: Prove main publication**

```bash
gh run list --workflow publish.yml --branch main --limit 3
run_id="$(gh run list --workflow publish.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$run_id"
```

Expected: `build and publish package` and `verify cache-only substitution` pass.

- [ ] **Step 4: Retry current server app deployment**

```bash
/home/jonathan/.local/state/claude-tasks/smarthome/direct-deploy-smoke
```

Expected: deploy success, healthy `/healthz`, builders disabled, at most two app generations, zero failed units.

## Phase B: standalone repository implementation

### Task 2: Add system flake boundary and red host test

**Files:**
- Modify: `flake.nix`, `flake.lock`
- Create: `nixos/tests/standalone-host.nix`

- [ ] **Step 1: Add test wiring before host implementation**

Add exact inputs:

```nix
inputs.nixpkgs-system.url =
  "github:NixOS/nixpkgs/b7c2ada94fe99c15b0dbcf4d11fd7850b957a436";
inputs.agenix.url = "github:ryantm/agenix";
inputs.agenix.inputs.nixpkgs.follows = "nixpkgs-system";
```

Extend outputs with `nixpkgs-system` and `agenix`, construct `pkgsSystem`, and wire:

```nix
nixosConfigurations.home-server = nixpkgs-system.lib.nixosSystem {
  system = "x86_64-linux";
  specialArgs = { inherit self; };
  modules = [ agenix.nixosModules.default ./nixos/hosts/home-server ];
};

checks.${system}.standalone-host = import ./nixos/tests/standalone-host.nix {
  inherit pkgsSystem;
  host = self.nixosConfigurations.home-server;
};
```

Create the evaluation contract:

```nix
assert host.config.networking.hostName == "home-server";
assert host.config.nix.settings.max-jobs == 0;
assert host.config.nix.settings.fallback == false;
assert host.config.nix.settings.builders == "";
assert host.config.nix.settings.keep-derivations == false;
assert host.config.nix.settings.keep-outputs == false;
assert host.config.services.openssh.enable;
assert host.config.services.tailscale.enable;
assert host.config.system.stateVersion == "26.05";
pkgsSystem.runCommand "standalone-host-contract" { } "touch $out"
```

- [ ] **Step 2: Stage and verify red**

```bash
git add flake.nix flake.lock nixos/tests/standalone-host.nix
nix build --no-link .#checks.x86_64-linux.standalone-host -L
```

Expected: fail because `nixos/hosts/home-server` does not exist.

- [ ] **Step 3: Commit red contract**

```bash
git commit -m "test(nixos): define standalone host contract"
```

### Task 3: Build minimal physical host configuration

**Files:**
- Create: `nixos/hosts/home-server/default.nix`
- Create: `nixos/hosts/home-server/deployment-identity.nix`
- Create: `nixos/hosts/home-server/hardware-configuration.nix`
- Create: `nixos/profiles/home-server-base.nix`

- [ ] **Step 1: Read exact production sources**

```bash
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:hosts/home-server/hardware-configuration.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:hosts/home-server/deployment-identity.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:profiles/home-server-base.nix
```

Apply exact hardware content. Preserve host public key and both admin public
keys. Remove GitHub deploy-key declarations. Define:

```nix
homeServer = {
  ageHostPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnGlRJufT9hIgzqFqHujW28DsSX1YDYg/0vGG7BsO1+ root@home-server";
  repository = "https://github.com/jonathanmoregard/smarthome.git";
};
```

- [ ] **Step 2: Narrow base profile to appliance needs**

Keep systemd-boot limit 8, wired networkd DHCP, resolved, timezone/locale,
OpenSSH only on `tailscale0`, password auth off, root login off, Tailscale,
smartd, bounded journald, Jonathan wheel membership, and current authorized
keys. Add:

```nix
nix.settings = {
  max-jobs = lib.mkForce 0;
  builders = lib.mkForce "";
  fallback = lib.mkForce false;
  min-free = lib.mkForce (1024 * 1024 * 1024);
  max-free = lib.mkForce (5 * 1024 * 1024 * 1024);
  keep-derivations = false;
  keep-outputs = false;
  substituters = lib.mkForce [ "https://jonathanmoregard.cachix.org" ];
  trusted-public-keys = lib.mkForce [
    "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8="
  ];
};
```

Enable daily GC and weekly optimise. Do not import workstation common modules,
Home Manager, overlays, build coordination, or workstation packages.

- [ ] **Step 3: Create host imports**

```nix
{
  imports = [
    ./hardware-configuration.nix
    ./deployment-identity.nix
    ../../profiles/home-server-base.nix
    ../../modules/home-server-services.nix
  ];

  system.configurationRevision = "standalone-home-server";
}
```

Use `lib.mkIf (self ? rev)` to assign `self.rev` when available; keep literal
fallback for dirty local evaluation.

- [ ] **Step 4: Verify green evaluation and toplevel**

```bash
git add nixos
nix build --no-link .#checks.x86_64-linux.standalone-host -L
nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel -L
git diff --check
```

Expected: pass with no `nixos-config` reference.

- [ ] **Step 5: Commit host boundary**

```bash
git commit -m "feat(nixos): own minimal home-server host"
```

### Task 4: Move services and Zigbee identity test-first

**Files:**
- Create: `nixos/modules/home-server-services.nix`
- Create: `nixos/modules/house-automation-service.nix`
- Create: `nixos/hosts/home-server/zigbee-coordinator.nix`
- Create: `nixos/secrets/zigbee2mqtt-network-key.age`
- Create: `nixos/tests/home-server-services.nix`

- [ ] **Step 1: Add failing service VM contract**

Import the standalone host with disk/SMART/Tailscale hardware edges disabled.
Use PR #245's QEMU USB serial and age identity fixtures. Assert:

```python
server.wait_for_unit("mosquitto.service")
server.wait_for_unit("zigbee2mqtt.service")
server.succeed("test -L /dev/serial/by-id/usb-Itead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_V2_94b12b3f9478f011aba8a3e70ba521c7-if00-port0")
server.succeed("systemctl show zigbee2mqtt.service -P LoadCredential | grep -F zigbee2mqtt-network-key")
server.succeed("grep -Fx 'channel: 25' /run/zigbee2mqtt/configuration.yaml")
server.succeed("systemctl is-active postgresql.service")
server.succeed("test -d /var/lib/house-automation")
server.succeed("test -z \"$(systemctl --failed --no-legend)\"")
```

- [ ] **Step 2: Verify red**

```bash
git add flake.nix nixos/tests/home-server-services.nix
nix build --no-link .#checks.x86_64-linux.home-server-services -L
```

Expected: fail because service/coordinator modules are absent.

- [ ] **Step 3: Import reviewed production modules and ciphertext**

```bash
git -C /home/jonathan/Repos/nixos-config-worktrees/main show 2f18ebc:hosts/home-server/zigbee-coordinator.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show 2f18ebc:modules/nixos/home-server-services.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show 2f18ebc:modules/nixos/house-automation-service.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main ls-tree -r --name-only 2f18ebc secrets/rekeyed/home-server
```

Apply content under `nixos/`, changing only imports and secret declaration:

```nix
age.secrets.zigbee2mqtt-network-key = {
  file = ../../secrets/zigbee2mqtt-network-key.age;
  owner = "root";
  group = "root";
  mode = "0400";
};
```

Keep channel 25, PAN ID 50324, extended PAN ID `[ 52 207 50 36 195 122 154
61 ]`, Ember adapter, and stable USB path exact. Never print plaintext key.

- [ ] **Step 4: Verify service VM and host build**

```bash
git add nixos
nix build --no-link .#checks.x86_64-linux.home-server-services -L
nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel -L
git diff --check
```

- [ ] **Step 5: Commit service ownership**

```bash
git commit -m "feat(nixos): move home services and Zigbee identity"
```

### Task 5: Move app deployment to public promoted refs

**Files:**
- Create: `nixos/modules/app-auto-deploy.nix`
- Create: `nixos/modules/activate-app.sh`
- Create: `nixos/modules/hydrate-release-paths.sh`
- Create: `nixos/tests/app-deploy.nix`
- Create: `nixos/tests/app-activator.nix`
- Create: `nixos/tests/hydrator.nix`

- [ ] **Step 1: Port focused tests before production scripts**

Read exact current tests:

```bash
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:tests/smarthome-auto-deploy.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:tests/smarthome-activator.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:tests/smarthome-hydrator.nix
```

Adapt contract to HTTPS with no identity file; `release/app`; candidate ancestor
of `origin/main`; shared lock `/run/smarthome-deploy/deploy.lock`; builders
disabled; exact Cachix key; start-limit reset; exact rollback generation; at
most two stable generations.

- [ ] **Step 2: Verify red focused checks**

```bash
git add flake.nix nixos/tests
nix build --no-link .#checks.x86_64-linux.app-deploy -L
nix build --no-link .#checks.x86_64-linux.app-activator -L
nix build --no-link .#checks.x86_64-linux.hydrator -L
```

Expected: fail because deploy module/scripts are absent.

- [ ] **Step 3: Port minimal production code**

```bash
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:modules/nixos/smarthome-auto-deploy.nix
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:modules/nixos/smarthome-activate-package.sh
git -C /home/jonathan/Repos/nixos-config-worktrees/main show origin/main:modules/nixos/smarthome-hydrate-release-paths.sh
```

Apply under new names, then make only tested HTTPS/ref/lock changes. Keep
unit-wide 10-minute timeout, sandboxing, poison handling, health rollback, and
two-generation cap.

- [ ] **Step 4: Verify adversarial paths**

Focused checks must cover missing/non-ancestor ref, empty/unsigned path, failed
or hanging copy, crashing candidate, rollback restart, and replay.

```bash
nix build --no-link .#checks.x86_64-linux.app-deploy -L
nix build --no-link .#checks.x86_64-linux.app-activator -L
nix build --no-link .#checks.x86_64-linux.hydrator -L
```

- [ ] **Step 5: Commit app deployment**

```bash
git commit -m "feat(deploy): own promoted app deployment"
```

### Task 6: Add system deployment transaction test-first

**Files:**
- Create: `nixos/modules/system-auto-deploy.nix`
- Create: `nixos/modules/activate-system.sh`
- Create: `nixos/tests/system-deploy.nix`
- Create: `nixos/tests/system-activator.nix`

- [ ] **Step 1: Write failing activator contract**

Build fake v1, v2, and unhealthy NixOS-style system paths with executable
`bin/switch-to-configuration` fixtures. Exercise healthy switch/replay;
unhealthy rollback; manual profile drift refusal; switch timeout and recovery;
rollback after start-limit exhaustion; prune only after health; atomic markers;
poison only deterministic unhealthy candidate, never transient Git/cache miss.

- [ ] **Step 2: Write failing module contract**

Assert `release/home-server`, HTTPS, shared lock, finite deadline, root user,
`restartIfChanged = false`, and builders-disabled evaluation/hydration.

- [ ] **Step 3: Verify red**

```bash
git add flake.nix nixos/tests
nix build --no-link .#checks.x86_64-linux.system-activator -L
nix build --no-link .#checks.x86_64-linux.system-deploy -L
```

- [ ] **Step 4: Implement exact transaction**

```text
lock -> fetch main/release ref -> verify ancestry/drift/poison -> evaluate exact
toplevel with builders disabled -> hydrate signed closure -> record old profile
-> set system profile -> candidate switch -> health -> atomic last-good -> prune
```

On post-switch failure: reset affected start limits, restore old profile, run
old activation, prove recovery, retain recovery roots, and do not prune.

- [ ] **Step 5: Verify and commit**

```bash
nix build --no-link .#checks.x86_64-linux.system-activator -L
nix build --no-link .#checks.x86_64-linux.system-deploy -L
git diff --check
git commit -m "feat(deploy): add signed system release deployment"
```

### Task 7: Prove complete host and both tracks in VMs

**Files:**
- Create: `nixos/tests/home-server.nix`
- Create: `nixos/tests/home-server-cd.nix`
- Create: `nixos/tests/fixtures/home-server-cd-module.nix`
- Create: `nixos/tests/fixtures/home-server-cd-release/*`
- Modify: `flake.nix`

- [ ] **Step 1: Port full host VM test and verify red**

Start from PR #245 `tests/home-server.nix`. Point it to standalone host, plain
agenix fixture, and local modules. Add behavior checks for global no-build,
both timers, shared lock, HTTPS, stable Zigbee path, app-profile command,
current admin keys, bounded journals, and zero failed units.

```bash
git add flake.nix nixos/tests
nix build --no-link .#checks.x86_64-linux.vm-home-server -L
```

Expected: first integration assertion fails; record it before changing code.

- [ ] **Step 2: Port and extend CD fixture**

Preserve real Git checkout, app profile switch, health, replay, rollback, and
rollback guard. Add disposable promoted system ref, signed-cache seam, real
system generation switch, units/markers/replay, bad generation rollback.

- [ ] **Step 3: Make integration green and commit**

```bash
nix build --no-link .#checks.x86_64-linux.vm-home-server -L
nix build --no-link .#checks.x86_64-linux.vm-home-server-cd -L
nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel -L
git commit -m "test(nixos): prove standalone host deployment"
```

### Task 8: Add classifier and two-track publisher

**Files:**
- Create: `nix/ci/classify-paths.sh`
- Create: `nix/ci/push-closure.sh`
- Create: `nix/ci/promote-release-ref.sh`
- Create: `nix/tests/release-scripts.nix`
- Replace: `.github/workflows/ci.yml`, `.github/workflows/publish.yml`
- Modify: `nix/tests/publish-workflow.nix`

- [ ] **Step 1: Write red script contracts**

Expected classifications:

```text
house-automation-core/src/lib.rs -> app=true, system=false
nixos/modules/system-auto-deploy.nix -> app=false, system=true
flake.lock -> app=true, system=true
docs/home-server/recovery.md -> app=false, system=false
unknown.bin -> app=true, system=true
```

With 300 fake paths, publisher passes every path as explicit argv batches of at
most 128. Promotion tests create ref, fast-forward, treat late ancestor as
no-op, and reject divergence/rewind.

- [ ] **Step 2: Verify red**

```bash
git add flake.nix nix/tests/release-scripts.nix
nix build --no-link .#checks.x86_64-linux.release-scripts -L
```

- [ ] **Step 3: Implement scripts minimally**

Classifier accepts NUL-delimited paths and maps unknown to both. Publisher uses
`mapfile` plus 128-element array slices. Promoter requires candidate equal
`GITHUB_SHA`, uses GitHub ref API with `force=false`, and makes an older
already-ancestor candidate a successful no-op.

- [ ] **Step 4: Define selective PR and publication workflows**

Pin third-party actions by full SHA. Default permissions `contents: read`.
Always classify/evaluate. Select app checks or system toplevel/VM checks. Add
stable `ci` summary using `always()` and fail on selected failure/cancellation.

Publication runs independent app and system DAGs. Each builds exact output,
publishes bounded explicit closure batches, verifies every Cachix narinfo and
cache-only substitution with builders disabled, then promotes. Only promotion
jobs receive `contents: write`.

- [ ] **Step 5: Harden workflow contract**

Require pins, triggers, permissions, outputs, bounded publisher, no PR secrets,
isolated Cachix, builders disabled, verify-before-promote, stable summary.
Adversarial mutations cover public-cache masking, `continue-on-error`, skipped
verification, raw-main deployment, extra writes, and PR secret use.

- [ ] **Step 6: Verify and commit**

```bash
nix build --no-link .#checks.x86_64-linux.release-scripts -L
nix build --no-link .#checks.x86_64-linux.publish-workflow -L
nix-instantiate --parse flake.nix >/dev/null
yq -e '.' .github/workflows/ci.yml >/dev/null
yq -e '.' .github/workflows/publish.yml >/dev/null
git diff --check
git commit -m "ci: publish promoted app and system releases"
```

### Task 9: Document operations and remove stale private-repo assumptions

**Files:**
- Modify: `README.md`
- Create: `docs/home-server/bootstrap.md`
- Create: `docs/home-server/deployment.md`
- Create: `docs/home-server/recovery.md`
- Create: `docs/home-server/secrets.md`
- Create: `docs/home-server/access.md`

- [ ] **Step 1: Document exact operator flows**

Cover public HTTPS fetch, release refs, GitHub/Cachix trust, status and trigger
commands, profiles, failed publication, poison clearing, app/system rollback,
reboot recovery, disk policy, Zigbee identity, secret re-encryption, and old
deploy-key revocation.

Access documentation states: Dellan remains through cutover; add Tuxedo or a
portable operator key before Dellan retirement; friend gets a separate
key/account and least-privilege commands; never share private keys.

- [ ] **Step 2: Validate docs and dependency absence**

```bash
git diff --check
! rg -n '/home/jonathan/Repos/nixos-config|git@github.com:jonathanmoregard/(smarthome|nixos-config)' nixos README.md docs/home-server
```

Expected: no runtime or docs path points at old checkout or SSH Git.

- [ ] **Step 3: Commit docs**

```bash
git commit -m "docs: operate standalone home server"
```

### Task 10: Run mandatory local and interactive gates

**Files:**
- No planned source changes; each discovered defect starts a new red-green cycle.

- [ ] **Step 1: Run cheap checks**

```bash
nix eval .#checks.x86_64-linux --apply builtins.attrNames
nix eval .#nixosConfigurations.home-server.config.system.build.toplevel.drvPath
git diff --check
```

- [ ] **Step 2: Run focused and integrated automated gates**

```bash
nix build --no-link .#checks.x86_64-linux.standalone-host -L
nix build --no-link .#checks.x86_64-linux.home-server-services -L
nix build --no-link .#checks.x86_64-linux.app-deploy -L
nix build --no-link .#checks.x86_64-linux.app-activator -L
nix build --no-link .#checks.x86_64-linux.hydrator -L
nix build --no-link .#checks.x86_64-linux.system-deploy -L
nix build --no-link .#checks.x86_64-linux.system-activator -L
nix build --no-link .#checks.x86_64-linux.release-scripts -L
nix build --no-link .#checks.x86_64-linux.publish-workflow -L
nix build --no-link .#checks.x86_64-linux.vm-home-server -L
nix build --no-link .#checks.x86_64-linux.vm-home-server-cd -L
nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel -L
```

Expected: all pass at one exact commit.

- [ ] **Step 3: Run mandatory interactive smoke**

Launch standalone feature VM. Through SSH, trigger real app/system deploy jobs,
healthy activation, broken-candidate rollback, start-limit recovery, replay,
shared-lock exclusion, profile pruning, required services, and failed-unit
inspection.

Expected: old app/system restored after bad candidates, exactly two stable
generations per profile, builders disabled, exact release markers, zero failed
units.

- [ ] **Step 4: Run final deterministic and independent review gates**

```bash
~/.claude/skills/advice-refine-test-loop/scripts/deterministic-gate.sh --json
```

Dispatch one fresh read-only reviewer with goal, diff, and evidence. Reproduce
every finding before edits. Re-run affected checks and integration gates after
each fix.

- [ ] **Step 5: Push and open standalone PR**

```bash
git push -u origin feat/standalone-home-server
gh pr create --head feat/standalone-home-server --title "feat: make home-server standalone" --body-file /tmp/smarthome-standalone-home-server-pr.md
pr_number="$(gh pr view feat/standalone-home-server --json number --jq .number)"
gh pr checks "$pr_number" --watch
```

Expected: stable summary and selected app/system jobs pass. Human merges.

## Phase C: protect, bootstrap, and prove physical cutover

### Task 11: Protect main and prove promoted releases

**External state:**
- GitHub branch protection for `jonathanmoregard/smarthome:main`
- Release refs `release/app`, `release/home-server`

- [ ] **Step 1: Enable strict main protection**

Require pull requests, strict required `ci` status, resolved conversations, no
force pushes, and no deletion. Verify through read-only GitHub API output before
enabling system deployment.

- [ ] **Step 2: Observe exact main publication**

Expected: selected build/publish/verify lanes pass; release refs point at merged
standalone commit; every recursive system path has valid Cachix narinfo.

### Task 12: Bootstrap through minimal nixos-config PR

**Worktree:**
- Create: `/home/jonathan/Repos/nixos-config-worktrees/home-server-standalone-cutover`

**Files:**
- Modify: `flake.nix`, `flake.lock`
- Modify: `hosts/home-server/default.nix`
- Modify: home-server VM assertions only for cutover

- [ ] **Step 1: Create fresh NixOS worktree**

```bash
git -C /home/jonathan/Repos/nixos-config-worktrees/main fetch origin main
git -C /home/jonathan/Repos/nixos-config-worktrees/main worktree add /home/jonathan/Repos/nixos-config-worktrees/home-server-standalone-cutover -b feat/home-server-standalone-cutover origin/main
```

- [ ] **Step 2: Add red cutover assertion**

Assert old `nixos-deploy.timer` disabled, standalone system timer enabled, no
deploy SSH identity required, Dellan admin key retained. Run `vm-home-server`;
expect failure before implementation.

- [ ] **Step 3: Pin merged smarthome and import bootstrap module**

Update existing smarthome input to exact merge commit. Import only its exported
system deploy-client module. Disable legacy NixOS deployment in same generation
that enables standalone timer. Do not alter unrelated Dellan modules.

- [ ] **Step 4: Run required NixOS gates**

```bash
git add -A
nix build --no-link .#checks.x86_64-linux.vm-home-server -L
nix build --no-link .#checks.x86_64-linux.vm-home-server-cd -L
nix build --no-link .#nixosConfigurations.home-server.config.system.build.toplevel -L
```

Run mandatory interactive VM smoke for branching/timers/scripts. Run
deterministic gate and fresh review. Commit with full NixOS `Pre-push
checklist:` trailer, push, open PR, wait for hosted checks. Human merges.

### Task 13: Verify physical standalone operation

**Server:** `jonathan@100.87.199.107` through pinned host key

- [ ] **Step 1: Observe bootstrap generation**

Verify legacy timer inactive, standalone timer active, HTTPS origin, builders
globally disabled, existing app healthy, zero failed units.

- [ ] **Step 2: Trigger standalone system deployment**

Use deployed root service. Verify exact promoted commit/path, system profile
advance, deployment markers, Mosquitto, Zigbee2MQTT, Tailscale, OpenSSH, app
health, and two-generation limits.

- [ ] **Step 3: Prove rejection and rollback safely**

Use disposable signed unhealthy fixture through tested seam; never rewrite
protected production refs. Verify failure restores last good generation, then
clear fixture state.

- [ ] **Step 4: Reboot and verify persistence**

After authorized reboot, verify SSH, Tailscale, timers, app, MQTT, Zigbee network
identity, profiles, mounts, and zero failed units.

- [ ] **Step 5: Revoke obsolete GitHub deploy key**

Only after both live deployers fetch HTTPS, delete key id `164001088`, verify it
absent through GitHub API, and confirm next app/system polls still succeed.

## Phase D: remove nixos-config ownership

### Task 14: Add portable operator recipient

**Credential boundary:**
- Portable age recovery identity stored in KeePass
- Public recipient added to Zigbee ciphertext

- [ ] **Step 1: Request one explicit credential handoff**

Obtain or create portable recipient without putting private identity in Git,
logs, shell arguments, chat, or disk outside approved KeePass flow.

- [ ] **Step 2: Re-encrypt Zigbee secret**

Encrypt to physical host plus portable recipient using interactive secret-safe
tooling. Verify each identity can decrypt without printing plaintext. Commit
ciphertext only; run host VM/toplevel gates, review, PR, human merge, live deploy.

### Task 15: Remove every home-server artifact from nixos-config

**Worktree:**
- Create: `/home/jonathan/Repos/nixos-config-worktrees/remove-home-server`

**Files removed or narrowed:**
- `hosts/home-server/*`
- `profiles/home-server-base.nix`
- home-server-only modules/scripts/tests/fixtures/docs
- home-server secret declarations and rekeyed ciphertexts
- home-server flake outputs/checks and CI lanes
- obsolete smarthome input and lock node

- [ ] **Step 1: Add red absence contract**

Extend consistency tests to assert no home-server output, CI lane, secret
declaration, or smarthome pin remains while Dellan shared modules and deploy
secret remain.

- [ ] **Step 2: Remove explicit reviewed paths**

Deletion happens only after live proof and user deletion authorization. Keep
shared `tailscale.nix`, `agenix-rekey-common.nix`, `nixos-auto-deploy.nix`,
build coordination, Dellan secrets, and Dellan SSH access.

- [ ] **Step 3: Run full affected NixOS gates**

List checks with `nix eval`, build every selected lane and Dellan toplevel, run
deterministic gate and fresh review, then push with complete pre-push trailer.
Human merges.

- [ ] **Step 4: Final independence audit**

Verify physical server:

```text
no active unit references nixos-config
no Git remote references nixos-config
no credential references old repository
app and system polls succeed after cleanup merge
builders remain disabled
at most two app and two system generations
SSH, Tailscale, MQTT, Zigbee, app healthy
zero failed units
```

Expected final state: `smarthome` alone reproduces and operates `home-server`;
`nixos-config` contains no home-server ownership.
