/**
 * Inputs for tests, as Home Assistant's bridge sends them: a script or automation run, read by `haInput` with the
 * synthetic catalog's mode, so a test builds an input the way the host does.
 */
import assert from 'node:assert/strict';
import { parseCatalog } from '../../../src/adapter/codecs/catalog.ts';
import { haInput } from '../../../src/adapter/codecs/inputs.ts';
import type { HaInput } from '../../../src/adapter/codecs/inputs.ts';
import type { JsonObject } from '../../../src/adapter/ha-client.ts';

const MODE = parseCatalog({ mode: 'sara' }).mode;

/** The input a run is; it must be one of ours (an unreadable one is still an input, which the turn drops). */
export function bridged(script: string, args: JsonObject): HaInput {
  const input = haInput(script, args, MODE);
  assert.ok(input !== undefined, `${script} is an input`);
  return input;
}
