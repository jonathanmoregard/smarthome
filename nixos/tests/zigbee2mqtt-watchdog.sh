#!/usr/bin/env bash
# Contract for the Zigbee2MQTT watchdog: when it acts, when it refuses to, and
# that it cannot be goaded into fighting another owner of the unit.
set -euo pipefail

watchdog=$1
work=$(mktemp -d)
stubs=$work/bin
mkdir -p "$stubs"

# The stubs get the interpreter found at run time, not /usr/bin/env: a Nix build
# sandbox has no /usr/bin/env, so an env shebang leaves every stub unexecutable
# and the script under test silently takes its "cannot observe anything" paths.
bash_path=$(command -v bash)
emit_stub() {
  printf '#!%s\n' "$bash_path" > "$1"
  cat >> "$1"
  chmod +x "$1"
}

emit_stub "$stubs/systemctl" <<'STUB'
# Driven by ACTIVE_UNITS (space separated), UNIT_STATE and ACTION_LOG.
set -euo pipefail
last=${*: -1}
case "$1" in
  is-active)
    for unit in ${ACTIVE_UNITS:-}; do
      [ "$unit" = "$last" ] && exit 0
    done
    exit 3
    ;;
  show)
    # Per unit: the script asks about two of them and they are in unrelated
    # states. A deploy in flight is "activating" while the watched unit is
    # whatever the scenario says.
    case "$last" in
      system-deploy.service) printf '%s\n' "${DEPLOY_STATE:-inactive}" ;;
      *) printf '%s\n' "${UNIT_STATE:-active}" ;;
    esac
    ;;
  reset-failed) printf 'reset-failed %s\n' "$last" >> "$ACTION_LOG" ;;
  restart) printf 'restart %s\n' "$last" >> "$ACTION_LOG" ;;
  *) exit 64 ;;
esac
STUB

emit_stub "$stubs/mosquitto_sub" <<'STUB'
# An empty BRIDGE_PAYLOAD models the probe timing out with nothing published.
set -euo pipefail
[ -n "${BRIDGE_PAYLOAD:-}" ] || exit 27
printf '%s\n' "$BRIDGE_PAYLOAD"
STUB

# A stub that cannot run would make every scenario below pass for the wrong
# reason, so prove both are executable before relying on them.
"$stubs/systemctl" show --property=ActiveState --value -- probe.service > /dev/null
BRIDGE_PAYLOAD=online "$stubs/mosquitto_sub" > /dev/null

failures=0
check() {
  local name=$1 expected=$2 actual=$3
  if [ "$expected" = "$actual" ]; then
    printf '  PASS  %s\n' "$name"
  else
    printf '  FAIL  %s\n        expected %q\n        actual   %q\n' \
      "$name" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

# Every scenario gets a fresh state directory unless it is explicitly testing
# how the streak carries across ticks.
new_state() {
  local dir
  dir=$(mktemp -d "$work/state.XXXXXX")
  printf '%s' "$dir"
}

tick() {
  local state=$1
  ACTION_LOG=$state/actions.log
  export ACTION_LOG
  : > "$ACTION_LOG"
  STATE_DIRECTORY=$state PATH="$stubs:$PATH" \
    WATCHDOG_DEVICE_UNIT="${WATCHDOG_DEVICE_UNIT:-}" \
    bash "$watchdog" > "$state/out.log" 2>&1
}

actions() { tr '\n' ';' < "$1/actions.log"; }
counter() { cat "$2/consecutive-failures" 2>/dev/null || printf 'missing'; }

printf '\n1. a healthy bridge is left alone\n'
state=$(new_state)
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=online tick "$state"
check "no action taken" "" "$(actions "$state")"
check "streak cleared" "0" "$(counter x "$state")"

printf '\n2. an offline bridge waits for a second opinion before acting\n'
state=$(new_state)
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
check "no action on the first tick" "" "$(actions "$state")"
check "streak recorded" "1" "$(counter x "$state")"

printf '\n3. the second consecutive failure restarts the unit\n'
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
check "reset-failed then restart" \
  "reset-failed zigbee2mqtt.service;restart zigbee2mqtt.service;" "$(actions "$state")"
check "streak cleared after acting" "0" "$(counter x "$state")"

printf '\n4. a cooldown holds off a second restart\n'
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
check "no restart inside the cooldown" "" "$(actions "$state")"

printf '\n5. a cooldown that has expired allows acting again\n'
printf '%s' "$(( $(date +%s) - 4000 ))" > "$state/last-restart"
printf '1' > "$state/consecutive-failures"
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
check "restart after the cooldown" \
  "reset-failed zigbee2mqtt.service;restart zigbee2mqtt.service;" "$(actions "$state")"

printf '\n6. a probe that times out with nothing published counts as unhealthy\n'
state=$(new_state)
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD="" tick "$state"
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD="" tick "$state"
check "restart requested" \
  "reset-failed zigbee2mqtt.service;restart zigbee2mqtt.service;" "$(actions "$state")"

printf '\n7. a failed unit is unhealthy without needing the probe\n'
state=$(new_state)
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=failed BRIDGE_PAYLOAD=online tick "$state"
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=failed BRIDGE_PAYLOAD=online tick "$state"
check "restart requested despite an online payload" \
  "reset-failed zigbee2mqtt.service;restart zigbee2mqtt.service;" "$(actions "$state")"

printf '\n8. a deploy in progress is never fought\n'
# system-deploy.service is Type=oneshot with no RemainAfterExit, so while its
# ExecStart runs systemd reports ActiveState=activating and `systemctl is-active`
# exits non-zero. This scenario used to model the running deploy as is-active=
# active, which is a state systemd never puts it in, so a stand-down that could
# never fire looked tested. The states below are the whole "job in flight"
# class, so the check cannot pass by matching one literal string.
#
# Asserted after every tick, not once at the end: `tick` truncates the action
# log, so a trailing check alone sees only the last tick and would miss a
# restart fired on tick 2 -- which is exactly what a broken stand-down does.
for deploy_state in activating active deactivating reloading; do
  state=$(new_state)
  for tick_number in 1 2 3; do
    ACTIVE_UNITS="mosquitto.service" DEPLOY_STATE="$deploy_state" UNIT_STATE=failed \
      BRIDGE_PAYLOAD="" tick "$state"
    check "no action on tick $tick_number while the deploy is $deploy_state" \
      "" "$(actions "$state")"
  done
  check "streak cleared, not carried ($deploy_state)" "0" "$(counter x "$state")"
done

printf '\n9. with the broker down there is nothing to judge\n'
state=$(new_state)
for _ in 1 2 3; do
  ACTIVE_UNITS="" UNIT_STATE=failed BRIDGE_PAYLOAD="" tick "$state"
done
check "no action without the broker" "" "$(actions "$state")"

printf '\n10. an absent coordinator is the device unit'"'"'s job, not the watchdog'"'"'s\n'
state=$(new_state)
for _ in 1 2 3; do
  WATCHDOG_DEVICE_UNIT="dev-zigbee.device" ACTIVE_UNITS="mosquitto.service" \
    UNIT_STATE=failed BRIDGE_PAYLOAD="" tick "$state"
done
check "no action while the dongle is out" "" "$(actions "$state")"
unset WATCHDOG_DEVICE_UNIT

printf '\n11. a deliberately stopped unit is respected\n'
state=$(new_state)
for _ in 1 2 3; do
  ACTIVE_UNITS="mosquitto.service" UNIT_STATE=inactive BRIDGE_PAYLOAD="" tick "$state"
done
check "a stopped unit is not started" "" "$(actions "$state")"

printf '\n12. a unit mid-transition is left to settle\n'
state=$(new_state)
for _ in 1 2 3; do
  ACTIVE_UNITS="mosquitto.service" UNIT_STATE=activating BRIDGE_PAYLOAD="" tick "$state"
done
check "no action while activating" "" "$(actions "$state")"

printf '\n13. a blind tick clears the streak rather than carrying it\n'
#  Otherwise one real failure plus one unobservable period would be enough to
#  act, which is the thing the two-tick rule exists to prevent.
state=$(new_state)
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
check "streak at one" "1" "$(counter x "$state")"
ACTIVE_UNITS="mosquitto.service" DEPLOY_STATE=activating UNIT_STATE=active \
  BRIDGE_PAYLOAD=offline tick "$state"
check "streak cleared by the skip" "0" "$(counter x "$state")"
ACTIVE_UNITS="mosquitto.service" UNIT_STATE=active BRIDGE_PAYLOAD=offline tick "$state"
check "still no action" "" "$(actions "$state")"

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) FAILED\n' "$failures"
  exit 1
fi
printf '\nall watchdog contract checks passed\n'
