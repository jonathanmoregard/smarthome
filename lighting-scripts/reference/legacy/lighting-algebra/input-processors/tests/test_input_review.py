"""Observed independent-review reproducers, using actual exported scripts."""
import copy
import json
import random
import unittest
from pathlib import Path
from input_harness import InputSim, ROOM, NORMAL, clamp

class ReviewRegressions(unittest.TestCase):
    def old(self):
        return InputSim(candidate='/tmp/lighting-algebra/simple-effects/candidate')

    def upgrade(self,s):
        for p in Path('/tmp/lighting-algebra/input-processors/candidate').glob('*.json'):
            c=json.loads(p.read_text())
            if 'sequence' in c:s.config[p.stem]=c

    def test_migrated_candle_keeps_intensity_and_instance_across_adjustments(self):
        s=self.old()
        for command in ['down','down','left']:s.click(command)
        old=copy.deepcopy(s.resolved()[NORMAL])
        self.upgrade(s)
        for command in ['up','up','down']:
            s.click(command)
            new=s.resolved()[NORMAL]
            self.assertEqual(new['brightness'],old['brightness'])
            self.assertEqual(new['color'],old['color'])

    def test_migrated_remote_respects_newer_ui_brightness(self):
        s=self.old()
        for _ in range(12):s.click('down')
        s.ui('brightness',165)
        self.upgrade(s)
        self.assertEqual(s.resolved()['room:'+ROOM]['level'],165)
        s.click('up')
        self.assertAlmostEqual(s.resolved()['room:'+ROOM]['level'],176)

    def test_alternating_remotes_share_room_input_without_losing_clicks(self):
        s=InputSim();levels=[]
        for actor in ['A','B','A','B']:
            s.click('up',source=actor)
            levels.append(s.resolved()['room:'+ROOM]['level'])
        self.assertEqual(levels,[223.5,227,230.5,234])

    def test_random_interleaved_remote_sources_match_one_room_dial(self):
        s=InputSim();rng=random.Random(12091);position=1
        for i in range(50):
            command=rng.choice(['up','down']);position=clamp(position+(.1 if command=='up' else -.1))
            s.click(command,source=rng.choice(['A','B','C']))
            expected=s.pure('effects_scale',day={'brightness':220,'color':{'kelvin':4000}},
                            cosy={'brightness':110,'color':{'kelvin':2200}},position=position)
            self.assertAlmostEqual(s.resolved()['room:'+ROOM]['level'],expected['brightness'])

    def test_other_remote_can_leave_candle_and_preserves_its_intensity_while_selected(self):
        s=InputSim();s.click('down',source='A');s.click('left',source='A')
        before=s.resolved()[NORMAL]
        s.click('up',source='B');self.assertEqual(s.resolved()[NORMAL]['brightness'],before['brightness'])
        s.click('right',source='B')
        self.assertEqual(s.resolved()[NORMAL]['brightness']['kind'],'constant')
        self.assertEqual(s.resolved()[NORMAL]['level'],220)

if __name__=='__main__':unittest.main()
