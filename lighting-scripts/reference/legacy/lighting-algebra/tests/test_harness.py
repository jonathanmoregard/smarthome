"""Small checks for the offline interpreter's safety boundary."""
import unittest

from dry_harness import DrySim


class HarnessSafety(unittest.TestCase):
    def test_native_render_preserves_hex_ids_but_keeps_decimal_values_typed(self):
        sim = DrySim(candidate=None)
        for value, expected in [('0x385b44fffea50c99', '0x385b44fffea50c99'),
                                ('0o71', '0o71'), ('0b10', '0b10'),
                                ('123', 123), ('-2.5', -2.5), ('1e3', 1000),
                                ('True', True), ('[1, 2]', [1, 2])]:
            with self.subTest(value=value):
                result = sim.render('{{ value }}', {'value': value})
                self.assertEqual(result, expected)
                self.assertEqual(isinstance(result, str), isinstance(expected, str))

    def test_unknown_external_action_is_rejected(self):
        sim = DrySim(candidate=None)
        with self.assertRaisesRegex(AssertionError, 'Unknown external action blocked'):
            sim.service('unrecognized.service', {}, {})

    def test_current_plan_has_no_external_effects(self):
        sim = DrySim(candidate=None)
        plan = sim.pure('ls_apply', dry_run=True, reason='config')
        self.assertIn('plan', plan)

    def test_dry_assertion_catches_accidental_service_call(self):
        sim = DrySim(candidate=None)
        sim.config['unsafe_fixture'] = {'sequence': [
            {'action': 'mqtt.publish', 'data': {'topic': 'zigbee2mqtt/fixture/set',
                                              'payload': '{}', 'retain': False}}]}
        with self.assertRaisesRegex(AssertionError, 'external action'):
            sim.pure('unsafe_fixture')

    def test_override_event_executes_exported_writer(self):
        sim = DrySim(candidate=None)
        sim.event('ls_override', {'op': 'set', 'records': [
            {'kind': 'light', 'target': 'light.living_room_table_lamp',
             'value': {'brightness': 90}}], 'via': 'offline-test'})
        record = sim.attr('sensor.ls_overrides', 'overrides')['light:light.living_room_table_lamp']
        self.assertEqual(record['value'], {'brightness': 90})
        self.assertEqual(record['via'], 'offline-test')


if __name__ == '__main__':
    unittest.main(verbosity=2)
