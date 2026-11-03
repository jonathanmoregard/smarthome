"""Harness regressions: paused callbacks nesting real execution, and failure
normalization, which decides whether two backends count as equivalent."""
import unittest
from tests.parity.rpc import Rpc, empty_snapshot
from tests.parity.run import normalized_error


def plan_snapshot():
    """Minimal real HA entity state for controller tests; HA always supplies last_updated."""
    snapshot = empty_snapshot()
    snapshot['state']['sensor.ls_overrides'] = {
        'state': '0', 'attributes': {}, 'last_updated': snapshot['now']}
    return snapshot


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

        result = self.rpc.call('ls_plan', {}, plan_snapshot(), callback=callback)
        self.assertTrue(observed)
        self.assertEqual(result['snapshot']['state']['input_number.parity_fixture']['state'], '7')

    def test_callback_exception_does_not_leave_the_server_paused(self):
        def callback(message):
            raise ValueError('fixture assertion failed')

        with self.assertRaisesRegex(ValueError, 'fixture assertion failed'):
            self.rpc.call('ls_plan', {}, plan_snapshot(), callback=callback)
        result = self.rpc.call('effects_group_plan', {'rows': [], 'groups': []}, empty_snapshot())
        self.assertEqual(result['result']['commands'], [])

    def test_unknown_entrypoint_fails_explicitly(self):
        with self.assertRaisesRegex(AssertionError, 'Unsupported script: parity_missing'):
            self.rpc.call('parity_missing', {}, empty_snapshot())

    def test_literal_dependency_is_consumed_by_the_real_typescript_caller(self):
        dependency = {'marker': ['literal', 7]}
        result = self.rpc.call('ls_apply', {'dry_run': True}, empty_snapshot(),
                               literal_dependencies={'ls_plan': dependency})
        self.assertEqual(result['result'], dependency)
        self.assertEqual(result['dependencyCalls'], ['ls_plan'])
        self.assertEqual(self.rpc.dependency_calls, ['ls_plan'])


STALE_PRECONDITION = '''Traceback (most recent call last):
  File "/tmp/parity-reference-a1b2/lighting-algebra/remote/test_remote.py", line 42, in setUp
    assert CENTER['mode'] == 'single'
AssertionError
'''

BEHAVIOURAL_DIFFERENCE = '''Traceback (most recent call last):
  File "/tmp/parity-reference-a1b2/lighting-algebra/remote/test_remote.py", line 91, in test_arrow_dispatch
    assert commands == ['left']
AssertionError
'''

# The same failing assert as STALE_PRECONDITION, seen by the other backend: a
# different staging directory, and a line number moved by a substituted seam.
SAME_ASSERT_OTHER_BACKEND = '''Traceback (most recent call last):
  File "/tmp/parity-typescript-9f8e/lighting-algebra/remote/test_remote.py", line 57, in setUp
    assert CENTER['mode'] == 'single'
AssertionError
'''

TYPED_WITH_MESSAGE = '''Traceback (most recent call last):
  File "/tmp/parity-reference-a1b2/lighting-algebra/remote/test_remote.py", line 12, in test_store
    handlers.run('ls_store', {})
ParseError: ls_store.store must be a string, got undefined
'''


class NormalizedErrorTests(unittest.TestCase):
    def test_two_unrelated_bare_asserts_do_not_compare_equal(self):
        self.assertNotEqual(
            normalized_error(STALE_PRECONDITION),
            normalized_error(BEHAVIOURAL_DIFFERENCE),
            'a bare AssertionError must carry enough context to tell two failures apart',
        )

    def test_the_same_bare_assert_compares_equal_across_backends(self):
        # Without this the fix would trade a false equivalence for a false
        # difference, and every stale-precondition module would report as a
        # behavioural divergence.
        self.assertEqual(
            normalized_error(STALE_PRECONDITION),
            normalized_error(SAME_ASSERT_OTHER_BACKEND),
        )

    def test_no_machine_path_survives_normalization(self):
        for raw in (STALE_PRECONDITION, BEHAVIOURAL_DIFFERENCE, TYPED_WITH_MESSAGE):
            normalized = normalized_error(raw)
            self.assertNotIn('/tmp/', normalized)
            self.assertNotIn('parity-reference', normalized)

    def test_a_typed_exception_with_a_message_is_unchanged(self):
        self.assertEqual(
            normalized_error(TYPED_WITH_MESSAGE),
            'ParseError: ls_store.store must be a string, got undefined',
        )

    def test_a_bare_assert_still_names_the_exception_type(self):
        self.assertIn('AssertionError', normalized_error(STALE_PRECONDITION))


if __name__ == '__main__':
    unittest.main()
