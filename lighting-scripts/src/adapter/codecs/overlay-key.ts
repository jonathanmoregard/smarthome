import type { Id, RemoteId, RemoteSource } from '../../domain/types/ids.ts';
import type { Catalog } from './catalog.ts';
import { toRemoteSource, toSavedOverlayKey } from './ids.ts';
import { ParseError } from './parse.ts';

/**
 * The key an overlay is saved under in the overlay store, as the overlay it
 * names. Read from the store by {@link parseOverlayKey};
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

/**
 * Overlay keys as the overlay store saves them, read into what they name.
 * Lenient, as every read of saved values is: a key of no known shape is kept
 * as saved (`{ kind: 'saved' }`), never rejected and never dropped, so the
 * store still round-trips it.
 */
export function parseOverlayKey(text: string): OverlayKey {
  if (text === '') return { kind: 'empty' };
  if (text === 'mode:sara') return { kind: 'sara mode' };
  const scope = after(text, 'block:');
  if (scope !== undefined) return { kind: 'block', scope };
  const base = after(text, 'channels:native:');
  if (base !== undefined) return { kind: 'native control', base };
  const control = after(text, 'channels:ui:');
  if (control !== undefined) return { kind: 'dashboard control', control };
  const source = after(text, 'channels:');
  // Neither constructor below can raise here: every prefix they refuse was read above.
  if (source !== undefined) return { kind: 'remote input', source: toRemoteSource(source) };
  return { kind: 'saved', key: toSavedOverlayKey(text) };
}

function after(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

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

/**
 * A saved overlay key of no known shape, kept as saved. Never text a known
 * shape claims (empty, `mode:sara`, `block:...`, `channels:...`), so it reads
 * back as itself; its constructor (`toSavedOverlayKey`) checks that.
 */
export type SavedOverlayKey = Id<'SavedOverlayKey'>;

/**
 * The catalog's remotes by the source each one's overlay is saved under
 * (`channels:<source>`), and each remote's source. The Model keys a remote's
 * overlay by the remote (amendment 5.2); only the stored key names the source.
 */
export type RemoteSources = { remoteOf: ReadonlyMap<RemoteSource, RemoteId>; sourceOf: ReadonlyMap<RemoteId, RemoteSource> };

/** The catalog's remotes and their sources. A source is one overlay key, so two remotes listed under one are refused. */
export function remoteSources(catalog: Catalog): RemoteSources {
  const remoteOf = new Map<RemoteSource, RemoteId>(), sourceOf = new Map<RemoteId, RemoteSource>();
  for (const { device_id: remote, source } of Object.values(catalog.remotes)) {
    if (remoteOf.has(source)) {
      throw new ParseError(`catalog.remotes: source ${source} is listed for more than one remote; a source is one remote's overlay`);
    }
    remoteOf.set(source, remote);
    sourceOf.set(remote, source);
  }
  return { remoteOf, sourceOf };
}

/** The Sara mode overlay's key. */
export const SARA_MODE: OverlayKey = { kind: 'sara mode' };
