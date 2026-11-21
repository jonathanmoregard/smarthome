// Out of scope: src/runtime is the adapter, which writes wire text.
export function wire(value: unknown): string {
  return String(value) + `${value}`;
}
