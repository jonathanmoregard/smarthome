/**
 * `ui-state`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/ui-state.ts`.
 */
import { isDeepStrictEqual } from 'node:util';
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { perform, run } from '../runtime/effects.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { discoveryRows, parseRangeSaveArgs, parseUiSyncArgs, rangeSaveAnswer } from '../parse/ui-state.ts';
import type { RangeSaveArgs } from '../parse/ui-state.ts';
import { decideRangeSave, discoveryPublish, publishUi, saveRange, uiChoices, uiMessages } from '../domain/ui-state.ts';
import type { RangeSaveResult } from '../domain/ui-state.ts';

/**
 * A shell: each row's current effect list is read live, after the previous
 * row's publish, as the captured loop reads it.
 */
function uiCatalog(ctx: ScriptContext): null {
  perform(ctx, { kind: 'script', name: 'effects_catalog', args: {} });
  const choices = uiChoices(ctx);
  for (const row of discoveryRows(ctx)) {
    if (!isDeepStrictEqual(ctx.attr(row.entity, 'effect_list'), choices)) perform(ctx, discoveryPublish(row, choices));
  }
  return null;
}
export function rangeSave(ctx: ScriptContext, args: RangeSaveArgs): RangeSaveResult {
  const result = decideRangeSave(ctx, args);
  return args.dryRun ? result : run(ctx, saveRange(result));
}
export const uiHandlers: ScriptHandlers = {
  effects_ui_catalog: ctx => uiCatalog(ctx),
  effects_ui_sync: withParsedArgs({
    parse: parseUiSyncArgs,
    run: (ctx, args) => {
    if (!args.dryRun) perform(ctx, { kind: 'script', name: 'effects_ui_catalog', args: {} });
    const messages = uiMessages(ctx, args.force);
    return args.dryRun ? { messages } : run(ctx, publishUi(messages));
    },
  }),
  // Every argument read is eager in the captured script and none can raise
  // between them, so the arguments parse up front.
  ls_range_save: withParsedArgs({ parse: parseRangeSaveArgs, run: (ctx, args) => rangeSaveAnswer(rangeSave(ctx, args)) }),
};
