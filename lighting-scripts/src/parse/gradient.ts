/**
 * Parsing for the gradient cache and the `effects_gradient_plan` entrypoint.
 *
 * Both genuinely read unparsed documents: the cache is persisted state and the
 * handler's arguments arrive over the RPC, so this is a legitimate JSON edge.
 * `domain/gradient.ts` holds the compile and sample algebra and names no JSON.
 */
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '../runtime/context.ts';
import { isObject, lazy, object } from '../runtime/parse.ts';
import { boundedNumber, WARM_END } from '../domain/scale.ts';
import type { RGB } from '../domain/scale.ts';
import type { GradientEntry, GradientPlanArgs, GradientPlanTarget, GradientSignature } from '../domain/gradient.ts';
import { anchor, requireRgb, validColor } from './scale.ts';

function validGradientColor(value: unknown): boolean {
  return validColor(value, 0, 1e20) && (value.kelvin === undefined || (value.kelvin > 0 && value.kelvin < 1e20));
}

/** Validate stored shape/anchor identity without repeating Kelvin conversion on cache hits. */
export function validGradient(entry: unknown, signature: GradientSignature): entry is GradientEntry {
  if (!isObject(entry) || !isDeepStrictEqual(entry.signature, signature) || !isObject(entry.curve)) return false;
  const c = entry.curve;
  if (c.version !== 1 || !isObject(c.day) || !isObject(c.cosy) || !isObject(c.brightness) || !isObject(c.colors)) return false;
  if (c.day.brightness !== signature[1] || !isDeepStrictEqual(c.day.color, signature[2]) || c.cosy.brightness !== signature[3] ||
    !isDeepStrictEqual(c.cosy.color, signature[4])) return false;
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
 * A handler's `warm_end` field, read where the oracle lists it.
 *
 * Absent falls back to the field's `default: [255,126,0]`, as Home Assistant
 * fills field defaults only for a field the caller left out. Read lazily: the
 * oracle first touches `warm_end` in `gradient_signature`'s `warm_end|list`,
 * which only runs for a target that compiles, so a handler with nothing to
 * compile never reads it. When read, an explicit null raises the TypeError
 * `None|list` raises; anything else must be an `[r, g, b]` triple of finite
 * numbers. The live callers pass Home Assistant's `rgb_color` (always a
 * triple) or the default.
 */
export function warmEndArgument(args: JsonObject, context: string): () => RGB {
  return lazy(() => {
    if (args.warm_end === undefined) return WARM_END;
    if (args.warm_end === null) throw new TypeError(`${context}.warm_end|list: 'NoneType' object is not iterable`);
    return requireRgb(args.warm_end, `${context}.warm_end`);
  });
}

/**
 * `effects_gradient_plan`'s arguments.
 *
 * One piece of leniency is load-bearing and deliberately not tightened: a
 * target whose `day`/`cosy` is not a mapping is skipped rather than raising
 * (the captured `for ... if item is mapping and ...`); a baseline mid-compile
 * legitimately holds incomplete targets. `base` and `cached` are read as the
 * captured `is mapping else {}` reads them. A target's anchors are read when
 * the planner reaches it, so a malformed anchor raises in target order, after
 * every earlier target's signature, as the inline loop did.
 */
export function parseGradientPlanArgs(args: JsonObject): GradientPlanArgs {
  const cache = object(args.cached);
  const targets: GradientPlanTarget[] = [];
  for (const [target, item] of Object.entries(object(args.base))) {
    if (!isObject(item) || !isObject(item.day) || !isObject(item.cosy)) continue;
    const day = item.day, cosy = item.cosy;
    targets.push({
      target,
      anchors: lazy(() => ({ day: anchor(day), cosy: anchor(cosy) })),
      cached: signature => {
        const entry = cache[target];
        return validGradient(entry, signature) ? entry : undefined;
      },
    });
  }
  return { targets, warmEnd: warmEndArgument(args, 'effects_gradient_plan') };
}
