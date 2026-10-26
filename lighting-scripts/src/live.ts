import { callService, createConnection, createLongLivedTokenAuth, getConfig, getStates } from 'home-assistant-js-websocket';
import type { Connection } from 'home-assistant-js-websocket';
import type { JsonObject, JsonValue, ServiceCall, Snapshot } from './runtime/context.ts';
import type { OutputAcknowledgement, OutputTransport } from './runtime/host.ts';

const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
interface EntityEntry { entity_id: string; area_id: string | null; device_id: string | null; labels?: string[]; platform?: string }
interface DeviceEntry { id: string; area_id: string | null; labels?: string[]; identifiers?: JsonValue[] }
interface AreaEntry { area_id: string; labels?: string[] }
interface LabelEntry { label_id: string; name: string }
export interface HaEvent { event_type: string; data: JsonObject; context?: { user_id?: string | null } }
/** Connection/reconnect/authentication are owned by the official HA client. */
export class HomeAssistantTransport implements OutputTransport {
  private readonly connection: Connection;
  private inFlight = 0;
  private ownContexts: string[] = [];
  private buffered: { event: HaEvent; callback: (event: HaEvent) => void }[] = [];
  private ambiguous = false;
  private readonly subscriptions: (() => Promise<void>)[] = [];
  private readonly listeners: { name: 'ready' | 'disconnected'; callback: () => void }[] = [];
  constructor(connection: Connection) { this.connection = connection; }
  static async connect(url: string, token: string): Promise<HomeAssistantTransport> {
    if (!token.trim()) throw new Error('Home Assistant token is empty');
    const connection = await createConnection({ auth: createLongLivedTokenAuth(url, token.trim()), setupRetry: 0, connectTimeout: 10_000 });
    return new HomeAssistantTransport(connection);
  }
  async send(call: ServiceCall): Promise<void | OutputAcknowledgement> {
    // Do not enter the client's optional suspended-connection queue with stale output.
    if (!this.connection.connected) throw new Error('Home Assistant is disconnected');
    const [domain, service, extra] = call.service.split('.');
    if (!domain || !service || extra) throw new Error('Invalid Home Assistant service name');
    this.inFlight++;
    try {
      const response: unknown = await callService(this.connection, domain, service, call.data, call.target);
      const context = object(object(response).context).id;
      if (typeof context === 'string') this.ownContexts = [...this.ownContexts, context].slice(-1024);
    } catch (error) { this.ambiguous = true; throw error; }
    finally {
      this.inFlight--;
      if (this.inFlight === 0) {
        const events = this.buffered.splice(0);
        if (this.ambiguous && events.length) console.error('Discarded ambiguous user-control echoes after an unacknowledged output.');
        else for (const item of events) this.deliverBridge(item.event, item.callback);
        this.ambiguous = false;
      }
    }
    if (domain === 'variable' && [call.target?.entity_id, call.data.entity_id].flat().includes('sensor.ls_overrides')) {
      const target = call.target?.entity_id ?? call.data.entity_id;
      const entities = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
      const states = await getStates(this.connection);
      return { states: Object.fromEntries(states.filter(state => entities.includes(state.entity_id)).map(state => [state.entity_id, { state: state.state, attributes: state.attributes as JsonObject, entity_id: state.entity_id, last_changed: state.last_changed, last_updated: state.last_updated }])) };
    }
  }
  private deliverBridge(event: HaEvent, callback: (event: HaEvent) => void): void {
    const data = event.data;
    if (['automation.lighting_schedule_sara_mode_switch', 'automation.lighting_schedule_lamp_change_detector'].includes(String(data.script))) {
      if (this.inFlight) { this.buffered.push({ event, callback }); return; }
      const trigger = object(object(data.args).trigger);
      const context = object(object(trigger.to_state).context).id ?? object(object(trigger.event).context).id;
      if (typeof context === 'string' && this.ownContexts.includes(context)) return;
    }
    callback(event);
  }
  async subscribe(event: string, callback: (event: HaEvent) => void): Promise<void> {
    const unsubscribe = await this.connection.subscribeEvents<HaEvent>(event === 'smarthome_script' ? value => this.deliverBridge(value, callback) : callback, event);
    this.subscriptions.push(unsubscribe);
  }
  onConnection(callback: (connected: boolean) => void): void {
    for (const [name, value] of [['ready', true], ['disconnected', false]] as const) {
      const listener = () => callback(value);
      this.connection.addEventListener(name, listener); this.listeners.push({ name, callback: listener });
    }
  }
  async refresh(previous: Snapshot): Promise<Snapshot> {
    if (!previous.catalog?.members || !previous.catalog.effects) throw new Error('Supply the existing runtime catalog; registry relationships must not be guessed');
    const [states, config, entities, devices, areas, labels, sources] = await Promise.all([
      getStates(this.connection), getConfig(this.connection),
      this.connection.sendMessagePromise<EntityEntry[]>({ type: 'config/entity_registry/list' }),
      this.connection.sendMessagePromise<DeviceEntry[]>({ type: 'config/device_registry/list' }),
      this.connection.sendMessagePromise<AreaEntry[]>({ type: 'config/area_registry/list' }),
      this.connection.sendMessagePromise<LabelEntry[]>({ type: 'config/label_registry/list' }),
      this.connection.sendMessagePromise<Record<string, { domain: string }>>({ type: 'entity/source' }),
    ]);
    const next: Snapshot = { ...previous, now: new Date().toISOString(), timezone: config.time_zone,
      state: Object.fromEntries(states.map(state => [state.entity_id, { state: state.state, attributes: state.attributes as JsonObject, entity_id: state.entity_id, last_changed: state.last_changed, last_updated: state.last_updated }])),
      areas: {}, devices: {}, identifiers: {}, labels: {}, entitySources: Object.fromEntries(Object.entries(sources).map(([entity, source]) => [entity, source.domain])),
    };
    const deviceIndex = new Map(devices.map(device => [device.id, device]));
    const labelIndex = new Map(labels.map(label => [label.label_id, label.name]));
    const label = (name: string, entity: string) => {
      for (const key of new Set([name, labelIndex.get(name) ?? name])) next.labels![key] = [...new Set([...(next.labels![key] ?? []), entity])];
    };
    for (const area of areas) for (const name of area.labels ?? []) label(name, area.area_id);
    for (const device of devices) {
      if (device.area_id) next.areas[device.id] = device.area_id;
      next.identifiers![device.id] = device.identifiers ?? [];
    }
    for (const entity of entities) {
      const device = entity.device_id ? deviceIndex.get(entity.device_id) : undefined;
      const area = entity.area_id ?? device?.area_id;
      if (area) next.areas[entity.entity_id] = area;
      if (entity.device_id) (next.devices![entity.device_id] ??= []).push(entity.entity_id);
      for (const name of [...entity.labels ?? [], ...device?.labels ?? []]) label(name, entity.entity_id);
    }
    // This label owns schedule membership; catalog owns logical-to-physical identity.
    next.members = (next.labels?.house_schedule ?? []).filter(entity => entity in (previous.catalog?.members as JsonObject));
    return next;
  }
  async close(): Promise<void> {
    for (const listener of this.listeners) this.connection.removeEventListener(listener.name, listener.callback);
    this.connection.close();
    await Promise.allSettled(this.subscriptions.map(unsubscribe => unsubscribe()));
    this.subscriptions.length = 0; this.listeners.length = 0;
  }
}
