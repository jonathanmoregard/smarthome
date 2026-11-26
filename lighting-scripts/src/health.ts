/**
 * The host's health, which the heartbeat beats on: the turns in a row that threw, the turns in a row whose every call
 * Home Assistant refused, and the calls in a row it did not answer in time. At {@link UNHEALTHY_AFTER} of any, the
 * heartbeat stops, so Home Assistant's watchdog hands the rooms back. Turns that threw resume it only at a turn that
 * does not. Failing calls resume it at any call Home Assistant answers: while they hold, Home Assistant is probed every
 * {@link PROBE_MS} with a request that changes nothing, since a house handed back makes no call of its own.
 */
import { Unanswered } from './adapter/ha-client.ts';
import type { BoundedClient } from './adapter/ha-client.ts';
import type { Log, Timer } from './host.ts';

/** The turns in a row that throw or whose every call is refused, or the calls in a row unanswered, before the heartbeat stops and the watchdog hands the rooms back. */
const UNHEALTHY_AFTER = 3;
/** How often Home Assistant is probed while its calls fail. */
const PROBE_MS = 60_000;

export class Health {
  private readonly ha: BoundedClient; private readonly log: Log; private readonly timer: Timer;
  private thrownInARow = 0; private refusedInARow = 0; private cancelProbe: (() => void) | undefined; private closed = false;

  constructor(ha: BoundedClient, log: Log, timer: Timer) { this.ha = ha; this.log = log; this.timer = timer; }

  /** A turn threw. */
  turnThrew(): void {
    if (++this.thrownInARow === UNHEALTHY_AFTER) this.log.error(`lighting: ${UNHEALTHY_AFTER} turns in a row failed; the heartbeat stops until a turn succeeds`);
  }

  /** A turn ran through. */
  turnRan(): void { this.thrownInARow = 0; }

  /** A call failed with `error`. */
  callFailed(error: unknown): void {
    if (error instanceof Unanswered && this.ha.unansweredInARow() === UNHEALTHY_AFTER) {
      this.log.error(`lighting: Home Assistant answered none of ${UNHEALTHY_AFTER} calls in a row; the heartbeat stops until it answers one`);
    }
  }

  /** A turn's calls made, `failed` saying which of its `outputs` failed: any taken answers, every one refused counts. */
  callsMade(failed: readonly boolean[], outputs: number): void {
    if (failed.includes(false)) this.refusedInARow = 0;
    else if (failed.length > 0 && failed.length === outputs && ++this.refusedInARow === UNHEALTHY_AFTER) {
      this.log.error(`lighting: Home Assistant refused every call of ${UNHEALTHY_AFTER} turns in a row; the heartbeat stops until it takes one`);
    }
    this.probeWhileFailing();
  }

  /** While calls fail, a probe every {@link PROBE_MS}; an answer in time clears both counts (the client clears its own). */
  private probeWhileFailing(): void {
    if (this.closed || this.cancelProbe !== undefined || !this.failingCalls()) return;
    this.cancelProbe = this.timer(PROBE_MS, () => {
      this.cancelProbe = undefined;
      if (this.closed || !this.failingCalls()) return;
      void this.ha.probe().then(() => {
        this.refusedInARow = 0;
        this.log.warn('lighting: Home Assistant answers again; the heartbeat resumes');
      }, () => this.probeWhileFailing());
    });
  }

  /** Whether the heartbeat is paused: the last turns all threw or were refused, or the last calls went unanswered. */
  paused(): boolean { return this.thrownInARow >= UNHEALTHY_AFTER || this.failingCalls(); }

  close(): void { this.closed = true; this.cancelProbe?.(); }

  private failingCalls(): boolean { return this.refusedInARow >= UNHEALTHY_AFTER || this.ha.unansweredInARow() >= UNHEALTHY_AFTER; }
}
