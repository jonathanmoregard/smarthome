import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../../src/main.ts';

/** The refusal comes first: before any file is read, any lock taken or Home Assistant contacted. */
test('the port refuses to start live without a live-room list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lighting-live-start-'));
  await assert.rejects(main(['--live', '--config', join(directory, 'missing-catalog.json'), '--state', join(directory, 'state.json')]),
    /--live-rooms/);
});

test('the port refuses to start offline without a live-room list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lighting-live-start-'));
  await assert.rejects(main(['--snapshot', join(directory, 'missing-snapshot.json'), '--state', join(directory, 'state.json')]),
    /--live-rooms/);
});
