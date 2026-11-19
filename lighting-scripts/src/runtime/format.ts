/**
 * How the edges spell typed values as text.
 *
 * The lighting domain decides a value; how it is written as text for a log
 * line, a Home Assistant state or an MQTT payload is the transport's concern,
 * so the conversion lives here rather than as a bare `String(...)` in domain
 * logic. None of these is a parse: every input is already typed.
 */

/**
 * A float as Python's `str()` writes it -- an integral value keeps its `.0`
 * (`1.0`, not `1`) -- for the schedule's debug lines, which the oracle renders
 * from a Python float.
 */
export function pythonFloatText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}
