# Promoted application deployment: public Git only, exact cache provenance,
# ancestry protection, replay, and rollback-latch contract.
{ pkgs, nixosSystem }:

let
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  app = pkgs.writeShellScriptBin "house-automationd" "exit 0";
  hydrator = pkgs.writeShellScriptBin "smarthome-hydrate-release-paths" ''
    printf '%s\n' "$*" >> "$DEPLOY_LOG"
    case "$*" in *"$HYDRATE_PATH"*) exit 0 ;; *) exit 75 ;; esac
  '';
  activator = pkgs.writeShellScriptBin "activate-app" ''
    printf '%s\n' "$*" >> "$DEPLOY_LOG"
    ln -sfn "$1" "$4"
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
          repository = "https://github.com/jonathanmoregard/smarthome.git";
          sourceDir = "/build/source";
          profile = "/build/profile";
          nixPackage = pkgs.nix;
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
assert !(service.environment ? GIT_SSH_COMMAND);
assert !(service.environment ? SSH_AUTH_SOCK);
assert !(service.environment ? DEPLOY_KEY);
pkgs.runCommand "app-deploy-contract" { nativeBuildInputs = with pkgs; [ bash coreutils git gnugrep ]; } ''
  set -euo pipefail
  deploy=${service.serviceConfig.ExecStart}
  grep -qF 'https://github.com/jonathanmoregard/smarthome.git' "$deploy"
  grep -qF 'refs/heads/release/app' "$deploy"
  grep -qF 'git merge-base --is-ancestor' "$deploy"
  grep -qF 'origin/main' "$deploy"
  grep -qF '/run/smarthome-deploy/deploy.lock' "$deploy"
  grep -qF -- '--option max-jobs 0' "$deploy"
  grep -qF -- '--option fallback false' "$deploy"
  grep -qF -- '--option builders ""' "$deploy"
  grep -qF '${projectCache}' "$deploy"
  grep -qF '${projectKey}' "$deploy"
  grep -qF '${nixosCache}' "$deploy"
  grep -qF '${nixosKey}' "$deploy"
  ! grep -Eq 'IdentitiesOnly|deploy[Kk]ey|GIT_SSH_COMMAND|ssh -i' "$deploy"

  export DEPLOY_LOG="$PWD/deploy.log" HYDRATE_PATH=${app}
  mkdir source run state
  git init -q source
  git -C source config user.email test@example.invalid
  git -C source config user.name test
  printf '%s\n' ${app} > source/release-path
  git -C source add release-path && git -C source commit -qm main
  main=$(git -C source rev-parse HEAD)
  git -C source update-ref refs/heads/release/app "$main"

  # The program must reject a missing promotion and a promoted commit outside
  # main before it can hydrate or switch the active profile.
  git -C source update-ref -d refs/heads/release/app
  if "$deploy" > missing-ref.log 2>&1; then exit 1; fi
  grep -qF 'release/app' missing-ref.log
  git -C source checkout -qb unrelated
  printf other > source/release-path && git -C source commit -am unrelated -q
  foreign=$(git -C source rev-parse HEAD)
  git -C source update-ref refs/heads/release/app "$foreign"
  if "$deploy" > non-ancestor.log 2>&1; then exit 1; fi
  grep -qF 'not an ancestor' non-ancestor.log

  # A valid promoted revision is activated once. Replaying it is inert, while
  # a manual rollback remains a latch and must never be clobbered.
  git -C source update-ref refs/heads/release/app "$main"
  "$deploy"
  activations=$(grep -c '^${app} ' "$DEPLOY_LOG")
  [ "$activations" -eq 1 ]
  "$deploy"
  [ "$(grep -c '^${app} ' "$DEPLOY_LOG")" -eq 1 ]
  ln -sfn /manual-rollback /build/profile
  if "$deploy" > rollback.log 2>&1; then exit 1; fi
  grep -qF 'rollback' rollback.log
  touch "$out"
''
