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
import type { ScriptHandlers } from './context.ts';

export const handlers: ScriptHandlers = {
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
