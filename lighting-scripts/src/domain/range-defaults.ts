/** A house range default holds when its bounds are in order inside 0..100. */
export function isRangeDefault(low: number, high: number): boolean {
  return 0 <= low && low <= high && high <= 100;
}
