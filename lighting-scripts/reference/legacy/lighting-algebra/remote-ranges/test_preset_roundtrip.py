"""Preset rotation is reversible while the remote's adjustment is preserved.

Break: assigning a preset resets the input accumulator or discards its carried
baseline. Compare stable lighting meaning, excluding animation time/timestamps.
"""
import copy
import os
import sys
import unittest

sys.path.insert(0, '/tmp/lighting-algebra/input-processors/tests')
from input_harness import InputSim, ROOM, NORMAL, CANDLE, KEY


class PresetRoundTripTests(unittest.TestCase):
    def sim(self, candle=False):
        s = InputSim(candidate=os.environ.get('INPUT_CANDIDATE',
            '/tmp/lighting-algebra/remote-ranges/candidate'), candle=candle)
        return s

    def meaning(self, s):
        result = {}
        for lamp, target in s.resolved().items():
            result[lamp] = {key: target[key] for key in ['level', 'period', 'on']}
            for channel in ['brightness', 'color']:
                source = target[channel]
                result[lamp][channel] = {k: source[k] for k in
                    ['kind', 'value', 'effect', 'instance', 'base', 'intensity'] if k in source}
        return result

    def test_both_roundtrip_directions_preserve_input_and_lighting_in_each_mode(self):
        for preset in ['day', 'cosy', 'Candle']:
            for cycle in [('right', 'left'), ('left', 'right')]:
                with self.subTest(preset=preset, cycle=cycle):
                    s = self.sim()
                    for _ in range(4):
                        s.click('down')
                    if preset in ['cosy', 'Candle']:
                        s.click('right')
                    if preset == 'Candle':
                        s.click('right')
                    before = self.meaning(s)
                    value = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides')[KEY]['value'])
                    for command in cycle:
                        s.click(command)
                    self.assertEqual(self.meaning(s), before)
                    self.assertEqual(s.attr('sensor.ls_overrides', 'overrides')[KEY]['value'].get('adjustment'),
                                     value.get('adjustment'))

    def test_mode_changes_keep_the_adjustment_while_changing_the_base(self):
        s = self.sim()
        s.click('up')
        before = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['adjustment'])
        s.click('right')
        t = s.resolved()['room:' + ROOM]
        self.assertEqual(t['period'], 'cosy')
        self.assertAlmostEqual(t['level'], 121)  # Cosy110 plus one tick11.
        self.assertEqual(s.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['adjustment'], before)

    def test_saturated_input_stays_saturated_through_roundtrip_then_reverses(self):
        s = self.sim()
        for _ in range(70):
            s.click('up')
        s.click('right')
        s.click('left')
        s.click('down')
        t = s.resolved()['room:' + ROOM]
        self.assertAlmostEqual(t['brightness']['position'], 1.9)

    def test_newer_ui_override_does_not_make_mode_change_erase_remote_input(self):
        s = self.sim()
        for _ in range(4):
            s.click('down')
        saved = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['adjustment'])
        s.ui('brightness', 165)
        before = self.meaning(s)
        others = {k: copy.deepcopy(v) for k,v in s.attr('sensor.ls_overrides', 'overrides').items() if k != KEY}
        s.click('right')
        s.click('left')
        self.assertEqual(self.meaning(s), before)
        self.assertEqual(s.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['adjustment'], saved)
        self.assertEqual({k:v for k,v in s.attr('sensor.ls_overrides', 'overrides').items() if k != KEY}, others)

    def test_configured_candle_stays_unchanged_through_adjusted_roundtrip(self):
        s = self.sim(candle=True)
        s.click('down')
        before = self.meaning(s)
        s.click('left')
        s.click('right')
        self.assertEqual(self.meaning(s), before)
        self.assertEqual(self.meaning(s)[CANDLE]['brightness']['effect'], 'Candle')

    def test_candle_roundtrip_preserves_baseline_after_ignored_adjustments(self):
        s = self.sim()
        for _ in range(4):
            s.click('down')
        normal_level = s.resolved()[NORMAL]['level']
        s.click('left')
        self.assertEqual(s.resolved()[NORMAL]['brightness']['intensity'], normal_level)
        before = self.meaning(s)
        for _ in range(4):
            s.click('up')
        self.assertEqual(self.meaning(s), before)
        s.click('right')
        s.click('left')
        self.assertEqual(self.meaning(s), before)

    def test_candle_roundtrip_preserves_precedence_of_newer_ui_override(self):
        s = self.sim()
        s.click('down')
        s.click('left')
        s.ui('brightness', 165)
        before = self.meaning(s)
        s.click('right')
        s.click('left')
        self.assertEqual(self.meaning(s), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
