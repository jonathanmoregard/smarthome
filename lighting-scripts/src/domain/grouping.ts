import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { jinjaTruthy, optionalBoolean, requireBoolean, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { typed } from '../runtime/entrypoints.ts';
import { list, num, timestamp } from './schedule.ts';

function mapping(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: JsonValue | undefined): string[] { return list(value).filter((v): v is string => typeof v === 'string'); }
function topic(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && value.startsWith('zigbee2mqtt/') && value.endsWith('/set');
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** JSON structural equality, including mapping-order independence as in Jinja/Python. */
function equal(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (mapping(a) && mapping(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}
interface EndpointRow { entity: string; owner: string; topic: string; payload: JsonObject }
interface Candidate { id: JsonValue; topic: string; members: string[] }

function objectOrEmpty(value: JsonValue | undefined, context: string): JsonObject {
  if (value === undefined) return {};
  return jinjaTruthy(value) ? requireObject({ value }, 'value', context) : {};
}
function objectDefaultAbsent(container: JsonObject, key: string, context: string): JsonObject {
  return container[key] === undefined ? {} : requireObject(container, key, context);
}
function stringList(value: JsonValue | undefined, context: string): string[] {
  return list(value).map((item, index) => requireString({ item }, 'item', `${context}[${index}]`));
}

/**
 * One MQTT publish the planner decided on.
 *
 * `payload` and `group` stay JSON deliberately. The payload is the lamp's own
 * MQTT body, assembled by `framePlan` and carried through here untouched;
 * `group` is the multicast group's `id` when it names one and its `topic`
 * otherwise, both read raw from the catalog. These are compared bytes, so
 * narrowing either would be a projection -- THE INVARIANT. Everything else is
 * decided here, from locals.
 */
export type GroupCommand = {
  topic: string;
  payload: JsonObject;
  members: string[];
  owners: string[];
  group: JsonValue;
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
export function planGroups(rows: JsonValue[], groups: JsonValue[]): GroupPlanResult {
  const byEntity = new Map<string, EndpointRow>();
  const blocked = new Set<string>();
  const rejected: RejectedRow[] = [];
  rows.forEach((row, index) => {
    if (!mapping(row) || typeof row.entity !== 'string' || typeof row.owner !== 'string' || !topic(row.topic)
      || !mapping(row.payload) || Object.keys(row.payload).length === 0) {
      rejected.push({ reason: 'invalid_endpoint_row', index });
      return;
    }
    const entity = row.entity;
    if (blocked.has(entity)) return;
    const previous = byEntity.get(entity);
    if (previous === undefined) byEntity.set(entity, { entity, owner: row.owner, topic: row.topic, payload: row.payload });
    else if (previous.owner !== row.owner || previous.topic !== row.topic || !equal(previous.payload, row.payload)) {
      blocked.add(entity);
      byEntity.delete(entity);
      rejected.push({ entity, reason: 'conflicting_endpoint_rows' });
    }
  });
  const candidates: Candidate[] = [];
  for (const g of groups) {
    if (!mapping(g) || g.verified !== true || !topic(g.topic) || !Array.isArray(g.members) || g.members.length <= 1) continue;
    const members = strings(g.members);
    if (members.length !== g.members.length || new Set(members).size !== members.length) continue;
    candidates.push({ id: Object.hasOwn(g, 'id') ? g.id as JsonValue : g.topic, topic: g.topic, members });
  }
  candidates.sort((a, b) => b.members.length - a.members.length || compare(a.topic, b.topic));
  const used = new Set<string>();
  const commands: GroupCommand[] = [];
  for (const group of candidates) {
    if (candidates.some(other => other.topic === group.topic && !equal([...other.members].sort(compare), [...group.members].sort(compare)))) continue;
    const members = group.members.map(e => byEntity.get(e));
    const first = members[0];
    if (first === undefined || group.members.some(e => used.has(e)) || members.some(row => row === undefined || !equal(row.payload, first.payload))) continue;
    const owners = [...new Set(members.flatMap(row => row === undefined ? [] : [row.owner]))].sort(compare);
    commands.push({ topic: group.topic, payload: first.payload, members: [...group.members].sort(compare), owners, group: group.id });
    group.members.forEach(e => used.add(e));
  }
  for (const [entity, row] of [...byEntity.entries()].sort(([a], [b]) => compare(a, b))) {
    if (!used.has(entity)) commands.push({ topic: row.topic, payload: row.payload, members: [entity], owners: [row.owner], group: null });
  }
  return { commands, rejected, input_count: rows.length, endpoint_count: byEntity.size, command_count: commands.length };
}

function epoch(value: string | undefined): number { return value === undefined ? 0 : timestamp(value); }
/** For members this function built: the address is already a string. */
function byIeee(a: CandleMember, b: CandleMember): number { return compare(a.ieee_address, b.ieee_address); }
/** For members read out of the runtime attribute, which are still documents. */
function byAddress(a: JsonValue, b: JsonValue): number {
  const left = requireObject({ a }, 'a', 'effects_candle_plan.member');
  const right = requireObject({ b }, 'b', 'effects_candle_plan.member');
  return compare(
    requireString(left, 'ieee_address', 'effects_candle_plan.member'),
    requireString(right, 'ieee_address', 'effects_candle_plan.member'),
  );
}

/**
 * One endpoint this plan wants in the Candle group. Both fields are built from
 * the device identifier, so the key order the gate compares is this order.
 */
export type CandleMember = { ieee_address: string; endpoint: number };
/**
 * `effects_candle_plan`'s result.
 *
 * Three fields stay JSON, each for its own reason:
 *
 * - `lamps` holds the assignment documents themselves, which are persisted
 *   into `candle_pending` and compared.
 * - `actual` is the runtime sensor's `candle_group` attribute, read raw and
 *   handed back raw.
 * - `remove` is filtered out of `actual.members`, whose entries this function
 *   only *checks* (`requireObject` plus a required `ieee_address`) and never
 *   rebuilds. Narrowing it to `CandleMember` would drop any other field the
 *   real document carries, and the selected member is persisted -- THE
 *   INVARIANT.
 *
 * `members` and `add` are `CandleMember[]` because every field of those is
 * built here, in `endpoints`.
 */
export type CandlePlanResult = {
  lamps: Record<string, JsonObject>;
  entities: string[];
  members: CandleMember[];
  actual: JsonObject;
  remove: JsonObject[];
  add: CandleMember[];
  owners: Record<string, string>;
  fresh: boolean;
  synchronized: boolean;
  ready: boolean;
};

/** Membership uses current runtime assignments and device identifiers, never fixed lamp topology. */
export function planCandle(ctx: ScriptContext, catalogMembers: JsonObject): CandlePlanResult {
  const assignments = objectOrEmpty(ctx.attr('sensor.ls_effects_runtime', 'assignments'), 'effects_candle_plan.assignments');
  const power = objectOrEmpty(ctx.attr('sensor.ls_overrides', 'power'), 'effects_candle_plan.power');
  const actual = objectOrEmpty(ctx.attr('sensor.ls_effects_runtime', 'candle_group'), 'effects_candle_plan.actual');
  const endpoints = new Map<string, CandleMember>();
  const owners: Record<string, string> = {};
  for (const [lamp, ends] of Object.entries(catalogMembers)) {
    for (const endpoint of stringList(ends, `effects_candle_plan.catalog.members.${lamp}`)) {
      for (const pair of ctx.identifiers?.[endpoint] ?? []) {
        if (!Array.isArray(pair)) continue;
        const [domain, identifier] = pair;
        if (domain !== 'mqtt' || typeof identifier !== 'string' || !identifier.startsWith('zigbee2mqtt_0x')) continue;
        const ieee = identifier.slice(12);
        endpoints.set(endpoint, { ieee_address: ieee, endpoint: 1 });
        owners[ieee] = lamp;
      }
    }
  }
  const lamps: Record<string, JsonObject> = {};
  const entities: string[] = [];
  const wanted: CandleMember[] = [];
  for (const [lamp, assignment] of Object.entries(assignments)) {
    if (!Object.hasOwn(catalogMembers, lamp) || ctx.get(lamp) !== 'on') continue;
    const t = requireObject({ assignment }, 'assignment', `effects_candle_plan.assignments.${lamp}`);
    const on = t.on === undefined ? false : requireBoolean(t.on, `effects_candle_plan.assignments.${lamp}.on`);
    if (!on) continue;
    const area = requireString(t, 'area', `effects_candle_plan.assignments.${lamp}`);
    const powered = power[area] === undefined ? true : requireBoolean(power[area], `effects_candle_plan.power.${area}`);
    if (!powered) continue;
    const brightness = objectDefaultAbsent(t, 'brightness', `effects_candle_plan.assignments.${lamp}`);
    const color = objectDefaultAbsent(t, 'color', `effects_candle_plan.assignments.${lamp}`);
    if (brightness.kind !== 'effect' || brightness.effect !== 'Candle' || color.kind !== 'effect' || color.effect !== 'Candle') continue;
    lamps[lamp] = t;
    for (const endpoint of stringList(catalogMembers[lamp], `effects_candle_plan.catalog.members.${lamp}`)) {
      const member = endpoints.get(endpoint);
      if (ctx.get(endpoint) === 'on' && member !== undefined) { entities.push(endpoint); wanted.push(member); }
    }
  }
  wanted.sort(byIeee);
  const members = list(actual.members).map((member, index) => {
    const parsed = requireObject({ member }, 'member', `effects_candle_plan.actual.members[${index}]`);
    requireString(parsed, 'ieee_address', `effects_candle_plan.actual.members[${index}]`);
    return parsed;
  }).sort(byAddress);
  const remove = members.filter(member => !wanted.some(w => equal(w, member)));
  const add = wanted.filter(member => !members.some(m => equal(m, member)));
  const restarted = Math.max(epoch(ctx.state['binary_sensor.zigbee2mqtt_bridge_connection_state']?.last_changed), epoch(ctx.state['automation.effects_candle_group_state']?.last_changed));
  const observed = num(actual.observed_at, 0);
  const fresh = observed >= restarted && observed > 0;
  // Captured `actual.get('exists', false)` makes an absent first observation
  // genuinely optional; a present value is still required to be a boolean.
  const exists = actual.exists === undefined
    ? false
    : requireBoolean(actual.exists, 'effects_candle_plan.actual.exists');
  const synchronized = exists && fresh && equal(members, wanted);
  const syncing = optionalBoolean(ctx.attr('sensor.ls_effects_runtime', 'candle_syncing'), 'effects_candle_plan.candle_syncing') ?? false;
  return {
    lamps, entities: [...new Set(entities)].sort(compare), members: wanted, actual, remove, add, owners, fresh, synchronized,
    ready: synchronized && wanted.length > 0 && !syncing && ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') === 'on',
  };
}

export const groupingHandlers: ScriptHandlers = {
  // Captured rows/groups are iterated, so absence is empty while a malformed
  // present container raises. catalog.members is accessed through .items().
  effects_group_plan: typed('effects_group_plan', {
    parse: args => ({ rows: list(args.rows), groups: list(args.groups) }),
    run: (_ctx, args) => planGroups(args.rows, args.groups),
  }),
  effects_candle_plan: typed('effects_candle_plan', {
    parse: args => {
      const catalog = requireObject(args, 'catalog', 'effects_candle_plan');
      return { catalogMembers: requireObject(catalog, 'members', 'effects_candle_plan.catalog') };
    },
    run: (ctx, args) => planCandle(ctx, args.catalogMembers),
  }),
};
