import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { latestRemoteKey, recordTimestamp } from './resolution.ts';
import { clamp, isObject, object } from './scale.ts';

const numeric = (v: JsonValue | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const list = (v: JsonValue | undefined): JsonValue[] => Array.isArray(v) ? v : [];
const omit = (v: JsonObject, keys: string[]): JsonObject => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
const pick = (v: JsonObject, keys: string[]): JsonObject => Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)));

/** Store button-domain intent; rendered brightness/color belong to the resolver. */
export function remotePlan(ctx: ScriptContext, args: JsonObject): JsonObject {
  const source = String(args.source ?? ''), command = String(args.command ?? '');
  const area = String(args.area ?? '');
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
    && (Number(inputValue.remote_valid_until ?? 0) <= stamp || inputValue.remote_timing_revision !== timingRevision));
  const current = needsContext ? object(ctx.run('ls_room_plan', { room, overrides,
    cache: ctx.attr(`sensor.ls_cache_${room}`, 'cache') ?? {}, reason: 'remote' })) : { plan: {} };
  const plan = object(current.plan);
  const catalog = ['toggle', 'left', 'right'].includes(command) ? object(ctx.run('effects_catalog')) : {};
  const key = `channels:${source}`;
  let old = inputRecord;
  if (old.scope !== 'room' || old.target !== room || list(plan.stale_keys).includes(inputKey)) old = {};
  const value = object(old.value);
  const bounds = Object.hasOwn(value, 'step_range') ? value.step_range : { min: -20, max: 20 };
  const validBounds = isObject(bounds) && numeric(bounds.min) && numeric(bounds.max)
    && -20 <= bounds.min && bounds.min <= bounds.max && bounds.max <= 20;
  let result: JsonObject = { op: 'noop' };
  if (room && ['up', 'down', 'left', 'right', 'toggle', 'reset', 'sara_toggle'].includes(command)
    && (validBounds || ['toggle', 'reset', 'sara_toggle'].includes(command))) {
    if (command === 'sara_toggle') {
      result = Object.hasOwn(overrides, 'mode:sara') ? { op: 'clear', keys: ['mode:sara'], via: 'remote' }
        : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'remote' };
    } else if (command === 'toggle') {
      const targets = [...Object.keys(object(catalog.members)), ...Object.keys(object(ctx.attr('sensor.ls_overrides', 'switch_ranges')))]
        .filter(id => ctx.areas[id] === room);
      const saved = object(ctx.attr('sensor.ls_overrides', 'power'))[room];
      result = { op: 'power', area: room, on: typeof saved === 'boolean' ? !saved : !targets.some(id => ctx.get(id) === 'on'), targets, via: 'remote' };
    } else if (command === 'reset') result = { op: 'clear_room', area: room, via: 'remote' };
    else {
      if (!isObject(bounds) || !numeric(bounds.min) || !numeric(bounds.max)) throw Error('Invalid remote input bounds');
      const low = bounds.min, high = bounds.max;
      const identity: JsonObject = { steps: 0, lower: low, upper: high, anchor: 'current', updated: stamp };
      let adjustment = isObject(value.adjustment) ? { ...value.adjustment } : isObject(value.selection_input) ? { ...value.selection_input } : undefined;
      if (!adjustment) {
        adjustment = { ...identity, updated: recordTimestamp(old.when) };
        if (old.kind === 'channels' && numeric(value.position)) adjustment.legacy_position = value.position;
      }
      let restart = false;
      for (const [other, raw] of Object.entries(overrides)) {
        if (other === key || !isObject(raw)) continue;
        const applies = raw.scope === 'room' && raw.target === room || raw.scope === 'house' && raw.target === 'house' && !(ctx.labels?.private_room ?? []).includes(room);
        if (!applies || !isObject(raw.value)) continue;
        const claim = object(object(raw.value.channels).brightness);
        const newer = Object.keys(claim).length ? Number(claim.updated ?? recordTimestamp(raw.when))
          : Number(object(raw.value.adjustment).updated ?? 0);
        if (newer > Number(adjustment.updated ?? 0)) restart = true;
      }
      if (restart && ['up', 'down'].includes(command)) adjustment = { ...identity };
      let lower = clamp(Number(adjustment.lower), low, high), upper = clamp(Number(adjustment.upper), low, high);
      adjustment = { ...adjustment, steps: lower === upper ? 0 : adjustment.steps ?? 0, lower, upper };
      let next: JsonObject = { ...omit(value, ['channels', 'position']), step_range: bounds };
      if (old.kind === 'channels' && Object.values(object(value.channels)).some(x => object(x).kind === 'effect')) next.legacy_channels = value.channels!;
      if (command === 'up' || command === 'down') {
        const delta = command === 'up' ? 1 : -1;
        lower = clamp(lower + delta, low, high); upper = clamp(upper + delta, low, high);
        adjustment = { ...adjustment, steps: lower === upper ? 0 : Number(adjustment.steps) + delta, lower, upper,
          updated: stamp, last: command, has_up: Boolean(adjustment.has_up) || command === 'up' };
        next.adjustment = adjustment;
      } else {
        const choices = ['day', 'cosy', 'Candle', ...Object.keys(object(catalog.effects)).filter(k => !['Candle', 'Colour loop', 'Breathe', 'Normal light'].includes(k))];
        const group = object(object(object(plan.resolved).targets)[`room:${room}`]);
        let selected = String(value.selection ?? group.period ?? 'day');
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
      if (Object.keys(schedule).length) next = { ...next, remote_valid_until: schedule.next_fs ?? 0, remote_timing_revision: timingRevision };
      result = { op: 'set', records: [{ kind: 'input', key, source, scope: 'room', target: room, value: next }], via: 'remote' };
    }
  }
  return { ...result, input_revision: revision, received_at: stamp, request_id: `${source}:${stamp}` };
}

export const remoteInputHandlers: ScriptHandlers = { ls_remote_plan: remotePlan };
