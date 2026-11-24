/**
 * The host, a minimal wrapper with no lighting rule: it mirrors Home Assistant's states and registry, runs one turn at a
 * time, makes each turn's calls in order (each one's outcome back to the adapter, the journal saved where the turn says),
 * pauses while Home Assistant is out of reach, holding inputs until it is back, and keeps one timer for the wake.
 */
import type { Catalog } from './adapter/codecs/catalog.ts';
import type { HouseMirror } from './adapter/codecs/house.ts';
import { afterOutput, houseView, mergedRead, withState } from './adapter/codecs/house.ts';
import { loadJournal, saveJournal } from './adapter/codecs/journal.ts';
import type { JournalRecord } from './adapter/codecs/journal.ts';
import { outputCall } from './adapter/encode.ts';
import { bounded, Unanswered, Unreachable } from './adapter/ha-client.ts';
import type { BoundedClient, EntityState, HaClient, JsonObject } from './adapter/ha-client.ts';
import { bridgeVerdict } from './adapter/codecs/inputs.ts';
import type { HaInput } from './adapter/codecs/inputs.ts';
import { afterOutputs, catalogChanged, handleInput, keptConfig, wantsTurn } from './adapter/loop.ts';
import type { Kept } from './adapter/loop.ts';
import { beatRooms } from './adapter/live-rooms.ts';
import type { LiveRooms, RoomsGiven } from './adapter/live-rooms.ts';
import type { Instant } from './domain/types/time.ts';
import { toInstant } from './adapter/codecs/ids.ts';

/** Where the reconciler's beliefs are kept across a restart: the journal's text, none before the first save. */
export type Journal = { load(): Promise<string | undefined>; save(text: string): Promise<void> };

export type Log = { info(message: string): void; warn(message: string): void; error(message: string): void };

/** A timer: `wake` runs after `delayMs`, unless the answer is called first. */
export type Timer = (delayMs: number, wake: () => void) => () => void;

/** `rooms` are those the host may drive; `took`, if given, hears how long each turn with outputs took to make them, in seconds. */
export type HostIo = {
  ha: HaClient; journal: Journal; clock: () => Instant; log: Log; timer: Timer; rooms: RoomsGiven; took?: (seconds: number) => void;
};

/** The longest a timer waits: Node's limit, about 24 days. A wake further away is set again when this one runs. */
const LONGEST_WAIT_MS = 2_147_483_647;
/** How many of our calls' context ids are kept to know their echoes by. */
const OWN_CONTEXTS = 1024;
/** How soon a turn that threw is followed by a wake. */
const AFTER_A_FAILED_TURN_SECONDS = 5;
/** The turns in a row that throw or whose every call is refused, or the calls in a row unanswered, before the heartbeat stops and the watchdog hands the rooms back. */
const UNHEALTHY_AFTER = 3;

export class Host {
  private readonly io: HostIo; private readonly ha: BoundedClient; private mirror: HouseMirror; private catalog: Catalog; private kept: Kept;
  private queue: Promise<void> = Promise.resolve(); private cancelWake: (() => void) | undefined; private closed = false;
  /** The context ids of our recent calls, the turns run so far, the last one with a failed call, and whether one is calling. */
  private ownContexts: string[] = [];
  private turns = 0; private failedTurn = -1; private calling = false; private thrownInARow = 0; private refusedInARow = 0;
  /** Whether Home Assistant is in reach: while it is not, nothing is sent, no wake runs, and inputs are held. */
  private connected = true; private held: HaInput[] = [];
  /** The journal's text as last loaded or saved, so a turn that leaves it as it is saves nothing. */
  private saved: string | undefined;

  private constructor(io: HostIo, mirror: HouseMirror, catalog: Catalog, saved: string | undefined) {
    this.io = io; this.mirror = mirror; this.catalog = catalog; this.saved = saved; this.kept = { kind: 'starting', ...loadJournal(saved) };
    this.ha = bounded(io.ha, message => io.log.warn(message));
  }

  /** A host over the house as Home Assistant shows it, holding the beliefs its journal kept. */
  static async open(io: HostIo, mirror: HouseMirror, catalog: Catalog): Promise<Host> {
    return new Host(io, structuredClone(mirror), catalog, await io.journal.load());
  }

  /**
   * A script or automation run Home Assistant's bridge forwards: an input, or logged and dropped. It waits its turn,
   * so the echo of a call still being made is known for ours once that call is answered; one that came while a call
   * failed cannot be told from a person's, and is dropped.
   */
  script(name: string, args: JsonObject): void {
    const during = this.calling ? this.turns : undefined;
    this.enqueue(async () => {
      const own = { contexts: this.ownContexts, callFailed: during !== undefined && this.failedTurn === during };
      const verdict = bridgeVerdict(name, args, this.catalog, own);
      if (verdict.kind === 'dropped') this.io.log.error(`lighting: ${verdict.why}; dropped`);
      else if (verdict.kind === 'input') await this.turn(verdict.input);
    });
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(step).catch(this.report);
  }

  private readonly report = (error: unknown): void => this.io.log.error(`lighting: ${error instanceof Error ? error.message : String(error)}`);

  private async turn(input: HaInput): Promise<void> {
    if (!this.connected && input.kind !== 'wake' && input.kind !== 'tick') this.held.push(input);
    if (this.closed || !this.connected) return;
    const now = this.io.clock();
    // A turn that throws still sets a wake, a little later, so the timer that started it is not the last one.
    let wakeAt: Instant | undefined = toInstant(now + AFTER_A_FAILED_TURN_SECONDS);
    try {
      wakeAt = await this.run(input, now);
      this.thrownInARow = 0;
    } catch (error) {
      if (++this.thrownInARow === UNHEALTHY_AFTER) this.io.log.error(`lighting: ${UNHEALTHY_AFTER} turns in a row failed; the heartbeat stops until a turn succeeds`);
      throw error;
    } finally {
      this.cancelWake?.();
      this.cancelWake = wakeAt === undefined || this.closed || !this.connected ? undefined
        : this.io.timer(Math.min(LONGEST_WAIT_MS, Math.max(0, Math.round((wakeAt - now) * 1000))), () => this.accept({ kind: 'wake' }));
    }
  }

  /** One turn: its outputs made one at a time; the answer is when to be woken. */
  private async run(input: HaInput, now: Instant): Promise<Instant | undefined> {
    const turn = handleInput(this.kept, houseView(this.mirror, now, this.catalog), input, this.io.rooms);
    for (const error of turn.errors) this.io.log.error(error);
    const failed: boolean[] = [], started = performance.now(); this.turns++; this.calling = true;
    for (const [index, output] of turn.outputs.entries()) {
      const call = outputCall(output, turn.now);
      if (!this.connected) break;
      try {
        const context = await this.ha.call(call);
        if (context !== undefined) this.ownContexts = [...this.ownContexts, context].slice(-OWN_CONTEXTS);
        this.mirror = { ...this.mirror, state: afterOutput(this.mirror.state, output, this.io.clock()) };
        failed.push(false);
      } catch (error) {
        // Out of reach is no failure of the bulb or helper: the call, and the turn's later ones, count as not made.
        if (error instanceof Unreachable) { this.disconnected(); break; }
        this.io.log.error(`lighting: ${call.service} failed: ${error instanceof Error ? error.message : String(error)}`);
        failed.push(true); this.failedTurn = this.turns;
        if (error instanceof Unanswered && this.ha.unansweredInARow() === UNHEALTHY_AFTER) this.io.log.error(`lighting: Home Assistant answered none of ${UNHEALTHY_AFTER} calls in a row; the heartbeat stops until it answers one`);
      }
      if (turn.journalled.includes(index)) await this.save(afterOutputs(turn, failed).state);
    }
    this.calling = false;
    if (failed.includes(false)) this.refusedInARow = 0;
    else if (failed.length > 0 && failed.length === turn.outputs.length && ++this.refusedInARow === UNHEALTHY_AFTER)
      this.io.log.error(`lighting: Home Assistant refused every call of ${UNHEALTHY_AFTER} turns in a row; the heartbeat stops until it takes one`);
    const settled = afterOutputs(turn, failed);
    this.kept = { kind: 'running', state: settled.state };
    // Each publish saved the journal; any other change of the beliefs or the share is saved once the turn is done.
    if (saveJournal(settled.state) !== this.saved) await this.save(settled.state);
    for (const note of settled.notes) this.io.log.info(note);
    for (const warning of settled.warnings) this.io.log.warn(warning);
    if (turn.outputs.length > 0 && this.connected) this.io.took?.((performance.now() - started) / 1000);
    return settled.wakeAt;
  }

  /** Home Assistant went out of reach: sends and wakes pause until {@link reconnected}. */
  disconnected(): void {
    if (!this.connected) return;
    this.connected = false; this.cancelWake?.(); this.cancelWake = undefined;
    this.io.log.warn('lighting: Home Assistant is out of reach; sends and wakes are paused until it is back');
  }

  private async save(record: JournalRecord): Promise<void> {
    const text = saveJournal(record);
    await this.io.journal.save(text).then(() => { this.saved = text; }, (error: unknown) => this.report(`journal not saved: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Queue an input; inputs run one at a time, in order. */
  accept(input: HaInput): void { this.enqueue(() => this.turn(input)); }

  /** A state Home Assistant reports changed, or removed, in order with the inputs; one a turn waits on runs a turn. */
  stateChanged(entity: string, state: EntityState | undefined): void {
    this.enqueue(async () => { this.mirror = { ...this.mirror, state: withState(this.mirror.state, entity, state) }; });
    this.enqueue(async () => { if (wantsTurn(this.kept, entity)) await this.turn({ kind: 'wake' }); });
  }

  /**
   * Home Assistant's states and registry read again whole, after a reconnect or a registry change, from a read that
   * started at `startedAt`: a state that changed since (an event, or a write of ours) is kept over the read's.
   */
  houseRead(mirror: HouseMirror, startedAt: Instant): void {
    this.enqueue(async () => { this.mirror = mergedRead(this.mirror, structuredClone(mirror), startedAt); });
  }

  /** Home Assistant is back, or started again, its house read afresh from `startedAt`: reconciled anew, then held inputs run. */
  reconnected(mirror: HouseMirror, startedAt: Instant): void {
    this.enqueue(async () => {
      this.mirror = mergedRead(this.mirror, structuredClone(mirror), startedAt);
      if (!this.connected) this.io.log.warn('lighting: Home Assistant is back; every bulb is reconciled again');
      this.connected = true;
      await this.turn({ kind: 'reconnected' });
      // Each held input on its own, as when it was its own step: one that throws is logged, and the rest still run.
      for (const input of this.held.splice(0)) await this.turn(input).catch(this.report);
    });
  }

  /** Whether the heartbeat is paused: Home Assistant is out of reach or not yet read again, the last turns all threw or were refused, or the last calls went unanswered. */
  paused(): boolean { return !this.connected || [this.thrownInARow, this.refusedInARow, this.ha.unansweredInARow()].some(count => count >= UNHEALTHY_AFTER); }

  /** The rooms the heartbeat names now: those given, or the rooms of the current config's lamps. */
  liveRooms(): LiveRooms { return beatRooms(this.io.rooms, keptConfig(this.kept, houseView(this.mirror, this.io.clock(), this.catalog))); }

  /** The house as the host holds it now. */
  house(): HouseMirror { return this.mirror; }

  /** A new catalog; the next turn reads it, and the config decoded from it. */
  catalogChanged(catalog: Catalog): void { this.enqueue(async () => { this.catalog = catalog; this.kept = catalogChanged(this.kept); }); }

  /** Settles once every input has run, those accepted while waiting included. */
  async idle(): Promise<void> { for (let current = this.queue; ; current = this.queue) { await current; if (current === this.queue) return; } }

  async close(): Promise<void> { this.closed = true; this.cancelWake?.(); await this.queue; }
}
