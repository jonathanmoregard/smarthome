import type { Remote } from '../parse/remote.ts';

// Not exported itself, but reached through `lampLevel`'s parameter.
interface Lamp {
  level: number;
  remote: Remote;
}

export function lampLevel(lamp: Lamp): void {
  void lamp;
}
