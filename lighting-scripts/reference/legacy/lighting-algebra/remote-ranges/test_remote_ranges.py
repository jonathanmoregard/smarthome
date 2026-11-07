"""A remote's declared tick range discards excess input before interpretation.

Break: clamping only rendered output, or ignoring the remote's bounds, leaves
excess button input to unwind. Tests execute actual exported HA scripts.
"""
import copy
import os
import random
import sys
import unittest

sys.path.insert(0, '/tmp/lighting-algebra/input-processors/tests')
from input_harness import InputSim, KEY, ROOM, NORMAL, CANDLE


class RemoteRangeTests(unittest.TestCase):
    def sim(self, limits=None, candle=False):
        s = InputSim(candidate=os.environ.get('INPUT_CANDIDATE',
            '/tmp/lighting-algebra/remote-ranges/candidate'), candle=candle)
        s.click('right')  # Cosy, zero ticks.
        if limits is not None:
            self.limits(s, limits)
        return s

    def limits(self, s, limits):
        record = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides')[KEY])
        record['value']['step_range'] = limits
        s.run('ls_commit', data={'op': 'set', 'records': [record]})

    def position(self, s):
        return s.room_plan()['plan']['resolved']['targets']['room:' + ROOM]['brightness']['position']

    def test_excess_up_is_discarded_and_one_down_moves_both_channels(self):
        s = self.sim({'min': -2, 'max': 15})
        for _ in range(70):
            s.click('up')
        self.assertAlmostEqual(self.position(s), 1.5)
        s.click('down')
        t = s.resolved()['room:' + ROOM]
        self.assertAlmostEqual(t['brightness']['position'], 1.4)
        self.assertAlmostEqual(t['level'], 234)
        self.assertAlmostEqual(t['color']['value']['kelvin'], 5000)

    def test_excess_down_is_discarded_and_one_up_moves_both_channels(self):
        s = self.sim({'min': -2, 'max': 15})
        for _ in range(70):
            s.click('down')
        self.assertAlmostEqual(self.position(s), -.2)
        s.click('up')
        t = s.resolved()['room:' + ROOM]
        self.assertAlmostEqual(t['brightness']['position'], -.1)
        self.assertAlmostEqual(t['level'], 99)
        self.assertAlmostEqual(t['color']['value']['kelvin'], 2175)

    def test_range_tightening_clamps_existing_input_before_next_reverse(self):
        s = self.sim()
        for _ in range(60):
            s.click('up')
        self.limits(s, {'min': -2, 'max': 15})
        self.assertAlmostEqual(self.position(s), 1.5)
        s.click('down')
        self.assertAlmostEqual(self.position(s), 1.4)

    def test_random_inputs_from_multiple_remotes_share_one_bounded_dial(self):
        s = self.sim({'min': -2, 'max': 15})
        tick = 0
        rng = random.Random(73221)
        for i, command in enumerate(['down']*10 + ['up']*30 +
                [rng.choice(['up', 'down']) for _ in range(35)]):
            tick = max(-2, min(15, tick + (1 if command == 'up' else -1)))
            s.click(command, source=rng.choice(['A', 'B', 'C']))
            if i % 5 == 0 or i == 74:
                self.assertAlmostEqual(self.position(s), tick / 10)

    def test_zero_width_range_remains_fixed_for_both_directions(self):
        s = self.sim({'min': 5, 'max': 5})
        for command in ['up', 'down', 'down', 'up']:
            s.click(command)
            self.assertAlmostEqual(self.position(s), .5)

    def test_candle_keeps_ownership_and_ignores_bounded_remote_input(self):
        s = self.sim({'min': -2, 'max': 15}, candle=True)
        before = s.resolved()[CANDLE]
        for command in ['up']*20 + ['down']*30:
            s.click(command)
        after = s.resolved()[CANDLE]
        self.assertEqual(after['brightness'], before['brightness'])
        self.assertEqual(after['color'], before['color'])
        self.assertEqual(after['owners'], before['owners'])

    def test_invalid_remote_range_is_noop_and_reset_still_works(self):
        for limits in [None, {'min': 5, 'max': -2}, {'min': False, 'max': 15},
                       {'min': -21, 'max': 15}, {'min': 0, 'max': 21}, {}]:
            s = self.sim()
            self.limits(s, limits)
            before = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides'))
            s.click('up')
            self.assertEqual(s.attr('sensor.ls_overrides', 'overrides'), before)
            s.click('reset')
            self.assertEqual(s.attr('sensor.ls_overrides', 'overrides'), {})

    def test_missing_range_preserves_old_records_and_warm_fast_path(self):
        s = self.sim()
        record = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides')[KEY])
        record['value'].pop('step_range', None)
        s.run('ls_commit', data={'op': 'set', 'records': [record]})
        s.clear_observations()
        for _ in range(65):
            s.click('up')
        s.click('down')
        self.assertNotIn('ls_room_plan', s.script_runs)
        self.assertNotIn('effects_gradient_plan', s.script_runs)
        self.assertEqual(s.blocking_steps, [])
        self.assertAlmostEqual(self.position(s), 1.9)


if __name__ == '__main__':
    unittest.main(verbosity=2)
