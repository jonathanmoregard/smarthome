{
  pkgs,
  module,
  package,
}:

let
  fakePython = pkgs.python3.withPackages (pythonPackages: [ pythonPackages.paho-mqtt ]);
  fakeZigbee2mqtt = pkgs.writeShellScript "fake-zigbee2mqtt" ''
    exec ${fakePython}/bin/python3 - <<'PYTHON'
    from pathlib import Path

    import paho.mqtt.client as mqtt

    STATE_DIRECTORY = Path("/var/lib/fake-zigbee2mqtt")
    TRAFFIC = STATE_DIRECTORY / "traffic.tsv"
    READY = STATE_DIRECTORY / "ready"
    DEVICE_STATE = {
        "zigbee2mqtt/sim/living/lamp/get": (
            "zigbee2mqtt/sim/living/lamp",
            '{"state":"OFF","brightness":127,"color_temp":333}',
        ),
        "zigbee2mqtt/sim/hall/switch/get": (
            "zigbee2mqtt/sim/hall/switch",
            '{"state":"OFF"}',
        ),
    }

    traffic = TRAFFIC.open("a", buffering=1)

    def record(kind, topic, payload):
        traffic.write(f"{kind}\t{topic}\t{payload}\n")

    def on_connect(client, _userdata, _flags, _reason_code, _properties):
        client.subscribe("zigbee2mqtt/#", qos=1)
        client.publish(
            "zigbee2mqtt/sim/living/lamp/availability",
            "online",
            qos=1,
            retain=True,
        )
        client.publish(
            "zigbee2mqtt/sim/hall/switch/availability",
            "online",
            qos=1,
            retain=True,
        )

    def on_subscribe(_client, _userdata, _mid, _reason_codes, _properties):
        READY.touch()

    def on_message(client, _userdata, message):
        topic = message.topic
        payload = message.payload.decode("utf-8", errors="replace")
        if topic in DEVICE_STATE:
            record("GET", topic, payload)
            state_topic, state_payload = DEVICE_STATE[topic]
            client.publish(state_topic, state_payload, qos=1, retain=True)
        elif topic.endswith("/set") and topic in {
            "zigbee2mqtt/sim/living/lamp/set",
            "zigbee2mqtt/sim/hall/switch/set",
        }:
            record("SET", topic, payload)
            client.publish(topic.removesuffix("/set"), payload, qos=1, retain=True)

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="fake-zigbee2mqtt",
        protocol=mqtt.MQTTv311,
    )
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=2)
    client.connect_async("127.0.0.1", 1883, keepalive=10)
    client.loop_forever(retry_first_connection=True)
    PYTHON
  '';
in
pkgs.testers.runNixOSTest {
  name = "simulated-house";

  nodes.server =
    { lib, ... }:
    {
      imports = [ module ];

      time.timeZone = "Europe/Stockholm";
      services.timesyncd.enable = false;
      virtualisation = {
        cores = 2;
        memorySize = 1536;
      };

      services.mosquitto = {
        enable = true;
        persistence = true;
        listeners = [
          {
            address = "127.0.0.1";
            port = 1883;
            omitPasswordAuth = true;
            acl = [ "topic readwrite #" ];
            settings.allow_anonymous = true;
          }
        ];
      };

      services.houseAutomation = {
        enable = true;
        inherit package;
        settings = {
          schema_version = 1;
          mqtt = {
            host = "127.0.0.1";
            port = 1883;
            client_id = "simulated-house";
            application_namespace = "house/v1";
            zigbee2mqtt_base_topic = "zigbee2mqtt";
          };
          input = {
            double_click_window_ms = 300;
            ambiguous_center_hold_window_ms = 800;
          };
          circadian = {
            daily_reset_time = "04:00";
            unfreeze_convergence_seconds = 2.0;
            tick_seconds = 0.1;
            brightness_change_threshold = 0.01;
            color_temperature_change_threshold_kelvin = 20.0;
            maximum_refresh_seconds = 30.0;
          };
          acknowledgement = {
            overlay_id = "circadian-ack";
            amplitude = 0.10;
            duration_ms = 600;
            priority = 100;
          };
          whole_hour = {
            brightness_delta = 0.12;
            duration_ms = 400;
            priority = 10;
          };
          reconciliation = {
            retry_interval_seconds = 0.2;
            maximum_attempts = 5;
            dispatch_acceptance_margin_seconds = 1.0;
            dispatch_failure_backoff_seconds = 0.1;
          };
          health.bind = "127.0.0.1:9877";

          floors = [ { id = "ground-floor"; } ];
          rooms = [
            {
              id = "living-room";
              floor = "ground-floor";
            }
            {
              id = "hall";
              floor = "ground-floor";
            }
          ];
          curves = [
            {
              id = "simulated-day";
              anchors = [
                {
                  time = "04:00";
                  brightness = 0.20;
                  color_temperature_kelvin = 2400;
                }
                {
                  time = "13:00";
                  brightness = 0.50;
                  color_temperature_kelvin = 3500;
                }
                {
                  time = "23:00";
                  brightness = 0.30;
                  color_temperature_kelvin = 2700;
                }
              ];
            }
          ];
          scopes = [
            {
              id = "living-room-lights";
              kind = "room";
              room = "living-room";
              curve = "simulated-day";
            }
            {
              id = "hall-lights";
              kind = "room";
              room = "hall";
              curve = "simulated-day";
            }
            {
              id = "ground-floor-lights";
              kind = "floor";
              floor = "ground-floor";
              curve = "simulated-day";
            }
            {
              id = "whole-house";
              kind = "house";
              curve = "simulated-day";
            }
          ];
          devices = [
            {
              id = "living-lamp";
              friendly_name = "sim/living/lamp";
              room = "living-room";
              capabilities = {
                on_off = true;
                dimming = true;
                color_temperature = {
                  minimum_kelvin = 2200;
                  maximum_kelvin = 4000;
                  minimum_mired = 250;
                  maximum_mired = 454;
                };
              };
            }
            {
              id = "hall-switch";
              friendly_name = "sim/hall/switch";
              room = "hall";
              capabilities.on_off = true;
            }
          ];
          controls = [
            {
              id = "living-remote";
              friendly_name = "sim/living/remote";
              selected_scope = "living-room-lights";
              mappings = [
                {
                  gesture = "up";
                  target = "selected";
                  action = {
                    kind = "adjust_brightness_offset";
                    delta = 0.05;
                  };
                }
                {
                  gesture = "right";
                  target = "selected";
                  action = {
                    kind = "adjust_color_temperature_offset";
                    delta_kelvin = 200;
                  };
                }
                {
                  gesture = "center_single";
                  target = "selected";
                  action.kind = "toggle_power";
                }
                {
                  gesture = "center_double";
                  target = "selected";
                  action.kind = "toggle_circadian_with_acknowledgement";
                }
              ];
            }
            {
              id = "hall-remote";
              friendly_name = "sim/hall/remote";
              selected_scope = "hall-lights";
              mappings = [
                {
                  gesture = "center_single";
                  target = "selected";
                  action.kind = "toggle_power";
                }
                {
                  gesture = "center_double";
                  target = "selected";
                  action.kind = "toggle_circadian_with_acknowledgement";
                }
              ];
            }
          ];
        };
      };

      # Start after the deterministic wall clock is installed by the driver.
      systemd.services.house-automationd.wantedBy = lib.mkForce [ ];

      systemd.services.fake-zigbee2mqtt = {
        description = "MQTT-only simulated Zigbee2MQTT boundary";
        after = [ "mosquitto.service" ];
        serviceConfig = {
          ExecStart = fakeZigbee2mqtt;
          Restart = "always";
          RestartSec = "200ms";
          StateDirectory = "fake-zigbee2mqtt";
          StateDirectoryMode = "0700";
        };
      };

      environment.systemPackages = [
        pkgs.coreutils
        pkgs.curl
        pkgs.jq
        pkgs.mosquitto
        pkgs.sqlite
      ];
    };

  testScript = ''
    import json
    import shlex
    import time

    TRAFFIC = "/var/lib/fake-zigbee2mqtt/traffic.tsv"
    DATABASE = "/var/lib/house-automation/state.sqlite3"
    LAMP_SET = "zigbee2mqtt/sim/living/lamp/set"
    HALL_SET = "zigbee2mqtt/sim/hall/switch/set"
    RESET_FINAL_BRIGHTNESS = 76

    def q(value):
        return shlex.quote(str(value))

    def mqtt_publish(topic, payload, *, retain=False, qos=0):
        retained = " -r" if retain else ""
        server.succeed(
            "mosquitto_pub -h 127.0.0.1 -p 1883"
            + retained
            + f" -q {qos} -t {q(topic)} -m {q(payload)}"
        )

    def remote_action(remote, action):
        mqtt_publish(
            f"zigbee2mqtt/sim/{remote}/remote",
            json.dumps({"action": action}, separators=(",", ":")),
        )

    def remote_double(remote):
        topic = f"zigbee2mqtt/sim/{remote}/remote"
        payload = json.dumps({"action": "toggle"}, separators=(",", ":"))
        server.succeed(
            f"printf '%s\\n' {q(payload)} {q(payload)} | "
            f"mosquitto_pub -h 127.0.0.1 -p 1883 -q 0 -l -t {q(topic)}"
        )

    def records():
        raw = server.succeed(f"test -e {q(TRAFFIC)} && cat {q(TRAFFIC)} || true")
        parsed = []
        for line in raw.splitlines():
            parts = line.split("\t", 2)
            if len(parts) != 3:
                continue
            kind, topic, payload = parts
            try:
                value = json.loads(payload)
            except json.JSONDecodeError:
                value = payload
            parsed.append((kind, topic, value))
        return parsed

    def checkpoint():
        return len(records())

    def matching(after, kind, topic, predicate=lambda payload: True):
        return [
            payload
            for record_kind, record_topic, payload in records()[after:]
            if record_kind == kind and record_topic == topic and predicate(payload)
        ]

    def wait_for(after, kind, topic, predicate=lambda payload: True, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = matching(after, kind, topic, predicate)
            if found:
                return found[-1]
            time.sleep(0.1)
        raise Exception(
            f"timed out waiting for {kind} {topic}; records={records()[after:]}"
        )

    def assert_absent(after, kind, topic, predicate=lambda payload: True, duration=0.5):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            found = matching(after, kind, topic, predicate)
            assert not found, f"unexpected {kind} {topic}: {found}"
            time.sleep(0.05)

    def latest_number(topic, field):
        values = [
            payload[field]
            for kind, record_topic, payload in records()
            if kind == "SET"
            and record_topic == topic
            and isinstance(payload, dict)
            and field in payload
        ]
        assert values, f"no {field} command for {topic}"
        return values[-1]

    def sqlite_scalar(statement):
        return server.succeed(
            f"sqlite3 -readonly -noheader {q(DATABASE)} {q(statement)}"
        ).strip()

    def sql_literal(value):
        apostrophe = chr(39)
        return apostrophe + value.replace(apostrophe, apostrophe + apostrophe) + apostrophe

    def scope_mode(scope_key):
        return sqlite_scalar(
            "SELECT json_extract(payload_json, '$.data.curve_mode.mode') "
            f"FROM scope_state WHERE scope_key={sql_literal(scope_key)}"
        )

    start_all()
    server.wait_for_unit("mosquitto.service")
    server.succeed("date --set='2026-09-14 12:58:00'")
    server.succeed("systemctl start fake-zigbee2mqtt.service")
    server.wait_for_unit("fake-zigbee2mqtt.service")
    server.wait_until_succeeds("test -e /var/lib/fake-zigbee2mqtt/ready")

    # Prove the MQTT fake is subscribed before the production daemon starts.
    fake_ready = checkpoint()
    mqtt_publish("zigbee2mqtt/sim/living/lamp/get", "{}", qos=1)
    wait_for(fake_ready, "GET", "zigbee2mqtt/sim/living/lamp/get")

    mqtt_publish("zigbee2mqtt/bridge/state", "offline", retain=True, qos=1)
    server.succeed("systemctl start house-automationd.service")
    server.wait_for_unit("house-automationd.service")
    server.wait_until_succeeds(
        "test \"$(curl -sS -o /tmp/health.json -w '%{http_code}' "
        "http://127.0.0.1:9877/healthz)\" = 503"
    )
    server.succeed("jq -e '.database_migrated and .mqtt_connected and (.zigbee2mqtt_bridge_online | not)' /tmp/health.json")

    mqtt_publish("zigbee2mqtt/bridge/state", "online", retain=True, qos=1)
    server.wait_until_succeeds(
        "curl -fsS http://127.0.0.1:9877/healthz | "
        "jq -e '.ready and .database_migrated and .mqtt_connected and "
        ".zigbee2mqtt_bridge_online and .adapter_available'"
    )
    wait_for(0, "GET", "zigbee2mqtt/sim/living/lamp/get")
    wait_for(0, "GET", "zigbee2mqtt/sim/hall/switch/get")
    server.succeed(
        "test \"$(timeout 2 mosquitto_sub -h 127.0.0.1 -p 1883 -C 1 "
        "-t house/v1/status)\" = online"
    )

    # A single ambiguous center event must wait for its hold window, then turn on.
    single_mark = checkpoint()
    remote_action("living", "toggle")
    assert_absent(single_mark, "SET", LAMP_SET, duration=0.4)
    wait_for(
        single_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict) and payload.get("state") == "ON",
    )
    hall_on_mark = checkpoint()
    remote_action("hall", "toggle")
    wait_for(
        hall_on_mark,
        "SET",
        HALL_SET,
        lambda payload: isinstance(payload, dict) and payload.get("state") == "ON",
    )

    # Native input topics and daemon command topics are event streams, not retained state.
    server.fail(
        "timeout 1 mosquitto_sub -h 127.0.0.1 -p 1883 -C 1 "
        "-t zigbee2mqtt/sim/living/remote"
    )
    server.fail(
        "timeout 1 mosquitto_sub -h 127.0.0.1 -p 1883 -C 1 "
        "-t zigbee2mqtt/sim/living/lamp/set -t zigbee2mqtt/sim/hall/switch/set"
    )

    # Offset actions alter only the capable lamp's normalized target.
    before_brightness = latest_number(LAMP_SET, "brightness")
    brightness_mark = checkpoint()
    remote_action("living", "brightness_up_click")
    brighter = wait_for(
        brightness_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and payload.get("brightness", -1) > before_brightness,
    )["brightness"]
    before_cct = latest_number(LAMP_SET, "color_temp")
    cct_mark = checkpoint()
    remote_action("living", "arrow_right_click")
    warmer_offset = wait_for(
        cct_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and payload.get("color_temp", before_cct) < before_cct,
    )["color_temp"]
    assert brighter > before_brightness
    assert warmer_offset < before_cct

    # Crossing a real wall-clock hour starts the production scheduler overlay,
    # then expiry recomputes the current offset target instead of restoring a snapshot.
    server.succeed("date --set='2026-09-14 12:59:58'")
    time.sleep(0.5)
    hourly_base = latest_number(LAMP_SET, "brightness")
    hourly_mark = checkpoint()
    server.succeed("date --set='2026-09-14 13:00:01'")
    hourly_peak_payload = wait_for(
        hourly_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and payload.get("brightness", -1) >= hourly_base + 20,
    )
    hourly_peak_index = next(
        index
        for index, record in enumerate(records()[hourly_mark:], start=hourly_mark)
        if record[0] == "SET" and record[1] == LAMP_SET and record[2] == hourly_peak_payload
    )
    hourly_return = wait_for(
        hourly_peak_index + 1,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and abs(payload.get("brightness", -1000) - hourly_base) <= 2,
    )
    assert hourly_peak_payload["brightness"] > hourly_return["brightness"]

    # Double click is classified atomically: no single-click OFF flash. Freeze
    # and unfreeze acknowledgements pulse to opposite brightness sides, then expire.
    freeze_base = latest_number(LAMP_SET, "brightness")
    freeze_mark = checkpoint()
    remote_double("living")
    freeze_ack = wait_for(
        freeze_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and payload.get("brightness", freeze_base) <= freeze_base - 15,
    )
    freeze_ack_index = next(
        index
        for index, record in enumerate(records()[freeze_mark:], start=freeze_mark)
        if record[0] == "SET" and record[1] == LAMP_SET and record[2] == freeze_ack
    )
    freeze_return = wait_for(
        freeze_ack_index + 1,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and abs(payload.get("brightness", -1000) - freeze_base) <= 2,
    )
    assert not any(
        isinstance(payload, dict) and payload.get("state") == "OFF"
        for payload in matching(freeze_mark, "SET", LAMP_SET)
    )
    assert scope_mode("room:living-room") == "frozen"

    unfreeze_mark = checkpoint()
    remote_double("living")
    unfreeze_ack = wait_for(
        unfreeze_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and payload.get("brightness", freeze_base) >= freeze_base + 15,
    )
    unfreeze_ack_index = next(
        index
        for index, record in enumerate(records()[unfreeze_mark:], start=unfreeze_mark)
        if record[0] == "SET" and record[1] == LAMP_SET and record[2] == unfreeze_ack
    )
    unfreeze_return = wait_for(
        unfreeze_ack_index + 1,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and abs(payload.get("brightness", -1000) - freeze_base) <= 2,
    )
    assert freeze_ack["brightness"] < freeze_return["brightness"]
    assert unfreeze_ack["brightness"] > unfreeze_return["brightness"]
    assert scope_mode("room:living-room") == "follow"

    # Persist a second freeze and both user offsets, then restart the actual unit.
    remote_double("living")
    server.wait_until_succeeds(
        f"test \"$(sqlite3 -readonly -noheader {q(DATABASE)} "
        + q("SELECT json_extract(payload_json, '$.data.curve_mode.mode') FROM scope_state WHERE scope_key='room:living-room'")
        + ")\" = frozen"
    )
    assert float(sqlite_scalar(
        "SELECT json_extract(payload_json, '$.data.offsets.brightness') "
        "FROM scope_state WHERE scope_key='room:living-room'"
    )) == 0.05
    assert float(sqlite_scalar(
        "SELECT json_extract(payload_json, '$.data.offsets.color_temperature_kelvin') "
        "FROM scope_state WHERE scope_key='room:living-room'"
    )) == 200.0
    stored_payloads = sqlite_scalar(
        "SELECT COALESCE(group_concat(payload_json, '|'), 'EMPTY') FROM ("
        "SELECT payload_json FROM scope_state UNION ALL "
        "SELECT payload_json FROM control_state UNION ALL "
        "SELECT payload_json FROM metadata)"
    )
    for forbidden in ["overlay", "converging", "animation", "mqtt"]:
        assert forbidden not in stored_payloads

    restart_mark = checkpoint()
    old_pid = server.succeed("systemctl show house-automationd.service -P MainPID").strip()
    server.succeed("systemctl restart house-automationd.service")
    server.wait_for_unit("house-automationd.service")
    server.wait_until_succeeds("curl -fsS http://127.0.0.1:9877/healthz | jq -e .ready")
    new_pid = server.succeed("systemctl show house-automationd.service -P MainPID").strip()
    assert old_pid != new_pid
    assert scope_mode("room:living-room") == "frozen"
    wait_for(restart_mark, "GET", "zigbee2mqtt/sim/living/lamp/get")

    # The on/off-only endpoint never receives brightness/CCT/color and cannot
    # flash as a circadian acknowledgement.
    hall_freeze_mark = checkpoint()
    remote_double("hall")
    server.wait_until_succeeds(
        f"test \"$(sqlite3 -readonly -noheader {q(DATABASE)} "
        + q("SELECT json_extract(payload_json, '$.data.curve_mode.mode') FROM scope_state WHERE scope_key='room:hall'")
        + ")\" = frozen"
    )
    assert_absent(hall_freeze_mark, "SET", HALL_SET, duration=0.8)
    for payload in matching(0, "SET", HALL_SET):
        assert isinstance(payload, dict)
        assert "brightness" not in payload
        assert "color_temp" not in payload
        assert "color" not in payload

    # A broker outage changes readiness without restarting the daemon. Recovery
    # resubscribes and reconciles durable desired state when the adapter returns.
    daemon_pid = server.succeed("systemctl show house-automationd.service -P MainPID").strip()
    reconnect_mark = checkpoint()
    server.succeed("systemctl stop mosquitto.service")
    server.wait_until_succeeds(
        "test \"$(curl -sS -o /tmp/disconnected.json -w '%{http_code}' "
        "http://127.0.0.1:9877/healthz)\" = 503"
    )
    server.succeed("jq -e '(.ready | not) and (.mqtt_connected | not)' /tmp/disconnected.json")
    server.succeed("systemctl start mosquitto.service")
    server.wait_for_unit("mosquitto.service")
    mqtt_publish("zigbee2mqtt/bridge/state", "online", retain=True, qos=1)
    server.wait_until_succeeds("curl -fsS http://127.0.0.1:9877/healthz | jq -e .ready")
    assert daemon_pid == server.succeed("systemctl show house-automationd.service -P MainPID").strip()
    wait_for(
        reconnect_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict) and payload.get("state") == "ON",
        timeout=35,
    )
    wait_for(
        reconnect_mark,
        "SET",
        HALL_SET,
        lambda payload: isinstance(payload, dict) and payload.get("state") == "ON",
        timeout=35,
    )
    post_reconnect_brightness = latest_number(LAMP_SET, "brightness")
    post_reconnect_remote_mark = checkpoint()
    remote_action("living", "brightness_up_click")
    wait_for(
        post_reconnect_remote_mark,
        "SET",
        LAMP_SET,
        lambda payload: isinstance(payload, dict)
        and payload.get("brightness", -1) > post_reconnect_brightness,
        timeout=35,
    )

    # Every independently controlled scope is frozen before 04:00. The real
    # wall-clock boundary must atomically persist FOLLOW for both and converge
    # the capable lamp rather than jumping directly to the new curve.
    assert scope_mode("room:living-room") == "frozen"
    assert scope_mode("room:hall") == "frozen"
    server.succeed("date --set='2026-09-15 03:59:58'")
    time.sleep(0.5)
    reset_start_brightness = latest_number(LAMP_SET, "brightness")
    reset_mark = checkpoint()
    server.succeed("date --set='2026-09-15 04:00:01'")
    server.wait_until_succeeds(
        f"test \"$(sqlite3 -readonly -noheader {q(DATABASE)} "
        + q("SELECT COUNT(*) FROM scope_state WHERE scope_key IN ('room:living-room','room:hall') AND json_extract(payload_json, '$.data.curve_mode.mode')='follow'")
        + ")\" = 2"
    )
    assert sqlite_scalar(
        "SELECT json_extract(payload_json, '$.data.last_reset_date.year') || '-' || "
        "printf('%02d', json_extract(payload_json, '$.data.last_reset_date.month')) || '-' || "
        "printf('%02d', json_extract(payload_json, '$.data.last_reset_date.day')) "
        "FROM metadata WHERE key='automation'"
    ) == "2026-09-15"
    assert sqlite_scalar("SELECT COUNT(*) FROM control_state") == "2"

    # Inspect the complete command sequence captured since the boundary. The
    # SQLite checks above may consume most of a two-second convergence on a
    # loaded VM, so sampling only after they finish would be timing-dependent.
    deadline = time.monotonic() + 8
    reset_values = []
    while time.monotonic() < deadline:
        reset_values = [
            payload["brightness"]
            for payload in matching(reset_mark, "SET", LAMP_SET)
            if isinstance(payload, dict) and "brightness" in payload
        ]
        if (
            len(set(reset_values)) >= 5
            and abs(reset_values[-1] - RESET_FINAL_BRIGHTNESS) <= 2
        ):
            break
        time.sleep(0.1)
    assert len(set(reset_values)) >= 5, reset_values
    assert max(reset_values) >= reset_start_brightness + 20, reset_values
    peak_index = reset_values.index(max(reset_values))
    convergence_values = reset_values[peak_index:]
    assert len(set(convergence_values)) >= 5, convergence_values
    assert all(
        right <= left + 1
        for left, right in zip(convergence_values, convergence_values[1:])
    ), convergence_values
    assert abs(reset_values[-1] - RESET_FINAL_BRIGHTNESS) <= 2, reset_values

    # Malformed external payloads are poison-isolated and never copied into JSON logs.
    mqtt_publish("zigbee2mqtt/sim/living/lamp", "LOG_SECRET_SENTINEL{", qos=1)
    time.sleep(0.3)
    server.succeed("systemctl is-active --quiet house-automationd.service")
    server.succeed("curl -fsS http://127.0.0.1:9877/healthz | jq -e '.ready and (.last_successful_reconciliation_unix_seconds != null)'")
    server.succeed("journalctl -u house-automationd.service -o cat | grep -F '\"source\":\"control\"'")
    server.succeed("journalctl -u house-automationd.service -o cat | grep -F '\"overlay\":\"whole-hour\"'")
    server.succeed("journalctl -u house-automationd.service -o cat | grep -F '\"mqtt_reconnect\":true'")
    server.fail("journalctl -u house-automationd.service -o cat | grep -F LOG_SECRET_SENTINEL")

    # Re-check broker retention after all command, overlay, and restart paths.
    # First require a bounded quiet window so a live convergence command cannot
    # be mistaken for retained delivery; continuously active traffic fails.
    quiet_deadline = time.monotonic() + 5
    quiet_since = time.monotonic()
    previous_record_count = len(records())
    while time.monotonic() < quiet_deadline:
        current_record_count = len(records())
        if current_record_count != previous_record_count:
            previous_record_count = current_record_count
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= 0.6:
            break
        time.sleep(0.1)
    else:
        raise Exception("MQTT command stream did not become quiescent")
    server.fail(
        "timeout 1 mosquitto_sub -h 127.0.0.1 -p 1883 -C 1 "
        "-t zigbee2mqtt/sim/living/lamp/set -t zigbee2mqtt/sim/hall/switch/set"
    )
  '';
}
