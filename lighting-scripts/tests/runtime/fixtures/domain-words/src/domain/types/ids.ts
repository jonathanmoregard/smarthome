declare const room: unique symbol;
export type RoomId = string & { readonly [room]: 'RoomId' };
