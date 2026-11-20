/**
 * Overlay keys as the overlay store saves them, read into what they name.
 * Lenient, as every read of saved values is: a key of no known shape is kept
 * as saved (`{ kind: 'saved' }`), never rejected and never dropped, so the
 * store still round-trips it.
 */
import type { OverlayKey } from '../domain/types/overlay.ts';

function after(text: string, prefix: string): string | undefined {
  return text.startsWith(prefix) ? text.slice(prefix.length) : undefined;
}

export function parseOverlayKey(text: string): OverlayKey {
  if (text === 'mode:sara') return { kind: 'sara mode' };
  const scope = after(text, 'block:');
  if (scope !== undefined) return { kind: 'block', scope };
  const base = after(text, 'channels:native:');
  if (base !== undefined) return { kind: 'native control', base };
  const control = after(text, 'channels:ui:');
  if (control !== undefined) return { kind: 'dashboard control', control };
  const source = after(text, 'channels:');
  if (source !== undefined) return { kind: 'remote input', source };
  return { kind: 'saved', key: text };
}
