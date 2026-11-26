import type { RoomId } from '../../domain/types/ids.ts';

// Inside the codecs, building a brand is the parser's job and is not counted.
export function roomId(raw: string): RoomId {
  return raw as RoomId;
}
