import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'home-assistant-js-websocket';
import type { HaWebSocket } from 'home-assistant-js-websocket';
import { HomeAssistantClient } from '../../src/adapter/ha-client.ts';
import { houseMirrorOf } from '../../src/adapter/codecs/house.ts';

class SocketPort extends EventTarget {
  OPEN = 1; readyState = 1; haVersion = '2026.7.4'; frames: Record<string, unknown>[] = [];
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>; this.frames.push(frame);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, type: 'result', success: true, result: null }) })));
  }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('official HA client sends service frames and releases event subscriptions on close', async () => {
  const socket = new SocketPort();
  const connection = await createConnection({ createSocket: async () => socket as unknown as HaWebSocket });
  const transport = new HomeAssistantClient(connection);
  await transport.call({ service: 'light.turn_on', target: { entity_id: 'light.test' }, data: { brightness: 80 } });
  assert.equal(socket.frames[0]?.type, 'call_service');
  assert.deepEqual(socket.frames[0]?.service_data, { brightness: 80 });
  assert.deepEqual(socket.frames[0]?.target, { entity_id: 'light.test' });
  let events = 0;
  await transport.subscribe('smarthome_script', () => { events++; });
  const id = socket.frames.at(-1)?.id;
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', id, event: { event_type: 'smarthome_script', data: {} } }) }));
  assert.equal(events, 1);
  await transport.close();
  await assert.rejects(transport.call({ service: 'light.turn_on', data: {} }), /disconnected/);
  assert.equal(connection.commands.size, 0);
  assert.equal(events, 1);
});

test('a guarded call is made as a script that stops with an error when its entity changed since it was read', async () => {
  // Review finding 2. Break: the port's write of the overrides sensor lands over an old scripts' commit made since
  // the port read it, and the commit is lost; or a call with no guard is sent as anything but the plain service call.
  const socket = new SocketPort();
  const connection = await createConnection({ createSocket: async () => socket as unknown as HaWebSocket });
  const transport = new HomeAssistantClient(connection);
  const write = { service: 'variable.update_sensor', target: { entity_id: 'sensor.ls_overrides' },
    data: { value: 'r2', attributes: { overrides: {} }, replace_attributes: false } };
  await transport.call({ ...write, guard: { entity: 'sensor.ls_overrides', lastUpdated: '2026-09-21T11:59:00.123456+00:00' } });
  assert.deepEqual(socket.frames[0], { id: socket.frames[0]?.id, type: 'execute_script', sequence: [
    { if: [{ condition: 'template',
      value_template: '{{ states.sensor.ls_overrides.last_updated.isoformat() != "2026-09-21T11:59:00.123456+00:00" }}' }],
    then: [{ stop: 'sensor.ls_overrides changed since it was read', error: true }] },
    { action: 'variable.update_sensor', target: { entity_id: 'sensor.ls_overrides' }, data: write.data },
  ] });
  await transport.call(write);
  assert.equal(socket.frames[1]?.type, 'call_service');
  await transport.close();
});

test('entity context survives a full read', async () => {
  class SnapshotPort extends SocketPort {
    override send(data: string) {
      const frame = JSON.parse(data) as Record<string, unknown>;
      this.frames.push(frame);
      const states = [
        { entity_id: 'script.test', state: 'on', attributes: {}, context: { id: 'script-call' }, last_changed: '2026-10-26T12:00:00Z', last_updated: '2026-10-26T12:00:00Z' },
        { entity_id: 'sensor.ls_overrides', state: '1', attributes: {}, context: { id: 'state-call' }, last_changed: '2026-10-26T12:00:00Z', last_updated: '2026-10-26T12:00:00Z' },
      ];
      const result = frame.type === 'get_states' ? states
        : frame.type === 'get_config' ? { time_zone: 'Europe/Stockholm' }
        : frame.type === 'config/entity_registry/list' ? []
        : frame.type === 'config/device_registry/list' ? []
        : frame.type === 'config/area_registry/list' ? []
        : frame.type === 'config/label_registry/list' ? []
        : frame.type === 'entity/source' ? {}
        : frame.type === 'call_service' ? { context: { id: 'own-call' } }
        : null;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id, type: 'result', success: true, result }) })));
    }
  }
  const socket = new SnapshotPort();
  const connection = await createConnection({ createSocket: async () => socket as unknown as HaWebSocket });
  const transport = new HomeAssistantClient(connection);
  const read = houseMirrorOf(await transport.read());
  assert.deepEqual(read.state['script.test']?.context, { id: 'script-call' });
  assert.deepEqual(read.state['sensor.ls_overrides']?.context, { id: 'state-call' });
  await transport.close();
});
