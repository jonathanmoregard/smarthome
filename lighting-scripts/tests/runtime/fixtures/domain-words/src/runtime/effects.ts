export interface HouseView {
  get(entity: string): string;
  attr(entity: string, name: string): number | undefined;
}
export type Plan<R> = Generator<object, R, void>;
