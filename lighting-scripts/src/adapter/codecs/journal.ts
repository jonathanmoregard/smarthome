/**
 * The journal: the reconciler's beliefs as text, so a restart of the process
 * knows what each bulb was sent and sends nothing a bulb already shows, and the
 * share of the house the process drove, so a room handed over while it was down
 * is taken as found.
 *
 * Reading recovers, never raises: the journal is a saved file the process
 * writes, and a missing or garbled one is no beliefs, which costs one send to
 * each bulb. An entry that does not read is no belief for that bulb or switch;
 * the rest are kept.
 */
import type { Attempts, Belief, Beliefs, LitAppearance, ObservedLight, SwitchSent } from '../reconcile.ts';
import { NO_BELIEFS } from '../reconcile.ts';
import type { BulbAppearance } from '../../domain/effect.ts';
import type { BulbId, SwitchId } from '../../domain/types/ids.ts';
import type { Colour, Power } from '../../domain/types/light.ts';
import type { Instant } from '../../domain/types/time.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import { toBulbId, toColourChannel, toInstant, toKelvin, toLevel, toRoomId, toSwitchId } from './ids.ts';
import type { Share } from './rooms.ts';
import { isObject, ParseError } from './parse.ts';

/** The journal's format; a journal of another version is no beliefs. */
const VERSION = 1;

/** What the journal keeps: the beliefs, and the share of the house the process drove when it saved them. */
export type JournalRecord = { beliefs: Beliefs; share: Share };

/** The record as journal text. */
export function saveJournal(record: JournalRecord): string {
  const share = record.share.kind === 'house' ? record.share : { kind: 'rooms', rooms: [...record.share.rooms].sort() };
  return JSON.stringify({ version: VERSION, bulbs: record.beliefs.bulbs, switches: record.beliefs.switches, share });
}

/**
 * Journal text read back. No text, text that is not a journal, or a journal of another version is no beliefs; a share
 * that is missing or does not read is no room, so every room is taken as found.
 */
export function loadJournal(text: string | undefined): JournalRecord {
  const document = text === undefined ? undefined : jsonOf(text);
  const share = isObject(document) ? readable(() => shareOf(document.share)) ?? NO_ROOMS : NO_ROOMS;
  return { beliefs: beliefsOf(document), share };
}

const NO_ROOMS: Share = { kind: 'rooms', rooms: new Set() };

function jsonOf(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** An entry read by a reader that raises {@link ParseError}: none when it does not read. */
function readable<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof ParseError) return undefined;
    throw error;
  }
}

function shareOf(value: JsonValue | undefined): Share {
  if (!isObject(value)) throw new ParseError('the share is not an object');
  if (value.kind === 'house') return { kind: 'house' };
  const rooms = value.rooms;
  if (value.kind !== 'rooms' || !Array.isArray(rooms)) throw new ParseError('the share is neither the house nor a list of rooms');
  return { kind: 'rooms', rooms: new Set(rooms.map(room => {
    if (typeof room !== 'string' || room === '') throw new ParseError('a room of the share is not a room id');
    return toRoomId(room);
  })) };
}

function beliefsOf(document: JsonValue | undefined): Beliefs {
  if (!isObject(document) || document.version !== VERSION || !isObject(document.bulbs) || !isObject(document.switches)) {
    return NO_BELIEFS;
  }
  const bulbs: Record<BulbId, Belief> = {}, switches: Record<SwitchId, SwitchSent> = {};
  for (const [id, entry] of Object.entries(document.bulbs)) {
    const belief = readable(() => beliefOf(entry));
    if (belief !== undefined) bulbs[toBulbId(id)] = belief;
  }
  for (const [id, entry] of Object.entries(document.switches)) {
    const sent = readable(() => switchSentOf(entry));
    if (sent !== undefined) switches[toSwitchId(id)] = sent;
  }
  return { bulbs, switches };
}

function beliefOf(entry: JsonValue): Belief {
  const fields = fieldsOf(entry);
  switch (fields.kind) {
    case 'sent':
      return { kind: 'sent', shows: appearanceOf(fields.shows), sentAt: instantOf(fields.sentAt), settlesAt: instantOf(fields.settlesAt),
        reapplies: listOf(fields.reapplies).map(instantOf), reportedWhenSent: reportOf(fields.reportedWhenSent) };
    case 'retrying':
      return { kind: 'retrying', shows: fields.shows === undefined ? undefined : litOf(fields.shows), attempts: attemptsOf(fields.attempts),
        retryAt: instantOf(fields.retryAt) };
    case 'parked':
      return { kind: 'parked', lastSent: appearanceOf(fields.lastSent) };
    case 'back on':
      return { kind: 'back on' };
    default:
      throw new ParseError(`journal: not a belief kind: ${JSON.stringify(fields.kind) ?? 'none'}`);
  }
}

function fieldsOf(value: JsonValue | undefined): JsonObject {
  if (isObject(value)) return value;
  throw new ParseError('journal: not an entry');
}

function appearanceOf(value: JsonValue | undefined): BulbAppearance {
  return isObject(value) && value.power === 'off' ? { power: 'off' } : litOf(value);
}

function litOf(value: JsonValue | undefined): LitAppearance {
  const fields = fieldsOf(value);
  if (fields.power !== 'on') throw new ParseError('journal: a lit appearance is not on');
  const firmwareEffect = fields.firmwareEffect;
  if (firmwareEffect !== 'none' && firmwareEffect !== 'candle') throw new ParseError('journal: not a firmware effect');
  return { power: 'on', level: toLevel(numberOf(fields.level)), colour: fields.colour === undefined ? undefined : colourOf(fields.colour),
    firmwareEffect };
}

/** A bulb's report as a send went out; an entry saved before it was kept has none, and is no belief. */
function reportOf(value: JsonValue | undefined): ObservedLight {
  const fields = fieldsOf(value);
  if (fields.power === 'off') return { power: 'off' };
  if (fields.power !== 'on') throw new ParseError('journal: a report is neither on nor off');
  return { power: 'on', level: toLevel(numberOf(fields.level)), colour: fields.colour === undefined ? undefined : colourOf(fields.colour) };
}

function numberOf(value: JsonValue | undefined): number {
  if (typeof value === 'number') return value;
  throw new ParseError('journal: not a number');
}

function colourOf(value: JsonValue): Colour {
  const fields = fieldsOf(value);
  if (fields.kind === 'kelvin') return { kind: 'kelvin', kelvin: toKelvin(numberOf(fields.kelvin)) };
  if (fields.kind !== 'rgb') throw new ParseError('journal: not a colour kind');
  const rgb = fieldsOf(fields.rgb);
  return { kind: 'rgb', rgb: { red: toColourChannel(numberOf(rgb.red)), green: toColourChannel(numberOf(rgb.green)),
    blue: toColourChannel(numberOf(rgb.blue)) } };
}

function instantOf(value: JsonValue | undefined): Instant {
  return toInstant(numberOf(value));
}

function listOf(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  throw new ParseError('journal: not a list');
}

function attemptsOf(value: JsonValue | undefined): Attempts {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  throw new ParseError('journal: not a count of failed sends');
}

function switchSentOf(entry: JsonValue): SwitchSent {
  const fields = fieldsOf(entry), power = powerOf(fields.power), sentAt = instantOf(fields.sentAt);
  switch (fields.kind) {
    case 'open': return { kind: 'open', power, sentAt, attempts: attemptsOf(fields.attempts), retryAt: instantOf(fields.retryAt) };
    case 'parked': return { kind: 'parked', power, sentAt };
    default: throw new ParseError(`journal: not a switch send kind: ${JSON.stringify(fields.kind) ?? 'none'}`);
  }
}

function powerOf(value: JsonValue | undefined): Power {
  if (value === 'on' || value === 'off') return value;
  throw new ParseError('journal: not a power');
}
