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
import { opaqueMap, storedFact, storedOverrides } from './overrides.ts';
import type { OpaqueMap, StoredFact, StoredOverrides, StoredValue } from './overrides.ts';

export const OVERRIDES_SENSOR = 'sensor.ls_overrides';

/** `state_attr('sensor.ls_overrides', 'overrides')` read leniently: a non-mapping is `{}`. */
export function lenientOverrides(ctx: ScriptContext): StoredOverrides {
  return storedOverrides(object(ctx.attr(OVERRIDES_SENSOR, 'overrides')));
}

/** An attribute as stored, compared by identity. */
export function attributeFact(ctx: ScriptContext, entity: string, key: string): StoredFact {
  return storedFact(ctx.attr(entity, key));
}

/** An attribute read with `.get(key, {})` leniency: a non-mapping is `{}`, entries carried. */
export function attributeMapping(ctx: ScriptContext, entity: string, key: string): OpaqueMap {
  return opaqueMap(ctx.attr(entity, key));
}

/** An attribute read as a list leniently: a non-list is `[]`, elements as stored. */
export function attributeList(ctx: ScriptContext, entity: string, key: string): StoredValue[] {
  const value = ctx.attr(entity, key);
  return Array.isArray(value) ? value.map(item => storedFact(item)) : [];
}
