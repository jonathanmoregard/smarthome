/**
 * Zigbee groups: bulbs that get the same publish and together form a whole
 * group go as one publish to the group's topic.
 *
 * Moved from `planGroups` (the deleted `src/legacy/domain/grouping.ts`, today's
 * `effects_group_plan`) and the old group filter (`grouping.ts`): only
 * a verified group on a `/set` topic with two or more distinct members is
 * used; larger groups are tried first, then by topic; a topic two groups claim
 * with different members is not used; a bulb goes in at most one group; the
 * rest go one by one, in bulb order.
 */
import type { BulbPayload, Publish } from '../encode.ts';
import type { MqttTopic } from './ids.ts';
import type { BulbId } from '../../domain/types/ids.ts';
import type { Catalog } from './catalog.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import { toBulbId, toMqttTopic } from './ids.ts';

export type BulbGroup = { readonly topic: MqttTopic; readonly members: readonly BulbId[] };
/** A verified group on a `/set` topic with two or more members, none twice; anything else is none. */
function usableGroup(entry: JsonValue): BulbGroup | undefined {
  if (!isMapping(entry) || entry['verified'] !== true) return undefined;
  const topic = entry['topic'], members = entry['members'];
  if (typeof topic !== 'string' || !topic.startsWith('zigbee2mqtt/') || !topic.endsWith('/set')) return undefined;
  if (!Array.isArray(members) || members.length <= 1) return undefined;
  const names = members.filter((member): member is string => typeof member === 'string');
  if (names.length !== members.length || new Set(names).size !== names.length) return undefined;
  return { topic: toMqttTopic(topic), members: names.map(toBulbId) };
}

function sameMembers(a: BulbGroup, b: BulbGroup): boolean {
  const left = [...a.members].sort(compare), right = [...b.members].sort(compare);
  return left.length === right.length && left.every((bulb, index) => bulb === right[index]);
}

function isMapping(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type BulbGroups = readonly BulbGroup[];

/** The groups the catalog's `multicast` list holds that may stand in for their members; any other entry is skipped. */
export function bulbGroups(catalog: Catalog): BulbGroups {
  return catalog.multicast.flatMap(entry => {
    const group = usableGroup(entry);
    return group === undefined ? [] : [group];
  });
}

/** One bulb's wanted publish. */
export type BulbPublish = { bulb: BulbId; topic: MqttTopic; payload: BulbPayload };

/** The publishes for one round of bulbs: each whole group whose members all get the same payload as one, the rest one by one. */
export function groupedPublishes(rows: readonly BulbPublish[], groups: BulbGroups): Publish[] {
  const byBulb = new Map(rows.map(row => [row.bulb, row]));
  const candidates = [...groups].sort((a, b) => b.members.length - a.members.length || compare(a.topic, b.topic));
  const used = new Set<BulbId>();
  const sent: Publish[] = [];
  for (const group of candidates) {
    if (candidates.some(other => other.topic === group.topic && !sameMembers(other, group))) continue;
    const members = group.members.map(bulb => byBulb.get(bulb));
    const first = members[0];
    if (first === undefined || group.members.some(bulb => used.has(bulb))
      || members.some(row => row === undefined || payloadText(row.payload) !== payloadText(first.payload))) continue;
    sent.push({ topic: group.topic, payload: first.payload });
    for (const bulb of group.members) used.add(bulb);
  }
  for (const row of [...byBulb.values()].sort((a, b) => compare(a.bulb, b.bulb))) {
    if (!used.has(row.bulb)) sent.push({ topic: row.topic, payload: row.payload });
  }
  return sent;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Two payloads are the same publish when they go out as the same text. */
function payloadText(payload: BulbPayload): string {
  return JSON.stringify(payload);
}
