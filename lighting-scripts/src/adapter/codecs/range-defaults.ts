/**
 * The range defaults codec: the house's bright and cosy ranges, read from the
 * dashboard's four range helpers (`input_number.ls_range_<profile>_<end>`) as
 * today's `switch_lamps_validate_house_defaults` reads them. Each end is the
 * helper's state as a number (`Number`, so an empty state is 0); a range is
 * read only when both ends are percents and the low end is not above the high.
 */
import type { RangeDefaults } from '../../domain/model.ts';
import type { PercentRange } from '../../domain/types/light.ts';
import { percentRangeOf } from '../../parse/ids.ts';
import type { EntityState } from '../../runtime/context.ts';

/** The house's range defaults; none unless both ranges read. */
export function decodeRangeDefaults(states: Readonly<Record<string, EntityState>>): RangeDefaults | undefined {
  const bright = rangeOf(states, 'bright'), cosy = rangeOf(states, 'cosy');
  return bright === undefined || cosy === undefined ? undefined : { bright, cosy };
}

function rangeOf(states: Readonly<Record<string, EntityState>>, profile: 'bright' | 'cosy'): PercentRange | undefined {
  const end = (bound: 'min' | 'max') => {
    const helper = states[`input_number.ls_range_${profile}_${bound}`];
    return helper === undefined ? undefined : Number(helper.state);
  };
  return percentRangeOf(end('min'), end('max'));
}
