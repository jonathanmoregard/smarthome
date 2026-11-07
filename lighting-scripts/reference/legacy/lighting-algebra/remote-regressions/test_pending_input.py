"""Pending remote input must reach output even when a schedule tick coalesces it.

Break: treating the scheduled 'send' hint as a veto for pending room input.
Actual deployed scripts run against the existing fail-closed offline sinks.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, '/tmp/lighting-algebra/input-processors/tests')
from input_harness import InputSim, ROOM, NORMAL, CANDLE, RUNTIME


class PendingInputTests(unittest.TestCase):
    def sim(self, candle=False):
        s = InputSim(candidate=os.environ.get('INPUT_CANDIDATE',
            '/tmp/lighting-algebra/remote-regressions/candidate'), candle=candle)
        s.seed()
        return s

    def payloads(self, sim, lamp=NORMAL):
        catalog = sim.pure('effects_catalog')
        return [json.loads(c['data']['payload']) for c in sim.sends()
                if c['data']['topic'] == catalog['topics'][lamp]]

    def test_tick_cannot_acknowledge_cosy_without_sending_it(self):
        s = self.sim()
        s.click('right')
        s.run('ls_apply', reason='tick')
        s.drain()
        self.assertTrue(self.payloads(s), 'Cosy was marked handled with no output')
        self.assertEqual(self.payloads(s)[-1]['brightness'], 110)
        self.assertEqual(self.payloads(s)[-1]['color_temp'], round(1_000_000/2200))
        self.assertFalse(s.pending_rooms())

    def test_click_during_pending_tick_also_reaches_output(self):
        s = self.sim()
        s.run('ls_apply', reason='tick')
        s.click('up')
        s.drain()
        self.assertTrue(self.payloads(s), 'Up disappeared into a pending tick')
        self.assertGreater(self.payloads(s)[-1]['brightness'], 220)

    def test_tick_cannot_drop_day_output_when_leaving_candle(self):
        s = self.sim()
        for _ in range(2):
            s.click('right')
            s.drain()
        self.assertIn(NORMAL, s.attr(RUNTIME, 'assignments'))
        s.clear_observations()
        s.click('right')
        s.run('ls_apply', reason='tick')
        s.drain()
        self.assertNotIn(NORMAL, s.attr(RUNTIME, 'assignments'))
        self.assertTrue(self.payloads(s), 'Candle released but Day never sent')
        self.assertEqual(self.payloads(s)[-1]['brightness'], 220)
        self.assertIn('color_temp', self.payloads(s)[-1])

    def test_tick_cannot_drop_reset_output(self):
        s = self.sim()
        s.click('right')
        s.drain()
        s.clear_observations()
        s.click('reset')
        s.run('ls_apply', reason='tick')
        s.drain()
        self.assertTrue(self.payloads(s), 'Reset cleared intent but never sent Day')
        self.assertEqual(self.payloads(s)[-1]['brightness'], 220)

    def test_coalesced_remote_output_keeps_short_transition_and_room_scope(self):
        s = self.sim(candle=True)
        s.click('right')
        s.run('ls_apply', reason='tick')
        s.drain()
        self.assertTrue(self.payloads(s))
        self.assertTrue(all(x['transition'] <= .5 for x in self.payloads(s)))
        self.assertEqual(s.attr(RUNTIME, 'assignments')[CANDLE]['color']['effect'], 'Candle')
        catalog = s.pure('effects_catalog')
        unrelated = {topic for lamp,topic in catalog['topics'].items()
                     if s.areas.get(lamp) != ROOM}
        self.assertFalse(any(c['data']['topic'] in unrelated for c in s.sends()))

    def test_plain_unchanged_tick_remains_silent(self):
        s = self.sim()
        s.run('ls_apply', reason='tick')
        s.drain()
        self.assertEqual(s.sends(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
