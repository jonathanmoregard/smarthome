import { turnHandler, WAKE } from '../adapter/turn.ts';
import type { ScriptHandlers } from './context.ts';

/**
 * The names Home Assistant (and the harness) send as inputs: each automation,
 * the dashboard's and the remotes' scripts, the override event's sink, the
 * native controls, the render requests and the loop's own wake. Each runs a
 * turn of the adapter.
 */
const INPUTS: readonly string[] = [
  'automation.remote_center', 'automation.remote_directions', 'automation.remote_preset',
  'automation.lighting_bedroom_remote_preset_arrows',
  'automation.lighting_jonathan_s_bedroom_remote_center', 'automation.lighting_jonathan_s_bedroom_remote_directions',
  'automation.lighting_kitchen_remote_center', 'automation.lighting_kitchen_remote_directions',
  'automation.lighting_kitchen_remote_preset_arrows',
  'automation.lighting_living_room_remote_center', 'automation.lighting_living_room_remote_directions',
  'automation.lighting_living_room_remote_preset_arrows',
  'automation.effects_native_light_controls', 'automation.lighting_schedule_override_store_writer',
  'automation.lighting_recover_pending_output', 'automation.effects_refresh_native_light_controls',
  'automation.lighting_schedule_engine', 'automation.lighting_schedule_end_overrides',
  'automation.lighting_schedule_sara_mode_switch', 'automation.lighting_schedule_lamp_change_detector',
  'automation.switch_lamps_validate_house_defaults',
  'ls_remote_gesture', 'ls_remote_power_quiet', 'ls_remote_command',
  'ls_commit', 'ls_store', 'ls_override_block', 'ls_clear_overrides', 'ls_sara_mode', 'ls_range_save',
  'effects_set', 'effects_ui_sync', 'effects_ui_catalog', 'ls_apply', 'ls_dispatch', 'ls_render', WAKE,
];

/**
 * Every input goes through the adapter's turn. `effects_catalog` serves the
 * unparsed catalog document, deliberately: the e2e harness reads the house's
 * bulbs, groups and lamps from it, and the document includes fields no
 * lighting logic reads.
 */
export const handlers: ScriptHandlers = {
  ...Object.fromEntries(INPUTS.map(name => [name, turnHandler(name)])),
  effects_catalog: ctx => structuredClone(ctx.rawCatalog()),
};
