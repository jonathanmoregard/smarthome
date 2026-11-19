import type { ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { requireString } from '../runtime/parse.ts';
import { catalogOf, emptyCatalog } from '../runtime/catalog.ts';
import { typed } from '../runtime/entrypoints.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import { switchRangeEntities } from '../parse/planning.ts';
import type { AssembledMap } from '../parse/overrides.ts';
import { overridesRevision } from '../parse/sensors.ts';
import {
  contextEntries, noInputRecord, presetSelection, remoteCache, remoteOverrides, remoteRoomPlan, roomPower,
} from '../parse/remote-input.ts';
import { clamp } from './scale.ts';

const omit = (v: AssembledMap, keys: string[]): AssembledMap => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
const pick = (v: AssembledMap, keys: string[]): AssembledMap => Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)));

interface RemotePlanArgs {
  source: string;
  area: string;
  command: string;
}

/**
 * An input adjustment as the planner carries it: the document (stored keys in
 * place), and the numbers it reads from it. A stored adjustment's numbers are
 * read on demand and raise where the inline reads did; one the planner builds
 * holds them already.
 */
export interface Adjustment {
  fields: AssembledMap;
  updated(): number;
  lower(): number;
  upper(): number;
  steps(): number;
  hasUp(): boolean;
}

/** An adjustment the planner builds itself; it has no `has_up`. */
function built(fields: AssembledMap & { updated: number; lower: number; upper: number; steps: number }): Adjustment {
  return { fields, updated: () => fields.updated, lower: () => fields.lower, upper: () => fields.upper, steps: () => fields.steps, hasUp: () => false };
}

/** A mode flip carries its own value; `sara_toggle` is the only producer. */
export type RemoteModeRecord = { kind: 'mode'; target: string; value: string };
/**
 * A channel claim. `value` is `next`, which is assembled by spreading the
 * stored override document through `omit`/`pick` and the preset contexts -- it
 * carries fields this planner never names, and it is persisted and compared.
 * So it is an `AssembledMap`: the keys the planner sets, plus the stored ones
 * carried unread. THE INVARIANT.
 */
export type RemoteInputRecord = {
  kind: 'input';
  key: string;
  source: string;
  scope: 'room';
  target: string;
  value: AssembledMap;
};
/**
 * What the remote decided, discriminated by `op`. Every field of every variant
 * is built in `remotePlan` from locals, which is why this types at all -- the
 * passthrough is confined to `RemoteInputRecord.value`.
 *
 * `noop` carries nothing on purpose: `ls_remote_command` tests `op === 'noop'`
 * and accepts without committing, and inventing keys on it would change bytes
 * the gate compares.
 */
export type RemotePlanOp =
  | { op: 'noop' }
  | { op: 'clear'; keys: string[]; via: 'remote' }
  | { op: 'clear_room'; area: string; via: 'remote' }
  | { op: 'power'; area: string; on: boolean; targets: string[]; via: 'remote' }
  | { op: 'set'; records: (RemoteModeRecord | RemoteInputRecord)[]; via: 'remote' };
/** The envelope every answer carries, whatever the operation. */
export type RemotePlanResult = RemotePlanOp & {
  input_revision: string;
  received_at: number;
  request_id: string;
};

/** Store button-domain intent; rendered brightness/color belong to the resolver. */
export function remotePlan(ctx: ScriptContext, args: RemotePlanArgs): RemotePlanResult {
  const source = args.source, command = args.command, area = args.area;
  const room = Object.values(ctx.areas).includes(area) ? area : '';
  const overrides = remoteOverrides(ctx, room);
  const stamp = recordTimestamp(ctx.now);
  const revision = overridesRevision(ctx, 'ls_remote_plan');
  const inputKey = overrides.inputKey;
  const inputRecord = overrides.input;
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
  const inputValue = inputRecord.value;
  const needsContext = ['left', 'right'].includes(command) || (['up', 'down'].includes(command) && expiry
    && (inputValue.validUntil() <= stamp || inputValue.timingRevision !== timingRevision));
  const cache = remoteCache(ctx.attr(`sensor.ls_cache_${room}`, 'cache'));
  const plan = remoteRoomPlan(needsContext ? ctx.run('ls_room_plan', { room, overrides: overrides.document,
    cache, reason: 'remote' }) : undefined);
  // The captured script calls effects_catalog only for these three commands.
  const catalog = ['toggle', 'left', 'right'].includes(command) ? catalogOf(ctx) : emptyCatalog();
  const key = `channels:${source}`;
  const old = inputRecord.scope !== 'room' || inputRecord.target !== room || plan.stale(inputKey) ? noInputRecord() : inputRecord;
  const value = old.value;
  const bounds = value.stepRange.bounds;
  let result: RemotePlanOp = { op: 'noop' };
  if (room !== '' && ['up', 'down', 'left', 'right', 'toggle', 'reset', 'sara_toggle'].includes(command)
    && (bounds !== undefined || ['toggle', 'reset', 'sara_toggle'].includes(command))) {
    if (command === 'sara_toggle') {
      result = overrides.has('mode:sara') ? { op: 'clear', keys: ['mode:sara'], via: 'remote' }
        : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'remote' };
    } else if (command === 'toggle') {
      const targets = [...Object.keys(catalog.members), ...switchRangeEntities(ctx.attr('sensor.ls_overrides', 'switch_ranges'))]
        .filter(id => ctx.areas[id] === room);
      const saved = roomPower(ctx, room);
      result = { op: 'power', area: room, on: saved !== undefined ? !saved : !targets.some(id => ctx.get(id) === 'on'), targets, via: 'remote' };
    } else if (command === 'reset') result = { op: 'clear_room', area: room, via: 'remote' };
    else {
      if (bounds === undefined) throw Error('Invalid remote input bounds');
      const low = bounds.min, high = bounds.max;
      const identity = { steps: 0, lower: low, upper: high, anchor: 'current', updated: stamp };
      let adjustment = value.adjustment === undefined
        ? built({ ...identity, updated: old.whenStamp,
          ...(old.kind === 'channels' && value.legacyPosition !== undefined ? { legacy_position: value.legacyPosition } : {}) })
        : value.adjustment;
      let restart = false;
      for (const other of overrides.others) {
        if (other.key === key) continue;
        // A non-mapping record has no scope or target, so it never applies.
        const applies = other.scope === 'room' && other.target === room || other.scope === 'house' && other.target === 'house' && !(ctx.labels?.private_room ?? []).includes(room);
        if (!applies || !other.valueIsMapping) continue;
        const newer = other.newer();
        if (newer > adjustment.updated()) restart = true;
      }
      if (restart && ['up', 'down'].includes(command)) adjustment = built({ ...identity });
      let lower = clamp(adjustment.lower(), low, high), upper = clamp(adjustment.upper(), low, high);
      const steps = lower === upper ? 0 : adjustment.steps();
      let fields: AssembledMap = { ...adjustment.fields, steps, lower, upper };
      let next: AssembledMap = { ...omit(value.fields, ['channels', 'position']), step_range: value.stepRange.document };
      if (old.kind === 'channels' && value.effectChannels !== undefined) next.legacy_channels = value.effectChannels;
      if (command === 'up' || command === 'down') {
        const delta = command === 'up' ? 1 : -1;
        const hasUp = adjustment.hasUp();
        lower = clamp(lower + delta, low, high); upper = clamp(upper + delta, low, high);
        fields = { ...fields, steps: lower === upper ? 0 : steps + delta, lower, upper,
          updated: stamp, last: command, has_up: hasUp || command === 'up' };
        next.adjustment = fields;
      } else {
        const choices = ['day', 'cosy', 'Candle', ...Object.keys(catalog.effects).filter(k => !['Candle', 'Colour loop', 'Breathe', 'Normal light'].includes(k))];
        let selected = presetSelection(value.selection, plan.roomPeriod(room));
        const names = ['period', 'period_updated', 'selection_updated', 'selection_input', 'selection_instance', 'legacy_channels'];
        const contexts: AssembledMap = { ...value.presetContexts, [selected]: pick(next, names) };
        const index = Math.max(0, choices.indexOf(selected));
        selected = choices[(index + (command === 'right' ? 1 : -1) + choices.length) % choices.length]!;
        const stored = contextEntries(contexts[selected]);
        const saved: AssembledMap = stored !== undefined ? stored : ['day', 'cosy'].includes(selected)
          ? { period: selected, period_updated: stamp, selection_updated: stamp }
          : { ...pick(next, ['period', 'period_updated']), selection_updated: stamp, selection_input: fields, selection_instance: `${source}:${selected}` };
        next = { ...omit(next, names), selection: selected, adjustment: fields, preset_contexts: contexts, ...saved };
      }
      const schedule = plan.schedule(room);
      if (schedule.present) next = { ...next,
        remote_valid_until: schedule.nextFs(),
        remote_timing_revision: timingRevision };
      result = { op: 'set', records: [{ kind: 'input', key, source, scope: 'room', target: room, value: next }], via: 'remote' };
    }
  }
  return { ...result, input_revision: revision, received_at: stamp, request_id: `${source}:${stamp}` };
}

export const remoteInputHandlers: ScriptHandlers = {
  // Captured source/area/command are raw at 7/4/15 sites and form identifiers,
  // mapping keys and command branches. Missing or malformed values must raise.
  ls_remote_plan: typed('ls_remote_plan', {
    parse: args => ({
      source: requireString(args, 'source', 'ls_remote_plan'),
      area: requireString(args, 'area', 'ls_remote_plan'),
      command: requireString(args, 'command', 'ls_remote_plan'),
    }),
    run: remotePlan,
  }),
};
