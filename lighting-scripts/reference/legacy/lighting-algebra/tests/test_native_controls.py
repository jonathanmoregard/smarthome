"""Existing HA control entry points keep channel and logical-lamp semantics."""
import copy
import unittest

from dry_harness import DrySim

LAMP = 'light.living_room_table_lamp'


class NativeControlTests(unittest.TestCase):
    def setUp(self):
        self.sim = DrySim()

    def capture(self, data, user='offline-user', service='turn_on'):
        self.sim.run_automation('automation_lighting_schedule_lamp_change_detector',
                                {'event': {'context': {'user_id': user, 'id': 'offline-native'},
                                           'data': {'service': service, 'service_data': data}}})

    def resolved(self):
        return self.sim.pure('ls_apply', dry_run=True, reason='config')['plan']['resolved']['targets']

    def test_ui_adapter_dry_run_is_pure_for_all_supported_attributes(self):
        for attribute, value in [('brightness', 80), ('rgb', [1, 2, 3]), ('temperature', 400),
                                 ('effect', 'Candle'), ('power', 'OFF')]:
            result = self.sim.pure('effects_set', source=LAMP, attribute=attribute,
                                   value=value, dry_run=True)
            self.assertTrue(result['valid'])

    def test_normal_light_label_stops_candle_without_changing_underlying_light(self):
        self.sim.run('effects_set', source=LAMP, attribute='brightness', value=80)
        self.sim.run('effects_set', source=LAMP, attribute='effect', value='Candle')
        self.sim.advance(1)
        proposed = self.sim.pure('effects_set', source=LAMP, attribute='effect',
                                value='Normal Light', dry_run=True)
        self.assertTrue(proposed['valid'], proposed['errors'])
        legacy = self.sim.pure('effects_set', source=LAMP, attribute='effect',
                              value='Normal light', dry_run=True)
        self.assertEqual(proposed, legacy)
        self.sim.run('effects_set', source=LAMP, attribute='effect', value='Normal Light')
        target = self.resolved()[LAMP]
        self.assertEqual(target['level'], 80)
        self.assertEqual(target['brightness']['kind'], 'constant')
        self.assertEqual(target['color']['kind'], 'constant')

    def test_normal_light_profile_label_uses_existing_schedule_clear_semantics(self):
        source = 'light.ls_house_day'
        titled = self.sim.pure('effects_set', source=source, attribute='effect',
                              value='Normal Light', dry_run=True)
        legacy = self.sim.pure('effects_set', source=source, attribute='effect',
                              value='Normal light', dry_run=True)
        self.assertTrue(titled['valid'], titled['errors'])
        self.assertEqual(titled, legacy)

    def test_native_rgb_claims_only_colour_without_stopping_brightness_effect(self):
        self.sim.run('effects_set', source=LAMP, attribute='effect', value='Candle')
        before = self.resolved()[LAMP]['brightness']
        self.sim.advance(1)
        self.capture({'entity_id': LAMP, 'rgb_color': [20, 30, 40]})
        after = self.resolved()[LAMP]
        self.assertEqual(after['brightness'], before)
        self.assertEqual(after['color']['kind'], 'constant')
        self.assertEqual(after['color']['value'], {'rgb': [20, 30, 40]})

    def test_native_physical_bulb_change_maps_to_existing_logical_lamp(self):
        self.capture({'entity_id': 'light.kitchen_pendant_bulb_1', 'brightness': 90})
        records = self.sim.attr('sensor.ls_overrides', 'overrides')
        self.assertEqual(len(records), 1)
        record = next(iter(records.values()))
        self.assertEqual(record['target'], 'light.kitchen_pendant')
        self.assertEqual(set(record['value']['channels']), {'brightness'})

    def test_native_full_room_group_updates_logical_room_level(self):
        self.capture({'entity_id': 'light.living_room', 'brightness_pct': 90})
        records = self.sim.attr('sensor.ls_overrides', 'overrides')
        self.assertEqual(len(records), 1)
        record = next(iter(records.values()))
        self.assertEqual(record['scope'], 'room')
        self.assertEqual(record['target'], 'living_room')
        self.assertEqual(self.resolved()['room:living_room']['level'], 229.5)

    def test_native_power_only_and_automation_calls_do_not_create_overrides(self):
        self.capture({'entity_id': LAMP})
        self.capture({'entity_id': LAMP}, service='turn_off')
        self.capture({'entity_id': LAMP, 'brightness': 80}, user=None)
        self.assertEqual(self.sim.attr('sensor.ls_overrides', 'overrides'), {})

    def test_ui_room_power_uses_persistent_state_without_mutating_overrides(self):
        self.sim.run('effects_set', source='light.living_room', attribute='brightness', value=90)
        before = copy.deepcopy(self.sim.attr('sensor.ls_overrides', 'overrides'))
        self.sim.advance(1)
        self.sim.run('effects_set', source='light.living_room', attribute='power', value='OFF')
        self.assertFalse(self.sim.attr('sensor.ls_overrides', 'power')['living_room'])
        self.assertEqual(self.sim.attr('sensor.ls_overrides', 'overrides'), before)

    def test_ui_effect_retains_same_control_sources_selected_brightness(self):
        self.sim.run('effects_set', source=LAMP, attribute='brightness', value=80)
        self.sim.advance(1)
        self.sim.run('effects_set', source=LAMP, attribute='effect', value='Candle')
        self.assertEqual(self.resolved()[LAMP]['brightness']['intensity'], 80)

    def test_room_effect_preserves_individual_lamp_schedule_baselines(self):
        self.sim.store('input_text.ls_lamp_living_room_table_lamp_day',
                       {'on': True, 'own': True, 'b': 75, 'm': 'ct', 'k': 2300})
        before = self.resolved()[LAMP]['level']
        self.sim.run('effects_set', source='light.living_room', attribute='effect', value='Candle')
        self.assertEqual(self.resolved()[LAMP]['brightness']['intensity'], before)

    def test_unknown_effect_and_unknown_target_fail_closed_in_dry_adapter(self):
        for source, effect in [(LAMP, 'Not Registered'), ('light.not_present', 'Candle')]:
            result = self.sim.pure('effects_set', source=source, attribute='effect',
                                   value=effect, dry_run=True)
            self.assertFalse(result['valid'])
            self.assertEqual(result['events'], [])
            self.assertEqual(result['commands'], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
