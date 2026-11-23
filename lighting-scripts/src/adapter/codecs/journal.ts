/**
 * The journal: the reconciler's beliefs as text, so a restart of the process
 * knows what each bulb was sent and sends nothing a bulb already shows.
 *
 * Reading recovers, never raises: the journal is a saved file the process
 * writes, and a missing or garbled one is no beliefs, which costs one send to
 * each bulb. An entry that does not read is no belief for that bulb or switch;
 * the rest are kept.
 */
import type { Attempts, Belief, Beliefs, LitAppearance, SwitchSent } from '../reconcile.ts';
import { NO_BELIEFS } from '../reconcile.ts';
import type { BulbAppearance } from '../../domain/effect.ts';
import type { BulbId, SwitchId } from '../../domain/types/ids.ts';
import type { Colour, Power } from '../../domain/types/light.ts';
import type { Instant } from '../../domain/types/time.ts';
import type { JsonObject, JsonValue } from '../ha-client.ts';
import { toBulbId, toColourChannel, toInstant, toKelvin, toLevel, toSwitchId } from './ids.ts';
import { isObject, ParseError } from './parse.ts';

/** The journal's format; a journal of another version is no beliefs. */
const VERSION = 1;

/** The beliefs as journal text. */
export function saveBeliefs(beliefs: Beliefs): string {
  return JSON.stringify({ version: VERSION, bulbs: beliefs.bulbs, switches: beliefs.switches });
}

/** Journal text read back: no text, text that is not a journal, or a journal of another version is no beliefs. */
export function loadBeliefs(text: string | undefined): Beliefs {
  const document = text === undefined ? undefined : jsonOf(text);
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

function beliefOf(entry: JsonValue): Belief {
  const fields = fieldsOf(entry);
  switch (fields.kind) {
    case 'sent':
      return { kind: 'sent', shows: appearanceOf(fields.shows), sentAt: instantOf(fields.sentAt), settlesAt: instantOf(fields.settlesAt),
        reapplies: listOf(fields.reapplies).map(instantOf) };
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
  const fields = fieldsOf(entry);
  return { power: powerOf(fields.power), sentAt: instantOf(fields.sentAt) };
}

function powerOf(value: JsonValue | undefined): Power {
  if (value === 'on' || value === 'off') return value;
  throw new ParseError('journal: not a power');
}
