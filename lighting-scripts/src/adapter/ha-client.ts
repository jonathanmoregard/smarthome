/**
 * Home Assistant's wire, as the adapter reads and writes it: JSON values, an
 * entity's state, a service call, the shapes a whole read and an event come
 * in, and the websocket client that carries them.
 */
import { callService, createConnection, createLongLivedTokenAuth, ERR_CONNECTION_LOST, getConfig, getStates } from 'home-assistant-js-websocket';
import type { Connection } from 'home-assistant-js-websocket';
import { guardAnswerOf, guardedScript } from './codecs/guard.ts';

/** A JSON value as Home Assistant and the harness send it: the input to parsing, never its result. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

/** An entity's state as Home Assistant reports it. */
export interface EntityState {
  state: string;
  attributes: JsonObject;
  context?: JsonObject;
  entity_id?: string;
  last_updated?: string;
  last_changed?: string;
  /**
   * Set only by the port, on a state a write of its own laid over before Home Assistant reported it: when the write
   * was taken, as ISO text. Such a state has no `last_updated`, which is Home Assistant's stamp alone.
   */
  laid?: string;
}

/**
 * A Home Assistant service call: `domain.service`, its data and its target; with a guard, made only while the
 * guard's entity was last updated when the guard says, and refused otherwise.
 */
export interface ServiceCall {
  service: string;
  data: JsonObject;
  target?: JsonObject;
  guard?: Guard;
}

/** An entity's `last_updated` as read, as Home Assistant's `isoformat()` gives it: the call needs it unchanged. */
export type Guard = { entity: string; lastUpdated: string };

/**
 * A call's result, as Home Assistant answered it with success: the context id it gave, if any. A guarded call's script
 * answers success whether it wrote or not, so its response is read, and a call it did not write is refused.
 */
export function takenContext(result: unknown, guard: Guard | undefined): string | undefined {
  if (guard !== undefined) {
    const answer = guardAnswerOf(object(result).response);
    if (answer === undefined) throw new Error(`${guard.entity}: Home Assistant's answer does not say the write was made`);
    if (answer.kind === 'refused') throw new Error(`${guard.entity} changed since it was read: Home Assistant saw ${answer.seen}, not ${guard.lastUpdated}`);
  }
  const context = object(object(result).context).id;
  return typeof context === 'string' ? context : undefined;
}

/**
 * A call that did not reach Home Assistant, or whose answer was lost with the connection: Home Assistant is out of
 * reach, which says nothing about the bulb or helper the call was for.
 */
export class Unreachable extends Error {}

/** A call Home Assistant did not answer in time: refused, as far as the caller knows, though it may still be made. */
export class Unanswered extends Error {}

/**
 * What the host needs of Home Assistant: a service call, which rejects when Home Assistant did not take it, and
 * answers the context id Home Assistant gave it, when it gave one; and a probe, a request that changes nothing, which
 * settles once Home Assistant answers it.
 */
export interface HaClient {
  call(call: ServiceCall): Promise<string | undefined>;
  probe(): Promise<void>;
}

/**
 * How long a call waits for Home Assistant's answer. Its websocket `call_service` waits on the service with no bound of
 * its own (an MQTT publish is bounded at 10 s, a cloud plug's call is not), so one hung call would hold the queue, while
 * the heartbeat beats on and Home Assistant's watchdog never hands the rooms back.
 */
export const CALL_TIMEOUT_MS = 15_000;

/**
 * How long a whole read of the house waits for Home Assistant's seven answers. One list left unanswered would hold the
 * read for good, and the host paused with it; a read past this rejects, and is tried again.
 */
export const READ_TIMEOUT_MS = 30_000;

/** Node's timer: `wake` after `delayMs`, unless the answer is called first. */
const nodeTimer = (delayMs: number, wake: () => void): (() => void) => { const handle = setTimeout(wake, delayMs); return () => clearTimeout(handle); };

/** A client whose every call is bounded, and how many calls in a row Home Assistant has not answered in time. */
export type BoundedClient = HaClient & { unansweredInARow(): number };

/** An entity's state as the websocket sends it. */
export interface WireState { entity_id: string; state: string; attributes: unknown; context?: unknown; last_changed: string; last_updated: string }

export interface EntityEntry { entity_id: string; area_id: string | null; device_id: string | null; labels?: string[] }
export interface DeviceEntry { id: string; area_id: string | null; labels?: string[]; identifiers?: JsonValue[] }
export interface AreaEntry { area_id: string; labels?: string[]; floor_id?: string | null }
export interface LabelEntry { label_id: string; name: string }
/** The states, the timezone and the registry as one whole read brings them; `codecs/house.ts` makes the mirror of it. */
export type HouseRead = {
  states: readonly WireState[]; timezone: string; entities: readonly EntityEntry[]; devices: readonly DeviceEntry[];
  areas: readonly AreaEntry[]; labels: readonly LabelEntry[]; sources: Readonly<Record<string, { domain: string }>>;
};
export interface HaEvent { event_type: string; data: JsonObject }

const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

/**
 * Home Assistant over its websocket, through the official client, which owns
 * the connection, reconnects and authentication: service calls, the events
 * the host listens to, and the states and registry read whole. It holds no
 * rule: what the reads and events mean is the codecs'.
 */
export class HomeAssistantClient implements HaClient {
  private readonly connection: Connection;
  private readonly subscriptions: (() => Promise<void>)[] = [];
  private readonly listeners: { name: 'ready' | 'disconnected'; callback: () => void }[] = [];

  constructor(connection: Connection) { this.connection = connection; }

  static async connect(url: string, token: string): Promise<HomeAssistantClient> {
    if (!token.trim()) throw new Error('Home Assistant token is empty');
    const connection = await createConnection({ auth: createLongLivedTokenAuth(url, token.trim()), setupRetry: 0, connectTimeout: 10_000 });
    return new HomeAssistantClient(connection);
  }

  /**
   * A service call; rejects when Home Assistant is out of reach or refuses it. The answer is the call's context id.
   * A guarded call is run as a script that answers refused when the guard's entity has changed, the check the old
   * scripts make of a commit's `expected_revision`; {@link takenContext} reads that answer.
   */
  async call(call: ServiceCall): Promise<string | undefined> {
    // Do not enter the client's suspended-connection queue with stale output.
    if (!this.connection.connected) throw new Unreachable('Home Assistant is disconnected');
    const [domain, service, extra] = call.service.split('.');
    if (domain === undefined || service === undefined || extra !== undefined) throw new Error('Invalid Home Assistant service name');
    const sent = call.guard === undefined ? callService(this.connection, domain, service, call.data, call.target)
      : this.connection.sendMessagePromise({ type: 'execute_script', sequence: guardedScript(call, call.guard) });
    // The released client (9.7.1) rejects a lost connection with the bare code, or with an error result carrying it.
    const connectionLost = (error: unknown): boolean => error === ERR_CONNECTION_LOST
      || (typeof error === 'object' && error !== null && 'error' in error && typeof error.error === 'object' && error.error !== null
        && 'code' in error.error && error.error.code === ERR_CONNECTION_LOST);
    const result: unknown = await sent.catch((error: unknown) => {
      throw connectionLost(error) ? new Unreachable('Home Assistant connection lost') : error;
    });
    return takenContext(result, call.guard);
  }

  /** Home Assistant's config asked for, a request with no effect (never a service call, nor the heartbeat). */
  async probe(): Promise<void> {
    if (!this.connection.connected) throw new Unreachable('Home Assistant is disconnected');
    await getConfig(this.connection);
  }

  async subscribe(event: string, callback: (event: HaEvent) => void): Promise<void> {
    const unsubscribe = await this.connection.subscribeEvents<HaEvent>(callback, event);
    this.subscriptions.push(unsubscribe);
  }

  /**
   * The messages on an MQTT topic, through Home Assistant's `mqtt/subscribe` (an admin's only, as `execute_script`
   * is): each one's payload as Home Assistant forwards it, text. Subscribed again after a reconnect, as an event is.
   */
  async subscribeMqtt(topic: string, callback: (payload: JsonValue | undefined) => void): Promise<void> {
    const unsubscribe = await this.connection.subscribeMessage<unknown>(message => callback(object(message).payload), { type: 'mqtt/subscribe', topic });
    this.subscriptions.push(unsubscribe);
  }

  onConnection(callback: (connected: boolean) => void): void {
    for (const [name, value] of [['ready', true], ['disconnected', false]] as const) {
      const listener = () => callback(value);
      this.connection.addEventListener(name, listener); this.listeners.push({ name, callback: listener });
    }
  }

  /** The states, the config's timezone and the registry, read whole, as Home Assistant sends them; rejects {@link Unanswered} past {@link READ_TIMEOUT_MS}. */
  async read(): Promise<HouseRead> {
    const [states, config, entities, devices, areas, labels, sources] = await answeredWithin(READ_TIMEOUT_MS, 'the house read', Promise.all([
      getStates(this.connection), getConfig(this.connection),
      this.connection.sendMessagePromise<EntityEntry[]>({ type: 'config/entity_registry/list' }),
      this.connection.sendMessagePromise<DeviceEntry[]>({ type: 'config/device_registry/list' }),
      this.connection.sendMessagePromise<AreaEntry[]>({ type: 'config/area_registry/list' }),
      this.connection.sendMessagePromise<LabelEntry[]>({ type: 'config/label_registry/list' }),
      this.connection.sendMessagePromise<Record<string, { domain: string }>>({ type: 'entity/source' }),
    ]));
    return { states, timezone: config.time_zone, entities, devices, areas, labels, sources };
  }

  async close(): Promise<void> {
    for (const listener of this.listeners) this.connection.removeEventListener(listener.name, listener.callback);
    this.connection.close();
    await Promise.allSettled(this.subscriptions.map(unsubscribe => unsubscribe()));
    this.subscriptions.length = 0; this.listeners.length = 0;
  }
}

/** `answer` as it settles, unless `timeoutMs` of Node's timer pass first: then it rejects {@link Unanswered}, naming `what`. */
function answeredWithin<T>(timeoutMs: number, what: string, answer: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = nodeTimer(timeoutMs, () => reject(new Unanswered(`Home Assistant did not answer ${what} within ${timeoutMs / 1000} s`)));
    answer.then(value => { cancel(); resolve(value); }, (error: unknown) => { cancel(); reject(error); });
  });
}

/**
 * `ha` with every call and probe bounded at `timeoutMs` of `timer`, Node's own by default (the bound is the wire's,
 * not the house's clock): one Home Assistant has not answered by then rejects {@link Unanswered}, a refused call, so
 * the caller moves on and tries it again. An answer that comes after is said to `late` and taken for nothing. Any
 * answer in time, a refusal too, ends the run of calls unanswered.
 */
export function bounded(ha: HaClient, late: (message: string) => void, timer: (delayMs: number, wake: () => void) => () => void = nodeTimer,
  timeoutMs = CALL_TIMEOUT_MS): BoundedClient {
  let unanswered = 0;
  const within = <T>(what: string, ask: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    let over = false;
    const cancel = timer(timeoutMs, () => {
      over = true; unanswered++;
      reject(new Unanswered(`Home Assistant did not answer ${what} within ${timeoutMs / 1000} s; counted as refused`));
    });
    const answered = (take: () => void, how: string) => {
      if (over) late(`lighting: ${what} ${how} after its ${timeoutMs / 1000} s timeout; ignored`);
      else { cancel(); unanswered = 0; take(); }
    };
    ask().then(value => answered(() => resolve(value), 'answered'),
      (error: unknown) => answered(() => reject(error), `failed (${error instanceof Error ? error.message : String(error)})`));
  });
  return { unansweredInARow: () => unanswered, call: call => within(call.service, () => ha.call(call)), probe: () => within('the probe', () => ha.probe()) };
}
