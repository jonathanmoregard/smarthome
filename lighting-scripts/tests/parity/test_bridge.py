"""Transport regressions: paused callbacks must support nested real execution."""
import unittest
from rpc import Rpc, empty_snapshot


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.rpc = Rpc()

    def tearDown(self):
        self.rpc.close()

    def test_nested_request_and_concurrent_state_survive_outer_resume(self):
        observed = []

        def callback(message):
            if not observed:
                observed.append(message['call']['service'])
                result = self.rpc.call('effects_scale', {
                    'day': {'brightness': 220, 'color': {'kelvin': 4000}},
                    'cosy': {'brightness': 110, 'color': {'kelvin': 2200}},
                    'position': 0}, empty_snapshot())
                self.assertEqual(result['result']['brightness'], 110)
            message['snapshot']['state']['input_number.parity_fixture'] = {'state': '7', 'attributes': {}}
            return message['snapshot']

        result = self.rpc.call('ls_plan', {}, empty_snapshot(), callback=callback)
        self.assertTrue(observed)
        self.assertEqual(result['snapshot']['state']['input_number.parity_fixture']['state'], '7')

    def test_callback_exception_does_not_leave_the_server_paused(self):
        def callback(message):
            raise ValueError('fixture assertion failed')

        with self.assertRaisesRegex(ValueError, 'fixture assertion failed'):
            self.rpc.call('ls_plan', {}, empty_snapshot(), callback=callback)
        result = self.rpc.call('effects_group_plan', {'rows': [], 'groups': []}, empty_snapshot())
        self.assertEqual(result['result']['commands'], [])

    def test_unknown_entrypoint_fails_explicitly(self):
        with self.assertRaisesRegex(AssertionError, 'Unsupported script: parity_missing'):
            self.rpc.call('parity_missing', {}, empty_snapshot())


if __name__ == '__main__':
    unittest.main()
