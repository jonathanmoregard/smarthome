/**
 * `update(model, msg)`: everything that can happen to the Model, one case per
 * message, each calling its concept's module (Elm's update). Total and pure:
 * every message gives a Model, and nothing is read but the two arguments.
 *
 * The clock removes the overlays a reset makes due, then closes the remotes'
 * chords and power bursts whose window has closed.
 */
import { dashboardControlSet, personChanged } from './lamp-overlays.ts';
import type { Model, Msg, OverlayRequest } from './model.ts';
import { clearAll, holdBlock, resetsDue, setModeOverlay, setRoomPower } from './overlays.ts';
import { lampProfileSaved, switchProfileSaved } from './profiles.ts';
import { remoteButtonPressed, remotePressed, remoteTimeouts } from './remote.ts';
import { rangeDefaultsSaved, rangeSaved, switchButtonPressed } from './switches.ts';
import type { Instant } from './types/time.ts';

export function update(model: Model, msg: Msg): Model {
  switch (msg.kind) {
    case 'clock': return remoteTimeouts(resetsDue(model, msg.now), msg.now);
    case 'configChanged': return { ...model, config: msg.config };
    case 'overlayRequested': return overlayRequested(model, msg.request, msg.at);
    case 'lampChangedByPerson': return personChanged(model, msg.lamps, msg.rooms, msg.light, msg.at);
    case 'remotePressed': return remotePressed(model, msg.remote, msg.command, msg.anyOn, msg.at);
    case 'remoteButtonPressed': return remoteButtonPressed(model, msg.remote, msg.button, msg.anyOn, msg.at);
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
