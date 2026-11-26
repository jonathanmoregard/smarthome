import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJournal, saveJournal } from '../../src/adapter/codecs/journal.ts';
import { NO_BELIEFS } from '../../src/adapter/reconcile.ts';
import type { Beliefs } from '../../src/adapter/reconcile.ts';
import { toBulbId, toColourChannel, toInstant, toKelvin, toLevel, toRoomId, toSwitchId } from '../../src/adapter/codecs/ids.ts';

/**
 * The journal is what the reconciler holds about each bulb and switch, kept
 * across a restart of the process. Every kind of belief goes in.
 */
const saveBeliefs = (beliefs: Beliefs) => saveJournal({ beliefs, share: { kind: 'house' } });
const loadBeliefs = (text: string | undefined) => loadJournal(text).beliefs;
const at = (seconds: number) => toInstant(1_800_000_000 + seconds);
const red = toColourChannel(255), half = toColourChannel(127.5), none = toColourChannel(0);

const EVERY_KIND: Beliefs = {
  bulbs: {
    [toBulbId('light.a1')]: { kind: 'sent', shows: { power: 'on', level: toLevel(120), colour: { kind: 'kelvin', kelvin: toKelvin(2200) },
      firmwareEffect: 'candle' }, sentAt: at(0), settlesAt: at(2.4), reapplies: [at(-300), at(-60)],
      reportedWhenSent: { power: 'on', level: toLevel(118), colour: { kind: 'kelvin', kelvin: toKelvin(2207) } } },
    [toBulbId('light.a2')]: { kind: 'sent', shows: { power: 'on', level: toLevel(1), colour: { kind: 'rgb', rgb: { red, green: half, blue: none } },
      firmwareEffect: 'none' }, sentAt: at(1), settlesAt: at(3.2), reapplies: [],
      reportedWhenSent: { power: 'on', level: toLevel(3), colour: { kind: 'rgb', rgb: { red, green: none, blue: none } } } },
    [toBulbId('light.a3')]: { kind: 'sent', shows: { power: 'on', level: toLevel(254), colour: undefined, firmwareEffect: 'none' },
      sentAt: at(1), settlesAt: at(3), reapplies: [], reportedWhenSent: { power: 'on', level: toLevel(200), colour: undefined } },
    [toBulbId('light.b1')]: { kind: 'sent', shows: { power: 'off' }, sentAt: at(2), settlesAt: at(4.2), reapplies: [],
      reportedWhenSent: { power: 'off' } },
    [toBulbId('light.b2')]: { kind: 'retrying', shows: undefined, attempts: 3, retryAt: at(8) },
    [toBulbId('light.b3')]: { kind: 'retrying', shows: { power: 'on', level: toLevel(80), colour: undefined, firmwareEffect: 'candle' },
      attempts: 1, retryAt: at(5) },
    [toBulbId('light.c1')]: { kind: 'parked', lastSent: { power: 'off' } },
    [toBulbId('light.c2')]: { kind: 'back on' },
  },
  switches: {
    [toSwitchId('switch.plug')]: { kind: 'open', power: 'on', sentAt: at(7), attempts: 2, retryAt: at(9) },
    [toSwitchId('switch.lamp')]: { kind: 'parked', power: 'off', sentAt: at(3) },
  },
};

test('round trip: every kind of belief comes back as it went in', () => {
  // Break: a belief kind, a field, a colour kind, the candle or a switch send is lost or changed on the way.
  assert.deepEqual(loadBeliefs(saveBeliefs(EVERY_KIND)), EVERY_KIND);
  assert.deepEqual(loadBeliefs(saveBeliefs(NO_BELIEFS)), NO_BELIEFS);
});

test('an unreadable journal is no beliefs', () => {
  // Break: a missing, empty, garbled or foreign file raises, or is read as something held.
  for (const text of [undefined, '', 'not json', 'null', '[]', '"text"', '{}', '{"version":2,"bulbs":{},"switches":{}}',
    '{"version":1,"bulbs":[],"switches":{}}']) {
    assert.deepEqual(loadBeliefs(text), NO_BELIEFS, String(text));
  }
});

test('the share the beliefs were sent under comes back; a journal without one drove no room', () => {
  // Review finding 8. Break: the share is lost, so a restart cannot tell a room handed over while the process was down;
  // or a journal saved before the share was kept reads as the whole house, and its beliefs are trusted everywhere.
  const rooms = { kind: 'rooms' as const, rooms: new Set([toRoomId('den'), toRoomId('studio')]) };
  assert.deepEqual(loadJournal(saveJournal({ beliefs: EVERY_KIND, share: rooms })), { beliefs: EVERY_KIND, share: rooms });
  assert.deepEqual(loadJournal(saveJournal({ beliefs: NO_BELIEFS, share: { kind: 'house' } })).share, { kind: 'house' });
  const none = { kind: 'rooms', rooms: new Set() };
  for (const share of [undefined, 'house', { kind: 'rooms' }, { kind: 'rooms', rooms: [''] }, { kind: 'garden' }]) {
    const text = JSON.stringify({ ...(JSON.parse(saveBeliefs(EVERY_KIND)) as object), share });
    assert.deepEqual(loadJournal(text), { beliefs: EVERY_KIND, share: none }, JSON.stringify(share));
  }
  assert.deepEqual(loadJournal(undefined).share, none);
});

test('an unreadable entry is no belief for that bulb or switch; the rest are kept', () => {
  // Break: one bad entry throws the whole journal away (every bulb re-sent), or is read as a belief.
  const text = JSON.parse(saveBeliefs(EVERY_KIND)) as { bulbs: Record<string, unknown>; switches: Record<string, unknown> };
  text.bulbs['light.a1'] = { kind: 'sent', shows: { power: 'on', level: 999 } };
  text.bulbs['light.b2'] = { kind: 'retrying', shows: undefined, attempts: 7, retryAt: 8 };
  text.bulbs['light.c1'] = 'parked';
  text.switches['switch.plug'] = { kind: 'open', power: 'dim', sentAt: 1, attempts: 1, retryAt: 2 };
  text.switches['switch.lamp'] = { power: 'off', sentAt: 1 };
  const loaded = loadBeliefs(JSON.stringify(text));
  assert.deepEqual(Object.keys(loaded.bulbs).sort(), ['light.a2', 'light.a3', 'light.b1', 'light.b3', 'light.c2']);
  assert.deepEqual(loaded.switches, {});
  assert.deepEqual(loaded.bulbs[toBulbId('light.b3')], EVERY_KIND.bulbs[toBulbId('light.b3')]);
});

test('a send journalled before the report at the send was kept is no belief', () => {
  // Break: an old entry is read with a made-up report, which the next turn would take as the bulb's answer or not.
  const text = JSON.parse(saveBeliefs(EVERY_KIND)) as { bulbs: Record<string, Record<string, unknown>> };
  delete text.bulbs['light.a3']?.reportedWhenSent;
  const loaded = loadBeliefs(JSON.stringify(text));
  assert.equal(loaded.bulbs[toBulbId('light.a3')], undefined);
  assert.deepEqual(loaded.bulbs[toBulbId('light.a2')], EVERY_KIND.bulbs[toBulbId('light.a2')]);
});
