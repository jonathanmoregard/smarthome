export interface HouseView {
  get(entity: string): string;
  attr(entity: string, name: string): number | undefined;
  now: string;
  state: Record<string, string>;
}
export type Plan<R> = Generator<object, R, void>;
