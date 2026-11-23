/**
 * The one bridge from the legacy entry points (`ls_apply`, `ls_render`,
 * `ls_dispatch`) into the new path, deleted in M3 Task 3: read the Model from
 * Home Assistant, compute the lighting state, reconcile the bulbs and switches
 * to it, and send what differs.
 *
 * What each bulb was sent is kept in this process, so a bulb already showing
 * its light is not sent it again. It does not survive a restart: after one,
 * every reachable bulb is sent its light once (M5 keeps it in a journal).
 */
import { bulbGroups } from './bulb-groups.ts';
import { bulbTopics } from './codecs/config.ts';
import { decodeModel } from './codecs/model.ts';
import { publishes } from './encode.ts';
import { decodeObserved } from './observed.ts';
import { afterSend, forgotten, NO_BELIEFS, nextSends } from './reconcile.ts';
import type { Beliefs } from './reconcile.ts';
import { lightingState } from '../domain/lighting-state.ts';
import { entriesOf } from '../domain/types/ids.ts';
import { timestamp } from '../parse/accessors.ts';
import { toInstant } from '../parse/ids.ts';
import type { ScriptContext } from '../runtime/context.ts';
import { perform } from '../runtime/effects.ts';

/** What this process last sent each bulb and switch. */
let beliefs: Beliefs = NO_BELIEFS;

/**
 * Start as a fresh process does, believing nothing sent. For a process that
 * opens more than one port in turn (the unit tests, each opening its own host).
 */
export function forgetBeliefs(): void {
  beliefs = NO_BELIEFS;
}

/**
 * decodeModel → lightingState → nextSends → publishes → the house, then the beliefs. Every send is taken as sent.
 * `named`: the lights asked for by name (a lamp or a bulb), whose bulbs are sent their light again whatever they were last sent.
 */
export function showLightingState(ctx: ScriptContext, named: readonly string[] = []): void {
  const now = toInstant(timestamp(ctx.now));
  const source = { states: ctx.state, rooms: ctx.rooms, labels: ctx.labels === undefined ? {} : ctx.labels, timezone: ctx.timezone };
  const model = decodeModel(source, ctx.catalog);
  const asked = new Set(named);
  beliefs = forgotten(beliefs, entriesOf(model.config.lamps).flatMap(([lamp, { bulbs }]) =>
    bulbs.flatMap(({ bulb }) => asked.has(lamp) || asked.has(bulb) ? [bulb] : [])));
  const { sends } = nextSends(lightingState(model, now), model.config, decodeObserved(ctx.state, model.config), beliefs, now);
  for (const { topic, payload } of publishes(sends, bulbTopics(ctx.catalog), bulbGroups(ctx.catalog))) {
    perform(ctx, { kind: 'service', service: 'mqtt.publish', data: { topic, payload: JSON.stringify(payload), qos: 0, retain: false } });
  }
  for (const send of sends) {
    if (send.kind === 'switch') {
      perform(ctx, { kind: 'service', service: `homeassistant.turn_${send.power}`, data: {}, target: { entity_id: send.switch } });
    }
    beliefs = afterSend(beliefs, send, 'sent', now);
  }
}
