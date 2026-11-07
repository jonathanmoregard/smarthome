"""Base period, cache and channels must consume the same room input snapshot.

Break: a restored preset's old priority loses to an inactive remote snapshot,
or changing only the source of an identical room input invalidates the cache.
"""
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, '/tmp/lighting-algebra/input-processors/tests')
from input_harness import InputSim, ROOM, NORMAL

STAGE = Path(__file__).parent


class PeriodStreamTests(unittest.TestCase):
    def seeded_upgrade(self):
        s = InputSim(candidate=STAGE.parent/'remote-regressions/candidate')
        s.store('input_text.ls_lamp_living_room_hall_ceiling_cosy',
                {'own': True, 'on': True, 'b': 105, 'm': 'ct', 'k': 2200, 'effect': 'Candle'})
        for _ in range(3):
            s.click('right', source='A')  # Old deployed planner: explicit Day.
        for path in Path(os.environ.get('INPUT_CANDIDATE', STAGE/'candidate')).glob('*.json'):
            c = json.loads(path.read_text())
            if 'sequence' in c:
                s.config[path.stem] = c
        return s

    def test_inactive_snapshot_cannot_keep_cosy_candle_after_other_remote_selects_day(self):
        s = self.seeded_upgrade()
        s.click('right', source='A')
        s.click('right', source='A')
        s.click('right', source='B')
        self.assertEqual(s.attr('sensor.ls_overrides', 'overrides')['channels:B']['value']['selection'], 'day')
        for targets in [s.resolved(), s.room_plan()['plan']['resolved']['targets']]:
            self.assertEqual(targets['room:'+ROOM]['period'], 'day')
            self.assertEqual(targets[NORMAL]['period'], 'day')
            self.assertEqual(targets[NORMAL]['brightness']['kind'], 'constant')

    def test_cached_base_is_invalidated_when_latest_snapshot_restores_day(self):
        s = self.seeded_upgrade()
        s.click('right', source='A')
        s.click('right', source='A')
        cache = s.room_plan()['cache_update']
        s.click('right', source='B')
        result = s.room_plan(cache=cache)
        self.assertFalse(result['cache_hit'])
        self.assertEqual(result['plan']['resolved']['targets'][NORMAL]['period'], 'day')

    def test_input_handoff_with_same_period_reuses_cached_base(self):
        s = InputSim(candidate=os.environ.get('INPUT_CANDIDATE', STAGE/'candidate'))
        s.click('right', source='A')
        cache = s.room_plan()['cache_update']
        s.click('up', source='B')
        result = s.room_plan(cache=cache)
        self.assertTrue(result['cache_hit'])
        self.assertEqual(result['plan']['resolved']['targets'][NORMAL]['period'], 'cosy')


if __name__ == '__main__':
    unittest.main(verbosity=2)
