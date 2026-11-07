"""Replay the native preset automation offline; all service calls are sinks."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, '/tmp/lighting-algebra/tests')
from dry_harness import DrySim

ROOT = Path('/tmp/lighting-algebra/remote')
CURSOR = 'input_number.ls_bedroom_remote_preset'
IEEE = '0x385b44fffea4fc67'
DEVICE = '0e973e9202acb5ace9a8e6a8b336891d'
PRESETS = [200, 285, 370, 454, 588]


class Replay(DrySim):
    def __init__(self):
        super().__init__()
        self.automations['preset'] = json.loads((ROOT / 'preset_automation.json').read_text())
        self.areas[DEVICE] = 'jonathan_bedroom'
        self.put(CURSOR, '4')
        self.dispatches = []
        self.cursor_at_dispatch = []

    def cond(self, condition, context):
        if isinstance(condition, dict) and condition.get('condition') == 'template':
            # HA conditions accept true, not generic Python truthiness.
            return str(self.render(condition['value_template'], context)).lower() == 'true'
        return super().cond(condition, context)

    def service(self, action, target, data):
        if action == 'input_number.set_value':
            self.calls.append({'action': action, 'target': target, 'data': data})
            self.put(target['entity_id'], data['value'])
        elif action == 'script.ls_remote_command':
            self.dispatches.append(copy.deepcopy(data))
            self.cursor_at_dispatch.append(self.states(CURSOR))
        else:
            super().service(action, target, data)

    def message(self, payload):
        self.run_automation('preset', {'payload_json': payload})

    def preset(self, value):
        self.message({'action': 'color_temperature_move', 'action_color_temperature': value})


class PresetReplayTests(unittest.TestCase):
    def test_observed_left_right_and_right_wrap(self):
        sim = Replay()
        for value in [454, 588, 200, 285]:
            sim.preset(value)
        self.assertEqual([d['command'] for d in sim.dispatches], ['left', 'right', 'right', 'right'])
        self.assertEqual(sim.cursor_at_dispatch, ['3', '4', '0', '1'])
        self.assertTrue(all(d['source'] == IEEE and d['area'] == 'jonathan_bedroom'
                            and d['dry_run'] is False for d in sim.dispatches))

    def test_both_wraps_and_all_adjacent_edges(self):
        for old in range(5):
            for delta, command in [(1, 'right'), (-1, 'left')]:
                sim = Replay()
                sim.put(CURSOR, old)
                sim.preset(PRESETS[(old + delta) % 5])
                self.assertEqual([d['command'] for d in sim.dispatches], [command])

    def test_paired_brightness_and_duplicates_do_not_dispatch(self):
        sim = Replay()
        sim.message({'action': 'brightness_move_to_level', 'action_level': 76,
                     'action_color_temperature': 454})
        self.assertEqual(sim.states(CURSOR), '4')
        sim.preset(454)
        sim.preset(454)
        sim.message({'action': 'brightness_move_to_level', 'action_level': 2})
        sim.preset(588)
        self.assertEqual([d['command'] for d in sim.dispatches], ['left', 'right'])
        self.assertEqual(len([c for c in sim.calls if c['action'] == 'input_number.set_value']), 2)

    def test_nonadjacent_presets_resync_without_guessing(self):
        sim = Replay()
        sim.preset(285)  # 588 -> 285 skips a preset; direction is ambiguous.
        self.assertEqual(sim.dispatches, [])
        self.assertEqual(sim.states(CURSOR), '1')
        sim.preset(370)
        self.assertEqual([d['command'] for d in sim.dispatches], ['right'])

    def test_unknown_payloads_leave_cursor_unchanged(self):
        sim = Replay()
        for payload in [None, [], {}, {'action': 'on'}, {'action': 'color_temperature_move'},
                        *[{'action': 'color_temperature_move', 'action_color_temperature': v}
                          for v in [None, True, False, '454', 455, 0, -1]]]:
            sim.message(payload)
        self.assertEqual(sim.dispatches, [])
        self.assertEqual(sim.states(CURSOR), '4')

    def test_missing_cursor_only_resynchronizes_and_area_is_dynamic(self):
        sim = Replay()
        for value in ['unknown', 'unavailable', '-1', '1.5', '5']:
            sim.put(CURSOR, value)
            sim.preset(454)
            self.assertEqual(sim.states(CURSOR), '3')
            self.assertEqual(sim.dispatches, [])
        sim.areas[DEVICE] = 'living_room'
        sim.preset(588)
        self.assertEqual(sim.dispatches[-1]['area'], 'living_room')
        sim.areas.pop(DEVICE)
        sim.preset(200)
        self.assertEqual(len(sim.dispatches), 1)
        self.assertEqual(sim.states(CURSOR), '0')

    def test_override_reset_does_not_reset_persistent_hardware_cursor(self):
        sim = Replay()
        sim.preset(454)
        sim.event('ls_override', {'op': 'clear_room', 'area': 'jonathan_bedroom', 'via': 'remote'})
        self.assertEqual(sim.states(CURSOR), '3')
        sim.preset(588)
        self.assertEqual([d['command'] for d in sim.dispatches], ['left', 'right'])
        helper = json.loads((ROOT / 'preset_helper.json').read_text())['input_number']['ls_bedroom_remote_preset']
        self.assertNotIn('initial', helper)
        self.assertEqual((helper['min'], helper['max'], helper['step']), (0, 4, 1))
        automation = sim.automations['preset']
        self.assertEqual(automation['mode'], 'queued')
        self.assertEqual(automation['triggers'][0]['topic'], 'zigbee2mqtt/' + IEEE)


if __name__ == '__main__':
    unittest.main()
