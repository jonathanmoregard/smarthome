/**
 * Overlay keys as the overlay store saves them, read into what they name.
 * Lenient, as every read of saved values is: a key of no known shape is kept
 * as saved (`{ kind: 'saved' }`), never rejected and never dropped, so the
 * store still round-trips it.
 */
import type { OverlayKey } from '../domain/types/overlay.ts';
import { toRemoteSource, toSavedOverlayKey } from './ids.ts';

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
