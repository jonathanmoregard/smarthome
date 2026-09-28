"""Minimal stand-in for the Zigbee2MQTT 2.x bridge API.

Serves the pair-zigbee and house checks. It publishes the retained bridge
state only after its subscription is acknowledged, then a retained device
list and each device's availability. It answers permit_join, device/rename,
device/remove and device/options with the request's transaction, simulates
one IKEA bulb joining whenever joining is permitted, and answers /get and
/set for known devices. Identify and effect commands are logged.
"""

import json
import os
import signal
import threading

import paho.mqtt.client as mqtt

BASE = "zigbee2mqtt"
STATE = "/var/lib/fake-zigbee2mqtt"
REQUESTS = f"{STATE}/requests.jsonl"
DEVICES = f"{STATE}/devices.json"
OPTIONS = f"{STATE}/options.jsonl"
IDENTIFY = f"{STATE}/identify.jsonl"
REJECT = "/run/fake-zigbee2mqtt/reject"
REFUSE_REMOVE = "/run/fake-zigbee2mqtt/refuse-remove"
SEED = os.environ.get("FAKE_Z2M_SEED")
BULB = "0x000b57fffe123456"
LIGHT = {
    "type": "light",
    "features": [
        {"type": "binary", "name": "state", "property": "state",
         "access": 7, "value_on": "ON", "value_off": "OFF"},
        {"type": "numeric", "name": "brightness",
         "property": "brightness", "access": 7,
         "value_min": 0, "value_max": 254},
        {"type": "numeric", "name": "color_temp",
         "property": "color_temp", "access": 7, "unit": "mired",
         "value_min": 250, "value_max": 454},
    ],
}
EFFECT = {
    "type": "enum", "name": "effect", "property": "effect", "access": 2,
    "values": ["blink", "breathe", "okay", "channel_change",
               "finish_effect", "stop_effect"],
}
DEFINITION = {
    "vendor": "IKEA",
    "model": "LED2201G8",
    "description": "TRADFRI bulb E27, white spectrum, globe, opal, 1055 lm",
    "exposes": [LIGHT, EFFECT],
}
COORDINATOR = {
    "ieee_address": "0x00124b0000000001",
    "type": "Coordinator",
    "friendly_name": "Coordinator",
    "supported": True,
    "disabled": False,
    "interview_completed": True,
    "definition": None,
}
LIVE_STATE = {"state": "OFF", "brightness": 127, "color_temp": 333}
OFFLINE = json.dumps({"state": "offline"})
lock = threading.Lock()


def load_devices():
    for path in (DEVICES, SEED):
        if path and os.path.exists(path):
            with open(path) as source:
                return json.load(source)
    return [COORDINATOR]


devices = load_devices()


def publish(client, topic, payload, retain=False):
    client.publish(f"{BASE}/{topic}", json.dumps(payload), qos=1,
                   retain=retain)


def log(path, entry):
    with open(path, "a") as target:
        target.write(json.dumps(entry) + "\n")


def find(name):
    for device in devices:
        if device["type"] == "Coordinator":
            continue
        if name in (device["friendly_name"], device["ieee_address"]):
            return device
    return None


def set_availability(client, name, online):
    if online:
        publish(client, f"{name}/availability", {"state": "online"},
                retain=True)
    else:
        client.publish(f"{BASE}/{name}/availability", b"", qos=1,
                       retain=True)


def publish_devices(client):
    with open(DEVICES, "w") as target:
        json.dump(devices, target)
    publish(client, "bridge/devices", devices, retain=True)


def respond(client, name, request, response):
    if "transaction" in request:
        response["transaction"] = request["transaction"]
    publish(client, f"bridge/response/{name}", response)


def refuse(client, name, request, reason):
    respond(client, name, request,
            {"data": {}, "status": "error", "error": reason})


def on_connect(client, userdata, flags, reason_code, properties):
    client.subscribe(f"{BASE}/#", qos=1)


def on_subscribe(client, userdata, mid, reason_codes, properties):
    with lock:
        publish(client, "bridge/state", {"state": "online"}, retain=True)
        publish_devices(client)
        for device in devices:
            if device["type"] != "Coordinator":
                set_availability(client, device["friendly_name"], True)


def permit_join(client, request):
    log(REQUESTS, request)
    if os.path.exists(REJECT) and request["time"] > 0:
        refuse(client, "permit_join", request, "simulated adapter failure")
        return
    respond(client, "permit_join", request,
            {"data": {"time": request["time"]}, "status": "ok"})
    if request["time"] == 0:
        return
    names = {"friendly_name": BULB, "ieee_address": BULB}
    publish(client, "bridge/event", {"type": "device_joined", "data": names})
    publish(client, "bridge/event", {
        "type": "device_interview",
        "data": {**names, "status": "started"},
    })
    if find(BULB) is None:
        devices.append({**names, "type": "Router", "supported": True,
                        "disabled": False, "interview_completed": True,
                        "definition": DEFINITION})
        publish_devices(client)
        set_availability(client, BULB, True)
    publish(client, "bridge/event", {
        "type": "device_interview",
        "data": {**names, "status": "successful", "supported": True,
                 "definition": DEFINITION},
    })


def rename(client, request):
    device = find(request.get("from", ""))
    target = request.get("to", "")
    if device is None:
        refuse(client, "device/rename", request,
               f"Device '{request.get('from')}' does not exist")
        return
    if not target or find(target) is not None:
        refuse(client, "device/rename", request,
               f"Friendly name '{target}' is already in use")
        return
    old = device["friendly_name"]
    device["friendly_name"] = target
    set_availability(client, old, False)
    set_availability(client, target, True)
    publish_devices(client)
    respond(client, "device/rename", request, {
        "data": {"from": old, "to": target, "homeassistant_rename": False},
        "status": "ok",
    })


def remove(client, request):
    name = request.get("id", "")
    device = find(name)
    if device is None:
        refuse(client, "device/remove", request,
               f"Device '{name}' does not exist")
        return
    if os.path.exists(REFUSE_REMOVE) and not request.get("force"):
        refuse(client, "device/remove", request,
               "Device did not respond to the leave request")
        return
    devices.remove(device)
    set_availability(client, device["friendly_name"], False)
    publish_devices(client)
    respond(client, "device/remove", request, {
        "data": {"id": name, "block": False,
                 "force": bool(request.get("force"))},
        "status": "ok",
    })


def options(client, request):
    log(OPTIONS, request)
    if find(request.get("id", "")) is None:
        refuse(client, "device/options", request,
               f"Device '{request.get('id')}' does not exist")
        return
    respond(client, "device/options", request, {
        "data": {"id": request["id"], "from": {},
                 "to": request.get("options", {}),
                 "restart_required": False},
        "status": "ok",
    })


def command(client, path, payload):
    name, _, action = path.rpartition("/")
    device = find(name)
    if device is None or device["friendly_name"] != name:
        return
    if action == "set" and ("identify" in payload or "effect" in payload):
        log(IDENTIFY, {"device": name, **payload})
    state = dict(LIVE_STATE)
    if action == "set":
        state.update({key: value for key, value in payload.items()
                      if key in LIVE_STATE})
    publish(client, name, state)


def on_message(client, userdata, message):
    if message.retain or not message.payload:
        return
    path = message.topic.removeprefix(f"{BASE}/")
    try:
        payload = json.loads(message.payload)
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    with lock:
        if path == "bridge/request/permit_join":
            permit_join(client, payload)
        elif path == "bridge/request/device/rename":
            rename(client, payload)
        elif path == "bridge/request/device/remove":
            remove(client, payload)
        elif path == "bridge/request/device/options":
            options(client, payload)
        elif path.endswith(("/get", "/set")):
            command(client, path, payload)


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
