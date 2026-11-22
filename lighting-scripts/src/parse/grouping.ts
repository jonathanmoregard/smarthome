/**
 * Parsing for `effects_group_plan`.
 *
 * Endpoint rows and multicast groups arrive as script arguments -- the
 * name-keyed edge, and `framePlan`'s call, whose argument bytes are compared --
 * so they are genuinely unparsed documents. `domain/grouping.ts` plans over
 * the typed rows and groups this produces and names no JSON.
 *
 * Neither element parse can raise: an invalid row is reported by the planner
 * by index, and an unusable group is skipped. So parsing both lists here,
 * before planning, moves no raise. Only the two containers can raise, in the
 * order the handler always read them.
 */
import type { JsonObject, JsonValue } from '../runtime/context.ts';
import { carry } from '../runtime/verbatim.ts';
import { list } from './accessors.ts';
import type { EndpointRow, GroupPlanRequest, MulticastGroup } from '../domain/grouping.ts';
import { toBulbId } from './ids.ts';

/** Captured rows/groups are iterated: absence is empty, a malformed present container raises. */
export function parseGroupPlanArgs(args: JsonObject): GroupPlanRequest {
  const rows = list(args.rows), groups = list(args.groups);
  return {
    rows: rows.map(endpointRow),
    groups: groups.flatMap(g => { const group = multicastGroup(g); return group === undefined ? [] : [group]; }),
  };
}
/** `undefined` is an invalid row, which the planner rejects by index. */
function endpointRow(row: JsonValue): EndpointRow | undefined {
  if (!mapping(row) || typeof row.entity !== 'string' || typeof row.owner !== 'string' || !topic(row.topic)
    || !mapping(row.payload) || Object.keys(row.payload).length === 0) return undefined;
  return { entity: toBulbId(row.entity), owner: row.owner, topic: row.topic, payload: carry(row.payload) };
}
function mapping(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function topic(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.startsWith('zigbee2mqtt/') && value.endsWith('/set');
}

/** `undefined` is a group the planner may not use. */
function multicastGroup(g: JsonValue): MulticastGroup | undefined {
  if (!mapping(g) || g.verified !== true || !topic(g.topic) || !Array.isArray(g.members) || g.members.length <= 1) return undefined;
  const members = strings(g.members).map(toBulbId);
  if (members.length !== g.members.length || new Set(members).size !== members.length) return undefined;
  // The group's own `id` when it names one, else its topic -- raw either way,
  // since it reaches the command unchanged.
  return { id: carry((Object.hasOwn(g, 'id') ? g.id : g.topic) as JsonValue), topic: g.topic, members };
}

function strings(value: JsonValue | undefined): string[] { return list(value).filter((v): v is string => typeof v === 'string'); }
