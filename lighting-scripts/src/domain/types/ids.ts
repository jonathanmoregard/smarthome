/**
 * Identifiers. Each one names a thing; it is not text to read. Swapping every
 * id for a UUID would change nothing the domain does, so each gets its own
 * type, and one kind of id cannot be passed where another is expected.
 *
 * The constructors live only in `src/parse/ids.ts`, and only the parse steps
 * call them. They check nothing: an id is branded where the edge reads it.
 */
declare const brand: unique symbol;
export type Id<Name extends string> = string & { readonly [brand]: Name };

/** A room: Home Assistant's area id (`kitchen`). */
export type RoomId = Id<'RoomId'>;
/** A lamp: the logical light the catalog's `members` names (`light.lamp`). */
export type LampId = Id<'LampId'>;
/** A bulb: one physical member of a lamp (`light.lamp_1`). */
export type BulbId = Id<'BulbId'>;
/** A switch: a switched socket's entity (`switch.plug`). */
export type SwitchId = Id<'SwitchId'>;
/** A remote: the remote control's Home Assistant device id. */
export type RemoteId = Id<'RemoteId'>;
/** A Home Assistant user, as an event's `user_id` names them. */
export type UserId = Id<'UserId'>;
/** A dashboard control: one control whose lamp overlay it sets, one overlay per control. */
export type DashboardControlId = Id<'DashboardControlId'>;
/**
 * A remote's source, as its input's overlay key carries it
 * (`channels:<source>`). Never begins `ui:` or `native:`, the prefixes of a
 * dashboard or native control's key, so the key reads back as the remote's.
 * Unlike the other ids, its constructor checks that.
 */
export type RemoteSource = Id<'RemoteSource'>;


/**
 * `Object.entries` with the record's own key type. `Object.entries` widens
 * every key to `string`, so a `Record<RoomId, ...>` would hand back plain
 * text; the keys of a record typed by its id are those ids.
 */
export function entriesOf<K extends string, V>(record: Readonly<Record<K, V>>): [K, V][] {
  // Cast: the record's keys are its key type by construction; Object.entries only forgets it.
  return Object.entries(record) as [K, V][];
}
