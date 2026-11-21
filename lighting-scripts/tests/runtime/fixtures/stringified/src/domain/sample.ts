// Hand-counted sample for tests/runtime/stringified.test.ts. Every expected
// site is written in the test; keep the two in step.
import type { RoomId } from './types/ids.ts';

type Mode = 'day' | 'night';
type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

// Comments are not code: String(value) `${value}` 'a' + value.

export function text(room: RoomId, mode: Mode, count: number, big: bigint, name: string): string[] {
  // None of these is a site: an id, a literal union, a number, a bigint and text.
  return [String(room), `${mode}:${count}`, `${big}`, 'x' + name, name + count, String(mode)];
}

export function stringifiedCall(value: Json, flag: boolean): string {
  // Two sites: String() of a JSON value and of a boolean.
  return String(value) + String(flag).length;
}

export function stringifiedHole(area: RoomId | null, label: string | undefined, entry: { id: string }): string {
  // Three sites: a room that may be null, text that may be absent, and an object.
  return `sensor.cache_${area}/${label}/${entry}`;
}

export function concatenated(value: unknown, room: RoomId): string {
  // One site: `'key:' + value`. `+ room` is text.
  let key = 'key:' + value;
  key += room;
  return key;
}

export function appended(key: string, flag: boolean | undefined): string {
  // One site: `+=` of a value that is not text.
  let out = key;
  out += flag;
  return out;
}

export function narrowed(value: Json): string {
  // Not a site: the value is narrowed to text before it is joined.
  if (typeof value === 'string') return `room:${value}`;
  return 'none';
}

export function generic<T extends string>(value: T, other: unknown): string {
  // One site: `other`. A type parameter bounded by string is text.
  return `${value}` + `${String(other).length}`;
}

export function tagged(value: Json): string {
  // Not a site: a tagged template hands the value to its tag, which does not join it.
  return tag`${value}`;
}

function tag(strings: TemplateStringsArray, ...values: Json[]): string {
  return strings.join('') + values.length;
}

export function shadowed(value: Json): string {
  // Not a site: this `String` is a local function, not the global.
  const String = (raw: Json): string => typeof raw === 'string' ? raw : 'other';
  return String(value);
}
