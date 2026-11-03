import type { JsonValue } from '../runtime/context.ts';
import type { TypedResults } from '../runtime/entrypoints.ts';
import type { SwitchDecision, SwitchPlanResult } from '../domain/controller.ts';
import { ParseError, requireArray, requireBoolean, requireFinite, requireNumber, requireObject, requireString } from '../runtime/parse.ts';

/**
 * The JSON edge of one converted entrypoint's result.
 *
 * `encode` serves the name-keyed shim: Home Assistant and the parity harness
 * compare these bytes, so it must reproduce exactly what the handler returned
 * before conversion. Where the domain type is already JSON data -- a type alias
 * of plain fields, which is what criterion 3 made them -- encode is the
 * identity and there is nothing to serialise. That is the goal, not a shortcut:
 * a representation that needs converting is a representation that can drift.
 *
 * `decode` is the reverse, and runs **only** when a name-keyed override answers
 * instead of the registered handler: a unit test's stub, or the parity
 * harness's literal `ls_plan` dependency. The real handler's result never
 * passes through it.
 *
 * `decode` is therefore **optional**, and leaving it out is a real choice
 * rather than laziness. Write one where it is cheap and catches a stub that has
 * drifted from the shape it stands in for. Leave it out where the result type
 * is rich enough that a faithful decoder would be a second implementation of
 * the handler's output format -- `GradientCurve` is forty lines of structure
 * whose only JSON-returning stub is `{gradients: {}}`, and a decoder that
 * accepted that and nothing else would be theatre. Without one, a
 * JSON-returning override gets a precise error naming the two ways forward, so
 * the gap cannot pass silently.
 */
export interface ResultCodec<R> {
  encode(result: R): JsonValue;
  decode?(value: JsonValue, context: string): R;
}

function decodeSwitchDecision(value: JsonValue, context: string): SwitchDecision {
  const entry = requireObject({ value }, 'value', context);
  const range = requireArray(entry, 'range', context);
  if (range.length !== 2) throw new ParseError(`${context}.range must have two elements, got ${range.length}`);
  return {
    on: requireBoolean(entry.on, `${context}.on`),
    room: requireString(entry, 'room', context),
    brightness: requireNumber(entry, 'brightness', context),
    range: [requireFinite(range[0], `${context}.range.0`), requireFinite(range[1], `${context}.range.1`)],
  };
}

/**
 * Stricter than the two call sites it replaces, deliberately and only on the
 * stub path.
 *
 * `ls_plan` raised on a missing `switches` (`requireObject`) while
 * `ls_room_plan` defaulted it to `{}`, so no single reader reproduces both. The
 * difference was unreachable for the real handler -- `switchPlan` always
 * returns `{switches}` and builds every field itself -- so it could only ever
 * have fired for a stub, and the strict reading is the one that catches a stub
 * that has drifted from the shape it stands in for.
 */
function decodeSwitchPlan(value: JsonValue, context: string): SwitchPlanResult {
  const result = requireObject({ value }, 'value', context);
  const switches = requireObject(result, 'switches', context);
  return {
    switches: Object.fromEntries(Object.entries(switches)
      .map(([entity, entry]) => [entity, decodeSwitchDecision(entry, `${context}.switches.${entity}`)])),
  };
}

/**
 * One codec per converted entrypoint.
 *
 * The mapped type is the completeness check: adding a name to
 * {@link TypedResults} breaks this declaration until its codec is written, so
 * the typed surface cannot grow a member that the JSON edge cannot serve.
 */
export const resultCodecs: { [K in keyof TypedResults]: ResultCodec<TypedResults[K]> } = {
  ls_switch_plan: { encode: result => result, decode: decodeSwitchPlan },
  // No decoder: a `ResolvedTarget` is `JsonObject`/`JsonValue` fields plus one
  // string, so a decoder could only check that nine keys are present -- and the
  // three stubs that stand in for this entrypoint declare their shape through
  // `typed()` instead, which states the same thing where a reader will see it.
  effects_resolve: { encode: result => result },
  // No decoder, for the opposite reason: `GradientCurve` is a deep structure
  // and its only JSON stub is `{gradients: {}}`.
  effects_gradient_plan: { encode: result => result },
};
