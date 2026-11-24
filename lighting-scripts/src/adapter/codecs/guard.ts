/**
 * A guarded call as Home Assistant runs it, and its answer read. Home Assistant answers `execute_script` with success
 * whether the script made the write or stopped first (2026.7.4: a stopped script returns normally, helpers/script.py
 * 474-487, and components/websocket_api/commands.py 1216-1222 sends it as a result), so the script says which in its
 * response: it ends in a `stop` with `response_variable`, the written answer or the refused one.
 */
import type { Guard, JsonObject, JsonValue, ServiceCall } from '../ha-client.ts';
import { isObject } from './parse.ts';

/** What a guarded call's script answered: the write was made, or refused over the `last_updated` Home Assistant saw. */
export type GuardAnswer = { kind: 'written' } | { kind: 'refused'; seen: string };

/** The guard script's response read: its answer, or `undefined` for one that says neither, which tells nothing was written. */
export function guardAnswerOf(response: JsonValue | undefined): GuardAnswer | undefined {
  if (!isObject(response)) return undefined;
  if (response.guard === 'written') return { kind: 'written' };
  return response.guard === 'refused' && typeof response.seen === 'string' ? { kind: 'refused', seen: response.seen } : undefined;
}

/**
 * The script a guarded call runs: when the guard's entity was updated since it was read, it answers refused, with the
 * stamp it saw; otherwise it makes the call and answers written.
 */
export function guardedScript(call: ServiceCall, guard: Guard): JsonObject[] {
  const stamp = `states.${guard.entity}.last_updated.isoformat()`;
  return [
    { if: [{ condition: 'template', value_template: `{{ ${stamp} != ${JSON.stringify(guard.lastUpdated)} }}` }],
      then: [
        { variables: { answer: { guard: 'refused', seen: `{{ ${stamp} }}` } } },
        { stop: `${guard.entity} changed since it was read`, response_variable: 'answer' }] },
    { action: call.service, ...call.target === undefined ? {} : { target: call.target }, data: call.data },
    { variables: { answer: { guard: 'written' } } },
    { stop: 'written', response_variable: 'answer' },
  ];
}
