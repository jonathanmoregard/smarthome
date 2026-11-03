import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'home-assistant-js-websocket';
import type { HaWebSocket } from 'home-assistant-js-websocket';
import { HomeAssistantTransport } from '../../src/live.ts';

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
  const transport = new HomeAssistantTransport(connection);
  await transport.send({ service: 'light.turn_on', target: { entity_id: 'light.test' }, data: { brightness: 80 } });
  assert.equal(socket.frames[0]?.type, 'call_service');
  assert.deepEqual(socket.frames[0]?.service_data, { brightness: 80 });
  assert.deepEqual(socket.frames[0]?.target, { entity_id: 'light.test' });
  let events = 0;
  await transport.subscribe('smarthome_script', () => { events++; });
  const id = socket.frames.at(-1)?.id;
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', id, event: { event_type: 'smarthome_script', data: {} } }) }));
  assert.equal(events, 1);
  await transport.close();
  await assert.rejects(transport.send({ service: 'light.turn_on', data: {} }), /disconnected/);
  assert.equal(connection.commands.size, 0);
  assert.equal(events, 1);
});

test('own Sara mirror events arriving before service ACK are suppressed while genuine user events reach typed automation', async () => {
  const { execute } = await import('../../src/runtime/engine.ts');
  const { automationHandlers } = await import('../../src/domain/automations.ts');
  class ControlledPort extends SocketPort {
    override send(data: string) { const frame = JSON.parse(data); if (frame.type === 'call_service') this.frames.push(frame); else super.send(data); }
  }
  const socket = new ControlledPort();
  const connection = await createConnection({ createSocket: async () => socket as unknown as HaWebSocket });
  const transport = new HomeAssistantTransport(connection);
  const overrides: unknown[] = [];
  await transport.subscribe('smarthome_script', event => {
    const result = execute({ script: String(event.data.script), args: event.data.args, snapshot: { state: { 'sensor.ls_overrides': { state: '0', attributes: { overrides: {} } } }, areas: {}, members: [], now: '2026-10-26T12:00:00Z' } }, automationHandlers);
    overrides.push(...result.events);
  });
  const subscription = socket.frames.at(-1)?.id;
  const pending = transport.send({ service: 'input_boolean.turn_on', target: { entity_id: 'input_boolean.ls_sara_mode_mirror' }, data: {} });
  const command = socket.frames.at(-1)?.id;
  for (const id of ['own', 'real-user']) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', id: subscription, event: { event_type: 'smarthome_script', data: { script: 'automation.lighting_schedule_sara_mode_switch', args: { trigger: { id: 'on', to_state: { state: 'on', context: { id, user_id: 'same-authenticated-user' } } } } } } }) }));
  assert.equal(overrides.length, 0);
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'result', id: command, success: true, result: { context: { id: 'own' } } }) }));
  await pending;
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].data.records[0].kind, 'mode');
  await transport.close();
});

test('entity context survives full refresh and acknowledged state snapshots', async () => {
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
  const transport = new HomeAssistantTransport(connection);
  const previous = { state: {}, areas: {}, members: [], now: '2026-10-26T12:00:00Z', catalog: { members: {}, effects: {} } };
  const refreshed = await transport.refresh(previous);
  assert.deepEqual(refreshed.state['script.test']?.context, { id: 'script-call' });
  const acknowledged = await transport.send({ service: 'variable.set_variable', data: { entity_id: 'sensor.ls_overrides' } });
  assert.deepEqual(acknowledged?.states?.['sensor.ls_overrides']?.context, { id: 'state-call' });
  await transport.close();
});
