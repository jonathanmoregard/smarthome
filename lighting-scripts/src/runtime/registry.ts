import { gestureHandlers } from '../handlers/gestures.ts';
import { resolutionHandlers } from '../handlers/resolution.ts';
import { remoteInputHandlers } from '../handlers/remote-input.ts';
import { stateStoreHandlers } from '../handlers/state-store.ts';
import { scheduleHandlers } from '../handlers/schedule.ts';
import { nativeHandlers } from '../handlers/native-controls.ts';
import { planningHandlers } from '../handlers/planning.ts';
import { controllerHandlers } from '../handlers/controller.ts';
import { uiHandlers } from '../handlers/ui-state.ts';
import { dispatchHandlers } from '../handlers/dispatch-render.ts';
import { automationHandlers } from '../handlers/automations.ts';
import { turnHandler, WAKE } from '../adapter/turn.ts';
import type { ScriptHandler, ScriptHandlers } from './context.ts';

/**
 * The old scripts' table: their writers and the readers they call each other
 * through. No input reaches it; the legacy tests run it until M3 Task 3-B
 * deletes it.
 */
export const legacyHandlers: ScriptHandlers = {
  ...gestureHandlers,
  ...resolutionHandlers,
  ...remoteInputHandlers,
  ...stateStoreHandlers,
  ...scheduleHandlers,
  ...nativeHandlers,
  ...planningHandlers,
  ...controllerHandlers,
  ...uiHandlers,
  ...dispatchHandlers,
  ...automationHandlers,
  // Serves the unparsed document, deliberately: this is the name-keyed view
  // that HA and the parity harness call, and they compare the whole document
  // including fields no lighting logic reads. Domain logic reads ctx.catalog.
  effects_catalog: ctx => structuredClone(ctx.rawCatalog()),
};

/**
 * The names Home Assistant (and the harness) send as inputs: each automation,
 * the dashboard's and the remotes' scripts, the override event's sink, the
 * native controls, the render requests and the loop's own wake. Each runs a
 * turn of the adapter.
 */
const INPUTS: readonly string[] = [
  ...Object.keys(automationHandlers),
  'ls_remote_gesture', 'ls_remote_power_quiet', 'ls_remote_command',
  'ls_commit', 'ls_store', 'ls_override_block', 'ls_clear_overrides', 'ls_sara_mode', 'ls_range_save',
  'effects_set', 'effects_ui_sync', 'ls_apply', 'ls_dispatch', 'ls_render', WAKE,
];

/**
 * Every input goes through the adapter's turn. A dry run of `ls_apply` or
 * `ls_range_save` asks a question and changes nothing, so the old readers
 * still answer it. The readers no input reaches (the old plan, base and
 * resolution scripts, and the catalog) stay callable by name.
 */
export const handlers: ScriptHandlers = {
  ...legacyHandlers,
  ...Object.fromEntries(INPUTS.map(name => [name, turnHandler(name)])),
  ls_apply: unlessDryRun(turnHandler('ls_apply'), legacyHandlers.ls_apply),
  ls_range_save: unlessDryRun(turnHandler('ls_range_save'), legacyHandlers.ls_range_save),
};

/** The turn, or the old reader for a dry run. */
function unlessDryRun(turn: ScriptHandler, reader: ScriptHandler | undefined): ScriptHandler {
  return (ctx, args) => args.dry_run === true && reader !== undefined ? reader(ctx, args) : turn(ctx, args);
}
