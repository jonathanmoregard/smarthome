/**
 * `resolution`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/resolution.ts`.
 */
import type { ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import { planGradients } from '../domain/gradient.ts';
import { scaleValue } from '../domain/scale.ts';
import { parseGradientPlanArgs } from '../parse/gradient.ts';
import { parseScaleArgs } from '../parse/scale.ts';
import { parseResolveArgs } from '../parse/resolution.ts';
import { resolveEffects } from '../domain/resolution.ts';

export const resolutionHandlers: ScriptHandlers = {
  // Arguments parsed in `src/parse/resolution.ts`. Every read there is as
  // lenient as the traversal it replaces, so the parse raises nowhere; the
  // three reads that do raise are thunks the resolver calls where it always
  // did.
  effects_resolve: typed('effects_resolve', { parse: parseResolveArgs, run: (_context, args) => resolveEffects(args) }),
  // Arguments parsed in `src/parse/scale.ts`.
  effects_scale: withParsedArgs({
    parse: parseScaleArgs,
    run: (_context, a) => scaleValue(a.day, a.cosy, a.position, a.warmEnd),
  }),
  // Arguments parsed in `src/parse/gradient.ts`, which documents the
  // leniency in them that is load-bearing.
  effects_gradient_plan: typed('effects_gradient_plan', { parse: parseGradientPlanArgs, run: (_context, args) => planGradients(args) }),
};
