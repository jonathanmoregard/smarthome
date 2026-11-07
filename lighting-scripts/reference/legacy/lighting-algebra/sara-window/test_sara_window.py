"""Dry replay of actual HA gestures; catches premature Power/chord expiry.

The external restartable timer is simulated from its real delay configuration.
All MQTT, helper and lamp service effects remain inside the offline interpreter.
"""
import copy
import os
from pathlib import Path
import random
import sys
import unittest

STAGE = Path(__file__).resolve().parent
os.environ.setdefault('LIGHTING_CANDIDATE', str(STAGE.parent / 'remote-ranges/candidate'))
sys.path.insert(0, str(STAGE.parent / 'tests'))
from test_gesture_native_conditions import NativeConditionReplay
from test_gesture_integration import REMOTES, arrow, brightness, direction, power


class WindowReplay(NativeConditionReplay):
    def service(self, action, target, data):
        entity = target.get('entity_id', '')
        if action == 'script.turn_on' and isinstance(entity, str) and entity.startswith('script.ls_remote_power_quiet_'):
            config = self.config[entity.removeprefix('script.')]
            delay = config['sequence'][0]['delay']['milliseconds'] / 1000
            self.debounces[entity] = (self.elapsed + delay, data['variables']['token'])
            return
        return super().service(action, target, data)


def sequence(gap, room, start=0):
    events = [power(start, room, 'off'), power(start + gap, room, 'on')]
    for index, (temp, level) in enumerate([(588, 2), (200, 254), (588, 2), (200, 254)]):
        at = start + gap + .15 + index * .2
        events += [brightness(at, level, room), arrow(at + .01, temp, room)]
    return events


class SaraWindowTests(unittest.TestCase):
    def test_recorded_failed_power_gaps_cancel_sara_without_power_or_override_changes(self):
        for room in REMOTES:
            for gap in [.446799, .460778]:
                with self.subTest(room=room, gap=gap):
                    sim = WindowReplay(sequence(gap, room))
                    sim.put('input_boolean.ls_ovr_next_block_on', 'off')
                    sim.event('ls_override', {'op': 'set', 'records': [{'kind': 'mode', 'target': 'sara', 'value': 'on'}]})
                    before = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides'))
                    before.pop('mode:sara')
                    power_before = copy.deepcopy(sim.attr('sensor.ls_overrides', 'power'))
                    commands = sim.drive()
                    self.assertEqual([c['command'] for c in commands], ['sara_toggle'])
                    self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), before)
                    self.assertEqual(sim.attr('sensor.ls_overrides', 'power'), power_before)
                    self.assertEqual(sim.physical(), [])

    def test_same_sequence_twice_restores_sara_for_both_remotes(self):
        for room in REMOTES:
            sim = WindowReplay(sequence(.55, room) + sequence(.55, room, 3))
            sim.put('input_boolean.ls_ovr_next_block_on', 'off')
            commands = sim.drive()
            self.assertEqual([c['command'] for c in commands], ['sara_toggle', 'sara_toggle'])
            self.assertEqual([c['sara_enabled'] for c in commands], [True, False])
            self.assertEqual(sim.physical(), [])

    def test_triple_power_resets_once_and_never_toggles_power_or_sara(self):
        for room in REMOTES:
            sim = WindowReplay([power(0, room), power(.45, room), power(.90, room)], defer_commands=True)
            commands = sim.drive()
            self.assertEqual([c['command'] for c in commands], ['reset'])
            self.assertLess(commands[0]['time'], 1.6)

    def test_separate_power_clicks_still_toggle_individually(self):
        sim = WindowReplay([power(0), power(.75)], defer_commands=True)
        commands = sim.drive()
        self.assertEqual([c['command'] for c in commands], ['toggle', 'toggle'])
        self.assertGreater(commands[0]['time'], .55)
        self.assertLess(commands[0]['time'], .65)

    def test_arrows_bypass_power_wait_and_cancel_incomplete_chord(self):
        sim = WindowReplay([power(0), direction(.05, 'up'), power(.45), direction(.5, 'down')], defer_commands=True)
        commands = sim.drive()
        self.assertEqual([c['command'] for c in commands], ['up', 'down'])
        self.assertEqual([c['time'] for c in commands], [.05, .5])

    def test_stale_completion_does_not_split_extended_double_click(self):
        sim = WindowReplay(defer_commands=True)
        sim.gesture('bedroom', 'power')
        token = sim.states('input_text.ls_bedroom_remote_power_token')
        sim.advance(.45)
        sim.gesture('bedroom', 'power')
        sim.gesture('bedroom', 'power_done', token=token)
        self.assertEqual(sim.drive(), [])

    def test_random_valid_power_spacing_preserves_full_chord(self):
        rng = random.Random(607)
        for _ in range(24):
            room = rng.choice(list(REMOTES))
            sim = WindowReplay(sequence(rng.uniform(.02, .59), room), defer_commands=True)
            self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
