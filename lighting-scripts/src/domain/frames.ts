import { createHash } from 'node:crypto';
import type { ScriptHandlers } from '../runtime/context.ts';
import { jinjaFloat, jinjaInt, jinjaString, withParsedArgs } from '../runtime/parse.ts';
import { roundEven } from './scale.ts';

function modulo(value: number, period: number): number {
  const remainder = value % period;
  return remainder < 0 ? remainder + period : remainder;
}

/** Pure frame renderers; transport owns which channels are emitted on each tick. */
export const frameHandlers: ScriptHandlers = {
  // Captured timestamp/brightness/transition use float/int filters; phase has
  // default('default'), which replaces Undefined but preserves explicit null.
  effect_candle_frame: withParsedArgs({
    parse: args => ({
      timestamp: jinjaFloat(args.timestamp),
      phase: jinjaString(args.phase === undefined ? 'default' : args.phase),
      brightness: jinjaInt(args.brightness, 150),
      transition: jinjaFloat(args.transition, 0.2),
    }),
    run: (ctx, args) => {
    const frame = Math.trunc(args.timestamp / 0.15);
    let sample = 28 * 0.35 ** 6;
    for (let i = 0; i < 6; i++) {
      const seed = createHash('sha256').update(`${frame - i}:${args.phase}:research-v2`).digest('hex');
      const raw = 20 + parseInt(seed.slice(0, 8), 16) % 17;
      sample += 0.65 * 0.35 ** i * raw;
    }
    const noise = jinjaFloat(ctx.get('input_number.candle_test_noise'), 0.8);
    const ceiling = Math.max(1, Math.min(254, args.brightness));
    const floor = Math.max(1, roundEven(ceiling / 4));
    const level = Math.max(floor, Math.min(ceiling, roundEven(ceiling * (28 + noise * (sample - 28)) / 36)));
    const warm = ctx.attr('light.candle_test_rgb_warm_end', 'rgb_color');
    return { brightness: level, rgb: Array.isArray(warm) && warm.length > 0 ? warm : [255, 126, 0], transition: args.transition };
    },
  }),
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
