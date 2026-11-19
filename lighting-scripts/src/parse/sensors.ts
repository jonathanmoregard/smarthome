/**
 * Readers for `sensor.ls_overrides`'s attributes.
 *
 * One reader per spelling the captured scripts use, and they are deliberately
 * not unified: the lenient `.get(key, {})` reads treat a non-mapping as empty,
 * while `controller`'s strict read raises on one. Collapsing the two would move
 * a raise or swallow one.
 */
import type { ScriptContext } from '../runtime/context.ts';
import { object } from '../runtime/parse.ts';
import { storedOverrides } from './overrides.ts';
import type { StoredOverrides } from './overrides.ts';

export const OVERRIDES_SENSOR = 'sensor.ls_overrides';

/** `state_attr('sensor.ls_overrides', 'overrides')` read leniently: a non-mapping is `{}`. */
export function lenientOverrides(ctx: ScriptContext): StoredOverrides {
  return storedOverrides(object(ctx.attr(OVERRIDES_SENSOR, 'overrides')));
}
