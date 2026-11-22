/**
 * `native-controls`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/native-controls.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { run } from '../runtime/effects.ts';
import type { Plan } from '../runtime/effects.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { parseNativeCatalog, parseNativeCurrent, parseNativePlanArgs, parseSetArgs } from '../parse/native-controls.ts';
import type { SetRequest } from '../parse/native-controls.ts';
import { planNativeControls, planUIControls } from '../domain/native-controls.ts';
import type { ControlPlan } from '../domain/native-controls.ts';

function setControls(ctx: ScriptContext, args: SetRequest): ControlPlan {
  const catalog = parseNativeCatalog(ctx.run('effects_catalog'), 'effects_set.catalog');
  const current = !args.source.startsWith('light.ls_') && args.attribute !== 'power' ? parseNativeCurrent(ctx.run('ls_plan',
    { reason: 'config' }), 'effects_set.current') : undefined;
  const result = planUIControls(ctx, args, catalog, current);
  if (args.dryRun) return result;
  run(ctx, controlEffects(result));
  return result;
}
/**
 * A control plan's effects: an invalid plan raises its errors before anything
 * is sent; a valid one fires its override events, then performs its commands
 * in order (the store as an inter-handler run whose answer is not read).
 */
export function* controlEffects(result: ControlPlan): Plan<void> {
  if (!result.valid) throw new Error(result.errors.join(' '));
  for (const event of result.events) yield { kind: 'event', event: 'ls_override', data: event };
  for (const command of result.commands) {
    if (command.action === 'script.ls_store') yield { kind: 'script', name: 'ls_store', args: command.data };
    else yield { kind: 'service', service: command.action, data: command.data, target: command.target };
  }
}
export const nativeHandlers: ScriptHandlers = {
  effects_native_plan: withParsedArgs({ parse: parseNativePlanArgs, run: planNativeControls }),
  effects_set: withParsedArgs({ parse: parseSetArgs, run: setControls }),
};
