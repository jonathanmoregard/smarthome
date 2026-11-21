declare const brand: unique symbol;
export type RoomId = string & { readonly [brand]: 'RoomId' };
export type LampId = string & { readonly [brand]: 'LampId' };

export function entriesOf<K extends string, V>(record: Readonly<Record<K, V>>): [K, V][] {
  // Cast: the keys are the key type by construction.
  return Object.entries(record) as [K, V][];
}
