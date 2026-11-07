"""Replay the observed first preset after the RC250 power reset.

Break: representing 'reset, no preset observed yet' as 'preset zero observed',
which drops the first real right press as a supposed companion frame.
"""
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, '/tmp/lighting-algebra/remote')
from gesture_test import Replay, REMOTES, power, arrow, brightness, chord


class CurrentReplay(Replay):
    def __init__(self, events):
        super().__init__(events)
        stage = Path(os.environ.get('INPUT_CANDIDATE',
            '/tmp/lighting-algebra/remote-regressions/candidate'))
        for room in REMOTES:
            self.config['ls_remote_gesture_'+room] = json.loads(
                (stage/('ls_remote_gesture_'+room+'.json')).read_text())


class FirstArrowTests(unittest.TestCase):
    def test_first_right_after_reset_is_one_press_even_with_delayed_companion(self):
        for room in REMOTES:
            with self.subTest(room=room):
                # Observed live: first brightness254, then CT200 ~2s later;
                # next brightness229/CT285. Both are real right presses.
                events = [power(0, room, 'off'), power(.1, room, 'on'), power(.2, room, 'off'),
                          brightness(1, 254, room), arrow(3, 200, room),
                          brightness(5, 229, room), arrow(5.5, 285, room)]
                s = CurrentReplay(events)
                self.assertEqual([x['command'] for x in s.drive()], ['reset','right','right'])

    def test_first_left_after_reset_and_its_companion_remain_one_press(self):
        for room in REMOTES:
            s = CurrentReplay([power(0,room,'off'),power(.1,room,'on'),power(.2,room,'off'),
                               brightness(1,2,room),arrow(1.5,588,room)])
            self.assertEqual([x['command'] for x in s.drive()], ['reset','left'])

    def test_first_arrow_without_known_reset_does_not_guess_direction(self):
        s = CurrentReplay([brightness(1,254),arrow(1.5,200)])
        s.put('input_number.ls_bedroom_remote_preset', 'unavailable')
        self.assertEqual(s.drive(), [])

    def test_repeat_same_preset_after_decoding_still_does_not_double_advance(self):
        s = CurrentReplay([power(0,'bedroom','off'),power(.1,'bedroom','on'),
                           brightness(1,254),arrow(1.5,200),arrow(2,200)])
        self.assertEqual([x['command'] for x in s.drive()], ['right'])

    def test_secret_chord_still_toggles_twice(self):
        s = CurrentReplay(chord()+chord(1))
        self.assertEqual([x['command'] for x in s.drive()], ['sara_toggle','sara_toggle'])
        self.assertEqual(s.sara_states, [True,False])


if __name__ == '__main__':
    unittest.main(verbosity=2)
