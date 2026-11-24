/**
 * Zigbee groups: bulbs that get the same publish and together form a whole
 * group go as one publish to the group's topic.
 *
 * Which groups may stand in for their members is read here; sending a round
 * through them is the encoder's (`groupedPublishes` in `../encode.ts`).
 *
 * Moved from `planGroups` (the deleted `src/legacy/domain/grouping.ts`, today's
 * `effects_group_plan`) and the old group filter (`grouping.ts`): only
 * a verified group on a `/set` topic with two or more distinct members is
 * used; larger groups are tried first, then by topic; a topic two groups claim
 * with different members is not used; a bulb goes in at most one group; the
 * rest go one by one, in bulb order.
 */
import type { MqttTopic } from './ids.ts';
import type { BulbId } from '../../domain/types/ids.ts';
import type { Catalog } from './catalog.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import { toBulbId, toMqttTopic, ZIGBEE2MQTT_BASE } from './ids.ts';

export type BulbGroup = { readonly topic: MqttTopic; readonly members: readonly BulbId[] };
/** A verified group on a `/set` topic with two or more members, none twice; anything else is none. */
function usableGroup(entry: JsonValue): BulbGroup | undefined {
  if (!isMapping(entry) || entry['verified'] !== true) return undefined;
  const topic = entry['topic'], members = entry['members'];
  if (typeof topic !== 'string' || !topic.startsWith(`${ZIGBEE2MQTT_BASE}/`) || !topic.endsWith('/set')) return undefined;
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

/**
 * The groups the catalog's `multicast` list holds that may stand in for their members, largest first, then by
 * topic; any other entry is skipped, and so is a topic two groups claim with different members.
 */
export function bulbGroups(catalog: Catalog): BulbGroups {
  const usable = catalog.multicast.flatMap(entry => {
    const group = usableGroup(entry);
    return group === undefined ? [] : [group];
  });
  return usable.filter(group => !usable.some(other => other.topic === group.topic && !sameMembers(other, group)))
    .sort((a, b) => b.members.length - a.members.length || compare(a.topic, b.topic));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
