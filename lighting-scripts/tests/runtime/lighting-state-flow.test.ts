import assert from 'node:assert/strict';
import test from 'node:test';
import { blend } from '../../src/domain/blend.ts';
import { bulbAppearance, candle, normal } from '../../src/domain/effect.ts';
import { lightingState, MODE_COLOUR, nextChange, overlaysOn } from '../../src/domain/lighting-state.ts';
import type { LitLight, Model } from '../../src/domain/model.ts';
import type { LampOverlay, RemoteAdjustment, RemoteOverlay } from '../../src/domain/overlays.ts';
import { IDLE_REMOTE } from '../../src/domain/remote.ts';
import { sceneBetween } from '../../src/domain/schedule.ts';
import type { LampId } from '../../src/domain/types/ids.ts';
import type { Colour, LampLight, OnLight } from '../../src/domain/types/light.ts';
import { blendPositionOrThrow } from '../../src/domain/types/range.ts';
import type { Instant } from '../../src/domain/types/time.ts';
import {
  toBrightness, toBulbId, toColourChannel, toDashboardControlId, toInstant, toKelvin, toLampId, toLevel, toMinutes, toProgress,
  toRemoteId, toRoomId, toSeconds, toStep, toStepCount, toSwitchId, toTimeOfDay,
} from '../../src/parse/ids.ts';
import { syntheticHouse } from './fixtures/synthetic-house.ts';

/**
 * The lighting state: the schedule with every overlay over it (M1 plan, "The
 * overlay flow the types must carry", items 1 to 7, and the gaps listed after
 * it). Every test starts from the synthetic house with its overlays taken away
 * and changes one thing.
 *
 * The house, in UTC, on Monday 2026-09-21: day 07:00 (fade 20 min), 220 at
 * 4000 K; cosy 18:00 (fade 30), 120 at 2700 K; night 22:30 (fade 30), off.
 * `room-a` has its own cosy from 17:30 (fade 45, so from 16:45), 90 in an
 * orange RGB, running the candle. `light.lamp_a1` has a candle bulb and a
 * stock bulb, and its own colourless cosy profile running the candle;
 * `light.lamp_a2` has one stock bulb; `light.lamp_b1` is in the private
 * `room-b`. The next-block reset is on.
 */

const at = (time: string, day = 21): Instant => toInstant(Date.parse(`2026-09-${day}T${time}Z`) / 1000);
const kelvin = (value: number): Colour => ({ kind: 'kelvin', kelvin: toKelvin(value) });
const rgb = (red: number, green: number, blue: number): Colour =>
  ({ kind: 'rgb', rgb: { red: toColourChannel(red), green: toColourChannel(green), blue: toColourChannel(blue) } });
const lit = (brightness: number, colour: Colour | undefined, effect: 'Candle' | 'Normal' = 'Normal'): LitLight =>
  ({ power: 'on', brightness: toBrightness(brightness), colour, effect });

const MANUAL = { kind: 'manual' } as const;
const FADING = { kind: 'scheduled fade', over: toSeconds(60) } as const;
const shows = (level: number, colour: Colour | undefined, effect: OnLight['effect'] = normal, transition: OnLight['transition'] = MANUAL): LampLight =>
  ({ power: 'on', level: toLevel(level), colour, effect, transition });
const OFF: LampLight = { power: 'off' };

const lampA1 = toLampId('light.lamp_a1'), lampA2 = toLampId('light.lamp_a2'), lampB1 = toLampId('light.lamp_b1');
const roomA = toRoomId('room-a'), roomB = toRoomId('room-b');
const DAY_LIGHT = lit(220, kelvin(4000)), ROOM_A_COSY = lit(90, rgb(255, 150, 60), 'Candle');
const ORANGE = rgb(255, 150, 60), WARM_END = rgb(255, 126, 0);

/** The synthetic house with no overlays, the mode overlay off and every remote idle; `change` makes the test's one change. */
function house(change: (model: Model) => void = () => {}): Model {
  const model = structuredClone(syntheticHouse());
  model.overlays = { blocks: {}, remotes: [], lamps: [], roomPower: {}, switches: {} };
  model.modeOverlay = { active: false };
  model.remotes = { [toRemoteId('remote-a')]: IDLE_REMOTE, [toRemoteId('remote-b')]: IDLE_REMOTE };
  change(model);
  return model;
}

function lamp(model: Model, id: LampId, now: Instant): LampLight | undefined {
  return lightingState(model, now).lamps[id];
}

type PartsOverlay = Extract<LampOverlay, { kind: 'parts' }>;
const person = (over: LampOverlay['over'], parts: Partial<Pick<PartsOverlay, 'brightness' | 'colour' | 'effect'>>, since: Instant): LampOverlay =>
  ({ kind: 'parts', over, from: { kind: 'person' }, since, brightness: undefined, colour: undefined, effect: undefined, ...parts });
const dashboard = (over: LampOverlay['over'], parts: Partial<Pick<PartsOverlay, 'brightness' | 'colour' | 'effect'>>, since: Instant): LampOverlay =>
  ({ ...person(over, parts, since), from: { kind: 'dashboard', control: toDashboardControlId('control-x') } });
/** A person's off in Home Assistant, held over a lamp or a room. */
const switchedOff = (over: LampOverlay['over'], since: Instant): LampOverlay => ({ kind: 'off', over, from: { kind: 'person' }, since });
const onLamp = (id: LampId) => ({ kind: 'lamp', lamp: id }) as const;
const fixed = (brightness: number, setAt: Instant) => ({ kind: 'fixed', brightness: toBrightness(brightness), at: setAt }) as const;

function steps(count: number, setAt: Instant, lower = -20, upper = 20): RemoteAdjustment {
  return {
    steps: toStepCount(count), lower: toStep(Math.max(-20, lower)), upper: toStep(Math.min(20, upper)), from: 'current', at: setAt,
    lastPress: count < 0 ? 'down' : 'up', everBrighter: count > 0,
  };
}
function remote(id: string, since: Instant, parts: Partial<RemoteOverlay>): RemoteOverlay {
  return {
    remote: toRemoteId(id), room: roomA, since, stepRange: { min: toStep(-20), max: toStep(20) }, adjustment: undefined,
    preset: { choice: 'none' }, remembered: {}, ...parts,
  };
}

// 1. Schedule.

test('a lamp shows its room\'s block light', () => {
  // Break: the lamp reads the house's light where its room has its own, or its own light where it follows its room.
  const model = house();
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(220, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(90, ORANGE));
  assert.deepEqual(lamp(model, lampB1, at('20:00:00')), shows(120, kelvin(2700)));
  assert.deepEqual(lamp(model, lampA2, at('23:30:00')), OFF);
});

test('during a fade it is between the two', () => {
  // Break: a fade jumps to either end, or its transition is not the scheduled fade's one-minute move.
  const model = house();
  assert.deepEqual(lamp(model, lampB1, at('17:45:00')), shows(170, kelvin(3350), normal, FADING));
});

test('a lamp with its own profile shows that', () => {
  // Break: the lamp's own profile is ignored for its room's light.
  const model = house(m => { m.lampProfiles[lampA2] = { ...m.lampProfiles[lampA2]!, day: { follows: 'own', own: { power: 'on', light: lit(60, kelvin(3000)) } } }; });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(60, kelvin(3000)));
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(220, kelvin(4000)));
});

// Rule 2: a lit light with no colour.

test('a lit light with no colour takes the colour of the block it is in', () => {
  // Break: the colourless profile reaches the lamp with no colour while its block's light has one.
  const model = house(m => { m.lampProfiles[lampA2] = { ...m.lampProfiles[lampA2]!, cosy: { follows: 'own', own: { power: 'on', light: lit(70, undefined) } } }; });
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(70, ORANGE));
});

test('with none there it keeps the colour of the newest earlier block that has one', () => {
  // Break: the fallback stops at the block itself, or takes an older block over the newest.
  const model = house(m => { m.config.house.cosy.light = lit(120, undefined); });
  assert.deepEqual(lamp(model, lampB1, at('20:00:00')), shows(120, kelvin(4000)));
});

test('a held block looks back from itself, not from the scheduled block', () => {
  // Cosy held over `room-b` at noon on Monday, cosy colourless, night lit at 2000 K. The block before cosy is day,
  // so its 4000 K. Break: the look-back starts from the scheduled day and takes the night before it.
  const model = house(m => {
    m.config.house.cosy.light = lit(120, undefined);
    m.config.house.night.light = lit(30, kelvin(2000));
    m.overlays.blocks[roomB] = { block: 'cosy', since: at('11:00:00') };
  });
  assert.deepEqual(lamp(model, lampB1, at('12:00:00')), shows(120, kelvin(4000)));
});

test('with no colour in any block the lamp has none, and each bulb keeps its own', () => {
  // Break: a colour is invented (white, the warm end) where the schedule names none.
  const model = house(m => { m.config.house.day.light = lit(220, undefined); m.config.house.cosy.light = lit(120, undefined); });
  const shown = lamp(model, lampB1, at('12:00:00'));
  assert.deepEqual(shown, shows(220, undefined));
  assert.deepEqual(bulbAppearance(shown!, { bulb: toBulbId('bulb-b1'), firmware: 'stock' }),
    { power: 'on', level: toLevel(220), colour: undefined, firmwareEffect: 'none' });
});

// 2. Which block.

test('a block held over a room replaces its scheduled block', () => {
  // Break: the hold is ignored, or reaches another room.
  const model = house(m => { m.overlays.blocks[roomA] = { block: 'cosy', since: at('11:00:00') }; });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(90, ORANGE));
  assert.deepEqual(lamp(model, lampB1, at('12:00:00')), shows(220, kelvin(4000)));
});

test('over the house it reaches every room but not as a room\'s own', () => {
  // The house's hold reaches a room through the room's own hold, which holding a block over the house also
  // writes for every room (today's `planOverrideBlock`, M3). On its own it reaches the lamps in no room.
  // Break: a room's lamps read the house's hold as their own, or a lamp in no room ignores it.
  const lampC = toLampId('light.lamp_c');
  const model = house(m => {
    m.config.lamps[lampC] = { room: undefined, bulbs: [{ bulb: toBulbId('bulb-c'), firmware: 'stock' }] };
    m.overlays.blocks.house = { block: 'cosy', since: at('11:00:00') };
  });
  assert.deepEqual(lamp(model, lampC, at('12:00:00')), shows(120, kelvin(2700)));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(220, kelvin(4000)));
  model.overlays.blocks[roomA] = { block: 'cosy', since: at('11:00:00') };
  model.overlays.blocks[roomB] = { block: 'cosy', since: at('11:00:00') };
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(90, ORANGE));
  assert.deepEqual(lamp(model, lampB1, at('12:00:00')), shows(120, kelvin(2700)));
});

test('a remote\'s day preset holds day like a block overlay, and the newer of the two wins', () => {
  // Break: the preset is ignored, or the older of the preset and the block overlay wins.
  const preset = remote('remote-a', at('19:00:00'), { preset: { choice: 'day', since: at('19:00:00') } });
  const model = house(m => { m.overlays.remotes = [preset]; });
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(220, kelvin(4000)));
  model.overlays.blocks[roomA] = { block: 'night', since: at('19:30:00') };
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), OFF);
  model.overlays.blocks[roomA] = { block: 'night', since: at('18:30:00') };
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(220, kelvin(4000)));
});

// 3. Brightness and colour, separately.

test('a person\'s fixed brightness holds across a block start while colour follows the schedule', () => {
  // With the next-block reset off, so the hold outlives the block start.
  // Break: the hold takes the colour with it, or the schedule's new block takes the brightness back.
  const model = house(m => {
    m.config.overlayReset.atNextBlock = false;
    m.overlays.lamps = [person(onLamp(lampA2), { brightness: fixed(50, at('12:00:00')) }, at('12:00:00'))];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(50, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(50, ORANGE));
});

test('a dashboard control\'s candle shows the candle on that lamp only', () => {
  // The candle holds the warm end, as today's candle does when it starts.
  // Break: the candle reaches the other lamps of the room, or runs in the schedule's colour.
  const model = house(m => { m.overlays.lamps = [dashboard(onLamp(lampA1), { effect: { kind: 'candle', at: at('12:00:00') } }, at('12:00:00'))]; });
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), shows(220, WARM_END, candle));
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(220, kelvin(4000)));
});

test('a newer brightness or colour keeps the candle running at it; only a newer normal light ends it', () => {
  // Owner, 2026-11-22: "sure, both color and intensity". Break: a newer level or colour ends the candle.
  const lit12 = dashboard(onLamp(lampA1), { effect: { kind: 'candle', at: at('12:00:00') } }, at('12:00:00'));
  const level = person(onLamp(lampA1), { brightness: fixed(60, at('12:10:00')), colour: { kind: 'fixed', colour: kelvin(3000), at: at('12:10:00') } },
    at('12:10:00'));
  const model = house(m => { m.overlays.lamps = [lit12, level]; });
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), shows(60, kelvin(3000), candle));
  model.overlays.lamps = [lit12, level, dashboard(onLamp(lampA1), { effect: { kind: 'normal', at: at('12:20:00') } }, at('12:20:00'))];
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), shows(60, kelvin(3000)));
});

test('the newer of two overlays on a lamp wins per part', () => {
  // Break: the newer overlay wins whole, taking the older one's colour away, or the older wins.
  const model = house(m => {
    m.overlays.lamps = [
      person(onLamp(lampA2), { brightness: fixed(80, at('12:10:00')) }, at('12:10:00')),
      dashboard(onLamp(lampA2), { brightness: fixed(40, at('12:00:00')), colour: { kind: 'fixed', colour: kelvin(3000), at: at('12:00:00') } },
        at('12:00:00')),
    ];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(80, kelvin(3000)));
});

test('a part handed back to the schedule shows the schedule over older overlays', () => {
  // Break: a part handed back is read as "no change" and the older fixed value shows.
  const older = dashboard(onLamp(lampA2), { brightness: fixed(40, at('12:00:00')) }, at('12:00:00'));
  const model = house(m => { m.overlays.lamps = [older, person(onLamp(lampA2), { brightness: { kind: 'schedule', at: at('12:10:00') } }, at('12:10:00'))]; });
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(220, kelvin(4000)));
  model.overlays.lamps = [dashboard(onLamp(lampA2), { brightness: fixed(40, at('12:20:00')) }, at('12:20:00')),
    person(onLamp(lampA2), { brightness: { kind: 'schedule', at: at('12:10:00') } }, at('12:10:00'))];
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(40, kelvin(4000)));
});

test('a room overlay reaches every lamp in the room', () => {
  // Break: a room overlay reaches no lamp, or one in another room.
  const model = house(m => { m.overlays.lamps = [person({ kind: 'room', room: roomA }, { brightness: fixed(30, at('12:00:00')) }, at('12:00:00'))]; });
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), shows(30, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(30, kelvin(4000)));
  assert.deepEqual(lamp(model, lampB1, at('12:30:00')), shows(220, kelvin(4000)));
});

// 3.2 The remote.

/** The light of `light.lamp_a2` at a place on its day-cosy blend, as the remote steps it at noon. */
function onTheBlend(position: number): LampLight {
  const light = blend(DAY_LIGHT, ROOM_A_COSY, blendPositionOrThrow(position), { red: toColourChannel(255), green: toColourChannel(126), blue: toColourChannel(0) });
  if (light === undefined || light.power === 'off') throw new Error('the blend at noon is lit');
  return shows(Math.min(254, light.brightness), light.colour);
}

test('brighter moves every lamp in the room up the blend, dimmer down', () => {
  // At noon the room is at day, 1 on the blend; three steps are 0.3.
  // Break: the step moves the wrong way, misses a lamp of the room, or reaches another room.
  // `light.lamp_a1` follows its room in cosy here, so both lamps share the room's blend.
  const brighter = house(m => {
    m.lampProfiles[lampA1] = { ...m.lampProfiles[lampA1]!, cosy: { ...m.lampProfiles[lampA1]!.cosy, follows: 'room' } };
    m.overlays.remotes = [remote('remote-a', at('11:00:00'), { adjustment: steps(3, at('11:00:00'), -17, 20) })];
  });
  assert.deepEqual(lamp(brighter, lampA2, at('12:00:00')), shows(230, kelvin(4750)));
  assert.deepEqual(lamp(brighter, lampA1, at('12:00:00')), shows(230, kelvin(4750)));
  assert.deepEqual(lamp(brighter, lampB1, at('12:00:00')), shows(220, kelvin(4000)));
  const dimmer = house(m => { m.overlays.remotes = [remote('remote-a', at('11:00:00'), { adjustment: steps(-3, at('11:00:00'), -20, 17) })]; });
  assert.deepEqual(lamp(dimmer, lampA2, at('12:00:00')), onTheBlend(0.7));
  assert.equal((lamp(dimmer, lampA2, at('12:00:00')) as OnLight).level, 181);
});

test('only the newest remote\'s overlay in a room applies', () => {
  // Break: an older remote's steps add to the newer one's, or win.
  const model = house(m => {
    m.overlays.remotes = [
      remote('remote-b', at('11:30:00'), { adjustment: steps(-3, at('11:30:00'), -20, 17) }),
      remote('remote-a', at('11:00:00'), { adjustment: steps(3, at('11:00:00'), -17, 20) }),
    ];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), onTheBlend(0.7));
});

test('of two remote overlays set at the same instant, the one whose remote id sorts last applies', () => {
  // Amendment 6.4: the tie goes by the remote's id, not by the source its overlay is saved under.
  // Break: the first one listed wins, or the tie reads a field the overlay no longer has.
  const tied = (first: string, second: string) => house(m => {
    m.overlays.remotes = [
      remote(first, at('11:00:00'), { adjustment: steps(first === 'remote-b' ? -3 : 3, at('11:00:00'), -20, 20) }),
      remote(second, at('11:00:00'), { adjustment: steps(second === 'remote-b' ? -3 : 3, at('11:00:00'), -20, 20) }),
    ];
  });
  assert.deepEqual(lamp(tied('remote-a', 'remote-b'), lampA2, at('12:00:00')), onTheBlend(0.7));
  assert.deepEqual(lamp(tied('remote-b', 'remote-a'), lampA2, at('12:00:00')), onTheBlend(0.7));
});

test('a lamp steps from its room\'s place on the blend, not from its own level', () => {
  // Rule 4 and today's room-first order: the room at day places three steps at 1.3, and a lamp held dimmer uses that place.
  // Break: each lamp places the step from its own level (100 here would place it near cosy).
  const model = house(m => {
    m.overlays.lamps = [person(onLamp(lampA2), { brightness: fixed(100, at('10:00:00')) }, at('10:00:00'))];
    m.overlays.remotes = [remote('remote-a', at('11:00:00'), { adjustment: steps(3, at('11:00:00'), -17, 20) })];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(230, kelvin(4750)));
});

test('dimming from below cosy with no brighter press never brightens a lamp', () => {
  // The room held at 40, below cosy's 76.5 floor; one dimmer press lands on the blend's floor (76) above it.
  // Break: the dim-below-cosy rule is lost and the dimmer press brightens the room to the blend's floor.
  const model = house(m => {
    m.overlays.lamps = [person({ kind: 'room', room: roomA }, { brightness: fixed(40, at('19:00:00')) }, at('19:00:00'))];
    m.overlays.remotes = [remote('remote-a', at('19:30:00'), { adjustment: steps(-1, at('19:30:00'), -20, 19) })];
  });
  assert.equal((lamp(model, lampA2, at('20:00:00')) as OnLight).level, 40);
});

test('a step leaves a lamp whose blend has a lit end with no colour', () => {
  // `light.lamp_a1`'s own cosy light names no colour, so its blend gives nothing (today: no anchors) while its room's moves.
  // Break: the lamp is moved along a blend that has no colour at one end, or the room's place is not shared.
  const model = house(m => { m.overlays.remotes = [remote('remote-a', at('11:00:00'), { adjustment: steps(3, at('11:00:00'), -17, 20) })]; });
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(220, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(230, kelvin(4750)));
});

test('steps beyond day and below cosy stay inside the step range', () => {
  // Twenty steps from day would be 3, clamped to the blend's 2; inside a range of -5..5 they stop at 0.5, and down at -0.5.
  // Break: the step range is not applied, or applied to the step count instead of the place on the blend.
  const up = house(m => { m.overlays.remotes = [remote('remote-a', at('11:00:00'), { adjustment: steps(20, at('11:00:00')) })]; });
  assert.deepEqual(lamp(up, lampA2, at('12:00:00')), onTheBlend(2));
  const narrow = { min: toStep(-5), max: toStep(5) };
  const inside = house(m => { m.overlays.remotes = [remote('remote-a', at('11:00:00'), { stepRange: narrow, adjustment: steps(20, at('11:00:00')) })]; });
  assert.deepEqual(lamp(inside, lampA2, at('12:00:00')), onTheBlend(0.5));
  const below = house(m => { m.overlays.remotes = [remote('remote-a', at('11:00:00'), { stepRange: narrow, adjustment: steps(-20, at('11:00:00')) })]; });
  assert.deepEqual(lamp(below, lampA2, at('12:00:00')), onTheBlend(-0.5));
});

test('a remote step does nothing on a lamp running the candle', () => {
  // Today's catalog: the candle's remote_adjustment is `ignore`. Break: the step moves the candle lamp's level.
  // `light.lamp_a1` follows its room in cosy here, so its blend could move it.
  const model = house(m => {
    m.lampProfiles[lampA1] = { ...m.lampProfiles[lampA1]!, cosy: { ...m.lampProfiles[lampA1]!.cosy, follows: 'room' } };
    m.overlays.lamps = [dashboard(onLamp(lampA1), { effect: { kind: 'candle', at: at('11:00:00') } }, at('11:00:00'))];
    m.overlays.remotes = [remote('remote-a', at('11:30:00'), { adjustment: steps(3, at('11:30:00'), -17, 20) })];
  });
  assert.deepEqual(lamp(model, lampA1, at('12:00:00')), shows(220, WARM_END, candle));
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(230, kelvin(4750)));
});

// 4. The mode overlay.

test('the mode overlay colours every lamp outside private rooms', () => {
  // Break: the mode colour misses a lamp, or reaches the private room.
  const model = house(m => { m.modeOverlay = { active: true, since: at('12:00:00') }; });
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), shows(220, MODE_COLOUR));
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(220, MODE_COLOUR));
  assert.deepEqual(lamp(model, lampB1, at('12:30:00')), shows(220, kelvin(4000)));
  assert.deepEqual(MODE_COLOUR, rgb(255, 105, 180));
});

test('the mode overlay does nothing in the night block', () => {
  // A lamp lit at night by its own night profile, so there is a colour to keep. Break: the mode colours a lamp at night.
  const model = house(m => {
    m.lampProfiles[lampA2] = { ...m.lampProfiles[lampA2]!, night: { follows: 'own', own: { power: 'on', light: lit(30, kelvin(3000)) } } };
    m.modeOverlay = { active: true, since: at('23:00:00') };
  });
  assert.deepEqual(lamp(model, lampA2, at('23:30:00')), shows(30, kelvin(3000)));
});

// 5. Room power.

test('a room switched off is off whatever its overlays say', () => {
  // Break: a lamp overlay switches a lamp of a room that is off back on, or the power reaches another room.
  const model = house(m => {
    m.overlays.roomPower[roomA] = 'off';
    m.overlays.lamps = [person(onLamp(lampA2), { brightness: fixed(200, at('12:00:00')) }, at('12:00:00'))];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), OFF);
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), OFF);
  assert.deepEqual(lamp(model, lampB1, at('12:30:00')), shows(220, kelvin(4000)));
});

// 5.1 A person's off (owner, 2026-11-23: a person's off in HA is a hold).

test("a person's off holds the lamp off over its lit block", () => {
  // Break: the off hold is ignored, so the lamp shows its block light, or it reaches the other lamps of the room.
  const model = house(m => { m.overlays.lamps = [switchedOff(onLamp(lampA2), at('12:00:00'))]; });
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), OFF);
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), shows(220, kelvin(4000)));
});

test('a later brightness, colour or effect, from anyone, ends the off hold', () => {
  // Break: a newer part leaves the lamp off, or an older part ends a newer off.
  const off = switchedOff(onLamp(lampA2), at('12:00:00'));
  const brighter = house(m => { m.overlays.lamps = [off, dashboard(onLamp(lampA2), { brightness: fixed(80, at('12:10:00')) }, at('12:10:00'))]; });
  assert.deepEqual(lamp(brighter, lampA2, at('12:30:00')), shows(80, kelvin(4000)));
  const coloured = house(m => {
    m.overlays.lamps = [off, person(onLamp(lampA2), { colour: { kind: 'fixed', colour: kelvin(3000), at: at('12:10:00') } }, at('12:10:00'))];
  });
  assert.deepEqual(lamp(coloured, lampA2, at('12:30:00')), shows(220, kelvin(3000)));
  const older = house(m => { m.overlays.lamps = [dashboard(onLamp(lampA2), { brightness: fixed(80, at('11:50:00')) }, at('11:50:00')), off]; });
  assert.deepEqual(lamp(older, lampA2, at('12:30:00')), OFF);
});

test('a room switched off by a person, then a colour on one lamp, lights that lamp only', () => {
  // Carry-over 1.3: the off is its own flag, so a colour change, which leaves `lit` alone, still ends it.
  // Break: the off rides on `lit` and the colour leaves the lamp off, or the colour lights the whole room.
  const model = house(m => {
    m.overlays.lamps = [
      switchedOff({ kind: 'room', room: roomA }, at('12:00:00')),
      person(onLamp(lampA2), { colour: { kind: 'fixed', colour: kelvin(3000), at: at('12:10:00') } }, at('12:10:00')),
    ];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(220, kelvin(3000)));
  assert.deepEqual(lamp(model, lampA1, at('12:30:00')), OFF);
  assert.deepEqual(lamp(model, lampB1, at('12:30:00')), shows(220, kelvin(4000)));
});

test('a later remote step ends the off hold', () => {
  // Break: the step leaves the lamp off under an older off.
  const model = house(m => {
    m.overlays.lamps = [switchedOff({ kind: 'room', room: roomA }, at('11:00:00'))];
    m.overlays.remotes = [remote('remote-a', at('11:30:00'), { adjustment: steps(3, at('11:30:00'), -17, 20) })];
  });
  assert.deepEqual(lamp(model, lampA2, at('12:00:00')), shows(230, kelvin(4750)));
});

test("the next block's fade start releases the off hold", () => {
  // `room-a`'s cosy fade starts at 16:45. Break: the off outlives the fade start.
  const model = house(m => { m.overlays.lamps = [switchedOff(onLamp(lampA2), at('12:00:00'))]; });
  assert.deepEqual(lamp(model, lampA2, at('16:00:00')), OFF);
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(90, ORANGE));
});

test("a room's off hold leaves its range switch as the room's light has it", () => {
  // Keep today (review ruling): the plug's range rule (20..60 %) reads its room's own light, cosy's 90 at 20:00, and
  // a person's off is not part of that light. Break: the off turns the room's light off and the plug with it.
  const model = house(m => { m.overlays.lamps = [switchedOff({ kind: 'room', room: roomA }, at('19:00:00'))]; });
  assert.equal(lightingState(house(), at('20:00:00')).switches[toSwitchId('switch.plug_a')], 'on');
  assert.equal(lightingState(model, at('20:00:00')).switches[toSwitchId('switch.plug_a')], 'on');
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), OFF);
});

// 7. Overlay resets.

const heldAtNoon = person(onLamp(lampA2), { brightness: fixed(50, at('12:00:00')) }, at('12:00:00'));

test('with the next-block rule on, an overlay set before the last fade start no longer applies', () => {
  // `room-a`'s cosy fade starts at 16:45. Break: the hold outlives the fade start, or ends before it.
  const model = house(m => { m.overlays.lamps = [heldAtNoon]; });
  assert.deepEqual(lamp(model, lampA2, at('16:00:00')), shows(50, kelvin(4000)));
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(90, ORANGE));
  assert.equal(overlaysOn(model, lampA2, at('16:00:00')).lamps.length, 1);
  assert.equal(overlaysOn(model, lampA2, at('20:00:00')).lamps.length, 0);
});

test('during that fade the lamp fades out of the held light', () => {
  // Half way through 16:45-17:30: between the held 50 at 4000 K and the cosy 90 in orange, not between day and cosy.
  // Break: the lamp jumps to the schedule's fade at the fade start, or stays held to the block start.
  const model = house(m => { m.overlays.lamps = [heldAtNoon]; });
  const between = sceneBetween(lit(50, kelvin(4000)), ROOM_A_COSY, toProgress(0.5));
  if (between.power === 'off') throw new Error('lit');
  assert.deepEqual(lamp(model, lampA2, at('17:07:30')), shows(70, between.colour, normal, FADING));
  assert.equal(overlaysOn(model, lampA2, at('17:07:30')).fadingOut, true);
});

test('with the next-block rule off the overlay holds', () => {
  // Break: the overlay is released at the fade start with the rule off.
  const model = house(m => { m.config.overlayReset.atNextBlock = false; m.overlays.lamps = [heldAtNoon]; });
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(50, ORANGE));
});

// The wake light.

test('a room\'s lamps follow the wake fade before the day block', () => {
  // `room-b` wakes at 06:00 on Tuesday over 30 minutes; day starts at 07:00. At 06:15 the wake is half way, ramping up from off.
  // Break: the wake light is ignored, or reaches another room.
  const model = house(m => { m.config.rooms[roomB]!.wakeLight = { at: at('06:00:00', 22), fade: toMinutes(30) }; });
  assert.deepEqual(lamp(model, lampB1, at('06:15:00', 22)), shows(110, kelvin(4000), normal, FADING));
  assert.deepEqual(lamp(model, lampA2, at('06:15:00', 22)), OFF);
});

// The candle.

test('a candle lamp with no candle bulb shows its normal light', () => {
  // `room-a`'s cosy runs the candle. Break: a lamp with only stock bulbs is given the candle, or the candle's warm end.
  const model = house();
  assert.deepEqual(lamp(model, lampA2, at('20:00:00')), shows(90, ORANGE));
  model.overlays.lamps = [dashboard(onLamp(lampA2), { effect: { kind: 'candle', at: at('12:00:00') } }, at('12:00:00'))];
  assert.deepEqual(lamp(model, lampA2, at('12:30:00')), shows(220, kelvin(4000)));
});

test('a lamp with one candle bulb shows the candle; its stock bulb shows the normal light', () => {
  // Rule 3: the candle shows where some bulb can run it. Break: a mixed lamp loses the candle on every bulb.
  const model = house();
  const shown = lamp(model, lampA1, at('20:00:00'));
  assert.deepEqual(shown, shows(100, WARM_END, candle));
  assert.deepEqual(bulbAppearance(shown!, { bulb: toBulbId('bulb-a1'), firmware: 'candle' }),
    { power: 'on', level: toLevel(100), colour: WARM_END, firmwareEffect: 'candle' });
  assert.deepEqual(bulbAppearance(shown!, { bulb: toBulbId('bulb-a2'), firmware: 'stock' }),
    { power: 'on', level: toLevel(100), colour: WARM_END, firmwareEffect: 'none' });
});

test('the synthetic house with its overlays has a light for every lamp and a power for its switch', () => {
  // Break: some overlay of the fixture makes the lighting state raise or leave a lamp out.
  const state = lightingState(syntheticHouse(), at('15:30:00'));
  assert.deepEqual(Object.keys(state.lamps).sort(), [lampA1, lampA2, lampB1]);
  assert.equal(state.lamps[lampB1]!.power, 'off');
  assert.equal(state.lamps[lampA1]!.power === 'on' && state.lamps[lampA1]!.effect, candle);
  assert.deepEqual(Object.keys(state.switches), ['switch.plug_a']);
});

// nextChange.

test('nextChange is the next fade minute during a fade, else the next fade start, wake time or reset', () => {
  // Break: a fade is not stepped each minute, or a start, a wake or a reset falling due is missed.
  const plain = house();
  assert.equal(nextChange(plain, at('12:00:30')), at('16:45:00'));
  assert.equal(nextChange(plain, at('16:50:10')), at('16:51:00'));
  const waking = house(m => { m.config.rooms[roomB]!.wakeLight = { at: at('06:00:00', 22), fade: toMinutes(30) }; });
  assert.equal(nextChange(waking, at('23:00:00')), at('06:00:00', 22));
  assert.equal(nextChange(waking, at('06:10:20', 22)), at('06:11:00', 22));
  const aged = house(m => { m.overlays.lamps = [heldAtNoon]; });
  assert.equal(nextChange(aged, at('12:00:30')), at('15:00:00'));
  const daily = house(m => { m.config.overlayReset.atSetTime = toTimeOfDay(14, 0); });
  assert.equal(nextChange(daily, at('12:00:30')), at('14:00:00'));
});
