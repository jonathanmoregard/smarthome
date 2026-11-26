"""The e2e gate's verdict, on synthetic scenario results."""
from __future__ import annotations
import unittest

from tests.e2e.gate import Scenario, exact_line, verdict, without_replays


class Verdict(unittest.TestCase):
    def test_all_agree_on_the_flow(self):
        line, code = verdict({'a': Scenario(0, {}, {'level': 2}), 'b': Scenario(0, {}, {})}, units_passed=True)
        self.assertEqual(line, "e2e: golden 2/2 flow agree, flow differences 0, noted {'level': 2}, expected {}")
        self.assertEqual(code, 0)

    def test_flow_differences_fail_and_noted_and_expected_add_up(self):
        line, code = verdict({'a': Scenario(3, {'power': 3}, {'level': 1}, {'x': 2}),
                              'b': Scenario(0, {}, {'level': 2, 'fade-sampling': 1})}, units_passed=True)
        self.assertEqual(line, "e2e: golden 1/2 flow agree, flow differences 3, "
                               "noted {'fade-sampling': 1, 'level': 3}, expected {'x': 2}")
        self.assertEqual(code, 1)

    def test_exact_differences_never_fail(self):
        scenarios = {'a': Scenario(0, {}, {'level': 4}, exact=4, fields={'level': 4}, adjustments={'y': 1})}
        self.assertEqual(verdict(scenarios, units_passed=True)[1], 0)
        self.assertEqual(exact_line(scenarios),
                         "e2e --exact (information only): golden 0/1 agree, differences 4, adjustments {'y': 1}")

    def test_a_scenario_that_could_not_replay_fails_and_does_not_agree(self):
        line, code = verdict({'a': Scenario(0, {}, {}, error='StaleRecording: a')}, units_passed=True)
        self.assertEqual(line, 'e2e: golden 0/1 flow agree, flow differences 0, noted {}, expected {}, 1 not replayed')
        self.assertEqual(code, 1)

    def test_a_failing_unit_test_fails_the_gate(self):
        line, code = verdict({'a': Scenario(0, {}, {})}, units_passed=False)
        self.assertEqual(line, 'e2e: golden 1/1 flow agree, flow differences 0, noted {}, expected {}, unit tests failed')
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
