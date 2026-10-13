# Home Assistant

Home Assistant owns lighting schedules through the Adaptive Lighting
integration. Configure the `House` integration in the Home Assistant UI and
select the desired `light.*` entities there. Schedule sleep mode with a Home
Assistant automation targeting the Adaptive Lighting sleep-mode switch.

Zigbee2MQTT publishes Home Assistant discovery messages through the local
Mosquitto broker. Pair devices through Zigbee2MQTT's bridge entity, then add
the resulting light entities to Adaptive Lighting.

The repository keeps the Zigbee coordinator identity stable and does not store
Home Assistant runtime state in Git.
