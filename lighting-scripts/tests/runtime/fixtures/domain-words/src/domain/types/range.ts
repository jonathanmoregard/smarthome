declare const level: unique symbol;
export type Level = number & { readonly [level]: 'Level' };

// A minting site: an `...OrThrow` range constructor. Its cast is not counted, as a cast or as a brand constructor.
export function levelOrThrow(raw: number): Level {
  if (raw < 1 || raw > 254) throw new RangeError(`level ${raw}`);
  return raw as Level;
}
