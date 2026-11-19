/**
 * `native-controls`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/native-controls.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { run } from '../runtime/effects.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { parseNativeCatalog, parseNativeCurrent, parseNativePlanArgs, parseSetArgs } from '../parse/native-controls.ts';
import type { SetArgs } from '../parse/native-controls.ts';
import { controlEffects, planNativeControls, planUIControls } from '../domain/native-controls.ts';
import type { ControlPlan } from '../domain/native-controls.ts';

function setControls(ctx: ScriptContext, args: SetArgs): ControlPlan {
  const catalog = parseNativeCatalog(ctx.run('effects_catalog'), 'effects_set.catalog');
  const current = !args.source.startsWith('light.ls_') && args.attribute !== 'power' ? parseNativeCurrent(ctx.run('ls_plan',
    { reason: 'config' }), 'effects_set.current') : undefined;
  const result = planUIControls(ctx, args, catalog, current);
  if (args.dryRun) return result;
  run(ctx, controlEffects(result));
  return result;
}
export const nativeHandlers: ScriptHandlers = {
  effects_native_plan: withParsedArgs({ parse: parseNativePlanArgs, run: planNativeControls }),
  effects_set: withParsedArgs({ parse: parseSetArgs, run: setControls }),
};
