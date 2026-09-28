# Promoted application deployment: public Git only, exact cache provenance,
# ancestry protection, replay, and rollback-latch contract.
{ pkgs, nixosSystem }:

let
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  app = pkgs.writeShellScriptBin "house-automationd" "exit 0";
  fakeNix = pkgs.writeShellScriptBin "nix" ''
    [ "$1" = eval ] && [ "$2" = --raw ] || exit 64
    require_once() {
      local wanted=$1 argument count=0
      shift
      for argument in "$@"; do [ "$argument" = "$wanted" ] && count=$((count + 1)); done
      [ "$count" -eq 1 ]
    }
    require_once --no-update-lock-file "$@" || exit 64
    require_once --no-write-lock-file "$@" || exit 64
    printf '%s\n' "$*" >> "$DEPLOY_LOG"
    reference="''${*: -1}"
    cat "''${reference%%#*}"/release-path
  '';
  hydrator = pkgs.writeShellScriptBin "smarthome-hydrate-release-paths" ''
    printf '%s\n' "$*" >> "$DEPLOY_LOG"
    if [ "''${HYDRATOR_TRANSIENT_ONCE:-}" = "$HYDRATE_PATH" ] && [ ! -e "$HYDRATOR_RETRY_STATE" ]; then
      touch "$HYDRATOR_RETRY_STATE"
      exit 75
    fi
    case "$*" in *"$HYDRATE_PATH"*) exit 0 ;; *) exit 75 ;; esac
  '';
  activator = pkgs.writeShellScriptBin "activate-app" ''
    printf '%s\n' "$*" >> "$DEPLOY_LOG"
    if [ "$1" = --recover ]; then
      previous=$(sed -n 's/^previous_path=//p' "$2/pending-activation")
      [ -n "$previous" ] && [ "$previous" != none ] || exit 75
      ln -sfn "$previous" "$3"
      rm -f "$2/pending-activation"
      exit 0
    fi
    mkdir -p "$3"
    if [ "''${ACTIVATOR_FAIL_REV:-}" = "$2" ]; then
      printf 'rev=%s\nreason=candidate-health-failed\nrollback=complete\n' "$2" > "$3/last-failure"
      exit 1
    fi
    if [ "''${ACTIVATOR_INCOMPLETE_REV:-}" = "$2" ]; then
      printf 'rev=%s\nreason=candidate-health-failed\nrollback=incomplete\n' "$2" > "$3/last-failure"
      exit 1
    fi
    if [ "''${ACTIVATOR_TRANSIENT_REV:-}" = "$2" ] && [ ! -e "$ACTIVATOR_TRANSIENT_MARKER" ]; then
      touch "$ACTIVATOR_TRANSIENT_MARKER"
      printf 'rev=%s\nreason=candidate-restart-failed\nrollback=complete\n' "$2" > "$3/last-failure"
      exit 1
    fi
    ln -sfn "$1" "$4"
    printf 'rev=%s\npath=%s\nprevious_path=none\n' "$2" "$1" > "$3/last-success"
  '';
  evaluated = nixosSystem {
    system = "x86_64-linux";
    modules = [
      ../modules/app-auto-deploy.nix
      {
        documentation.enable = false;
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        system.stateVersion = "26.05";
        services.app-auto-deploy = {
          enable = true;
          testRepository = "file:///build/origin.git";
          sourceDir = "/build/source";
          profile = "/build/profile";
          nixPackage = fakeNix;
          hydratorPackage = hydrator;
          activatorPackage = activator;
        };
      }
    ];
  };
  forbiddenRepository = builtins.tryEval (nixosSystem {
    system = "x86_64-linux";
    modules = [ ../modules/app-auto-deploy.nix {
      documentation.enable = false;
      fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
      system.stateVersion = "26.05";
      services.app-auto-deploy.repository = "file:///forbidden";
    } ];
  }).config.services.app-auto-deploy.repository;
  service = evaluated.config.systemd.services.app-deploy;
in
assert !forbiddenRepository.success;
assert !(service.environment ? GIT_SSH_COMMAND);
assert !(service.environment ? SSH_AUTH_SOCK);
assert !(service.environment ? DEPLOY_KEY);
pkgs.runCommand "app-deploy-contract" { nativeBuildInputs = with pkgs; [ bash coreutils git gnugrep ]; } ''
  set -euo pipefail
  deploy=${service.serviceConfig.ExecStart}
  export DEPLOY_LOG="$PWD/deploy.log" HYDRATE_PATH=${app} HYDRATOR_RETRY_STATE="$PWD/hydrator-retry"
  export DEPLOY_LOCK="$PWD/run/deploy.lock"
  export STATE_DIRECTORY="$PWD/state" RUNTIME_DIRECTORY="$PWD/run"
  deploy_failure_diagnostics() {
    status=$?
    if [ "$status" -eq 0 ]; then
      return
    fi
    for log in missing-ref.log non-ancestor.log recovered-crash.log ref-rollback.log rollback.log; do
      [ -f "$log" ] || continue
      printf '\n--- %s ---\n' "$log" >&2
      cat "$log" >&2
    done
    if [ -f "$DEPLOY_LOG" ]; then
      printf '\n--- deploy log ---\n' >&2
      cat "$DEPLOY_LOG" >&2
    fi
    if [ -d source/.git ]; then
      printf '\n--- deploy source status ---\n' >&2
      git -C source status --short >&2 || true
      printf '\n--- deploy source refs ---\n' >&2
      git -C source show-ref >&2 || true
    fi
    return "$status"
  }
  trap deploy_failure_diagnostics EXIT
  grep -qF -- '--option max-jobs 0' "$deploy"
  grep -qF -- '--option fallback false' "$deploy"
  grep -qF -- '--option builders ""' "$deploy"
  grep -qF '${projectCache}' "$deploy"
  grep -qF '${projectKey}' "$deploy"
  grep -qF '${nixosCache}' "$deploy"
  grep -qF '${nixosKey}' "$deploy"
  ! grep -Eq 'IdentitiesOnly|deploy[Kk]ey|GIT_SSH_COMMAND|ssh -i' "$deploy"

  mkdir work run state
  git init -q work
  git -C work config user.email test@example.invalid
  git -C work config user.name test
  printf '%s\n' ${app} > work/release-path
  printf '{"version":7,"root":"root","nodes":{"root":{"inputs":{}}}}\n' > work/flake.lock
  git -C work add release-path flake.lock && git -C work commit -qm main
  main=$(git -C work rev-parse HEAD)
  initial_main=$main
  git init -q --bare origin.git
  git -C work remote add origin file:///build/origin.git
  git -C work push -q origin "$main":refs/heads/main
  git -C work push -q origin "$main":refs/heads/release/app
  # The program must reject a missing promotion and a promoted commit outside
  # main before it can hydrate or switch the active profile.
  git -C work push -q origin :refs/heads/release/app
  if "$deploy" > missing-ref.log 2>&1; then exit 1; fi
  grep -qF 'release/app' missing-ref.log
  git -C work checkout -qb unrelated
  printf other > work/release-path && git -C work commit -am unrelated -q
  foreign=$(git -C work rev-parse HEAD)
  git -C work push -q origin "$foreign":refs/heads/release/app
  if "$deploy" > non-ancestor.log 2>&1; then exit 1; fi
  grep -qF 'not an ancestor' non-ancestor.log

  # Lockless promoted content is refused before the evaluator can run.
  git -C work checkout -q "$main"
  rm work/flake.lock
  git -C work add -u && git -C work commit -qm lockless
  lockless=$(git -C work rev-parse HEAD)
  printf '{"version":7,"root":"root","nodes":{"root":{"inputs":{}}}}\n' > work/flake.lock
  git -C work add flake.lock && git -C work commit -qm locked-descendant
  main=$(git -C work rev-parse HEAD)
  git -C work push -q --force origin "$main":refs/heads/main
  git -C work push -q --force origin "$lockless":refs/heads/release/app
  if "$deploy" > missing-lock.log 2>&1; then exit 1; fi
  grep -qF 'promoted revision has no flake.lock' missing-lock.log
  [ ! -e "$DEPLOY_LOG" ]

  # A valid promoted revision is activated once. Replaying it is inert, while
  # a manual rollback remains a latch and must never be clobbered.
  git -C work push -q --force origin "$main":refs/heads/release/app
  "$deploy"
  [ "$(git -C source rev-parse HEAD)" = "$main" ]
  activations=$(grep -c '^${app} ' "$DEPLOY_LOG")
  [ "$activations" -eq 1 ]
  touch "$STATE_DIRECTORY/rollback-database.sqlite3"
  "$deploy"
  [ "$(grep -c '^${app} ' "$DEPLOY_LOG")" -eq 1 ]
  [ ! -e "$STATE_DIRECTORY/rollback-database.sqlite3" ]

  # A pending journal is recovered under the shared lock before profile drift
  # is classified. The interrupted candidate is retried only by a later poll.
  printf 'rev=ffffffffffffffffffffffffffffffffffffffff\npath=/crashed\nprevious_path=%s\nprevious_generation=1\n' ${app} > "$STATE_DIRECTORY/pending-activation"
  ln -sfn /crashed /build/profile
  if "$deploy" > recovered-crash.log 2>&1; then exit 1; fi
  grep -qF 'recovered interrupted activation; retrying on the next run' recovered-crash.log
  [ "$(readlink -f /build/profile)" = ${app} ]
  [ ! -e "$STATE_DIRECTORY/pending-activation" ]

  # Promotion may advance only: an older reviewed ancestor cannot roll the app
  # behind the last successful revision.
  git -C work push -q --force origin "$initial_main":refs/heads/release/app
  if "$deploy" > ref-rollback.log 2>&1; then exit 1; fi
  grep -qF 'promoted revision rolls back last successful revision' ref-rollback.log
  [ "$(grep -c '^${app} ' "$DEPLOY_LOG")" -eq 1 ]
  git -C work push -q --force origin "$main":refs/heads/release/app

  # A deterministic unhealthy activation is latched.
  git -C work checkout -q "$main"
  printf bad > work/promotion-marker
  git -C work add promotion-marker && git -C work commit -qm bad
  bad_commit=$(git -C work rev-parse HEAD)
  export ACTIVATOR_FAIL_REV="$bad_commit"
  printf main-after-bad > work/promotion-marker
  git -C work commit -am main-after-bad -q
  main_after_bad=$(git -C work rev-parse HEAD)
  git -C work push -q --force origin "$main_after_bad":refs/heads/main
  git -C work push -q --force origin "$bad_commit":refs/heads/release/app
  if "$deploy" > poison.log 2>&1; then exit 1; fi
  if "$deploy" > poison-replay.log 2>&1; then exit 1; fi
  grep -qF 'poisoned' poison-replay.log
  unset ACTIVATOR_FAIL_REV
  git -C work checkout -q "$main_after_bad"
  printf transient > work/promotion-marker
  git -C work add promotion-marker && git -C work commit -qm transient
  transient=$(git -C work rev-parse HEAD)
  printf main-after-transient > work/promotion-marker
  git -C work commit -am main-after-transient -q
  main_after_transient=$(git -C work rev-parse HEAD)
  git -C work push -q --force origin "$main_after_transient":refs/heads/main
  git -C work push -q --force origin "$transient":refs/heads/release/app
  export ACTIVATOR_TRANSIENT_REV="$transient" ACTIVATOR_TRANSIENT_MARKER="$PWD/transient-once"
  before_transient=$(grep -c '^${app} ' "$DEPLOY_LOG")
  if "$deploy" > transient.log 2>&1; then exit 1; fi
  "$deploy"
  [ "$(grep -c '^${app} ' "$DEPLOY_LOG")" -eq $((before_transient + 2)) ]
  ! grep -qF 'poisoned' transient.log
  unset ACTIVATOR_TRANSIENT_REV ACTIVATOR_TRANSIENT_MARKER
  # An unhealthy candidate with incomplete rollback must remain retryable;
  # only a proven-complete recovery is a deterministic poison latch.
  git -C work checkout -q "$main_after_transient"
  printf incomplete > work/promotion-marker
  git -C work add promotion-marker && git -C work commit -qm incomplete
  incomplete=$(git -C work rev-parse HEAD)
  printf main-after-incomplete > work/promotion-marker
  git -C work commit -am main-after-incomplete -q
  main_after_incomplete=$(git -C work rev-parse HEAD)
  git -C work push -q --force origin "$main_after_incomplete":refs/heads/main
  git -C work push -q --force origin "$incomplete":refs/heads/release/app
  export ACTIVATOR_INCOMPLETE_REV="$incomplete"
  if "$deploy" > incomplete.log 2>&1; then exit 1; fi
  if "$deploy" > incomplete-replay.log 2>&1; then exit 1; fi
  ! grep -qF 'poisoned' incomplete-replay.log
  unset ACTIVATOR_INCOMPLETE_REV
  ln -sfn /manual-rollback /build/profile
  if "$deploy" > rollback.log 2>&1; then exit 1; fi
  grep -qF 'rollback' rollback.log
  touch "$out"
''
