import type { OverlayKey } from '../../domain/types/overlay.ts';

/**
 * The overlays an after-limit reset ends: those at least `limit` seconds old
 * at `now`. An overlay whose `when` is unreadable ages from now, so it is
 * never older than the limit unless the limit is 0.
 */
export function expiredOverlays(ages: ReadonlyArray<{ key: OverlayKey; when: number | undefined }>, now: number, limit: number): OverlayKey[] {
  return ages.filter(({ when }) => now - (when === undefined ? now : when) >= limit).map(({ key }) => key);
}
