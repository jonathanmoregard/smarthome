/**
 * The host: a minimal wrapper that holds no lighting rule. It keeps Home
 * Assistant's states and registry as a mirror, runs one turn of the adapter
 * at a time for each input, makes the turn's calls one at a time (reporting
 * each one's failure back to the adapter and saving the journal after each
 * bulb send), shows how long the sends took, and keeps one timer for the
 * turn's wake time. What to send, and when, is the adapter's.
 */
import type { Catalog } from './adapter/codecs/catalog.ts';
import type { HouseMirror } from './adapter/codecs/house.ts';
import { afterCall, houseView, mergedRead } from './adapter/codecs/house.ts';
import { loadBeliefs, saveBeliefs } from './adapter/codecs/journal.ts';
import { outputCall, timingCall } from './adapter/encode.ts';
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

export type Log = { info(message: string): void; error(message: string): void };

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
    if (this.closed) return;
    const now = this.io.clock();
    // A turn that throws still sets a wake, a little later, so the timer that started it is not the last one.
    let wakeAt: Instant | undefined = toInstant(now + AFTER_A_FAILED_TURN_SECONDS);
    try {
      wakeAt = await this.run(input, now);
    } finally {
      this.cancelWake?.();
      this.cancelWake = wakeAt === undefined || this.closed ? undefined
        : this.io.timer(Math.min(LONGEST_WAIT_MS, Math.max(0, Math.round((wakeAt - now) * 1000))), () => this.accept({ kind: 'wake' }));
    }
  }

  /** One turn: its outputs made one at a time; the answer is when to be woken. */
  private async run(input: HaInput, now: Instant): Promise<Instant | undefined> {
    const nowText = new Date(now * 1000).toISOString();
    const turn = handleInput(this.kept, houseView(this.mirror, nowText, this.catalog), input);
    if (turn.dropped !== undefined) this.io.log.error(`lighting: ${input.kind}: ${turn.dropped}; dropped`);
    const failed: boolean[] = [];
    const started = performance.now();
    this.turns++; this.calling = true;
    for (const output of turn.outputs) {
      const call = outputCall(output, turn.now);
      try {
        const context = await this.io.ha.call(call);
        if (context !== undefined) this.ownContexts = [...this.ownContexts, context].slice(-OWN_CONTEXTS);
        this.mirror = { ...this.mirror, state: afterCall(this.mirror.state, call, nowText) };
        failed.push(false);
      } catch (error) {
        this.io.log.error(`lighting: ${call.service} failed: ${error instanceof Error ? error.message : String(error)}`);
        failed.push(true); this.failedTurn = this.turns;
      }
      if (output.kind === 'publish') await this.save(afterOutputs(turn, failed).state.beliefs);
    }
    this.calling = false;
    const settled = afterOutputs(turn, failed);
    this.kept = { kind: 'running', state: settled.state };
    // A bulb given up on is most often switched off at the wall: logged once, at info level (owner, 2026-11-20).
    for (const bulb of settled.parked) {
      this.io.log.info(`lighting: ${bulb} is parked: it does not take what it is sent; left until it comes back on or its light changes`);
    }
    if (turn.outputs.length > 0) await this.io.ha.call(timingCall((performance.now() - started) / 1000)).catch(() => undefined);
    return settled.wakeAt;
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

  /** The house as the host holds it now. */
  house(): HouseMirror {
    return this.mirror;
  }

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
    this.closed = true;
    this.cancelWake?.();
    await this.queue;
  }
}
