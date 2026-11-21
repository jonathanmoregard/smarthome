import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServiceCall } from '../../src/runtime/context.ts';
import { heartbeatCall } from '../../src/runtime/live-rooms.ts';
import { parseLiveRooms } from '../../src/parse/live-rooms.ts';
import { startHeartbeat } from '../../src/main.ts';

/**
 * The port's heartbeat: while it runs, it tells Home Assistant it is alive
 * and which rooms it may drive. A Home Assistant watchdog turns off every
 * port switch the heartbeat does not cover, so a port that stops, crashes or
 * was started without a room hands those rooms back to the old scripts.
 */
test('the heartbeat names the time and the rooms the port may drive', () => {
  assert.deepEqual(heartbeatCall(parseLiveRooms('studio,den'), Date.parse('2026-10-26T12:00:00Z')), {
    service: 'input_text.set_value', data: { value: '1793016000|den,studio' }, target: { entity_id: 'input_text.ls_port_heartbeat' },
  });
});

test('a port with no live room sends no heartbeat, so it sends nothing at all', () => {
  assert.equal(heartbeatCall(parseLiveRooms(''), 0), undefined);
});

test('the heartbeat beats until stopped, and a failed beat does not stop it', async () => {
  const sent: ServiceCall[] = [], errors: string[] = [];
  let calls = 0;
  const stop = startHeartbeat(parseLiveRooms('studio'), async call => {
    calls++;
    if (calls === 1) throw new Error('not connected');
    sent.push(call);
  }, message => errors.push(message), 5);
  await new Promise(resolve => setTimeout(resolve, 40));
  stop();
  const count = calls;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(count >= 3, `expected several beats, got ${count}`);
  assert.equal(calls, count, 'no beat after stop');
  assert.deepEqual(errors, ['Heartbeat not sent: not connected']);
  assert.ok(sent.every(call => call.target?.entity_id === 'input_text.ls_port_heartbeat'));
});
