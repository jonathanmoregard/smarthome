"""End-state comparator, on synthetic checkpoints only."""
from __future__ import annotations
from dataclasses import replace
from datetime import datetime
import unittest

from tests.e2e.codec import Checkpoint
from tests.e2e.compare import (KELVIN_FAMILY, KELVIN_K, LEVEL_BAND, LEVEL_STEPS, MID_FADE_LEVEL_PCT, TICK, XY_DISTANCE,
                               XY_FAMILY, Difference, ExpectedWindow, FadeIntoCandleColour, FadeOffToOnGradual, compare,
                               compare_flow, planckian_xy)
from tests.e2e.router import LOCAL
from tests.e2e.scenarios import Proof, Scenario
from tests.e2e.world import Kelvin, Off, On, Rgb


def on(level=200, colour=Kelvin(2700), effect='none'):
    return On(level=level, colour=colour, effect=effect)


def checkpoint(step=0, t=0.0, bulbs=None, switches=None, dashboard=None, in_fade=(), not_ported=()):
    return Checkpoint(step=step, t=t, bulbs={'bulb_a': on()} if bulbs is None else bulbs,
                      switches={} if switches is None else switches, dashboard={} if dashboard is None else dashboard,
                      in_fade=frozenset(in_fade), not_ported=tuple(not_ported))


def bulb(state, **kwargs):
    return checkpoint(bulbs={'bulb_a': state}, **kwargs)


def fields(result):
    return [(d.subject, d.field) for d in result.differences]


def adjustment(name, claimed, applies=True):
    class Fake:
        fields = frozenset(claimed)

        def applies(self, history, at, subject):
            return applies
    Fake.name = name
    return Fake()


class Tolerances(unittest.TestCase):
    def test_equal_within_tolerances(self):
        ref = bulb(on(level=200, colour=Kelvin(2700)))
        port = bulb(on(level=200 + LEVEL_STEPS, colour=Kelvin(2700 + KELVIN_K)))
        self.assertEqual(compare([ref], [port]).differences, ())

    def test_level_off_by_3_is_a_difference(self):
        result = compare([bulb(on(level=200))], [bulb(on(level=203))])
        self.assertEqual(result.differences, (Difference(0, 0.0, 'bulb_a', 'level', 200, 203),))

    def test_mid_fade_uses_one_percent(self):
        self.assertEqual(MID_FADE_LEVEL_PCT, 1)
        self.assertEqual(compare([bulb(on(level=200), in_fade={'bulb_a'})],
                                 [bulb(on(level=202), in_fade={'bulb_a'})]).differences, ())
        self.assertEqual(fields(compare([bulb(on(level=200), in_fade={'bulb_a'})],
                                        [bulb(on(level=204), in_fade={'bulb_a'})])), [('bulb_a', 'level')])

    def test_mid_fade_applies_when_only_one_side_is_fading(self):
        result = compare([bulb(on(level=200), in_fade={'bulb_a'})], [bulb(on(level=202))])
        self.assertEqual(result.differences, ())

    def test_kelvin_51_apart_differs(self):
        result = compare([bulb(on(colour=Kelvin(2700)))], [bulb(on(colour=Kelvin(2700 + KELVIN_K + 1)))])
        self.assertEqual(fields(result), [('bulb_a', 'colour')])

    def test_rgb_xy_distance(self):
        red = Rgb(255, 0, 0)
        self.assertEqual(compare([bulb(on(colour=red))], [bulb(on(colour=Rgb(255, 2, 0)))]).differences, ())
        self.assertEqual(fields(compare([bulb(on(colour=red))], [bulb(on(colour=Rgb(255, 40, 0)))])),
                         [('bulb_a', 'colour')])
        self.assertGreater(XY_DISTANCE, 0)

    def test_black_rgb_does_not_divide_by_zero(self):
        self.assertEqual(compare([bulb(on(colour=Rgb(0, 0, 0)))], [bulb(on(colour=Rgb(0, 0, 0)))]).differences, ())

    def test_kelvin_vs_rgb_is_a_difference(self):
        result = compare([bulb(on(colour=Kelvin(6500)))], [bulb(on(colour=Rgb(255, 255, 255)))])
        self.assertEqual(fields(result), [('bulb_a', 'colour')])

    def test_colour_absent_on_one_side_is_a_difference(self):
        self.assertEqual(fields(compare([bulb(on(colour=None))], [bulb(on())])), [('bulb_a', 'colour')])
        self.assertEqual(compare([bulb(on(colour=None))], [bulb(on(colour=None))]).differences, ())

    def test_effect_differs(self):
        self.assertEqual(fields(compare([bulb(on(effect='none'))], [bulb(on(effect='candle'))])), [('bulb_a', 'effect')])

    def test_off_vs_on_differs(self):
        result = compare([bulb(Off())], [bulb(on())])
        self.assertEqual(result.differences, (Difference(0, 0.0, 'bulb_a', 'power', 'off', 'on'),))
        self.assertEqual(compare([bulb(Off())], [bulb(Off())]).differences, ())


class Alignment(unittest.TestCase):
    def test_missing_checkpoint_differs(self):
        both = checkpoint(step=0, t=0.0)
        extra = checkpoint(step=1, t=30.0)
        result = compare([both, extra], [both])
        self.assertEqual(result.differences, (Difference(1, 30.0, 'checkpoint', 'checkpoint', 'present', None),))
        result = compare([both], [both, extra])
        self.assertEqual(result.differences, (Difference(1, 30.0, 'checkpoint', 'checkpoint', None, 'present'),))

    def test_same_step_different_t_is_not_aligned(self):
        result = compare([checkpoint(step=1, t=10.0)], [checkpoint(step=1, t=20.0)])
        self.assertEqual(len(result.differences), 2)

    def test_bulb_missing_on_one_side_differs(self):
        result = compare([checkpoint(bulbs={'bulb_a': on(), 'bulb_b': on()})], [checkpoint(bulbs={'bulb_a': on()})])
        self.assertEqual(fields(result), [('bulb_b', 'bulb')])

    def test_switches_and_dashboard(self):
        ref = checkpoint(switches={'plug_x': 'on'}, dashboard={'switch_ranges': 1, 'range_defaults': 2})
        port = checkpoint(switches={'plug_x': 'off'}, dashboard={'switch_ranges': 1, 'range_defaults': 3})
        result = compare([ref], [port])
        self.assertEqual(sorted(fields(result)), [('dashboard', 'range_defaults'), ('plug_x', 'power')])


class Reporting(unittest.TestCase):
    def test_not_ported_counted(self):
        port = [checkpoint(step=0, t=0.0, not_ported=('automation_a',)),
                checkpoint(step=1, t=1.0, not_ported=('automation_a', 'automation_b')),
                # a fade gives several checkpoints for one step: the same miss is not counted again
                checkpoint(step=1, t=2.0, not_ported=('automation_a', 'automation_b'))]
        ref = [checkpoint(step=0, t=0.0), checkpoint(step=1, t=1.0), checkpoint(step=1, t=2.0)]
        self.assertEqual(dict(compare(ref, port).not_ported), {'automation_a': 2, 'automation_b': 1})

    def test_adjustment_counts_and_suppresses_only_its_fields(self):
        ref = [checkpoint(step=0, t=0.0, bulbs={'bulb_a': on(level=50)}),
               checkpoint(step=1, t=1.0, bulbs={'bulb_a': on(level=50)})]
        port = [checkpoint(step=0, t=0.0, bulbs={'bulb_a': on(level=50, effect='candle')}),
                checkpoint(step=1, t=1.0, bulbs={'bulb_a': on(level=50)})]
        result = compare(ref, port, [adjustment('candle', {'effect'})])
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'candle': 1})
        self.assertEqual(fields(compare(ref, port)), [('bulb_a', 'effect')])

    def test_adjustment_leaves_other_fields_on_the_same_bulb_reported(self):
        ref = [checkpoint(bulbs={'bulb_a': on(level=50, colour=Kelvin(2700), effect='none')})]
        port = [checkpoint(bulbs={'bulb_a': on(level=90, colour=Kelvin(4000), effect='candle')})]
        result = compare(ref, port, [adjustment('candle', {'effect'})])
        self.assertEqual(fields(result), [('bulb_a', 'level'), ('bulb_a', 'colour')])
        self.assertEqual(dict(result.adjustments), {'candle': 1})

    def test_two_adjustments_on_different_fields_both_count(self):
        ref = [checkpoint(bulbs={'bulb_a': on(level=50, effect='none')})]
        port = [checkpoint(bulbs={'bulb_a': on(level=90, effect='candle')})]
        result = compare(ref, port, [adjustment('one', {'effect'}), adjustment('two', {'level'})])
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'one': 1, 'two': 1})

    def test_a_field_claimed_by_two_adjustments_counts_for_both(self):
        ref = [checkpoint(bulbs={'bulb_a': on(effect='none')})]
        port = [checkpoint(bulbs={'bulb_a': on(effect='candle')})]
        result = compare(ref, port, [adjustment('one', {'effect'}), adjustment('two', {'effect'})])
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'one': 1, 'two': 1})

    def test_adjustment_that_does_not_apply_suppresses_nothing(self):
        ref = [checkpoint(bulbs={'bulb_a': on(effect='none')})]
        port = [checkpoint(bulbs={'bulb_a': on(effect='candle')})]
        result = compare(ref, port, [adjustment('never', {'effect'}, applies=False)])
        self.assertEqual(fields(result), [('bulb_a', 'effect')])
        self.assertEqual(dict(result.adjustments), {})

    def test_power_adjustment_claims_the_power_difference(self):
        result = compare([bulb(Off())], [bulb(on())], [adjustment('p', {'power'})])
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'p': 1})

    def test_adjustment_does_not_count_when_nothing_differs(self):
        class Always:
            name = 'always'
            fields = frozenset({'effect'})

            def applies(self, history, at, subject):
                return True

        same = [checkpoint()]
        self.assertEqual(dict(compare(same, same, [Always()]).adjustments), {})

    def test_an_adjustment_sees_the_bulbs_history_on_both_sides(self):
        seen = []

        class Recording:
            name = 'recording'
            fields = frozenset({'level'})

            def applies(self, history, at, subject):
                seen.append((subject, at, [(h.step, h.t, h.ref, h.port, h.ref_fading, h.port_fading) for h in history]))
                return False

        ref = [bulb(Off()), checkpoint(step=1, t=60.0, bulbs={'bulb_a': on(level=100)})]
        port = [bulb(Off()), checkpoint(step=1, t=60.0, bulbs={'bulb_a': on(level=50)}, in_fade={'bulb_a'})]
        compare(ref, port, [Recording()])
        self.assertEqual(seen, [('bulb_a', 1, [(0, 0.0, Off(), Off(), False, False),
                                               (1, 60.0, on(level=100), on(level=50), False, True)])])


class PortOnlyCheckpoints(unittest.TestCase):
    def test_a_port_only_tick_after_a_settled_reference_is_still_a_difference(self):
        # The reference's state there is unknown: a settled checkpoint can be stale by the next tick (a pressed plug
        # is put back with no fade, so no sample), so holding it would invent or hide differences.
        ref = [checkpoint(step=0, t=0.0), checkpoint(step=1, t=180.0)]
        port = [checkpoint(step=0, t=0.0), checkpoint(step=1, t=60.0, in_fade={'bulb_a'}), checkpoint(step=1, t=180.0)]
        self.assertEqual(compare(ref, port).differences,
                         (Difference(1, 60.0, 'checkpoint', 'checkpoint', None, 'present'),))


# --- fade-off-to-on-gradual ------------------------------------------------------------------------------

END = 218


def ramp(port_levels, *, ref_before=Off(), ref_level=END, colour=Kelvin(2700), port_colour=None, ref_fading=(),
         after=END):
    """Step 0 both settled; step 1 a fade: the reference at `ref_level`, the port mid-fade at each of `port_levels`
    (None: Off); step 2 both settled at `after` (the port) and `ref_level` (the reference)."""
    port_colour = colour if port_colour is None else port_colour
    ref = [bulb(ref_before)]
    port = [bulb(ref_before)]
    for n, level in enumerate(port_levels):
        t = 60.0 * (n + 1)
        ref.append(checkpoint(step=1, t=t, bulbs={'bulb_a': on(level=ref_level, colour=colour)},
                              in_fade={'bulb_a'} if n in ref_fading else ()))
        port.append(checkpoint(step=1, t=t, bulbs={'bulb_a': Off() if level is None else on(level=level, colour=port_colour)},
                               in_fade={'bulb_a'}))
    t = 60.0 * (len(port_levels) + 1)
    ref.append(checkpoint(step=2, t=t, bulbs={'bulb_a': on(level=ref_level, colour=colour)}))
    port.append(checkpoint(step=2, t=t, bulbs={'bulb_a': on(level=after, colour=colour)}))
    return ref, port


class FadeOffToOn(unittest.TestCase):
    def explained(self, ref, port):
        return compare(ref, port, [FadeOffToOnGradual()])

    def test_explains_a_gradual_ramp_from_off(self):
        result = self.explained(*ramp([1, 60, 120, 180]))
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'fade-off-to-on-gradual': 4})
        self.assertEqual(len(compare(*ramp([1, 60, 120, 180])).differences), 4)

    def test_explains_level_only(self):
        self.assertEqual(FadeOffToOnGradual.fields, frozenset({'level'}))
        self.assertEqual(FadeOffToOnGradual.name, 'fade-off-to-on-gradual')

    def test_not_a_wrong_colour(self):
        result = self.explained(*ramp([1, 60, 120], port_colour=Kelvin(4000)))
        self.assertEqual(sorted(set(fields(result))), [('bulb_a', 'colour'), ('bulb_a', 'level')])
        self.assertEqual(dict(result.adjustments), {})

    def test_not_a_level_above_the_reference(self):
        result = self.explained(*ramp([1, 60, END + 20]))
        self.assertEqual(fields(result), [('bulb_a', 'level')])
        self.assertEqual(dict(result.adjustments), {'fade-off-to-on-gradual': 2})

    def test_not_an_on_to_off_fade(self):
        result = self.explained(*ramp([180, 120, 60], ref_before=on(level=END)))
        self.assertEqual(fields(result), [('bulb_a', 'level')] * 3)

    def test_not_a_ramp_that_did_not_start_from_off(self):
        result = self.explained(*ramp([120, 160, 200], ref_before=on(level=100)))
        self.assertEqual(fields(result), [('bulb_a', 'level')] * 3)

    def test_not_outside_a_fade(self):
        ref, port = ramp([1, 60, 120])
        port = [replace(c, in_fade=frozenset()) for c in port]
        result = self.explained(ref, port)
        self.assertEqual(fields(result), [('bulb_a', 'level')] * 3)

    def test_not_after_the_fade_ends(self):
        result = self.explained(*ramp([1, 60, 120], after=150))
        self.assertEqual(fields(result), [('bulb_a', 'level')])
        self.assertEqual(result.differences[0].step, 2)

    def test_not_while_the_reference_fades_too(self):
        result = self.explained(*ramp([1, 60, 120], ref_fading={1}))
        self.assertEqual([(d.t, d.field) for d in result.differences], [(120.0, 'level')])

    def test_not_a_port_off_mid_window(self):
        result = self.explained(*ramp([1, None, 120]))
        self.assertEqual(fields(result), [('bulb_a', 'level'), ('bulb_a', 'power'), ('bulb_a', 'level')])

    def test_not_a_falling_ramp_from_off(self):
        result = self.explained(*ramp([120, 60, 30]))
        self.assertEqual(fields(result), [('bulb_a', 'level')] * 3)


# --- fade-into-candle-colour -----------------------------------------------------------------------------

WARM = Rgb(255, 126, 0)   # the colour the reference's candle shows
DAY = Kelvin(4505)
PORT_PATH = (Rgb(255, 215, 181), Rgb(255, 200, 150), Rgb(255, 172, 94), Rgb(255, 147, 44))   # the port's own samples
REF_PATH = (Kelvin(4425), Kelvin(4032), Kelvin(3344), Kelvin(2740))   # the reference, towards the block's 2200 K


def into_candle(port_path=PORT_PATH, *, port_end=WARM, ref_end_effect='candle', port_fading=True, port_levels=None,
                port_effect='none', after=WARM):
    """Step 0 both settled in DAY; step 1 the fade into the candle block, a sample a minute: the reference along
    REF_PATH, the port along `port_path` (fading where `port_fading`), at each of `port_levels` (default: the
    reference's 200) with `port_effect`; the last sample is the block start, the reference's candle in WARM
    (`ref_end_effect`) and the port's in `port_end`, both still in their fade; step 2 both settled half an hour on,
    the port in `after`."""
    levels = (200,) * len(port_path) if port_levels is None else port_levels
    fading = {'bulb_a'} if port_fading else set()
    ref, port = [bulb(on(colour=DAY))], [bulb(on(colour=DAY))]
    for n, (ref_colour, port_colour, level) in enumerate(zip(REF_PATH, port_path, levels)):
        t = 60.0 * (n + 1)
        ref.append(checkpoint(step=1, t=t, bulbs={'bulb_a': on(colour=ref_colour)}, in_fade={'bulb_a'}))
        port.append(checkpoint(step=1, t=t, bulbs={'bulb_a': on(level=level, colour=port_colour, effect=port_effect)},
                               in_fade=fading))
    end = 60.0 * (len(port_path) + 1)
    ref.append(checkpoint(step=1, t=end, bulbs={'bulb_a': on(colour=WARM, effect=ref_end_effect)}, in_fade={'bulb_a'}))
    port.append(checkpoint(step=1, t=end, bulbs={'bulb_a': on(colour=port_end, effect='candle')}, in_fade=fading))
    ref.append(checkpoint(step=2, t=end + 1800, bulbs={'bulb_a': on(colour=WARM, effect=ref_end_effect)}))
    port.append(checkpoint(step=2, t=end + 1800, bulbs={'bulb_a': on(colour=after, effect='candle')}))
    return ref, port


CANDLE_BULBS = frozenset({'bulb_a'})


class FadeIntoCandle(unittest.TestCase):
    def explained(self, ref, port, candle_bulbs=CANDLE_BULBS):
        return compare(ref, port, [FadeIntoCandleColour(candle_bulbs)])

    def test_explains_the_fade_into_the_candles_colour(self):
        result = self.explained(*into_candle())
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'fade-into-candle-colour': 4})
        self.assertEqual(fields(compare(*into_candle())), [('bulb_a', 'colour')] * 4)

    def test_explains_a_fade_whose_window_opens_the_history(self):
        # The port's fade run reaches back to the first checkpoint: the fade starts from the colour both show there.
        ref, port = into_candle()
        port[0] = replace(port[0], in_fade=frozenset({'bulb_a'}))
        self.assertEqual(dict(self.explained(ref, port).adjustments), {'fade-into-candle-colour': 4})

    def test_explains_colour_only(self):
        self.assertEqual(FadeIntoCandleColour.fields, frozenset({'colour'}))
        self.assertEqual(FadeIntoCandleColour.name, 'fade-into-candle-colour')

    def test_not_a_level_difference(self):
        result = self.explained(*into_candle(port_levels=(200, 120, 200, 200)))
        self.assertEqual(fields(result), [('bulb_a', 'level')])
        self.assertEqual(dict(result.adjustments), {'fade-into-candle-colour': 4})

    def test_not_a_colour_moving_away_from_the_warm_end(self):
        # The port goes colder than the day before it turns warm: not between the day colour and the warm end.
        away = (Rgb(255, 215, 181), Rgb(225, 230, 255), Rgb(255, 172, 94), Rgb(255, 147, 44))
        self.assertEqual(fields(self.explained(*into_candle(away))), [('bulb_a', 'colour')] * 4)

    def test_not_a_colour_turning_back(self):
        # Between the ends at every sample, but back towards the day colour at the third.
        back = (Rgb(255, 200, 150), Rgb(255, 172, 94), Rgb(255, 215, 181), Rgb(255, 147, 44))
        self.assertEqual(fields(self.explained(*into_candle(back))), [('bulb_a', 'colour')] * 4)

    def test_not_outside_a_port_fade(self):
        self.assertEqual(fields(self.explained(*into_candle(port_fading=False))), [('bulb_a', 'colour')] * 4)

    def test_not_a_bulb_that_cannot_run_the_candle(self):
        result = self.explained(*into_candle(), candle_bulbs=frozenset({'bulb_b'}))
        self.assertEqual(fields(result), [('bulb_a', 'colour')] * 4)

    def test_not_a_fade_that_misses_the_warm_end(self):
        result = self.explained(*into_candle(port_end=Rgb(255, 172, 94)))
        self.assertEqual(fields(result), [('bulb_a', 'colour')] * 5)

    def test_not_a_block_without_the_candle(self):
        result = self.explained(*into_candle(ref_end_effect='none'))
        self.assertEqual(fields(result), [('bulb_a', 'colour')] * 4 + [('bulb_a', 'effect')] * 2)

    def test_not_after_the_fade_ends(self):
        result = self.explained(*into_candle(after=Rgb(255, 172, 94)))
        self.assertEqual([(d.step, d.field) for d in result.differences], [(2, 'colour')])
        self.assertEqual(dict(result.adjustments), {'fade-into-candle-colour': 4})

    def test_a_colour_temperature_sits_on_the_planckian_locus(self):
        # CIE standard illuminant A is a 2856 K black body at (0.44757, 0.40745).
        x, y = planckian_xy(2856)
        self.assertLessEqual(((x - 0.44757) ** 2 + (y - 0.40745) ** 2) ** 0.5, XY_DISTANCE / 10)
        with self.assertRaises(ValueError):
            planckian_xy(1000)


# --- the flow gate ---------------------------------------------------------------------------------------

FLOW_START = datetime(2026, 11, 18, 12, tzinfo=LOCAL)


def scenario(proves=(), holds=()):
    return Scenario('flow_x', FLOW_START, (), (), tuple(proves), tuple(holds))


def flow(reference, port, proves=(), holds=(), expected=(), adjustments=()):
    return compare_flow(reference, port, scenario(proves, holds), expected, adjustments)


def rules(result):
    return [(d.subject, d.field, d.rule) for d in result.flow]


def steps(*states, **kwargs):
    """One settled checkpoint per step, a minute apart, with bulb_a in each of `states`."""
    return [checkpoint(step=n, t=60.0 * n, bulbs={'bulb_a': state}, **kwargs) for n, state in enumerate(states)]


def switched(*states, name='plug_a', other='off'):
    return [checkpoint(step=n, t=60.0 * n, switches={name: state, 'plug_b': other}) for n, state in enumerate(states)]


class FlowRules(unittest.TestCase):
    def test_power_differs_is_flow(self):
        self.assertEqual(rules(flow([bulb(Off())], [bulb(on())])), [('bulb_a', 'power', 'power')])
        self.assertEqual(rules(flow(switched('on'), switched('off'))), [('plug_a', 'power', 'power')])

    def test_kelvin_against_rgb_is_flow(self):
        result = flow([bulb(on(colour=Kelvin(6500)))], [bulb(on(colour=Rgb(255, 255, 255)))])
        self.assertEqual(rules(result), [('bulb_a', 'colour', 'colour')])

    def test_a_lit_bulb_with_no_colour_on_one_side_is_flow(self):
        self.assertEqual(rules(flow([bulb(on(colour=None))], [bulb(on())])), [('bulb_a', 'colour', 'colour')])

    def test_kelvin_within_family_is_noted(self):
        result = flow([bulb(on(colour=Kelvin(2700)))], [bulb(on(colour=Kelvin(2900)))])
        self.assertEqual((result.flow, dict(result.noted)), ((), {'colour-shade': 1}))

    def test_kelvin_outside_family_is_flow(self):
        result = flow([bulb(on(colour=Kelvin(2700)))], [bulb(on(colour=Kelvin(4000)))])
        self.assertEqual(rules(result), [('bulb_a', 'colour', 'colour')])
        self.assertGreater(2700 * (1 + KELVIN_FAMILY), 2900)

    def test_rgb_outside_family_is_flow(self):
        red, orange, green = Rgb(255, 0, 0), Rgb(255, 40, 0), Rgb(0, 255, 0)
        self.assertEqual(dict(flow([bulb(on(colour=red))], [bulb(on(colour=orange))]).noted), {'colour-shade': 1})
        self.assertEqual(rules(flow([bulb(on(colour=red))], [bulb(on(colour=green))])), [('bulb_a', 'colour', 'colour')])
        self.assertGreater(XY_FAMILY, XY_DISTANCE)

    def test_candle_against_none_is_flow(self):
        result = flow([bulb(on(effect='candle'))], [bulb(on(effect='none'))])
        self.assertEqual(rules(result), [('bulb_a', 'effect', 'effect')])

    def test_level_inside_band_is_noted(self):
        result = flow([bulb(on(level=120))], [bulb(on(level=150))])
        self.assertEqual((result.flow, dict(result.noted)), ((), {'level': 1}))

    def test_level_within_the_old_tolerance_is_not_noted(self):
        result = flow([bulb(on(level=120))], [bulb(on(level=120 + LEVEL_STEPS))])
        self.assertEqual((result.flow, dict(result.noted)), ((), {}))

    def test_level_outside_band_is_flow(self):
        self.assertEqual(rules(flow([bulb(on(level=40))], [bulb(on(level=200))])), [('bulb_a', 'level', 'level')])
        self.assertEqual(LEVEL_BAND, 51)

    def test_level_in_fade_is_never_flow(self):
        for fading in ('reference', 'port'):
            with self.subTest(fading=fading):
                ref = bulb(on(level=40), in_fade={'bulb_a'} if fading == 'reference' else ())
                port = bulb(on(level=200), in_fade={'bulb_a'} if fading == 'port' else ())
                result = flow([ref], [port])
                self.assertEqual((result.flow, dict(result.noted)), ((), {'fade-sampling': 1}))

    def test_candle_level_is_noted(self):
        result = flow([bulb(on(level=40, effect='candle'))], [bulb(on(level=200, effect='candle'))])
        self.assertEqual((result.flow, dict(result.noted)), ((), {'candle-level': 1}))

    def test_timing_within_a_tick_is_noted(self):
        # The port is a tick late switching the bulb off inside a step: gone by the next checkpoint past TICK.
        ref = [bulb(on()), checkpoint(step=1, t=60.0, bulbs={'bulb_a': Off()}, in_fade={'bulb_a'}),
               checkpoint(step=1, t=120.0, bulbs={'bulb_a': Off()}),
               checkpoint(step=1, t=180.0, bulbs={'bulb_a': Off()})]
        port = [bulb(on()), checkpoint(step=1, t=60.0, bulbs={'bulb_a': on()}, in_fade={'bulb_a'}),
                checkpoint(step=1, t=120.0, bulbs={'bulb_a': Off()}),
                checkpoint(step=1, t=180.0, bulbs={'bulb_a': Off()})]
        result = flow(ref, port)
        self.assertEqual((result.flow, dict(result.noted)), ((), {'timing-slack': 1}))
        self.assertEqual(TICK, 60.0)

    def test_timing_beyond_a_tick_is_flow(self):
        ref = [bulb(on()), *(checkpoint(step=1, t=t, bulbs={'bulb_a': Off()}) for t in (60.0, 180.0, 240.0))]
        port = [bulb(on()), *(checkpoint(step=1, t=t, bulbs={'bulb_a': on()}) for t in (60.0, 180.0)),
                checkpoint(step=1, t=240.0, bulbs={'bulb_a': Off()})]
        result = flow(ref, port)
        self.assertEqual(rules(result), [('bulb_a', 'power', 'timing')])
        self.assertEqual((result.flow[0].step, result.flow[0].t), (1, 60.0))

    def test_port_must_react_where_the_reference_proves(self):
        proof = Proof(0, 1, ('bulb_a',), ())
        ref = steps(on(level=100), on(level=130))
        self.assertEqual(rules(flow(ref, steps(on(level=100), on(level=100)), proves=[proof])),
                         [('steps 0-1', 'reaction', 'reaction')])
        self.assertEqual(rules(flow(ref, steps(on(level=100), on(level=96)), proves=[proof])),
                         [('steps 0-1', 'reaction', 'reaction')])   # the wrong way
        self.assertEqual(flow(ref, steps(on(level=100), on(level=103)), proves=[proof]).flow, ())
        self.assertEqual(flow(ref, steps(on(level=100), Off()), proves=[Proof(0, 1, ('bulb_a',), ())],
                              ).flow[0].rule, 'power')   # a flow change reacts, though it differs at the end

    def test_port_must_react_on_a_switch(self):
        proof = Proof(0, 1, (), ('plug_a',))
        self.assertIn(('steps 0-1', 'reaction', 'reaction'),
                      rules(flow(switched('on', 'off'), switched('on', 'on'), proves=[proof])))

    def test_port_must_hold_where_the_reference_holds(self):
        proof = Proof(0, 1, ('bulb_a',), ())
        ref = steps(on(level=100), on(level=100))
        self.assertIn(('steps 0-1', 'hold', 'hold'), rules(flow(ref, steps(on(level=100), Off()), holds=[proof])))
        result = flow(ref, steps(on(level=100), on(level=120)), holds=[proof])
        self.assertEqual((result.flow, dict(result.noted)), ((), {'level': 1}))   # inside the band holds

    def test_missing_fade_tick_is_noted(self):
        ref = [checkpoint(step=0, t=0.0), checkpoint(step=1, t=180.0)]
        port = [checkpoint(step=0, t=0.0), checkpoint(step=1, t=60.0, in_fade={'bulb_a'}), checkpoint(step=1, t=180.0)]
        for reference, new in ((ref, port), (port, ref)):
            result = flow(reference, new)
            self.assertEqual((result.flow, dict(result.noted)), ((), {'fade-sampling': 1}))

    def test_missing_settled_checkpoint_is_flow(self):
        both = checkpoint(step=0, t=0.0)
        result = flow([both, checkpoint(step=1, t=60.0)], [both])
        self.assertEqual(rules(result), [('checkpoint', 'checkpoint', 'checkpoint')])

    def test_dashboard_difference_is_flow(self):
        for key in ('switch_ranges', 'range_defaults'):
            with self.subTest(key=key):
                result = flow([checkpoint(dashboard={key: {'a': 1}})], [checkpoint(dashboard={key: {'a': 2}})])
                self.assertEqual(rules(result), [('dashboard', key, 'dashboard')])

    def test_not_ported_is_counted(self):
        port = [checkpoint(not_ported=('automation_a',))]
        self.assertEqual(dict(flow([checkpoint()], port).not_ported), {'automation_a': 1})


class ExpectedDifferences(unittest.TestCase):
    # The press at step 1 turns plug_a off on both; the reference takes it back at step 2, the port holds it.
    # The window closes at step 3's checkpoint (t 180), which is judged as usual.
    window = ExpectedWindow('press-held', 'plug_a', 'power', after_step=1, closes_at=180.0, port_holds=True)

    def test_expected_difference_excuses_only_its_switch_rule_and_window(self):
        ref = switched('on', 'off', 'on', 'on')
        port = switched('on', 'off', 'off', 'on')
        result = flow(ref, port, expected=[self.window])
        self.assertEqual((result.flow, dict(result.expected)), ((), {'press-held': 1}))
        other = flow(switched('on', 'off', 'on', 'on', name='plug_c'), switched('on', 'off', 'off', 'on', name='plug_c'),
                     expected=[self.window])
        self.assertIn(('plug_c', 'power', 'power'), rules(other))   # another switch
        past = flow(ref, switched('on', 'off', 'off', 'off'), expected=[self.window])
        self.assertEqual([(d.step, d.subject, d.rule) for d in past.flow], [(3, 'plug_a', 'power')])
        bulb_window = ExpectedWindow('held', 'bulb_a', 'power', after_step=0, closes_at=120.0, port_holds=False)
        other_rule = flow(steps(on(), Off()), steps(on(colour=Kelvin(5000)), on()), expected=[bulb_window])
        self.assertEqual(rules(other_rule), [('bulb_a', 'colour', 'colour')])   # another rule on the subject
        self.assertEqual(dict(other_rule.expected), {'held': 1})

    def test_expected_difference_missing_is_flow(self):
        same = switched('on', 'off', 'on', 'on')
        result = flow(same, same, expected=[self.window])
        self.assertEqual(rules(result), [('plug_a', 'power', 'expected-missing')])

    def test_expected_difference_needs_the_port_to_hold(self):
        ref = switched('on', 'off', 'off', 'on')
        port = switched('on', 'off', 'on', 'on')   # differs inside the window, but not at the value it showed first
        self.assertIn(('plug_a', 'power', 'power'), rules(flow(ref, port, expected=[self.window])))
        loose = replace(self.window, port_holds=False)
        self.assertEqual(dict(flow(ref, port, expected=[loose]).expected), {'press-held': 1})

    def test_a_port_that_lets_go_inside_the_window_is_flow_where_it_agrees_with_the_reference(self):
        # The window now runs to t 240 (steps 1 to 3). The port holds at step 2, then lets go at step 3, where it
        # shows what the reference shows: no difference there, but the port did not hold.
        window = replace(self.window, closes_at=240.0)
        ref = switched('on', 'off', 'on', 'on', 'on')
        port = switched('on', 'off', 'off', 'on', 'on')
        result = flow(ref, port, expected=[window])
        self.assertEqual([(d.step, d.subject, d.rule, d.reference, d.port) for d in result.flow],
                         [(3, 'plug_a', 'expected-not-held', 'off', 'on')])
        self.assertEqual(dict(result.expected), {'press-held': 1})
        held = flow(ref, switched('on', 'off', 'off', 'off', 'on'), expected=[window])
        self.assertEqual((held.flow, dict(held.expected)), ((), {'press-held': 2}))
        loose = flow(ref, port, expected=[replace(window, port_holds=False)])
        self.assertEqual(loose.flow, ())


class FlowAdjustments(unittest.TestCase):
    def test_a_fade_into_the_candles_colour_is_counted_under_its_name(self):
        # Without the adjustment the port's warm fade is a colour difference that outlasts a tick: flow.
        self.assertEqual(rules(flow(*into_candle())), [('bulb_a', 'colour', 'timing')] * 2)
        result = flow(*into_candle(), adjustments=[FadeIntoCandleColour(CANDLE_BULBS)])
        self.assertEqual((result.flow, dict(result.expected)), ((), {'fade-into-candle-colour': 4}))

    def test_an_adjustment_explains_only_its_own_fields(self):
        # The port starts the candle at the fade's start, not at the block's: an effect difference it does not explain.
        result = flow(*into_candle(port_effect='candle'), adjustments=[FadeIntoCandleColour(CANDLE_BULBS)])
        self.assertEqual((rules(result), dict(result.expected)),
                         ([('bulb_a', 'effect', 'timing')] * 2, {'fade-into-candle-colour': 4}))

    def test_an_adjustment_that_does_not_apply_leaves_the_flow(self):
        result = flow(*into_candle(port_fading=False), adjustments=[FadeIntoCandleColour(CANDLE_BULBS)])
        self.assertEqual((rules(result), dict(result.expected)), ([('bulb_a', 'colour', 'timing')] * 2, {}))


if __name__ == '__main__':
    unittest.main()
