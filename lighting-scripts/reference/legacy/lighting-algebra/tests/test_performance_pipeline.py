"""Behavioral races against generated synchronous-commit/asynchronous-render scripts."""
import copy
import json
import random
import unittest

from performance_harness import PerformanceSim, RUNTIME


class PerformancePipelineTests(unittest.TestCase):
    def assert_drained(self, sim):
        self.assertEqual(sim.pending_rooms(), set())
        self.assertEqual(sim.attr('sensor.ls_overrides', 'full_version'),
                         sim.attr(RUNTIME, 'handled_full'))
        self.assertEqual(sim.attr(RUNTIME, 'revision'),
                         sim.state['sensor.ls_overrides']['last_updated'])

    def test_commit_is_synchronous_but_render_stays_deferred(self):
        s = PerformanceSim(); s.seed()
        prior = copy.deepcopy(s.attr(RUNTIME, 'targets'))
        s.remote()
        self.assertIn('channels:offline-living_room', s.attr('sensor.ls_overrides', 'overrides'))
        self.assertEqual(s.pending_rooms(), {'living_room'})
        self.assertEqual(len(s.render_jobs), 1)
        self.assertEqual(s.attr(RUNTIME, 'targets'), prior)
        self.assertEqual(s.sends(), [])
        self.assertNotIn('ls_render', s.script_runs)
        self.assertEqual(s.events, [])
        self.assertEqual(s.blocking_steps, [])
        s.drain(); self.assert_drained(s)
        self.assertFalse(any(c['action'] == 'mqtt.publish' and
                             c['data']['topic'] == 'house/v1/effects/controller' for c in s.calls))

    def test_two_room_inputs_one_latest_drain_preserves_both(self):
        s = PerformanceSim(); s.seed()
        s.remote('living_room'); s.remote('kitchen')
        self.assertEqual(s.pending_rooms(), {'living_room', 'kitchen'})
        s.drain_one(); self.assert_drained(s)
        self.assertEqual({s.areas[lamp] for lamp in s.framed_lamps()}, {'living_room', 'kitchen'})
        before = copy.deepcopy(s.attr(RUNTIME, 'targets'))
        s.calls.clear(); s.script_runs.clear()
        s.drain()
        self.assertEqual(s.sends(), [])
        self.assertEqual(s.attr(RUNTIME, 'targets'), before)
        self.assertNotIn('ls_room_plan', s.script_runs)
        self.assertNotIn('ls_plan', s.script_runs)

    def test_room_only_change_never_replans_or_sends_other_rooms(self):
        s = PerformanceSim(); s.seed()
        prior = copy.deepcopy(s.attr(RUNTIME, 'targets'))
        s.remote(); s.drain()
        self.assertNotIn('ls_plan', s.script_runs)
        self.assertNotIn('ls_base', s.script_runs)
        self.assertEqual({s.areas[lamp] for lamp in s.framed_lamps()}, {'living_room'})
        self.assertEqual({key: value for key, value in s.attr(RUNTIME, 'targets').items() if value['area'] != 'living_room'},
                         {key: value for key, value in prior.items() if value['area'] != 'living_room'})

    def test_cross_room_input_mid_output_leaves_both_pending_then_repairs(self):
        s = PerformanceSim(); s.seed(); s.remote()
        injected = []
        def after(action, target, data):
            if action == 'mqtt.publish' and data['topic'].startswith('zigbee2mqtt/') and not injected:
                injected.append(True); s.remote('kitchen')
        s.after_service = after
        s.drain_one()
        self.assertTrue(injected)
        self.assertEqual(s.pending_rooms(), {'living_room', 'kitchen'})
        self.assertTrue(all(s.areas.get(lamp) != 'living_room' for lamp in s.attr(RUNTIME, 'applied')))
        s.after_service = None; s.calls.clear(); s.drain(); self.assert_drained(s)
        self.assertEqual({s.areas[lamp] for lamp in s.framed_lamps()}, {'living_room', 'kitchen'})

    def test_full_profile_work_survives_remote_revision_during_output(self):
        s = PerformanceSim(); s.seed()
        s.store('input_text.ls_house_day', {'on': True, 'b': 220, 'm': 'ct', 'k': 3000})
        s.run('ls_apply', reason='config')
        injected = []
        def after(action, target, data):
            if action == 'mqtt.publish' and data['topic'].startswith('zigbee2mqtt/') and not injected:
                injected.append(True); s.remote()
        s.after_service = after; s.drain_one()
        self.assertTrue(injected)
        self.assertNotEqual(s.attr('sensor.ls_overrides', 'full_version'), s.attr(RUNTIME, 'handled_full'))
        s.after_service = None; s.drain(); self.assert_drained(s)
        self.assertEqual(s.attr(RUNTIME, 'targets')['room:kitchen']['level'], 220)

    def test_moving_stable_remote_record_repairs_old_and_new_rooms(self):
        s = PerformanceSim(); s.seed()
        s.remote('living_room', source='movable'); s.drain()
        s.calls.clear(); s.remote('kitchen', source='movable')
        self.assertEqual(s.pending_rooms(), {'living_room', 'kitchen'})
        s.drain(); self.assert_drained(s)
        targets = s.attr(RUNTIME, 'targets')
        self.assertEqual(targets['room:living_room']['owners']['brightness'], 'base')
        self.assertEqual(targets['room:kitchen']['owners']['brightness'], 'channels:movable')

    def test_sara_from_private_room_updates_common_rooms_without_claiming_private(self):
        s = PerformanceSim(); s.seed()
        before = copy.deepcopy(s.attr('sensor.ls_overrides', 'overrides'))
        s.remote('jonathan_bedroom', 'sara_toggle'); s.drain(); self.assert_drained(s)
        self.assertEqual(set(s.attr('sensor.ls_overrides', 'overrides')) - set(before), {'mode:sara'})
        targets = s.attr(RUNTIME, 'targets')
        self.assertEqual(targets['room:jonathan_bedroom']['color']['value'], {'kelvin': 3000})
        self.assertIn('rgb', targets['room:living_room']['color']['value'])
        self.assertIn('rgb', targets['room:kitchen']['color']['value'])

    def test_new_dirty_stamp_during_ack_is_not_acknowledged_by_old_batch(self):
        s = PerformanceSim(); s.seed(); s.remote()
        captured = copy.deepcopy(s.attr('sensor.ls_overrides', 'pending_rooms'))
        injected = []
        def before(action, target, data):
            if action == 'variable.update_sensor' and target.get('entity_id') == RUNTIME and 'handled_rooms' in data.get('attributes', {}) and not injected:
                injected.append(True); s.remote()
        s.before_service = before; s.drain_one()
        self.assertTrue(injected)
        self.assertEqual(s.attr(RUNTIME, 'handled_rooms'), captured)
        self.assertEqual(s.pending_rooms(), {'living_room'})
        s.before_service = None; s.drain(); self.assert_drained(s)

    def test_bridge_failure_leaves_work_pending_for_recovery(self):
        s = PerformanceSim(); s.seed(); s.remote()
        s.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'off')
        s.drain()
        self.assertEqual(s.pending_rooms(), {'living_room'})
        self.assertEqual(s.sends(), [])
        s.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on')
        s.run_automation('automation_lighting_output_recovery', {'platform': 'state'})
        self.assertEqual(len(s.render_jobs), 1)
        s.drain(); self.assert_drained(s)
        self.assertTrue(s.sends())

    def test_partial_then_reset_to_original_value_resends_unknown_applied(self):
        s = PerformanceSim(); s.seed()
        initial = copy.deepcopy(s.attr(RUNTIME, 'applied'))
        s.remote('kitchen')
        injected = []
        def after(action, target, data):
            if action == 'mqtt.publish' and data['topic'].startswith('zigbee2mqtt/') and not injected:
                injected.append(True); s.remote('kitchen', 'reset')
        s.after_service = after; s.drain_one()
        self.assertTrue(injected)
        self.assertNotIn('light.kitchen_pendant', s.attr(RUNTIME, 'applied'))
        s.after_service = None; s.calls.clear(); s.drain(); self.assert_drained(s)
        self.assertIn('light.kitchen_pendant', s.framed_lamps())
        self.assertTrue(s.sends())
        self.assertEqual(s.attr(RUNTIME, 'applied')['light.kitchen_pendant'], initial['light.kitchen_pendant'])

    def test_stale_expected_revision_rejected_without_mutation_or_scheduling(self):
        s = PerformanceSim(); s.seed()
        prior = copy.deepcopy(s.state['sensor.ls_overrides'])
        result = s.run('ls_commit', data={'op': 'clear_all', 'expected_revision': 'old'})
        self.assertFalse(result['accepted'])
        self.assertEqual(s.state['sensor.ls_overrides'], prior)
        self.assertEqual(len(s.render_jobs), 0)

    def test_competing_write_between_remote_calculation_and_commit_retries_from_latest(self):
        s = PerformanceSim(); s.seed(); injected = []
        def before(action, target, data):
            if action == 'script.ls_commit' and data['data'].get('via') == 'remote' and not injected:
                injected.append(True)
                s.run('ls_commit', data={'op': 'set', 'records': [{
                    'kind': 'channels', 'key': 'channels:competing-ui',
                    'scope': 'room', 'target': 'living_room',
                    'value': {'channels': {'brightness': {'kind': 'constant', 'value': 230,
                                                        'updated': s.now.timestamp()}}}}]})
        s.before_service = before; s.remote(); s.before_service = None
        self.assertTrue(injected)
        self.assertGreaterEqual(s.script_runs.count('ls_remote_plan'), 2)
        self.assertEqual(s.blocking_steps, [])
        s.drain(); self.assert_drained(s)
        self.assertGreater(s.attr(RUNTIME, 'targets')['room:living_room']['level'], 230)

    def test_repeated_identical_full_configuration_is_output_silent(self):
        s = PerformanceSim(); s.seed()
        s.run('ls_apply', reason='config'); s.drain(); self.assert_drained(s)
        self.assertEqual(s.sends(), [])
        self.assertEqual(s.blocking_steps, [])

    def test_full_range_request_and_lamp_on_merge_preserve_unrelated_switch_work(self):
        s = PerformanceSim(); s.seed()
        s.areas['switch.offline_bright'] = 'living_room'
        s.put('switch.offline_bright', 'off')
        s.run('ls_commit', data={'op': 'range_set', 'entity': 'switch.offline_bright',
                                'profile': 'custom', 'min': 0, 'max': 100})
        s.run('ls_apply', reason='lamp_on', lights=['light.kitchen_pendant'])
        s.drain(); self.assert_drained(s)
        self.assertEqual(s.states('switch.offline_bright'), 'on')
        self.assertIn('light.kitchen_pendant', s.framed_lamps())

    def test_random_interleaved_rooms_equal_final_full_resolution(self):
        s = PerformanceSim(); s.seed(); rng = random.Random(8273)
        for index in range(45):
            room = rng.choice(['living_room', 'kitchen', 'jonathan_bedroom'])
            s.remote(room, rng.choice(['up', 'down', 'left', 'right', 'reset']))
            if index % 7 == 0:
                s.drain_one()
        oracle = s.pure('ls_plan')['plan']['resolved']
        s.drain(); self.assert_drained(s)
        self.assertEqual(s.attr(RUNTIME, 'targets'), oracle['targets'])
        self.assertEqual(s.attr(RUNTIME, 'assignments'), oracle['assignments'])
        keys = [key for key in s.attr('sensor.ls_overrides', 'overrides') if key.startswith('channels:offline-')]
        self.assertLessEqual(len(keys), 3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
