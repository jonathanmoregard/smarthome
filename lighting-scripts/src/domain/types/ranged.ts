/**
 * The mark a number held to a range carries. The constructors that put it on are in `./range.ts`; the types that
 * carry it import only this file, so none of them imports its constructor's module back.
 */
declare const range: unique symbol;
export type Ranged<Name extends string> = number & { readonly [range]: Name };
/** The same mark on a value that is not a number (`PercentRange`). */
export type RangeMark<Name extends string> = { readonly [range]: Name };
