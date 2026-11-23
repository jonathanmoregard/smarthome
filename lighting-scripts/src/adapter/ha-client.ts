/**
 * Home Assistant's wire, as the adapter reads and writes it: JSON values, an
 * entity's state, a service call, the shapes a whole read and an event come
 * in, and the websocket client that carries them.
 */
import { callService, createConnection, createLongLivedTokenAuth, getConfig, getStates, isConnectionLost } from 'home-assistant-js-websocket';
import type { Connection } from 'home-assistant-js-websocket';

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
 * A call that did not reach Home Assistant, or whose answer was lost with the connection: Home Assistant is out of
 * reach, which says nothing about the bulb or helper the call was for.
 */
export class Unreachable extends Error {}

/**
 * What the host needs of Home Assistant: a service call, which rejects when Home Assistant did not take it, and
 * answers the context id Home Assistant gave it, when it gave one.
 */
export interface HaClient {
  call(call: ServiceCall): Promise<string | undefined>;
}

/** An entity's state as the websocket sends it. */
export interface WireState { entity_id: string; state: string; attributes: unknown; context?: unknown; last_changed: string; last_updated: string }
export interface EntityEntry { entity_id: string; area_id: string | null; device_id: string | null; labels?: string[] }
export interface DeviceEntry { id: string; area_id: string | null; labels?: string[]; identifiers?: JsonValue[] }
export interface AreaEntry { area_id: string; labels?: string[] }
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
   * A guarded call is run as a script whose first step stops it with an error when the guard's entity has changed,
   * the check the old scripts make of a commit's `expected_revision`.
   */
  async call(call: ServiceCall): Promise<string | undefined> {
    // Do not enter the client's suspended-connection queue with stale output.
    if (!this.connection.connected) throw new Unreachable('Home Assistant is disconnected');
    const [domain, service, extra] = call.service.split('.');
    if (domain === undefined || service === undefined || extra !== undefined) throw new Error('Invalid Home Assistant service name');
    const guard = call.guard;
    const sent = guard === undefined ? callService(this.connection, domain, service, call.data, call.target)
      : this.connection.sendMessagePromise({ type: 'execute_script', sequence: [
        { if: [{ condition: 'template', value_template: `{{ states.${guard.entity}.last_updated.isoformat() != ${JSON.stringify(guard.lastUpdated)} }}` }],
          then: [{ stop: `${guard.entity} changed since it was read`, error: true }] },
        { action: call.service, ...call.target === undefined ? {} : { target: call.target }, data: call.data },
      ] });
    const response: unknown = await sent.catch((error: unknown) => {
      throw isConnectionLost(error) ? new Unreachable('Home Assistant connection lost') : error;
    });
    const context = object(object(response).context).id;
    return typeof context === 'string' ? context : undefined;
  }

  async subscribe(event: string, callback: (event: HaEvent) => void): Promise<void> {
    const unsubscribe = await this.connection.subscribeEvents<HaEvent>(callback, event);
    this.subscriptions.push(unsubscribe);
  }

  onConnection(callback: (connected: boolean) => void): void {
    for (const [name, value] of [['ready', true], ['disconnected', false]] as const) {
      const listener = () => callback(value);
      this.connection.addEventListener(name, listener); this.listeners.push({ name, callback: listener });
    }
  }

  /** The states, the config's timezone and the registry, read whole, as Home Assistant sends them. */
  async read(): Promise<HouseRead> {
    const [states, config, entities, devices, areas, labels, sources] = await Promise.all([
      getStates(this.connection), getConfig(this.connection),
      this.connection.sendMessagePromise<EntityEntry[]>({ type: 'config/entity_registry/list' }),
      this.connection.sendMessagePromise<DeviceEntry[]>({ type: 'config/device_registry/list' }),
      this.connection.sendMessagePromise<AreaEntry[]>({ type: 'config/area_registry/list' }),
      this.connection.sendMessagePromise<LabelEntry[]>({ type: 'config/label_registry/list' }),
      this.connection.sendMessagePromise<Record<string, { domain: string }>>({ type: 'entity/source' }),
    ]);
    return { states, timezone: config.time_zone, entities, devices, areas, labels, sources };
  }

  async close(): Promise<void> {
    for (const listener of this.listeners) this.connection.removeEventListener(listener.name, listener.callback);
    this.connection.close();
    await Promise.allSettled(this.subscriptions.map(unsubscribe => unsubscribe()));
    this.subscriptions.length = 0; this.listeners.length = 0;
  }
}
