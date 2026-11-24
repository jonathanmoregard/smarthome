{ config, lib, pkgs, ... }:

# The lighting port (lighting-scripts/, the TypeScript Home Assistant lighting
# controller) runs here from a git checkout, by its own dev watcher: it
# recompiles when a file under src/ changes and restarts the host, keeping the
# last good build on a compile error. This module provides Node, the user and
# the units, never the code: the checkout is cloned once, and from then on
# lighting-port-follow keeps it at the branch on origin, within about a
# minute of a push. The checkout is not edited on the server: the follower
# forces it to the branch and discards local edits to tracked files. It never
# cleans, so .runtime (catalog, journal) and node_modules stay. What the
# watcher does not see (lighting-scripts outside src/, a package-lock.json
# that is not what is installed) restarts the unit.
#
# The port is deliberately not part of a deploy. Its code changes without one,
# so it is not a system-auto-deploy health unit. That alone is not enough:
# switch-to-configuration fails (exit 4) when, after a switch, any unit is
# `failed`, or is in auto-restart after a non-zero exit, and the deployer then
# rolls the whole system back. A port that is crashing on a pushed change,
# a first deploy before the env file exists, or a clone that cannot reach
# GitHub would each block every unrelated deploy. So the unit is built never
# to be in either state, and never to make a switch wait:
#   - setup (clone, `npm ci`) runs inside the service process, not in a
#     oneshot ordered before it, because a switch waits for such a oneshot
#     and counts its failure;
#   - something only the operator can fix stops the unit cleanly with status
#     78 and is not retried (`refuse`);
#   - any other setup failure, foreseen or not (`retry`, `catch_all`), and the
#     watcher exiting, exit 0 and are restarted by Restart=always, backing
#     off while they repeat. The real status is logged;
#   - a stop reaches the host once, through the watcher, and is clean even
#     when the port's own shutdown hangs; a watcher that dies alone has its
#     host stopped the same way before the unit backs off.
# The follower holds to the same rule: it runs from its timer alone, a switch
# never restarts it, and every run exits 0, whatever fails (an unreachable
# origin is tried again next minute).

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
  # How long the port gets to shut down before the unit kills it itself;
  # below TimeoutStopSec, so systemd never has to.
  stopGraceSeconds = 15;
  # A watcher that has run this long before it exits (or is stopped) ran;
  # its exit is not part of a run of failed starts.
  stableSeconds = 300;

  isRuntimePath = value:
    lib.hasPrefix "/" value
    && value != builtins.storeDir
    && !lib.hasPrefix "${builtins.storeDir}/" value;

  run = pkgs.writeShellApplication {
    name = "lighting-port";
    runtimeInputs = [ pkgs.coreutils pkgs.findutils pkgs.git pkgs.util-linux nodejs ];
    text = ''
      repository=${lib.escapeShellArg cfg.repository}
      branch=${lib.escapeShellArg cfg.branch}
      checkout=${checkout}
      partial=${stateDir}/.src.partial
      failures_file=${stateDir}/.setup-failures
      exits_file=${stateDir}/.watcher-exits
      scripts=${scriptsDir}
      env_file=${envFile}
      catalog=.runtime/catalog.json
      stop_grace_seconds=${toString stopGraceSeconds}
      stable_seconds=${toString stableSeconds}

      say() { printf 'lighting-port: %s\n' "$*" >&2; }
      refuse() { say "refusing to start: $*"; exit ${toString refusedStatus}; }

      # A failure worth another try. Each consecutive one, counted in
      # <count file>, waits longer (10 s, doubling, at most 5 min) before
      # handing back to Restart=, so a deleted branch, an unreachable origin
      # or a port that refuses its configuration is not hammered.
      # back_off <count file> <what is counted> <message>
      back_off() {
        failures=$(cat -- "$1" 2>/dev/null) || failures=0
        if ! [[ "$failures" =~ ^[0-9]+$ ]]; then failures=0; fi
        failures=$((failures + 1))
        delay=300
        if [ "$failures" -le 5 ]; then delay=$((10 << (failures - 1))); fi
        printf '%s\n' "$failures" > "$1" || true
        say "$3; retrying in ''${delay}s ($2 $failures in a row)"
        interruptible sleep "$delay"
        exit 0
      }
      # A setup step failed. The count resets once setup gets through.
      retry() { back_off "$failures_file" "setup failure" "$1"; }

      # A stop (or a restart by a deploy) is never a failure. systemd sends
      # its SIGTERM to this script alone (KillMode=mixed) and SIGKILLs
      # whatever is left once the script has exited. Bash runs a trap only
      # between commands, so a step that can take long runs in the
      # background and is waited for: a wait ends at the signal, a foreground
      # command would hold the stop until it finished.
      trap 'exit 0' TERM INT
      interruptible() { "$@" & wait "$!"; }
      # The catch-all: anything that fails without being refused or retried
      # above (errexit on a step nobody foresaw) is retried too, instead of
      # leaving a non-zero status that a switch would count.
      # shellcheck disable=SC2329 # invoked by the EXIT trap
      catch_all() {
        status=$?
        if [ "$status" -ne 0 ] && [ "$status" -ne ${toString refusedStatus} ]; then
          trap - EXIT
          retry "setup failed unexpectedly (status $status)"
        fi
      }
      trap catch_all EXIT

      # Clone only into an absent checkout, and make it appear whole: a clone
      # cut short must not leave a directory that later counts as present.
      if [ ! -e "$checkout" ]; then
        if [ -e "$partial" ]; then
          stale="$partial.$(date +%s)"
          mv -- "$partial" "$stale"
          say "moved an interrupted clone aside to $stale; delete it when convenient"
        fi
        say "cloning $repository ($branch) into $checkout"
        # Git has no transfer timeout of its own: a connection that stalls
        # after it is made (the handshake is bounded by curl's connect
        # timeout) would hold the clone, and the unit, forever. Under 1 KB/s
        # for a minute counts as stalled, and the clone is retried.
        interruptible git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
          clone --quiet --branch "$branch" -- "$repository" "$partial" || retry "clone failed"
        # -T: a $checkout the operator put back meanwhile is theirs. Without
        # it the clone would land inside it; with it the move fails, and the
        # next start runs what is there.
        mv -T -- "$partial" "$checkout" \
          || retry "$checkout appeared while cloning; the clone stays at $partial"
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
        # npm ci replaces node_modules, so it needs every directory in it.
        # npm run there as the operator (umask 022) leaves some it cannot
        # write, and no retry fixes that.
        if [ -d node_modules ]; then
          foreign=$(find node_modules -type d ! -writable -print -quit 2>/dev/null) || true
          if [ -n "$foreign" ]; then
            refuse "$scripts/$foreign is not writable by lighting-port, so npm ci cannot replace node_modules; give it back with: sudo chown -R lighting-port:lighting-port $scripts/node_modules"
          fi
        fi
        say "running npm ci"
        # No lifecycle scripts: this process can read the Home Assistant
        # token and reach the network. The port's dependencies have none.
        interruptible npm ci --ignore-scripts --no-audit --no-fund || retry "npm ci failed"
        printf '%s\n' "$lock_hash" > "$stamp"
      fi

      # Created by the unit, so it is group-writable whatever the operator's
      # umask, and the port can always write its journal next to the catalog.
      # Before any refusal: the first start refuses for the missing env file,
      # and the operator drops the catalog in here before writing that file.
      mkdir -p .runtime
      # Setup got through, so the count of its failures starts over.
      printf '0\n' > "$failures_file"

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
      if [ ! -f "$catalog" ]; then
        refuse "$scripts/$catalog does not exist"
      fi
      # A catalog copied in by the operator follows their umask and mode.
      if [ ! -r "$catalog" ]; then
        refuse "$scripts/$catalog is not readable by lighting-port; give it to the group with: chgrp lighting-port $scripts/$catalog && chmod g+r $scripts/$catalog"
      fi

      say "starting the watcher for live rooms '$LIVE_ROOMS'"
      # Its own process group, so a stop can reach the watcher and the host
      # it runs together.
      setsid node scripts/dev.mjs --live --config "$catalog" --live-rooms "$LIVE_ROOMS" &
      watcher=$!
      started=$(date +%s)
      # Once the watcher has run stable_seconds, a run of failed starts, if
      # there was one, is over, and its count starts over while the watcher
      # still runs: a power cut after a long run leaves no old count behind.
      sleep "$stable_seconds" &
      settling=$!

      # Waits up to the grace for the watcher's process group (the watcher,
      # the host it runs, a compile) to end, then kills whatever is left.
      # end_group <what is waited for>
      end_group() {
        for _ in $(seq $((stop_grace_seconds * 2))); do
          if ! kill -0 -- "-$watcher" 2>/dev/null; then return 0; fi
          sleep 0.5
        done
        say "$1 still running ''${stop_grace_seconds}s after stop; killing it"
        kill -KILL -- "-$watcher" 2>/dev/null || true
      }

      # The stop goes to the watcher alone, which passes it on to the host it
      # runs: the host handles one SIGTERM, and a second one (as every
      # process of the unit would get from systemd) kills it halfway through
      # its shutdown. A host whose shutdown hangs (Home Assistant
      # unreachable) would outlive TimeoutStopSec, be killed by systemd, and
      # leave the unit failed, which a switch counts. So it is killed here
      # first, and the stop stays clean.
      # shellcheck disable=SC2329 # invoked by the TERM/INT trap
      stop_watcher() {
        kill -TERM -- "$watcher" 2>/dev/null || true
        end_group watcher
        exit 0
      }
      trap stop_watcher TERM INT

      status=0
      ended=
      wait -n -p ended "$watcher" "$settling" || status=$?
      if [ "$ended" = "$settling" ]; then
        printf '0\n' > "$exits_file" || true
        status=0
        wait "$watcher" || status=$?
      else
        kill "$settling" 2>/dev/null || true
      fi

      # The watcher can die alone (killed for memory, an fs.watch error) and
      # leave its host running: unsupervised through the backoff, then killed
      # outright when this script exits. It gets its one SIGTERM here
      # instead, and its shutdown. A stop meanwhile waits for that shutdown
      # (within the same grace), then ends the script.
      stopping=no
      trap 'stopping=yes' TERM INT
      if kill -0 -- "-$watcher" 2>/dev/null; then
        say "the watcher exited and left its host running; stopping it"
        kill -TERM -- "-$watcher" 2>/dev/null || true
        end_group "the watcher's host"
      fi
      if [ "$stopping" = yes ]; then exit 0; fi
      # From here a stop has nothing to pass on.
      trap 'exit 0' TERM INT

      # The port exits on what only the operator can fix (a room in
      # LIVE_ROOMS the house does not have, a catalog it refuses, a revoked
      # token) as it does on a crash, and says which above; the unit cannot
      # tell them apart. Either way a port that exits again right after each
      # start backs off, instead of restarting, and recompiling, every 10 s.
      back_off "$exits_file" "watcher exit" \
        "watcher exited with status $status after $(($(date +%s) - started))s"
    '';
  };

  # The follower asks for a restart of the unit by touching this file, and
  # its root part restarts the unit when the file is newer than the unit's
  # current start. A run cut off between the two is caught up by the next.
  restartRequest = "${stateDir}/.follow-restart";
  # `owed` from the run that found a restart needed until a checkout got
  # through and the restart was asked for (`asked`).
  restartOwed = "${stateDir}/.follow-restart-owed";
  # The package-lock.json hash a restart was last asked for, so a lock that
  # npm ci fails on (and leaves the old stamp) is not restarted every minute
  # past the unit's own backoff.
  lockRequested = "${stateDir}/.follow-lock-requested";
  # Bounds the fetch.
  fetchTimeoutSeconds = 120;
  # Bounds the whole run, fetch included, so the script ends it, exiting 0,
  # well before the follower's TimeoutStartSec would leave it failed.
  runTimeoutSeconds = 150;
  # A git lock this old outlived any run (and any git someone runs by hand):
  # it was left by a run killed outright, and would fail every later one.
  staleLockMinutes = 5;

  # As lighting-port: brings the checkout to origin's branch and decides
  # whether the unit needs a restart. Git runs as the user that owns the
  # checkout and can write its .git/config, never as root.
  follow = pkgs.writeShellApplication {
    name = "lighting-port-follow";
    runtimeInputs = [ pkgs.coreutils pkgs.findutils pkgs.git ];
    text = ''
      run_seconds=${toString runTimeoutSeconds}
      branch=${lib.escapeShellArg cfg.branch}
      checkout=${checkout}
      lock=${scriptsDir}/package-lock.json
      stamp=${scriptsDir}/node_modules/.lighting-port-lock.sha256
      restart_request=${restartRequest}
      restart_owed=${restartOwed}
      lock_requested=${lockRequested}
      stale_locks=${stateDir}/.stale-git-locks

      say() { printf 'lighting-port-follow: %s\n' "$*" >&2; }
      request_restart() {
        say "$1; asking for a restart of lighting-port.service"
        touch -- "$restart_request"
      }

      # Never failed, so the timer tries again next minute and no switch
      # counts it: a stop exits 0, and so does anything that fails.
      trap 'exit 0' TERM INT
      interruptible() { "$@" & wait "$!"; }

      # The whole run is bounded: this script runs itself again under
      # timeout, which stops it after run_seconds. A run systemd had to time
      # out would be left failed. Accepted: the fetch's own timeout runs in
      # its own process group, so this TERM misses it and the fetch lives
      # until systemd cleans the unit's cgroup; the unit still ends in
      # success.
      if [ "''${1-}" != --bounded ]; then
        status=0
        interruptible timeout --kill-after=10 "$run_seconds" "$0" --bounded || status=$?
        if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
          say "the run took longer than ''${run_seconds}s; stopped it, trying again next minute"
        fi
        exit 0
      fi

      # shellcheck disable=SC2329 # invoked by the EXIT trap
      catch_all() {
        status=$?
        trap - EXIT
        if [ "$status" -ne 0 ]; then
          say "failed unexpectedly (status $status); trying again next minute"
        fi
        exit 0
      }
      trap catch_all EXIT

      # lighting-port.service clones the checkout, and moves it into place
      # whole.
      if [ ! -d "$checkout/.git" ]; then
        say "no checkout at $checkout yet; lighting-port.service clones it"
        exit 0
      fi
      cd "$checkout"

      # A request dated in the future (a clock stepped back) would never be
      # older than a start, and restart the unit every minute. Accepted: a
      # clock that steps back right after a real request loses that one
      # restart, rather than looping.
      if [ -f "$restart_request" ] && [ "$(stat -c %Y -- "$restart_request")" -gt "$(date +%s)" ]; then
        say "the restart request was dated in the future; setting it back"
        touch -d @0 -- "$restart_request"
      fi

      # A lock git left when it was killed outright (a power cut, SIGKILL)
      # fails every later run. Git removes its locks on any other exit, and
      # no run lasts staleLockMinutes, so an older one is moved aside.
      while IFS= read -r -d "" stale; do
        mkdir -p -- "$stale_locks"
        relative=''${stale#.git/}
        mv -- "$stale" "$stale_locks/$(date +%s)-''${relative//\//_}"
        say "moved a stale git lock aside: $stale (into $stale_locks)"
      done < <(find .git -name '*.lock' -type f -mmin +${toString staleLockMinutes} -print0)

      # No automatic maintenance: a fetch would start it detached, and the
      # end of this oneshot kills it, every run. It runs at the end instead.
      if ! interruptible timeout ${toString fetchTimeoutSeconds} \
        git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
          fetch --quiet --no-tags --no-auto-maintenance \
          origin "+refs/heads/$branch:refs/remotes/origin/$branch"; then
        # Exit status 2: origin answered, and has no such branch.
        gone=0
        interruptible timeout 60 git ls-remote --quiet --exit-code --heads origin "refs/heads/$branch" \
          > /dev/null || gone=$?
        if [ "$gone" -eq 2 ]; then
          say "branch $branch no longer exists on origin; the checkout stays as it is until services.lighting-port.branch names a branch that does"
        else
          say "fetching $branch from origin failed; trying again next minute"
        fi
        exit 0
      fi
      target=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}")
      head=$(git rev-parse --verify --quiet 'HEAD^{commit}') || head=
      on=$(git symbolic-ref --quiet --short HEAD) || on=
      edited=
      if [ -n "$head" ]; then
        edited=$(git diff --name-only HEAD --)
      fi

      if [ "$head" != "$target" ] || [ "$on" != "$branch" ] || [ -n "$edited" ]; then
        if [ -n "$edited" ]; then
          say "discarding local edits to: $(printf '%s\n' "$edited" | paste -sd ' ')"
        fi
        # The watcher sees only src/. Without a stamp an install is running
        # (npm ci empties node_modules first), and the unit starts the
        # watcher from what is here once it is done. The restart is owed
        # here and asked for below, once the checkout got through.
        if [ -f "$stamp" ] \
          && ! git diff --quiet "$target" -- lighting-scripts ':(exclude)lighting-scripts/src'; then
          printf 'owed\n' > "$restart_owed"
        fi
        say "updating $checkout to $target ($branch); it was at ''${head:-no commit} (''${on:-no branch})"
        # A checkout that fails (a directory it cannot write, a git lock,
        # a full disk) ends the run here, owing the restart: a restart now
        # would start the unit from a half-updated tree, every minute.
        git checkout --quiet --force -B "$branch" "refs/remotes/origin/$branch"
      fi

      # The checkout is whole. Asked for only now, so a unit that started
      # on its own before this (from half-updated files) is restarted too;
      # owed until asked for, so a run cut off before this is caught up by
      # the next. Not while an install runs (no stamp): the unit may have
      # started on its own from a checkout that failed half way, and a
      # restart would kill its npm ci. It stays owed until the stamp is back.
      owed=$(cat -- "$restart_owed" 2>/dev/null) || owed=
      if [ "$owed" = owed ] && [ -f "$stamp" ]; then
        request_restart "the update changes lighting-scripts outside src/"
        printf 'asked\n' > "$restart_owed"
      fi

      # The unit installs a package-lock.json at its start, and stamps it.
      if [ -f "$stamp" ] && [ -f "$lock" ]; then
        lock_hash=$(sha256sum -- "$lock" | cut -d' ' -f1)
        requested=$(cat -- "$lock_requested" 2>/dev/null) || requested=
        if [ "$(cat -- "$stamp")" != "$lock_hash" ] && [ "$requested" != "$lock_hash" ]; then
          request_restart "package-lock.json differs from what is installed"
          printf '%s\n' "$lock_hash" > "$lock_requested"
        fi
      fi

      # Git's own upkeep (packing loose objects once there are enough), in
      # the foreground and within the run's bound, when git finds it due.
      interruptible git -c maintenance.autoDetach=false -c gc.autoDetach=false \
        maintenance run --auto --quiet \
        || say "git maintenance failed (status $?); trying again next minute"
    '';
  };

  # As root, after the follow: restarts the unit if a restart was asked for
  # since it started. It reads only the request's age, never the checkout.
  restartForUpdate = pkgs.writeShellApplication {
    name = "lighting-port-follow-restart";
    runtimeInputs = [ pkgs.coreutils config.systemd.package ];
    text = ''
      say() { printf 'lighting-port-follow: %s\n' "$*" >&2; }
      trap 'exit 0' TERM INT
      # shellcheck disable=SC2329 # invoked by the EXIT trap
      catch_all() {
        status=$?
        trap - EXIT
        if [ "$status" -ne 0 ]; then
          say "restart check failed unexpectedly (status $status)"
        fi
        exit 0
      }
      trap catch_all EXIT

      if [ ! -f ${restartRequest} ]; then exit 0; fi
      # A unit that is not running starts from the checkout as it is.
      if ! systemctl is-active --quiet lighting-port.service; then exit 0; fi
      # Both in microseconds: a restart lands within the second it was asked
      # for, so seconds could not tell the request from the start it caused.
      requested=$(stat -c %.6Y -- ${restartRequest})
      requested=''${requested/./}
      # `t <microseconds>`, the time the unit's current process started.
      property=$(busctl get-property org.freedesktop.systemd1 \
        /org/freedesktop/systemd1/unit/lighting_2dport_2eservice \
        org.freedesktop.systemd1.Service ExecMainStartTimestamp)
      read -r kind started <<< "$property"
      if [ "$kind" != t ] || ! [[ "$started" =~ ^[0-9]+$ ]] || ! [[ "$requested" =~ ^[0-9]+$ ]]; then
        say "cannot tell whether lighting-port.service started after the update ($property); not restarting it"
        exit 0
      fi
      # lighting-port sets the request's time. One dated in the future would
      # be newer than every start, and restart the unit every minute.
      if [ "$requested" -gt "$(date +%s%6N)" ]; then
        say "ignoring a restart request dated in the future"
        exit 0
      fi
      if [ "$requested" -gt "$started" ]; then
        say "restarting lighting-port.service for the update"
        systemctl --no-block try-restart lighting-port.service
      fi
    '';
  };
in
{
  options.services.lighting-port = {
    enable = mkEnableOption "the lighting port, run by its dev watcher from a checkout that follows its branch";
    repository = mkOption {
      type = types.str;
      default = "https://github.com/jonathanmoregard/smarthome.git";
      description = "Repository cloned into ${checkout} when that directory is absent. The clone's origin is the one followed afterwards; changing this option does not re-point an existing checkout.";
    };
    branch = mkOption {
      type = types.str;
      default = "feature/typescript-lighting-scripts";
      description = "Branch the checkout follows: lighting-port-follow fetches it from origin every minute and forces the checkout to it, discarding local edits to tracked files. Changing it switches the checkout to the new branch on the next run.";
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
      description = "Users added to the lighting-port group, so they can write ${envFile} and the catalog in ${scriptsDir}/.runtime, and read the checkout, without sudo. The checkout itself is not edited on the server: the follower discards such edits.";
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

    # Git to look at the checkout with, as lighting-port. Deliberately no
    # safe.directory for it: lighting-port can write its .git/config, and a
    # config there (core.fsmonitor, hooks) runs commands as whoever runs git
    # in it, so no other user may trust it. The follower's root part runs no
    # git for the same reason.
    programs.git.enable = true;

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
        # spend most of that budget. The script kills a host still running
        # after ${toString stopGraceSeconds} s itself, so systemd's timeout
        # (which would leave the unit failed) is never reached. The journal is
        # written whole and renamed into place, so a kill cannot leave it
        # half-written.
        TimeoutStopSec = "${toString (stopGraceSeconds + 5)}s";
        # SIGTERM to the script only, which passes it to the watcher; the
        # rest of the unit is SIGKILLed once the script has exited. The
        # default (SIGTERM to every process) signals the host twice.
        KillMode = "mixed";
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

    # Keeps the checkout at the branch on origin. Wanted by nothing but its
    # timer, and never restarted by a switch, so a switch never waits on a
    # fetch; every run exits 0, so none is ever counted as failed.
    systemd.services.lighting-port-follow = {
      description = "Keep ${checkout} at ${cfg.branch} on origin";
      restartIfChanged = false;
      environment.HOME = stateDir;
      # A start limit, hit by runs in quick succession (by hand, besides the
      # timer), would leave the follower failed, which a switch counts.
      unitConfig.StartLimitIntervalSec = 0;
      serviceConfig = {
        Type = "oneshot";
        ExecStart = lib.getExe follow;
        # `+`: as root, outside the sandbox, for the restart alone.
        ExecStartPost = "+${lib.getExe restartForUpdate}";
        User = "lighting-port";
        Group = "lighting-port";
        # Above the run's own bound (plus timeout's 10 s grace to kill it)
        # and the restart check, so the script, not systemd, ends a long run.
        TimeoutStartSec = "${toString (runTimeoutSeconds + 30)}s";
        UMask = "0007";
        ProtectSystem = "strict";
        # Optional: before the main unit's first start it does not exist,
        # and the run has nothing to do.
        ReadWritePaths = [ "-${stateDir}" ];
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

    systemd.timers.lighting-port-follow = {
      description = "Keep the lighting port's checkout at its branch, every minute";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "minutely";
        AccuracySec = "1s";
        RandomizedDelaySec = "10s";
      };
    };
  };
}
