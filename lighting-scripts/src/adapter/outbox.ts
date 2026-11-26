/**
 * The writes to Home Assistant still to land: the overrides sensor, the remote helpers, the profile and block-light
 * stores, and the dashboard's writes. The outbox is held in the adapter's state; nothing derives it from the Model.
 *
 * A write enters when a turn makes it, and leaves when Home Assistant has it (it answered the call, or its state shows
 * the value) or when a newer change by someone else, made after the write was queued, supersedes it; the sensor's
 * changes are held key by key, and each is superseded on its own. Nothing else
 * drops it: a helper read, a reconnect or a helper change only update what Home Assistant is read to hold, and the
 * writes still waiting are laid over that read, so the Model keeps them. A refused write is tried again on the bulbs'
 * backoff, {@link MAX_ATTEMPTS} times, then parked and said once; a call not made (Home Assistant out of reach) counts
 * no try. Only the writes due are sent: a write a turn makes again unchanged is the one already waiting.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Instant } from '../domain/types/time.ts';
import { storeLanded } from './codecs/config.ts';
import { afterOutput, withStates, writeSettled } from './codecs/house.ts';
import type { HouseView } from './codecs/house.ts';
import type { Share } from './codecs/rooms.ts';
import { sensorSettled, sensorWriteOver } from './codecs/writes.ts';
import type { SensorChanges } from './codecs/writes.ts';
import type { Output } from './encode.ts';
import { MAX_ATTEMPTS, retryAt } from './reconcile.ts';

/** A write to Home Assistant other than a bulb's publish or a switch's power: the sensor's as the port's own changes to it. */
export type Write = { kind: 'sensor'; write: SensorChanges } | Exclude<Output, { kind: 'publish' } | { kind: 'switch' } | { kind: 'sensor' }>;

/** What a write is to: its entity, or for a publish, its topic. */
export function targetOf(write: Write): string {
  switch (write.kind) {
    case 'sensor': case 'helper': case 'store': return write.write.entity;
    case 'dashboard': {
      const dashboard = write.write;
      return dashboard.kind === 'block selector' || dashboard.kind === 'mode mirror' || dashboard.kind === 'plants all-off' ? dashboard.entity
        : `mqtt:${dashboard.topic}`;
    }
  }
}

/**
 * Whether two writes to one target set the same: the sensor's by each key's new value, its revision and the reads they
 * were made over aside.
 */
function same(a: Write, b: Write): boolean {
  const keys = (write: SensorChanges) => write.changes.map(({ attribute, key, to }) => ({ attribute, key, to }));
  return a.kind === 'sensor' && b.kind === 'sensor' ? isDeepStrictEqual(keys(a.write), keys(b.write)) : isDeepStrictEqual(a, b);
}

/**
 * A write waiting: when it was queued, how often Home Assistant refused it, and when it is next due, parked, or held
 * for its store, which Home Assistant does not have.
 */
export type Entry = {
  write: Write; queuedAt: Instant; refusals: number; status: { kind: 'due'; at: Instant } | { kind: 'parked' } | { kind: 'no store' };
};

/** The output a waiting write makes now: the sensor's changes laid over the sensor as Home Assistant reports it, any other write as it is. */
export function outputOf(entry: Entry, reported: HouseView, share: Share): Output {
  const write = entry.write;
  return write.kind !== 'sensor' ? write : { kind: 'sensor', write: sensorWriteOver(write.write, reported.state[write.write.entity], entry.queuedAt, share) };
}

/**
 * Whether a waiting write is held for Home Assistant's echo: a guarded sensor write (some room is the old scripts') is
 * made only over a `last_updated` Home Assistant reported, so while the sensor shows a write of ours it has not yet
 * echoed, the write waits for that echo or the next read, rather than going over our own stamp and being refused.
 */
export function awaitsEcho(entry: Entry, reported: HouseView, share: Share): boolean {
  return entry.write.kind === 'sensor' && share.kind !== 'house' && reported.state[entry.write.write.entity]?.laid !== undefined;
}

export type Outbox = readonly Entry[];

/**
 * The outbox without the writes Home Assistant's states show it has, or that a newer change superseded. A sensor
 * write is settled once each of its keys shows its change or someone else's newer one; a newer commit to other keys
 * leaves it to be made again over the newer read.
 */
export function settled(outbox: Outbox, house: HouseView): Outbox {
  return outbox.filter(({ write, queuedAt }) => write.kind === 'sensor' ? !sensorSettled(write.write, house.state[write.write.entity], queuedAt)
    : !writeSettled(house.state, write, queuedAt));
}

/** The share a write laid over the house is resolved for: the read it is laid on is the one it is made over. */
const HOUSE: Share = { kind: 'house' };

/**
 * The house as it will be once the waiting writes land: each laid over Home Assistant's states, so a read of the
 * helpers, or of the overrides sensor, keeps them. A parked write is not laid over: Home Assistant refused it, and the
 * Model follows what Home Assistant holds.
 */
export function withWaiting(house: HouseView, outbox: Outbox): HouseView {
  const laid = outbox.filter(entry => entry.status.kind !== 'parked');
  return laid.length === 0 ? house : withStates(house, laid.reduce((states, entry) => entry.write.kind === 'store'
    ? storeLanded(states, entry.write.write.entity, entry.write.write.text)
    : afterOutput(states, outputOf(entry, withStates(house, states), HOUSE), entry.queuedAt), house.state));
}

/**
 * When the next waiting write is due after `now`, if one is. A write due by `now` that the turn did not make waits for
 * Home Assistant (back in reach, or the echo of ours): what brings that runs the next turn, so it asks for no wake.
 */
export function nextTry(outbox: Outbox, now: Instant): Instant | undefined {
  return outbox.reduce<Instant | undefined>((first, entry) => entry.status.kind !== 'due' || entry.status.at <= now
    || (first !== undefined && first <= entry.status.at) ? first : entry.status.at, undefined);
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

/**
 * The outbox with each store write held while Home Assistant has no such store, and made due at `now` once it has;
 * and the writes held anew, each said once. Home Assistant answers a write to an input_text it lacks with success and
 * sets nothing, so a write sent there would be taken and lost. A held write is still laid over the house, so the Model
 * keeps it.
 */
export function heldForStore(outbox: Outbox, reported: HouseView, now: Instant): { outbox: Outbox; held: Entry[] } {
  const held: Entry[] = [];
  const next = outbox.map((entry): Entry => {
    if (entry.write.kind !== 'store') return entry;
    const missing = reported.state[entry.write.write.entity] === undefined;
    if (missing && entry.status.kind !== 'no store') {
      const waiting: Entry = { ...entry, status: { kind: 'no store' } };
      held.push(waiting);
      return waiting;
    }
    return !missing && entry.status.kind === 'no store' ? { ...entry, status: { kind: 'due', at: now } } : entry;
  });
  return { outbox: next, held };
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
