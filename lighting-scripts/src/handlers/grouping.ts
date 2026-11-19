/**
 * `grouping`'s handlers: the shells that read the live house, make the
 * inter-handler calls and perform effects, and the name-keyed table.
 * The decisions they run are in `src/domain/grouping.ts`.
 */
import type { ScriptHandlers } from '../runtime/context.ts';
import { typed } from '../runtime/entrypoints.ts';
import { parseGroupPlanArgs } from '../parse/grouping.ts';
import { planGroups } from '../domain/grouping.ts';

export const groupingHandlers: ScriptHandlers = {
  // Captured rows/groups are iterated, so absence is empty while a malformed
  // present container raises. catalog.members is accessed through .items().
  effects_group_plan: typed('effects_group_plan', {
    parse: parseGroupPlanArgs,
    run: (_ctx, args) => planGroups(args.rows, args.groups),
  }),
};
