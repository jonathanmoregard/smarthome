# Zigbee2MQTT contract fixtures

These files are anonymous, constructed protocol examples. They contain no captured household traffic, real IEEE addresses, network keys, friendly names, or other deployment data.

They pin parser behavior against these official Zigbee2MQTT references:

- MQTT topics and messages: <https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html>
- IKEA E1524/E1810 remote: <https://www.zigbee2mqtt.io/devices/E1524_E1810.html>
- IKEA LED2111G6 light: <https://www.zigbee2mqtt.io/devices/LED2111G6.html>

Fixture shapes are intentionally partial and include unknown fields to verify forward-compatible parsing. Update fixtures only with a reviewed adapter-contract change.

Friendly-name validation catches conflicts detectable without a running Zigbee2MQTT instance: empty edges, MQTT wildcard characters, all-numeric terminal segments, `left`/`right`, and local `set`/`get`/`availability` endpoint collisions. This is not an exhaustive substitute for Zigbee2MQTT's own validation.
