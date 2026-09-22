# Promoted NixOS deployment: reviewed ref, no-build evaluation, signed hydration,
# replay/drift protection, and deterministic-health poison contract.
{ pkgs, nixosSystem }:

let
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  systemPath = pkgs.runCommand "fake-nixos-system" { } ''
    mkdir -p "$out/bin"
    touch "$out/bin/switch-to-configuration"
    chmod +x "$out/bin/switch-to-configuration"
  '';
  fakeNix = pkgs.writeShellScriptBin "nix" ''
    set -euo pipefail
    [ "$1" = eval ] && [ "$2" = --raw ] || exit 64
    require_once() {
      wanted=$1 count=0
      shift
      for argument in "$@"; do [ "$argument" = "$wanted" ] && count=$((count + 1)); done
      [ "$count" -eq 1 ]
    }
    require_once --no-update-lock-file "$@" || exit 64
    require_once --no-write-lock-file "$@" || exit 64
    max_jobs=0 fallback=0 builders=0
    arguments=("$@")
    for ((index = 0; index + 2 < ''${#arguments[@]}; index++)); do
      [ "''${arguments[$index]}" = --option ] || continue
      case "''${arguments[$((index + 1))]}:''${arguments[$((index + 2))]}" in
        max-jobs:0) max_jobs=$((max_jobs + 1)) ;;
        fallback:false) fallback=$((fallback + 1)) ;;
        builders:) builders=$((builders + 1)) ;;
      esac
    done
    [ "$max_jobs" -eq 1 ] && [ "$fallback" -eq 1 ] && [ "$builders" -eq 1 ] || exit 64
    printf 'nix %s\n' "$*" >> "$DEPLOY_LOG"
    reference="''${*: -1}"
    [ "''${reference#*#}" = nixosConfigurations.home-server.config.system.build.toplevel ] || exit 64
    cat "''${reference%%#*}/system-path"
  '';
  hydrator = pkgs.writeShellScriptBin "smarthome-hydrate-release-paths" ''
    [ "$#" -eq 15 ]
    [ "$1" = --from ] && [ "$2" = '${projectCache}' ]
    [ "$3" = --trusted-key ] && [ "$4" = '${projectKey}' ]
    [ "$5" = --from ] && [ "$6" = '${nixosCache}' ]
    [ "$7" = --trusted-key ] && [ "$8" = '${nixosKey}' ]
    [ "$9" = --timeout-seconds ] && [ "''${10}" = 300 ]
    [ "''${11}" = --interval ] && [ "''${12}" = 5 ]
    [ "''${13}" = --attempts ] && [ "''${14}" = 3 ]
    [ "''${15}" = "$HYDRATE_PATH" ]
    printf 'hydrate %s\n' "$*" >> "$DEPLOY_LOG"
    if [ "''${HYDRATOR_TRANSIENT_ONCE:-0}" = 1 ] && [ ! -e "$HYDRATOR_RETRY_STATE" ]; then
      touch "$HYDRATOR_RETRY_STATE"
      exit 75
    fi
    case "$*" in *"$HYDRATE_PATH"*) exit 0 ;; *) exit 75 ;; esac
  '';
  activator = pkgs.writeShellScriptBin "activate-system" ''
    set -euo pipefail
    printf 'activate %s\n' "$*" >> "$DEPLOY_LOG"
    if [ "$1" = --recover ]; then
      previous=$(sed -n 's/^previous_path=//p' "$2/pending-activation")
      [ -n "$previous" ] && [ "$previous" != none ] || exit 75
      ln -sfn "$previous" "$3"
      ln -sfn "$previous" "$4"
      rm -f "$2/pending-activation"
      exit 0
    fi
    mkdir -p "$3" "$(dirname "$4")"
    if [ "''${ACTIVATOR_UNHEALTHY_REV:-}" = "$2" ]; then
      printf 'rev=%s\npath=%s\nreason=candidate-health-failed\nrollback=complete\n' "$2" "$1" > "$3/last-failure"
      exit 1
    fi
    if [ "''${ACTIVATOR_INCOMPLETE_REV:-}" = "$2" ]; then
      printf 'rev=%s\npath=%s\nreason=candidate-health-failed\nrollback=incomplete\n' "$2" "$1" > "$3/last-failure"
      exit 1
    fi
    if [ "''${ACTIVATOR_TRANSIENT_REV:-}" = "$2" ] && [ ! -e "$ACTIVATOR_RETRY_STATE" ]; then
      touch "$ACTIVATOR_RETRY_STATE"
      printf 'rev=%s\npath=%s\nreason=candidate-switch-timeout\nrollback=complete\n' "$2" "$1" > "$3/last-failure"
      exit 1
    fi
    ln -sfn "$1" "$4"
    ln -sfn "$1" "$5"
    printf 'rev=%s\npath=%s\nprevious_path=none\nprevious_generation=none\n' "$2" "$1" > "$3/last-success"
  '';
  evaluated = nixosSystem {
    system = "x86_64-linux";
    modules = [
      ../modules/system-auto-deploy.nix
      {
        documentation.enable = false;
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        system.stateVersion = "26.05";
        services.system-auto-deploy = {
          enable = true;
          testRepository = "file:///build/origin.git";
          sourceDir = "/build/system-source";
          profile = "/build/system-profile";
          runningSystemPath = "/build/current-system";
          nixPackage = fakeNix;
          hydratorPackage = hydrator;
          activatorPackage = activator;
        };
      }
    ];
  };
  forbiddenRepository = builtins.tryEval (nixosSystem {
    system = "x86_64-linux";
    modules = [ ../modules/system-auto-deploy.nix {
      documentation.enable = false;
      fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
      system.stateVersion = "26.05";
      services.system-auto-deploy.repository = "file:///forbidden";
    } ];
  }).config.services.system-auto-deploy.repository;
  service = evaluated.config.systemd.services.system-deploy;
  protectHome = if (service.serviceConfig.ProtectHome or false) then "true" else "false";
  writablePaths = builtins.concatStringsSep " " service.serviceConfig.ReadWritePaths;
in
assert !forbiddenRepository.success;
assert evaluated.options.services.system-auto-deploy.repository.default == "https://github.com/jonathanmoregard/smarthome.git";
assert evaluated.config.services.system-auto-deploy.releaseRef == "release/home-server";
assert evaluated.config.services.system-auto-deploy.healthUnits == [
  "sshd.service"
  "tailscaled.service"
  "mosquitto.service"
];
assert evaluated.config.services.system-auto-deploy.healthUnitGroups == [
  [ "app-deploy.timer" "smarthome-deploy.timer" ]
  [ "system-deploy.timer" "nixos-deploy.timer" ]
];
assert service.serviceConfig.User == "root";
assert service.serviceConfig.Group == "root";
assert service.serviceConfig.TimeoutStartSec == "10min";
assert service.serviceConfig.TimeoutStopSec == "5min";
assert service.serviceConfig.RuntimeDirectory == "smarthome-deploy";
assert service.serviceConfig.RuntimeDirectoryPreserve == "yes";
assert service.restartIfChanged == false;
pkgs.runCommand "system-deploy-contract" {
  nativeBuildInputs = with pkgs; [ bash coreutils git gnugrep ];
} ''
  set -euo pipefail
  deploy=${service.serviceConfig.ExecStart}
  export STATE_DIRECTORY="$PWD/state" RUNTIME_DIRECTORY="$PWD/run"
  export DEPLOY_LOCK="$PWD/run/deploy.lock" DEPLOY_LOG="$PWD/deploy.log"
  export HYDRATE_PATH=${systemPath} HYDRATOR_RETRY_STATE="$PWD/hydrator-once"
  export ACTIVATOR_RETRY_STATE="$PWD/activator-once"
  diagnose() {
    status=$?
    [ "$status" -eq 0 ] && return
    for log in ./*.log; do
      [ -f "$log" ] || continue
      printf '\n--- %s ---\n' "$log" >&2
      cat "$log" >&2
    done
    [ ! -d system-source/.git ] || git -C system-source show-ref >&2 || true
    return "$status"
  }
  trap diagnose EXIT

  sandbox_status=0
  if [ '${protectHome}' != false ]; then
    echo 'ProtectHome blocks NixOS activation writes to /root and /home' >&2
    sandbox_status=1
  fi
  case ' ${writablePaths} ' in
    *' /usr '*) ;;
    *)
      echo 'ProtectSystem blocks NixOS activation writes to /usr' >&2
      sandbox_status=1
      ;;
  esac
  [ "$sandbox_status" -eq 0 ] || exit 1

  grep -qF 'refs/heads/release/home-server' "$deploy"
  grep -qF 'refs/heads/main:refs/remotes/origin/main' "$deploy"
  grep -qF 'merge-base --is-ancestor' "$deploy"
  grep -qF '/run/smarthome-deploy/deploy.lock' "$deploy"
  [ "$(grep -cF 'timeout --signal=KILL 45s git' "$deploy")" -eq 2 ]
  grep -qF 'nixosConfigurations.home-server.config.system.build.toplevel' "$deploy"
  grep -qF -- '--no-update-lock-file' "$deploy"
  grep -qF -- '--no-write-lock-file' "$deploy"
  grep -qF -- '--option max-jobs 0' "$deploy"
  grep -qF -- '--option fallback false' "$deploy"
  grep -qF -- '--option builders ""' "$deploy"
  grep -qF '${projectCache}' "$deploy"
  grep -qF '${projectKey}' "$deploy"
  grep -qF '${nixosCache}' "$deploy"
  grep -qF '${nixosKey}' "$deploy"
  for unit in sshd.service tailscaled.service mosquitto.service app-deploy.timer smarthome-deploy.timer system-deploy.timer nixos-deploy.timer; do
    grep -qF "$unit" "$deploy"
  done
  ! grep -Eq 'IdentitiesOnly|deploy[Kk]ey|GIT_SSH_COMMAND|ssh -i' "$deploy"

  mkdir work run state
  git init -q work
  git -C work config user.email test@example.invalid
  git -C work config user.name test
  printf '%s\n' ${systemPath} > work/system-path
  printf '{"version":7,"root":"root","nodes":{"root":{"inputs":{}}}}\n' > work/flake.lock
  git -C work add system-path flake.lock
  git -C work commit -qm main
  main=$(git -C work rev-parse HEAD)
  initial_main=$main
  git init -q --bare origin.git
  git -C work remote add origin file:///build/origin.git
  git -C work push -q origin "$main":refs/heads/main

  # Missing promotion, unrelated promotion, and a lockless revision fail before
  # evaluation/hydration/activation and cannot poison a revision.
  if "$deploy" > missing-ref.log 2>&1; then exit 1; fi
  grep -qF 'release/home-server is missing or unavailable' missing-ref.log
  [ ! -e "$DEPLOY_LOG" ]

  git -C work checkout -qb unrelated
  printf foreign > work/release-marker
  git -C work add release-marker && git -C work commit -qm foreign
  foreign=$(git -C work rev-parse HEAD)
  git -C work push -q origin "$foreign":refs/heads/release/home-server
  if "$deploy" > non-ancestor.log 2>&1; then exit 1; fi
  grep -qF 'not an ancestor' non-ancestor.log
  [ ! -e "$DEPLOY_LOG" ]

  git -C work checkout -q "$main"
  rm work/flake.lock
  git -C work add -u && git -C work commit -qm lockless
  lockless=$(git -C work rev-parse HEAD)
  printf '{"version":7,"root":"root","nodes":{"root":{"inputs":{}}}}\n' > work/flake.lock
  git -C work add flake.lock && git -C work commit -qm locked-main
  main=$(git -C work rev-parse HEAD)
  git -C work push -q --force origin "$main":refs/heads/main
  git -C work push -q --force origin "$lockless":refs/heads/release/home-server
  if "$deploy" > lockless.log 2>&1; then exit 1; fi
  grep -qF 'promoted revision has no flake.lock' lockless.log
  [ ! -e "$DEPLOY_LOG" ]

  # Valid exact revision activates once; replay is inert.
  git -C work push -q --force origin "$main":refs/heads/release/home-server
  "$deploy"
  [ "$(git -C system-source rev-parse HEAD)" = "$main" ]
  [ "$(grep -c '^activate ' "$DEPLOY_LOG")" -eq 1 ]
  "$deploy"
  [ "$(grep -c '^activate ' "$DEPLOY_LOG")" -eq 1 ]

  # A crash journal is recovered under the shared lock before fetch or drift
  # classification, then the candidate is retried only by a later run.
  printf 'rev=ffffffffffffffffffffffffffffffffffffffff\npath=/crashed\nprevious_path=%s\nprevious_generation=1\n' ${systemPath} > "$STATE_DIRECTORY/pending-activation"
  ln -sfn /crashed "$PWD/system-profile"
  ln -sfn /crashed "$PWD/current-system"
  if "$deploy" > recovered-crash.log 2>&1; then exit 1; fi
  grep -qF 'recovered interrupted activation; retrying on the next run' recovered-crash.log
  [ "$(readlink -f "$PWD/system-profile")" = ${systemPath} ]
  [ "$(readlink -f "$PWD/current-system")" = ${systemPath} ]
  [ ! -e "$STATE_DIRECTORY/pending-activation" ]

  # Promotion may advance only: an older reviewed ancestor cannot roll the
  # system behind the last successful revision.
  git -C work push -q --force origin "$initial_main":refs/heads/release/home-server
  if "$deploy" > ref-rollback.log 2>&1; then exit 1; fi
  grep -qF 'promoted revision rolls back last successful revision' ref-rollback.log
  git -C work push -q --force origin "$main":refs/heads/release/home-server

  # Manual profile drift is an operator latch, checked before evaluation.
  ln -sfn /manual-system "$PWD/system-profile"
  before=$(wc -l < "$DEPLOY_LOG")
  if "$deploy" > drift.log 2>&1; then exit 1; fi
  grep -qF 'rollback in effect; refusing to clobber' drift.log
  [ "$(wc -l < "$DEPLOY_LOG")" -eq "$before" ]
  ln -sfn ${systemPath} "$PWD/system-profile"

  # Cache misses and switch timeouts remain retryable and never poison.
  git -C work checkout -q "$main"
  printf cache-retry > work/release-marker
  git -C work add release-marker && git -C work commit -qm cache-retry
  cache_retry=$(git -C work rev-parse HEAD)
  git -C work push -q origin "$cache_retry":refs/heads/main
  git -C work push -q --force origin "$cache_retry":refs/heads/release/home-server
  export HYDRATOR_TRANSIENT_ONCE=1
  if "$deploy" > cache-retry.log 2>&1; then exit 1; fi
  [ ! -e "$STATE_DIRECTORY/last-failure" ]
  "$deploy"
  unset HYDRATOR_TRANSIENT_ONCE

  git -C work checkout -q "$cache_retry"
  printf switch-retry > work/release-marker
  git -C work commit -am switch-retry -q
  switch_retry=$(git -C work rev-parse HEAD)
  git -C work push -q origin "$switch_retry":refs/heads/main
  git -C work push -q --force origin "$switch_retry":refs/heads/release/home-server
  export ACTIVATOR_TRANSIENT_REV="$switch_retry"
  if "$deploy" > switch-retry.log 2>&1; then exit 1; fi
  ! grep -qF 'poisoned' switch-retry.log
  "$deploy"
  ! grep -qF 'poisoned' switch-retry.log
  unset ACTIVATOR_TRANSIENT_REV

  # Even a health failure is retryable while exact rollback is incomplete.
  git -C work checkout -q "$switch_retry"
  printf incomplete > work/release-marker
  git -C work commit -am incomplete -q
  incomplete_rev=$(git -C work rev-parse HEAD)
  git -C work push -q origin "$incomplete_rev":refs/heads/main
  git -C work push -q --force origin "$incomplete_rev":refs/heads/release/home-server
  export ACTIVATOR_INCOMPLETE_REV="$incomplete_rev"
  if "$deploy" > incomplete.log 2>&1; then exit 1; fi
  if "$deploy" > incomplete-replay.log 2>&1; then exit 1; fi
  ! grep -qF 'poisoned' incomplete-replay.log
  unset ACTIVATOR_INCOMPLETE_REV

  # Only switch success followed by sustained health failure and complete
  # rollback is deterministic poison; replay refuses before activation.
  git -C work checkout -q "$incomplete_rev"
  printf unhealthy > work/release-marker
  git -C work commit -am unhealthy -q
  unhealthy_rev=$(git -C work rev-parse HEAD)
  git -C work push -q origin "$unhealthy_rev":refs/heads/main
  git -C work push -q --force origin "$unhealthy_rev":refs/heads/release/home-server
  export ACTIVATOR_UNHEALTHY_REV="$unhealthy_rev"
  if "$deploy" > unhealthy.log 2>&1; then exit 1; fi
  activations=$(grep -c '^activate ' "$DEPLOY_LOG")
  if "$deploy" > poisoned.log 2>&1; then exit 1; fi
  grep -qF 'candidate is poisoned after deterministic unhealthy activation' poisoned.log
  [ "$(grep -c '^activate ' "$DEPLOY_LOG")" -eq "$activations" ]

  touch "$out"
''
