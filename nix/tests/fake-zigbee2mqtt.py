"""Minimal stand-in for the Zigbee2MQTT 2.x bridge API used by pair-zigbee.

Publishes the retained bridge state only after its request subscription is
acknowledged, records every permit_join payload, answers with the request's
transaction, and simulates one IKEA bulb joining when joining is permitted.
"""

import json
import os
import signal
import threading

import paho.mqtt.client as mqtt

BASE = "zigbee2mqtt"
REQUESTS = "/var/lib/fake-zigbee2mqtt/requests.jsonl"
REJECT = "/run/fake-zigbee2mqtt/reject"
BULB = "0x000b57fffe123456"
DEFINITION = {
    "vendor": "IKEA",
    "model": "LED2201G8",
    "description": "TRADFRI bulb E27, white spectrum, globe, opal, 1055 lm",
}
OFFLINE = json.dumps({"state": "offline"})


def publish(client, topic, payload, retain=False):
    client.publish(f"{BASE}/{topic}", json.dumps(payload), qos=1,
                   retain=retain)


def on_connect(client, userdata, flags, reason_code, properties):
    client.subscribe(f"{BASE}/bridge/request/permit_join", qos=1)


def on_subscribe(client, userdata, mid, reason_codes, properties):
    publish(client, "bridge/state", {"state": "online"}, retain=True)


def on_message(client, userdata, message):
    request = json.loads(message.payload)
    with open(REQUESTS, "a") as log:
        log.write(json.dumps(request) + "\n")
    response = {"data": {"time": request["time"]}, "status": "ok"}
    if os.path.exists(REJECT) and request["time"] > 0:
        response = {
            "data": {},
            "status": "error",
            "error": "simulated adapter failure",
        }
    if "transaction" in request:
        response["transaction"] = request["transaction"]
    publish(client, "bridge/response/permit_join", response)
    if response["status"] != "ok" or request["time"] == 0:
        return
    names = {"friendly_name": BULB, "ieee_address": BULB}
    publish(client, "bridge/event", {"type": "device_joined", "data": names})
    publish(client, "bridge/event", {
        "type": "device_interview",
        "data": {**names, "status": "started"},
    })
    publish(client, "bridge/event", {
        "type": "device_interview",
        "data": {
            **names,
            "status": "successful",
            "supported": True,
            "definition": DEFINITION,
        },
    })


def main():
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                         client_id="fake-zigbee2mqtt")
    client.will_set(f"{BASE}/bridge/state", OFFLINE, qos=1, retain=True)
    client.on_connect = on_connect
    client.on_subscribe = on_subscribe
    client.on_message = on_message

    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda signum, frame: stopping.set())
    client.connect("127.0.0.1", 1883)
    client.loop_start()
    stopping.wait()
    # Mirror Zigbee2MQTT's clean shutdown: retained offline, then leave.
    info = client.publish(f"{BASE}/bridge/state", OFFLINE, qos=1,
                          retain=True)
    info.wait_for_publish(5)
    client.disconnect()
    client.loop_stop()


if __name__ == "__main__":
    main()
