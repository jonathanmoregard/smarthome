/**
 * A number held to a range. Each range type is built only by its constructor
 * in `src/parse/ids.ts`, which checks the range, so a value of the type is in
 * range by construction and the domain never re-checks it.
 */
declare const range: unique symbol;
export type Ranged<Name extends string> = number & { readonly [range]: Name };
/** The same mark on a value that is not a number (`PercentRange`). */
export type RangeMark<Name extends string> = { readonly [range]: Name };
