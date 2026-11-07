"""User-visible input/processor invariants, executing actual exported scripts.

The only reference model is button-by-button saturation. It deliberately does
not reproduce the production compact-input reducer or effect selection code.
"""
import copy
import json
import random
import unittest

from input_harness import InputSim, ROOM, CANDLE, NORMAL, SOURCE, KEY, RUNTIME, clamp


class InputProcessorTests(unittest.TestCase):
    def assert_color_close(self, actual, expected):
        self.assertEqual(set(actual), set(expected))
        if 'kelvin' in expected:
            self.assertAlmostEqual(actual['kelvin'], expected['kelvin'], places=7)
        else:
            self.assertEqual(actual, expected)

    def test_configured_candle_ignores_adjustment_and_normal_presets(self):
        s = InputSim(candle=True)
        before = s.resolved()
        candle = copy.deepcopy(before[CANDLE])
        self.assertEqual(candle['brightness']['effect'], 'Candle')
        normal_values = []
        for command in ['up', 'up', 'down', 'right', 'left', 'down']:
            s.click(command)
            targets = s.resolved()
            normal_values.append(targets[NORMAL]['brightness']['value'])
            with self.subTest(command=command):
                for channel in ['brightness', 'color']:
                    self.assertEqual(targets[CANDLE][channel], candle[channel])
                self.assertEqual(targets[CANDLE]['owners'], candle['owners'])
        self.assertGreater(len(set(normal_values)), 2)
        self.assertEqual(s.sends(), [])  # Rendering has not been scheduled locally.

    def test_room_selected_candle_ignores_adjustment_but_can_leave_by_preset(self):
        s = InputSim(candle=True)
        s.click('left')  # Day -> Candle, wrapping backwards.
        before = s.resolved()
        self.assertEqual(before[NORMAL]['brightness']['effect'], 'Candle')
        for command in ['up', 'down', 'up']:
            s.click(command)
            after = s.resolved()
            for lamp in [CANDLE, NORMAL]:
                for channel in ['brightness', 'color']:
                    self.assertEqual(after[lamp][channel], before[lamp][channel])
        s.click('right')  # Candle -> Day.
        after = s.resolved()
        self.assertEqual(after[NORMAL]['brightness']['kind'], 'constant')
        self.assertEqual(after[CANDLE]['brightness']['effect'], 'Candle')

    def test_explicit_normal_light_ui_can_exit_configured_candle(self):
        s = InputSim(candle=True)
        for _ in range(8):
            s.click('up')
        s.ui('effect', 'Normal Light', source=CANDLE)
        target = s.resolved()[CANDLE]
        self.assertEqual(target['brightness']['kind'], 'constant')
        self.assertEqual(target['color']['kind'], 'constant')
        self.assertEqual(target['level'], 105)
        s.click('up')
        target = s.resolved()[CANDLE]
        self.assertEqual(target['brightness']['kind'], 'constant')
        self.assertEqual(target['color']['kind'], 'constant')

    def test_input_storage_is_compact_and_has_no_resolved_output_channels(self):
        s = InputSim()
        first_created = None
        sizes = []
        for command in ['up'] * 65 + ['down'] * 65 + ['up', 'down'] * 20:
            s.click(command)
            records = s.attr('sensor.ls_overrides', 'overrides')
            self.assertEqual(set(records), {KEY})
            record = records[KEY]
            self.assertEqual(record['kind'], 'input')
            self.assertNotIn('channels', record['value'])
            self.assertNotIn('position', record['value'])
            serialized = json.dumps(record['value'])
            for output_key in ['"brightness"', '"color"', '"rgb"', '"kelvin"', '"scale"']:
                self.assertNotIn(output_key, serialized)
            first_created = first_created or record['created']
            self.assertEqual(record['created'], first_created)
            sizes.append(len(serialized))
        self.assertLess(max(sizes), 1800)
        self.assertLess(max(sizes) - min(sizes), 150)

    def test_random_bursts_match_button_by_button_saturation(self):
        s = InputSim()
        s.click('right')  # Establish exact Cosy origin.
        position = 0.
        rng = random.Random(245919)
        commands = ['up'] * 55 + ['down'] * 60 + [rng.choice(['up', 'down']) for _ in range(80)]
        for index, command in enumerate(commands):
            s.click(command)
            position = clamp(position + (.1 if command == 'up' else -.1))
            if index % 7 == 0 or index in [54, 55, 114, len(commands) - 1]:
                plan = s.room_plan()['plan']
                target = plan['resolved']['targets']['room:' + ROOM]
                anchors = plan['base']['room:' + ROOM]
                expected = s.pure('effects_scale', day=anchors['day'], cosy=anchors['cosy'],
                                  position=position,
                                  warm_end=s.attr('light.candle_test_rgb_warm_end', 'rgb_color') or [255, 126, 0])
                self.assertAlmostEqual(target['level'], expected['brightness'], places=7)
                self.assert_color_close(target['color']['value'], expected['color'])

    def test_saturation_does_not_require_unwinding_excess_clicks(self):
        for direction, reverse, expected in [('up', 'down', 1.9), ('down', 'up', -1.9)]:
            s = InputSim()
            for _ in range(70):
                s.click(direction)
            s.click(reverse)
            plan = s.room_plan()['plan']
            anchors = plan['base']['room:' + ROOM]
            reference = s.pure('effects_scale', day=anchors['day'], cosy=anchors['cosy'],
                               position=expected,
                               warm_end=s.attr('light.candle_test_rgb_warm_end', 'rgb_color') or [255, 126, 0])
            target = plan['resolved']['targets']['room:' + ROOM]
            self.assertAlmostEqual(target['level'], reference['brightness'], places=7)
            self.assert_color_close(target['color']['value'], reference['color'])

    def test_newer_room_brightness_seeds_next_adjustment_without_replaying_old_steps(self):
        s = InputSim()
        for _ in range(12):
            s.click('down')
        s.ui('brightness', 165)
        self.assertEqual(s.resolved()['room:' + ROOM]['level'], 165)
        s.click('up')
        self.assertAlmostEqual(s.resolved()['room:' + ROOM]['level'], 176)

    def test_explicit_per_channel_ui_claims_keep_their_independent_meaning(self):
        s = InputSim(candle=True)
        s.click('up')
        s.ui('rgb', [3, 9, 27], source=CANDLE)
        target = s.resolved()[CANDLE]
        self.assertEqual(target['brightness']['effect'], 'Candle')
        self.assertEqual(target['color']['value'], {'rgb': [3, 9, 27]})
        s.click('up')
        target = s.resolved()[CANDLE]
        self.assertEqual(target['brightness']['effect'], 'Candle')
        self.assertEqual(target['color']['kind'], 'constant')
        self.assertNotEqual(target['color']['value'], {'rgb': [3, 9, 27]})

    def test_adjustment_does_not_stop_or_reassign_running_candle(self):
        s = InputSim(candle=True)
        s.seed()
        assignment = copy.deepcopy(s.attr(RUNTIME, 'assignments')[CANDLE])
        s.clear_observations()
        for command in ['up', 'down', 'down']:
            s.click(command)
            s.drain()
            # The global output generation must advance for Normal neighbours'
            # stale-send checks. It is not Candle's instance/animation clock.
            self.assertEqual(s.attr(RUNTIME, 'assignments')[CANDLE], assignment)
        # The existing single-mode runner receives idempotent turn_on calls;
        # Home Assistant does not restart a running single-mode script.
        engine_stops = [c for c in s.calls if c['action'] == 'script.turn_off'
                        and c['target'].get('entity_id') == 'script.effects_engine']
        self.assertEqual(engine_stops, [])

    def test_room_input_isolation_and_logical_lamp_ontology(self):
        s = InputSim(candle=True)
        before = s.resolved()
        for command in ['up', 'down', 'right', 'left']:
            s.click(command)
        after = s.resolved()
        for key, value in before.items():
            if value['area'] != ROOM:
                self.assertEqual(after[key], value)
        self.assertIn('light.kitchen_pendant', after)
        self.assertNotIn('light.kitchen_pendant_bulb_1', after)

    def test_power_keeps_input_and_reset_keeps_power(self):
        s = InputSim(candle=True)
        s.click('up')
        records = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides'))
        s.click('toggle')
        self.assertEqual(s.attr('sensor.ls_overrides', 'overrides'), records)
        self.assertFalse(s.attr('sensor.ls_overrides', 'power')[ROOM])
        s.click('reset')
        self.assertNotIn(KEY, s.attr('sensor.ls_overrides', 'overrides'))
        self.assertFalse(s.attr('sensor.ls_overrides', 'power')[ROOM])

    def test_schedule_expiry_removes_input_without_disabling_configured_candle(self):
        s = InputSim(candle=True, expiry=True)
        s.now = s.now.replace(hour=17, minute=39, second=50)
        s.click('up')
        self.assertIn(KEY, s.attr('sensor.ls_overrides', 'overrides'))
        s.now = s.now.replace(hour=18, minute=1, second=0)
        plan = s.room_plan()['plan']
        self.assertIn(KEY, plan['stale_keys'])
        target = plan['resolved']['targets'][CANDLE]
        self.assertEqual(target['brightness']['effect'], 'Candle')
        self.assertEqual(target['owners']['brightness'], 'base:Candle')

    def test_switch_range_uses_interpreted_room_level(self):
        s = InputSim(candle=True)
        s.areas['switch.test_bright'] = ROOM
        s.put('switch.test_bright', 'off')
        s.run('ls_commit', data={'op': 'range_set', 'entity': 'switch.test_bright',
                                 'profile': 'bright'})
        self.assertFalse(s.room_plan()['plan']['switches']['switch.test_bright']['on'])
        for _ in range(4):
            s.click('up')
        self.assertTrue(s.room_plan()['plan']['switches']['switch.test_bright']['on'])
        for _ in range(4):
            s.click('down')
        self.assertFalse(s.room_plan()['plan']['switches']['switch.test_bright']['on'])

    def test_warm_input_path_does_no_schedule_or_gradient_work(self):
        s = InputSim(candle=True)
        s.seed()
        s.click('up')
        s.drain()
        s.clear_observations()
        for command in ['up', 'down'] * 15:
            s.click(command)
        self.assertEqual(s.blocking_steps, [])
        self.assertEqual(s.sends(), [])
        self.assertFalse(set(s.script_runs) & {'ls_room_plan', 'ls_room_base', 'ls_plan', 'ls_base',
                                             'effects_resolve', 'effects_gradient_plan', 'effects_catalog'})
        s.clear_observations()
        s.drain()
        self.assertEqual(s.script_runs.count('ls_room_plan'), 1)
        self.assertNotIn('ls_room_base', s.script_runs)
        self.assertNotIn('effects_gradient_plan', s.script_runs)
        self.assertNotIn('ls_plan', s.script_runs)
        self.assertEqual(s.pending_rooms(), set())

    def test_burst_render_coalesces_and_preserves_other_room_targets(self):
        s = InputSim(candle=True)
        s.seed()
        before = copy.deepcopy(s.attr(RUNTIME, 'targets'))
        for command in ['up'] * 15 + ['down'] * 10 + ['up'] * 5:
            s.click(command)
        self.assertEqual(s.attr(RUNTIME, 'targets'), before)
        s.clear_observations()
        s.drain()
        self.assertEqual(s.script_runs.count('ls_room_plan'), 1)
        self.assertEqual(s.script_runs.count('effects_resolve'), 1)
        self.assertNotIn('ls_plan', s.script_runs)
        self.assertEqual({s.areas[lamp] for lamp in s.framed_lamps()}, {ROOM})
        for key, target in before.items():
            if target['area'] != ROOM:
                self.assertEqual(s.attr(RUNTIME, 'targets')[key], target)
        self.assertEqual(s.attr(RUNTIME, 'targets')[CANDLE]['brightness'], before[CANDLE]['brightness'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
