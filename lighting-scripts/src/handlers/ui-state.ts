/**
 * `ui-state`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/legacy/domain/ui-state.ts`.
 */
import { isDeepStrictEqual } from 'node:util';
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { perform, run } from '../runtime/effects.ts';
import type { Effect, Plan } from '../runtime/effects.ts';
import { withFields } from '../runtime/verbatim.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { discoveryRows, parseRangeSaveArgs, parseUiSyncArgs, rangeSaveAnswer } from '../parse/ui-state.ts';
import type { DiscoveryRow, RangeSaveRequest } from '../parse/ui-state.ts';
import { decideRangeSave, saveRange, uiChoices, uiMessages } from '../legacy/domain/ui-state.ts';
import type { RangeSaveDecision, UiMessage } from '../legacy/domain/ui-state.ts';

/** Publish the UI mirror's messages, retained. */
export function* publishUi(messages: UiMessage[]): Plan<null> {
  for (const message of messages) yield { kind: 'service', service: 'mqtt.publish', data: { ...message, qos: 0, retain: true } };
  return null;
}
export function rangeSave(ctx: ScriptContext, args: RangeSaveRequest): RangeSaveDecision {
  const result = decideRangeSave(ctx, args);
  return args.dryRun ? result : run(ctx, saveRange(result));
}
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
/** Republish one discovery row's config with the choices as its effect list. */
export function discoveryPublish(row: DiscoveryRow, choices: string[]): Effect {
  return {
    kind: 'service', service: 'mqtt.publish',
    data: {
      topic: `homeassistant/light/${row.uniqueId}/config`,
      payload: JSON.stringify(withFields(row.config, { effect_list: choices })), qos: 0, retain: true,
    },
  };
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
