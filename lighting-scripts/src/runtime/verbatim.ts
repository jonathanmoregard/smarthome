/**
 * Document values the domain carries to an edge unchanged, and never reads.
 *
 * Some data crosses the lighting domain without being *about* lighting: an MQTT
 * body assembled upstream, the multicast group's own `id`, the runtime sensor's
 * `candle_group` attribute handed back as observed. The gate compares those
 * bytes, so parsing them into a narrower type would be a projection (THE
 * INVARIANT in `tasks/mission.md`), and leaving them `JsonValue` would let the
 * domain traverse them -- which is the defect class this mission removes.
 *
 * `Verbatim` is the third option: an opaque handle. At runtime it *is* the
 * document, so carrying it costs nothing and every encoder stays the identity.
 * At compile time it has no readable property and cannot be compared with a
 * literal, so the only things the domain can do with one are hold it, put it in
 * an output, and ask the parse layer about it. Its brand is a symbol key, which
 * keeps it assignable to `JsonValue`: putting it into an output document needs
 * no ceremony, while getting JSON *in* goes through {@link carry}, at the edge.
 */
import type { JsonValue } from './context.ts';

declare const verbatim: unique symbol;

export type Verbatim = { readonly [verbatim]: 'verbatim' };

/** For the parse layer: admit an unparsed value as an opaque handle. */
export function carry(value: JsonValue): Verbatim {
  return value as unknown as Verbatim;
}

/** For the parse layer: the document behind a handle, to parse or serialise. */
export function reveal(value: Verbatim): JsonValue {
  return value as unknown as JsonValue;
}

/**
 * JSON structural equality with mapping-order independence, as Jinja/Python
 * `==` compares dicts. Deliberately not `isDeepStrictEqual`: `NaN` is never
 * equal here (it is there), and `0`/`-0` are equal here (they are not there).
 */
export function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isMapping(a) && isMapping(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** {@link jsonEqual} over two carried documents. */
export function sameDocument(a: Verbatim, b: Verbatim): boolean {
  return jsonEqual(reveal(a), reveal(b));
}

function isMapping(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
