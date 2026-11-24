/**
 * What the dashboard shows of the Model: each scope's block selector, the
 * mode switch and each live control's light, moved from the schedule mirror
 * (`ls_room_plan`'s `mirror` and its mode mirror) and the UI sync (`uiMessages`
 * in `src/legacy/domain/ui-state.ts`). The adapter writes what changed.
 */
import type { EffectName } from './effect.ts';
import { blockPosition } from './schedule.ts';
import type { DashboardControlId, LampId, LampOrRoom } from './types/ids.ts';
import { entriesOf } from './types/ids.ts';
import type { Colour, Level, OnLight } from './types/light.ts';
import { sameColour } from './types/light.ts';
import { levelOrThrow } from './types/range.ts';
import type { Block, RoomOrHouse } from './types/schedule.ts';
import type { Instant } from './types/time.ts';
import type { LightingState } from './lighting-state.ts';
import type { Model } from './update.ts';

/**
 * The dashboard's view: the block each scope's selector shows (the held block,
 * or the scheduled one), whether the mode switch is on, and each control's light.
 */
export type DashboardView = { blockShown: Record<RoomOrHouse, Block>; modeOn: boolean; controls: readonly DashboardControlView[] };

export function dashboardView(model: Model, lighting: LightingState, now: Instant): DashboardView {
  const { config, overlays, modeOverlay } = model;
  const shown = (scope: RoomOrHouse): Block => {
    const held = overlays.blocks[scope];
    return held === undefined ? blockPosition(config, scope === 'house' ? undefined : scope, now).current : held.block;
  };
  const blockShown: Record<RoomOrHouse, Block> = { house: shown('house') };
  for (const [room] of entriesOf(config.rooms)) blockShown[room] = shown(room);
  return {
    blockShown,
    modeOn: modeOverlay.active,
    controls: entriesOf(config.controls).map(([control, over]) => ({ control, over, light: controlShown(model, lighting, over) })),
  };
}

/** A live control on the dashboard and the lamp or room it is over (the catalog's UI rows say which, at the edge). */
export type DashboardControl = { control: DashboardControlId; over: LampOrRoom };

export type DashboardControlView = DashboardControl & { light: ControlShown };

/**
 * What a control shows: off when every lamp under it is off; else on, at the
 * mean level of its lit lamps, with the colour and effect they share (none
 * where they differ).
 */
export type ControlShown = { power: 'off' } | { power: 'on'; level: Level; colour: Colour | undefined; effect: EffectName | undefined };

/** The light a control over a lamp or a room shows, from the lighting state of the lamps under it. */
function controlShown(model: Model, lighting: LightingState, over: LampOrRoom): ControlShown {
  const lamps: LampId[] = over.kind === 'lamp' ? [over.lamp]
    : entriesOf(model.config.lamps).flatMap(([lamp, placed]) => placed.room === over.room ? [lamp] : []);
  const lit = lamps.flatMap((lamp): OnLight[] => {
    const light = lighting.lamps[lamp];
    return light === undefined || light.power === 'off' ? [] : [light];
  });
  const [first] = lit;
  if (first === undefined) return { power: 'off' };
  const level = levelOrThrow(Math.round(lit.reduce((sum, light) => sum + light.level, 0) / lit.length));
  const colour = lit.every(light => sameColour(light.colour, first.colour)) ? first.colour : undefined;
  const effect = lit.every(light => light.effect.name === first.effect.name) ? first.effect.name : undefined;
  return { power: 'on', level, colour, effect };
}

