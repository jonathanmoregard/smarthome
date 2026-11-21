declare const room: unique symbol;
export type RoomId = string & { readonly [room]: 'RoomId' };

// A cast to a type parameter declared here is not a cast to a domain type (`entriesOf`'s shape).
export function keysOf<K extends string>(record: Readonly<Record<K, unknown>>): K[] {
  return Object.keys(record) as K[];
}
