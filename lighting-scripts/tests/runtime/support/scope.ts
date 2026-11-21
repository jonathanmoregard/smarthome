import type { OutputScope } from '../../../src/runtime/host.ts';

/**
 * For host tests about something other than rooms: the process owns all of
 * its output and keeps nothing to itself. Production builds its scope from
 * the required `--live-rooms` list (`src/runtime/live-rooms.ts`).
 */
export const sendsAll: OutputScope = { origin: () => ({ kind: 'house' }), share: call => [call], keeps: () => false };
