#!/usr/bin/env bash
# Restart Zigbee2MQTT when the bridge is not actually online.
#
# systemd can only see whether the process exists. Zigbee2MQTT is Type=simple,
# so "active" means "execed", and a Zigbee2MQTT that is running but not talking
# to the radio or the broker is indistinguishable from a working one at that
# level. That gap is how the house ends up with no Zigbee and nothing acting on
# it: an unplugged coordinator now recovers on its own (the service is bound to
# its device unit and wanted by it, so an unplug stops it and a re-add starts
# it), but any cause nobody predicted still leaves the radio down indefinitely.
#
# The signal is the bridge's own availability topic, which Zigbee2MQTT
# publishes retained and backs with an MQTT will, so the broker flips it to
# offline by itself if Zigbee2MQTT dies or its connection drops.
#
# Be clear about what that proves: "online" means the process is alive and
# talking to the broker, not that the radio is passing traffic. The deaths the
# topic reports are mostly handled already by Restart=always, so the case this
# adds cover for is a narrow one -- Zigbee2MQTT still running with its broker
# connection dead or wedged, plus whatever else leaves the unit up and useless
# that nobody has thought of yet. Narrow is the honest claim for it.
#
# Deliberately narrow about when it acts, because a watchdog that fights another
# owner of the unit is worse than no watchdog:
#
#   - a deploy in progress owns the unit; stand down
#   - the broker down means there is nothing to judge and nothing to fix here
#   - the coordinator absent means there is nothing to restart into; the device
#     unit brings the service back when it returns
#   - the unit stopped (inactive, not failed) was somebody's decision; respect
#     it. This leans on the unit carrying Restart=always: under upstream's
#     Restart=on-failure, systemd.service(5) counts exit code 0 and
#     SIGHUP/SIGINT/SIGTERM/SIGPIPE as clean and does not restart, so a
#     Zigbee2MQTT that quietly exited 0 also sat in "inactive" and this skip
#     made the radio stay dead. With Restart=always, systemd restarts every
#     death it owns and leaves only deliberate stops inactive, so "inactive"
#     really does mean somebody meant it. If that ever reverts to on-failure,
#     this branch becomes a hole again.
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
state_of() { systemctl show --property=ActiveState --value -- "$1"; }

# `is-active` cannot see a deploy in flight. system-deploy.service is
# Type=oneshot with no RemainAfterExit, so while its ExecStart runs systemd
# reports ActiveState=activating and is-active exits non-zero; it reads
# "active" only for the instant a RemainAfterExit unit would hold. Keying the
# stand-down on is-active therefore meant it never fired, and the watchdog
# could restart Zigbee2MQTT underneath a deploy -- which the deploy's own
# health gate then reads as the new generation flapping, and rolls back. So
# the question is whether a job is in flight, and only a settled inactive or
# failed says no.
case "$(state_of "$deploy_unit")" in
  inactive | failed) ;;
  *) skip 'a deploy is in progress; standing down' ;;
esac
active "$broker_unit" || skip "$broker_unit is not active; nothing to judge"
if [ -n "$device_unit" ]; then
  active "$device_unit" ||
    skip 'the coordinator is not present; its device unit restarts the service when it returns'
fi

unit_state=$(state_of "$unit")
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
