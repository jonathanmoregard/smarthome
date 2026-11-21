import type { RoomId } from '../domain/types/ids.ts';

interface Target { area: RoomId | null }

export const cacheEntities = (targets: Target[]): string[] =>
  // One site: a lamp in no room names the entity `sensor.ls_cache_null`.
  targets.map(target => `sensor.ls_cache_${target.area}`);
