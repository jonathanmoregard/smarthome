/**
 * Readers for `sensor.ls_overrides`'s attributes.
 *
 * One reader per spelling the captured scripts use, and they are deliberately
 * not unified: the lenient `.get(key, {})` reads treat a non-mapping as empty,
 * while `controller`'s strict read raises on one. Collapsing the two would move
 * a raise or swallow one.
 */
import type { HouseView } from '../runtime/effects.ts';
import { object, ParseError } from '../runtime/parse.ts';
import { opaqueMap, storedFact, storedOverrides } from './overrides.ts';
import type { OpaqueMap, StoredFact, StoredOverrides, StoredValue } from './overrides.ts';

export const OVERRIDES_SENSOR = 'sensor.ls_overrides';

/** `state_attr('sensor.ls_overrides', 'overrides')` read leniently: a non-mapping is `{}`. */
export function lenientOverrides(ctx: HouseView): StoredOverrides {
  return storedOverrides(object(ctx.attr(OVERRIDES_SENSOR, 'overrides')));
}

/**
 * `states.sensor.ls_overrides.last_updated.isoformat()`, the revision every
 * captured script reads bare: no `default`, no guard. A missing sensor makes
 * `states.sensor.ls_overrides` `None`, and `.isoformat()` on its undefined
 * `last_updated` raises (Home Assistant 2026.7.4: `UndefinedError: 'None' has
 * no attribute 'last_updated'`), so this raises too, and each caller reads it at
 * the point its script does. Home Assistant always supplies `last_updated` on a
 * state, so a present sensor without one is malformed state and raises as
 * `ls_plan`'s read does (`planRevision`).
 */
export function overridesRevision(ctx: HouseView, script: string): string {
  const sensor = ctx.state[OVERRIDES_SENSOR];
  if (sensor === undefined) throw new ParseError(`${script}.revision: ${OVERRIDES_SENSOR} is missing, and the captured script reads its last_updated bare`);
  if (sensor.last_updated === undefined) throw new ParseError(`${script}.revision: ${OVERRIDES_SENSOR} has no last_updated`);
  return sensor.last_updated;
}

/** An attribute as stored, compared by identity. */
export function attributeFact(ctx: HouseView, entity: string, key: string): StoredFact {
  return storedFact(ctx.attr(entity, key));
}

/** An attribute read with `.get(key, {})` leniency: a non-mapping is `{}`, entries carried. */
export function attributeMapping(ctx: HouseView, entity: string, key: string): OpaqueMap {
  return opaqueMap(ctx.attr(entity, key));
}

/** An attribute read as a list leniently: a non-list is `[]`, elements as stored. */
export function attributeList(ctx: HouseView, entity: string, key: string): StoredValue[] {
  const value = ctx.attr(entity, key);
  return Array.isArray(value) ? value.map(item => storedFact(item)) : [];
}
