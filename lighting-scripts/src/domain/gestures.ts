import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';

const presets = [200, 285, 370, 454, 588];
const directions = ['left', 'right', 'up', 'down'];
const accepted = ['power', 'power_done', 'preset', 'cancel', ...directions];
function object(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function number(value: string, fallback = 0): number {
  const parsed = value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function roomArg(args: JsonObject): string {
  if (typeof args.room !== 'string' || !/^[a-z0-9_]+$/.test(args.room)) throw Error('Gesture room must be a runtime room ID');
  return args.room;
}

/** Serialized actor. It never waits for actuator services or the power quiet window. */
export function remoteGesture(ctx: ScriptContext, args: JsonObject): JsonValue {
  const room = roomArg(args);
  let command = typeof args.command === 'string' ? args.command : '';
  if (!accepted.includes(command)) return null;
  const prefix = `ls_${room}_remote_`;
  const chord = `timer.${prefix}chord`;
  const helper = (key: string) => `${key === 'power_token' ? 'input_text' : 'input_number'}.${prefix}${key}`;
  const set = (key: string, value: string | number) => {
    const entity = helper(key);
    ctx.put(entity, String(value));
    ctx.emit(`${key === 'power_token' ? 'input_text' : 'input_number'}.set_value`, { value }, { entity_id: entity });
  };
  const timer = (start: boolean) => {
    ctx.put(chord, start ? 'active' : 'idle');
    ctx.emit(`timer.${start ? 'start' : 'cancel'}`, start ? { duration: '00:00:03' } : {}, { entity_id: chord });
  };
  const clearChord = () => { set('chord_step', 0); timer(false); };
  const send = (logical: string) => {
    const area = (typeof args.device_id === 'string' && ctx.areas[args.device_id]) || room;
    ctx.emit('script.turn_on', { variables: { source: args.source ?? '', area, command: logical, dry_run: false } }, { entity_id: 'script.ls_remote_command' });
  };
  const step = Math.trunc(number(ctx.get(helper('chord_step'))));
  const active = ctx.get(chord) === 'active';
  let clicks = Math.trunc(number(ctx.get(helper('power_count'))));
  const saved = ctx.get(helper('power_token'));
  const stored = ['unknown', 'unavailable'].includes(saved) ? '' : saved;
  const quietActive = clicks > 0 && stored.length > 0 && Date.parse(stored) + 600 > Date.parse(ctx.now);
  const complete = () => {
    set('power_count', 0);
    set('power_token', '');
    if (clicks === 1 || clicks >= 3) { clearChord(); send(clicks === 1 ? 'toggle' : 'reset'); }
  };
  if (command === 'power_done') {
    if (!args.token || args.token !== stored || clicks <= 0) return null;
    complete();
    return null;
  }
  if (command === 'power') {
    set('preset', -1);
    if (clicks > 0 && !quietActive) complete();
    clicks = quietActive ? Math.min(3, clicks + 1) : 1;
    set('power_count', clicks);
    if (clicks === 1) { set('chord_step', -1); timer(true); }
    else if (clicks === 2 && active && step === -1) { set('chord_step', 1); timer(true); }
    else clearChord();
    set('power_token', ctx.now);
    // The host launches the restartable quiet script. Keep the HA service boundary
    // intact so the same recorder and event router can execute this actor.
    ctx.emit('script.turn_on', { variables: { token: ctx.now } }, { entity_id: `script.ls_remote_power_quiet_${room}` });
    return null;
  }
  if (command === 'preset') {
    const payload = object(args.payload);
    if (payload.action !== 'color_temperature_move') return null;
    const preset = payload.action_color_temperature;
    if (typeof preset !== 'number' || !presets.includes(preset)) { clearChord(); return null; }
    const index = presets.indexOf(preset);
    const previous = number(ctx.get(helper('preset')), -2);
    if (index === previous) return null;
    const delta = previous === -1 ? (index === 0 ? 1 : index === 4 ? 4 : -1)
      : [0, 1, 2, 3, 4].includes(previous) ? (index - previous + 5) % 5 : -1;
    set('preset', index);
    command = delta === 1 ? 'right' : delta === 4 ? 'left' : 'cancel';
  }
  if (active && [1, 2, 3, 4].includes(step) && command === ['left', 'right', 'left', 'right'][step - 1]) {
    if (step === 4) { clearChord(); send('sara_toggle'); }
    else { set('chord_step', step + 1); timer(true); }
    return null;
  }
  if (step !== 0 || active) clearChord();
  if (directions.includes(command)) send(command);
  return null;
}

export const gestureHandlers: ScriptHandlers = {
  ls_remote_gesture: remoteGesture,
  ls_remote_power_quiet: (ctx, args) => {
    const room = roomArg(args);
    ctx.schedule('ls_remote_gesture', { ...args, room, command: 'power_done' }, 600);
    return null;
  },
};
