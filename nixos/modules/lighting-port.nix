{ config, lib, pkgs, ... }:

# The lighting port (lighting-scripts/, the TypeScript Home Assistant lighting
# controller) runs here from a mutable git checkout, by its own dev watcher:
# it recompiles on save and restarts the host, keeping the last good build on
# a compile error. This module provides Node, the user and the unit, never the
# code: the checkout is cloned once and then belongs to the operator, who
# edits it in place and reconciles it into the repository by hand. Nothing
# here ever fetches, pulls or resets it.
#
# The port is deliberately not part of a deploy. Its code changes without one,
# so it is not a system-auto-deploy health unit. That alone is not enough:
# switch-to-configuration fails (exit 4) when, after a switch, any unit is
# `failed`, or is in auto-restart after a non-zero exit, and the deployer then
# rolls the whole system back. A port that is crashing while someone edits it,
# a first deploy before the env file exists, or a clone that cannot reach
# GitHub would each block every unrelated deploy. So the unit is built never
# to be in either state, and never to make a switch wait:
#   - setup (clone, `npm ci`) runs inside the service process, not in a
#     oneshot ordered before it, because a switch waits for such a oneshot
#     and counts its failure;
#   - something only the operator can fix stops the unit cleanly with status
#     78 and is not retried (`refuse`);
#   - anything worth another try, the watcher exiting included, exits 0 and
#     is restarted by Restart=always (`retry`). The real status is logged.

let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.services.lighting-port;

  stateDir = "/var/lib/lighting-port";
  checkout = "${stateDir}/src";
  scriptsDir = "${checkout}/lighting-scripts";
  envFile = "${stateDir}/env";
  nodejs = pkgs.nodejs_22;
  # EX_CONFIG: the configuration is wrong, and a retry will not fix it.
  refusedStatus = 78;

  isRuntimePath = value:
    lib.hasPrefix "/" value
    && value != builtins.storeDir
    && !lib.hasPrefix "${builtins.storeDir}/" value;

  run = pkgs.writeShellApplication {
    name = "lighting-port";
    runtimeInputs = [ pkgs.coreutils pkgs.git nodejs ];
    text = ''
      repository=${lib.escapeShellArg cfg.repository}
      branch=${lib.escapeShellArg cfg.branch}
      checkout=${checkout}
      partial=${stateDir}/.src.partial
      scripts=${scriptsDir}
      env_file=${envFile}
      catalog=.runtime/catalog.json

      say() { printf 'lighting-port: %s\n' "$*" >&2; }
      refuse() { say "refusing to start: $*"; exit ${toString refusedStatus}; }
      retry() { say "$*; retrying after restart"; exit 0; }

      # Clone only into an absent checkout, and make it appear whole: a clone
      # cut short must not leave a directory that later counts as present.
      if [ ! -e "$checkout" ]; then
        if [ -e "$partial" ]; then
          stale="$partial.$(date +%s)"
          mv -- "$partial" "$stale"
          say "moved an interrupted clone aside to $stale; delete it when convenient"
        fi
        say "cloning $repository ($branch) into $checkout"
        git clone --quiet --branch "$branch" -- "$repository" "$partial" || retry "clone failed"
        mv -- "$partial" "$checkout"
      fi

      if [ ! -f "$scripts/package-lock.json" ]; then
        refuse "$scripts/package-lock.json does not exist; is $checkout a checkout of a branch with lighting-scripts?"
      fi
      cd "$scripts"

      # The stamp lives inside node_modules, so a missing node_modules and a
      # changed package-lock.json are the same test, and an install cut short
      # (npm ci empties node_modules first) is redone.
      lock_hash=$(sha256sum package-lock.json | cut -d' ' -f1)
      stamp=node_modules/.lighting-port-lock.sha256
      if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$lock_hash" ]; then
        say "running npm ci"
        npm ci --no-audit --no-fund || retry "npm ci failed"
        printf '%s\n' "$lock_hash" > "$stamp"
      fi

      # Which rooms the port may drive is the operator's call, made in the env
      # file; a missing answer never means any room. An empty LIVE_ROOMS is
      # the port's own "no rooms" and is passed through.
      if [ ! -f "$env_file" ]; then
        refuse "$env_file does not exist; create it with a line LIVE_ROOMS=<room>[,<room>...]"
      fi
      if [ -z "''${LIVE_ROOMS+set}" ]; then
        refuse "LIVE_ROOMS is not set in $env_file"
      fi
      if [ ! -r "$HA_TOKEN_FILE" ] || [ ! -s "$HA_TOKEN_FILE" ]; then
        refuse "HA token file $HA_TOKEN_FILE is missing, unreadable or empty"
      fi
      # Created by the unit, so it is group-writable whatever the operator's
      # umask, and the port can always write its journal next to the catalog.
      mkdir -p .runtime
      if [ ! -f "$catalog" ]; then
        refuse "$scripts/$catalog does not exist"
      fi

      say "starting the watcher for live rooms '$LIVE_ROOMS'"
      status=0
      node scripts/dev.mjs --live --config "$catalog" --live-rooms "$LIVE_ROOMS" || status=$?
      say "watcher exited with status $status; restarting"
      exit 0
    '';
  };
in
{
  options.services.lighting-port = {
    enable = mkEnableOption "the lighting port, run from a mutable checkout by its dev watcher";
    repository = mkOption {
      type = types.str;
      default = "https://github.com/jonathanmoregard/smarthome.git";
      description = "Repository cloned into ${checkout} when that directory is absent. Never fetched afterwards.";
    };
    branch = mkOption {
      type = types.str;
      default = "feature/typescript-lighting-scripts";
      description = "Branch checked out by that one clone. Changing it later does not touch an existing checkout.";
    };
    homeAssistantUrl = mkOption {
      type = types.strMatching "https?://[^[:space:]]+";
      default = "http://127.0.0.1:8123";
      description = "Home Assistant base URL, passed to the port as HA_URL.";
    };
    haTokenFile = mkOption {
      type = types.str;
      description = "Runtime path of the Home Assistant long-lived access token, readable by the lighting-port user. Passed as HA_TOKEN_FILE.";
    };
    operators = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Users added to the lighting-port group, so they can edit the checkout and ${envFile} without sudo.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = isRuntimePath cfg.haTokenFile;
        message = "services.lighting-port.haTokenFile must be an absolute runtime path outside the Nix store";
      }
    ];

    users.users.lighting-port = {
      isSystemUser = true;
      group = "lighting-port";
      description = "Lighting port";
    };
    users.groups.lighting-port.members = cfg.operators;

    # The checkout belongs to lighting-port; git refuses to work in a
    # repository another user owns unless it is named here.
    programs.git = {
      enable = true;
      config.safe.directory = [ checkout ];
    };

    systemd.services.lighting-port = {
      description = "Lighting port, run by its dev watcher from ${scriptsDir}";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      environment = {
        HA_URL = cfg.homeAssistantUrl;
        HA_TOKEN_FILE = cfg.haTokenFile;
        # npm's cache and git's config; the system user's home is /var/empty.
        HOME = stateDir;
        npm_config_update_notifier = "false";
      };
      # A start limit would leave the unit `failed`, which a switch counts.
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "simple";
        ExecStart = lib.getExe run;
        User = "lighting-port";
        Group = "lighting-port";
        # Optional to systemd, so a missing file reaches the script, which
        # refuses to start and says why, instead of systemd failing the unit.
        EnvironmentFile = "-${envFile}";
        Restart = "always";
        RestartSec = "10s";
        # A deploy that changes this unit restarts it inside the deployer's
        # 120 s switch timeout. The port's shutdown waits on Home Assistant,
        # which may be restarting in the same switch; the default 90 s would
        # spend most of that budget. Its journal is written whole and renamed
        # into place, so a kill cannot leave it half-written.
        TimeoutStopSec = "20s";
        SuccessExitStatus = [ refusedStatus ];
        RestartPreventExitStatus = [ refusedStatus ];
        # Group-writable, setgid: the operator and the service share every
        # file under it.
        StateDirectory = "lighting-port";
        StateDirectoryMode = "2770";
        UMask = "0007";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
        CapabilityBoundingSet = "";
      };
    };
  };
}
