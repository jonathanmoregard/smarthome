/**
 * `ls_render` and `ls_dispatch`: each shows the lighting state
 * (`src/adapter/show.ts`). The room plans, the runtime sensor's `applied`,
 * its guards and the room caches they used to read and write are gone.
 */
import type { ScriptHandlers } from '../runtime/context.ts';
import { showLightingState } from '../adapter/show.ts';

export const dispatchHandlers: ScriptHandlers = {
  ls_dispatch: ctx => { showLightingState(ctx); return null; },
  ls_render: ctx => { showLightingState(ctx); return null; },
};
