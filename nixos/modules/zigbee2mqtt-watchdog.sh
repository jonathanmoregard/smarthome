#!/usr/bin/env bash
# Restart Zigbee2MQTT when the bridge is not actually online.
#
# systemd can only see whether the process exists. Zigbee2MQTT is Type=simple,
# so "active" means "execed", and a Zigbee2MQTT that is running but not talking
# to the radio or the broker is indistinguishable from a working one at that
# level. That gap is how the house ends up with no Zigbee and nothing acting on
# it: the known causes are now repaired or recovered on their own (invalid
# persisted registries by the state guard, an unplugged coordinator by the
# service being wanted by its device unit), but any cause nobody predicted still
# leaves the radio down indefinitely.
#
# The authority on "working" is the bridge's own availability topic, which
# Zigbee2MQTT publishes retained and backs with an MQTT will, so the broker
# flips it to offline by itself if Zigbee2MQTT dies or its connection drops.
#
# Deliberately narrow about when it acts, because a watchdog that fights another
# owner of the unit is worse than no watchdog:
#
#   - a deploy in progress owns the unit; stand down
#   - the broker down means there is nothing to judge and nothing to fix here
#   - the coordinator absent means there is nothing to restart into; the device
#     unit brings the service back when it returns
#   - the unit stopped (inactive, not failed) was somebody's decision; respect it
#   - the unit mid-transition gets left to settle
#
# and it requires the failure on two consecutive ticks before acting, then holds
# a cooldown, so a transient blip costs nothing and a genuinely dead radio is
# retried slowly and forever rather than being given up on.

set -euo pipefail
umask 077

state_dir=${STATE_DIRECTORY:-/var/lib/zigbee2mqtt-watchdog}
unit=${WATCHDOG_UNIT:-zigbee2mqtt.service}
broker_unit=${WATCHDOG_BROKER_UNIT:-mosquitto.service}
deploy_unit=${WATCHDOG_DEPLOY_UNIT:-system-deploy.service}
device_unit=${WATCHDOG_DEVICE_UNIT:-}
broker_host=${WATCHDOG_BROKER_HOST:-127.0.0.1}
broker_port=${WATCHDOG_BROKER_PORT:-1883}
topic=${WATCHDOG_TOPIC:-zigbee2mqtt/bridge/state}
probe_seconds=${WATCHDOG_PROBE_SECONDS:-5}
needed_failures=${WATCHDOG_NEEDED_FAILURES:-2}
cooldown_seconds=${WATCHDOG_COOLDOWN_SECONDS:-600}

counter_file=$state_dir/consecutive-failures
stamp_file=$state_dir/last-restart

say() { printf 'zigbee2mqtt-watchdog: %s\n' "$*"; }

mkdir -p "$state_dir"

read_number() {
  local file=$1 value=0
  if [ -s "$file" ]; then
    value=$(cat "$file")
    [[ "$value" =~ ^[0-9]+$ ]] || value=0
  fi
  printf '%s' "$value"
}

# A skip is not a success: it means this tick had no opinion, so the failure
# streak is cleared rather than carried across a period the watchdog was blind.
skip() {
  say "$1"
  printf '0' > "$counter_file"
  exit 0
}

active() { systemctl is-active --quiet -- "$1"; }

active "$deploy_unit" && skip 'a deploy is in progress; standing down'
active "$broker_unit" || skip "$broker_unit is not active; nothing to judge"
if [ -n "$device_unit" ]; then
  active "$device_unit" ||
    skip 'the coordinator is not present; its device unit restarts the service when it returns'
fi

unit_state=$(systemctl show --property=ActiveState --value -- "$unit")
case "$unit_state" in
  inactive)
    skip 'the unit is stopped rather than broken; leaving it alone' ;;
  activating | deactivating | reloading)
    skip "the unit is $unit_state; letting it settle" ;;
esac

healthy=0
reason=
if [ "$unit_state" = failed ]; then
  reason='the unit is failed'
else
  # The retained value is what is wanted here: a healthy bridge publishes
  # nothing for hours, so insisting on a fresh message would call a working
  # radio broken. The broker's will message is what makes the retained value
  # trustworthy when Zigbee2MQTT dies.
  payload=$(timeout --signal=KILL "$((probe_seconds + 5))s" \
    mosquitto_sub -h "$broker_host" -p "$broker_port" -t "$topic" \
    -C 1 -W "$probe_seconds" 2>/dev/null || true)
  case "$payload" in
    *online*) healthy=1 ;;
    '') reason="no value published on $topic" ;;
    *) reason="$topic reports ${payload//[$'\n\r']/ }" ;;
  esac
fi

if [ "$healthy" = 1 ]; then
  printf '0' > "$counter_file"
  exit 0
fi

failures=$(( $(read_number "$counter_file") + 1 ))
printf '%s' "$failures" > "$counter_file"

if [ "$failures" -lt "$needed_failures" ]; then
  say "$reason; waiting for one more tick before acting ($failures/$needed_failures)"
  exit 0
fi

now=$(date +%s)
last=$(read_number "$stamp_file")
if [ "$last" -gt 0 ] && [ "$((now - last))" -lt "$cooldown_seconds" ]; then
  say "$reason; last restart was $((now - last))s ago, holding off until ${cooldown_seconds}s"
  exit 0
fi

say "$reason after $failures consecutive checks; restarting $unit"
# reset-failed first: without it a unit parked by its start-limit refuses to be
# restarted, which is precisely the "down and staying down" case this exists for.
systemctl reset-failed -- "$unit" || true
printf '%s' "$now" > "$stamp_file"
printf '0' > "$counter_file"
systemctl restart -- "$unit"
say "restart of $unit requested"
