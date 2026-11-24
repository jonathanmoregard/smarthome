/**
 * One turn of the adapter: read the input, update the Model, write back what
 * changed, compute the lighting state and reconcile the bulbs and switches to
 * it (spec 5.2). The Model lives in this process between turns; with none
 * (the process's first input) or on a start, it is read from Home Assistant.
 * A helper change reads the config and the profiles again.
 */
import { dashboardView } from '../domain/dashboard.ts';
import type { DashboardView } from '../domain/dashboard.ts';
import { lightingState } from '../domain/lighting-state.ts';
import { update, nextChange } from '../domain/update.ts';
import type { Config } from '../domain/config.ts';
import type { BulbId, RoomId, SwitchId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { Instant } from '../domain/types/time.ts';
import { toDashboardControlId, toInstant } from './codecs/ids.ts';
import { timestamp } from './codecs/accessors.ts';
import type { HouseView } from './codecs/house.ts';
import { ParseError } from './codecs/parse.ts';
import { bulbGroups } from './codecs/bulb-groups.ts';
import { blockLightSaved, bulbTopics, decodeConfig, reportedBulbs } from './codecs/config.ts';
import type { BlockLight } from './codecs/config.ts';
import { configSource, decodeModel, followingSensor } from './codecs/model.ts';
import { drives, portSwitchesOn } from './codecs/rooms.ts';
import type { Share } from './codecs/rooms.ts';
import { ownsMessage, shareOf } from './live-rooms.ts';
import type { RoomsGiven } from './live-rooms.ts';
import type { JournalRecord } from './codecs/journal.ts';
import { decodeRangeDefaults } from './codecs/range-defaults.ts';
import { carries, outcomeOf, publishes } from './encode.ts';
import type { Output } from './encode.ts';
import { messages, storeSaveIn, unexplainedMessages } from './codecs/inputs.ts';
import { uiRowsOf } from './codecs/catalog.ts';
import type { HaInput, StoreSave } from './codecs/inputs.ts';
import { decodeObserved } from './codecs/observed.ts';
import type { Observed } from './reconcile.ts';
import {
  afterSend, backOn, forgotten, MAX_ATTEMPTS, NO_BELIEFS, newlyParked, nextRetry, nextSends, reportedChanged, switchesForgotten, switchesSeen,
  unexplained, unparked,
} from './reconcile.ts';
import type { Beliefs, Outcome, Send } from './reconcile.ts';
import { afterTries, dueAt, nextTry, queued, settled, targetOf, unparkedWrites, withWaiting } from './outbox.ts';
import type { Entry, Outbox, Tried, Write } from './outbox.ts';
import { configStoreWrite, dashboardWrites, modelWrites, uiSyncWrites } from './codecs/writes.ts';
import type { ControlRow, StoreWrite } from './codecs/writes.ts';
import type { LightingState } from '../domain/lighting-state.ts';
import type { LampProfileChange } from '../domain/profiles.ts';
import type { Model, Msg } from '../domain/update.ts';

/**
 * What the adapter keeps between turns: the Model, what each bulb and switch was sent, the dashboard last shown, what
 * the bulbs and switches reported at the last turn, which the next one reads changes against, and the writes to Home
 * Assistant still to land.
 */
export type AdapterState = {
  model: Model; beliefs: Beliefs; view: DashboardView | undefined; observed: Observed; outbox: Outbox;
  /** The share of the house the last turn drove, so a room handed over since is taken as found. */
  share: Share;
  /**
   * The config is read again next turn, as on a helper change: a write was parked, and the Model follows what Home
   * Assistant holds; or the catalog changed, and the config is decoded from the new one.
   */
  reread: boolean;
};

/**
 * What the adapter has before a turn: the state it kept from the last turn, or, at the process's start, only what its
 * journal held: the beliefs, so a restart sends nothing a bulb already shows, and the share they were sent under.
 */
export type Kept = { kind: 'running'; state: AdapterState } | ({ kind: 'starting' } & JournalRecord);

/** What is kept once the catalog changed: the next turn reads the config again, through `configChanged`, as a helper change does. A start reads it anyway. */
export function catalogChanged(kept: Kept): Kept {
  return kept.kind === 'running' ? { kind: 'running', state: { ...kept.state, reread: true } } : kept;
}

/**
 * A turn's result, before its outputs are made: the state to keep, whose beliefs are those before any send; the
 * outputs in order; each send with the outputs that carry it; the turn's clock; the lighting's next change; and why
 * the input was dropped, when it was. {@link afterOutputs} turns it into what to keep once the outputs have gone.
 */
export type Turn = {
  state: AdapterState; outputs: Output[]; sends: readonly Sending[]; now: Instant; nextChange: Instant | undefined;
  dropped: string | undefined;
  /** The outputs, by their place, after which the journal is saved: each bulb's publish, so a crash loses no send. */
  journalled: readonly number[];
  /** The outbox's writes the turn makes, each with its output's place. */
  writing: readonly { entry: Entry; output: number }[];
};

/** A send and the outputs that carry it, by their place in the turn's outputs: a bulb's publishes, a switch's call. */
export type Sending = { send: Send; carriedBy: readonly number[] };

/**
 * A turn once its outputs have gone: the state to keep, when to be woken (the lighting's next change, or a failed
 * send's or write's retry when that comes first), the bulbs given up on, each reported once, and the writes parked,
 * each warned of once. A send settling asks for no
 * wake of its own: the next minute's tick looks again, as today's scripts did, and a wake seconds after every send
 * would move the house's clock under the harness's checkpoints.
 */
export type Settled = {
  state: AdapterState; wakeAt: Instant | undefined; parked: readonly BulbId[]; notes: readonly string[]; warnings: readonly string[];
};

/**
 * The turn once its first `failed.length` outputs have gone, `failed` saying which of them failed. A send whose
 * outputs have all gone is believed by how they went; one with an output still to go is not yet believed, so beliefs
 * saved part-way through a turn hold only what was sent.
 */
export function afterOutputs(turn: Turn, failed: readonly boolean[]): Settled {
  let beliefs = turn.state.beliefs;
  const tried = new Map(turn.writing.map(({ entry, output }): [Entry, Tried] =>
    [entry, output >= failed.length ? 'not made' : failed[output] === true ? 'refused' : 'taken']));
  const { outbox, parked: stopped } = afterTries(turn.state.outbox, tried, turn.now);
  for (const { send, carriedBy } of turn.sends) {
    if (carriedBy.some(index => index >= failed.length)) continue;
    const lost = carriedBy.flatMap(index => {
      const output = turn.outputs[index];
      return failed[index] === true && output !== undefined ? [output] : [];
    });
    beliefs = afterSend(beliefs, send, outcomeIn(send, lost), turn.now);
  }
  const wakeAt = [turn.nextChange, nextRetry(beliefs, turn.now), nextTry(outbox)].reduce<Instant | undefined>((first, at) =>
    at === undefined || (first !== undefined && first <= at) ? first : at, undefined);
  const parked = newlyParked(turn.state.beliefs, beliefs);
  // A bulb given up on is most often switched off at the wall: said once, for the host's info log (owner, 2026-11-20).
  const notes = parked.map(bulb => `lighting: ${bulb} is parked: it does not take what it is sent; left until it comes back on or its light changes`);
  const warnings = stopped.map(entry =>
    `lighting: ${targetOf(entry.write)} is parked: Home Assistant refused it ${MAX_ATTEMPTS} times; the lighting follows what Home Assistant holds until it is written anew, changes, or Home Assistant is back`);
  return { state: { ...turn.state, beliefs, outbox, reread: turn.state.reread || stopped.length > 0 }, wakeAt, parked, notes, warnings };
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
 * The turn acts on, writes and sends only its share of the house (`given`,
 * spec 5.4); the rest of the house follows the store the old scripts write.
 */
export function handleInput(kept: Kept, reported: HouseView, input: HaInput, given: RoomsGiven): Turn {
  const state = kept.kind === 'running' ? kept.state : undefined;
  const now = toInstant(timestamp(reported.now));
  // The house as it will be once the writes still waiting land, so a read of the helpers keeps them.
  // A reconnect unparks every parked write, as it does every bulb.
  const landed = settled(state?.outbox ?? [], reported), waiting = input.kind === 'reconnected' ? unparkedWrites(landed, now) : landed;
  const house = withWaiting(reported, waiting);
  const read = input.kind === 'helper changed' || input.kind === 'reconnected' || state?.reread === true ? helpersRead(house, now) : undefined;
  const decoded = state === undefined || input.kind === 'started' ? decodeModel(configSource(house), house.catalog)
    : read === undefined ? state.model : update(state.model, read);
  const share = shareOf(given, given.kind === 'listed' ? portSwitchesOn(house.state, given.rooms) : new Set());
  const before = followingSensor(decoded, house, share);
  // The clock runs first, and the input is read against what it leaves: a reset at this instant is already applied.
  const clocked = update(before, { kind: 'clock', now });
  const taken = takenOver(kept.kind === 'running' ? kept.state.share : kept.share, share, clocked.config);
  // What changed since the last turn that no send of ours explains: a plug's own button is pressed first, then the input.
  // A room handed over since was the old scripts' meanwhile, and is taken as found: a change there is theirs.
  const changed = state === undefined ? [] : unexplained(state.observed, decodeObserved(house.state, clocked.config), state.beliefs)
    .filter(change => change.kind === 'switch pressed' ? !taken.switches.includes(change.switch) : !taken.bulbs.includes(change.bulb));
  let inputMessages: Msg[] = [], dropped: string | undefined, saved: StoreSave | undefined;
  try {
    inputMessages = [...messages(input, clocked, now, house), ...rangeDefaultsMessages(input, house, now)];
    saved = storeSaveIn(input, house, clocked);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    dropped = `${input.kind}: ${error.message}`;
  }
  // The turn's messages are the share's, the input's and the presses alike, whether the input read or was dropped.
  const own = [...unexplainedMessages(changed, now), ...inputMessages].filter(msg => ownsMessage(share, msg, clocked.config));
  // A block light's save is written as it is, and goes through `update` as the config the helpers will hold once it
  // lands, so the lamps move in this turn and not on the echo.
  const light = saved?.target.kind === 'block light' && drives(share, saved.target.scope === 'house' ? undefined : saved.target.scope)
    ? saved.target : undefined;
  const configWrite = saved === undefined || light === undefined ? undefined : configStoreWrite(light, saved.change, house);
  const messaged = own.reduce(update, clocked);
  const model = saved === undefined || light === undefined || configWrite === undefined ? messaged
    : update(messaged, blockLightRead(light, saved.change, configWrite, messaged, house, now));
  const writes: Write[] = [];
  const written = modelWrites(before, model, house, reported, now, share);
  if (written.sensor !== undefined) writes.push({ kind: 'sensor', write: written.sensor });
  for (const write of written.helpers) writes.push({ kind: 'helper', write });
  for (const write of written.stores) writes.push({ kind: 'store', write });
  if (configWrite !== undefined) writes.push({ kind: 'store', write: configWrite });

  const lighting = lightingState(model, now);
  const view = dashboardView(model, lighting, now);
  const previous = state === undefined || input.kind === 'started' ? undefined : state.view;
  const sync = controlRows(model, house);
  // The dashboard is the old scripts' to show while some room is still theirs.
  if (share.kind === 'house') {
    for (const write of dashboardWrites(previous, view, sync, house)) writes.push({ kind: 'dashboard', write });
    for (const write of uiSyncWrites(house, previous === undefined)) writes.push({ kind: 'dashboard', write });
  }
  const outbox = queued(waiting, writes, now), due = dueAt(outbox, now);
  const outputs: Output[] = due.map(entry => entry.write);
  const writing = due.map((entry, output) => ({ entry, output }));

  let beliefs = kept.kind === 'running' ? kept.state.beliefs : kept.beliefs;
  if (input.kind === 'reconnected') beliefs = unparked(beliefs);
  // What the port sent a room before it was handed over says nothing: the old scripts drove it meanwhile.
  beliefs = switchesForgotten(forgotten(beliefs, taken.bulbs), taken.switches);
  const observed = decodeObserved(house.state, model.config);
  if (input.kind === 'state changed') {
    const reported = reportedBulbs(input.entities, model.config);
    beliefs = state === undefined ? forgotten(beliefs, reported) : reportedChanged(beliefs, state.observed, observed, reported);
  }
  beliefs = switchesSeen(backOn(beliefs, changed.flatMap(change => change.kind === 'bulb back on' ? [change.bulb] : [])), observed,
    lighting.switches);
  const { sends } = nextSends(sharedLighting(lighting, model.config, share), model.config, observed, beliefs, now);
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
  const journalled = outputs.flatMap((output, index) => output.kind === 'publish' ? [index] : []);
  const next: AdapterState = { model, beliefs, view, observed, outbox, reread: false, share };
  return { state: next, outputs, sends: sending, now, nextChange: nextChange(model, now), dropped, journalled, writing };
}

/**
 * The bulbs and switches the turn's share drives that the last one did not: the rooms whose port switch went from off
 * to on, or, at a start, those the journal's process did not drive. A switch that stays on is no handover, even when
 * its last change moves: Home Assistant started again.
 */
function takenOver(previous: Share, share: Share, config: Config): { bulbs: BulbId[]; switches: SwitchId[] } {
  const taken = (room: RoomId | undefined) => drives(share, room) && !drives(previous, room);
  return {
    bulbs: entriesOf(config.lamps).flatMap(([, lamp]) => taken(lamp.room) ? lamp.bulbs.map(bulb => bulb.bulb) : []),
    switches: entriesOf(config.switches).flatMap(([plug, settings]) => taken(settings.room) ? [plug] : []),
  };
}

/** The lighting state of the lamps and switches the share drives: the reconciler sends nothing to the rest. */
function sharedLighting(lighting: LightingState, config: Config, share: Share): LightingState {
  return {
    lamps: Object.fromEntries(entriesOf(lighting.lamps).filter(([lamp]) => drives(share, config.lamps[lamp]?.room))),
    switches: Object.fromEntries(entriesOf(lighting.switches).filter(([plug]) => drives(share, config.switches[plug]?.room))),
  };
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
function blockLightRead(light: BlockLight, change: LampProfileChange, write: StoreWrite, model: Model, house: HouseView, now: Instant): Msg {
  const states = blockLightSaved(house.state, light, write.text, change);
  const config = decodeConfig({ ...configSource(house), states }, house.catalog);
  return { kind: 'configChanged', config, lampProfiles: model.lampProfiles, switchProfiles: model.switchProfiles, at: now };
}

/** The config's live controls with their proxy topics, from the catalog's UI rows. */
function controlRows(model: Model, house: HouseView): ControlRow[] {
  return uiRowsOf(house.catalog).flatMap(row => {
    const control = toDashboardControlId(row.source);
    return row.store !== undefined || model.config.controls[control] === undefined ? [] : [{ control, topics: row.topics }];
  });
}
