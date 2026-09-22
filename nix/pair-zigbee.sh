# Open Zigbee pairing on the home server for a bounded window.
#
# Reaches the server's loopback-only Mosquitto through an SSH-forwarded Unix
# socket, asks Zigbee2MQTT to permit joining, reports what joins, and asks it
# to stop permitting joins again on every exit path.

readonly base_topic=zigbee2mqtt
# zigbee-herdsman refuses permit-join windows longer than 254 seconds.
readonly max_seconds=254

# jq programs turning Zigbee2MQTT bridge events into plain sentences.
readonly describe_event='
  .data as $d
  | ($d.friendly_name // $d.ieee_address // "unknown device") as $name
  | if .type == "device_joined" then
      "New device joined: \($name). Identifying it..."
    elif .type == "device_interview" and $d.status == "successful" then
      if $d.supported then
        "Paired: \($d.definition.vendor) \($d.definition.model) - \($d.definition.description) (\($name))"
      else
        "Paired \($name), but Zigbee2MQTT does not support this model yet."
      end
    elif .type == "device_interview" and $d.status == "failed" then
      "Could not identify \($name). Switch it off and on again to retry."
    elif .type == "device_leave" then
      "Device left: \($name)"
    else
      empty
    end'
readonly describe_paired='
  (.data.definition // {}) as $def
  | "\($def.vendor // "Unknown vendor") \($def.model // "unknown model") (\(.data.friendly_name))"'

usage() {
  cat <<'EOF'
Usage: pair-zigbee [--host HOST] [--time SECONDS]

Opens Zigbee pairing on the home server so a new bulb, plug, remote or sensor
can join. Shows what joins, then closes pairing again when the time is up or
when you press Ctrl-C.

Options:
  -H, --host HOST     SSH destination (default: $SMARTHOME_HOST, else home-server)
  -t, --time SECONDS  how long pairing stays open, 1-254 (default: 180)
  -h, --help          show this help
EOF
}

usage_error() {
  printf 'pair-zigbee: %s\n\n' "$1" >&2
  usage >&2
  exit 64
}

fail() {
  printf 'pair-zigbee: %s\n' "$1" >&2
  exit "${2:-1}"
}

host=${SMARTHOME_HOST:-home-server}
seconds=180
while [ "$#" -gt 0 ]; do
  case $1 in
    -H | --host)
      [ "$#" -ge 2 ] || usage_error "$1 needs a value"
      host=$2
      shift 2
      ;;
    -t | --time)
      [ "$#" -ge 2 ] || usage_error "$1 needs a value"
      seconds=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

if ! [[ $seconds =~ ^[0-9]{1,3}$ ]] || ((10#$seconds < 1 || 10#$seconds > max_seconds)); then
  usage_error "--time must be a whole number of seconds from 1 to $max_seconds"
fi
seconds=$((10#$seconds))
# A leading dash would be parsed by ssh as an option, not a destination.
if [ -z "$host" ] || [[ $host == -* ]]; then
  usage_error "invalid host: '$host'"
fi

workdir=$(mktemp -d)
socket=$workdir/mqtt.sock
ssh_pid=
subscriber_pid=
pairing_open=0
paired=()

close_pairing() {
  [ -S "$socket" ] &&
    timeout 15 mosquitto_pub --unix "$socket" -q 1 \
      -t "$base_topic/bridge/request/permit_join" -m '{"time":0}' 2>/dev/null
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$pairing_open" = 1 ]; then
    if close_pairing; then
      echo "Pairing closed."
    else
      echo "Could not reach $host to close pairing; it closes by itself when the window ends." >&2
    fi
  fi
  if [ -n "$subscriber_pid" ]; then kill "$subscriber_pid" 2>/dev/null || true; fi
  if [ -n "$ssh_pid" ]; then kill "$ssh_pid" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Background jobs of a non-interactive shell ignore SIGINT, so the tunnel
# survives the terminal's Ctrl-C long enough for cleanup to close pairing.
# Prompts (host key, passphrase) still reach the terminal through /dev/tty.
echo "Connecting to $host..."
ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=10 \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=3 \
  -L "$socket:127.0.0.1:1883" \
  -- "$host" 2>"$workdir/ssh.log" &
ssh_pid=$!
while [ ! -S "$socket" ]; do
  if ! kill -0 "$ssh_pid" 2>/dev/null; then
    reason=$(tail -n 3 "$workdir/ssh.log")
    fail "could not connect to $host over SSH${reason:+: $reason}" 69
  fi
  sleep 0.2
done

# One subscriber for everything. The retained bridge state arrives right after
# the subscription is acknowledged, so reading it proves nothing published
# later can be missed.
mkfifo "$workdir/bridge"
mosquitto_sub --unix "$socket" -q 1 -F '%t %p' \
  -t "$base_topic/bridge/state" \
  -t "$base_topic/bridge/event" \
  -t "$base_topic/bridge/response/permit_join" \
  >"$workdir/bridge" 2>"$workdir/mosquitto.log" &
subscriber_pid=$!
exec 3<"$workdir/bridge"

# Reads one message into $topic and $payload. Returns 0 for a message, 1 when
# the timeout passes, and 2 when the subscriber has gone away.
next_message() {
  local line status=0
  IFS= read -r -t "$1" -u 3 line || status=$?
  if [ "$status" -eq 0 ]; then
    topic=${line%% *}
    payload=${line#* }
    return 0
  fi
  if [ "$status" -gt 128 ]; then
    return 1
  fi
  return 2
}

bridge_state() {
  jq -r '.state // "unknown"' <<<"$payload" 2>/dev/null || echo unknown
}

handle_message() {
  case $topic in
    "$base_topic/bridge/state")
      [ "$(bridge_state)" = online ] || fail "Zigbee2MQTT on $host went offline" 1
      ;;
    "$base_topic/bridge/event")
      local line
      line=$(jq -r "$describe_event" <<<"$payload" 2>/dev/null || true)
      if [ -n "$line" ]; then echo "$line"; fi
      if jq -e '.type == "device_interview" and .data.status == "successful"' \
        <<<"$payload" >/dev/null 2>&1; then
        paired+=("$(jq -r "$describe_paired" <<<"$payload")")
      fi
      ;;
  esac
}

state=
deadline=$((SECONDS + 5))
while [ -z "$state" ] && [ "$SECONDS" -lt "$deadline" ]; do
  status=0
  next_message 1 || status=$?
  case $status in
    0) if [ "$topic" = "$base_topic/bridge/state" ]; then state=$(bridge_state); fi ;;
    2) fail "lost the connection to $host" 1 ;;
  esac
done
if [ "$state" != online ]; then
  fail "Zigbee2MQTT is not running on $host (bridge state: ${state:-never reported})" 69
fi

transaction="pair-zigbee-$$-$RANDOM"
request=$(jq -cn --argjson time "$seconds" --arg transaction "$transaction" \
  '{time: $time, transaction: $transaction}')
# Marked open before sending, so an interruption mid-send still closes it.
pairing_open=1
timeout 15 mosquitto_pub --unix "$socket" -q 1 \
  -t "$base_topic/bridge/request/permit_join" -m "$request" ||
  fail "could not send the pairing request to $host" 1

response=
deadline=$((SECONDS + 10))
while [ -z "$response" ] && [ "$SECONDS" -lt "$deadline" ]; do
  status=0
  next_message 1 || status=$?
  case $status in
    0)
      if [ "$topic" = "$base_topic/bridge/response/permit_join" ]; then
        if jq -e --arg transaction "$transaction" '.transaction == $transaction' \
          <<<"$payload" >/dev/null 2>&1; then
          response=$payload
        fi
      else
        handle_message
      fi
      ;;
    2) fail "lost contact with Zigbee2MQTT on $host" 1 ;;
  esac
done
[ -n "$response" ] || fail "Zigbee2MQTT on $host did not answer the pairing request" 1
if [ "$(jq -r '.status' <<<"$response")" != ok ]; then
  pairing_open=0
  fail "Zigbee2MQTT refused to open pairing: $(jq -r '.error // "no reason given"' <<<"$response")" 1
fi

echo "Pairing is open for $seconds seconds (until $(date -d "+$seconds seconds" +%H:%M:%S))."
echo "Power on the new device now, close to the server. A device that was paired"
echo "before must be reset first. Press Ctrl-C to stop early."
end=$((SECONDS + seconds))
while [ "$SECONDS" -lt "$end" ]; do
  kill -0 "$ssh_pid" 2>/dev/null || fail "lost the connection to $host" 1
  status=0
  next_message 1 || status=$?
  case $status in
    0) handle_message ;;
    2) fail "lost contact with Zigbee2MQTT on $host" 1 ;;
  esac
done

pairing_open=0
if close_pairing; then
  echo "Pairing closed."
else
  echo "Could not reach $host to close pairing; it closes by itself now that the window has ended." >&2
fi
if [ "${#paired[@]}" -eq 0 ]; then
  echo "No new device finished pairing. Reset the device and run pair-zigbee again."
else
  noun=devices
  if [ "${#paired[@]}" -eq 1 ]; then noun=device; fi
  echo "${#paired[@]} $noun paired:"
  printf '  %s\n' "${paired[@]}"
fi
