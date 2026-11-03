import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EntityState, EventRecord, JsonObject, JsonValue, ScheduledTask, ServiceCall, Snapshot } from './context.ts';
import type { ExecutionRequest, ExecutionResult } from './engine.ts';

export type Program = (request: ExecutionRequest) => ExecutionResult;
export interface OutputAcknowledgement { states?: Record<string, EntityState> }
export interface OutputTransport { send(call: ServiceCall): Promise<void | OutputAcknowledgement>; close(): Promise<void>; event?(event: EventRecord): Promise<void> }
export interface HostOptions {
  path: string; initial: Snapshot; program: Program; transport: OutputTransport;
  autoTimers?: boolean; connected?: boolean; now?: () => number; report?: (message: string) => void;
}
interface Journal { version: 1; snapshot: Snapshot; uncertain: boolean; pending: number; held?: ScheduledTask[] }
interface Batch { calls: ServiceCall[]; events: EventRecord[]; epoch: number; topology: unknown; deferred: Map<string, JsonObject>; tasks: ScheduledTask[]; started: number; versions: Map<ServiceCall, Map<string, number>>; revision?: string }
const successFields = ['applied', 'handled_rooms', 'handled_full', 'last_latency'];
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
function ids(call: ServiceCall): string[] { const value = call.target?.entity_id ?? call.data.entity_id; return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []; }
function topology(snapshot: Snapshot): unknown {
  const runtime = snapshot.state['sensor.ls_effects_runtime']?.attributes ?? {};
  return [snapshot.areas, snapshot.members, snapshot.devices, snapshot.entitySources, snapshot.catalog, runtime.candle_group, runtime.candle_syncing, snapshot.state['binary_sensor.zigbee2mqtt_bridge_connection_state']];
}

/** One process owns the journal and writer. Ambiguous in-flight calls are never replayed. */
export class LightingHost {
  private state: Snapshot;
  private program: Program;
  private readonly options: HostOptions;
  private owner!: FileHandle;
  private serial: Promise<unknown> = Promise.resolve();
  private output: Promise<void> = Promise.resolve();
  private batches: Batch[] = [];
  private pumping = false;
  private closing = false;
  private connected = true;
  private epoch = 0;
  private pending = 0;
  private held = new Map<string, ScheduledTask>();
  private writeVersions = new Map<string, number>();
  private pendingWrites = new Map<string, Set<number>>();
  private revisionAliases = new Map<string, string>();
  private refreshVersion = 0;
  private shutdown: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  recoveryRequired = false;

  private constructor(options: HostOptions) { this.options = options; this.state = structuredClone(options.initial); this.program = options.program; this.connected = options.connected ?? true; }
  static async open(options: HostOptions): Promise<LightingHost> {
    const host = new LightingHost(options);
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const lock = `${options.path}.lock`;
    // Kernel flock uses the inherited open-file description; crashes release ownership.
    // Keep the lock inode permanently: deleting it can create two independent owners.
    host.owner = await open(lock, 'a+', 0o600);
    const locked = spawnSync('flock', ['--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', host.owner.fd] });
    if (locked.error || locked.status !== 0) { await host.owner.close(); throw new Error(locked.error ? `Runtime needs flock: ${locked.error.message}` : 'Runtime already has an owner (locked)'); }
    await host.owner.truncate(0); await host.owner.writeFile(String(process.pid)); await host.owner.sync();
    try {
      try {
        const data = JSON.parse(await readFile(options.path, 'utf8')) as Journal;
        if (data.version !== 1 || !data.snapshot?.state || !Number.isFinite(Date.parse(data.snapshot.now))) throw new Error('Invalid runtime journal');
        host.state = data.snapshot;
        host.recoveryRequired = data.uncertain || data.pending > 0;
        for (const held of data.held ?? []) {
          const task = host.state.scheduled?.find(item => isDeepStrictEqual(item, held));
          if (task) { task.due = Math.max(task.due, host.now()); task.args = { ...task.args, host_completed_at: new Date(host.now()).toISOString(), host_output_success: false }; }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await host.save(); host.armTimer(); return host;
    } catch (error) { await host.owner.close(); throw error; }
  }
  snapshot(): Snapshot { return structuredClone(this.state); }
  async refresh(read: (previous: Snapshot) => Promise<Snapshot>): Promise<void> {
    const version = ++this.refreshVersion, previous = this.snapshot(), refreshed = await read(previous);
    await this.update(state => {
      if (version !== this.refreshVersion) return;
      // Only HA-owned fields belong to this read. Timers, catalog and the local
      // clock may have advanced while registry/network requests were in flight.
      state.areas = refreshed.areas;
      state.members = refreshed.members;
      if (refreshed.timezone !== undefined) state.timezone = refreshed.timezone;
      if (refreshed.labels !== undefined) state.labels = refreshed.labels;
      if (refreshed.devices !== undefined) state.devices = refreshed.devices;
      if (refreshed.identifiers !== undefined) state.identifiers = refreshed.identifiers;
      if (refreshed.entitySources !== undefined) state.entitySources = refreshed.entitySources;
      for (const [entity, incoming] of Object.entries(refreshed.state)) this.mergeIncoming(state, entity, incoming);
      for (const [entity, before] of Object.entries(previous.state)) {
        if (!Object.hasOwn(refreshed.state, entity) && isDeepStrictEqual(state.state[entity], before)) this.mergeIncoming(state, entity, null);
      }
    });
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async save(): Promise<void> {
    const temporary = `${this.options.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, snapshot: this.state, uncertain: this.recoveryRequired, pending: this.pending, held: [...this.held.values()] } satisfies Journal));
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, this.options.path);
    const directory = await open(dirname(this.options.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private mutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action);
    this.serial = result.catch(() => undefined);
    return result;
  }
  async ingestState(entity: string, incoming: EntityState | null): Promise<void> {
    await this.update(state => { this.mergeIncoming(state, entity, incoming); });
  }
  private mergeIncoming(state: Snapshot, entity: string, incoming: EntityState | null): void {
    if (this.pendingWrites.get(entity)?.size) return;
    const previous = state.state[entity];
    const time = (iso: string) => Date.parse(iso) + Number((/\.(\d{6})/.exec(iso)?.[1] ?? '000000').slice(3)) / 1000;
    if (incoming?.last_updated && previous?.last_updated && time(incoming.last_updated) < time(previous.last_updated)) return;
    if (incoming) state.state[entity] = structuredClone(incoming); else delete state.state[entity];
  }
  async update(change: (snapshot: Snapshot) => void): Promise<void> {
    await this.mutation(async () => { if (this.closing) return; const next = this.snapshot(); change(next); this.state = next; await this.save(); this.armTimer(); });
  }
  dispatch(script: string, args: JsonObject = {}): Promise<JsonValue> { return this.transaction(script, args); }
  private async transaction(script: string, args: JsonObject, task?: ScheduledTask): Promise<JsonValue> {
    return this.mutation(async () => {
      if (this.closing) throw new Error('Runtime is closing');
      const previous = this.snapshot();
      const request = this.snapshot();
      if (task) {
        const index = (request.scheduled ?? []).findIndex(item => isDeepStrictEqual(item, task));
        if (index < 0) return null;
        request.scheduled!.splice(index, 1);
      }
      const oldMicros = BigInt(Date.parse(request.now)) * 1000n + BigInt((/\.(\d{6})/.exec(request.now)?.[1] ?? '000000').slice(3));
      const wallMicros = BigInt(Math.trunc(this.now())) * 1000n;
      const micros = wallMicros > oldMicros ? wallMicros : oldMicros + 1n;
      request.now = new Date(Number(micros / 1000n)).toISOString().replace('Z', String(micros % 1000n).padStart(3, '0') + 'Z');
      const result = this.program({ script, args, snapshot: request });
      const next = structuredClone(result.snapshot), deferred = new Map<string, JsonObject>();
      for (const task of next.scheduled ?? []) {
        const deadline = task.args.host_timer_deadline;
        if (typeof deadline === 'number' && Number.isFinite(deadline)) task.due = deadline;
        else if (typeof deadline === 'string' && Number.isFinite(Date.parse(deadline))) task.due = Date.parse(deadline);
      }
      for (const call of result.calls) if (call.guard?.requiresOutputSuccess) {
        for (const entity of ids(call)) {
          const desired = object(call.data.attributes), old = previous.state[entity]?.attributes ?? {};
          const fields = deferred.get(entity) ?? {};
          for (const field of successFields) if (Object.hasOwn(desired, field)) {
            fields[field] = desired[field]!;
            if (next.state[entity]) {
              if (Object.hasOwn(old, field)) next.state[entity]!.attributes[field] = old[field]!;
              else delete next.state[entity]!.attributes[field];
            }
          }
          deferred.set(entity, fields);
        }
      }
      this.state = next;
      const tasks = (next.scheduled ?? []).filter(item => item.args.host_timer_deadline === undefined && !(previous.scheduled ?? []).some(old => isDeepStrictEqual(old, item)));
      const versions = new Map<ServiceCall, Map<string, number>>();
      for (const call of result.calls) if (/^(variable|input_text|input_number|input_boolean|timer)\./.test(call.service)) {
        const callVersions = new Map<string, number>();
        for (const entity of ids(call)) {
          const version = (this.writeVersions.get(entity) ?? 0) + 1;
          this.writeVersions.set(entity, version); callVersions.set(entity, version);
          const pending = this.pendingWrites.get(entity) ?? new Set<number>(); pending.add(version); this.pendingWrites.set(entity, pending);
        }
        versions.set(call, callVersions);
      }
      const batch: Batch = { calls: result.calls, events: result.events, epoch: this.epoch, topology: structuredClone(topology(next)), deferred, tasks: structuredClone(tasks), started: this.now(), versions, ...(next.state['sensor.ls_overrides']?.last_updated ? { revision: next.state['sensor.ls_overrides']!.last_updated! } : {}) };
      if (batch.calls.length || batch.events.length) for (const task of tasks) this.held.set(JSON.stringify(task), task);
      if (batch.calls.length || batch.events.length) this.pending++;
      try { await this.save(); } catch (error) { this.state = previous; this.closing = true; throw error; }
      if (batch.calls.length || batch.events.length) { this.batches.push(batch); this.startPump(); }
      this.armTimer();
      return result.result;
    });
  }
  /** Candidate import/compile must finish before this atomic replacement. */
  async replaceProgram(program: Program): Promise<void> {
    await this.mutation(async () => { this.epoch++; this.program = program; this.armTimer(); await this.save(); });
  }
  async connectionChanged(connected: boolean): Promise<void> {
    await this.mutation(async () => { this.connected = connected; this.epoch++; if (!connected && this.pending) this.recoveryRequired = true; await this.save(); this.armTimer(); });
  }
  private allowed(call: ServiceCall, batch: Batch): boolean {
    if (this.closing || !this.connected || batch.epoch !== this.epoch) return false;
    const guard = call.guard;
    if (!guard) return true;
    const runtime = this.state.state['sensor.ls_effects_runtime']?.attributes ?? {};
    if (this.state.state['sensor.ls_overrides']?.last_updated !== (this.revisionAliases.get(guard.revision) ?? guard.revision) || !isDeepStrictEqual(runtime.generation, guard.generation) || !isDeepStrictEqual(topology(this.state), batch.topology)) return false;
    for (const owner of guard.owners ?? []) if (this.state.state[owner]?.state !== 'on') return false;
    for (const member of guard.members ?? []) if (this.state.state[member]?.state !== 'on') return false;
    for (const [entity, target] of Object.entries(guard.effectTargets ?? {})) if (!isDeepStrictEqual(object(runtime.assignments)[entity], target)) return false;
    let payload: JsonObject = {};
    try { payload = object(typeof call.data.payload === 'string' ? JSON.parse(call.data.payload) : call.data.payload); } catch { return false; }
    if (payload.state !== 'OFF') for (const owner of guard.owners ?? []) {
      const area = this.state.areas[owner];
      if (area && object(this.state.state['sensor.ls_overrides']?.attributes.power)[area] === false) return false;
    }
    return true;
  }
  private startPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.output = this.pump().finally(() => { this.pumping = false; if (this.batches.length && !this.closing) this.startPump(); });
  }
  private async pump(): Promise<void> {
    while (this.batches.length) {
      const batch = this.batches.shift()!;
      let succeeded = true;
      try {
        for (const event of batch.events) {
          if (event.event === 'ls_override') await this.dispatch('ls_commit', { data: event.data });
          else if (event.event === 'ls_lamp_store_changed') await this.dispatch('ls_apply', { reason: 'config' });
          else if (this.options.transport.event) await this.options.transport.event(event);
          else throw new Error(`Unsupported external event: ${event.event}`);
        }
        // Completion writes always follow every physical command, irrespective of template order.
        const calls = [...batch.calls.filter(call => !call.guard?.requiresOutputSuccess), ...batch.calls.filter(call => call.guard?.requiresOutputSuccess)];
        for (const call of calls) {
          if (!this.allowed(call, batch) || (call.guard?.requiresOutputSuccess && !succeeded)) { succeeded = false; continue; }
          if (call.service === 'script.turn_on') {
            for (const entity of ids(call)) await this.dispatch(entity.replace(/^script\./, ''), object(call.data.variables));
          } else if (call.service === 'script.turn_off') {
            const names = ids(call).map(entity => entity.replace(/^script\./, ''));
            await this.update(state => { state.scheduled = (state.scheduled ?? []).filter(task => !names.some(name => task.script === name || task.script.startsWith(name + '_'))); });
          } else {
            const acknowledgement = await this.options.transport.send(call);
            await this.mutation(async () => {
              for (const [entity, state] of Object.entries(acknowledgement?.states ?? {})) {
                const version = batch.versions.get(call)?.get(entity);
                if (version === undefined || version !== this.writeVersions.get(entity)) continue;
                if (call.guard?.requiresOutputSuccess) continue;
                if (entity === 'sensor.ls_overrides' && batch.revision && state.last_updated) this.revisionAliases.set(batch.revision, state.last_updated);
                this.state.state[entity] = structuredClone(state);
              }
              for (const [entity, version] of batch.versions.get(call) ?? []) this.pendingWrites.get(entity)?.delete(version);
              await this.save();
            });
          }
          // A request may become stale while awaiting an acknowledgement.
          if (!this.allowed(call, batch)) succeeded = false;
        }
      } catch (error) { succeeded = false; this.options.report?.(`Output uncertain: ${error instanceof Error ? error.message : String(error)}`); }
      await this.mutation(async () => {
        if (succeeded && batch.epoch === this.epoch) for (const [entity, fields] of batch.deferred) {
          const current = this.state.state[entity];
          if (current) current.attributes = { ...current.attributes, ...fields };
        }
        if (!succeeded) this.recoveryRequired = true;
        else if (batch.deferred.size) this.recoveryRequired = false;
        for (const held of batch.tasks) {
          this.held.delete(JSON.stringify(held));
          const task = this.state.scheduled?.find(item => isDeepStrictEqual(item, held));
          if (task) { task.due += Math.max(0, this.now() - batch.started); task.args = { ...task.args, host_completed_at: new Date(this.now()).toISOString(), host_output_success: succeeded }; }
        }
        for (const versions of batch.versions.values()) for (const [entity, version] of versions) this.pendingWrites.get(entity)?.delete(version);
        const referenced = new Set(this.batches.flatMap(item => item.calls.map(call => call.guard?.revision)));
        for (const revision of this.revisionAliases.keys()) if (!referenced.has(revision)) this.revisionAliases.delete(revision);
        this.pending--; await this.save(); this.armTimer();
      });
    }
  }
  async drain(): Promise<void> { do { await this.serial; await this.output; } while (this.pumping || this.batches.length); }
  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.options.autoTimers === false || this.closing || !this.connected) return;
    const due = Math.min(...(this.state.scheduled ?? []).filter(task => !this.held.has(JSON.stringify(task))).map(task => task.due));
    if (!Number.isFinite(due)) return;
    this.timer = setTimeout(() => { void this.runDue().catch(error => this.options.report?.(String(error))); }, Math.max(0, Math.min(2_147_483_647, due - this.now())));
  }
  async runDue(): Promise<void> {
    while (!this.closing && this.connected) {
      const task = (this.snapshot().scheduled ?? []).filter(item => item.due <= this.now() && !this.held.has(JSON.stringify(item))).sort((a, b) => a.due - b.due)[0];
      if (!task) break;
      await this.transaction(task.script, task.args, task);
    }
    this.armTimer();
  }
  close(): Promise<void> {
    return this.shutdown ??= this.finishClose();
  }
  private async finishClose(): Promise<void> {
    this.closing = true; this.epoch++;
    if (this.timer) clearTimeout(this.timer);
    await this.options.transport.close(); await this.drain();
    await this.owner.close();
  }
}
