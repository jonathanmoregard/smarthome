import { gestureHandlers } from '../domain/gestures.ts';
import { resolutionHandlers } from '../domain/resolution.ts';
import { groupingHandlers } from '../domain/grouping.ts';
import { frameHandlers } from '../domain/frames.ts';
import { remoteInputHandlers } from '../domain/remote-input.ts';
import { stateStoreHandlers } from '../domain/state-store.ts';
import { scheduleHandlers } from '../domain/schedule.ts';
import { nativeHandlers } from '../domain/native-controls.ts';
import { planningHandlers } from '../domain/planning.ts';
import { controllerHandlers } from '../domain/controller.ts';
import { uiHandlers } from '../domain/ui-state.ts';
import { transportHandlers } from '../domain/transport.ts';
import { dispatchHandlers } from '../domain/dispatch-render.ts';
import { candleSyncHandlers } from '../domain/candle-sync.ts';
import { automationHandlers } from '../domain/automations.ts';
import type { ScriptHandlers } from './context.ts';

export const handlers: ScriptHandlers = {
  ...gestureHandlers,
  ...resolutionHandlers,
  ...groupingHandlers,
  ...frameHandlers,
  ...remoteInputHandlers,
  ...stateStoreHandlers,
  ...scheduleHandlers,
  ...nativeHandlers,
  ...planningHandlers,
  ...controllerHandlers,
  ...uiHandlers,
  ...transportHandlers,
  ...dispatchHandlers,
  ...candleSyncHandlers,
  ...automationHandlers,
  // Serves the unparsed document, deliberately: this is the name-keyed view
  // that HA and the parity harness call, and they compare the whole document
  // including fields no lighting logic reads. Domain logic reads ctx.catalog.
  effects_catalog: ctx => structuredClone(ctx.rawCatalog()),
};
