import type { Ranged } from './range.ts';
import type { RemoteSource, SavedOverlayKey } from './ids.ts';

/**
 * The key an overlay is saved under in the overlay store, as the overlay it
 * names. Read from the store by `parseOverlayKey` (`src/parse/overlay-key.ts`);
 * turned back into the saved text only by {@link overlayKeyText}, where a key
 * is written or compared with another.
 */
export type OverlayKey =
  /** Sara mode: `mode:sara`. */
  | { kind: 'sara mode' }
  /** A block overlay on a room, or on the house: `block:<room or house>`. */
  | { kind: 'block'; scope: string }
  /** A remote's input for its room: `channels:<remote source>`. */
  | { kind: 'remote input'; source: RemoteSource }
  /** A dashboard control's channels: `channels:ui:<control>`, the control's light and, for a group, the room or lamp. */
  | { kind: 'dashboard control'; control: string }
  /** A native control's channels: `channels:native:<base>`, the base being `room:<room>` or a lamp. */
  | { kind: 'native control'; base: string }
  /**
   * The empty key: the key the scripts' newest-record searches start from and
   * keep when no record applies, and a store key spelled `''`.
   */
  | { kind: 'empty' }
  /** Any other key a saved store holds, kept exactly as saved. */
  | { kind: 'saved'; key: SavedOverlayKey };

/** A count of minutes, finite and not negative (the overlay reset's age limit). */
export type Minutes = Ranged<'Minutes'>;

/**
 * The key's saved text: the exact inverse of `parseOverlayKey`, both ways. A
 * remote source and a saved key's text are ids whose constructors refuse the
 * text another shape claims, so no key can be built whose text reads back as
 * a different key.
 */
export function overlayKeyText(key: OverlayKey): string {
  switch (key.kind) {
    case 'sara mode': return 'mode:sara';
    case 'block': return `block:${key.scope}`;
    case 'remote input': return `channels:${key.source}`;
    case 'dashboard control': return `channels:ui:${key.control}`;
    case 'native control': return `channels:native:${key.base}`;
    case 'empty': return '';
    case 'saved': return key.key;
  }
}

/** Two keys name the same saved overlay. */
export function sameOverlayKey(a: OverlayKey, b: OverlayKey): boolean {
  return overlayKeyText(a) === overlayKeyText(b);
}

/** Order keys as their saved text sorts (`sorted()` over the saved keys). */
export function byOverlayKeyText(a: OverlayKey, b: OverlayKey): number {
  const x = overlayKeyText(a), y = overlayKeyText(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The Sara mode overlay's key. */
export const SARA_MODE: OverlayKey = { kind: 'sara mode' };
/** The empty key. */
export const EMPTY_KEY: OverlayKey = { kind: 'empty' };
