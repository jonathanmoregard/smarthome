import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServiceCall } from '../../src/adapter/ha-client.ts';
import { heartbeatCall } from '../../src/adapter/encode.ts';
import { parseLiveRooms } from '../../src/adapter/live-rooms.ts';
import { toInstant } from '../../src/adapter/codecs/ids.ts';
import type { HouseMirror } from '../../src/adapter/codecs/house.ts';
import { rereading, startHeartbeat } from '../../src/main.ts';

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
  const stop = startHeartbeat(() => parseLiveRooms('studio'), async call => {
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

const settle = () => new Promise(resolve => setImmediate(resolve));

test('the heartbeat is held while the host is paused, so the watchdog sees the port stall', async () => {
  // Re-review 2. Break: the port beats on while it is paused (Home Assistant out of reach, or not read again), and the
  // watchdog takes a port that drives nothing for alive.
  const sent: ServiceCall[] = [];
  let paused = true;
  const stop = startHeartbeat(() => parseLiveRooms('studio'), async call => { sent.push(call); }, () => {}, 5, () => paused);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(sent, [], 'no beat while paused');
    paused = false;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(sent.length > 0, 'the beat goes again once the host is back');
  } finally {
    stop();
  }
});

test('a house read that fails is tried again on its backoff until one lands', async () => {
  // Re-review 2. Break: a read that fails once the connection is back is only reported, never tried again, so the host
  // stays paused for good.
  const landed: number[] = [], reports: string[] = [], timers: { delayMs: number; wake: () => void }[] = [];
  const house: HouseMirror = { state: {}, areas: {} };
  let reads = 0;
  const start = rereading(async () => {
    reads++;
    if (reads < 3) throw new Error('timed out');
    return house;
  }, (_house, startedAt) => landed.push(startedAt), message => reports.push(message), () => toInstant(100 + reads),
  (delayMs, wake) => { timers.push({ delayMs, wake }); return () => {}; });
  start();
  await settle();
  assert.deepEqual([landed, timers.map(timer => timer.delayMs)], [[], [1000]]);
  timers[0]!.wake();
  await settle();
  assert.deepEqual([landed, timers.map(timer => timer.delayMs)], [[], [1000, 2000]]);
  timers[1]!.wake();
  await settle();
  assert.deepEqual(landed, [102], 'the third read landed, with the instant it started');
  assert.equal(reports.length, 2);
  assert.match(reports[0] ?? '', /timed out/);
});
