# List, inspect, identify, rename, remove and add devices on the home server.
#
# Zigbee2MQTT is the device registry: every change here is a Zigbee2MQTT
# bridge request, and house-automationd follows the retained device list.
# One SSH connection forwards two private Unix sockets: the server's
# loopback-only Mosquitto and house-automationd's loopback status listener.

readonly base_topic=zigbee2mqtt
readonly segment='[a-z0-9]([a-z0-9_-]{0,62}[a-z0-9])?'
# zigbee-herdsman refuses permit-join windows longer than 254 seconds.
readonly max_pairing_seconds=254

usage() {
  cat <<'EOF'
Usage: house [--host HOST] COMMAND [ARGUMENTS]

Commands:
  list                         every device: name, room, model, availability
  show NAME                    details, live state and circadian target
  identify NAME [--seconds S]  make a device flash for 1-30 s (default 10)
  rename OLD NEW               rename a device; a new floor/room moves it
  remove NAME [--force]        remove a device from the Zigbee network
  add [NEW] [--time S]         pair a device (1-254 s window, default 180)
                               and optionally name it NEW

NAME and OLD are a device's current name or its 0x... address. NEW is
floor/room/device in lowercase letters, digits, '-' and '_', for example
upper-floor/upper-hallway/lamp. Every light follows the circadian curve as
soon as it pairs; a name only places it in a room.

Options:
  -H, --host HOST  SSH destination (default: $SMARTHOME_HOST, else home-server)
  -h, --help       show this help
EOF
}

usage_error() {
  printf 'house: %s\n\n' "$1" >&2
  usage >&2
  exit 64
}

fail() {
  printf 'house: %s\n' "$1" >&2
  exit "${2:-1}"
}

valid_name() {
  local terminal=${1##*/}
  [[ $1 =~ ^$segment/$segment/$segment$ ]] &&
    ! [[ $terminal =~ ^(set|get|availability|left|right|[0-9]+)$ ]]
}

# True when $1 is a whole number of seconds from 1 to $2.
whole_seconds_in() {
  [[ $1 =~ ^[0-9]{1,3}$ ]] && ((10#$1 >= 1 && 10#$1 <= $2))
}

host=${SMARTHOME_HOST:-home-server}
health_port=${SMARTHOME_HEALTH_PORT:-9876}
while [ "$#" -gt 0 ]; do
  case $1 in
    -H | --host)
      [ "$#" -ge 2 ] || usage_error "$1 needs a value"
      host=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) usage_error "unknown option: $1" ;;
    *) break ;;
  esac
done
[ "$#" -gt 0 ] || usage_error "missing command"
command=$1
shift

name=
old=
seconds=
force=0
new_name_hint="new name must be floor/room/device, for example upper-floor/upper-hallway/lamp"
case $command in
  list)
    [ "$#" -eq 0 ] || usage_error "list takes no arguments"
    ;;
  show)
    [ "$#" -eq 1 ] || usage_error "show needs one device name"
    name=$1
    ;;
  identify)
    [ "$#" -ge 1 ] || usage_error "identify needs a device name"
    name=$1
    seconds=10
    shift
    while [ "$#" -gt 0 ]; do
      case $1 in
        -s | --seconds)
          [ "$#" -ge 2 ] || usage_error "$1 needs a value"
          seconds=$2
          shift 2
          ;;
        *) usage_error "unknown argument: $1" ;;
      esac
    done
    whole_seconds_in "$seconds" 30 || usage_error "--seconds must be a whole number from 1 to 30"
    ;;
  rename)
    [ "$#" -eq 2 ] || usage_error "rename needs the old and the new name"
    old=$1
    name=$2
    valid_name "$name" || usage_error "$new_name_hint"
    ;;
  remove)
    [ "$#" -ge 1 ] || usage_error "remove needs a device name"
    name=$1
    shift
    while [ "$#" -gt 0 ]; do
      case $1 in
        -f | --force)
          force=1
          shift
          ;;
        *) usage_error "unknown argument: $1" ;;
      esac
    done
    ;;
  add)
    seconds=180
    if [ "$#" -gt 0 ] && [[ $1 != -* ]]; then
      name=$1
      shift
      valid_name "$name" || usage_error "$new_name_hint"
    fi
    while [ "$#" -gt 0 ]; do
      case $1 in
        -t | --time)
          [ "$#" -ge 2 ] || usage_error "$1 needs a value"
          seconds=$2
          shift 2
          ;;
        *) usage_error "unknown argument: $1" ;;
      esac
    done
    whole_seconds_in "$seconds" "$max_pairing_seconds" ||
      usage_error "--time must be a whole number of seconds from 1 to $max_pairing_seconds"
    ;;
  *) usage_error "unknown command: $command" ;;
esac
if [ -n "$seconds" ]; then
  seconds=$((10#$seconds))
fi
# A leading dash would be parsed by ssh as an option, not a destination.
if [ -z "$host" ] || [[ $host == -* ]]; then
  usage_error "invalid host: '$host'"
fi
[[ $health_port =~ ^[0-9]{1,5}$ ]] || usage_error "SMARTHOME_HEALTH_PORT must be a port number"

workdir=$(mktemp -d)
mqtt_socket=$workdir/mqtt.sock
health_socket=$workdir/health.sock
devices=$workdir/devices.json
daemon=$workdir/daemon.json
daemon_reachable=0
bridge_error=
ssh_pid=
subscriber_pid=

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$subscriber_pid" ]; then kill "$subscriber_pid" 2>/dev/null || true; fi
  if [ -n "$ssh_pid" ]; then kill "$ssh_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

open_tunnel() {
  local reason
  echo "Connecting to $host..." >&2
  ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=10 \
    -o ServerAliveCountMax=3 \
    -L "$mqtt_socket:127.0.0.1:1883" \
    -L "$health_socket:127.0.0.1:$health_port" \
    -- "$host" 2>"$workdir/ssh.log" &
  ssh_pid=$!
  while [ ! -S "$mqtt_socket" ] || [ ! -S "$health_socket" ]; do
    if ! kill -0 "$ssh_pid" 2>/dev/null; then
      reason=$(tail -n 3 "$workdir/ssh.log")
      fail "could not connect to $host over SSH${reason:+: $reason}" 69
    fi
    sleep 0.2
  done
}

fetch_devices() {
  timeout 15 mosquitto_sub --unix "$mqtt_socket" -q 1 -C 1 -W 10 \
    -t "$base_topic/bridge/devices" >"$devices" 2>/dev/null || true
  jq -e 'type == "array"' "$devices" >/dev/null 2>&1 ||
    fail "Zigbee2MQTT on $host has not published its device list; is it running?" 69
}

fetch_daemon_devices() {
  if curl -fsS --max-time 5 --unix-socket "$health_socket" http://localhost/devices \
    >"$daemon" 2>/dev/null && jq -e 'type == "array"' "$daemon" >/dev/null 2>&1; then
    daemon_reachable=1
  else
    daemon_reachable=0
    echo '[]' >"$daemon"
  fi
}

# Prints the Zigbee2MQTT entry whose name or 0x address is $1.
device_entry() {
  jq -ce --arg name "$1" \
    'first(.[] | select(.type != "Coordinator")
      | select(.friendly_name == $name or .ieee_address == $name))' "$devices"
}

# Sends one Zigbee2MQTT bridge request. Returns 1 with $bridge_error set when
# Zigbee2MQTT answers with an error; exits when it cannot be reached.
bridge_request() {
  local path=$1 body=$2 wait_seconds=$3
  local transaction request line status topic payload response='' deadline
  transaction="house-$$-$RANDOM"
  request=$(jq -c --arg transaction "$transaction" '. + {transaction: $transaction}' <<<"$body")
  rm -f "$workdir/bridge"
  mkfifo "$workdir/bridge"
  mosquitto_sub --unix "$mqtt_socket" -q 1 -F %j \
    -t "$base_topic/bridge/state" \
    -t "$base_topic/bridge/response/$path" \
    >"$workdir/bridge" 2>/dev/null &
  subscriber_pid=$!
  exec 3<"$workdir/bridge"
  # The retained bridge state arrives after the subscription is acknowledged,
  # so the response to a request sent afterwards cannot be missed.
  IFS= read -r -t 10 -u 3 line || fail "Zigbee2MQTT on $host did not answer" 69
  [ "$(jq -r '.payload | fromjson? | .state // "unknown"' <<<"$line")" = online ] ||
    fail "Zigbee2MQTT is not running on $host" 69
  timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
    -t "$base_topic/bridge/request/$path" -m "$request" ||
    fail "could not send the $path request to $host" 1
  deadline=$((SECONDS + wait_seconds))
  while [ -z "$response" ] && [ "$SECONDS" -lt "$deadline" ]; do
    status=0
    IFS= read -r -t 1 -u 3 line || status=$?
    if [ "$status" -gt 128 ]; then continue; fi
    [ "$status" -eq 0 ] || fail "lost contact with Zigbee2MQTT on $host" 1
    topic=$(jq -r .topic <<<"$line")
    payload=$(jq -r .payload <<<"$line")
    if [ "$topic" = "$base_topic/bridge/response/$path" ] &&
      jq -e --arg t "$transaction" '.transaction == $t' <<<"$payload" >/dev/null 2>&1; then
      response=$payload
    fi
  done
  exec 3<&-
  kill "$subscriber_pid" 2>/dev/null || true
  wait "$subscriber_pid" 2>/dev/null || true
  subscriber_pid=
  [ -n "$response" ] || fail "Zigbee2MQTT on $host did not answer the $path request" 1
  if [ "$(jq -r .status <<<"$response")" != ok ]; then
    bridge_error=$(jq -r '.error // "no reason given"' <<<"$response")
    return 1
  fi
}

# Waits briefly until house-automationd reports the device under $1.
report_daemon_view() {
  local wanted=$1 entry deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    fetch_daemon_devices
    if entry=$(jq -ce --arg name "$wanted" 'first(.[] | select(.friendly_name == $name))' "$daemon"); then
      if jq -e .controlled <<<"$entry" >/dev/null; then
        echo "house-automationd controls it (owner: $(jq -r .owner <<<"$entry"))."
      else
        echo "house-automationd sees it but does not control it: $(jq -r .reason <<<"$entry")."
      fi
      return 0
    fi
    sleep 1
  done
  echo "house-automationd has not reported it yet; check with: house show $wanted" >&2
}

list_devices() {
  local names=() topics=() device
  mapfile -t names < <(jq -r '.[] | select(.type != "Coordinator") | .friendly_name' "$devices")
  if [ "${#names[@]}" -eq 0 ]; then
    echo "No devices are paired yet. Add one with: house add"
    return
  fi
  for device in "${names[@]}"; do
    topics+=(-t "$base_topic/$device/availability")
  done
  timeout 10 mosquitto_sub --unix "$mqtt_socket" -q 1 --retained-only -W 3 -F %j \
    "${topics[@]}" >"$workdir/availability" 2>/dev/null || true
  jq -n --arg prefix "$base_topic/" \
    '[inputs | {key: (.topic | ltrimstr($prefix) | rtrimstr("/availability")),
      value: ((.payload | fromjson? | .state?) // .payload)}] | from_entries' \
    "$workdir/availability" >"$workdir/availability.json"
  {
    printf 'NAME\tROOM\tMODEL\tAVAILABILITY\tCONTROL\n'
    jq -r --slurpfile daemon "$daemon" --slurpfile availability "$workdir/availability.json" \
      --argjson reachable "$daemon_reachable" '
      ($daemon[0] | map({key: .friendly_name, value: .}) | from_entries) as $reports
      | .[] | select(.type != "Coordinator")
      | . as $d | ($reports[$d.friendly_name] // null) as $r
      | [ $d.friendly_name,
          (if $r and $r.room then "\($r.floor)/\($r.room)" else "-" end),
          (if $d.definition then "\($d.definition.vendor) \($d.definition.model)" else "unknown" end),
          ($availability[0][$d.friendly_name] // "unknown"),
          (if $reachable == 0 then "house-automationd not reachable"
           elif $r == null then "not seen by house-automationd yet"
           elif $r.controlled then "controlled (\($r.owner))"
           else "not controlled: \($r.reason)" end)
        ] | @tsv' "$devices"
  } | column -t -s $'\t'
}

live_state() {
  local friendly=$1 line status topic payload ready=0 availability='' state=''
  local deadline=$((SECONDS + 10))
  rm -f "$workdir/live"
  mkfifo "$workdir/live"
  mosquitto_sub --unix "$mqtt_socket" -q 1 -F %j \
    -t "$base_topic/bridge/state" \
    -t "$base_topic/$friendly" \
    -t "$base_topic/$friendly/availability" \
    >"$workdir/live" 2>/dev/null &
  subscriber_pid=$!
  exec 4<"$workdir/live"
  while [ -z "$state" ] && [ "$SECONDS" -lt "$deadline" ]; do
    status=0
    IFS= read -r -t 1 -u 4 line || status=$?
    if [ "$status" -gt 128 ]; then continue; fi
    [ "$status" -eq 0 ] || break
    topic=$(jq -r .topic <<<"$line")
    payload=$(jq -r .payload <<<"$line")
    case $topic in
      "$base_topic/bridge/state")
        if [ "$ready" = 0 ]; then
          ready=1
          timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
            -t "$base_topic/$friendly/get" -m '{"state":""}' || true
        fi
        ;;
      "$base_topic/$friendly/availability")
        availability=$(jq -r '.state // empty' <<<"$payload" 2>/dev/null || echo "$payload")
        ;;
      "$base_topic/$friendly") state=$payload ;;
    esac
  done
  exec 4<&-
  kill "$subscriber_pid" 2>/dev/null || true
  wait "$subscriber_pid" 2>/dev/null || true
  subscriber_pid=
  echo "Availability:  ${availability:-unknown}"
  if [ -n "$state" ]; then
    echo "Live state:    $(jq -r '[.state // empty,
      (if .brightness then "brightness \(.brightness)/254" else empty end),
      (if .color_temp then "\(.color_temp) mired" else empty end)] | join(", ")' <<<"$state")"
  else
    echo "Live state:    no answer within 10 seconds"
  fi
}

show_device() {
  local entry friendly report
  entry=$(device_entry "$name") || fail "no device named $name on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  report=$(jq -c --arg name "$friendly" 'first(.[] | select(.friendly_name == $name)) // null' "$daemon")
  jq -r --argjson report "$report" --argjson reachable "$daemon_reachable" '
    "Name:          \(.friendly_name)",
    "Address:       \(.ieee_address)",
    "Model:         \(if .definition then "\(.definition.vendor) \(.definition.model) - \(.definition.description)" else "unknown" end)",
    "Room:          \(if $report and $report.room then "\($report.room) on \($report.floor)" else "none" end)",
    "Controlled:    \(if $reachable == 0 then "unknown (house-automationd not reachable)"
      elif $report == null then "not seen by house-automationd yet"
      elif $report.controlled then "yes, follows \($report.owner)"
      else "no: \($report.reason)" end)",
    (if $report and $report.note then "Note:          \($report.note)" else empty end),
    "Circadian:     \(if $report and $report.target then ($report.target
      | "\(if .on then "on" else "off" end)\(if .brightness_percent then ", \(.brightness_percent)%" else "" end)\(if .color_temperature_kelvin then ", \(.color_temperature_kelvin) K" else "" end)")
      else "no target" end)"
  ' <<<"$entry"
  live_state "$friendly"
}

identify_device() {
  local entry friendly effects stop
  entry=$(device_entry "$name") || fail "no device named $name on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  if jq -e '[.definition.exposes[]? | .. | objects | select(.name? == "identify")] | length > 0' \
    <<<"$entry" >/dev/null; then
    bridge_request device/options \
      "$(jq -cn --arg id "$friendly" --argjson seconds "$seconds" \
        '{id: $id, options: {identify_timeout: $seconds}}')" 15 ||
      fail "Zigbee2MQTT could not set the identify time for $friendly: $bridge_error" 1
    timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
      -t "$base_topic/$friendly/set" -m '{"identify":"identify"}' ||
      fail "could not reach $friendly" 1
    echo "$friendly is flashing for $seconds s."
    return
  fi
  effects=$(jq -c '[.definition.exposes[]? | .. | objects | select(.name? == "effect") | .values[]?]' <<<"$entry")
  jq -e 'index("breathe")' <<<"$effects" >/dev/null ||
    fail "$friendly cannot flash: it exposes neither identify nor a breathe effect" 1
  timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
    -t "$base_topic/$friendly/set" -m '{"effect":"breathe"}' ||
    fail "could not reach $friendly" 1
  echo "$friendly is breathing for $seconds s."
  sleep "$seconds"
  stop=$(jq -r 'if index("stop_effect") then "stop_effect"
    elif index("finish_effect") then "finish_effect" else empty end' <<<"$effects")
  if [ -n "$stop" ]; then
    timeout 15 mosquitto_pub --unix "$mqtt_socket" -q 1 \
      -t "$base_topic/$friendly/set" -m "{\"effect\":\"$stop\"}" || true
  fi
}

rename_device() {
  local entry friendly
  entry=$(device_entry "$old") || fail "no device named $old on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  if [ "$friendly" = "$name" ]; then
    echo "$friendly already has that name."
    return
  fi
  if device_entry "$name" >/dev/null; then fail "$name is already taken on $host" 1; fi
  bridge_request device/rename \
    "$(jq -cn --arg from "$friendly" --arg to "$name" '{from: $from, to: $to, homeassistant_rename: false}')" 30 ||
    fail "Zigbee2MQTT refused to rename $friendly: $bridge_error" 1
  echo "Renamed $friendly to $name."
  report_daemon_view "$name"
}

remove_device() {
  local entry friendly force_json=false
  entry=$(device_entry "$name") || fail "no device named $name on $host (see: house list)" 1
  friendly=$(jq -r .friendly_name <<<"$entry")
  if [ "$force" = 1 ]; then force_json=true; fi
  if ! bridge_request device/remove \
    "$(jq -cn --arg id "$friendly" --argjson force "$force_json" '{id: $id, force: $force, block: false}')" 90; then
    if [ "$force" = 0 ]; then
      fail "Zigbee2MQTT could not remove $friendly: $bridge_error. If the device is gone for good, run: house remove $friendly --force" 1
    fi
    fail "Zigbee2MQTT could not remove $friendly: $bridge_error" 1
  fi
  echo "Removed $friendly."
}

add_device() {
  local paired=$workdir/paired ieee status=0
  if [ -n "$name" ] && device_entry "$name" >/dev/null; then
    fail "$name is already taken on $host" 1
  fi
  : >"$paired"
  pair-zigbee --host "$host" --time "$seconds" --stop-after-first --paired-file "$paired" || status=$?
  ieee=$(head -n 1 "$paired")
  if [ -z "$ieee" ]; then
    [ "$status" -eq 0 ] || exit "$status"
    fail "nothing paired, so nothing was named" 1
  fi
  if [ -z "$name" ]; then
    echo "Paired $ieee. It follows the circadian curve now."
    echo "Name it with: house rename $ieee <floor/room/device>"
    report_daemon_view "$ieee"
    return
  fi
  bridge_request device/rename \
    "$(jq -cn --arg from "$ieee" --arg to "$name" '{from: $from, to: $to, homeassistant_rename: false}')" 30 ||
    fail "paired $ieee but could not name it: $bridge_error. Retry with: house rename $ieee $name" 1
  echo "Renamed $ieee to $name."
  report_daemon_view "$name"
}

open_tunnel
fetch_devices
case $command in
  list)
    fetch_daemon_devices
    list_devices
    ;;
  show)
    fetch_daemon_devices
    show_device
    ;;
  identify) identify_device ;;
  rename) rename_device ;;
  remove) remove_device ;;
  add) add_device ;;
esac
