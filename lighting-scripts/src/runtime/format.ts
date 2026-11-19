/**
 * How the edges spell typed values as text.
 *
 * The lighting domain decides a value; writing it as a Home Assistant state
 * string or as an MQTT payload field is the transport's concern, so the
 * conversion lives here rather than as a bare `String(...)` in domain logic.
 * Both use JavaScript's own number-to-text conversion -- `"128"`, `"0.5"`,
 * never `"128.0"` -- which is what these sites have always sent. Neither is a
 * parse: the input is already typed.
 */

/** A helper entity's new state, as `ctx.put` records it. */
export function stateText(value: string | number): string {
  return String(value);
}

/** A number in a UI proxy's MQTT state message. */
export function payloadNumber(value: number): string {
  return String(value);
}

/**
 * A float as Python's `str()` writes it -- an integral value keeps its `.0`
 * (`1.0`, not `1`) -- for the schedule's debug lines, which the oracle renders
 * from a Python float.
 */
export function pythonFloatText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
