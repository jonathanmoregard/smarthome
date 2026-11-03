import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaTruthy, requireBoolean, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { catalogOf, emptyCatalog } from '../runtime/catalog.ts';
import { latestRemoteKey, recordTimestamp } from './resolution.ts';
import { clamp, isObject, object } from './scale.ts';
import { list, num } from './schedule.ts';

const numeric = (v: JsonValue | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const omit = (v: JsonObject, keys: string[]): JsonObject => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
const pick = (v: JsonObject, keys: string[]): JsonObject => Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)));

interface RemotePlanArgs {
  source: string;
  area: string;
  command: string;
}

/** Store button-domain intent; rendered brightness/color belong to the resolver. */
export function remotePlan(ctx: ScriptContext, args: RemotePlanArgs): JsonObject {
  const source = args.source, command = args.command, area = args.area;
  const room = Object.values(ctx.areas).includes(area) ? area : '';
  const overrides = object(ctx.attr('sensor.ls_overrides', 'overrides'));
  const stamp = recordTimestamp(ctx.now);
  const revision = ctx.state['sensor.ls_overrides']?.last_updated ?? ctx.now;
  const inputKey = latestRemoteKey(overrides, room);
  const inputRecord = object(overrides[inputKey]);
  let timingRevision = 0;
  const expiry = ctx.get('input_boolean.ls_ovr_next_block_on') === 'on';
  if (['up', 'down'].includes(command) && expiry) {
    const ids = ['input_boolean.ls_ovr_next_block_on'];
    for (const scope of ['house', room]) for (const block of ['day', 'cosy', 'night']) {
      ids.push(`input_boolean.ls_${scope}_${block}_own_timing`, `input_datetime.ls_${scope}_${block}_start`,
        `input_datetime.ls_${scope}_${block}_weekend`, `input_number.ls_${scope}_${block}_fade`);
    }
    timingRevision = Math.max(0, ...ids.map(id => recordTimestamp(ctx.state[id]?.last_updated)));
  }
  const inputValue = object(inputRecord.value);
  const needsContext = ['left', 'right'].includes(command) || (['up', 'down'].includes(command) && expiry
    && (num(inputValue.remote_valid_until === undefined ? 0 : inputValue.remote_valid_until) <= stamp || inputValue.remote_timing_revision !== timingRevision));
  const rawCache = ctx.attr(`sensor.ls_cache_${room}`, 'cache');
  const cache: JsonValue = rawCache !== undefined && jinjaTruthy(rawCache) ? rawCache : {};
  const current = needsContext ? object(ctx.run('ls_room_plan', { room, overrides,
    cache, reason: 'remote' })) : { plan: {} };
  const plan = object(current.plan);
  // The captured script calls effects_catalog only for these three commands.
  const catalog = ['toggle', 'left', 'right'].includes(command) ? catalogOf(ctx) : emptyCatalog();
  const key = `channels:${source}`;
  let old = inputRecord;
  if (old.scope !== 'room' || old.target !== room || list(plan.stale_keys).includes(inputKey)) old = {};
  const value = object(old.value);
  const bounds = Object.hasOwn(value, 'step_range') ? value.step_range : { min: -20, max: 20 };
  const validBounds = isObject(bounds) && numeric(bounds.min) && numeric(bounds.max)
    && -20 <= bounds.min && bounds.min <= bounds.max && bounds.max <= 20;
  let result: JsonObject = { op: 'noop' };
  if (room !== '' && ['up', 'down', 'left', 'right', 'toggle', 'reset', 'sara_toggle'].includes(command)
    && (validBounds || ['toggle', 'reset', 'sara_toggle'].includes(command))) {
    if (command === 'sara_toggle') {
      result = Object.hasOwn(overrides, 'mode:sara') ? { op: 'clear', keys: ['mode:sara'], via: 'remote' }
        : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'remote' };
    } else if (command === 'toggle') {
      const targets = [...Object.keys(catalog.members), ...Object.keys(object(ctx.attr('sensor.ls_overrides', 'switch_ranges')))]
        .filter(id => ctx.areas[id] === room);
      const saved = object(ctx.attr('sensor.ls_overrides', 'power'))[room];
      result = { op: 'power', area: room, on: typeof saved === 'boolean' ? !saved : !targets.some(id => ctx.get(id) === 'on'), targets, via: 'remote' };
    } else if (command === 'reset') result = { op: 'clear_room', area: room, via: 'remote' };
    else {
      if (!isObject(bounds) || !numeric(bounds.min) || !numeric(bounds.max)) throw Error('Invalid remote input bounds');
      const low = bounds.min, high = bounds.max;
      const identity: JsonObject = { steps: 0, lower: low, upper: high, anchor: 'current', updated: stamp };
      let adjustment = isObject(value.adjustment) ? { ...value.adjustment } : isObject(value.selection_input) ? { ...value.selection_input } : undefined;
      if (adjustment === undefined) {
        adjustment = { ...identity, updated: recordTimestamp(old.when) };
        if (old.kind === 'channels' && numeric(value.position)) adjustment.legacy_position = value.position;
      }
      let restart = false;
      for (const [other, raw] of Object.entries(overrides)) {
        if (other === key || !isObject(raw)) continue;
        const applies = raw.scope === 'room' && raw.target === room || raw.scope === 'house' && raw.target === 'house' && !(ctx.labels?.private_room ?? []).includes(room);
        if (!applies || !isObject(raw.value)) continue;
        const claim = object(object(raw.value.channels).brightness);
        const newer = Object.keys(claim).length
          ? num(claim.updated === undefined ? recordTimestamp(raw.when) : claim.updated)
          : (() => {
              const rawAdjustment = raw.value.adjustment === undefined
                ? {}
                : requireObject(raw.value, 'adjustment', 'ls_remote_plan.override.value');
              return num(rawAdjustment.updated === undefined ? 0 : rawAdjustment.updated);
            })();
        if (newer > num(adjustment.updated === undefined ? 0 : adjustment.updated)) restart = true;
      }
      if (restart && ['up', 'down'].includes(command)) adjustment = { ...identity };
      let lower = clamp(num(adjustment.lower), low, high), upper = clamp(num(adjustment.upper), low, high);
      adjustment = { ...adjustment, steps: lower === upper ? 0 : num(adjustment.steps), lower, upper };
      let next: JsonObject = { ...omit(value, ['channels', 'position']), step_range: bounds };
      if (old.kind === 'channels' && Object.values(object(value.channels)).some(x => object(x).kind === 'effect')) next.legacy_channels = value.channels!;
      if (command === 'up' || command === 'down') {
        const delta = command === 'up' ? 1 : -1;
        const hasUp = adjustment.has_up === undefined
          ? false
          : requireBoolean(adjustment.has_up, 'ls_remote_plan.adjustment.has_up');
        lower = clamp(lower + delta, low, high); upper = clamp(upper + delta, low, high);
        adjustment = { ...adjustment, steps: lower === upper ? 0 : num(adjustment.steps) + delta, lower, upper,
          updated: stamp, last: command, has_up: hasUp || command === 'up' };
        next.adjustment = adjustment;
      } else {
        const choices = ['day', 'cosy', 'Candle', ...Object.keys(catalog.effects).filter(k => !['Candle', 'Colour loop', 'Breathe', 'Normal light'].includes(k))];
        const group = object(object(object(plan.resolved).targets)[`room:${room}`]);
        const selectedValue = value.selection === undefined
          ? (group.period === undefined ? 'day' : group.period)
          : value.selection;
        let selected = requireString({ selection: selectedValue }, 'selection', 'ls_remote_plan');
        const fields = ['period', 'period_updated', 'selection_updated', 'selection_input', 'selection_instance', 'legacy_channels'];
        const contexts: JsonObject = { ...object(value.preset_contexts), [selected]: pick(next, fields) };
        const index = Math.max(0, choices.indexOf(selected));
        selected = choices[(index + (command === 'right' ? 1 : -1) + choices.length) % choices.length]!;
        let saved = contexts[selected];
        if (!isObject(saved)) saved = ['day', 'cosy'].includes(selected)
          ? { period: selected, period_updated: stamp, selection_updated: stamp }
          : { ...pick(next, ['period', 'period_updated']), selection_updated: stamp, selection_input: adjustment, selection_instance: `${source}:${selected}` };
        next = { ...omit(next, fields), selection: selected, adjustment, preset_contexts: contexts, ...saved };
      }
      const schedule = object(object(plan.schedule_details)[room]);
      if (Object.keys(schedule).length) next = { ...next,
        remote_valid_until: num(schedule.next_fs === undefined ? 0 : schedule.next_fs),
        remote_timing_revision: timingRevision };
      result = { op: 'set', records: [{ kind: 'input', key, source, scope: 'room', target: room, value: next }], via: 'remote' };
    }
  }
  return { ...result, input_revision: revision, received_at: stamp, request_id: `${source}:${stamp}` };
}

export const remoteInputHandlers: ScriptHandlers = {
  // Captured source/area/command are raw at 7/4/15 sites and form identifiers,
  // mapping keys and command branches. Missing or malformed values must raise.
  ls_remote_plan: withParsedArgs({
    parse: args => ({
      source: requireString(args, 'source', 'ls_remote_plan'),
      area: requireString(args, 'area', 'ls_remote_plan'),
      command: requireString(args, 'command', 'ls_remote_plan'),
    }),
    run: remotePlan,
  }),
};
