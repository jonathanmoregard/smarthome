/**
 * What the Sara mode switch does to the Sara overlay: set it when it is
 * wanted and not active, clear it when it is active and not wanted, and
 * nothing when the switch would not change it.
 */
export function saraModeChange(wanted: boolean, active: boolean): 'set' | 'clear' | undefined {
  if (wanted === active) return undefined;
  return wanted ? 'set' : 'clear';
}
