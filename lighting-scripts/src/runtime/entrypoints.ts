import type { JsonObject, ScriptContext, ScriptHandler } from './context.ts';
import { resultCodecs } from '../parse/results.ts';
import type { SwitchPlanResult } from '../domain/controller.ts';
import type { ResolutionResult } from '../domain/resolution.ts';
import type { GradientPlanResult } from '../domain/gradient.ts';
import type { AssignResult, EmitResult } from '../domain/transport.ts';
import type { DispatchResult } from '../domain/dispatch-render.ts';
import type { CommitResult } from '../domain/state-store.ts';
import type { CandlePlanResult, GroupPlanResult } from '../domain/grouping.ts';

/**
 * The typed result of each converted internal entrypoint, keyed by the script
 * name callers already use.
 *
 * This is the typed dependency surface. `ctx.call('ls_switch_plan', args)`
 * returns `SwitchPlanResult` instead of `JsonValue`, so the caller stops
 * re-dissolving what the callee already built. The name stays a string literal
 * on purpose: `scriptRuns` and the parity trace both record it, and the
 * argument bytes are compared, so only the *result* data flow changes.
 *
 * Every member must also appear in {@link resultCodecs}, which the mapped type
 * there enforces at compile time -- add a name here and the codec table stops
 * compiling until its codec exists.
 *
 * Only entrypoints invoked from `src/` belong here. The 18 edge-only scripts
 * are reached by an HA trigger or the parity RPC and never by another handler;
 * they need no typed surface, only the name-keyed shim they already have.
 */
export interface TypedResults {
  ls_switch_plan: SwitchPlanResult;
  effects_resolve: ResolutionResult;
  effects_gradient_plan: GradientPlanResult;
  effects_emit: EmitResult;
  effects_assign: AssignResult;
  ls_dispatch: DispatchResult;
  ls_commit: CommitResult;
  // One type for two names, because `framePlan` returns
  // `ctx.call('effects_group_plan', ...)` unchanged. Registering both keeps the
  // two addressable by name for HA and the parity RPC while making it
  // impossible for their results to drift apart.
  effects_group_plan: GroupPlanResult;
  effects_frame_plan: GroupPlanResult;
  effects_candle_plan: CandlePlanResult;
}

export type TypedName = keyof TypedResults;

/**
 * A converted entrypoint's typed half: parse the JSON arguments, then run with
 * real types and return a real type.
 *
 * `A` and `R` are erased to `unknown` where the engine stores this, because the
 * engine dispatches by name and cannot know the pair statically. The cast back
 * is confined to {@link ScriptContext.call} and is sound because {@link typed}
 * is the only constructor and ties `R` to `TypedResults[K]`.
 */
export interface TypedEntry<A = unknown, R = unknown> {
  readonly name: string;
  parse(args: JsonObject): A;
  run(context: ScriptContext, args: A): R;
}

/**
 * A registered handler that also carries its typed half.
 *
 * It stays a *function*, so the name-keyed table is unchanged for every
 * existing caller, test and `typeof handler === 'function'` check: HA and the
 * parity RPC keep getting JSON in and JSON out. The typed half rides along as
 * a property, and {@link typedEntry} is the only reader.
 */
export type TypedScriptHandler = ScriptHandler & { readonly typed: TypedEntry };

/**
 * Register one entrypoint in both views at once.
 *
 * The returned function is the JSON shim -- parse, run, encode -- which is what
 * the HA transport and the parity harness call. `.typed` is the same `run` with
 * no serialisation around it, which is what {@link ScriptContext.call} uses.
 * One implementation, two views, and the encoder lives in the parse layer.
 */
export function typed<K extends TypedName, A>(name: K, handler: {
  parse: (args: JsonObject) => A;
  run: (context: ScriptContext, args: A) => TypedResults[K];
}): TypedScriptHandler {
  const entry: TypedEntry<A, TypedResults[K]> = { name, parse: handler.parse, run: handler.run };
  const shim: ScriptHandler = (context, args) => resultCodecs[name].encode(handler.run(context, handler.parse(args)));
  return Object.assign(shim, { typed: entry as TypedEntry }) as TypedScriptHandler;
}

/**
 * The typed half of a registered handler, or `undefined` when something else
 * answers to this name -- a test stub, or the parity harness's literal
 * dependency. Those speak JSON and have to be decoded.
 */
function typedEntry(handler: ScriptHandler, name: string): TypedEntry | undefined {
  const entry = (handler as Partial<TypedScriptHandler>).typed;
  return entry !== undefined && entry.name === name ? entry : undefined;
}

/**
 * One definition of what a typed call does, used by the engine and by the test
 * context so a stub cannot behave differently in the two.
 *
 * `invoke` wraps only the handler call, never the decode: the engine passes its
 * own dispatch there (the `scriptRuns` entry, the parity hooks and the depth
 * guard), and a decode failure must surface in the caller's frame, after
 * `afterScript`, exactly where the lenient result reads it replaces used to
 * raise.
 */
export function typedDispatch<K extends TypedName>(
  name: K,
  handler: ScriptHandler,
  context: ScriptContext,
  args: JsonObject,
  invoke: <T>(call: () => T) => T = call => call(),
): TypedResults[K] {
  const entry = typedEntry(handler, name);
  if (entry === undefined) {
    const decode = resultCodecs[name].decode;
    if (decode === undefined) {
      throw new Error(`${name} was answered by a JSON-returning handler, but its result has no decoder. `
        + `Register the stub with typed('${name}', ...) so it returns the real type, or add a decode to resultCodecs.${name}.`);
    }
    return decode(invoke(() => handler(context, args)), name);
  }
  // Sound by construction: `typed()` is the only way to build a TypedEntry and
  // it ties `run`'s return type to `TypedResults[K]`. The entry is stored erased
  // because the table dispatches by name, so the pair cannot be known here.
  return invoke(() => entry.run(context, entry.parse(args))) as TypedResults[K];
}
