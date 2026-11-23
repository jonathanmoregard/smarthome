/**
 * `update(model, msg)`: everything that can happen to the Model, one case per
 * message, each calling its concept's module (Elm's update). Total and pure:
 * every message gives a Model, and nothing is read but the two arguments.
 *
 * A remote's presses are M3 Task 2's: until then they leave the Model as it is.
 */
import { dashboardControlSet, personChanged } from './lamp-overlays.ts';
import type { Model, Msg, OverlayRequest } from './model.ts';
import { clearAll, holdBlock, resetsDue, setModeOverlay, setRoomPower } from './overlays.ts';
import { lampProfileSaved, switchProfileSaved } from './profiles.ts';
import { rangeDefaultsSaved, rangeSaved, switchButtonPressed } from './switches.ts';
import type { Instant } from './types/time.ts';

export function update(model: Model, msg: Msg): Model {
  switch (msg.kind) {
    case 'clock': return resetsDue(model, msg.now);
    case 'configChanged': return { ...model, config: msg.config };
    case 'overlayRequested': return overlayRequested(model, msg.request, msg.at);
    case 'lampChangedByPerson': return personChanged(model, msg.lamps, msg.light, msg.at);
    case 'remotePressed': return model;
    case 'remoteButtonPressed': return model;
    case 'switchButtonPressed': return switchButtonPressed(model, msg.switch, msg.power, msg.at);
    case 'modeToggled': return setModeOverlay(model, msg.on, msg.at);
    case 'rangeSaved': return rangeSaved(model, msg.switch, msg.rule);
    case 'rangeDefaultsSaved': return rangeDefaultsSaved(model, msg.defaults);
    case 'lampProfileSaved': return lampProfileSaved(model, msg.lamp, msg.block, msg.change);
    case 'switchProfileSaved': return switchProfileSaved(model, msg.switch, msg.block, msg.change);
  }
}

function overlayRequested(model: Model, request: OverlayRequest, at: Instant): Model {
  switch (request.kind) {
    case 'hold block': return holdBlock(model, request.over, request.block, at);
    case 'clear all': return clearAll(model);
    case 'dashboard control': return dashboardControlSet(model, request.control, request.over, request.light, at);
    case 'room power': return setRoomPower(model, request.room, request.power);
  }
}
