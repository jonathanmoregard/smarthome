# Direct Package Deployment Design

## Goal

Deploy merged smarthome releases from GitHub to `home-server` without using
`dellan` as a build or transport hop. GitHub builds each release, Cachix stores
the signed runtime closure, and `home-server` pulls and activates it. The server
must never build the application locally and must retain only the current and
previous application generations.

The NixOS repository continues to own machine bootstrap, secrets, service
hardening, and the deployment mechanism. It no longer pins or imports the
smarthome source tree for normal application releases. `dellan` keeps its
existing OpenSSH administrator key; application delivery does not depend on
that key or machine.

## Selected architecture

Three release shapes were considered:

1. Publish the application package closure and switch a dedicated Nix profile.
   This is selected. It preserves Nix reproducibility and signature checking,
   transfers only the runtime closure, and gives the application an atomic,
   two-generation rollback boundary independent of NixOS system generations.
2. Build and publish a complete NixOS system for every application change, as
   Klaffat does. This gives one system-wide transaction but retains much larger
   closures and couples application releases to machine configuration.
3. Publish a standalone binary archive as a GitHub release artifact. This can
   be small, but it loses Nix closure metadata and cache signatures and creates
   a separate dependency and verification mechanism.

The package-profile design copies Klaffat's important safety properties at the
smallest useful boundary: exact Git revision, signed cache substitution, no
target builds, atomic activation, health verification, and rollback.

## Trust and release flow

`main` is the only production release source. Pull requests run the existing
flake checks without secrets. A separate workflow runs only after a push to
`main` and:

1. checks out the exact merge commit;
2. builds `packages.x86_64-linux.default` on a GitHub-hosted runner;
3. pushes that output's runtime closure to `jonathanmoregard.cachix.org` using
   a cache-scoped write token;
4. verifies that the exact package path can be substituted from the cache with
   local builds disabled.

The workflow has read-only repository permissions. Its Cachix token is never
available to pull-request jobs. Protected `main` remains the human release
gate: reviewed, green changes merge before any package is published.

`home-server` polls the private GitHub repository over SSH with a new,
repository-specific, read-only deploy key. GitHub deploy keys cannot be shared
between repositories, so the existing `nixos-config` key stays separate. GitHub
host keys are pinned. The server fetches `main` into a machine-owned bare Git
repository and resolves the fetched commit, never an unverified remote string.

For that exact commit, the server evaluates the package output path with
builders disabled, then copies the path from Cachix with builders disabled. It
accepts only paths signed by the configured Cachix signing key. Missing,
unsigned, or incomplete releases fail closed; they cannot trigger compilation.

## Activation and rollback

The stable executable path is owned by a dedicated root profile, conceptually
`/nix/var/nix/profiles/smarthome`. The deploy service performs this transaction:

1. acquire a deployment lock;
2. fetch and resolve the candidate commit;
3. return successfully when it already matches the active release;
4. evaluate and hydrate its package path from the signed cache;
5. validate the expected executable before changing the profile;
6. record the currently active profile generation and release metadata;
7. atomically install the candidate into the profile;
8. restart `house-automation.service` when configured and require it plus its
   local health endpoint to become healthy;
9. write the successful commit and store path atomically;
10. remove profile generations older than the active and immediately previous
    generations.

If restart or health verification fails, the deployer rolls the profile back,
restarts the old service, verifies recovery, and preserves failure diagnostics.
An unconfigured household has no running automation daemon; deployment still
validates and stages the executable so CI/CD can be commissioned before device
registration.

`ExecStart` references the stable profile path rather than a package embedded
in the NixOS system closure. Service configuration remains rendered and owned
by the host module. Application updates therefore do not rebuild or switch the
operating system.

## Disk and build constraints

Every evaluation, realization, and copy command sets `max-jobs = 0` and allows
substitutes. No fallback builder is configured for the deployment service.
Failure to find a cached release is an error, not permission to compile.

The server explicitly uses `keep-derivations = false` and `keep-outputs =
false`. Publication and deployment operate on the package output/runtime
closure, not the derivation or build closure. After each successful switch,
only two app profile generations remain GC roots. Existing scheduled Nix store
garbage collection then removes older app closures and evaluation/source paths.
System-generation retention remains a separate NixOS concern.

Release state contains only small text files: active commit, active store path,
last failure, and lock state. The source checkout is a bare/shallow machine
checkout and is periodically repacked or replaced during fetch, avoiding an
unbounded Git history.

## NixOS ownership

`nixos-config` gains a local deployment/service module containing:

- host-owned application TOML rendering and service hardening;
- the stable profile-backed service command;
- private-repository polling, cache hydration, activation, and rollback;
- a timer and explicit on-demand service;
- agenix wiring for the smarthome repository deploy key;
- disk-retention settings and assertions.

It removes the smarthome flake input and lock entry. The smarthome repository
may continue exporting its general NixOS module for other consumers, but the
production home server does not consume it. This removes the former
`nixos-config -> smarthome` release pin while preserving the necessary
`home-server -> GitHub/Cachix` runtime relationship.

The existing `jonathan@dellan` authorized key is unchanged. Migration to the
Tuxedo computer still requires adding its public administrator key through the
NixOS PR pipeline before retiring `dellan`; app deployment credentials do not
grant interactive shell access.

## Failure model

- GitHub build fails: no cache publication; active server release is untouched.
- Cache publication is incomplete: cache-only hydration fails; active profile
  is untouched.
- Repository authentication or fetch fails: timer records failure and retries
  later; active release is untouched.
- Candidate lacks expected executable or signature: reject before switching.
- Service fails after switch: roll profile and service back to last working
  generation.
- Power loss during state write: atomic rename leaves either old or new complete
  state. Nix profile switching is atomic.
- Rollback also fails: preserve both generations and emit a high-priority
  journal failure; do not delete recovery roots.

## Verification

Repository tests enforce publication workflow boundaries: `main`-only trigger,
read-only permissions, exact package build, Cachix publication, and no secret in
pull-request CI.

A dedicated NixOS VM lane uses disposable Git and binary-cache fixtures to
prove:

- target starts without candidate package or build capability;
- missing and unsigned releases fail without local compilation;
- valid signed release installs and starts through the stable profile;
- replay is idempotent;
- unhealthy candidate rolls back to the prior healthy generation;
- successful third release leaves exactly two app profile generations;
- `dellan` SSH authorization remains present;
- service, timer, release markers, and garbage-collection settings match the
  production contract.

Because the deployer contains branching and a multi-step systemd script, an
interactive VM smoke test is mandatory before the NixOS pull request opens.
