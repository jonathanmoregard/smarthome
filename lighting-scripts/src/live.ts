/**
 * Home Assistant over its websocket, through the official client, which owns
 * the connection, reconnects and authentication: service calls, the events
 * the host listens to, and the states and registry read whole.
 */
import { callService, createConnection, createLongLivedTokenAuth, getConfig, getStates } from 'home-assistant-js-websocket';
import type { Connection } from 'home-assistant-js-websocket';
import type { HouseMirror } from './adapter/codecs/house.ts';
import type { EntityState, HaClient, JsonObject, JsonValue, ServiceCall } from './adapter/ha-client.ts';

const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
interface EntityEntry { entity_id: string; area_id: string | null; device_id: string | null; labels?: string[] }
interface DeviceEntry { id: string; area_id: string | null; labels?: string[]; identifiers?: JsonValue[] }
interface AreaEntry { area_id: string; labels?: string[] }
interface LabelEntry { label_id: string; name: string }
export interface HaEvent { event_type: string; data: JsonObject }

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

  /** A service call; rejects when Home Assistant is out of reach or refuses it. The answer is the call's context id. */
  async call(call: ServiceCall): Promise<string | undefined> {
    // Do not enter the client's suspended-connection queue with stale output.
    if (!this.connection.connected) throw new Error('Home Assistant is disconnected');
    const [domain, service, extra] = call.service.split('.');
    if (domain === undefined || service === undefined || extra !== undefined) throw new Error('Invalid Home Assistant service name');
    const response: unknown = await callService(this.connection, domain, service, call.data, call.target);
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

  /** The states and the registry, read whole. Schedule membership is the `house_schedule` label over the catalog's lamps. */
  async read(lamps: ReadonlySet<string>): Promise<HouseMirror> {
    const [states, config, entities, devices, areas, labels, sources] = await Promise.all([
      getStates(this.connection), getConfig(this.connection),
      this.connection.sendMessagePromise<EntityEntry[]>({ type: 'config/entity_registry/list' }),
      this.connection.sendMessagePromise<DeviceEntry[]>({ type: 'config/device_registry/list' }),
      this.connection.sendMessagePromise<AreaEntry[]>({ type: 'config/area_registry/list' }),
      this.connection.sendMessagePromise<LabelEntry[]>({ type: 'config/label_registry/list' }),
      this.connection.sendMessagePromise<Record<string, { domain: string }>>({ type: 'entity/source' }),
    ]);
    const areaOf: Record<string, string> = {}, deviceEntities: Record<string, string[]> = {}, labelled: Record<string, string[]> = {};
    const deviceIndex = new Map(devices.map(device => [device.id, device]));
    const labelIndex = new Map(labels.map(label => [label.label_id, label.name]));
    const label = (name: string, entity: string) => {
      for (const key of new Set([name, labelIndex.get(name) ?? name])) labelled[key] = [...new Set([...(labelled[key] ?? []), entity])];
    };
    for (const area of areas) for (const name of area.labels ?? []) label(name, area.area_id);
    for (const device of devices) if (device.area_id !== null) areaOf[device.id] = device.area_id;
    for (const entity of entities) {
      const device = entity.device_id === null ? undefined : deviceIndex.get(entity.device_id);
      const area = entity.area_id ?? device?.area_id;
      if (area !== undefined && area !== null) areaOf[entity.entity_id] = area;
      if (entity.device_id !== null) (deviceEntities[entity.device_id] ??= []).push(entity.entity_id);
      for (const name of [...entity.labels ?? [], ...device?.labels ?? []]) label(name, entity.entity_id);
    }
    return {
      state: Object.fromEntries(states.map(state => [state.entity_id, entityState(state)])), areas: areaOf,
      members: (labelled.house_schedule ?? []).filter(entity => lamps.has(entity)), labels: labelled, devices: deviceEntities,
      entitySources: Object.fromEntries(Object.entries(sources).map(([entity, source]) => [entity, source.domain])), timezone: config.time_zone,
    };
  }

  async close(): Promise<void> {
    for (const listener of this.listeners) this.connection.removeEventListener(listener.name, listener.callback);
    this.connection.close();
    await Promise.allSettled(this.subscriptions.map(unsubscribe => unsubscribe()));
    this.subscriptions.length = 0; this.listeners.length = 0;
  }
}

/** An entity's state as the websocket sends it, in the shape the adapter reads. */
export function entityState(state: {
  state: string; attributes: unknown; entity_id: string; context?: unknown; last_changed: string; last_updated: string;
}): EntityState {
  const context = state.context !== null && typeof state.context === 'object' && !Array.isArray(state.context)
    ? state.context as JsonObject : undefined;
  return { state: state.state, attributes: object(state.attributes), entity_id: state.entity_id,
    last_changed: state.last_changed, last_updated: state.last_updated, ...(context === undefined ? {} : { context }) };
}
