/**
 * One turn of the adapter: read the input, update the Model, write back what
 * changed, compute the lighting state and reconcile the bulbs and switches to
 * it (spec 5.2). The Model lives in this process between turns; with none
 * (the process's first input) or on a start, it is read from Home Assistant.
 * A helper change reads the config and the profiles again.
 */
import { dashboardView } from '../domain/dashboard.ts';
import type { DashboardControl, DashboardView } from '../domain/dashboard.ts';
import { lightingState, nextChange } from '../domain/lighting-state.ts';
import type { Model, Msg } from '../domain/model.ts';
import { update } from '../domain/update.ts';
import type { BulbId, SwitchId } from '../domain/types/ids.ts';
import type { Instant } from '../domain/types/time.ts';
import { toDashboardControlId, toInstant } from './codecs/ids.ts';
import { timestamp } from './codecs/accessors.ts';
import type { HouseView } from './codecs/house.ts';
import { ParseError } from './codecs/parse.ts';
import { bulbGroups } from './codecs/bulb-groups.ts';
import { blockLightSaved, bulbTopics, decodeConfig, reportedBulbs } from './codecs/config.ts';
import { configSource, decodeModel } from './codecs/model.ts';
import { decodeRangeDefaults } from './codecs/range-defaults.ts';
import { carries, outcomeOf, publishes } from './encode.ts';
import type { Output } from './encode.ts';
import { controlOver, messages, profileStoreOf, storeSaveIn, uiRowsOf, unexplainedMessages } from './codecs/inputs.ts';
import type { HaInput, StoreSave } from './codecs/inputs.ts';
import { decodeObserved } from './codecs/observed.ts';
import type { Observed } from './codecs/observed.ts';
import {
  afterSend, backOn, forgotten, NO_BELIEFS, newlyParked, nextRetry, nextSends, reportedChanged, switchesSeen, unexplained,
} from './reconcile.ts';
import type { Beliefs, Outcome, Send } from './reconcile.ts';
import { configStoreWrite, dashboardWrites, modelWrites, uiSyncWrites } from './codecs/writes.ts';
import type { ControlRow, StoreWrite } from './codecs/writes.ts';

/**
 * What the adapter keeps between turns: the Model, what each bulb and switch was sent, the dashboard last shown, and
 * what the bulbs and switches reported at the last turn, which the next one reads changes against.
 */
export type AdapterState = { model: Model; beliefs: Beliefs; view: DashboardView | undefined; observed: Observed };

/**
 * What the adapter has before a turn: the state it kept from the last turn, or, at the process's start, only the
 * beliefs its journal held, so a restart sends nothing a bulb already shows.
 */
export type Kept = { kind: 'running'; state: AdapterState } | { kind: 'starting'; beliefs: Beliefs };

/**
 * A turn's result, before its outputs are made: the state to keep, whose beliefs are those before any send; the
 * outputs in order; each send with the outputs that carry it; the turn's clock; the lighting's next change; and why
 * the input was dropped, when it was. {@link afterOutputs} turns it into what to keep once the outputs have gone.
 */
export type Turn = {
  state: AdapterState; outputs: Output[]; sends: readonly Sending[]; now: Instant; nextChange: Instant | undefined;
  dropped: string | undefined;
};

/** A send and the outputs that carry it, by their place in the turn's outputs: a bulb's publishes, a switch's call. */
export type Sending = { send: Send; carriedBy: readonly number[] };

/**
 * A turn once its outputs have gone: the state to keep, when to be woken (the lighting's next change, or a failed
 * send's retry when that comes first), and the bulbs given up on, each reported once. A send settling asks for no
 * wake of its own: the next minute's tick looks again, as today's scripts did, and a wake seconds after every send
 * would move the house's clock under the harness's checkpoints.
 */
export type Settled = { state: AdapterState; wakeAt: Instant | undefined; parked: readonly BulbId[] };

/**
 * The turn once its first `failed.length` outputs have gone, `failed` saying which of them failed. A send whose
 * outputs have all gone is believed by how they went; one with an output still to go is not yet believed, so beliefs
 * saved part-way through a turn hold only what was sent.
 */
export function afterOutputs(turn: Turn, failed: readonly boolean[]): Settled {
  let beliefs = turn.state.beliefs;
  for (const { send, carriedBy } of turn.sends) {
    if (carriedBy.some(index => index >= failed.length)) continue;
    const lost = carriedBy.flatMap(index => {
      const output = turn.outputs[index];
      return failed[index] === true && output !== undefined ? [output] : [];
    });
    beliefs = afterSend(beliefs, send, outcomeIn(send, lost), turn.now);
  }
  const wakeAt = [turn.nextChange, nextRetry(beliefs, turn.now)].reduce<Instant | undefined>((first, at) =>
    at === undefined || (first !== undefined && first <= at) ? first : at, undefined);
  return { state: { ...turn.state, beliefs }, wakeAt, parked: newlyParked(turn.state.beliefs, beliefs) };
}

/** How a send went, from its outputs that failed: a switch's failed call is a failed send. */
function outcomeIn(send: Send, lost: readonly Output[]): Outcome {
  if (send.kind === 'switch') return lost.length === 0 ? 'sent' : 'failed';
  return outcomeOf(send, lost.flatMap(output => output.kind === 'publish' ? [output.publish] : []));
}

/**
 * One turn: read, update, write back what changed, compute the lighting state,
 * reconcile. Pure but for the house it is handed, whose `now` is the clock.
 * Every input applies the clock first, then its own messages, in order. An
 * input that cannot be read is dropped, and the turn goes on with the clock.
 */
export function handleInput(kept: Kept, house: HouseView, input: HaInput): Turn {
  const state = kept.kind === 'running' ? kept.state : undefined;
  const now = toInstant(timestamp(house.now));
  const before = state === undefined || input.kind === 'started' ? decodeModel(configSource(house), house.catalog)
    : input.kind === 'helper changed' ? update(state.model, helpersRead(house, now)) : state.model;
  // The clock runs first, and the input is read against what it leaves: a reset at this instant is already applied.
  const clocked = update(before, { kind: 'clock', now });
  // What changed since the last turn that no send of ours explains: a plug's own button is pressed first, then the input.
  const changed = state === undefined ? [] : unexplained(state.observed, decodeObserved(house.state, clocked.config), state.beliefs);
  let own: Msg[] = unexplainedMessages(changed, now), dropped: string | undefined, saved: StoreSave | undefined;
  try {
    own = [...own, ...messages(input, clocked, now, house), ...rangeDefaultsMessages(input, house, now)];
    saved = storeSaveIn(input, house);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    dropped = `${input.kind}: ${error.message}`;
  }
  // A block light's save (a store that is no lamp's or plug's profile) is written as it is, and goes through `update`
  // as the config the helpers will hold once it lands, so the lamps move in this turn and not on the echo.
  const configWrite = saved === undefined || profileStoreOf(saved.store, clocked) !== undefined ? undefined : configStoreWrite(saved, house);
  const messaged = own.reduce(update, clocked);
  const model = saved === undefined || configWrite === undefined ? messaged
    : update(messaged, blockLightRead(saved, configWrite, messaged, house, now));
  const outputs: Output[] = [];
  const written = modelWrites(before, model, house, now);
  if (written.sensor !== undefined) outputs.push({ kind: 'sensor', write: written.sensor });
  for (const write of written.helpers) outputs.push({ kind: 'helper', write });
  for (const write of written.stores) outputs.push({ kind: 'store', write });
  if (configWrite !== undefined) outputs.push({ kind: 'store', write: configWrite });

  const lighting = lightingState(model, now);
  const rows = controlRows(model, house);
  const view = dashboardView(model, lighting, now, rows.map(row => row.control));
  const previous = state === undefined || input.kind === 'started' ? undefined : state.view;
  const sync: ControlRow[] = rows.map(row => ({ control: row.control.control, topics: row.topics }));
  for (const write of dashboardWrites(previous, view, sync, house)) outputs.push({ kind: 'dashboard', write });
  for (const write of uiSyncWrites(house, previous === undefined)) outputs.push({ kind: 'dashboard', write });

  let beliefs = kept.kind === 'running' ? kept.state.beliefs : kept.beliefs;
  const observed = decodeObserved(house.state, model.config);
  if (input.kind === 'state changed') {
    const reported = reportedBulbs(input.entities, model.config);
    beliefs = state === undefined ? forgotten(beliefs, reported) : reportedChanged(beliefs, state.observed, observed, reported);
  }
  beliefs = switchesSeen(backOn(beliefs, changed.flatMap(change => change.kind === 'bulb back on' ? [change.bulb] : [])), observed,
    lighting.switches);
  const { sends } = nextSends(lighting, model.config, observed, beliefs, now);
  const topics = bulbTopics(house.catalog), groups = bulbGroups(house.catalog);
  const sent = publishes(sends, topics, groups), first = outputs.length, sending: Sending[] = [];
  for (const publish of sent) outputs.push({ kind: 'publish', publish });
  for (const send of sends) {
    if (send.kind === 'switch') {
      sending.push({ send, carriedBy: [outputs.length] });
      outputs.push({ kind: 'switch', switch: send.switch, power: send.power });
    } else {
      sending.push({ send, carriedBy: sent.flatMap((publish, index) => carries(send, publish, topics, groups) ? [first + index] : []) });
    }
  }
  return { state: { model, beliefs, view, observed }, outputs, sends: sending, now, nextChange: nextChange(model, now), dropped };
}

/** The config and the profiles read again from the helpers, as the message `update` takes them. */
function helpersRead(house: HouseView, now: Instant): Msg {
  const read = decodeModel(configSource(house), house.catalog);
  return { kind: 'configChanged', config: read.config, lampProfiles: read.lampProfiles, switchProfiles: read.switchProfiles, at: now };
}

/**
 * The house's range defaults from the dashboard's range helpers, saved at a
 * start and on a helper change when both ranges hold (today's
 * `switch_lamps_validate_house_defaults`).
 */
function rangeDefaultsMessages(input: HaInput, house: HouseView, now: Instant): Msg[] {
  if (input.kind !== 'started' && input.kind !== 'helper changed') return [];
  const defaults = decodeRangeDefaults(house.state);
  return defaults === undefined ? [] : [{ kind: 'rangeDefaultsSaved', defaults, at: now }];
}

/** A block light's save as the config the helpers will hold once it lands; the profiles stay as the Model has them. */
function blockLightRead(save: StoreSave, write: StoreWrite, model: Model, house: HouseView, now: Instant): Msg {
  const states = blockLightSaved(house.state, save.store, write.text, save.change);
  const config = decodeConfig({ ...configSource(house), states }, house.catalog);
  return { kind: 'configChanged', config, lampProfiles: model.lampProfiles, switchProfiles: model.switchProfiles, at: now };
}

/** The catalog's live controls (the UI rows with no profile store) the Model has a lamp or room for, with their proxy topics. */
function controlRows(model: Model, house: HouseView): Array<{ control: DashboardControl; topics: ControlRow['topics'] }> {
  return uiRowsOf(house).flatMap(row => {
    if (row.store !== undefined) return [];
    const over = controlOver(row, model);
    return over === undefined ? [] : [{ control: { control: toDashboardControlId(row.source), over }, topics: row.topics }];
  });
}
