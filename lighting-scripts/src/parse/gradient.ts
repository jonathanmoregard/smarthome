/**
 * Parsing for the gradient cache and the `effects_gradient_plan` entrypoint.
 *
 * Both genuinely read unparsed documents: the cache is persisted state and the
 * handler's arguments arrive over the RPC, so this is a legitimate JSON edge.
 * `domain/gradient.ts` holds the compile and sample algebra and names no JSON.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '../runtime/context.ts';
import { isObject, object } from '../runtime/parse.ts';
import { boundedNumber, WARM_END } from '../domain/scale.ts';
import type { RGB } from '../domain/scale.ts';
import { compileGradient, gradientSignature } from '../domain/gradient.ts';
import type { GradientEntry, GradientSignature } from '../domain/gradient.ts';
import { anchor, validColor } from './scale.ts';

function validGradientColor(value: unknown): boolean {
  return validColor(value, 0, 1e20) && (value.kelvin === undefined || (value.kelvin > 0 && value.kelvin < 1e20));
}

/** Validate stored shape/anchor identity without repeating Kelvin conversion on cache hits. */
export function validGradient(entry: unknown, signature: GradientSignature): entry is GradientEntry {
  if (!isObject(entry) || !isDeepStrictEqual(entry.signature, signature) || !isObject(entry.curve)) return false;
  const c = entry.curve;
  if (c.version !== 1 || !isObject(c.day) || !isObject(c.cosy) || !isObject(c.brightness) || !isObject(c.colors)) return false;
  if (c.day.brightness !== signature[1] || !isDeepStrictEqual(c.day.color, signature[2]) || c.cosy.brightness !== signature[3] || !isDeepStrictEqual(c.cosy.color, signature[4])) return false;
  if (!['floor', 'lower', 'middle', 'upper'].every(name => boundedNumber(object(c.brightness)[name]))) return false;
  for (const name of ['lower', 'middle', 'upper', 'tail']) {
    const p = c.colors[name];
    if (!isObject(p) || !validGradientColor(p.left) || !validGradientColor(p.right)) return false;
    for (const field of ['start', 'delta']) {
      const v = p[field];
      if (p.kind === 'kelvin') { if (!boundedNumber(v)) return false; }
      else if (p.kind === 'rgb') { if (!Array.isArray(v) || v.length !== 3 || !v.every(boundedNumber)) return false; }
      else return false;
    }
  }
  return true;
}

/**
 * `effects_gradient_plan`.
 *
 * Two pieces of leniency here are load-bearing and deliberately not tightened:
 *
 * - The `continue` skips a target whose `day`/`cosy` is not a mapping rather
 *   than raising. A baseline mid-compile legitimately holds incomplete targets.
 * - `args.warm_end ?? WARM_END` is a cast, not a parse. Replacing it with
 *   `requireRgb` would raise where the captured source coerces, and a
 *   fallback's trigger is observable behaviour. It is a known rough edge, left
 *   for whichever criterion owns this handler's argument boundary.
 */
export function planGradients(args: JsonObject): { gradients: Record<string, GradientEntry> } {
  const gradients: Record<string, GradientEntry> = {};
  const cache = object(args.cached);
  const warmEnd = (args.warm_end ?? WARM_END) as RGB;
  for (const [target, item] of Object.entries(object(args.base))) {
    if (!isObject(item) || !isObject(item.day) || !isObject(item.cosy)) continue;
    const day = anchor(item.day), cosy = anchor(item.cosy);
    const signature = gradientSignature(day, cosy, warmEnd);
    const cached = cache[target];
    gradients[target] = validGradient(cached, signature) ? cached : { signature, curve: compileGradient(day, cosy, warmEnd) };
  }
  return { gradients };
}
