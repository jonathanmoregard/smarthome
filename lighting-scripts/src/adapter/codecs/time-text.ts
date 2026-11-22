/**
 * Date text as the stores keep it, to the microsecond: Home Assistant orders
 * entries by microseconds, and the scripts' `now` carries six fractional
 * digits, which a reader comparing the text (the power token) needs exactly.
 */
import type { Instant } from '../../domain/types/time.ts';

/** Date text as seconds since the epoch, microseconds kept; none when it is not a date. */
export function dateSeconds(text: string): number | undefined {
  const fraction = /(?:T| )\d{2}:\d{2}:\d{2}\.(\d+)/.exec(text)?.[1];
  const parsed = Date.parse(fraction === undefined ? text : text.replace(/(\d{2}:\d{2}:\d{2})\.\d+/, '$1'));
  return Number.isNaN(parsed) ? undefined : parsed / 1000 + (fraction === undefined ? 0 : Number(`0.${fraction.slice(0, 6)}`));
}

/** An instant as the scripts' `now` reads: UTC, six fractional digits, `Z` (`src/runtime/host.ts`). */
export function nowText(instant: Instant): string {
  let whole = Math.floor(instant), micros = Math.round((instant - whole) * 1e6);
  if (micros === 1e6) { whole += 1; micros = 0; }
  return `${new Date(whole * 1000).toISOString().slice(0, 19)}.${String(micros).padStart(6, '0')}Z`;
}
