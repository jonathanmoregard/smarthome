// Hand-counted sample for tests/runtime/domain-words.test.ts. Every column's
// expected count is written in the test; keep the two in step.
import type { HouseView, Plan } from '../runtime/effects.ts';
import type { Verbatim } from '../runtime/verbatim.ts';
import { roomId } from '../parse/ids.ts';
import type { RoomId } from './types/ids.ts';

// Comments are not code: function* yield Plan<x> view.get('sensor.x') ?? x as y typeof z kind: 'service'.

const COLOURS = ['red', 'blue'] as const;

export function* turnOn(view: HouseView, document: Verbatim): Plan<null> {
  const state = view.get('light.example');
  yield { kind: 'service', service: 'light.turn_on' };
  yield { kind: 'script', name: 'ls_commit', args: document };
  const named = state as string;
  const level = view.attr('light.example', 'brightness') ?? 0;
  void named;
  void level;
  return null;
}

export function check(value: unknown, names: string[], room: RoomId | undefined): boolean {
  const kind = typeof value;
  const own = room!;
  void own;
  return ['a', 'b'].includes(kind) && COLOURS.includes('red') && names.includes('x');
}

export function made(raw: string): RoomId {
  return roomId(raw);
}

export function forged(raw: string): RoomId {
  return raw as RoomId;
}

// A type query is not a runtime `typeof` test.
export type Colours = typeof COLOURS;

// A local alias hides nothing: using one counts as using what it names.
type Room = RoomId;
type Carried = Verbatim;
type Documents = Carried[] | undefined;
// A named object type is not a carried type, though its field is one.
type Wrapper = { document: Verbatim };

export function aliased(raw: string, document: Carried, documents: Documents, wrapper: Wrapper): Room {
  void document;
  void documents;
  void wrapper;
  return raw as Room;
}

// A HouseView read by destructuring, as a parameter or from a variable, or by
// element access, is as much a view read as `view.get`.
export function destructured({ get, now }: HouseView, view: HouseView): unknown[] {
  const { attr } = view;
  return [get, now, attr, view['state']];
}

// A domain value whose own type, declared in the domain, names one of the effect kinds is not an effect.
type Part = { kind: 'schedule'; at: number } | { kind: 'fixed'; at: number };
export function handedBack(at: number): Part | undefined {
  return { kind: 'schedule', at };
}

// Only 'schedule' is exempt: a domain type that names another effect kind still counts.
type Call = { kind: 'service'; at: number };
export function called(at: number): Call {
  return { kind: 'service', at };
}
