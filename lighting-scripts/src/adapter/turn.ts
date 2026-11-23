/**
 * The adapter's turn as a script handler: every input name runs here. The
 * name and arguments are read into an input, `handleInput` makes the turn,
 * and its outputs become the Home Assistant calls the host (or the parity
 * harness) carries out. The adapter's state lives in this process.
 *
 * A wake the turn asks for is one scheduled `ls_wake`, and only when it falls
 * before the next minute's tick, which wakes the loop anyway: a wake hours
 * away would otherwise be a task the harness runs at once.
 */
import type { JsonObject, JsonValue } from './ha-client.ts';
import type { ScriptContext, ScriptHandler } from '../runtime/context.ts';
import { perform } from '../runtime/effects.ts';
import type { Effect } from '../runtime/effects.ts';
import { toInstant } from './codecs/ids.ts';
import { timestamp } from './codecs/accessors.ts';
import { mqttPublishCall, publishCall, switchCall } from './encode.ts';
import { haInput } from './inputs.ts';
import { handleInput } from './loop.ts';
import type { AdapterState, Output } from './loop.ts';
import type { HelperValue } from './codecs/remote-helpers.ts';
import type { Instant } from '../domain/types/time.ts';

/** The adapter's state between turns; none before the process's first input. */
let state: AdapterState | undefined;

/** Start as a fresh process does: the next input reads the Model from Home Assistant and believes nothing sent. */
export function forgetAdapterState(): void {
  state = undefined;
}

/** The scheduled script a wake runs. */
export const WAKE = 'ls_wake';

/** The minute's tick: what wakes the loop without a scheduled wake. */
const TICK_SECONDS = 60;

/**
 * The handler for an input name: the turn, its outputs performed in order, its
 * wake scheduled. A name that is not an input, a dry run, or an input that
 * cannot be read, is logged once and dropped; the loop goes on.
 */
export function turnHandler(name: string): ScriptHandler {
  return (ctx: ScriptContext, args: JsonObject): JsonValue => {
    // A dry run asks and changes nothing. Home Assistant's bridge never forwards one; the old scripts answered it.
    if (args.dry_run === true) {
      console.error(`lighting: ${name} is a dry run; dropped`);
      return null;
    }
    const input = haInput(name, args);
    if (input === undefined) {
      console.error(`lighting: ${name} is not an input; dropped`);
      return null;
    }
    const turn = handleInput(state, ctx, input);
    state = turn.state;
    if (turn.dropped !== undefined) console.error(`lighting: ${name}: ${turn.dropped}; dropped`);
    // A bulb given up on is most often switched off at the wall: logged once, at info level (owner, 2026-11-20).
    for (const bulb of turn.parked) {
      console.info(`lighting: ${bulb} is parked: it does not take what it is sent; left until it comes back on or its light changes`);
    }
    const now = toInstant(timestamp(ctx.now));
    for (const output of turn.outputs) perform(ctx, effectOf(output, now));
    const tick = Math.floor(now / TICK_SECONDS) * TICK_SECONDS + TICK_SECONDS;
    if (turn.wakeAt !== undefined && turn.wakeAt < tick) {
      ctx.scheduled = ctx.scheduled === undefined ? [] : ctx.scheduled.filter(task => task.script !== WAKE);
      perform(ctx, { kind: 'schedule', script: WAKE, args: {}, delayMs: Math.max(0, Math.round((turn.wakeAt - now) * 1000)) });
    }
    return null;
  };
}

/** An output as the Home Assistant call that carries it out. */
function effectOf(output: Output, now: Instant): Effect {
  switch (output.kind) {
    case 'publish': return { kind: 'service', ...publishCall(output.publish) };
    case 'switch': return { kind: 'service', ...switchCall(output.switch, output.power) };
    case 'sensor': return { kind: 'service', service: 'variable.update_sensor', target: { entity_id: output.write.entity },
      data: { value: output.write.revision, attributes: output.write.attributes, replace_attributes: false } };
    case 'helper': return helperEffect(output.write.entity, output.write.value, now);
    case 'store': return { kind: 'service', service: 'input_text.set_value', data: { value: output.write.text },
      target: { entity_id: output.write.entity } };
    case 'dashboard': {
      const write = output.write;
      switch (write.kind) {
        case 'block selector': return { kind: 'service', service: 'input_select.select_option', data: { option: write.option },
          target: { entity_id: write.entity } };
        case 'mode mirror': return { kind: 'service', service: `input_boolean.turn_${write.on ? 'on' : 'off'}`, data: {},
          target: { entity_id: write.entity } };
        case 'control sync': case 'discovery': return { kind: 'service', ...mqttPublishCall(write.topic, write.payload, true) };
      }
    }
  }
}

/** A remote helper's write, as the gesture script made it: a value set, or the chord timer started or cancelled. */
function helperEffect(entity: string, value: HelperValue, now: Instant): Effect {
  const target = { entity_id: entity };
  switch (value.kind) {
    case 'number': return { kind: 'service', service: 'input_number.set_value', data: { value: value.value }, target };
    case 'text': return { kind: 'service', service: 'input_text.set_value', data: { value: value.value }, target };
    case 'timer': return value.running
      ? { kind: 'service', service: 'timer.start', data: { duration: duration(value.until - now) }, target }
      : { kind: 'service', service: 'timer.cancel', data: {}, target };
  }
}

/** A timer's duration in whole seconds, as `HH:MM:SS`: the chord's three seconds are `00:00:03`. */
function duration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const two = (part: number) => `${part}`.padStart(2, '0');
  return `${two(Math.floor(whole / 3600))}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}`;
}
