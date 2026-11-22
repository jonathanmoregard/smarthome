/**
 * `transport`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/transport.ts`.
 */
import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { withParsedArgs } from '../runtime/parse.ts';
import { catalogOf } from '../runtime/catalog.ts';
import { perform, run } from '../runtime/effects.ts';
import type { Plan } from '../runtime/effects.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { typed } from '../runtime/entrypoints.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import { overridesRevision } from '../parse/sensors.ts';
import {
  assignedLamps, parseAssignArgs, parseEmitArgs, parseFilterArgs, parseFramePlanArgs, runtimeGeneration,
} from '../parse/transport.ts';
import type { GroupedCommands } from '../domain/grouping.ts';
import {
  assignDecision, filterCommands, frameRows, planAssignUpdate, publishCommand, stillCurrent, stopCommands, stoppedLamps,
} from '../domain/transport.ts';
import type { AssignRequest, AssignedGeneration, EmitRequest, EmitOutcome, FramePlanRequest, StopCommand } from '../domain/transport.ts';

/**
 * Each lamp's light, sent once. A channel running a bulb effect gets a static
 * value: brightness is the effect's intensity (the level it runs at, and the
 * candle's ceiling); colour is what the effect holds (see {@link BulbEffect}).
 * The start follows in a second emission, so it always lands after the light.
 *
 * The rows go to the group planner, an inter-handler call whose result is this
 * script's answer, so the call stays in the handler.
 */
export function framePlan(ctx: ScriptContext, args: FramePlanRequest): GroupedCommands {
  const rows = frameRows(ctx, args);
  // `ctx.call`, not `ctx.run`: this result is what `effects_frame_plan`
  // answers, so it must arrive typed. The call itself is unchanged -- same
  // name in `scriptRuns`, same argument bytes in the compared trace.
  return ctx.call('effects_group_plan', { rows, groups: args.catalog.multicast() });
}
/**
 * Publish each command the house still allows, in order. Each command's gate
 * is read live, after the publishes before it: the revision first (it raises
 * on a missing sensor, ahead of the command's own parse), then the command.
 */
export function emitCommands(ctx: ScriptContext, args: EmitRequest): EmitOutcome {
  const revision = args.revision, generation = args.generation;
  let completed = true;
  const published: number[] = [];
  for (const parseCommand of args.commands) {
    const current = overridesRevision(ctx, 'effects_emit');
    const command = parseCommand();
    const publish = publishCommand(ctx, { revision, generation, current, command, effectTargets: args.effectTargets() });
    if (publish === undefined) { completed = false; continue; }
    published.push(recordTimestamp(ctx.now));
    perform(ctx, publish);
  }
  return { published_at: published, completed: completed && stillCurrent(ctx, 'effects_emit', revision, generation) };
}
/**
 * Store the assignment, then stop the bulb effects lamps are leaving. The stop
 * commands read member states after the store and the catalog run, live, and
 * the answer re-reads the generation the store left.
 */
export function assignEffects(ctx: ScriptContext, args: AssignRequest): AssignedGeneration {
  if (args.revision !== overridesRevision(ctx, 'effects_assign')) return { generation: runtimeGeneration(ctx) };
  const details = args.details();
  const decision = assignDecision(ctx, args.revision, details);
  // The target views are parsed ahead of the store so it can drop the lamps
  // told to stop from `applied`. A parse that raises aborts the whole request
  // either way, so the earlier raise has no observable effect.
  const stopped = decision.changed ? stoppedLamps(details.targetViews(), decision.stored) : [];
  run(ctx, planAssignUpdate(decision, args.revision, details, stopped));
  if (decision.changed) {
    const catalog = catalogOf(ctx);
    const stops = stopCommands(ctx, catalog, details.targetViews(), decision.stored);
    run(ctx, planStops(stops, args.revision, decision.generation));
  }
  return { generation: runtimeGeneration(ctx) };
}
/** The stops go out through `effects_emit`, an inter-handler run whose answer is not read. */
export function* planStops(commands: StopCommand[], revision: string, generation: Verbatim | string): Plan<void> {
  yield { kind: 'script', name: 'effects_emit', args: { commands, revision, generation } };
}

export const transportHandlers: ScriptHandlers = {
  effects_frame_plan: typed('effects_frame_plan', { parse: parseFramePlanArgs, run: framePlan }),
  effects_emit: typed('effects_emit', { parse: parseEmitArgs, run: emitCommands }),
  effects_assign: typed('effects_assign', { parse: parseAssignArgs, run: assignEffects }),
  // The catalog run and the assigned-lamp read happen before any command is looked at.
  effects_filter_commands: withParsedArgs({
    parse: parseFilterArgs,
    run: (ctx, args) => {
      const catalog = catalogOf(ctx);
      return filterCommands(catalog, assignedLamps(ctx), args.commands);
    },
  }),
};
