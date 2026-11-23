import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { ControlLight, Model, Msg, OverlayRequest, RemoteModel, RequestedLight } from '../../src/domain/model.ts';
import type { BrightnessOverlay, ColourOverlay, LampOverlay, ModeOverlay, RemotePreset } from '../../src/domain/overlays.ts';
import type { LampLight, SceneLight } from '../../src/domain/types/light.ts';
import { entriesOf } from '../../src/domain/types/ids.ts';
import { toBrightness, toDashboardControlId, toInstant, toKelvin, toLevel, toPercentRange } from '../../src/parse/ids.ts';
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

/** One dashboard request of each kind; a kind with no value here does not compile. */
const oneRequestOfEach = {
  'hold block': { kind: 'hold block', over: 'house', block: 'night' },
  'clear all': { kind: 'clear all' },
  'dashboard control': { kind: 'dashboard control', control: toDashboardControlId('control-a'), over: { kind: 'room', room: roomA },
    light: { power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'candle' } } },
  'room power': { kind: 'room power', room: roomA, power: 'off' },
} satisfies { [K in OverlayRequest['kind']]: Extract<OverlayRequest, { kind: K }> };

/** One message of each kind, built against the house; a kind with no value here does not compile. */
const oneOfEach = {
  clock: { kind: 'clock', now },
  configChanged: { kind: 'configChanged', config: house.config, at: now },
  overlayRequested: { kind: 'overlayRequested', request: oneRequestOfEach['hold block'], at: now },
  lampChangedByPerson: { kind: 'lampChangedByPerson', lamps: [lampA1], rooms: [],
    light: { power: 'on', brightness: toBrightness(80), colour: undefined, effect: undefined }, at: now },
  remotePressed: { kind: 'remotePressed', remote: remoteA, command: 'up', at: now },
  remoteButtonPressed: { kind: 'remoteButtonPressed', remote: remoteA, button: { kind: 'preset', button: 'warmest' }, at: now },
  rangeDefaultsSaved: { kind: 'rangeDefaultsSaved', defaults: { bright: toPercentRange(80, 100), cosy: toPercentRange(20, 50) }, at: now },
  switchButtonPressed: { kind: 'switchButtonPressed', switch: switchA, power: 'off', at: now },
  modeToggled: { kind: 'modeToggled', on: false, at: now },
  rangeSaved: { kind: 'rangeSaved', switch: switchA, rule: { kind: 'bright' }, at: now },
  lampProfileSaved: { kind: 'lampProfileSaved', lamp: lampA1, block: 'cosy', at: now,
    change: { own: false, power: undefined, brightness: undefined, colour: undefined, effect: undefined } },
  switchProfileSaved: { kind: 'switchProfileSaved', switch: switchA, block: 'day', change: { own: true, power: 'off' }, at: now },
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
  for (const request of Object.values(oneRequestOfEach)) assert.ok(request satisfies OverlayRequest);
});

test('a fixed brightness hold on a candle lamp leaves the candle running; a Normal overlay ends a block candle', () => {
  // Owner rule: a person's level or colour hold on a candle lamp keeps the
  // candle at the new level or colour; only choosing normal light ends it. So
  // the effect is a part of its own, beside brightness and colour.
  // Break: the candle goes back to being a kind of brightness or colour, so
  // the newer fixed brightness would replace it, and no overlay could say
  // Normal over a block's candle.
  const onLampA1 = house.overlays.lamps.flatMap(overlay => overlay.kind === 'parts' && overlay.over.kind === 'lamp' && overlay.over.lamp === lampA1 ? [overlay] : []);
  const candle = onLampA1.find(overlay => overlay.effect?.kind === 'candle');
  const level = onLampA1.find(overlay => overlay.brightness?.kind === 'fixed');
  assert.ok(candle !== undefined && level !== undefined && candle !== level);
  assert.ok(level.brightness!.at > candle.effect!.at, 'the level hold is the newer part');
  assert.equal(level.effect, undefined, 'the level hold leaves the effect alone');

  const roomCosy = house.config.rooms[roomA]!.blocks.cosy.light;
  assert.equal(roomCosy.follows === 'own' && roomCosy.own?.power === 'on' ? roomCosy.own.effect : 'not lit', 'Candle');
  const normalOverRoom = house.overlays.lamps.find(overlay => overlay.over.kind === 'room' && overlay.over.room === roomA);
  assert.equal(normalOverRoom?.kind === 'parts' ? normalOverRoom.effect?.kind : 'not parts', 'normal');
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
  // @ts-expect-error the candle is the effect part, not a kind of brightness
  const candleBrightness: BrightnessOverlay = { kind: 'candle', at: now };
  // @ts-expect-error the candle is the effect part, not a kind of colour
  const candleColour: ColourOverlay = { kind: 'candle', at: now };
  // @ts-expect-error a person asks for the candle or the normal light, never the schedule's effect
  const scheduleRequested: RequestedLight = { power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'schedule' } };
  // @ts-expect-error a person's off has no level, colour or effect
  const offWithLevel: RequestedLight = { power: 'off', brightness: toBrightness(80) };
  const offOverlayLevel: LampOverlay = { kind: 'off', over: { kind: 'lamp', lamp: lampA1 }, from: { kind: 'person' }, since: now,
    // @ts-expect-error an off overlay holds no level, colour or effect (owner, 2026-11-23)
    brightness: { kind: 'fixed', brightness, at: now } };
  // @ts-expect-error a dashboard off has no level, colour or effect
  const controlOffLevel: ControlLight = { power: 'off', brightness: { kind: 'schedule' } };
  const stamped: ControlLight = { power: 'on',
    // @ts-expect-error a dashboard request carries no instants: update stamps them
    brightness: { kind: 'fixed', brightness, at: now }, colour: undefined, effect: undefined };
  const asPerson: OverlayRequest = {
    kind: 'dashboard control', control: toDashboardControlId('control-a'), over: { kind: 'lamp', lamp: lampA1 },
    light: { power: 'on', brightness: undefined, colour: undefined, effect: { kind: 'normal' } },
    // @ts-expect-error a dashboard request cannot claim to come from a person
    from: { kind: 'person' },
  };
  // @ts-expect-error a chord in progress ends at a deadline
  const chordForever: RemoteModel['chord'] = { active: true, progress: 'power' };
  // @ts-expect-error a burst of power presses counts at most three
  const fourPresses: RemoteModel['power'] = { presses: 4, until: now };
  // @ts-expect-error an inactive mode overlay has no since
  const inactive: ModeOverlay = { active: false, since: now };
  assert.equal([offScene, offEffect, litNoEffect, offLamp, offColour, dayPreset, candleUnsaid, candleNight, fixed, candleBrightness,
    candleColour, scheduleRequested, offWithLevel, offOverlayLevel, controlOffLevel, stamped, asPerson, chordForever, fourPresses, inactive].length, 20);
});
