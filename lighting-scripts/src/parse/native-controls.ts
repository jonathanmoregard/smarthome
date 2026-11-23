/**
 * Reads a person's native `light.turn_on` needs from Home Assistant's state:
 * a lamp's colour temperature range and a group's or zone's children.
 */
import type { HouseView } from '../runtime/effects.ts';
import { jinjaInt } from '../runtime/parse.ts';

/** A lamp's Kelvin range, `| int(6500)` / `| int(2000)` as the captured adapter reads it. */
export function lampKelvinRange(ctx: HouseView, lamp: string): { max: number; min: number } {
  return {
    max: jinjaInt(ctx.attr(lamp, 'max_color_temp_kelvin'), 6500),
    min: jinjaInt(ctx.attr(lamp, 'min_color_temp_kelvin'), 2000),
  };
}

/** A group or zone's children, `String`ed, when the attribute is a list. */
export function groupChildren(ctx: HouseView, entity: string, zone: boolean): string[] | undefined {
  const children = ctx.attr(entity, zone ? 'persons' : 'entity_id');
  return Array.isArray(children) ? children.map(String) : undefined;
}
