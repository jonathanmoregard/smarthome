// One exported site: `lampOf`'s parameter is typed as plain text.
export function lampOf(room: string): void {
  // A keyword inside a body is not part of the signature.
  const local: number = 1;
  void room;
  void local;
}

// Not exported, so not part of the domain's surface.
function count(times: number): number {
  return times;
}

export function counted(): void {
  void count;
}
