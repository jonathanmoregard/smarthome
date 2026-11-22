import type { Verbatim } from '../runtime/verbatim.ts';
import type { ScheduleEnvelope, TargetEntry } from './schedule.ts';
import { recordTimestamp } from '../parse/resolution.ts';
import type { OpaqueMap } from '../parse/overrides.ts';
import { planRevision } from '../parse/controller.ts';
import type { ResolutionResult } from './resolution.ts';
import type { CompiledGradients } from './gradient.ts';
import type { RemotePlanResult } from './remote-input.ts';
import type { HouseView } from '../runtime/effects.ts';
import type { PowerTarget, RemoteSource, RoomId, SwitchId } from './types/ids.ts';
import type { RemotePress } from './types/remote.ts';
import type { Percent } from './types/light.ts';
import { overlayKeyText, SARA_MODE } from './types/overlay.ts';

/**
 * A valid switch interval: its bounds as numbers (a boolean bound is Python's
 * 0 or 1, since captured `is number` admits it) and as stored, for the report.
 */
export interface SwitchInterval { low: Percent; high: Percent; stored: [number | boolean, number | boolean] }

export interface SwitchPlanArgs {
  /** Each switch-range rule, its interval read at its turn, or `undefined` unless valid. */
  rules: Array<{ entity: SwitchId; range: () => SwitchInterval | undefined }>;
  /** The resolved room target a rule follows, read leniently; `on` is required once read. */
  roomTarget(room: RoomId): { populated: boolean; level: () => number | undefined; on: () => boolean };
}

/** The override mapping `ls_plan` plans with: as stored (forwarded to the baseline), and entry by entry. */
export interface PlanOverrides {
  document: Verbatim;
  entries: OpaqueMap;
}

export interface PlanArgs {
  testOverrides: PlanOverrides | undefined;
  /** Forwarded to `ls_base` unread (`null` when absent); `ls_base` parses it. */
  testNow: Verbatim;
  reason: string;
  /** The room the request names; none when it names none or `''` (captured `default('')`). */
  room: RoomId | undefined;
}

export interface ApplyArgs {
  dryRun: boolean;
  forceAll: boolean;
  /** Is test_now defined and Jinja-truthy? */
  testNowGiven: boolean;
  /** Forwarded to `ls_plan` unread (`null` when absent). */
  testNow: Verbatim;
  hasTestOverrides: boolean;
  /** Forwarded to `ls_plan` unread (`null` when absent). */
  testOverrides: Verbatim;
  reason: string;
  /** Forwarded to `ls_commit` unread. */
  lights: () => Verbatim;
}

export interface RemoteCommandArgs {
  source: RemoteSource;
  area: RoomId;
  command: RemotePress;
  dryRun: boolean;
}

/**
 * One switch's planned state.
 *
 * Every field is computed here from the rule and the room's target, so the
 * parsed view and the serialised bytes cannot diverge -- nothing is passed
 * through from an input document. That is what makes this result safe to hand
 * callers as a type while `ls_plan` still serialises it into compared JSON.
 */
export type SwitchDecision = {
  on: boolean;
  room: RoomId;
  /** The room's level in percent; absent when the room shows no level (it is off), and the switch is then off. */
  brightness?: number;
  range: [number | boolean, number | boolean];
};
/** Each switch's planned state; `ls_switch_plan` answers it under the wire key `switches`. */
export function switchPlan(areas: Readonly<Record<string, RoomId>>, args: SwitchPlanArgs): Record<SwitchId, SwitchDecision> {
  const switches: Record<SwitchId, SwitchDecision> = {};
  for (const { entity, range } of args.rules) {
    const room = areas[entity];
    // The range is read first, so a malformed one raises for a switch in no room too.
    const interval = range();
    // A switch in no room has no room target to follow.
    if (room === undefined || interval === undefined) continue;
    const group = args.roomTarget(room);
    if (!group.populated) continue;
    const { low, high } = interval;
    const level = group.level();
    const brightness = level === undefined ? undefined : level * 100 / 255;
    const on = group.on();
    switches[entity] = { on: on && brightness !== undefined && low <= brightness && brightness <= high,
      room, ...(brightness === undefined ? {} : { brightness }), range: [...interval.stored] };
  }
  return switches;
}

/**
 * The document `ls_plan` builds, with every field concrete.
 *
 * `Omit` rather than a plain intersection, and that is load-bearing: `plan`
 * spreads `...schedule` and then *overwrites* `revision` and `sara_mirror`, and
 * the widths differ. `ScheduleEnvelope.sara_mirror` is `'off' | null`, but this
 * document's is `'on' | 'off' | null`, because `wanted` is `'on'` whenever
 * `mode:sara` is active. Intersecting would narrow the field back to the
 * envelope's two cases and reject the value this function actually produces.
 *
 * Every field is either computed here or the result of an already-converted
 * entrypoint, so there is no passthrough and THE INVARIANT (a projected field
 * must never reach compared JSON) cannot be broken by this type. The envelope's
 * own loosely-typed fields keep the reasons written at their declarations in
 * `schedule.ts`.
 */
export type PlanDocument = Omit<ScheduleEnvelope, 'revision' | 'sara_mirror'> & {
  base: Record<string, TargetEntry>;
  resolved: ResolutionResult;
  gradients: CompiledGradients;
  switches: Record<SwitchId, SwitchDecision>;
  revision: string;
  plan_order: number;
  remote: boolean;
  sara_mirror: 'on' | 'off' | null;
};


/** The parts `ls_plan` answers with, once every call is done. */
export interface PlanParts {
  schedule: ScheduleEnvelope;
  base: Record<string, TargetEntry>;
  resolved: ResolutionResult;
  gradients: CompiledGradients;
  switches: Record<SwitchId, SwitchDecision>;
  /** The overrides the baseline did not mark stale. */
  active: OpaqueMap;
  reason: string;
}

/**
 * The plan document: the schedule with the plan's fields over it. The
 * revision, the plan order and the Sara mirror are read here, after the last
 * call, where the captured script reads them.
 */
export function planAnswer(view: HouseView, parts: PlanParts): PlanDocument {
  const revision = planRevision(view.state['sensor.ls_overrides']?.last_updated);
  const wanted = Object.hasOwn(parts.active, overlayKeyText(SARA_MODE)) ? 'on' : 'off';
  return { ...parts.schedule, base: parts.base, resolved: parts.resolved, gradients: parts.gradients,
    switches: parts.switches, revision,
    plan_order: recordTimestamp(view.now), remote: parts.reason === 'remote',
    sara_mirror: view.get('input_boolean.ls_sara_mode_mirror') !== wanted ? wanted : null };
}


/** A planned change, committed against the revision it was planned at. */
export type RemoteCommit = RemotePlanResult & { expected_revision: string; area: RoomId; via: 'remote'; source: RemoteSource };

/** A remote's planned change as the store is asked to commit it: against the revision it was planned at, from its remote. */
export function remoteCommit(plan: RemotePlanResult, command: RemoteCommandArgs): RemoteCommit {
  return { ...plan, expected_revision: plan.input_revision, area: command.area, via: 'remote', source: command.source };
}

/** The lamps an accepted remote change switches. Switched on, they are then rendered as a lamp-on apply. */
export type PowerSwitch =
  | { tag: 'off'; targets: PowerTarget[] }
  | { tag: 'on_then_render'; targets: PowerTarget[] };

/** What an accepted remote change switches: a power change its targets, any other change nothing. */
export function acceptedPowerSwitch(plan: RemotePlanResult): PowerSwitch | undefined {
  if (plan.op !== 'power') return undefined;
  return { tag: plan.on ? 'on_then_render' : 'off', targets: plan.targets };
}
