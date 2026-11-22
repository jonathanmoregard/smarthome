"""The e2e gate's verdict, on synthetic scenario results."""
from __future__ import annotations
import unittest

from tests.e2e.gate import Scenario, verdict, without_replays


class Verdict(unittest.TestCase):
    def test_all_agree(self):
        line, code = verdict({'a': Scenario(0, {}, {'x': 2}), 'b': Scenario(0, {}, {})}, units_passed=True)
        self.assertEqual(line, "e2e: golden 2/2 agree, differences 0, adjustments {'x': 2}")
        self.assertEqual(code, 0)

    def test_differences_fail_and_adjustments_add_up(self):
        line, code = verdict({'a': Scenario(3, {'level': 3}, {'x': 1}), 'b': Scenario(0, {}, {'x': 2, 'y': 1})},
                             units_passed=True)
        self.assertEqual(line, "e2e: golden 1/2 agree, differences 3, adjustments {'x': 3, 'y': 1}")
        self.assertEqual(code, 1)

    def test_a_scenario_that_could_not_replay_fails_and_does_not_agree(self):
        line, code = verdict({'a': Scenario(0, {}, {}, error='StaleRecording: a')}, units_passed=True)
        self.assertEqual(line, 'e2e: golden 0/1 agree, differences 0, adjustments {}, 1 not replayed')
        self.assertEqual(code, 1)

    def test_a_failing_unit_test_fails_the_gate(self):
        line, code = verdict({'a': Scenario(0, {}, {})}, units_passed=False)
        self.assertEqual(line, 'e2e: golden 1/1 agree, differences 0, adjustments {}, unit tests failed')
        self.assertEqual(code, 1)

    def test_no_scenario_replayed_is_not_a_pass(self):
        self.assertEqual(verdict({}, units_passed=True)[1], 1)


class WithoutReplays(unittest.TestCase):
    def test_the_golden_agrees_tests_are_left_to_the_gate(self):
        class Sample(unittest.TestCase):
            def test_x_agrees(self): ...
            def test_x_is_not_vacuous(self): ...
            def test_other(self): ...

        suite = unittest.TestSuite([unittest.TestLoader().loadTestsFromTestCase(Sample)])
        kept = [test.id().rsplit('.', 1)[1] for test in without_replays(suite)]
        self.assertEqual(kept, ['test_other', 'test_x_is_not_vacuous'])


if __name__ == '__main__':
    unittest.main()
