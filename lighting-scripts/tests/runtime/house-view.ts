import type { EntityState, JsonObject, JsonValue } from '../../src/runtime/context.ts';
import type { HouseView } from '../../src/runtime/effects.ts';
import { parseCatalog } from '../../src/runtime/catalog.ts';

/**
 * A read-only house for pure decisions: entity states plus the topology a
 * decision reads. It has no effect methods at all, so a decision that tried to
 * emit, fire or run through it would fail instead of being silently recorded.
 *
 * A state is a bare string, a `[state, attributes]` pair, or a whole
 * {@link EntityState} when a decision reads more than those two (the overrides
 * revision reads `last_updated`).
 */
export function house(states: Record<string, string | [string, JsonObject] | EntityState>, topology: Partial<HouseView> & { catalogDocument?: JsonObject } = {}): HouseView {
  const state: Record<string, EntityState> = Object.fromEntries(Object.entries(states).map(([entity, value]) =>
    [entity, typeof value === 'string' ? { state: value, attributes: {} } : Array.isArray(value) ? { state: value[0], attributes: value[1] } : value]));
  const { catalogDocument, ...rest } = topology;
  return {
    state, areas: {}, members: [], now: '2026-10-26T12:00:00+01:00', timezone: 'Europe/Stockholm',
    labels: {}, devices: {}, entitySources: {}, catalog: parseCatalog(catalogDocument ?? {}),
    get: (entity: string) => state[entity]?.state ?? 'unknown',
    attr: (entity: string, key: string): JsonValue | undefined => state[entity]?.attributes[key],
    ...rest,
  };
}
