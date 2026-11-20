/**
 * Readers for `sensor.ls_overrides`'s attributes.
 *
 * One reader per spelling the captured scripts use, and they are deliberately
 * not unified: the lenient `.get(key, {})` reads treat a non-mapping as empty,
 * while `controller`'s strict read raises on one. Collapsing the two would move
 * a raise or swallow one.
 */
import type { HouseView } from '../runtime/effects.ts';
import { isObject, object, ParseError } from '../runtime/parse.ts';
import { opaqueMap, storedFact, storedOverrides } from './overrides.ts';
import type { OpaqueMap, StoredFact, StoredOverrides, StoredValue } from './overrides.ts';

export const OVERRIDES_SENSOR = 'sensor.ls_overrides';

/** `state_attr('sensor.ls_overrides', 'overrides')` read leniently: a non-mapping is `{}`. */
export function lenientOverrides(ctx: HouseView): StoredOverrides {
  return storedOverrides(object(ctx.attr(OVERRIDES_SENSOR, 'overrides')));
}

/**
 * Captured `key in (state_attr('sensor.ls_overrides','overrides') or {})`, for
 * a script that reads the attribute for nothing else: Python `in` -- a mapping's
 * keys, a list's elements, a string's substrings. A truthy value `in` raises on
 * (a number, `true`) reads as the `or {}` default (lenient saved-value directive).
 */
export function savedOverridesContain(ctx: HouseView, key: string): boolean {
  const value = ctx.attr(OVERRIDES_SENSOR, 'overrides');
  if (isObject(value)) return Object.hasOwn(value, key);
  if (Array.isArray(value)) return value.includes(key);
  if (typeof value === 'string') return value.includes(key);
  return false;
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
  if (sensor === undefined) {
    throw new ParseError(`${script}.revision: ${OVERRIDES_SENSOR} is missing, and the captured script reads its last_updated bare`);
  }
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

/** A saved runtime `plan_order` Python cannot compare with a number: the captured `plan_order or 0` default. */
export const NO_PLAN_ORDER = 0;

/**
 * `sensor.ls_effects_runtime`'s saved `plan_order`, captured `plan_order or 0`
 * and compared with a number: a finite number is itself, a boolean is Python's
 * 0 or 1, and anything else -- absent, falsy, or a value the comparison would
 * raise on -- is {@link NO_PLAN_ORDER} (lenient saved-value directive). Never raises.
 */
export function savedPlanOrder(ctx: HouseView): number {
  const value = ctx.attr('sensor.ls_effects_runtime', 'plan_order');
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return NO_PLAN_ORDER;
}
