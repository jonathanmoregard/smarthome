import { sameDocument } from '../runtime/verbatim.ts';
import type { Verbatim } from '../runtime/verbatim.ts';

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Element-wise `===`, which is what JSON equality reduces to on two string lists. */
function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * One endpoint's wanted publish. `payload` is the lamp's MQTT body, assembled
 * by `framePlan` and compared byte for byte downstream, so the planner holds it
 * opaquely: it only ever asks whether two payloads are the same document.
 */
export type EndpointRow = { entity: string; owner: string; topic: string; payload: Verbatim };
/**
 * A multicast group the planner may use: verified, on a `/set` topic, with
 * more than one member and no duplicate or non-string member. `id` is the
 * group's own id when it names one and its topic otherwise, raw either way.
 */
export type MulticastGroup = { id: Verbatim; topic: string; members: string[] };
/** `undefined` in `rows` is a row that failed to parse; it is rejected by index. */
export type GroupPlanArgs = { rows: Array<EndpointRow | undefined>; groups: MulticastGroup[] };

/**
 * One MQTT publish the planner decided on.
 *
 * `payload` and `group` are carried {@link Verbatim}. The payload is the lamp's
 * own MQTT body, assembled by `framePlan` and passed through here untouched;
 * `group` is the multicast group's `id` when it names one and its `topic`
 * otherwise, both read raw from the catalog. These are compared bytes, so
 * narrowing either would be a projection -- THE INVARIANT -- and the opaque
 * handle is what lets the domain hold them without being able to read them.
 * `null` is the unicast marker, decided here. Everything else is decided here,
 * from locals.
 */
export type GroupCommand = {
  topic: string;
  payload: Verbatim;
  members: string[];
  owners: string[];
  group: Verbatim | null;
};
/** Why one endpoint row was dropped. Both shapes are built here. */
export type RejectedRow =
  | { reason: 'invalid_endpoint_row'; index: number }
  | { entity: string; reason: 'conflicting_endpoint_rows' };
/**
 * `effects_group_plan`'s result -- and `effects_frame_plan`'s, which returns
 * this unchanged (`transport.ts`), so one type keeps the two from drifting.
 */
export type GroupPlanResult = {
  commands: GroupCommand[];
  rejected: RejectedRow[];
  input_count: number;
  endpoint_count: number;
  command_count: number;
};

/** Exact live effects_group_plan: only verified complete groups may replace unicast. */
export function planGroups(rows: Array<EndpointRow | undefined>, groups: MulticastGroup[]): GroupPlanResult {
  const byEntity = new Map<string, EndpointRow>();
  const blocked = new Set<string>();
  const rejected: RejectedRow[] = [];
  rows.forEach((row, index) => {
    if (row === undefined) {
      rejected.push({ reason: 'invalid_endpoint_row', index });
      return;
    }
    const entity = row.entity;
    if (blocked.has(entity)) return;
    const previous = byEntity.get(entity);
    if (previous === undefined) byEntity.set(entity, { entity, owner: row.owner, topic: row.topic, payload: row.payload });
    else if (previous.owner !== row.owner || previous.topic !== row.topic || !sameDocument(previous.payload, row.payload)) {
      blocked.add(entity);
      byEntity.delete(entity);
      rejected.push({ entity, reason: 'conflicting_endpoint_rows' });
    }
  });
  const candidates = [...groups];
  candidates.sort((a, b) => {
    const larger = b.members.length - a.members.length;
    return larger !== 0 ? larger : compare(a.topic, b.topic);
  });
  const used = new Set<string>();
  const commands: GroupCommand[] = [];
  for (const group of candidates) {
    if (candidates.some(other => other.topic === group.topic && !sameStrings([...other.members].sort(compare), [...group.members].sort(compare)))) continue;
    const members = group.members.map(e => byEntity.get(e));
    const first = members[0];
    if (first === undefined || group.members.some(e => used.has(e)) || members.some(row => row === undefined || !sameDocument(row.payload, first.payload))) continue;
    const owners = [...new Set(members.flatMap(row => row === undefined ? [] : [row.owner]))].sort(compare);
    commands.push({ topic: group.topic, payload: first.payload, members: [...group.members].sort(compare), owners, group: group.id });
    group.members.forEach(e => used.add(e));
  }
  for (const [entity, row] of [...byEntity.entries()].sort(([a], [b]) => compare(a, b))) {
    if (!used.has(entity)) commands.push({ topic: row.topic, payload: row.payload, members: [entity], owners: [row.owner], group: null });
  }
  return { commands, rejected, input_count: rows.length, endpoint_count: byEntity.size, command_count: commands.length };
}
