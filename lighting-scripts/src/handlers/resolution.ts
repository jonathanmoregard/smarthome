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
import { candleLamps, resolveEffects } from '../domain/resolution.ts';
import type { ScriptContext } from '../runtime/context.ts';

/**
 * `effects_resolve`, given where the Candle-capable lamps come from. Production
 * reads them from the runtime catalog the call runs with ({@link candleLamps});
 * the parity bridge supplies its fixtures' own set, since those fixtures
 * predate the declared flag. The `catalog` argument (the `effects_catalog`
 * document) is not consulted for this.
 */
export function effectsResolve(candle: (ctx: ScriptContext) => ReadonlySet<string>): ScriptHandlers[string] {
  return typed('effects_resolve', { parse: parseResolveArgs, run: (ctx, args) => resolveEffects(args, candle(ctx)) });
}

export const resolutionHandlers: ScriptHandlers = {
  // Arguments parsed in `src/parse/resolution.ts`. Every read there is as
  // lenient as the traversal it replaces, so the parse raises nowhere; the
  // three reads that do raise are thunks the resolver calls where it always
  // did.
  effects_resolve: effectsResolve(ctx => candleLamps(ctx.catalog)),
  // Arguments parsed in `src/parse/scale.ts`.
  effects_scale: withParsedArgs({
    parse: parseScaleArgs,
    run: (_context, a) => scaleValue(a.day, a.cosy, a.position, a.warmEnd),
  }),
  // Arguments parsed in `src/parse/gradient.ts`, which documents the
  // leniency in them that is load-bearing.
  effects_gradient_plan: typed('effects_gradient_plan', { parse: parseGradientPlanArgs, run: (_context, args) => planGradients(args) }),
};
