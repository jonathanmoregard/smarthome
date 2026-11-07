"""Actual preset decoder and gesture router through actual remote/store logic."""
import copy
import json
import sys
import unittest

from dry_harness import DrySim, ROOT, DEFAULT_CANDIDATE

sys.path.insert(0, '/tmp/lighting-algebra/remote')
from gesture_test import Replay, REMOTES, PRESETS, arrow, brightness, chord, direction, power


class IntegratedReplay(Replay):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # The deployment manifest is authoritative. Historical gesture_script
        # and power_done aliases are intentionally not loaded as active routes.
        manifest = json.loads((ROOT / 'remote/gesture_manifest.json').read_text())
        for item in manifest['scripts']:
            self.config[item['entity_id'].removeprefix('script.')] = json.loads(
                (DEFAULT_CANDIDATE / item['file']).read_text())
        for item in manifest['automations']:
            key = item['file'].removesuffix('.json').removeprefix('gesture_')
            self.automations[key] = json.loads((DEFAULT_CANDIDATE / item['file']).read_text())

    def run(self, name, **context):
        previous = getattr(self, 'controller_running', False)
        if name == 'ls_remote_command':
            self.controller_running = True
        try:
            return super().run(name, **context)
        finally:
            self.controller_running = previous

    def seq(self, steps, context):
        # The actor has no waits. Actual logical commands separately wait for
        # their writer acknowledgement, after asynchronous input dispatch.
        if getattr(self, 'controller_running', False):
            return DrySim.seq(self, steps, context)
        return super().seq(steps, context)

    def execute_intent(self, data):
        index = getattr(self, 'executed_count', 0)
        self.advance(.001)
        result = self.run('ls_remote_command', **data)
        records = self.attr('sensor.ls_overrides', 'overrides') or {}
        self.commands[index]['selection'] = records.get('channels:' + data['source'], {}).get('value', {}).get('selection')
        self.commands[index]['sara_enabled'] = 'mode:sara' in records
        self.executed_count = index + 1
        return result

    def service(self, action, target, data):
        if getattr(self, 'capture_only', False):
            assert action not in ['script.ls_remote_command', 'script.ls_plan', 'script.ls_base',
                                  'script.effects_resolve', 'script.effects_assign', 'script.effects_emit']
        entity = target.get('entity_id', '')
        async_remote = (action == 'script.turn_on' and isinstance(entity, str)
                        and (entity == 'script.ls_remote_command'
                             or entity.startswith(('script.ls_remote_power_quiet_', 'script.ls_remote_gesture_'))))
        token_write = (action == 'input_text.set_value' and isinstance(entity, str)
                       and entity.endswith('_remote_power_token'))
        if (action.startswith('script.ls_remote_gesture_')
                or action in ['input_number.set_value', 'timer.start', 'timer.cancel']
                or async_remote or token_write):
            return super().service(action, target, data)
        return DrySim.service(self, action, target, data)


class GestureIntegrationTests(unittest.TestCase):
    def test_real_preset_wrap_advances_and_wraps_the_logical_cycle_in_both_rooms(self):
        for room in REMOTES:
            for delta, command in [(1, 'right'), (-1, 'left')]:
                with self.subTest(room=room, command=command):
                    initial = 4 if delta == 1 else 0
                    events = [arrow(.03 * (index + 1), PRESETS[(initial + delta * (index + 1)) % 5], room)
                              for index in range(10)]
                    sim = IntegratedReplay(events)
                    sim.put('input_boolean.ls_ovr_next_block_on', 'off')
                    sim.put('input_number.ls_' + room + '_remote_preset', initial)
                    choices = ['day', 'cosy', 'Candle']
                    result = sim.drive()
                    self.assertEqual([item['command'] for item in result], [command] * 10)
                    self.assertEqual([item['selection'] for item in result],
                                     [choices[(delta * (index + 1)) % len(choices)] for index in range(10)])
                    self.assertNotIn('mode:sara', sim.attr('sensor.ls_overrides', 'overrides'))
                    self.assertEqual(sim.physical(), [])

    def test_secret_gesture_twice_uses_actual_global_toggle_without_power_or_channel_changes(self):
        sim = IntegratedReplay(chord() + chord(1))
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        sim.run('effects_set', source='light.living_room', attribute='effect', value='Candle')
        sim.event('ls_override', {'op': 'power', 'area': 'living_room', 'on': False})
        original = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides'))
        power_state = copy.deepcopy(sim.attr('sensor.ls_overrides', 'power'))
        result = sim.drive()
        self.assertEqual([item['command'] for item in result], ['sara_toggle', 'sara_toggle'])
        self.assertEqual([item['sara_enabled'] for item in result], [True, False])
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), original)
        self.assertEqual(sim.attr('sensor.ls_overrides', 'power'), power_state)
        self.assertEqual(sim.physical(), [])
        self.assertFalse(any(call['action'] in ['homeassistant.turn_on', 'homeassistant.turn_off'] for call in sim.calls))

    def test_captured_mixed_brightness_and_temperature_frames_toggle_sara_once(self):
        events = [power(0), power(.1), brightness(.12, 2), arrow(.125, 588),
                  brightness(.14, 254), brightness(.16, 2), arrow(.165, 588), arrow(.18, 200)]
        sim = IntegratedReplay(events)
        sim.put('input_number.ls_bedroom_remote_preset', 0)
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        result = sim.drive()
        self.assertEqual([item['command'] for item in result], ['sara_toggle'])
        self.assertEqual(set(sim.attr('sensor.ls_overrides', 'overrides')), {'mode:sara'})
        self.assertEqual(sim.attr('sensor.ls_overrides', 'power') or {}, {})
        self.assertEqual(sim.physical(), [])

    def test_double_power_resets_hardware_cursor_but_preserves_logical_selection(self):
        events = [power(0), power(.1), arrow(.12, 588), arrow(.14, 200),
                  arrow(.16, 588), arrow(.18, 200)]
        sim = IntegratedReplay(events)
        sim.put('input_number.ls_bedroom_remote_preset', 2)
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        source, _, area = REMOTES['bedroom']
        sim.run('ls_remote_command', source=source, area=area, command='left')
        key = 'channels:' + source
        logical_record = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides')[key])
        result = sim.drive()
        self.assertEqual([item['command'] for item in result], ['sara_toggle'])
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides')[key], logical_record)
        self.assertIn('mode:sara', sim.attr('sensor.ls_overrides', 'overrides'))
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_preset'), '0')

    def test_blocked_logical_dispatch_does_not_delay_third_power_or_arrow_capture(self):
        events = [direction(0, 'up'), power(.01), power(.02), power(.03), arrow(.04, 588), arrow(.05, 200)]
        sim = IntegratedReplay(events, defer_commands=True)
        sim.put('input_number.ls_bedroom_remote_preset', 2)
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        sim.run('effects_set', source='light.jonathan_bedroom', attribute='brightness', value=211)
        sim.event('ls_override', {'op': 'power', 'area': 'jonathan_bedroom', 'on': False})
        original = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides'))
        sim.capture_only = True
        result = sim.drive()
        self.assertEqual([item['command'] for item in result], ['up', 'left', 'right', 'reset'])
        for actual, expected in zip([item['time'] for item in result], [0, .04, .05, .43]):
            self.assertAlmostEqual(actual, expected)
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), original)
        self.assertEqual(getattr(sim, 'executed_count', 0), 0)
        self.assertEqual(len(sim.pending_commands), 4)
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_preset'), '0')
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_power_count'), '0')
        sim.capture_only = False
        sim.flush_commands()
        self.assertEqual(sim.pending_commands, [])
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), {})
        self.assertFalse(sim.attr('sensor.ls_overrides', 'power')['jonathan_bedroom'])
        self.assertNotIn('mode:sara', sim.attr('sensor.ls_overrides', 'overrides'))
        self.assertEqual(sim.physical(), [])

    def test_new_center_router_power_then_triple_reset_preserves_power_and_global_sara(self):
        sim = IntegratedReplay([power(0), power(1), power(1.1), power(1.2)])
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        sim.run('effects_set', source='light.jonathan_bedroom', attribute='effect', value='Candle')
        sim.event('ls_override', {'op': 'set', 'records': [{'kind': 'mode', 'target': 'sara', 'value': 'on'}]})
        result = sim.drive()
        self.assertEqual([item['command'] for item in result], ['toggle', 'reset'])
        self.assertFalse(sim.attr('sensor.ls_overrides', 'power')['jonathan_bedroom'])
        self.assertEqual(set(sim.attr('sensor.ls_overrides', 'overrides')), {'mode:sara'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
