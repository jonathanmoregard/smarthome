/**
 * Effects at the edge.
 *
 * A lighting decision is pure: it reads typed input and either returns a value
 * or yields a {@link Plan} of {@link Effect}s. This module is the one place
 * those effects are performed against the live {@link ScriptContext}.
 */
import type { JsonObject, OutputGuard, ScriptContext } from './context.ts';

/**
 * Everything a decision can ask the house to do. A closed union: payloads stay
 * as each site builds them (key order is compared bytes), so there are no
 * per-service variants.
 */
export type Effect =
  | { kind: 'service'; service: string; data: JsonObject; target?: JsonObject; guard?: OutputGuard }
  | { kind: 'event'; event: string; data: JsonObject }
  /** A helper's state as this transaction sees it (gestures' local write-through). */
  | { kind: 'state'; entity: string; state: string }
  | { kind: 'schedule'; script: string; args: JsonObject; delayMs: number }
  /** An inter-handler run whose result is discarded; its name and argument bytes are traced. */
  | { kind: 'script'; name: string; args: JsonObject };

/**
 * A one-way lazy sequence of effects with a final answer. Lazy on purpose: a
 * raising step after a `yield` raises after the effects before it were
 * performed, exactly where the imperative code raised. Nothing is sent back
 * in; a decision that needs an effect's result is split at that point and the
 * re-read happens in the caller.
 */
export type Plan<R> = Generator<Effect, R, void>;

/**
 * The read-only house a decision may consult for dynamically keyed reads.
 * Never hand it to a generator: it is live, so a read after a `yield` would
 * look pure and not be. Generators take a snapshot instead.
 */
export type HouseView = Pick<ScriptContext,
  'state' | 'rooms' | 'members' | 'labels' | 'devices' | 'entitySources' | 'timezone' | 'now' | 'catalog' | 'get' | 'attr'>;

export function perform(ctx: ScriptContext, effect: Effect): void {
  switch (effect.kind) {
    case 'service': ctx.emit(effect.service, effect.data, effect.target, effect.guard); return;
    case 'event': ctx.fire(effect.event, effect.data); return;
    case 'state': ctx.put(effect.entity, effect.state); return;
    case 'schedule': ctx.schedule(effect.script, effect.args, effect.delayMs); return;
    case 'script': ctx.run(effect.name, effect.args); return;
    default: {
      const unhandled: never = effect;
      throw new Error(`Unhandled effect ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Perform a plan's effects in yield order and answer its result. */
export function run<R>(ctx: ScriptContext, plan: Plan<R>): R {
  for (;;) {
    const step = plan.next();
    if (step.done) return step.value;
    perform(ctx, step.value);
  }
}

/**
 * A state machine for a handler that needs answers from the house mid-way, in
 * the Elm shape: from the current model and the message just received, the
 * next model and the commands to perform, in order. Pure; the model never
 * holds the house.
 */
export type Reducer<Model, Msg, Cmd> = (model: Model, msg: Msg) => [Model, Cmd[]];

/**
 * Run a reducer to its end. Each step's commands are performed in order; the
 * last reply any of them gives is the next message. A terminal model (`settle`
 * answers) ends the run after its own commands are performed.
 */
export function drive<Model, Msg, Cmd, R>(
  reducer: Reducer<Model, Msg, Cmd>, model: Model, first: Msg,
  perform: (cmd: Cmd) => Msg | undefined, settle: (model: Model) => { value: R } | undefined,
): R {
  let msg = first;
  for (;;) {
    const [next, cmds] = reducer(model, msg);
    model = next;
    let reply: Msg | undefined;
    for (const cmd of cmds) {
      const answer = perform(cmd);
      if (answer !== undefined) reply = answer;
    }
    const settled = settle(model);
    if (settled !== undefined) return settled.value;
    if (reply === undefined) throw new Error(`Reducer stalled: no reply to feed back in phase ${JSON.stringify(model)}`);
    msg = reply;
  }
}
