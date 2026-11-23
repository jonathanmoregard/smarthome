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
import type { SwitchId } from '../domain/types/ids.ts';
import { entriesOf } from '../domain/types/ids.ts';
import type { Power } from '../domain/types/light.ts';
import type { Instant } from '../domain/types/time.ts';
import { percentRangeOf, toDashboardControlId, toInstant } from '../parse/ids.ts';
import { timestamp } from '../parse/accessors.ts';
import type { HouseView } from '../runtime/effects.ts';
import { ParseError } from '../runtime/parse.ts';
import { bulbGroups } from './bulb-groups.ts';
import { bulbTopics } from './codecs/config.ts';
import { configSource, decodeModel } from './codecs/model.ts';
import { publishes } from './encode.ts';
import type { Publish } from './encode.ts';
import { controlOver, messages, profileStoreOf, storeSaveIn, uiRowsOf } from './inputs.ts';
import type { HaInput } from './inputs.ts';
import { decodeObserved } from './observed.ts';
import { afterSend, forgotten, NO_BELIEFS, nextSends } from './reconcile.ts';
import type { Beliefs } from './reconcile.ts';
import { configStoreWrite, dashboardWrites, modelWrites, uiSyncWrites } from './writes.ts';
import type { ControlRow, DashboardWrite, HelperWrite, SensorWrite, StoreWrite } from './writes.ts';

/** What the adapter keeps between turns: the Model, what each bulb and switch was sent, and the dashboard last shown. */
export type AdapterState = { model: Model; beliefs: Beliefs; view: DashboardView | undefined };

export type Output =
  | { kind: 'publish'; publish: Publish }
  | { kind: 'switch'; switch: SwitchId; power: Power }
  | { kind: 'sensor'; write: SensorWrite }
  | { kind: 'helper'; write: HelperWrite }
  | { kind: 'store'; write: StoreWrite }
  | { kind: 'dashboard'; write: DashboardWrite };

/**
 * A turn's result: the state to keep, the outputs in order, when to be woken
 * (the lighting's next change), and why the input was dropped, when it was. A
 * send settling asks for no wake of its own: the next minute's tick looks
 * again, as today's scripts did, and a wake seconds after every send would
 * move the house's clock under the harness's checkpoints.
 */
export type Turn = { state: AdapterState; outputs: Output[]; wakeAt: Instant | undefined; dropped: string | undefined };

/**
 * One turn: read, update, write back what changed, compute the lighting state,
 * reconcile. Pure but for the house it is handed, whose `now` is the clock.
 * Every input applies the clock first, then its own messages, in order. An
 * input that cannot be read is dropped, and the turn goes on with the clock.
 */
export function handleInput(state: AdapterState | undefined, house: HouseView, input: HaInput): Turn {
  const now = toInstant(timestamp(house.now));
  const before = state === undefined || input.kind === 'started' ? decodeModel(configSource(house), house.catalog)
    : input.kind === 'helper changed' ? update(state.model, helpersRead(house, now)) : state.model;
  // The clock runs first, and the input is read against what it leaves: a reset at this instant is already applied.
  const clocked = update(before, { kind: 'clock', now });
  let own: Msg[] = [], dropped: string | undefined;
  try {
    own = [...messages(input, clocked, now, house), ...rangeDefaultsMessages(input, house, now)];
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    dropped = `${input.kind}: ${error.message}`;
  }
  const model = own.reduce(update, clocked);
  const outputs: Output[] = [];
  const written = modelWrites(before, model, house, now);
  if (written.sensor !== undefined) outputs.push({ kind: 'sensor', write: written.sensor });
  for (const write of written.helpers) outputs.push({ kind: 'helper', write });
  for (const write of written.stores) outputs.push({ kind: 'store', write });
  const save = dropped === undefined ? storeSaveIn(input, house) : undefined;
  if (save !== undefined && profileStoreOf(save.store, model) === undefined) outputs.push({ kind: 'store', write: configStoreWrite(save, house) });

  const lighting = lightingState(model, now);
  const rows = controlRows(model, house);
  const view = dashboardView(model, lighting, now, rows.map(row => row.control));
  const previous = state === undefined || input.kind === 'started' ? undefined : state.view;
  const sync: ControlRow[] = rows.map(row => ({ control: row.control.control, topics: row.topics }));
  for (const write of dashboardWrites(previous, view, sync, house)) outputs.push({ kind: 'dashboard', write });
  for (const write of uiSyncWrites(house, previous === undefined)) outputs.push({ kind: 'dashboard', write });

  let beliefs = state === undefined ? NO_BELIEFS : state.beliefs;
  if (input.kind === 'state changed') {
    beliefs = forgotten(beliefs, entriesOf(model.config.lamps).flatMap(([lamp, { bulbs }]) =>
      bulbs.flatMap(({ bulb }) => input.entities.includes(lamp) || input.entities.includes(bulb) ? [bulb] : [])));
  }
  const reconciled = nextSends(lighting, model.config, decodeObserved(house.state, model.config), beliefs, now);
  for (const publish of publishes(reconciled.sends, bulbTopics(house.catalog), bulbGroups(house.catalog))) outputs.push({ kind: 'publish', publish });
  for (const send of reconciled.sends) {
    if (send.kind === 'switch') outputs.push({ kind: 'switch', switch: send.switch, power: send.power });
    beliefs = afterSend(beliefs, send, 'sent', now);
  }
  return { state: { model, beliefs, view }, outputs, wakeAt: nextChange(model, now), dropped };
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
  const range = (profile: 'bright' | 'cosy') => {
    const end = (bound: 'min' | 'max') => {
      const helper = house.state[`input_number.ls_range_${profile}_${bound}`];
      return helper === undefined ? undefined : Number(helper.state);
    };
    return percentRangeOf(end('min'), end('max'));
  };
  const bright = range('bright'), cosy = range('cosy');
  return bright === undefined || cosy === undefined ? [] : [{ kind: 'rangeDefaultsSaved', defaults: { bright, cosy }, at: now }];
}

/** The catalog's live controls (the UI rows with no profile store) the Model has a lamp or room for, with their proxy topics. */
function controlRows(model: Model, house: HouseView): Array<{ control: DashboardControl; topics: ControlRow['topics'] }> {
  return uiRowsOf(house).flatMap(row => {
    if (row.store !== undefined) return [];
    const over = controlOver(row, model);
    return over === undefined ? [] : [{ control: { control: toDashboardControlId(row.source), over }, topics: row.topics }];
  });
}
