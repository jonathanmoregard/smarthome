/**
 * The writes to Home Assistant still to land: the overrides sensor, the remote helpers, the profile and block-light
 * stores, and the dashboard's writes. The outbox is held in the adapter's state; nothing derives it from the Model.
 *
 * A write enters when a turn makes it, and leaves when Home Assistant has it (it answered the call, or its state shows
 * the value) or when a newer change by someone else, made after the write was queued, supersedes it. Nothing else
 * drops it: a helper read, a reconnect or a helper change only update what Home Assistant is read to hold, and the
 * writes still waiting are laid over that read, so the Model keeps them. A refused write is tried again on the bulbs'
 * backoff, {@link MAX_ATTEMPTS} times, then parked and said once; a call not made (Home Assistant out of reach) counts
 * no try. Only the writes due are sent: a write a turn makes again unchanged is the one already waiting.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Instant } from '../domain/types/time.ts';
import { storeLanded } from './codecs/config.ts';
import { afterCall, callSettled, withStates } from './codecs/house.ts';
import type { HouseView } from './codecs/house.ts';
import { outputCall } from './encode.ts';
import type { Output } from './encode.ts';
import { MAX_ATTEMPTS, retryAt } from './reconcile.ts';

/** A write to Home Assistant other than a bulb's publish or a switch's power. */
export type Write = Exclude<Output, { kind: 'publish' } | { kind: 'switch' }>;

/** What a write is to: its entity, or for a publish, its topic. */
export function targetOf(write: Write): string {
  switch (write.kind) {
    case 'sensor': case 'helper': case 'store': return write.write.entity;
    case 'dashboard': return write.write.kind === 'block selector' || write.write.kind === 'mode mirror' ? write.write.entity : `mqtt:${write.write.topic}`;
  }
}

/** Whether two writes to one target set the same: the sensor's by its attributes, its revision aside. */
function same(a: Write, b: Write): boolean {
  return a.kind === 'sensor' && b.kind === 'sensor' ? isDeepStrictEqual(a.write.attributes, b.write.attributes) : isDeepStrictEqual(a, b);
}

/** A write waiting: when it was queued, how often Home Assistant refused it, and when it is next due, or parked. */
export type Entry = { write: Write; queuedAt: Instant; refusals: number; status: { kind: 'due'; at: Instant } | { kind: 'parked' } };

export type Outbox = readonly Entry[];

/** The outbox without the writes Home Assistant's states show it has, or that a newer change superseded. */
export function settled(outbox: Outbox, house: HouseView): Outbox {
  return outbox.filter(entry => !callSettled(house.state, outputCall(entry.write, entry.queuedAt), entry.queuedAt));
}

/**
 * The house as it will be once the waiting writes land: each laid over Home Assistant's states, so a read of the
 * helpers keeps them. The overrides sensor is left as Home Assistant holds it: its write is the whole difference from
 * that, made again each turn. A parked write is not laid over: Home Assistant refused it, and the Model follows what
 * Home Assistant holds.
 */
export function withWaiting(house: HouseView, outbox: Outbox): HouseView {
  const laid = outbox.filter(entry => entry.write.kind !== 'sensor' && entry.status.kind !== 'parked');
  return laid.length === 0 ? house : withStates(house, laid.reduce((states, { write, queuedAt }) => write.kind === 'store'
    ? storeLanded(states, write.write.entity, write.write.text) : afterCall(states, outputCall(write, queuedAt), queuedAt), house.state));
}

/** When the next waiting write is due, if one is. */
export function nextTry(outbox: Outbox): Instant | undefined {
  return outbox.reduce<Instant | undefined>((first, entry) =>
    entry.status.kind !== 'due' || (first !== undefined && first <= entry.status.at) ? first : entry.status.at, undefined);
}

/** Every parked write due again at `now`, its refusals forgotten: Home Assistant is back, or started again, as bulbs are unparked. */
export function unparkedWrites(outbox: Outbox, now: Instant): Outbox {
  return outbox.map(entry => entry.status.kind === 'parked' ? { ...entry, refusals: 0, status: { kind: 'due', at: now } } : entry);
}

/** How a write's call went: Home Assistant took it, refused it, or the call was not made (it was out of reach first). */
export type Tried = 'taken' | 'refused' | 'not made';

/**
 * The turn's writes put in: one the same as a write already waiting for its target is that write; one that differs
 * replaces it, due at once. A turn's own writes to one target all go, in order.
 */
export function queued(outbox: Outbox, writes: readonly Write[], now: Instant): Outbox {
  const fresh = writes.filter(write => !outbox.some(entry => targetOf(entry.write) === targetOf(write) && same(entry.write, write)));
  const kept = outbox.filter(entry => !fresh.some(write => targetOf(write) === targetOf(entry.write)));
  return [...kept, ...fresh.map((write): Entry => ({ write, queuedAt: now, refusals: 0, status: { kind: 'due', at: now } }))];
}

/** The writes due at `now`, in the order they were queued. */
export function dueAt(outbox: Outbox, now: Instant): Entry[] {
  return outbox.filter(entry => entry.status.kind === 'due' && entry.status.at <= now);
}

/** The outbox once the turn's writes were tried, and the writes parked by it. */
export function afterTries(outbox: Outbox, tried: ReadonlyMap<Entry, Tried>, now: Instant): { outbox: Outbox; parked: Entry[] } {
  const parked: Entry[] = [];
  const next = outbox.flatMap((entry): Entry[] => {
    const outcome = tried.get(entry);
    if (outcome === 'taken') return [];
    if (outcome !== 'refused') return [entry];
    const refusals = entry.refusals + 1;
    if (refusals >= MAX_ATTEMPTS) {
      const stopped: Entry = { ...entry, refusals, status: { kind: 'parked' } };
      parked.push(stopped);
      return [stopped];
    }
    return [{ ...entry, refusals, status: { kind: 'due', at: retryAt(now, refusals) } }];
  });
  return { outbox: next, parked };
}
