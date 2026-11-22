import type { Catalog } from '../../runtime/catalog.ts';
import type { HouseView } from '../../runtime/effects.ts';
import type { Verbatim } from '../../runtime/verbatim.ts';
import { recordTimestamp } from '../../parse/resolution.ts';
import type { AssembledMap, StoredValue } from '../../parse/overrides.ts';
import { overridesRevision } from '../../parse/sensors.ts';
import { contextEntries, noInputRecord, presetSelection, remoteCache, remoteOverrides, roomPower, roomText } from '../../parse/remote-input.ts';
import { switchRangeIterable } from '../../parse/planning.ts';
import type { RemoteOverrides, RemoteRoomPlan } from '../../parse/remote-input.ts';
import { clamp } from './scale.ts';
import type { PowerTarget, RemoteSource, RoomId } from '../../domain/types/ids.ts';
import { entriesOf } from '../../domain/types/ids.ts';
import type { RemotePress } from '../../domain/types/remote.ts';
import { pressCommand } from '../../domain/types/remote.ts';
import type { OverlayKey } from '../../adapter/codecs/overlay-key.ts';
import { remoteInputKey, sameOverlayKey, SARA_MODE } from '../../adapter/codecs/overlay-key.ts';

const omit = (v: AssembledMap, keys: string[]): AssembledMap => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
const pick = (v: AssembledMap, keys: string[]): AssembledMap => Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)));

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
  /** Captured `a.v.get('has_up',false) or command=='up'`: the stored value when Jinja-truthy, else the press. */
  hasUp(pressedUp: boolean): StoredValue;
}

/** An adjustment the planner builds itself; it has no `has_up`. */
function built(fields: AssembledMap & { updated: number; lower: number; upper: number; steps: number }): Adjustment {
  return { fields, updated: () => fields.updated, lower: () => fields.lower, upper: () => fields.upper, steps: () => fields.steps,
    hasUp: pressedUp => pressedUp };
}

/**
 * Sara mode switched on: `sara_toggle` is the only producer, and switching it
 * off is a `clear` of its key, so the target and value are these literals.
 */
export type RemoteModeRecord = { kind: 'mode'; target: 'sara'; value: 'on' };
/**
 * A channel claim. `value` is `next`, which is assembled by spreading the
 * stored override document through `omit`/`pick` and the preset contexts -- it
 * carries fields this planner never names, and it is persisted and compared.
 * So it is an `AssembledMap`: the keys the planner sets, plus the stored ones
 * carried unread. THE INVARIANT.
 */
export type RemoteInputRecord = {
  kind: 'input';
  /**
   * Whose input this is. The record's overlay key is derived from it
   * ({@link remoteInputKey}), never held beside it, so the two cannot disagree;
   * `remotePlanDocument` writes the key's saved text where the record leaves.
   */
  source: RemoteSource;
  scope: 'room';
  target: RoomId;
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
  | { op: 'clear'; keys: OverlayKey[]; via: 'remote' }
  | { op: 'clear_room'; area: RoomId; via: 'remote' }
  | { op: 'power'; area: RoomId; on: boolean; targets: PowerTarget[]; via: 'remote' }
  | { op: 'set'; records: (RemoteModeRecord | RemoteInputRecord)[]; via: 'remote' };
/** The envelope every answer carries, whatever the operation. */
export type RemotePlan = RemotePlanOp & {
  input_revision: string;
  received_at: number;
  request_id: string;
};


/** What `ls_remote_plan` reads before it may ask `ls_room_plan` for the room's context. */
export interface RemoteOpening {
  /** The area, when some entity is in it; else none. */
  room: RoomId | undefined;
  overrides: RemoteOverrides;
  stamp: number;
  revision: string;
  /** The newest timing-helper update, for a dimming press under next-block expiry; else 0. */
  timingRevision: number;
  /** Does the decision need the room plan? */
  needsContext: boolean;
  /** The room cache forwarded to the room plan. */
  cache: Verbatim;
}

export interface RemotePlanRequest {
  source: RemoteSource;
  area: RoomId;
  command: RemotePress;
}
export function remoteOpening(view: HouseView, args: RemotePlanRequest): RemoteOpening {
  const command = pressCommand(args.command), area = args.area;
  const room = Object.values(view.rooms.ofId).includes(area) ? area : undefined;
  const overrides = remoteOverrides(view, room);
  const stamp = recordTimestamp(view.now);
  const revision = overridesRevision(view, 'ls_remote_plan');
  let timingRevision = 0;
  const expiry = view.get('input_boolean.ls_ovr_next_block_on') === 'on';
  const dimming = command === 'up' || command === 'down';
  if (dimming && expiry) {
    const ids = ['input_boolean.ls_ovr_next_block_on'];
    for (const scope of ['house', roomText(room)]) for (const block of ['day', 'cosy', 'night']) {
      ids.push(`input_boolean.ls_${scope}_${block}_own_timing`, `input_datetime.ls_${scope}_${block}_start`,
        `input_datetime.ls_${scope}_${block}_weekend`, `input_number.ls_${scope}_${block}_fade`);
    }
    timingRevision = Math.max(0, ...ids.map(id => recordTimestamp(view.state[id]?.last_updated)));
  }
  const inputValue = overrides.input.value;
  const needsContext = command === 'left' || command === 'right' || (dimming && expiry
    && (inputValue.validUntil() <= stamp || inputValue.timingRevision !== timingRevision));
  const cache = remoteCache(view.attr(`sensor.ls_cache_${roomText(room)}`, 'cache'));
  return { room, overrides, stamp, revision, timingRevision, needsContext, cache };
}

/** The command's operation, from the opening reads, the room plan and the catalog, on the house after both runs. */
export function remoteDecision(view: HouseView, args: RemotePlanRequest, opening: RemoteOpening, plan: RemoteRoomPlan,
  catalog: Catalog): RemotePlan {
  // No command: a press that does nothing, the scripts' noop.
  const source = args.source, command = pressCommand(args.command);
  const { room, overrides, stamp, revision, timingRevision } = opening;
  const inputKey = overrides.inputKey;
  const inputRecord = overrides.input;
  const key = remoteInputKey(source);
  // Compared as saved text: a remote in no room reads a record saved for the empty target, as the scripts' `''` room did.
  const old = inputRecord.scope !== 'room' || inputRecord.target !== roomText(room) || plan.stale(inputKey) ? noInputRecord() : inputRecord;
  const value = old.value;
  const bounds = value.stepRange.bounds;
  let result: RemotePlanOp = { op: 'noop' };
  if (room !== undefined && command !== undefined
    && (bounds !== undefined || command === 'toggle' || command === 'reset' || command === 'sara_toggle')) {
    if (command === 'sara_toggle') {
      result = overrides.has(SARA_MODE) ? { op: 'clear', keys: [SARA_MODE], via: 'remote' }
        : { op: 'set', records: [{ kind: 'mode', target: 'sara', value: 'on' }], via: 'remote' };
    } else if (command === 'toggle') {
      const targets: PowerTarget[] = [...entriesOf(catalog.members).map(([lamp]) => lamp),
        ...switchRangeIterable(view.attr('sensor.ls_overrides', 'switch_ranges'))]
        .filter(id => view.rooms.ofId[id] === room);
      const saved = roomPower(view, room);
      result = { op: 'power', area: room, on: saved !== undefined ? !saved : !targets.some(id => view.get(id) === 'on'), targets, via: 'remote' };
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
        if (sameOverlayKey(other.key, key)) continue;
        // A non-mapping record has no scope or target, so it never applies.
        const applies = other.scope === 'room' && other.target === room || other.scope === 'house' && other.target === 'house' &&
          !(view.labels?.private_room ?? []).includes(room);
        if (!applies || !other.valueIsMapping) continue;
        const newer = other.newer();
        if (newer > adjustment.updated()) restart = true;
      }
      if (restart && (command === 'up' || command === 'down')) adjustment = built({ ...identity });
      let lower = clamp(adjustment.lower(), low, high), upper = clamp(adjustment.upper(), low, high);
      const steps = lower === upper ? 0 : adjustment.steps();
      let fields: AssembledMap = { ...adjustment.fields, steps, lower, upper };
      let next: AssembledMap = { ...omit(value.fields, ['channels', 'position']), step_range: value.stepRange.document };
      if (old.kind === 'channels' && value.effectChannels !== undefined) next.legacy_channels = value.effectChannels;
      if (command === 'up' || command === 'down') {
        const delta = command === 'up' ? 1 : -1;
        const hasUp = adjustment.hasUp(command === 'up');
        lower = clamp(lower + delta, low, high); upper = clamp(upper + delta, low, high);
        fields = { ...fields, steps: lower === upper ? 0 : steps + delta, lower, upper,
          updated: stamp, last: command, has_up: hasUp };
        next.adjustment = fields;
      } else {
        const choices = ['day', 'cosy', 'Candle', ...Object.keys(catalog.effects).filter(k =>
          k !== 'Candle' && k !== 'Normal light')];
        // `undefined`: a saved selection that is not text names no choice, and has no name to save its context under.
        const current = presetSelection(value.selection, plan.roomPeriod(room));
        const names = ['period', 'period_updated', 'selection_updated', 'selection_input', 'selection_instance', 'legacy_channels'];
        const contexts: AssembledMap = current === undefined ? { ...value.presetContexts }
          : { ...value.presetContexts, [current]: pick(next, names) };
        const index = current === undefined ? 0 : Math.max(0, choices.indexOf(current));
        const selected = choices[(index + (command === 'right' ? 1 : -1) + choices.length) % choices.length]!;
        const stored = contextEntries(contexts[selected]);
        const saved: AssembledMap = stored !== undefined ? stored : ['day', 'cosy'].includes(selected)
          ? { period: selected, period_updated: stamp, selection_updated: stamp }
          : { ...pick(next, ['period', 'period_updated']), selection_updated: stamp, selection_input: fields,
            selection_instance: `${source}:${selected}` };
        next = { ...omit(next, names), selection: selected, adjustment: fields, preset_contexts: contexts, ...saved };
      }
      const schedule = plan.scheduleDetails(room);
      if (schedule.present) next = { ...next,
        remote_valid_until: schedule.nextFs(),
        remote_timing_revision: timingRevision };
      result = { op: 'set', records: [{ kind: 'input', source, scope: 'room', target: room, value: next }], via: 'remote' };
    }
  }
  return { ...result, input_revision: revision, received_at: stamp, request_id: `${source}:${stamp}` };
}
