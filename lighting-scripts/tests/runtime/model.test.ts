import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { Model, Msg } from '../../src/domain/model.ts';
import type { BrightnessOverlay, ModeOverlay, RemotePreset } from '../../src/domain/overlays.ts';
import type { LampLight, SceneLight } from '../../src/domain/types/light.ts';
import { entriesOf } from '../../src/domain/types/ids.ts';
import { toBrightness, toInstant, toKelvin, toLevel } from '../../src/parse/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * The Model and Msg types, and the synthetic house every later test builds on.
 *
 * `npm test` strips types without checking them and `npm run check` reads only
 * `src/`, so the first test compiles this file and the fixture itself: every
 * `satisfies` below and every `@ts-expect-error` line is checked there. An
 * expect-error line whose type stops refusing the value is reported unused
 * (TS2578) and fails it.
 */

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

/** Every compiler error in this file and what it imports, as `file:line message`. */
function compileErrors(): string[] {
  const config = ts.readConfigFile(`${PROJECT}tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PROJECT);
  // Not under `rootDir` (`src/`), and nothing is emitted, so the output settings go.
  const { rootDir: _rootDir, outDir: _outDir, ...options } = parsed.options;
  const program = ts.createProgram([THIS_FILE], { ...options, noEmit: true });
  return ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const where = diagnostic.file === undefined || diagnostic.start === undefined ? 'options'
      : `${diagnostic.file.fileName.slice(PROJECT.length)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`;
    return `${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
}

const house: Model = syntheticHouse();
const firstKey = <K extends string>(record: Readonly<Record<K, unknown>>): K => entriesOf(record)[0]![0];
const lampA1 = firstKey(house.config.lamps);
const remoteA = firstKey(house.config.remotes);
const switchA = firstKey(house.config.switches);
const roomA = firstKey(house.config.rooms);
const now = toInstant(1_790_000_000);

/** One message of each kind, built against the house; a kind with no value here does not compile. */
const oneOfEach = {
  clock: { kind: 'clock', now },
  configChanged: { kind: 'configChanged', config: house.config },
  overlayRequested: { kind: 'overlayRequested', request: { kind: 'hold block', over: 'house', block: 'night' } },
  lampChangedByPerson: { kind: 'lampChangedByPerson', lamps: [lampA1],
    light: { brightness: toBrightness(80), colour: undefined, effect: undefined } },
  remotePressed: { kind: 'remotePressed', remote: remoteA, press: { kind: 'command', command: 'up' } },
  switchButtonPressed: { kind: 'switchButtonPressed', switch: switchA, power: 'off' },
  modeToggled: { kind: 'modeToggled', on: false },
  rangeSaved: { kind: 'rangeSaved', switch: switchA, rule: { kind: 'bright' } },
  lampProfileSaved: { kind: 'lampProfileSaved', lamp: lampA1, block: 'cosy', profile: { follows: 'room' } },
} satisfies { [K in Msg['kind']]: Extract<Msg, { kind: K }> };

test('the model test and the synthetic house compile, and every refusal below is a refusal', () => {
  // Break: a field of the house or a message stops matching its type, or a type
  // starts admitting a value an expect-error line says it refuses.
  assert.deepEqual(compileErrors(), []);
});

test('every Msg kind builds against the synthetic house', () => {
  // Break: a message names a lamp, remote or switch the house does not have.
  for (const msg of Object.values(oneOfEach)) assert.ok(msg satisfies Msg);
  assert.ok(house.config.lamps[oneOfEach.lampChangedByPerson.lamps[0]!] !== undefined);
  assert.ok(house.config.remotes[oneOfEach.remotePressed.remote] !== undefined);
  assert.ok(house.config.switches[oneOfEach.rangeSaved.switch] !== undefined);
  assert.ok(house.config.rooms[roomA] !== undefined);
});

test('day then the candle keeps the day block; the candle from no preset holds none', () => {
  // Today the candle keeps the period the remote held before it (remote-input.ts
  // `pick(next, ['period', 'period_updated'])`), and the schedule reads that
  // period as the room's block whatever the selection.
  // Break: the candle drops the block it was moved onto from, or remembers a
  // different one than the day preset it left.
  const overlay = house.overlays.remotes[0]!;
  const remembered = overlay.remembered.day;
  assert.equal(overlay.preset.choice, 'candle');
  assert.equal(remembered?.choice, 'day');
  if (overlay.preset.choice !== 'candle' || remembered?.choice !== 'day') return;
  assert.deepEqual(overlay.preset.block, { block: 'day', since: remembered.since });

  const fromNoPreset: RemotePreset = { choice: 'candle', since: now, adjustment: undefined, block: undefined };
  assert.equal(fromNoPreset.choice === 'candle' ? fromNoPreset.block : 'not a candle', undefined);
});

test('a block light names its effect: the candle in one block, plain colour in another', () => {
  // The effect belongs to the lit light a block holds, so a room's own cosy
  // light can run the candle while its day light is plain colour.
  // Break: the block light loses its effect, or the effect moves elsewhere.
  const roomBlocks = house.config.rooms[roomA]!.blocks;
  const cosy = roomBlocks.cosy.light, day = roomBlocks.day.light;
  assert.equal(cosy.follows === 'own' && cosy.own?.power === 'on' ? cosy.own.effect : 'not lit', 'Candle');
  assert.equal(day.follows, 'house');
  const houseDay = house.config.house.day.light;
  assert.equal(houseDay?.power === 'on' ? houseDay.effect : 'not lit', 'Normal');
});

test('the types refuse what the domain does not allow', () => {
  const brightness = toBrightness(120), level = toLevel(120);
  const warm = { kind: 'kelvin', kelvin: toKelvin(2700) } as const;
  // @ts-expect-error an off scene has no brightness
  const offScene: SceneLight = { power: 'off', brightness };
  // @ts-expect-error an off light cannot name an effect
  const offEffect: SceneLight = { power: 'off', effect: 'Candle' };
  // @ts-expect-error a lit light names its effect
  const litNoEffect: SceneLight = { power: 'on', brightness, colour: warm };
  // @ts-expect-error an off lamp has no level
  const offLamp: LampLight = { power: 'off', level };
  // @ts-expect-error an off lamp has no colour
  const offColour: LampLight = { power: 'off', colour: warm };
  // @ts-expect-error a day preset has no adjustment of its own
  const dayPreset: RemotePreset = { choice: 'day', since: now, adjustment: undefined };
  // @ts-expect-error a candle preset says whether it holds a block
  const candleUnsaid: RemotePreset = { choice: 'candle', since: now, adjustment: undefined };
  // @ts-expect-error a candle preset holds day or cosy, never night
  const candleNight: RemotePreset = { choice: 'candle', since: now, adjustment: undefined, block: { block: 'night', since: now } };
  // @ts-expect-error a fixed brightness needs a brightness
  const fixed: BrightnessOverlay = { kind: 'fixed', at: now };
  // @ts-expect-error an inactive mode overlay has no since
  const inactive: ModeOverlay = { active: false, since: now };
  assert.equal([offScene, offEffect, litNoEffect, offLamp, offColour, dayPreset, candleUnsaid, candleNight, fixed, inactive].length, 10);
});
