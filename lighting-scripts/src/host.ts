/**
 * The host, a minimal wrapper with no lighting rule: it mirrors Home Assistant's states and registry, runs one turn
 * at a time, makes each turn's calls in order (each one's outcome back to the adapter, the journal saved where the
 * turn says), pauses while Home Assistant is out of reach, and keeps one timer for the wake. The rest is the adapter's.
 */
import type { Catalog } from './adapter/codecs/catalog.ts';
import type { HouseMirror } from './adapter/codecs/house.ts';
import { afterCall, houseView, mergedRead } from './adapter/codecs/house.ts';
import { loadBeliefs, saveBeliefs } from './adapter/codecs/journal.ts';
import { outputCall, timingCall } from './adapter/encode.ts';
import { Unreachable } from './adapter/ha-client.ts';
import type { EntityState, HaClient, JsonObject } from './adapter/ha-client.ts';
import { echoContext, mayBeEcho, scriptInput } from './adapter/codecs/inputs.ts';
import type { HaInput } from './adapter/codecs/inputs.ts';
import { afterOutputs, handleInput } from './adapter/loop.ts';
import type { Kept } from './adapter/loop.ts';
import type { Instant } from './domain/types/time.ts';
import { toInstant } from './adapter/codecs/ids.ts';

/** Where the reconciler's beliefs are kept across a restart: the journal's text, none before the first save. */
export interface Journal {
  load(): Promise<string | undefined>;
  save(text: string): Promise<void>;
}

export type Log = { info(message: string): void; warn(message: string): void; error(message: string): void };

/** A timer: `wake` runs after `delayMs`, unless the answer is called first. */
export type Timer = (delayMs: number, wake: () => void) => () => void;

export type HostIo = { ha: HaClient; journal: Journal; clock: () => Instant; log: Log; timer: Timer };

/** The longest a timer waits: Node's limit, about 24 days. A wake further away is set again when this one runs. */
const LONGEST_WAIT_MS = 2_147_483_647;
/** How many of our calls' context ids are kept to know their echoes by. */
const OWN_CONTEXTS = 1024;
/** How soon a turn that threw is followed by a wake. */
const AFTER_A_FAILED_TURN_SECONDS = 5;

export class Host {
  private readonly io: HostIo;
  private mirror: HouseMirror;
  private catalog: Catalog;
  private kept: Kept;
  private queue: Promise<void> = Promise.resolve();
  private cancelWake: (() => void) | undefined;
  private closed = false;
  /** The context ids of our recent calls, the turns run so far, the last one with a failed call, and whether one is calling. */
  private ownContexts: string[] = [];
  private turns = 0;
  private failedTurn = -1;
  private calling = false;
  /** Whether Home Assistant is in reach: while it is not, nothing is sent and no wake runs. */
  private connected = true;

  private constructor(io: HostIo, mirror: HouseMirror, catalog: Catalog, kept: Kept) {
    this.io = io; this.mirror = mirror; this.catalog = catalog; this.kept = kept;
  }

  /** A host over the house as Home Assistant shows it, holding the beliefs its journal kept. */
  static async open(io: HostIo, mirror: HouseMirror, catalog: Catalog): Promise<Host> {
    return new Host(io, structuredClone(mirror), catalog, { kind: 'starting', beliefs: loadBeliefs(await io.journal.load()) });
  }

  /**
   * A script or automation run Home Assistant's bridge forwards: an input, or logged and dropped. It waits its turn,
   * so the echo of a call still being made is known for ours once that call is answered; one that came while a call
   * failed cannot be told from a person's, and is dropped.
   */
  script(name: string, args: JsonObject): void {
    const during = this.calling ? this.turns : undefined;
    this.enqueue(async () => {
      if (mayBeEcho(name)) {
        if (during !== undefined && this.failedTurn === during) return this.io.log.error(`lighting: ${name} came as a call failed; dropped`);
        const context = echoContext(args);
        if (context !== undefined && this.ownContexts.includes(context)) return;
      }
      const input = scriptInput(name, args, this.catalog.remotes);
      if (input === 'dry run') this.io.log.error(`lighting: ${name} is a dry run; dropped`);
      else if (input === 'not ours') this.io.log.error(`lighting: ${name} is not an input; dropped`);
      else await this.turn(input);
    });
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(step).catch(error => this.io.log.error(`lighting: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async turn(input: HaInput): Promise<void> {
    if (this.closed || !this.connected) return;
    const now = this.io.clock();
    // A turn that throws still sets a wake, a little later, so the timer that started it is not the last one.
    let wakeAt: Instant | undefined = toInstant(now + AFTER_A_FAILED_TURN_SECONDS);
    try {
      wakeAt = await this.run(input, now);
    } finally {
      this.cancelWake?.();
      this.cancelWake = wakeAt === undefined || this.closed || !this.connected ? undefined
        : this.io.timer(Math.min(LONGEST_WAIT_MS, Math.max(0, Math.round((wakeAt - now) * 1000))), () => this.accept({ kind: 'wake' }));
    }
  }

  /** One turn: its outputs made one at a time; the answer is when to be woken. */
  private async run(input: HaInput, now: Instant): Promise<Instant | undefined> {
    const turn = handleInput(this.kept, houseView(this.mirror, now, this.catalog), input);
    if (turn.dropped !== undefined) this.io.log.error(`lighting: ${input.kind}: ${turn.dropped}; dropped`);
    const failed: boolean[] = [];
    const started = performance.now();
    this.turns++; this.calling = true;
    for (const [index, output] of turn.outputs.entries()) {
      const call = outputCall(output, turn.now);
      if (!this.connected) break;
      try {
        const context = await this.io.ha.call(call);
        if (context !== undefined) this.ownContexts = [...this.ownContexts, context].slice(-OWN_CONTEXTS);
        this.mirror = { ...this.mirror, state: afterCall(this.mirror.state, call, now) };
        failed.push(false);
      } catch (error) {
        // Out of reach is no failure of the bulb or helper: the call, and the turn's later ones, count as not made.
        if (error instanceof Unreachable) { this.disconnected(); break; }
        this.io.log.error(`lighting: ${call.service} failed: ${error instanceof Error ? error.message : String(error)}`);
        failed.push(true); this.failedTurn = this.turns;
      }
      if (turn.journalled.includes(index)) await this.save(afterOutputs(turn, failed).state.beliefs);
    }
    this.calling = false;
    const settled = afterOutputs(turn, failed);
    this.kept = { kind: 'running', state: settled.state };
    for (const note of settled.notes) this.io.log.info(note);
    if (turn.outputs.length > 0 && this.connected) await this.io.ha.call(timingCall((performance.now() - started) / 1000)).catch(() => undefined);
    return settled.wakeAt;
  }

  /** Home Assistant went out of reach: sends and wakes pause until {@link reconnected}. */
  disconnected(): void {
    if (!this.connected) return;
    this.connected = false; this.cancelWake?.(); this.cancelWake = undefined;
    this.io.log.warn('lighting: Home Assistant is out of reach; sends and wakes are paused until it is back');
  }

  private async save(beliefs: Parameters<typeof saveBeliefs>[0]): Promise<void> {
    await this.io.journal.save(saveBeliefs(beliefs)).catch(error =>
      this.io.log.error(`lighting: journal not saved: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Queue an input; inputs run one at a time, in order. */
  accept(input: HaInput): void {
    this.enqueue(() => this.turn(input));
  }

  /** A state Home Assistant reports changed, or removed; it lands in order with the inputs. */
  stateChanged(entity: string, state: EntityState | undefined): void {
    this.enqueue(async () => {
      const next = { ...this.mirror.state };
      if (state === undefined) delete next[entity]; else next[entity] = state;
      this.mirror = { ...this.mirror, state: next };
    });
  }

  /**
   * Home Assistant's states and registry read again whole, after a reconnect or a registry change, from a read that
   * started at `startedAt`: a state that changed since (an event, or a write of ours) is kept over the read's.
   */
  houseRead(mirror: HouseMirror, startedAt: Instant): void {
    this.enqueue(async () => { this.mirror = mergedRead(this.mirror, structuredClone(mirror), startedAt); });
  }

  /** Home Assistant is back, or started again, with its house read afresh from `startedAt`: reconciled anew. */
  reconnected(mirror: HouseMirror, startedAt: Instant): void {
    this.enqueue(async () => {
      this.mirror = mergedRead(this.mirror, structuredClone(mirror), startedAt);
      if (!this.connected) this.io.log.warn('lighting: Home Assistant is back; every bulb is reconciled again');
      this.connected = true;
      await this.turn({ kind: 'reconnected' });
    });
  }

  /** The house as the host holds it now. */
  house(): HouseMirror { return this.mirror; }

  /** A new catalog; the next turn reads it. */
  catalogChanged(catalog: Catalog): void {
    this.enqueue(async () => { this.catalog = catalog; });
  }

  /** Settles once every input has run, those accepted while waiting included. */
  async idle(): Promise<void> {
    for (let current = this.queue; ; current = this.queue) {
      await current;
      if (current === this.queue) return;
    }
  }

  async close(): Promise<void> {
    this.closed = true; this.cancelWake?.();
    await this.queue;
  }
}
