# Atomic NixOS system-profile activation, health, and exact rollback contract.
{ pkgs, script }:

let
  system = name: pkgs.runCommand name { } ''
    mkdir -p "$out/bin"
    cat > "$out/bin/switch-to-configuration" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
printf 'switch ${name} %s\n' "$*" >> "$SWITCH_LOG"
[ "$#" -eq 1 ] && [ "$1" = switch ]
if [ "''${FAIL_SWITCH_PATH:-}" = "$(readlink -f "$(dirname "$0")/..")" ]; then
  exit 75
fi
ln -sfn "$(readlink -f "$(dirname "$0")/..")" "$CURRENT_SYSTEM"
EOF
    chmod +x "$out/bin/switch-to-configuration"
  '';
  v1 = system "system-v1";
  v2 = system "system-v2";
  unhealthy = system "system-unhealthy";
  v3 = system "system-v3";
  v4 = system "system-v4";
  legacy = system "system-legacy";
  legacyTimersOnly = system "system-legacy-timers-only";
in
pkgs.runCommand "system-activator-contract" {
  nativeBuildInputs = with pkgs; [ bash coreutils gnugrep gnused ];
} ''
  set -euo pipefail
  # A bare `! cmd` never trips set -e; refute fails when cmd succeeds.
  refute() { if "$@"; then echo "refuted command succeeded: $*" >&2; exit 1; fi; }
  state="$PWD/state" profile="$PWD/system" events="$PWD/events.log"
  mkdir -p "$PWD/bin"

  cat > "$PWD/bin/systemctl" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
printf 'systemctl %s\n' "$*" >> "$EVENTS"
running=$(readlink -f "$PROFILE" 2>/dev/null || true)
printf 'health %s %s\n' "$running" "$*" >> "$EVENTS"
case "$1" in
  reset-failed)
    [ "$#" -eq 3 ] && [ "$2" = -- ] && [ -n "$3" ] || {
      rm -f "$UNRELATED_FAILED"
      exit 64
    }
    rm -f "$START_LIMIT"
    # A real `systemctl reset-failed <unit>` clears that unit's failed state,
    # and with it the manager degradation the unit was causing. Modelling that
    # is what separates a failed unit the gate resets before it looks (a listed
    # health unit) from one it never touches (anything else), which the stub
    # previously could not express at all.
    [ "''${FAILED_HEALTH_UNIT:-}" != "$3" ] || rm -f "$FAILED_HEALTH_UNIT_MARKER"
    ;;
  is-failed)
    [ "$#" -eq 4 ] && [ "$2" = --quiet ] && [ "$3" = -- ] && [ -n "$4" ] || exit 64
    [ "''${NEVER_LOADED_UNIT:-}" != "$4" ]
    ;;
  is-system-running)
    # Any failed unit anywhere degrades the manager, so both markers answer
    # here -- the difference between them is only whether reset-failed above
    # clears them first.
    [ ! -e "$UNRELATED_FAILED" ] || exit 1
    [ ! -e "$FAILED_HEALTH_UNIT_MARKER" ] || exit 1
    ;;
  show)
    [ "$#" -eq 5 ] && [ "$3" = --value ] && [ "$4" = -- ] && [ -n "$5" ] || exit 64
    case "$2" in
      --property=LoadState)
        case "$5" in
          sshd.service|tailscaled.service|mosquitto.service|zigbee2mqtt.service)
            printf 'loaded\n'
            ;;
          system-deploy.timer)
            if [ "$running" = "$LEGACY" ] || [ "$running" = "$LEGACY_TIMERS_ONLY" ]; then
              printf 'not-found\n'
            else
              printf 'loaded\n'
            fi
            ;;
          smarthome-deploy.timer|nixos-deploy.timer)
            if [ "$running" = "$LEGACY" ] || [ "$running" = "$LEGACY_TIMERS_ONLY" ]; then
              printf 'loaded\n'
            else
              printf 'not-found\n'
            fi
            ;;
          *) exit 64 ;;
        esac
        ;;
      # Reverse dependencies answer whether the running system was trying to
      # start this unit at all. NixOS units are wanted by a target rather than
      # required by one, so RequiredBy is normally empty; a unit nothing pulls
      # in reports neither.
      --property=WantedBy|--property=RequiredBy)
        case "$5" in
          sshd.service|tailscaled.service|mosquitto.service|zigbee2mqtt.service) ;;
          system-deploy.timer|smarthome-deploy.timer|nixos-deploy.timer) ;;
          *) exit 64 ;;
        esac
        if [ "''${UNWANTED_UNIT:-}" = "$5" ] || [ "$2" = --property=RequiredBy ]; then
          printf '\n'
        else
          printf 'multi-user.target\n'
        fi
        ;;
      # A crash-looping unit is active at every probe but never twice in the
      # same activation, so each probe answers with a fresh timestamp.
      --property=ActiveEnterTimestampMonotonic)
        case "$5" in
          sshd.service|tailscaled.service|mosquitto.service|zigbee2mqtt.service) ;;
          system-deploy.timer|smarthome-deploy.timer|nixos-deploy.timer) ;;
          *) exit 64 ;;
        esac
        if [ "''${FLAPPING_UNIT:-}" = "$5" ] && [ "''${FLAPPING_PATH:-}" = "$running" ]; then
          flaps=0
          [ ! -s "$FLAP_COUNTER" ] || flaps=$(cat "$FLAP_COUNTER")
          flaps=$((flaps + 1))
          printf '%s\n' "$flaps" > "$FLAP_COUNTER"
          printf '%s\n' "$((1000000 + flaps * 250000))"
        else
          printf '1000000\n'
        fi
        ;;
      *) exit 64 ;;
    esac
    ;;
  is-active)
    [ "$#" -eq 4 ] && [ "$2" = --quiet ] && [ "$3" = -- ] && [ -n "$4" ] || exit 64
    [ "''${DOWN_UNIT:-}" != "$4" ] || exit 3
    if [ "$running" = "$UNHEALTHY" ] && [ "$4" = mosquitto.service ]; then
      exit 3
    fi
    case "$4" in
      sshd.service|tailscaled.service|mosquitto.service|zigbee2mqtt.service) ;;
      system-deploy.timer)
        [ "$running" != "$LEGACY" ] && [ "$running" != "$LEGACY_TIMERS_ONLY" ] || exit 3
        ;;
      smarthome-deploy.timer|nixos-deploy.timer)
        [ "$running" = "$LEGACY" ] || [ "$running" = "$LEGACY_TIMERS_ONLY" ] || exit 3
        ;;
      *) exit 3 ;;
    esac
    ;;
  *) exit 64 ;;
esac
EOF
  cat > "$PWD/bin/timeout" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
[ "$1" = --signal=KILL ] || exit 64
duration=$2 command=$3
shift 3
printf 'timeout %s %s %s\n' "$duration" "$command" "$*" >> "$EVENTS"
if [ "''${SIGNAL_DURING_SWITCH_PATH:-}" = "$(readlink -f "$(dirname "$command")/..")" ]; then
  kill -TERM "$PPID"
  touch "$RECOVERY_SIGNAL_SENT"
fi
if [ "''${TIMEOUT_PATH:-}" = "$(readlink -f "$(dirname "$command")/..")" ] && [ ! -e "$TIMEOUT_MARKER" ]; then
  touch "$TIMEOUT_MARKER"
  exit 124
fi
exec "$command" "$@"
EOF
  cat > "$PWD/bin/sleep" <<'EOF'
#!${pkgs.runtimeShell}
printf 'sleep %s\n' "$*" >> "$EVENTS"
exit 0
EOF
  cat > "$PWD/bin/mv" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
destination=''${!#}
if [ "$destination" = "$SUCCESS_MARKER" ]; then
  if [ "''${FAIL_SUCCESS_MARKER_MOVE:-0}" = 1 ]; then
    touch "$SUCCESS_MOVE_FAILURE_TRIGGERED"
    exit 75
  fi
  ${pkgs.coreutils}/bin/mv "$@"
  if [ "''${SIGNAL_AFTER_SUCCESS_MOVE:-0}" = 1 ]; then
    kill -TERM "$PPID"
    touch "$SUCCESS_MOVE_SIGNAL_SENT"
  fi
  exit 0
fi
exec ${pkgs.coreutils}/bin/mv "$@"
EOF
  cat > "$PWD/bin/nix-env" <<'EOF'
#!${pkgs.runtimeShell}
set -euo pipefail
[ "$1" = --profile ]
profile=$2 operation=$3
shift 3
printf 'nix-env %s' "$operation" >> "$EVENTS"
printf ' %s' "$@" >> "$EVENTS"
printf '\n' >> "$EVENTS"
case "$operation" in
  --set)
    generation=1
    [ ! -s "$GENERATIONS" ] || generation=$(( $(sort -n "$GENERATIONS" | tail -n1) + 1 ))
    ln -sfn "$1" "$profile-$generation-link"
    ln -sfn "$profile-$generation-link" "$profile"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    if [ "''${CRASH_AFTER_SET:-0}" = 1 ]; then
      kill -KILL "$PPID"
      exit 137
    fi
    ;;
  --list-generations)
    if [ "''${FAIL_LIST_GENERATIONS:-0}" = 1 ]; then exit 75; fi
    while read -r generation; do
      suffix=
      if [ "$(readlink "$profile" 2>/dev/null || true)" = "$profile-$generation-link" ]; then
        suffix=' (current)'
      fi
      printf '%s 2026-09-22%s\n' "$generation" "$suffix"
    done < "$GENERATIONS"
    true
    ;;
  --switch-generation)
    ln -sfn "$profile-$1-link" "$profile"
    ;;
  --delete-generations)
    [ "''${FAIL_DELETE_GENERATIONS:-0}" != 1 ] || exit 75
    for generation in "$@"; do rm -f "$profile-$generation-link"; done
    grep -vxF -f <(printf '%s\n' "$@") "$GENERATIONS" > "$GENERATIONS.tmp" || true
    mv "$GENERATIONS.tmp" "$GENERATIONS"
    ;;
  *) exit 64 ;;
esac
EOF
  chmod +x "$PWD/bin/systemctl" "$PWD/bin/timeout" "$PWD/bin/sleep" "$PWD/bin/mv" "$PWD/bin/nix-env"
  export PATH="$PWD/bin:$PATH"
  export PROFILE="$profile" GENERATIONS="$PWD/generations" EVENTS="$events"
  export CURRENT_SYSTEM="$PWD/current-system"
  export SWITCH_LOG="$events" START_LIMIT="$PWD/start-limit" UNHEALTHY=${unhealthy}
  export LEGACY=${legacy}
  export LEGACY_TIMERS_ONLY=${legacyTimersOnly}
  export TIMEOUT_MARKER="$PWD/timeout-once" SUCCESS_MARKER="$state/last-success"
  export UNRELATED_FAILED="$PWD/unrelated-failed"
  export FAILED_HEALTH_UNIT_MARKER="$PWD/failed-health-unit"
  export SUCCESS_MOVE_SIGNAL_SENT="$PWD/success-move-signal-sent"
  export SUCCESS_MOVE_FAILURE_TRIGGERED="$PWD/success-move-failure-triggered"
  export RECOVERY_SIGNAL_SENT="$PWD/recovery-signal-sent"
  export FLAP_COUNTER="$PWD/flap-counter"
  health_units=(sshd.service tailscaled.service mosquitto.service zigbee2mqtt.service)
  candidate_health_units=("''${health_units[@]}" system-deploy.timer)
  recovery_health_unit_groups=(system-deploy.timer,nixos-deploy.timer)
  candidate_health_args=()
  recovery_health_args=()
  for unit in "''${candidate_health_units[@]}"; do candidate_health_args+=(--unit "$unit"); done
  for unit in "''${health_units[@]}"; do recovery_health_args+=(--recovery-unit "$unit"); done
  for group in "''${recovery_health_unit_groups[@]}"; do
    recovery_health_args+=(--recovery-any-unit-group "$group")
  done
  # The probe window is an input to the activator, so the test states the window
  # it is asserting against instead of restating the script's default. Every
  # probe count below is derived from these two numbers.
  health_samples=6 health_stable=3
  recovery_health_args+=(--health-samples "$health_samples" --health-stable "$health_stable")
  health_args=("''${candidate_health_args[@]}" "''${recovery_health_args[@]}")

  if bash ${script} --recover "$state" "$profile" "$CURRENT_SYSTEM" \
      --recovery-unit '../bad.service' 2> "$PWD/invalid-recovery-unit.err"; then
    exit 1
  fi
  grep -qxF 'activate-system: invalid required recovery health unit' "$PWD/invalid-recovery-unit.err"
  if bash ${script} --recover "$state" "$profile" "$CURRENT_SYSTEM" \
      --recovery-any-unit-group 'system-deploy.timer,../bad.timer' 2> "$PWD/invalid-recovery-group.err"; then
    exit 1
  fi
  grep -qxF 'activate-system: invalid required health unit group' "$PWD/invalid-recovery-group.err"

  reset_observations() {
    : > "$EVENTS"
    rm -f "$TIMEOUT_MARKER" "$START_LIMIT" "$UNRELATED_FAILED" "$SUCCESS_MOVE_SIGNAL_SENT" "$SUCCESS_MOVE_FAILURE_TRIGGERED" "$RECOVERY_SIGNAL_SENT" "$FLAP_COUNTER" "$FAILED_HEALTH_UNIT_MARKER"
    unset FAIL_SWITCH_PATH TIMEOUT_PATH SIGNAL_DURING_SWITCH_PATH NEVER_LOADED_UNIT
    unset FLAPPING_UNIT FLAPPING_PATH DOWN_UNIT UNWANTED_UNIT FAILED_HEALTH_UNIT
    export FAIL_LIST_GENERATIONS=0 FAIL_DELETE_GENERATIONS=0
    export SIGNAL_AFTER_SUCCESS_MOVE=0 FAIL_SUCCESS_MARKER_MOVE=0
  }
  reset_fixture() {
    rm -rf "$state"
    rm -f "$profile" "$profile"-*-link "$GENERATIONS" "$CURRENT_SYSTEM"
    mkdir -p "$state"
    : > "$GENERATIONS"
    reset_observations
  }
  seed_generation() {
    generation=$1 path=$2 current=$3
    ln -sfn "$path" "$profile-$generation-link"
    printf '%s\n' "$generation" >> "$GENERATIONS"
    if [ "$current" = current ]; then
      ln -sfn "$profile-$generation-link" "$profile"
      ln -sfn "$path" "$CURRENT_SYSTEM"
    fi
  }
  seed_v1() {
    reset_fixture
    seed_generation 1 ${v1} current
    cat > "$state/last-success" <<EOF
rev=1111111111111111111111111111111111111111
path=${v1}
previous_path=none
previous_generation=none
EOF
  }
  seed_v2_with_history() {
    reset_fixture
    seed_generation 1 ${v1} stale
    seed_generation 2 ${v2} current
    cat > "$state/last-success" <<EOF
rev=2222222222222222222222222222222222222222
path=${v2}
previous_path=${v1}
previous_generation=1
EOF
  }
  seed_legacy() {
    reset_fixture
    seed_generation 1 ${legacy} current
    cat > "$state/last-success" <<EOF
rev=0000000000000000000000000000000000000000
path=${legacy}
previous_path=none
previous_generation=none
EOF
  }
  run() { bash ${script} "$1" "$2" "$state" "$profile" "$CURRENT_SYSTEM" "''${health_args[@]}"; }
  links() { find "$PWD" -maxdepth 1 -name 'system-*-link' | wc -l; }

  # A healthy candidate is switched, observed healthy for the sustained
  # window, committed atomically, and only then may old generations be pruned.
  reset_fixture
  export NEVER_LOADED_UNIT=system-deploy.timer
  run ${v1} 1111111111111111111111111111111111111111 || {
    echo 'structured all-of/any-of unit health contract is absent' >&2
    exit 1
  }
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qxF 'rev=1111111111111111111111111111111111111111' "$state/last-success"
  [ "$(grep -c '^systemctl is-system-running$' "$EVENTS")" -eq "$health_stable" ]
  # One probe per unit more than the window, because each unit is also sampled
  # once before the switch to establish whether it was already down.
  for unit in "''${candidate_health_units[@]}"; do
    [ "$(grep -c "^systemctl is-active --quiet -- $unit$" "$EVENTS")" -eq "$((health_stable + 1))" ]
  done
  # Every probe inside the window also asks which activation the unit is in,
  # which is what separates "stayed up" from "execed and respawned".
  for unit in "''${candidate_health_units[@]}"; do
    [ "$(grep -c "^systemctl show --property=ActiveEnterTimestampMonotonic --value -- $unit$" "$EVENTS")" -eq "$health_stable" ]
  done
  for unit in smarthome-deploy.timer nixos-deploy.timer; do
    refute grep -q "^systemctl is-active --quiet -- $unit$" "$EVENTS"
  done
  grep -qxF 'systemctl is-failed --quiet -- system-deploy.timer' "$EVENTS"
  refute grep -qxF 'systemctl reset-failed -- system-deploy.timer' "$EVENTS"
  if grep -qxF 'systemctl reset-failed' "$EVENTS"; then
    echo 'activation used bare reset-failed and masked unrelated failures' >&2
    exit 1
  fi
  health_line=$(grep -n '^systemctl is-system-running$' "$EVENTS" | tail -1 | cut -d: -f1)
  prune_line=$(grep -n '^nix-env --delete-generations' "$EVENTS" | cut -d: -f1 || true)
  [ -z "$prune_line" ] || [ "$prune_line" -gt "$health_line" ]

  # Resetting deployment start limits must not erase unrelated failure state;
  # global manager health therefore remains degraded and activation fails shut.
  seed_v1
  touch "$UNRELATED_FAILED"
  if run ${v2} 2222222222222222222222222222222222222222; then
    echo 'activation masked unrelated failed service state' >&2
    exit 1
  fi
  [ -e "$UNRELATED_FAILED" ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=incomplete' "$state/last-failure"
  [ -s "$state/pending-activation" ]

  # A deterministically unhealthy candidate restores the exact old generation,
  # re-runs old activation, proves recovery health, and is poison-eligible.
  seed_v1
  if run ${unhealthy} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  grep -qF 'switch system-v1 switch' "$EVENTS"
  [ "$(links)" -eq 1 ]
  # That same fixture is the regression case for the baseline rule below:
  # mosquitto is active before the switch and inactive after, so it must keep
  # failing the candidate. A baseline that exempted it would be vacuous.

  # A unit that answers is-active at every probe can still be crash-looping,
  # because systemd reports a Type=simple unit active the instant it execs --
  # before it has read a line of its configuration. Sampling is-active cannot
  # tell "stayed up" from "kept respawning"; the activation timestamp can.
  seed_v1
  export FLAPPING_UNIT=zigbee2mqtt.service FLAPPING_PATH=${v2}
  if run ${v2} 2222222222222222222222222222222222222222; then
    echo 'candidate health accepted a unit that restarted inside the window' >&2
    exit 1
  fi
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ "$(readlink -f "$profile")" = ${v1} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v1} ]
  unset FLAPPING_UNIT FLAPPING_PATH

  # A unit that was already down before the switch is not this deploy's doing.
  # Failing the candidate for it means any unrelated outage blocks every later
  # deploy until a human clears it -- and zigbee2mqtt is BindsTo= its USB
  # coordinator, so "unrelated outage" includes an unplugged dongle.
  seed_v1
  export DOWN_UNIT=zigbee2mqtt.service
  run ${v2} 2222222222222222222222222222222222222222 || {
    echo 'a unit already down before the switch failed the candidate gate' >&2
    exit 1
  }
  [ "$(readlink -f "$profile")" = ${v2} ]
  grep -qxF 'rev=2222222222222222222222222222222222222222' "$state/last-success"
  unset DOWN_UNIT

  # The exemption above is about a unit that is *inactive*. One that is already
  # *failed* is a different shape and the gate meets it somewhere else entirely:
  # `systemctl is-system-running` reports degraded while any unit on the box is
  # failed, so a failed unit fails the candidate through manager health
  # regardless of what the per-unit baseline says about it.
  #
  # For a listed health unit that is survivable, and only because of ordering:
  # reset_health_units clears its failed state before the gate looks. That is
  # what makes the 2026-11-07 shape deployable -- a Zigbee2MQTT parked in failed
  # by its start limit is reset, and then exempted for staying down. Pinned
  # here because nothing else pins it: run the reset after the health check
  # instead of before and this is what fails.
  #
  # A failed unit that is *not* a listed health unit is deliberately not
  # survivable; see the unrelated-failure case above, which predates the
  # baseline rule and asserts the deploy fails shut. That gate is untouched.
  seed_v1
  export FAILED_HEALTH_UNIT=zigbee2mqtt.service DOWN_UNIT=zigbee2mqtt.service
  touch "$FAILED_HEALTH_UNIT_MARKER"
  run ${v2} 2222222222222222222222222222222222222222 || {
    echo 'a health unit already failed before the switch blocked the deploy' >&2
    exit 1
  }
  [ "$(readlink -f "$profile")" = ${v2} ]
  # The reset is the mechanism, so assert it happened rather than inferring it
  # from the deploy having landed.
  [ ! -e "$FAILED_HEALTH_UNIT_MARKER" ]
  unset FAILED_HEALTH_UNIT DOWN_UNIT

  # Being inactive beforehand is only an exemption if the running system was
  # trying to start the unit. A unit nothing wants or requires was not meant to
  # be up, and the candidate may be the very generation that enables it, so it
  # must still prove it starts. This is the legacy deploy-timer topology in
  # miniature: the unit file is installed, nothing pulls it in, and a candidate
  # that cannot bring it up has to fail. Neither LoadState nor UnitFileState
  # can draw that line -- the file exists either way, and a unit with no
  # [Install] section reads as static even when a target wants it.
  seed_v1
  export DOWN_UNIT=zigbee2mqtt.service UNWANTED_UNIT=zigbee2mqtt.service
  if run ${v2} 2222222222222222222222222222222222222222; then
    echo 'a unit nothing wanted was exempted from the candidate gate' >&2
    exit 1
  fi
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  [ "$(readlink -f "$profile")" = ${v1} ]
  unset DOWN_UNIT UNWANTED_UNIT

  # The same exemption applies to recovery health, or a rollback is reported
  # incomplete for a unit it was never going to bring back.
  seed_v1
  export DOWN_UNIT=zigbee2mqtt.service
  if run ${unhealthy} 3333333333333333333333333333333333333333; then exit 1; fi
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure" || {
    cat "$state/last-failure" >&2
    echo 'rollback reported incomplete for a unit that was down beforehand' >&2
    exit 1
  }
  [ ! -e "$state/pending-activation" ]
  unset DOWN_UNIT

  # A candidate cannot satisfy health with the legacy deploy timer name. Its
  # rollback may use that compatibility name to recover the pre-cutover system.
  seed_legacy
  if run ${legacyTimersOnly} 3333333333333333333333333333333333333333; then
    echo 'candidate accepted legacy timer names without standalone timers' >&2
    exit 1
  fi
  [ "$(readlink -f "$profile")" = ${legacy} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${legacy} ]
  grep -qxF 'reason=candidate-health-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure" || {
    cat "$state/last-failure" >&2
    echo 'legacy timer names did not satisfy rollback health' >&2
    exit 1
  }
  [ ! -e "$state/pending-activation" ]
  grep -qF 'health ${legacyTimersOnly} is-active --quiet -- system-deploy.timer' "$EVENTS"
  grep -qF 'health ${legacy} is-active --quiet -- nixos-deploy.timer' "$EVENTS"
  grep -qF 'systemctl show --property=LoadState --value -- system-deploy.timer' "$EVENTS"
  grep -qF 'systemctl show --property=LoadState --value -- nixos-deploy.timer' "$EVENTS"
  grep -qF 'systemctl reset-failed -- nixos-deploy.timer' "$EVENTS"
  refute grep -qF 'systemctl reset-failed -- system-deploy.timer' "$EVENTS"

  # A hard crash immediately after profile allocation leaves an atomic pending
  # journal. Recovery mode bypasses drift, restores the exact old generation,
  # reactivates it, proves its running-system link, and clears the journal.
  seed_v1
  export CRASH_AFTER_SET=1
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  unset CRASH_AFTER_SET
  [ -s "$state/pending-activation" ]
  [ "$(readlink -f "$profile")" = ${v2} ]
  export SIGNAL_DURING_SWITCH_PATH=${v1}
  bash ${script} --recover "$state" "$profile" "$CURRENT_SYSTEM" "''${recovery_health_args[@]}"
  unset SIGNAL_DURING_SWITCH_PATH
  [ -e "$RECOVERY_SIGNAL_SENT" ]
  [ "$(readlink -f "$profile")" = ${v1} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v1} ]
  [ ! -e "$state/pending-activation" ]
  [ "$(links)" -eq 1 ]

  # A profile/running-system mismatch is operator or boot drift and fails before
  # allocating a pending transaction or changing any generation.
  seed_v1
  ln -sfn ${v2} "$CURRENT_SYSTEM"
  if run ${v3} 4444444444444444444444444444444444444444 2> "$PWD/running-drift.err"; then exit 1; fi
  grep -qxF 'activate-system: active profile does not match running system' "$PWD/running-drift.err"
  [ ! -e "$state/pending-activation" ]
  [ "$(readlink -f "$profile")" = ${v1} ]
  [ "$(links)" -eq 1 ]

  # A finite candidate switch timeout is retryable, with exact healthy recovery.
  seed_v1
  export TIMEOUT_PATH=${v2}
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  grep -qxF 'reason=candidate-switch-timeout' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ "$(readlink -f "$profile")" = ${v1} ]
  grep -qF 'timeout 120s ${v2}/bin/switch-to-configuration switch' "$EVENTS"
  grep -qF 'switch system-v1 switch' "$EVENTS"

  # Start-limit exhaustion in the candidate switch still resets limits before
  # both activations and rolls back to the exact old generation.
  seed_v1
  touch "$START_LIMIT"
  export FAIL_SWITCH_PATH=${v2}
  if run ${v2} 2222222222222222222222222222222222222222; then exit 1; fi
  grep -qxF 'reason=candidate-switch-failed' "$state/last-failure"
  [ ! -e "$START_LIMIT" ]
  refute grep -qxF 'systemctl reset-failed' "$EVENTS"
  [ "$(grep -c '^systemctl reset-failed -- sshd.service$' "$EVENTS")" -eq 2 ]
  [ "$(readlink -f "$profile")" = ${v1} ]

  # Three stable activations retain current + previous only.
  reset_fixture
  run ${v1} 1111111111111111111111111111111111111111
  run ${v2} 2222222222222222222222222222222222222222
  run ${v3} 4444444444444444444444444444444444444444
  [ "$(readlink -f "$profile")" = ${v3} ]
  [ "$(links)" -eq 2 ]
  [ ! -e "$profile-1-link" ]

  # A signal immediately after atomic success rename cannot roll back committed
  # state; a failed rename must roll back and preserve the previous marker.
  seed_v1
  export SIGNAL_AFTER_SUCCESS_MOVE=1
  run ${v2} 2222222222222222222222222222222222222222
  [ -e "$SUCCESS_MOVE_SIGNAL_SENT" ]
  [ "$(readlink -f "$profile")" = ${v2} ]
  grep -qxF 'rev=2222222222222222222222222222222222222222' "$state/last-success"

  seed_v2_with_history
  success_before=$(cat "$state/last-success")
  export FAIL_SUCCESS_MARKER_MOVE=1
  if run ${v3} 4444444444444444444444444444444444444444; then exit 1; fi
  [ -e "$SUCCESS_MOVE_FAILURE_TRIGGERED" ]
  [ "$(readlink -f "$profile")" = ${v2} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v2} ]
  [ "$(cat "$state/last-success")" = "$success_before" ]
  grep -qxF 'reason=success-marker-failed' "$state/last-failure"
  grep -qxF 'rollback=complete' "$state/last-failure"
  [ ! -e "$profile-1-link" ]
  [ -e "$profile-2-link" ]
  [ ! -e "$profile-3-link" ]
  [ "$(links)" -eq 1 ]

  # Generation enumeration is fail-closed before any profile mutation.
  reset_fixture
  export FAIL_LIST_GENERATIONS=1
  if run ${v1} 1111111111111111111111111111111111111111 2> "$PWD/list.err"; then exit 1; fi
  grep -qxF 'activate-system: could not list profile generations' "$PWD/list.err"
  [ ! -e "$profile" ]

  # A first-install failure has no prior system whose health can be proven, so
  # rollback is incomplete and retains one recovery root. Retrying first removes
  # that orphan and therefore never grows the generation set without bound.
  reset_fixture
  for retry in 1 2 3; do
    if run ${unhealthy} 3333333333333333333333333333333333333333; then exit 1; fi
    [ ! -e "$profile" ]
    [ -e "$profile-1-link" ]
    [ "$(links)" -eq 1 ]
    [ "$(cat "$GENERATIONS")" = 1 ]
    grep -qxF 'rollback=incomplete' "$state/last-failure"
    reset_observations
  done

  # Journal recovery remains fail-closed when its orphan cannot be removed.
  export FAIL_DELETE_GENERATIONS=1
  if run ${unhealthy} 3333333333333333333333333333333333333333 2> "$PWD/delete.err"; then exit 1; fi
  grep -qxF 'activate-system: interrupted activation recovery failed' "$PWD/delete.err"
  [ ! -e "$profile" ]
  [ -s "$state/pending-activation" ]
  [ -e "$profile-1-link" ]
  [ "$(links)" -eq 1 ]
  refute grep -q '^nix-env --set ' "$EVENTS"

  # Without an auto-deploy journal, a newer non-current generation is a manual
  # rollback topology. Refuse it before deletion or candidate allocation.
  seed_v2_with_history
  seed_generation 3 ${v3} stale
  if run ${v4} 5555555555555555555555555555555555555555 2> "$PWD/manual-rollback.err"; then
    echo 'manual rollback topology was overwritten' >&2
    exit 1
  fi
  grep -qxF 'activate-system: active generation is older than newest generation; refusing manual rollback' "$PWD/manual-rollback.err"
  [ "$(readlink -f "$profile")" = ${v2} ]
  [ "$(readlink -f "$CURRENT_SYSTEM")" = ${v2} ]
  [ -e "$profile-1-link" ]
  [ -e "$profile-2-link" ]
  [ -e "$profile-3-link" ]
  [ "$(links)" -eq 3 ]
  [ ! -e "$state/pending-activation" ]
  refute grep -q '^nix-env --delete-generations' "$EVENTS"
  refute grep -q '^nix-env --set ' "$EVENTS"

  touch "$out"
''
