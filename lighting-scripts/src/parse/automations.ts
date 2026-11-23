/**
 * Parsing for the native light controls' MQTT topics, which the live-rooms
 * scope reads to tell which room a control's message belongs to.
 */
import type { JsonValue } from '../runtime/context.ts';
import { object } from '../adapter/codecs/parse.ts';
import { list } from '../adapter/codecs/accessors.ts';

/** A native-control MQTT topic's alias (fourth segment) and attribute (last), when the attribute is one this controls. */
export function controlTopic(topic: string): { alias: string; attribute: string } | undefined {
  const parts = topic.split('/'), alias = parts[3] ?? '', attribute = parts.at(-1) ?? '';
  return CONTROLLED.includes(attribute) ? { alias, attribute } : undefined;
}

const CONTROLLED = ['power', 'brightness', 'rgb', 'temperature', 'effect'];

/**
 * The UI row whose power topic names `alias`, read leniently from the raw
 * `ui_rows` (never raises, unlike `effects_ui_sync`'s row parse). The last
 * matching row wins. `source` is the row's own value when it is a string, and
 * `undefined` otherwise -- the only thing the caller asks of it.
 */
export function nativeSourceFor(rows: JsonValue[] | undefined, alias: string): { matched: boolean; source: string | undefined } {
  let source: JsonValue | undefined, matched = false;
  for (const raw of list(rows)) {
    const row = object(raw), topic = object(row.topics).power;
    if (typeof topic === 'string' && topic.split('/')[3] === alias) {
      source = row.source;
      matched = true;
    }
  }
  return { matched, source: typeof source === 'string' ? source : undefined };
}
