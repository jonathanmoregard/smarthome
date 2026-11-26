/**
 * One turn of the adapter: read the input, update the Model, write back what
 * changed, compute the lighting state and reconcile the bulbs and switches to
 * it (spec 5.2). The Model lives in this process between turns; with none
 * (the process's first input) or on a start, it is read from Home Assistant.
 * The config and the profiles are read again when anything they are read from
 * shows otherwise (a helper's state, the registry's rooms or labels), and on a
 * helper change, a reconnect or a catalog change.
 */
import { dashboardView } from '../domain/dashboard.ts';
import type { DashboardView } from '../domain/dashboard.ts';
import { lightingState } from '../domain/lighting-state.ts';
import { update, nextChange } from '../domain/update.ts';
import type { Config } from '../domain/config.ts';
import type { BulbId, RoomId, SwitchId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { Instant } from '../domain/types/time.ts';
import { toDashboardControlId, toInstant, toSwitchId } from './codecs/ids.ts';
import { timestamp } from './codecs/accessors.ts';
import type { HouseView } from './codecs/house.ts';
import { ParseError } from './codecs/parse.ts';
import { bulbGroups } from './codecs/bulb-groups.ts';
import { blockLightSaved, bulbTopics, decodeConfig, reportedBulbs } from './codecs/config.ts';
import type { BlockLight, ConfigSource } from './codecs/config.ts';
import type { Catalog } from './codecs/catalog.ts';
import { configMoved, configSource, decodeModelFrom, followingSensor, overridesRead, readConfig, readsConfig } from './codecs/model.ts';
import type { ConfigFrom, OverridesRead } from './codecs/model.ts';
import { drives, portSwitchesMissing, portSwitchesOn } from './codecs/rooms.ts';
import type { Share } from './codecs/rooms.ts';
import { noPortSwitch, ownPart, shareOf } from './live-rooms.ts';
import type { RoomsGiven } from './live-rooms.ts';
import type { JournalRecord } from './codecs/journal.ts';
import { decodeRangeDefaults } from './codecs/range-defaults.ts';
import { carries, outcomeOf, publishes } from './encode.ts';
import type { Output } from './encode.ts';
import { messages, PLANTS_ALL_OFF, plantsAllOffMessages, storeSaveIn, unexplainedMessages } from './codecs/inputs.ts';
import { uiRowsOf } from './codecs/catalog.ts';
import type { HaInput, StoreSave } from './codecs/inputs.ts';
import { BRIDGE_SENSOR, decodeObserved, observedSwitch } from './codecs/observed.ts';
import type { EntityState } from './ha-client.ts';
import type { Observed } from './reconcile.ts';
import {
  afterSend, backOn, forgotten, landedLate, MAX_ATTEMPTS, NO_BELIEFS, newlyParked, newlyParkedSwitches, nextRetry, nextPlan, reportedChanged,
  supersededAfter, switchesForgotten, switchesSeen, unexplained, unparked,
} from './reconcile.ts';
import type { Beliefs, Outcome, Send, Superseded } from './reconcile.ts';
import { afterTries, awaitsEcho, dueAt, heldForStore, nextTry, outputOf, queued, settled, targetOf, unparkedWrites, withWaiting } from './outbox.ts';
import type { Entry, Outbox, Tried, Write } from './outbox.ts';
import { configStoreWrite, dashboardWrites, modelWrites, plantsAllOffWrite, uiSyncWrites } from './codecs/writes.ts';
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
  /** The config's bulbs the catalog gives no topic: sent nothing, and each named once, when first found. */
  topicless: readonly BulbId[];
  /**
   * The config is read again next turn, as on a helper change: a write was parked, and the Model follows what Home
   * Assistant holds; or the catalog changed, and the config is decoded from the new one.
   */
  reread: boolean;
  /** What the config was last read from: a turn that finds any of it changed reads the config again. */
  configFrom: ConfigFrom;
  /** Whether Home Assistant had the overrides sensor at the last turn: while it is unread, the port writes it nothing. */
  overrides: OverridesRead['kind'];
  /** The switch sends whose target moved before they landed, each still on its way for a while: its landing is no press. */
  superseded: Readonly<Record<SwitchId, Superseded>>;
};

/**
 * The Model the turn starts from, what its config was read from, and the overrides sensor's read: decoded whole at a
 * start; otherwise the kept one, its config and profiles read again on a helper change, a reconnect, a reread asked
 * for, or when anything they are read from shows otherwise than at the last read, and its overlays and ranges the
 * sensor's when it is read for the first time since it was unread. The sensor is read when Home Assistant reports it;
 * what it holds is read with the port's own writes still waiting laid over it.
 */
function modelRead(state: AdapterState | undefined, input: HaInput, house: HouseView, reported: HouseView, now: Instant):
  { model: Model; from: ConfigFrom; overrides: OverridesRead } {
  const source = configSource(house);
  const overrides: OverridesRead = overridesRead(reported.state, house.catalog).kind === 'unread' ? { kind: 'unread' } : overridesRead(house.state, house.catalog);
  if (state === undefined || input.kind === 'started') return { ...decodeModelFrom(source, house.catalog), overrides };
  const again = input.kind === 'helper changed' || input.kind === 'reconnected' || state.reread || configMoved(state.configFrom, source);
  const { model, from } = again ? reread(state.model, source, house.catalog, now) : { model: state.model, from: state.configFrom };
  return { model: overrides.kind === 'read' && state.overrides === 'unread' ? { ...model, ...overrides.overrides } : model, from, overrides };
}

/** The Model with its config and profiles read again from `source`, and what they were read from. */
function reread(model: Model, source: ConfigSource, catalog: Catalog, now: Instant): { model: Model; from: ConfigFrom } {
  const { read, from } = readConfig(source, catalog);
  return { model: update(model, { kind: 'configChanged', ...read, at: now }), from };
}

/**
 * What the adapter has before a turn: the state it kept from the last turn, or, at the process's start, only what its
 * journal held: the beliefs, so a restart sends nothing a bulb already shows, and the share they were sent under.
 */
export type Kept = { kind: 'running'; state: AdapterState } | ({ kind: 'starting' } & JournalRecord);

/** What is kept once the catalog changed: the next turn reads the config again, through `configChanged`, as a helper change does. A start reads it anyway. */
export function catalogChanged(kept: Kept): Kept {
  return kept.kind === 'running' ? { kind: 'running', state: { ...kept.state, reread: true } } : kept;
}

/** The config the kept state holds; before the first turn, the one the house reads as. */
export function keptConfig(kept: Kept, house: HouseView): Config {
  return kept.kind === 'running' ? kept.state.model.config : decodeConfig(configSource(house), house.catalog);
}

/**
 * Whether `entity` changing to `state` is a reason for a turn: the config is read from it, it is the all-off control, a
 * sensor write waits on it, or it is a switch of the config that now shows another power than the last turn saw (its
 * own button, our send landing, or its reach). A switch's change is a live input: its turn reads it against the look
 * just before, so a press is told from our send without a clock (`switchPressed`, reconcile.ts). The same power again
 * (an attribute's report, a bounce) runs no turn. Bulbs run none: their reports come at every step of a fade and the
 * candle's flicker.
 */
export function wantsTurn(kept: Kept, entity: string, state: EntityState | undefined): boolean {
  if (kept.kind !== 'running') return false;
  const { configFrom, outbox, model, observed } = kept.state, plug = toSwitchId(entity);
  return readsConfig(configFrom, entity) || entity === PLANTS_ALL_OFF
    || outbox.some(({ write }) => write.kind === 'sensor' && write.write.entity === entity)
    || (model.config.switches[plug] !== undefined && observedSwitch(state) !== observed.switches[plug]);
}

/**
 * A turn's result, before its outputs are made: the state to keep, whose beliefs are those before any send; the
 * outputs in order; each send with the outputs that carry it; the turn's clock; the lighting's next change; and why
 * the input was dropped, when it was. {@link afterOutputs} turns it into what to keep once the outputs have gone.
 */
export type Turn = {
  state: AdapterState; outputs: Output[]; sends: readonly Sending[]; now: Instant; nextChange: Instant | undefined;
  /** When the first bulb send held for the least gap between sends is due (`MIN_GAP`, reconcile.ts). */
  heldUntil: Instant | undefined;
  dropped: string | undefined;
  /** The host's error log: the input dropped, if it was, and what the turn found wrong with the house, each said once, when first found. */
  errors: readonly string[];
  /** The outputs, by their place, after which the journal is saved: each bulb's publish, so a crash loses no send. */
  journalled: readonly number[];
  /** The outbox's writes the turn makes, each with its output's place. */
  writing: readonly { entry: Entry; output: number }[];
};

/** A send and the outputs that carry it, by their place in the turn's outputs: a bulb's publishes, a switch's call. */
export type Sending = { send: Send; carriedBy: readonly number[] };

/**
 * A turn once its outputs have gone: the state to keep, when to be woken (the lighting's next change, a held bulb
 * send's due time, or a failed send's, an open switch send's or a write's retry when that comes first), the bulbs
 * given up on, each reported once, and the writes parked, each warned of once. A send settling asks for no wake of its own: the next minute's tick
 * looks again, as today's scripts did, and a wake seconds after every send would move the house's clock under the
 * harness's checkpoints.
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
    // A bulb's send no output carries (the catalog gives the bulb no topic) was never made, so nothing is believed of it.
    if (carriedBy.some(index => index >= failed.length) || (send.kind !== 'switch' && carriedBy.length === 0)) continue;
    const lost = carriedBy.flatMap(index => {
      const output = turn.outputs[index];
      return failed[index] === true && output !== undefined ? [output] : [];
    });
    beliefs = afterSend(beliefs, send, outcomeIn(send, lost), turn.now);
  }
  const wakeAt = [turn.nextChange, turn.heldUntil, nextRetry(beliefs, turn.now), nextTry(outbox, turn.now)].reduce<Instant | undefined>((first, at) =>
    at === undefined || (first !== undefined && first <= at) ? first : at, undefined);
  const parked = newlyParked(turn.state.beliefs, beliefs);
  // A bulb given up on is most often switched off at the wall: said once, for the host's info log (owner, 2026-11-20).
  const notes = [...parked.map(bulb => `lighting: ${bulb} is parked: it does not take what it is sent; left until it comes back on or its light changes`),
    ...newlyParkedSwitches(turn.state.beliefs, beliefs).map(plug =>
      `lighting: ${plug} is parked: Home Assistant did not report it switched after ${MAX_ATTEMPTS} sends; left until its target changes or Home Assistant is back`)];
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
  const { model: decoded, from: configFrom, overrides } = modelRead(state, input, house, reported, now);
  const share = shareOf(given, given.kind === 'listed' ? portSwitchesOn(house.state, given.rooms) : new Set());
  const before = followingSensor(decoded, overrides, share);
  // The clock runs first, and the input is read against what it leaves: a reset at this instant is already applied.
  const clocked = update(before, { kind: 'clock', now });
  const taken = takenOver(kept.kind === 'running' ? kept.state.share : kept.share, share, clocked.config);
  // What changed since the last turn that no send of ours explains: a plug's own button is pressed first, then the input.
  // A room handed over since was the old scripts' meanwhile, and is taken as found: a change there is theirs.
  // A switch send of ours whose target moved before it landed may land late, within its window by our clock: no press.
  // A plant light found changed at a start or when Home Assistant is back is put right, not held (spec 3.7.5): only a
  // change seen while the port runs is its own button. A lighting switch's stays a press, as today.
  const seen = decodeObserved(house.state, clocked.config);
  const lookedAfresh = input.kind === 'started' || input.kind === 'reconnected';
  const changed = state === undefined ? [] : unexplained(state.observed, seen, state.beliefs)
    .filter(change => change.kind === 'switch pressed'
      ? !taken.switches.includes(change.switch) && !landedLate(state.superseded[change.switch], change.power, now)
        && !(lookedAfresh && clocked.config.switches[change.switch]?.kind === 'plant light')
      : !taken.bulbs.includes(change.bulb));
  let inputMessages: Msg[] = [], dropped: string | undefined, saved: StoreSave | undefined;
  try {
    inputMessages = [...messages(input, clocked, now, house), ...rangeDefaultsMessages(input, house, now)];
    saved = storeSaveIn(input, house, clocked);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    dropped = `${input.kind}: ${error.message}`;
  }
  // The all-off control, read against the Model before the clock: a hold the clock releases this turn, whose off to the
  // control is still to be written, is not read as a new on. Read whether the input read or was dropped.
  const allOffRead = plantsAllOffMessages(house, before.plantOverrides.allOff !== undefined, clocked.config, now);
  // The turn's messages are its share's parts of the input's, the presses' and the control's alike, whether the input
  // read or was dropped.
  const own = [...unexplainedMessages(changed, now), ...allOffRead, ...inputMessages].flatMap(msg => {
    const part = ownPart(share, msg, clocked.config);
    return part === undefined ? [] : [part];
  });
  // A block light's save is written as it is, and goes through `update` as the config the helpers will hold once it
  // lands, so the lamps move in this turn and not on the echo.
  const light = saved?.target.kind === 'block light' && drives(share, saved.target.scope === 'house' ? undefined : saved.target.scope)
    ? saved.target : undefined;
  const configWrite = saved === undefined || light === undefined ? undefined : configStoreWrite(light, saved.change, house);
  const messaged = own.reduce(update, clocked);
  const model = saved === undefined || light === undefined || configWrite === undefined ? messaged
    : update(messaged, blockLightRead(light, saved.change, configWrite, messaged, house, now));
  const writes: Write[] = [];
  const lighting = lightingState(model, now);
  const view = dashboardView(model, lighting, now);
  const written = modelWrites(before, model, house, reported, now, share, view.plantSwitchOff);
  // An unread sensor is not an empty one: no write of it, which would delete what Home Assistant has yet to load.
  if (written.sensor !== undefined && overrides.kind === 'read') writes.push({ kind: 'sensor', write: written.sensor });
  for (const write of written.helpers) writes.push({ kind: 'helper', write });
  for (const write of written.stores) writes.push({ kind: 'store', write });
  if (configWrite !== undefined) writes.push({ kind: 'store', write: configWrite });

  const previous = state === undefined || input.kind === 'started' ? undefined : state.view;
  const sync = controlRows(model, house);
  // The dashboard is the old scripts' to show while some room is still theirs.
  if (share.kind === 'house') {
    for (const write of dashboardWrites(previous, view, sync, house)) writes.push({ kind: 'dashboard', write });
    for (const write of uiSyncWrites(house, previous === undefined)) writes.push({ kind: 'dashboard', write });
  }
  // The all-off control is the port's to mirror whatever the share: the old scripts do not know it.
  const allOffWrite = plantsAllOffWrite(view, house);
  if (allOffWrite !== undefined) writes.push({ kind: 'dashboard', write: allOffWrite });
  const { outbox, held } = heldForStore(queued(waiting, writes, now), reported, now), due = dueAt(outbox, now)
    .filter(entry => !awaitsEcho(entry, reported, share) && (entry.write.kind !== 'sensor' || overrides.kind === 'read'));
  const outputs: Output[] = due.map(entry => outputOf(entry, reported, share));
  const writing = due.map((entry, output) => ({ entry, output }));

  let beliefs = kept.kind === 'running' ? kept.state.beliefs : kept.beliefs;
  // Home Assistant back, or a start, unparks: a park the journal kept does not outlive a restart.
  if (input.kind === 'reconnected' || input.kind === 'started') beliefs = unparked(beliefs);
  // What the port sent a room before it was handed over says nothing: the old scripts drove it meanwhile.
  beliefs = switchesForgotten(forgotten(beliefs, taken.bulbs), taken.switches);
  const observed = decodeObserved(house.state, model.config);
  if (input.kind === 'state changed') {
    const reported = reportedBulbs(input.entities, model.config);
    beliefs = state === undefined ? forgotten(beliefs, reported) : reportedChanged(beliefs, state.observed, observed, reported);
  }
  // A bulb's own announce is its power-up, which a report from on to on hides: back on, parked or not (closeout r2 A3).
  beliefs = backOn(beliefs, [...changed.flatMap(change => change.kind === 'bulb back on' ? [change.bulb] : []),
    ...input.kind === 'bulb announced' ? [input.bulb] : []]);
  const superseded = supersededAfter(state === undefined ? {} : state.superseded, beliefs, observed, lighting.switches, now);
  beliefs = switchesSeen(beliefs, observed, lighting.switches);
  const { sends, heldUntil } = nextPlan(sharedLighting(lighting, model.config, share), model.config, observed, beliefs, now);
  const topics = bulbTopics(house.catalog), groups = bulbGroups(house.catalog);
  const topicless = entriesOf(model.config.lamps).flatMap(([, lamp]) => lamp.bulbs.flatMap(({ bulb }) => topics[bulb] === undefined ? [bulb] : []));
  const errors = [
    ...dropped === undefined ? [] : [`lighting: ${input.kind}: ${dropped}; dropped`],
    ...state?.observed.bridge !== 'unknown' && observed.bridge === 'unknown'
      ? [`lighting: Home Assistant has no ${BRIDGE_SENSOR}; Zigbee2MQTT's connection is unknown, and the bulbs are sent as if it were up`] : [],
    ...topicless.filter(bulb => state?.topicless.includes(bulb) !== true).map(bulb => `lighting: the catalog gives ${bulb} no topic; it is sent nothing`),
    // Found when the last turn's Model held no such setting for it: at the first turn, a relabel, or the sensor's first read.
    ...plantLightsWithLightingSettings(model).filter(plug => state === undefined || !plantLightsWithLightingSettings(state.model).includes(plug))
      .map(plug => `lighting: ${plug} is a plant light; its saved range rule or switch overlay is ignored`),
    ...held.map(entry => `lighting: Home Assistant has no ${targetOf(entry.write)}; the write to it waits until it does`),
    // A start refuses such a room (src/main.ts); a host started over one says it once, at its start.
    ...given.kind === 'listed' && (state === undefined || input.kind === 'started') && portSwitchesMissing(house.state, given.rooms).length > 0
      ? [`lighting: ${noPortSwitch(portSwitchesMissing(house.state, given.rooms))}`] : [],
  ];
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
  const next: AdapterState = { model, beliefs, view, observed, outbox, reread: false, share, topicless, configFrom, overrides: overrides.kind, superseded };
  return { state: next, outputs, sends: sending, now, nextChange: nextChange(model, now), heldUntil, dropped, errors, journalled, writing };
}

/** The plant lights the Model holds a range rule or a lighting switch overlay for: both ignored, one kind per plug (spec 3.7.4). */
function plantLightsWithLightingSettings(model: Model): SwitchId[] {
  return entriesOf(model.config.switches).flatMap(([plug, placed]) => placed.kind === 'plant light'
    && (model.switchRanges[plug] !== undefined || model.overlays.switches[plug] !== undefined) ? [plug] : []);
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

/** The lighting state of the lamps and switches the share drives: the reconciler sends nothing to the rest. */
function sharedLighting(lighting: LightingState, config: Config, share: Share): LightingState {
  return {
    lamps: Object.fromEntries(entriesOf(lighting.lamps).filter(([lamp]) => drives(share, config.lamps[lamp]?.room))),
    switches: Object.fromEntries(entriesOf(lighting.switches).filter(([plug]) => drives(share, config.switches[plug]?.room))),
  };
}
