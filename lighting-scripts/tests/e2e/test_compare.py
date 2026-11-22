"""End-state comparator, on synthetic checkpoints only."""
from __future__ import annotations
import unittest

from tests.e2e.codec import Checkpoint
from tests.e2e.compare import (KELVIN_K, LEVEL_STEPS, MID_FADE_LEVEL_PCT, XY_DISTANCE, Difference, compare)
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

    def test_adjustment_counts_and_suppresses(self):
        class Candle:
            name = 'software-candle-is-firmware-candle'

            def applies(self, ref, port, subject):
                return isinstance(ref, On) and isinstance(port, On) and ref.effect == 'none' and port.effect == 'candle'

        ref = [checkpoint(step=0, t=0.0, bulbs={'bulb_a': on(level=50)}),
               checkpoint(step=1, t=1.0, bulbs={'bulb_a': on(level=50)})]
        port = [checkpoint(step=0, t=0.0, bulbs={'bulb_a': on(level=90, effect='candle')}),
                checkpoint(step=1, t=1.0, bulbs={'bulb_a': on(level=50)})]
        result = compare(ref, port, [Candle()])
        self.assertEqual(result.differences, ())
        self.assertEqual(dict(result.adjustments), {'software-candle-is-firmware-candle': 1})
        self.assertEqual(fields(compare(ref, port)), [('bulb_a', 'level'), ('bulb_a', 'effect')])

    def test_adjustment_does_not_count_when_nothing_differs(self):
        class Always:
            name = 'always'

            def applies(self, ref, port, subject):
                return True

        same = [checkpoint()]
        self.assertEqual(dict(compare(same, same, [Always()]).adjustments), {})


if __name__ == '__main__':
    unittest.main()
