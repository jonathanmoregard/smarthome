import { isDeepStrictEqual } from 'node:util';
import type { JsonObject, JsonValue, ScriptContext, ScriptHandlers } from '../runtime/context.ts';
import { requireBoolean, requireObject, requireString, withParsedArgs } from '../runtime/parse.ts';
import { object } from './scale.ts';
import { list, nativeScalar, num, optionalTimestamp, timestamp } from './schedule.ts';

const runtime = 'sensor.ls_effects_runtime';
const bridge = 'binary_sensor.zigbee2mqtt_bridge_connection_state';
const notice = 'lighting_candle_membership';
function update(ctx: ScriptContext, attributes: JsonObject): void {
  ctx.emit('variable.update_sensor', { value: nativeScalar(ctx.get(runtime)), replace_attributes: false, attributes }, { entity_id: runtime });
}
function timeout(ctx: ScriptContext, token: string, stage: string, started = Date.parse(ctx.now)): void {
  const deadline = started + 10000;
  ctx.schedule('effects_candle_sync_timeout', { token, stage, host_timer_deadline: deadline }, Math.max(0, deadline - Date.parse(ctx.now)));
}
function pending(ctx: ScriptContext): JsonObject { return object(ctx.attr(runtime, 'candle_pending')); }
function first(values: JsonValue[]): JsonValue {
  if (values.length === 0) throw new Error('Cannot take the first item of an empty Candle member list');
  return values[0] as JsonValue;
}
function interrupted(ctx: ScriptContext): void {
  update(ctx, { candle_pending: null, candle_syncing: true, candle_retry_at: timestamp(ctx.now) + 30, candle_error: 'Membership reconciliation interrupted' });
}
function requestDescription(value: JsonValue): string {
  if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(requestDescription).join(', ')}]`;
  return `{${Object.entries(value).map(([k, v]) => `${requestDescription(k)}: ${requestDescription(v)}`).join(', ')}}`;
}
function failed(ctx: ScriptContext, state: JsonObject): void {
  const request = requireObject(state, 'request', 'effects_candle_sync.pending');
  update(ctx, { candle_pending: null, candle_syncing: true, candle_retry_at: timestamp(ctx.now) + 30, candle_error: request });
  ctx.emit('persistent_notification.create', { notification_id: notice, title: 'Candle Group Update Delayed',
    message: `Candle is paused while Zigbee membership is confirmed: ${requestDescription(request)}` });
}
function iterate(ctx: ScriptContext, catalog: JsonObject, iteration: number): void {
  if (iteration >= 100 || ctx.get(bridge) !== 'on') { interrupted(ctx); return; }
  const membership = object(ctx.run('effects_candle_plan', { catalog })), actual = object(membership.actual);
  if (membership.synchronized || (!list(membership.members).length && !list(actual.members).length)) {
    if (ctx.attr(runtime, 'candle_error') !== null && ctx.attr(runtime, 'candle_error') !== undefined) ctx.emit('persistent_notification.dismiss', { notification_id: notice });
    update(ctx, { candle_pending: null, candle_syncing: false, candle_retry_at: 0, candle_error: null });
    return;
  }
  const remove = list(membership.remove), add = list(membership.add), wanted = list(membership.members);
  const exists = actual.exists === undefined
    ? false
    : requireBoolean(actual.exists, 'effects_candle_sync.plan.actual.exists');
  const operation = !exists ? 'create' : remove.length ? 'remove' : 'add';
  const selected = remove.length > 0 ? first(remove) : add.length > 0 ? first(add) : wanted.length > 0 ? first(wanted) : {};
  const member = requireObject({ selected }, 'selected', 'effects_candle_sync.plan.member');
  const token = `candle:${ctx.now}`;
  const config = ctx.catalog?.candle_group === undefined
    ? {}
    : requireObject(ctx.catalog, 'candle_group', 'effects_candle_sync.catalog');
  const group = config.friendly_name === undefined
    ? 'fx_candle_active'
    : requireString(config, 'friendly_name', 'effects_candle_sync.catalog.candle_group');
  const request: JsonObject = operation === 'create'
    ? { friendly_name: group, id: config.id === undefined ? 1100 : num(config.id), transaction: token }
    : {
      group,
      device: requireString(member, 'ieee_address', 'effects_candle_sync.plan.member'),
      endpoint: num(member.endpoint),
      skip_disable_reporting: true,
      transaction: token,
    };
  const state: JsonObject = { stage: 'publishing', token, operation, member, request, started: timestamp(ctx.now), iteration, catalog, owners: object(membership.owners) };
  // Persist the in-flight intent before output. A restart must not replay an
  // ambiguous group mutation. The host releases this continuation after ACK.
  update(ctx, { candle_pending: state });
  ctx.emit('mqtt.publish', { topic: operation === 'create' ? 'zigbee2mqtt/bridge/request/group/add' : `zigbee2mqtt/bridge/request/group/members/${operation}`, payload: JSON.stringify(request), qos: 0, retain: false });
  ctx.schedule('effects_candle_sync_published', { token }, 0);
}
function resume(ctx: ScriptContext): null {
  let state = pending(ctx);
  if (!Object.keys(state).length || state.stage === 'publishing') return null;
  if (state.stage === 'response') {
    const response = object(ctx.attr(runtime, 'candle_response'));
    if (response.transaction !== state.token) return null;
    if (response.status !== 'ok') { failed(ctx, state); return null; }
    state = { ...state, stage: 'membership' };
    update(ctx, { candle_pending: state });
    timeout(ctx, requireString(state, 'token', 'effects_candle_sync.pending'), 'membership');
  }
  if (state.stage !== 'membership') return null;
  const actual = object(ctx.attr(runtime, 'candle_group'));
  if (num(actual.observed_at, 0) < num(state.started)) return null;
  const contains = list(actual.members).some(member => isDeepStrictEqual(member, state.member));
  const confirmed = state.operation === 'create'
    ? requireBoolean(actual.exists, 'effects_candle_sync.candle_group.exists')
    : state.operation === 'remove' ? !contains : contains;
  if (!confirmed) return null;
  const owners = object(state.owners), member = object(state.member);
  if (state.operation === 'remove' && typeof member.ieee_address === 'string' && Object.hasOwn(owners, member.ieee_address)) {
    ctx.run('ls_apply', { reason: 'manual', lights: [owners[member.ieee_address]!] });
  }
  iterate(ctx, object(state.catalog), num(state.iteration) + 1);
  return null;
}

export const candleSyncHandlers: ScriptHandlers = {
  effects_candle_sync: withParsedArgs({
    parse: () => ({}),
    run: ctx => {
    // Native mode: single. State/response triggers own continuation while a
    // request is pending; periodic membership triggers cannot double-publish.
    if (Object.keys(pending(ctx)).length || timestamp(ctx.now) < num(ctx.attr(runtime, 'candle_retry_at'), 0) || ctx.get(bridge) !== 'on') return null;
    const source = object(ctx.run('effects_catalog'));
    const catalog: JsonObject = { members: object(source.members) };
    update(ctx, { candle_syncing: true });
    iterate(ctx, catalog, 1);
    return null;
    },
  }),
  effects_candle_sync_published: withParsedArgs({
    parse: args => {
      const completedAt = optionalTimestamp(args.host_completed_at);
      return {
        token: requireString(args, 'token', 'effects_candle_sync_published'),
        outputSuccess: requireBoolean(args.host_output_success, 'effects_candle_sync_published.host_output_success'),
        completedAtMs: completedAt === undefined ? undefined : completedAt * 1000,
      };
    },
    run: (ctx, args) => {
    const state = pending(ctx);
    if (state.token !== args.token || state.stage !== 'publishing') return null;
    if (!args.outputSuccess) { failed(ctx, state); return null; }
    update(ctx, { candle_pending: { ...state, stage: 'response' } });
    timeout(ctx, args.token, 'response', args.completedAtMs === undefined ? Date.parse(ctx.now) : args.completedAtMs);
    return resume(ctx);
    },
  }),
  effects_candle_sync_resume: withParsedArgs({ parse: () => ({}), run: ctx => resume(ctx) }),
  effects_candle_sync_timeout: withParsedArgs({
    parse: args => ({
      token: requireString(args, 'token', 'effects_candle_sync_timeout'),
      stage: requireString(args, 'stage', 'effects_candle_sync_timeout'),
    }),
    run: (ctx, args) => {
    const state = pending(ctx);
    if (state.token !== args.token || state.stage !== args.stage) return null;
    // An already-observed acknowledgement wins over a simultaneously due timer.
    resume(ctx);
    const remaining = pending(ctx);
    if (remaining.token === args.token && remaining.stage === args.stage) failed(ctx, remaining);
    return null;
    },
  }),
};
