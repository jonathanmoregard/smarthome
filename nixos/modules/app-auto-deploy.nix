{ config, lib, pkgs, ... }:

let
  cfg = config.services.app-auto-deploy;
  stateDir = "/var/lib/smarthome-deploy";
  runtimeDir = "/run/smarthome-deploy";
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  hydrator = pkgs.writeShellApplication {
    name = "smarthome-hydrate-release-paths";
    runtimeInputs = with pkgs; [ bash coreutils jq cfg.nixPackage ];
    text = ''exec ${pkgs.bash}/bin/bash ${./hydrate-release-paths.sh} "$@"'';
  };
  activator = pkgs.writeShellApplication {
    name = "activate-app";
    runtimeInputs = with pkgs; [ bash coreutils curl systemd config.nix.package ];
    text = ''exec ${pkgs.bash}/bin/bash ${./activate-app.sh} "$@"'';
  };
  deploy = pkgs.writeShellApplication {
    name = "app-deploy";
    runtimeInputs = with pkgs; [ bash coreutils git util-linux cfg.nixPackage ];
    text = ''
      set -euo pipefail
      set -f
      umask 077
      state="''${STATE_DIRECTORY:-${stateDir}}"; runtime="''${RUNTIME_DIRECTORY:-${runtimeDir}}"
      source=${lib.escapeShellArg cfg.sourceDir}; repo=${lib.escapeShellArg (if cfg.testRepository == null then cfg.repository else cfg.testRepository)}
      profile=${lib.escapeShellArg cfg.profile}; attr=${lib.escapeShellArg cfg.packageAttr}
      lock="''${DEPLOY_LOCK:-/run/smarthome-deploy/deploy.lock}"
      die() { printf 'app-deploy: %s\n' "$*" >&2; exit 1; }
      mkdir -p "$state" "$runtime" "$source" "$(dirname "$profile")"
      exec {fd}>"$lock"; flock --exclusive "$fd"
      export HOME="$state" XDG_CACHE_HOME="$state/cache" GIT_TERMINAL_PROMPT=0
      mkdir -p "$XDG_CACHE_HOME"
      if [ ! -d "$source/.git" ]; then git -C "$source" init -q; git -C "$source" remote add origin "$repo"; else git -C "$source" remote set-url origin "$repo"; fi
      git -C "$source" fetch --prune origin +refs/heads/main:refs/remotes/origin/main +refs/heads/release/app:refs/remotes/origin/release/app
      candidate=$(git -C "$source" rev-parse refs/remotes/origin/release/app) || die 'release/app is missing'
      git -C "$source" merge-base --is-ancestor "$candidate" origin/main || die 'release/app is not an ancestor of origin/main'
      revision=$candidate
      git -C "$source" reset --hard "$revision" > /dev/null
      git -C "$source" clean -ffdqx
      [ -f "$source/flake.lock" ] || die 'promoted revision has no flake.lock'
      active=$(readlink -f "$profile" 2>/dev/null || true)
      last_revision=
      last_path=
      if [ -s "$state/last-success" ]; then while IFS='=' read -r key value; do case "$key" in rev) last_revision=$value ;; path) last_path=$value ;; esac; done < "$state/last-success"; fi
      if [ -n "$last_path" ] && [ "$active" != "$last_path" ]; then die 'rollback in effect; refusing to clobber'; fi
      if [ "$revision" = "$last_revision" ]; then printf 'app-deploy: already deployed %s\n' "$revision"; exit 0; fi
      if [ -s "$state/last-failure" ]; then
        failed_revision=
        failed_reason=
        failed_rollback=
        while IFS='=' read -r key value; do case "$key" in rev) failed_revision=$value ;; reason) failed_reason=$value ;; rollback) failed_rollback=$value ;; esac; done < "$state/last-failure"
        if [ "$failed_revision" = "$revision" ] && [ "$failed_reason" = candidate-health-failed ] && [ "$failed_rollback" = complete ]; then
          die 'candidate is poisoned after deterministic unhealthy activation'
        fi
      fi
      package_path=$(nix eval --raw --no-update-lock-file --no-write-lock-file --option max-jobs 0 --option fallback false --option builders "" "$source#$attr.outPath") || die 'package path evaluation failed'
      [[ "$package_path" =~ ^/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || die 'invalid evaluated package path'
      ${lib.getExe cfg.hydratorPackage} --from ${lib.escapeShellArg projectCache} --trusted-key ${lib.escapeShellArg projectKey} --from ${lib.escapeShellArg nixosCache} --trusted-key ${lib.escapeShellArg nixosKey} --timeout-seconds 300 --interval 5 --attempts 3 "$package_path" || die 'release hydration failed'
      ${lib.getExe cfg.activatorPackage} "$package_path" "$revision" "$state" "$profile" ${lib.escapeShellArg cfg.serviceName} ${lib.escapeShellArg cfg.healthUrl}
    '';
  };
in {
  options.services.app-auto-deploy = {
    enable = lib.mkEnableOption "promoted public application deployment";
    repository = lib.mkOption { type = lib.types.strMatching "https://[^[:space:]]+"; default = "https://github.com/jonathanmoregard/smarthome.git"; };
    testRepository = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; internal = true; };
    sourceDir = lib.mkOption { type = lib.types.str; default = "${stateDir}/source"; };
    profile = lib.mkOption { type = lib.types.str; default = "/nix/var/nix/profiles/smarthome"; };
    packageAttr = lib.mkOption { type = lib.types.str; default = "packages.x86_64-linux.default"; };
    serviceName = lib.mkOption { type = lib.types.str; default = "-"; description = "Unit to restart, or '-' for service-free profile activation."; };
    healthUrl = lib.mkOption { type = lib.types.str; default = "-"; description = "Health URL, paired with serviceName; '-' is service-free."; };
    nixPackage = lib.mkOption { type = lib.types.package; default = config.nix.package; internal = true; };
    hydratorPackage = lib.mkOption { type = lib.types.package; default = hydrator; internal = true; };
    activatorPackage = lib.mkOption { type = lib.types.package; default = activator; internal = true; };
  };
  config = lib.mkIf cfg.enable {
    assertions = [ {
      assertion = (cfg.serviceName == "-") == (cfg.healthUrl == "-");
      message = "services.app-auto-deploy.serviceName and healthUrl must both be '-' or both be configured";
    } ];
    systemd.timers.app-deploy = { wantedBy = [ "timers.target" ]; timerConfig = { OnBootSec = "2min"; OnUnitActiveSec = "15min"; Persistent = true; Unit = "app-deploy.service"; }; };
    systemd.services.app-deploy = {
      after = [ "network-online.target" ]; wants = [ "network-online.target" ];
      serviceConfig = { Type = "oneshot"; ExecStart = lib.getExe deploy; User = "root"; Group = "root"; StateDirectory = "smarthome-deploy"; StateDirectoryMode = "0700"; RuntimeDirectory = "smarthome-deploy"; RuntimeDirectoryMode = "0700"; RuntimeDirectoryPreserve = "yes"; TimeoutStartSec = "10min"; UMask = "0077"; NoNewPrivileges = true; PrivateTmp = true; ProtectHome = true; ProtectSystem = "strict"; ReadWritePaths = [ stateDir runtimeDir (builtins.dirOf cfg.profile) ]; };
    };
  };
}
