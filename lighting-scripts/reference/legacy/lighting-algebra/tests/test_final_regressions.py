"""Cross-component regressions from independent final review, no live IO."""
import copy
import json
import unittest

from dry_harness import RUNTIME, DrySim, check_traffic
import test_integration

LAMP = 'light.living_room_hall_ceiling'
OTHER = 'light.kitchen_pendant'


class FinalRegressionTests(unittest.TestCase):
    def test_fresh_remote_direction_is_monotone_outside_and_between_anchors(self):
        for day, cosy, initial in [(150, 150, 230), (150, 150, 100), (150, 150, 8),
                                   (230, 110, 250), (230, 110, 150), (230, 110, 90),
                                   (230, 110, 8), (150, 140, 80)]:
            for command in ['up', 'down']:
                with self.subTest(day=day, cosy=cosy, initial=initial, command=command):
                    sim = DrySim()
                    for period, brightness in [('day', day), ('cosy', cosy)]:
                        sim.store('input_text.ls_house_' + period,
                                  {'on': True, 'b': brightness, 'm': 'ct', 'k': 3000})
                    sim.run('effects_set', source='light.living_room', attribute='brightness', value=initial)
                    sim.advance(1)
                    command_plan = sim.pure('ls_remote_command', source='freshremote',
                                            area='living_room', command=command, dry_run=True)
                    sim.event('ls_override', command_plan)
                    after = sim.pure('ls_apply', dry_run=True, reason='config')['plan']['resolved']['targets']['room:living_room']['level']
                    if command == 'up':
                        self.assertGreaterEqual(after, initial)
                    else:
                        self.assertLessEqual(after, initial)

    def test_expired_period_cannot_leak_day_into_first_night_resolution(self):
        sim = test_integration.IntegrationTests().configured()
        sim.put('input_boolean.ls_ovr_next_block_on', 'on')
        record = {'kind': 'channels', 'scope': 'room', 'target': 'living_room',
                  'when': '2026-10-23T22:00:00+02:00', 'value': {'period': 'day', 'channels': {}}}
        overrides = {'channels:oldremote': record,
                     'mode:sara': {'kind': 'mode', 'target': 'sara', 'value': 'on',
                                   'when': '2026-10-24T00:50:00+02:00'}}
        plan = sim.pure('ls_apply', dry_run=True, force_all=True, reason='config',
                        test_now='2026-10-24T01:00:00+02:00', test_overrides=overrides)['plan']
        for entity in [LAMP, 'room:living_room']:
            with self.subTest(entity=entity):
                target = plan['resolved']['targets'][entity]
                self.assertEqual(target['period'], 'night')
                self.assertEqual(target['level'], 8)
                self.assertEqual(target['color']['value'], {'rgb': [255, 0, 0]})
        self.assertIn('channels:oldremote', plan['stale_keys'])

    def test_shared_sara_expires_independently_for_rooms_with_different_timing(self):
        sim = DrySim()
        sim.put('input_boolean.ls_ovr_next_block_on', 'on')
        sim.put('input_boolean.ls_kitchen_cosy_own_timing', 'on')
        sim.put('input_datetime.ls_kitchen_cosy_start', '19:00:00')
        sim.put('input_datetime.ls_kitchen_cosy_weekend', '19:00:00')
        overrides = {'mode:sara': {'kind': 'mode', 'target': 'sara', 'value': 'on',
                                   'when': '2026-10-23T17:00:00+02:00'}}
        plan = sim.pure('ls_apply', dry_run=True, force_all=True, reason='config',
                        test_now='2026-10-23T18:05:00+02:00', test_overrides=overrides)['plan']
        self.assertNotIn('mode:sara', plan['stale_keys'])
        for entity in [LAMP, 'room:living_room']:
            self.assertNotEqual(plan['resolved']['targets'][entity]['color'].get('value'),
                                {'rgb': [255, 105, 180]})
        for entity in [OTHER, 'room:kitchen']:
            self.assertEqual(plan['resolved']['targets'][entity]['color']['value'],
                             {'rgb': [255, 105, 180]})

    def test_legacy_native_cleanup_precedes_software_runner_start(self):
        sim = DrySim()
        sim.run('effects_set', source=OTHER, attribute='effect', value='Candle')
        resolved = sim.pure('ls_apply', dry_run=True, reason='config')['plan']['resolved']
        sim.put(RUNTIME, '1', {'assignments': {OTHER: {'effect': 'Colour loop'}},
                                                 'targets': {}, 'revision': 'previous'})
        revision = sim.states['sensor.ls_overrides'].last_updated.isoformat()
        sim.calls.clear()
        sim.run('effects_assign', **resolved, revision=revision)
        sends = check_traffic(sim.calls, None if 'ls_commit' in sim.config else 5)
        self.assertEqual(len(sends), 6)
        self.assertEqual({json.loads(call['data']['payload'])['effect'] for call in sends},
                         {'stop_colorloop', 'stop_effect'})
        start = next(index for index, call in enumerate(sim.calls)
                     if call['action'] == 'script.turn_on')
        self.assertTrue(all(sim.calls.index(call) < start for call in sends))
        self.assertIn('room:living_room', sim.attr(RUNTIME, 'targets'))
        self.assertNotIn('room:living_room', sim.attr(RUNTIME, 'assignments'))

    def test_queued_stale_assignment_cannot_stop_engine_or_replace_controller(self):
        sim = DrySim()
        stale = sim.pure('ls_apply', dry_run=True, reason='config')['plan']['resolved']
        old_revision = sim.states['sensor.ls_overrides'].last_updated.isoformat()
        sim.advance(1)
        sim.event('ls_override', {'op': 'power', 'area': 'kitchen', 'on': False})
        sim.put(RUNTIME, '1', {'targets': {'newest': {}},
                                                 'assignments': {'newest': {}},
                                                 'generation': 'current-generation',
                                                 'revision': sim.states['sensor.ls_overrides'].last_updated.isoformat()})
        sim.put('script.effects_engine', 'on')
        sim.pure('effects_assign', **stale, revision=old_revision)
        self.assertTrue(sim.is_state('script.effects_engine', 'on'))
        self.assertEqual(sim.attr(RUNTIME, 'generation'), 'current-generation')

    def test_native_effect_takeover_stops_device_once_not_on_unchanged_reconcile(self):
        sim = DrySim()
        sim.run_automation('automation_lighting_schedule_lamp_change_detector', {
            'event': {'context': {'user_id': 'offline-user', 'id': 'native-new'},
                      'data': {'service': 'turn_on', 'service_data': {'entity_id': OTHER, 'effect': 'colorloop'}}}})
        resolved = sim.pure('ls_apply', dry_run=True, reason='config')['plan']['resolved']
        revision = sim.states['sensor.ls_overrides'].last_updated.isoformat()
        sim.calls.clear()
        sim.run('effects_assign', **resolved, revision=revision)
        self.assertEqual(len(check_traffic(sim.calls, None if 'ls_commit' in sim.config else 5)), 6)
        sim.calls.clear()
        sim.run('effects_assign', **resolved, revision=revision)
        self.assertEqual(check_traffic(sim.calls, None if 'ls_commit' in sim.config else 5), [])

    def test_requested_lamp_filters_dispatch_without_losing_other_effects_or_rooms(self):
        sim = DrySim()
        sim.run('effects_set', source=OTHER, attribute='effect', value='Candle')
        if 'ls_commit' in sim.config:
            sim.apply(reason='config')  # Settle earlier pending work before testing forced resend.
        catalog = sim.pure('effects_catalog')
        allowed = {catalog['topics'][entity] for entity in catalog['members'][LAMP]}
        sim.calls.clear()
        sim.apply( reason='config', lights=[LAMP])
        sends = [call for call in sim.physical() if call['action'] == 'mqtt.publish']
        self.assertTrue(sends)
        self.assertTrue(all(call['data']['topic'] in allowed for call in sends))
        self.assertIn(OTHER, sim.attr(RUNTIME, 'assignments'))
        self.assertIn('room:kitchen', sim.attr(RUNTIME, 'targets'))

    def test_switch_only_room_is_resolved_and_respects_requested_dispatch(self):
        sim = DrySim()
        entity = 'switch.annex_bright'
        sim.areas[entity] = 'annex'
        sim.put(entity, 'off')
        attrs = copy.deepcopy(sim.state['sensor.ls_overrides']['attributes'])
        attrs['switch_ranges'] = {entity: {'profile': 'custom', 'min': 0, 'max': 100}}
        sim.put('sensor.ls_overrides', '0', attrs)
        plan = sim.pure('ls_apply', dry_run=True, reason='config')['plan']
        self.assertIn('room:annex', plan['resolved']['targets'])
        sim.calls.clear()
        sim.apply( reason='config', lights=[LAMP])
        if 'ls_commit' in sim.config:
            # Explicit lamp IDs force resend; they must not suppress other
            # pending configuration in the coalesced full reconcile.
            self.assertTrue(sim.is_state(entity, 'on'))
            sim.put(entity, 'off')
        else:
            self.assertFalse(any(call['target'].get('entity_id') == entity for call in sim.calls))
        sim.calls.clear()
        sim.apply( reason='config', lights=[entity])
        self.assertTrue(any(call['action'] == 'homeassistant.turn_on' and
                            call['target'].get('entity_id') == entity for call in sim.calls))

    def test_standalone_ui_on_opens_room_gate_without_turning_on_siblings(self):
        sim = DrySim()
        siblings = [lamp for lamp, area in sim.areas.items() if area == 'living_room' and lamp != LAMP]
        for lamp in [LAMP] + siblings:
            sim.put(lamp, 'off')
        sim.event('ls_override', {'op': 'power', 'area': 'living_room', 'on': False})
        sim.calls.clear()
        sim.run('effects_set', source=LAMP, attribute='power', value='ON')
        self.assertTrue(sim.attr('sensor.ls_overrides', 'power')['living_room'])
        self.assertTrue(sim.is_state(LAMP, 'on'))
        self.assertTrue(all(sim.is_state(entity, 'off') for entity in siblings))
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), {})

    def test_ui_sync_uses_logical_room_level_and_sara_color_in_pure_dry_run(self):
        sim = DrySim()
        sim.run('effects_set', source='light.living_room', attribute='brightness', value=231)
        sim.event('ls_override', {'op': 'set', 'records': [{'kind': 'mode', 'target': 'sara', 'value': 'on'}]})
        resolved = sim.pure('ls_apply', dry_run=True, reason='config')['plan']['resolved']
        revision = sim.states['sensor.ls_overrides'].last_updated.isoformat()
        sim.run('effects_assign', **resolved, revision=revision)
        row = next(row for step in sim.config['effects_ui_sync']['sequence']
                   for row in step.get('variables', {}).get('rows', [])
                   if row['source'] == 'light.living_room')
        sim.put('light.living_room', 'on', {'brightness': 12, 'color_mode': 'color_temp', 'color_temp_kelvin': 3000})
        messages = {message['topic']: message['payload'] for message in
                    sim.pure('effects_ui_sync', dry_run=True, force=True)['messages']}
        self.assertEqual(messages[row['topics']['brightness']], '231')
        self.assertEqual(messages[row['topics']['rgb']], '255,105,180')


if __name__ == '__main__':
    unittest.main(verbosity=2)
