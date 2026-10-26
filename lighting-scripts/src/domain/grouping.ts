import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';

function object(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function mapping(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function list(value: JsonValue | undefined): JsonValue[] { return Array.isArray(value) ? value : []; }
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

/** Exact live effects_group_plan: only verified complete groups may replace unicast. */
export function planGroups(rows: JsonValue[], groups: JsonValue[]): JsonObject {
  const byEntity = new Map<string, EndpointRow>();
  const blocked = new Set<string>();
  const rejected: JsonValue[] = [];
  rows.forEach((row, index) => {
    if (!mapping(row) || typeof row.entity !== 'string' || typeof row.owner !== 'string' || !topic(row.topic)
      || !mapping(row.payload) || Object.keys(row.payload).length === 0) {
      rejected.push({ reason: 'invalid_endpoint_row', index });
      return;
    }
    const entity = row.entity;
    if (blocked.has(entity)) return;
    const previous = byEntity.get(entity);
    if (!previous) byEntity.set(entity, { entity, owner: row.owner, topic: row.topic, payload: row.payload });
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
    candidates.push({ id: Object.hasOwn(g, 'id') ? g.id! : g.topic, topic: g.topic, members });
  }
  candidates.sort((a, b) => b.members.length - a.members.length || compare(a.topic, b.topic));
  const used = new Set<string>();
  const commands: JsonValue[] = [];
  for (const group of candidates) {
    if (candidates.some(other => other.topic === group.topic && !equal([...other.members].sort(compare), [...group.members].sort(compare)))) continue;
    const members = group.members.map(e => byEntity.get(e));
    const first = members[0];
    if (!first || group.members.some(e => used.has(e)) || members.some(row => !row || !equal(row.payload, first.payload))) continue;
    const owners = [...new Set(members.flatMap(row => row ? [row.owner] : []))].sort(compare);
    commands.push({ topic: group.topic, payload: first.payload, members: [...group.members].sort(compare), owners, group: group.id });
    group.members.forEach(e => used.add(e));
  }
  for (const [entity, row] of [...byEntity.entries()].sort(([a], [b]) => compare(a, b))) {
    if (!used.has(entity)) commands.push({ topic: row.topic, payload: row.payload, members: [entity], owners: [row.owner], group: null });
  }
  return { commands, rejected, input_count: rows.length, endpoint_count: byEntity.size, command_count: commands.length };
}

function epoch(value: string | undefined): number {
  const parsed = value ? Date.parse(value) / 1000 : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
function numeric(value: JsonValue | undefined): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function byAddress(a: JsonValue, b: JsonValue): number { return compare(String(object(a).ieee_address ?? ''), String(object(b).ieee_address ?? '')); }

/** Membership uses current runtime assignments and device identifiers, never fixed lamp topology. */
export function planCandle(ctx: ScriptContext, catalog: JsonObject): JsonObject {
  const assignments = object(ctx.attr('sensor.ls_effects_runtime', 'assignments'));
  const power = object(ctx.attr('sensor.ls_overrides', 'power'));
  const actual = object(ctx.attr('sensor.ls_effects_runtime', 'candle_group'));
  const endpoints = new Map<string, JsonObject>();
  const owners: JsonObject = {};
  const catalogMembers = object(catalog.members);
  for (const [lamp, ends] of Object.entries(catalogMembers)) {
    for (const endpoint of strings(ends)) {
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
  const lamps: JsonObject = {};
  const entities: string[] = [];
  const wanted: JsonValue[] = [];
  for (const [lamp, assignment] of Object.entries(assignments)) {
    const t = object(assignment);
    if (!Object.hasOwn(catalogMembers, lamp) || ctx.get(lamp) !== 'on' || !t.on || power[String(t.area)] === false) continue;
    const brightness = object(t.brightness), color = object(t.color);
    if (brightness.kind !== 'effect' || brightness.effect !== 'Candle' || color.kind !== 'effect' || color.effect !== 'Candle') continue;
    lamps[lamp] = t;
    for (const endpoint of strings(catalogMembers[lamp])) {
      const member = endpoints.get(endpoint);
      if (ctx.get(endpoint) === 'on' && member) { entities.push(endpoint); wanted.push(member); }
    }
  }
  wanted.sort(byAddress);
  const members = [...list(actual.members)].sort(byAddress);
  const remove = members.filter(member => !wanted.some(w => equal(w, member)));
  const add = wanted.filter(member => !members.some(m => equal(m, member)));
  const restarted = Math.max(epoch(ctx.state['binary_sensor.zigbee2mqtt_bridge_connection_state']?.last_changed), epoch(ctx.state['automation.effects_candle_group_state']?.last_changed));
  const observed = numeric(actual.observed_at);
  const fresh = observed >= restarted && observed > 0;
  const synchronized = Boolean(actual.exists) && fresh && equal(members, wanted);
  return {
    lamps, entities: [...new Set(entities)].sort(compare), members: wanted, actual, remove, add, owners, fresh, synchronized,
    ready: synchronized && wanted.length > 0 && !ctx.attr('sensor.ls_effects_runtime', 'candle_syncing') && ctx.get('binary_sensor.zigbee2mqtt_bridge_connection_state') === 'on',
  };
}

export const groupingHandlers: ScriptHandlers = {
  effects_group_plan: (_ctx, args) => planGroups(list(args.rows), list(args.groups)),
  effects_candle_plan: (ctx, args) => planCandle(ctx, object(args.catalog)),
};
