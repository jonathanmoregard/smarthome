import type { EntityState, EventRecord, JsonObject, JsonValue, OutputGuard, ScheduledTask, ScriptContext, ScriptHandlers, ServiceCall, Snapshot } from './context.ts';

export interface ExecutionRequest { script: string; args: JsonObject; snapshot: Snapshot }
export interface ExecutionResult { result: JsonValue; snapshot: Snapshot; calls: ServiceCall[]; events: EventRecord[] }
export interface ExecutionHooks {
  beforeService?: (call: ServiceCall, context: ScriptContext) => void;
  afterService?: (call: ServiceCall, context: ScriptContext) => void;
  beforeScript?: (name: string, args: JsonObject, context: ScriptContext) => void;
  afterScript?: (name: string, args: JsonObject, result: JsonValue, context: ScriptContext) => void;
}

function finite(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JSON output must contain finite numbers');
  if (Array.isArray(value)) value.forEach(finite);
  else if (value && typeof value === 'object') Object.values(value).forEach(finite);
}

class Context implements ScriptContext {
  state: Record<string, EntityState>;
  areas: Record<string, string>;
  members: string[];
  now: string;
  timezone: string;
  elapsed: number;
  labels: Record<string, string[]>;
  devices: Record<string, string[]>;
  identifiers: Record<string, JsonValue[]>;
  scheduled: ScheduledTask[];
  catalog: JsonObject;
  entitySources: Record<string, string>;
  calls: ServiceCall[] = [];
  events: EventRecord[] = [];
  private depth = 0;
  private readonly handlers: ScriptHandlers;
  private readonly original: Snapshot;
  private readonly hooks: ExecutionHooks;
  readonly scriptRuns: string[] = [];

  constructor(snapshot: Snapshot, handlers: ScriptHandlers, hooks: ExecutionHooks) {
    this.handlers = handlers;
    this.hooks = hooks;
    const copy = structuredClone(snapshot);
    this.original = copy;
    if (!Number.isFinite(Date.parse(copy.now))) throw new Error('Snapshot now must be an ISO timestamp');
    this.state = copy.state;
    this.areas = copy.areas;
    this.members = copy.members;
    this.now = copy.now;
    this.timezone = copy.timezone ?? 'Europe/Stockholm';
    this.elapsed = copy.elapsed ?? 0;
    this.labels = copy.labels ?? {};
    this.devices = copy.devices ?? {};
    this.identifiers = copy.identifiers ?? {};
    this.scheduled = copy.scheduled ?? [];
    this.catalog = copy.catalog ?? {};
    this.entitySources = copy.entitySources ?? {};
  }

  run(name: string, args: JsonObject = {}): JsonValue {
    name = name.replace(/^script\./, '');
    let handler = this.handlers[name];
    if (!handler) {
      const match = /^(ls_remote_gesture|ls_remote_power_quiet)_(.+)$/.exec(name);
      if (match?.[1] && match[2]) {
        handler = this.handlers[match[1]];
        const remotes = this.catalog.remotes;
        const metadata = remotes && typeof remotes === 'object' && !Array.isArray(remotes) ? remotes[match[2]] : null;
        args = { ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}), ...args, room: match[2] };
      }
    }
    if (!handler) throw new Error(`Unsupported script: ${name}`);
    this.scriptRuns.push(name);
    this.hooks.beforeScript?.(name, args, this);
    if (++this.depth > 64) throw new Error('Script call depth exceeded');
    try {
      const result = handler(this, args);
      this.hooks.afterScript?.(name, args, result, this);
      return result;
    } finally { this.depth--; }
  }

  get(entity: string): string { return this.state[entity]?.state ?? 'unknown'; }
  attr(entity: string, key: string): JsonValue | undefined { return this.state[entity]?.attributes[key]; }
  put(entity: string, state: string, attributes?: JsonObject): void {
    const previous = this.state[entity];
    this.state[entity] = {
      entity_id: entity, state,
      attributes: structuredClone(attributes ?? previous?.attributes ?? {}),
      last_updated: this.now,
      last_changed: previous?.state === state ? previous.last_changed ?? this.now : this.now,
    };
  }
  emit(service: string, data: JsonObject, target?: JsonObject, guard?: OutputGuard): void {
    const call = structuredClone({ service, data, time: this.elapsed, ...(target ? { target } : {}), ...(guard ? { guard } : {}) });
    this.hooks.beforeService?.(call, this);
    this.calls.push(call);
    const ids = target?.entity_id ?? data.entity_id;
    const entities = (Array.isArray(ids) ? ids : [ids]).filter((id): id is string => typeof id === 'string');
    for (const entity of entities) {
      if (service === 'variable.update_sensor') {
        const attributes = data.attributes && typeof data.attributes === 'object' && !Array.isArray(data.attributes) ? data.attributes : {};
        this.put(entity, String(data.value ?? this.get(entity)), { ...(data.replace_attributes ? {} : this.state[entity]?.attributes), ...attributes });
      } else if (['input_text.set_value', 'input_number.set_value'].includes(service)) this.put(entity, String(data.value));
      else if (service === 'input_select.select_option') this.put(entity, String(data.option));
      else if (/^(input_boolean|homeassistant)\.turn_(on|off)$/.test(service)) this.put(entity, service.endsWith('_on') ? 'on' : 'off');
      else if (service === 'timer.start' || service === 'timer.cancel') this.put(entity, service === 'timer.start' ? 'active' : 'idle');
    }
    this.hooks.afterService?.(call, this);
  }
  fire(event: string, data: JsonObject): void { this.events.push({ event, data: structuredClone(data) }); }
  schedule(script: string, args: JsonObject, delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Schedule delay must be nonnegative and finite');
    this.scheduled.push({ script, args: structuredClone(args), due: Date.parse(this.now) + delayMs });
  }
  snapshot(): Snapshot {
    return { ...this.original, state: this.state, areas: this.areas, members: this.members, now: this.now,
      ...(this.original.elapsed !== undefined || this.elapsed ? { elapsed: this.elapsed } : {}),
      ...(this.original.scheduled !== undefined || this.scheduled.length ? { scheduled: this.scheduled } : {}),
    };
  }
}

/** Each request is an isolated transaction; the host decides how to persist and emit it. */
export function execute(request: ExecutionRequest, handlers: ScriptHandlers, hooks: ExecutionHooks = {}): ExecutionResult & { scriptRuns: string[] } {
  const context = new Context(request.snapshot, handlers, hooks);
  const result = context.run(request.script, request.args);
  const output = { result, snapshot: context.snapshot(), calls: context.calls, events: context.events, scriptRuns: context.scriptRuns };
  finite(output);
  return output;
}
