// Exported functions with no return annotation: the type they return is part
// of the signature as much as a written one.
declare const brand: unique symbol;
type Room = string & { readonly [brand]: 'Room' };

interface Lamp {
  on: boolean;
}

/** Inferred `string`: a site. */
export function lampName() {
  return String(1);
}

/** An arrow's inferred `string`: a site. */
export const roomOf = () => 'kitchen'.toUpperCase();

/** An inferred object whose field is a plain `number`: a site at that field. */
export function lampView() {
  return { level: Math.round(3.2), on: true };
}

/** A branded id is not plain text. */
export function brandedRoom(raw: Room) {
  return raw;
}

/** A literal is a closed set of one. */
export function literalKind() {
  return 'lamp' as const;
}

/** A named type is read where it is declared. */
export function namedLamp() {
  const lamp: Lamp = { on: true };
  return lamp;
}
