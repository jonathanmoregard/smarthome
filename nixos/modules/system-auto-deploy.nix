{ config, lib, pkgs, ... }:

let
  cfg = config.services.system-auto-deploy;
  stateDir = "/var/lib/smarthome-system-deploy";
  runtimeDir = "/run/smarthome-deploy";
  projectCache = "https://jonathanmoregard.cachix.org";
  projectKey = "jonathanmoregard.cachix.org-1:Qzksr/c2ciAaV4j/U2mGFd1HTgOAicks8gJNs1Ztxo8=";
  nixosCache = "https://cache.nixos.org";
  nixosKey = "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=";
  healthUnitType = lib.types.strMatching "[A-Za-z0-9@_.:-]+[.](service|timer)";
  baseHealthUnits = [
    "sshd.service"
    "tailscaled.service"
    "mosquitto.service"
  ];
  baseHealthUnitGroups = [
    [ "app-deploy.timer" "smarthome-deploy.timer" ]
    [ "system-deploy.timer" "nixos-deploy.timer" ]
  ];
  healthArguments =
    lib.concatMap (unit: [ "--unit" unit ]) cfg.healthUnits
    ++ lib.concatMap (group: [ "--any-unit-group" (builtins.concatStringsSep "," group) ]) cfg.healthUnitGroups;
  escapedHealthArguments = lib.escapeShellArgs healthArguments;
  hydrator = pkgs.writeShellApplication {
    name = "smarthome-hydrate-release-paths";
    runtimeInputs = with pkgs; [ bash coreutils jq cfg.nixPackage ];
    text = ''exec ${./hydrate-release-paths.sh} "$@"'';
  };
  activator = pkgs.writeShellApplication {
    name = "activate-system";
    runtimeInputs = with pkgs; [ bash coreutils systemd cfg.nixPackage ];
    text = ''exec ${./activate-system.sh} "$@"'';
  };
  deploy = pkgs.writeShellApplication {
    name = "system-deploy";
    runtimeInputs = with pkgs; [ bash coreutils git util-linux cfg.nixPackage ];
    text = ''
      set -euo pipefail
      set -f
      umask 077
      state="''${STATE_DIRECTORY:-${stateDir}}"
      runtime="''${RUNTIME_DIRECTORY:-${runtimeDir}}"
      source=${lib.escapeShellArg cfg.sourceDir}
      repo=${lib.escapeShellArg (if cfg.testRepository == null then cfg.repository else cfg.testRepository)}
      profile=${lib.escapeShellArg cfg.profile}
      lock="''${DEPLOY_LOCK:-/run/smarthome-deploy/deploy.lock}"
      die() { printf 'system-deploy: %s\n' "$*" >&2; exit 1; }

      mkdir -p "$state" "$runtime" "$source" "$(dirname "$profile")"
      exec {lock_fd}>"$lock"
      flock --exclusive "$lock_fd"
      if [ -s "$state/pending-activation" ]; then
        ${lib.getExe cfg.activatorPackage} --recover "$state" "$profile" ${lib.escapeShellArg cfg.runningSystemPath} ${escapedHealthArguments} || \
          die 'interrupted activation recovery failed'
        die 'recovered interrupted activation; retrying on the next run'
      fi
      export HOME="$state" XDG_CACHE_HOME="$state/cache" GIT_TERMINAL_PROMPT=0
      mkdir -p "$XDG_CACHE_HOME"
      if [ ! -d "$source/.git" ]; then
        git -C "$source" init -q
        git -C "$source" remote add origin "$repo"
      else
        git -C "$source" remote set-url origin "$repo"
      fi
      fetch_status=0
      timeout --signal=KILL 45s git -C "$source" fetch --prune origin \
        +refs/heads/main:refs/remotes/origin/main || fetch_status=$?
      case "$fetch_status" in
        0) ;;
        124|137) die 'main fetch timed out; retrying on the next run' ;;
        *) die 'main fetch failed; retrying on the next run' ;;
      esac
      fetch_status=0
      timeout --signal=KILL 45s git -C "$source" fetch --prune origin \
        +refs/heads/${cfg.releaseRef}:refs/remotes/origin/${cfg.releaseRef} || fetch_status=$?
      case "$fetch_status" in
        0) ;;
        124|137) die '${cfg.releaseRef} fetch timed out; retrying on the next run' ;;
        *) die '${cfg.releaseRef} is missing or unavailable; retrying on the next run' ;;
      esac
      candidate=$(git -C "$source" rev-parse refs/remotes/origin/${cfg.releaseRef}) || die '${cfg.releaseRef} is missing'
      git -C "$source" merge-base --is-ancestor "$candidate" origin/main || die '${cfg.releaseRef} is not an ancestor of origin/main'
      revision=$candidate
      git -C "$source" reset --hard "$revision" >/dev/null
      git -C "$source" clean -ffdqx
      [ -f "$source/flake.lock" ] || die 'promoted revision has no flake.lock'

      active=$(readlink -f "$profile" 2>/dev/null || true)
      running=$(readlink -f ${lib.escapeShellArg cfg.runningSystemPath} 2>/dev/null || true)
      last_revision=
      last_path=
      if [ -s "$state/last-success" ]; then
        while IFS='=' read -r key value; do
          case "$key" in
            rev) last_revision=$value ;;
            path) last_path=$value ;;
          esac
        done < "$state/last-success"
      fi
      if [ -n "$last_path" ] && { [ "$active" != "$last_path" ] || [ "$running" != "$last_path" ]; }; then
        die 'rollback in effect; refusing to clobber'
      fi
      if [ -n "$last_revision" ] && [ "$revision" != "$last_revision" ]; then
        git -C "$source" merge-base --is-ancestor "$last_revision" "$revision" || \
          die 'promoted revision rolls back last successful revision'
      fi
      if [ "$revision" = "$last_revision" ]; then
        printf 'system-deploy: already deployed %s\n' "$revision"
        exit 0
      fi
      if [ -s "$state/last-failure" ]; then
        failed_revision=
        failed_reason=
        failed_rollback=
        while IFS='=' read -r key value; do
          case "$key" in
            rev) failed_revision=$value ;;
            reason) failed_reason=$value ;;
            rollback) failed_rollback=$value ;;
          esac
        done < "$state/last-failure"
        if [ "$failed_revision" = "$revision" ] && \
           [ "$failed_reason" = candidate-health-failed ] && \
           [ "$failed_rollback" = complete ]; then
          die 'candidate is poisoned after deterministic unhealthy activation'
        fi
      fi

      system_path=$(nix eval --raw --no-update-lock-file --no-write-lock-file \
        --option max-jobs 0 --option fallback false --option builders "" \
        "$source#nixosConfigurations.${cfg.hostAttr}.config.system.build.toplevel") || \
        die 'system path evaluation failed'
      [[ "$system_path" =~ ^/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,211}$ ]] || \
        die 'invalid evaluated system path'
      ${lib.getExe cfg.hydratorPackage} \
        --from ${lib.escapeShellArg projectCache} --trusted-key ${lib.escapeShellArg projectKey} \
        --from ${lib.escapeShellArg nixosCache} --trusted-key ${lib.escapeShellArg nixosKey} \
        --timeout-seconds 300 --interval 5 --attempts 3 "$system_path" || \
        die 'release hydration failed'
      ${lib.getExe cfg.activatorPackage} "$system_path" "$revision" "$state" "$profile" ${lib.escapeShellArg cfg.runningSystemPath} ${escapedHealthArguments}
    '';
  };
in
{
  options.services.system-auto-deploy = {
    enable = lib.mkEnableOption "promoted public NixOS system deployment";
    repository = lib.mkOption {
      type = lib.types.strMatching "https://[^[:space:]]+";
      default = "https://github.com/jonathanmoregard/smarthome.git";
    };
    testRepository = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      internal = true;
    };
    releaseRef = lib.mkOption {
      type = lib.types.strMatching "release/[A-Za-z0-9._/-]+";
      default = "release/home-server";
      readOnly = true;
    };
    sourceDir = lib.mkOption {
      type = lib.types.str;
      default = "${stateDir}/source";
    };
    profile = lib.mkOption {
      type = lib.types.str;
      default = "/nix/var/nix/profiles/system";
    };
    runningSystemPath = lib.mkOption {
      type = lib.types.str;
      default = "/run/current-system";
      internal = true;
    };
    healthUnits = lib.mkOption {
      type = lib.types.listOf healthUnitType;
      default = [ ];
      description = "Units that must remain active throughout sustained candidate and recovery health checks.";
    };
    healthUnitGroups = lib.mkOption {
      type = lib.types.listOf (lib.types.listOf healthUnitType);
      default = [ ];
      description = "Compatibility groups from which at least one unit must be active throughout sustained health checks.";
    };
    hostAttr = lib.mkOption {
      type = lib.types.strMatching "[A-Za-z0-9._-]+";
      default = "home-server";
    };
    nixPackage = lib.mkOption {
      type = lib.types.package;
      default = config.nix.package;
      internal = true;
    };
    hydratorPackage = lib.mkOption {
      type = lib.types.package;
      default = hydrator;
      internal = true;
    };
    activatorPackage = lib.mkOption {
      type = lib.types.package;
      default = activator;
      internal = true;
    };
  };

  config = lib.mkIf cfg.enable {
    services.system-auto-deploy.healthUnits = lib.mkBefore baseHealthUnits;
    services.system-auto-deploy.healthUnitGroups = lib.mkBefore baseHealthUnitGroups;
    assertions = [ {
      assertion = builtins.all (group: group != [ ]) cfg.healthUnitGroups;
      message = "services.system-auto-deploy.healthUnitGroups cannot contain an empty group";
    } ];
    systemd.timers.system-deploy = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "3min";
        OnUnitActiveSec = "15min";
        Persistent = true;
        Unit = "system-deploy.service";
      };
    };
    systemd.services.system-deploy = {
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      restartIfChanged = false;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = lib.getExe deploy;
        User = "root";
        Group = "root";
        StateDirectory = "smarthome-system-deploy";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "smarthome-deploy";
        RuntimeDirectoryMode = "0700";
        RuntimeDirectoryPreserve = "yes";
        TimeoutStartSec = "10min";
        TimeoutStopSec = "5min";
        UMask = "0077";
        PrivateTmp = true;
        ProtectSystem = "full";
        ReadWritePaths = [ stateDir runtimeDir cfg.sourceDir (builtins.dirOf cfg.profile) "/etc" "/run" "/usr" "/var" "/boot" "-/efi" ];
      };
    };
  };
}
