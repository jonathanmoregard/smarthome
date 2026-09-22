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
    mkdir -p "$3"
    if [ "''${ACTIVATOR_FAIL_REV:-}" = "$2" ]; then
      printf 'rev=%s\nreason=service-restart-or-health-failed\nrollback=complete\n' "$2" > "$3/last-failure"
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
          repository = "file:///build/origin.git";
          sourceDir = "/build/source";
          profile = "/build/profile";
          nixPackage = fakeNix;
          hydratorPackage = hydrator;
          activatorPackage = activator;
        };
      }
    ];
  };
  service = evaluated.config.systemd.services.app-deploy;
in
assert service.serviceConfig.RuntimeDirectory == "smarthome-deploy";
assert service.serviceConfig.TimeoutStartSec == "10min";
assert service.serviceConfig.ExecStart != "";
assert evaluated.config.services.app-auto-deploy.serviceName == "-";
assert evaluated.config.services.app-auto-deploy.healthUrl == "-";
assert evaluated.options.services.app-auto-deploy.repository.default == "https://github.com/jonathanmoregard/smarthome.git";
assert !(service.environment ? GIT_SSH_COMMAND);
assert !(service.environment ? SSH_AUTH_SOCK);
assert !(service.environment ? DEPLOY_KEY);
pkgs.runCommand "app-deploy-contract" { nativeBuildInputs = with pkgs; [ bash coreutils git gnugrep ]; } ''
  set -euo pipefail
  deploy=${service.serviceConfig.ExecStart}
  export DEPLOY_LOG="$PWD/deploy.log" HYDRATE_PATH=${app} HYDRATOR_RETRY_STATE="$PWD/hydrator-retry"
  export DEPLOY_LOCK="$PWD/run/deploy.lock"
  deploy_failure_diagnostics() {
    status=$?
    if [ "$status" -eq 0 ]; then
      return
    fi
    for log in missing-ref.log non-ancestor.log rollback.log; do
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
  grep -qF 'refs/heads/release/app' "$deploy"
  grep -qF 'merge-base --is-ancestor' "$deploy"
  grep -qF 'origin/main' "$deploy"
  grep -qF '/run/smarthome-deploy/deploy.lock' "$deploy"
  grep -qF 'candidate is poisoned after deterministic unhealthy activation' "$deploy"
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
  git -C work add release-path && git -C work commit -qm main
  main=$(git -C work rev-parse HEAD)
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

  # A valid promoted revision is activated once. Replaying it is inert, while
  # a manual rollback remains a latch and must never be clobbered.
  git -C work push -q --force origin "$main":refs/heads/release/app
  "$deploy"
  [ "$(git -C source rev-parse HEAD)" = "$main" ]
  activations=$(grep -c '^${app} ' "$DEPLOY_LOG")
  [ "$activations" -eq 1 ]
  "$deploy"
  [ "$(grep -c '^${app} ' "$DEPLOY_LOG")" -eq 1 ]
  # A deterministic unhealthy activation is latched; a transient hydration
  # failure is not and succeeds on the next timer replay.
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
  export HYDRATOR_TRANSIENT_ONCE=${app}
  if "$deploy" > transient.log 2>&1; then exit 1; fi
  "$deploy"
  unset HYDRATOR_TRANSIENT_ONCE
  ln -sfn /manual-rollback /build/profile
  if "$deploy" > rollback.log 2>&1; then exit 1; fi
  grep -qF 'rollback' rollback.log
  touch "$out"
''
