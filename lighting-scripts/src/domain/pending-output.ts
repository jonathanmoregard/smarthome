import type { Verbatim } from '../runtime/verbatim.ts';
import type { StoredFact } from '../parse/overrides.ts';
import { entriesOf } from './types/ids.ts';
import type { RoomId } from './types/ids.ts';

/** The output facts the pending-output recovery compares, each as stored (compared by identity). */
export interface PendingOutput {
  fullVersion: StoredFact;
  handledFull: StoredFact;
  pendingRooms: Readonly<Record<RoomId, Verbatim>>;
  handledRooms: Readonly<Record<RoomId, Verbatim>>;
}
/** Output is dirty when the last full render or any pending room was not handled. */
export function pendingOutputDirty(output: PendingOutput): boolean {
  return output.fullVersion !== output.handledFull
    || entriesOf(output.pendingRooms).some(([room, version]) => version !== output.handledRooms[room]);
}
