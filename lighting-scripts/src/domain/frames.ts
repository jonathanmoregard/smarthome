import type { ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, withParsedArgs } from '../runtime/parse.ts';
import { roundEven } from './scale.ts';

function modulo(value: number, period: number): number {
  const remainder = value % period;
  return remainder < 0 ? remainder + period : remainder;
}

/** Pure frame renderers; transport owns which channels are emitted on each tick. */
export const frameHandlers: ScriptHandlers = {
  // Both renderers apply float to numeric inputs. Their transition default is
  // absent-only, followed by float, so explicit null becomes float's zero.
  effect_breathe_frame: withParsedArgs({
    parse: args => ({
      timestamp: jinjaFloat(args.timestamp),
      brightness: jinjaFloat(args.brightness),
      transition: args.transition === undefined ? 0.4 : jinjaFloat(args.transition),
    }),
    run: (_ctx, args) => {
    const q = modulo(args.timestamp, 6) / 3;
    const x = q <= 1 ? q : 2 - q;
    return { brightness: roundEven(Math.max(1, args.brightness * (0.35 + 0.65 * x))), transition: args.transition };
    },
  }),
  effect_colour_loop_frame: withParsedArgs({
    parse: args => ({
      timestamp: jinjaFloat(args.timestamp),
      transition: args.transition === undefined ? 0.4 : jinjaFloat(args.transition),
    }),
    run: (_ctx, args) => {
    const h = modulo(args.timestamp, 30) / 5;
    const sector = Math.trunc(h);
    const x = roundEven(255 * (h - sector));
    const colors = [[255, x, 0], [255 - x, 255, 0], [0, 255, x], [0, 255 - x, 255], [x, 0, 255], [255, 0, 255 - x]];
    return { rgb: colors[sector] ?? [255, 0, 0], transition: args.transition };
    },
  }),
};
