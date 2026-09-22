# Standalone Home Server Design

## Goal

Make `smarthome` the only repository needed to reproduce, publish, deploy, and
test the physical `home-server` NixOS system. GitHub builds both application and
system releases. `home-server` pulls promoted commits and signed closures
directly, with local builds impossible. `nixos-config` remains only a one-time
bootstrap source and loses all home-server ownership after live cutover proof.

## Scope and assumptions

- The current package-profile deployment remains the fast path for ordinary
  application changes.
- A second, independent system-profile deployment path handles NixOS, service,
  secret-ciphertext, and hardware changes.
- PR #7's complete Cachix publication fix lands and passes its main-branch
  publication before migration deployment begins.
- The exact Zigbee coordinator configuration and stable network identity from
  `nixos-config` PR #245 are included before the first standalone switch.
- Existing mutable service data and the dedicated application profile remain in
  place. This is a configuration ownership migration, not a data migration.
- Existing Dellan OpenSSH access remains during cutover. Tuxedo and friend keys
  are separate access-management work; the old repository is not removed until
  at least one migration-safe operator key is confirmed.
- Both repositories are public. Git fetches therefore use HTTPS and no runtime
  GitHub deploy key.

## Approaches considered

### Publish app and system on every `main` commit

This has the smallest workflow, but every Rust-only change rebuilds and uploads
the full NixOS closure. It wastes GitHub time and cache space and creates a new
system generation whose configuration did not change.

### Promote independent release refs (selected)

Protected `main` remains the reviewed source of truth. GitHub advances
`release/app` only after an application closure is published and verified, and
advances `release/home-server` only after a system closure is published and
verified. The server polls these refs independently. This preserves the cheap
application path without allowing the server to chase an unbuilt commit.

### Publish release manifests or GitHub release artifacts

A signed manifest can name commits and store paths without Git refs, but it
adds a second file-signing and retrieval protocol. Git fast-forward refs plus
Cachix signatures already provide the required promotion and artifact trust
boundaries, so a manifest would add machinery without a new safety property.

## Repository layout

The application tree remains unchanged. New NixOS ownership lives below one
top-level directory:

```text
nixos/
  hosts/home-server/
    default.nix
    deployment-identity.nix
    hardware-configuration.nix
    zigbee-coordinator.nix
  profiles/home-server-base.nix
  modules/
    home-server-services.nix
    house-automation-service.nix
    app-auto-deploy.nix
    system-auto-deploy.nix
    activate-app.sh
    activate-system.sh
    hydrate-release-paths.sh
  secrets/
    zigbee2mqtt-network-key.age
  tests/
    home-server.nix
    home-server-cd.nix
    app-deploy.nix
    system-deploy.nix
    app-activator.nix
    system-activator.nix
    hydrator.nix
    fixtures/
```

Files begin from the exact tested production versions, including PR #245, then
are narrowed for a 128 GB appliance. Workstation-wide `modules/common.nix`,
overlays, Home Manager, Android tooling, and Nix memory/build coordination do
not move. Small shared modules such as Tailscale are copied or inlined so no
runtime or evaluation import points back to `nixos-config`.

The flake exports:

- `packages.x86_64-linux.default` for the application;
- `nixosModules.default` for the reusable application module;
- `nixosConfigurations.home-server` for the physical machine;
- CD fixture configurations used by deployment tests;
- focused app, host, hydrator, activator, and deployment checks.

Application packaging keeps the existing NixOS 26.05 `nixpkgs` input. A new
`nixpkgs-system` input starts at exact live revision
`b7c2ada94fe99c15b0dbcf4d11fd7850b957a436`. This prevents an accidental OS
downgrade during ownership migration. Pin unification is a later reviewed
change, not part of cutover.

## Secrets

Only the Zigbee network key is still required by the standalone system. The
runtime ciphertext is copied from the tested home-server-specific ciphertext
and consumed through plain agenix, encrypted to the physical host key. GitHub
deploy-key ciphertexts and the Cachix write token do not enter this tree:

- public HTTPS replaces both GitHub deploy keys on the server;
- `CACHIX_AUTH_TOKEN` remains only in GitHub Actions;
- the server trusts only the public Cachix signing key.

Before `nixos-config` cleanup removes the canonical Zigbee source ciphertext,
the secret is re-encrypted to both the physical host recipient and a portable
operator recovery recipient stored outside Git. That final recipient requires
an explicit credential handoff; until then the runtime migration can be tested,
but destructive secret-source cleanup cannot proceed.

No plaintext secret, private key, token, exact household address, or private
topology value enters Git, build logs, the Nix store, or PR text.

## Release classification and CI

Every pull request always evaluates the flake and runs a stable summary check.
A tested, fail-closed classifier selects additional jobs:

- Rust crates, Cargo metadata, app package/module/tests: application checks.
- `nixos/**` and system tests: system toplevel and NixOS VM checks.
- `flake.nix`, `flake.lock`, or CI/classifier changes: both groups.
- documentation only: evaluation and summary only.
- unknown path: both groups.

After merge, the publication workflow uses two independent DAGs:

```text
classify
├── build app ── publish app closure ── verify Cachix paths ── promote release/app
└── build system ── publish system closure ── verify Cachix paths ── promote release/home-server
```

Promotion happens only after every recursive store path is present in
`jonathanmoregard.cachix.org` and cache-only substitution succeeds with
`max-jobs=0`, `fallback=false`, and `builders=""`. System closures are pushed in
bounded explicit-argument batches to avoid both Cachix's no-stdin behavior and
`ARG_MAX`.

Release refs only fast-forward. A late older workflow run exits without
rewinding a newer promotion. The promoted commit must be the workflow's exact
`github.sha`. Server-side deployment additionally verifies that the candidate
is an ancestor of fetched protected `main`.

`main` must require pull requests and the stable CI summary, and must forbid
force pushes and deletion before system self-deployment is enabled. Workflow
permissions default to read-only; only final promotion jobs receive
`contents: write`.

## Target build and disk contract

The appliance configuration enforces:

```nix
nix.settings = {
  max-jobs = 0;
  builders = "";
  fallback = false;
  keep-derivations = false;
  keep-outputs = false;
};
```

The deployers repeat those no-build flags on every evaluation, realization,
copy, and activation command. They hydrate only signed closures. No application
package is embedded in the system closure; the automation service executes the
stable application profile.

Both application and system profiles retain the active and immediately prior
healthy generation. Only after health succeeds are older generations pruned
and garbage collection requested. Git state is one root-owned repository with
periodic garbage collection. Journald remains bounded. No workstation package
set or derivation closure becomes a GC root.

## Deployment model

One root-owned checkout fetches `main`, `release/app`, and
`release/home-server` over HTTPS. App and system deployment use one global
`flock`, preventing an app switch from racing a system switch.

### Application track

The current activator is retained, with these changes:

1. resolve `release/app`, not raw `main`;
2. require it to be an ancestor of `origin/main`;
3. remove SSH identity handling;
4. hydrate and verify the exact package closure;
5. switch `/nix/var/nix/profiles/smarthome`;
6. health-check and roll back on failure;
7. retain two stable app generations.

### System track

The system deployer:

1. resolves promoted `release/home-server` and verifies main ancestry;
2. evaluates the exact
   `nixosConfigurations.home-server.config.system.build.toplevel.outPath` with
   builders disabled;
3. hydrates the complete signed closure from Cachix;
4. records current system profile and release state;
5. atomically installs the candidate system profile;
6. runs the candidate `switch-to-configuration switch` while preventing the
   deploy unit from restarting itself;
7. verifies OpenSSH, Tailscale, Mosquitto, Zigbee2MQTT when enabled,
   house-automation when configured, the two deploy timers, and zero unexpected
   failed units;
8. records success and prunes to two healthy system generations.

Failure before profile switch leaves the active system untouched. Failure after
switch restores the previous system profile, runs its activation program, and
verifies recovery. Manual rollback/profile drift is never overwritten merely
because a remote ref still names the newer commit. A poison latch blocks repeat
activation of a known unhealthy candidate while transient Git or publication
races remain retryable.

## Cutover

1. Merge PR #7; require its main publication and cache-only verification to
   pass; retry current app deploy and prove live health.
2. Merge or reproduce exact PR #245 Zigbee configuration and ciphertext.
3. Merge the standalone smarthome PR after local VM, interactive smoke, review,
   and hosted CI pass.
4. Let GitHub publish and promote both release refs; verify every system path is
   available from Cachix.
5. Enable branch protection on smarthome `main`.
6. Through one minimal `nixos-config` PR, pin the standalone smarthome commit,
   install its system deploy client, and disable the legacy NixOS deploy timer.
7. Trigger the standalone system deploy and verify live switch, reboot, SSH,
   Tailscale, Mosquitto, Zigbee2MQTT, app health, timers, profiles, rollback, and
   zero failed units.
8. Revoke obsolete GitHub deploy key id `164001088` after both deployers use
   public HTTPS successfully.
9. Add/confirm the portable operator recipient and migration-safe SSH key.
10. Open a separate cleanup PR removing every home-server host, service module,
    test, secret declaration/ciphertext, CI job, and obsolete smarthome input
    from `nixos-config`.

At the end, the physical server depends on upstream Nixpkgs, agenix, GitHub,
Cachix, and Tailscale. It has no runtime, build, deploy, secret-file, test, or
flake dependency on `nixos-config` or Dellan.

## Verification

TDD adds focused contracts before each implementation slice. Automated checks
cover classification, workflow permissions and promotion monotonicity,
cache-only completeness, exact release ancestry, signature validation,
no-builder settings, both activators, rollback, start-limit recovery,
generation pruning, shared locking, mutable state preservation, and retained
administrator access.

NixOS VM tests boot the complete standalone host and exercise app and system
deployments against disposable Git and binary-cache fixtures. Because deployers
contain branching and multistep scripts, an interactive feature-VM smoke is
mandatory before the PR opens. After merge, physical verification includes one
normal reboot and one deliberately rejected/rolled-back candidate before old
ownership is removed.
