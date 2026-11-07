"""Feed synthetic MQTT arrivals through the actual gesture automation."""
import random
import unittest

from dry_harness import DrySim


class GestureTests(unittest.TestCase):
    def execute(self, delays, irrelevant=False, area='living_room'):
        sim = DrySim()
        config = sim.automations['automation_remote_center']
        topic = config['triggers'][0]['topic']
        # Actual remote device id comes from the exported direction automation.
        sim.env.globals['area_id'] = lambda entity: area
        arrivals = [{'time': delay, 'topic': topic, 'payload': 'on' if index % 2 else 'off'}
                    for index, delay in enumerate(delays)]
        if irrelevant:
            arrivals += [{'time': .1, 'topic': topic, 'payload': 'brightness_up'},
                         {'time': .2, 'topic': 'unrelated/action', 'payload': 'on'}]
        sim.queue_mqtt(arrivals)
        sim.run_automation('automation_remote_center', {'topic': topic, 'payload': 'on'})
        calls = [call for call in sim.calls if call['action'] == 'script.ls_remote_command']
        return sim, calls

    def test_single_click_toggles_only_after_quiet_interval(self):
        sim, calls = self.execute([])
        self.assertEqual([call['data']['command'] for call in calls], ['toggle'])
        self.assertGreaterEqual(calls[0]['time'], .4)
        self.assertEqual(sim.attr('sensor.ls_overrides', 'power')['living_room'], False)

    def test_double_click_is_noop(self):
        sim, calls = self.execute([.2])
        self.assertEqual(calls, [])
        self.assertEqual(sim.physical(), [])
        self.assertEqual(sim.events, [])

    def test_three_or_more_clicks_reset_once_without_intermediate_toggle(self):
        for count in [3, 4, 7]:
            with self.subTest(count=count):
                sim, calls = self.execute([.1 * index for index in range(1, count)])
                self.assertEqual([call['data']['command'] for call in calls], ['reset'])
                self.assertGreaterEqual(calls[0]['time'], .1 * (count - 1) + .4 - 1e-8)
                self.assertNotIn('living_room', sim.attr('sensor.ls_overrides', 'power') or {})

    def test_other_actions_do_not_extend_click_window(self):
        _, calls = self.execute([], irrelevant=True)
        self.assertEqual([call['data']['command'] for call in calls], ['toggle'])
        self.assertAlmostEqual(calls[0]['time'], .4)

    def test_room_assignment_is_resolved_when_dispatching(self):
        _, calls = self.execute([], area='kitchen')
        self.assertEqual(calls[0]['data']['area'], 'kitchen')

    def test_random_bursts_dispatch_exactly_one_classification(self):
        rng = random.Random(3104)
        for _ in range(40):
            count = rng.randint(1, 8)
            delays, elapsed = [], 0
            for _ in range(count - 1):
                elapsed += rng.uniform(.01, .39)
                delays.append(elapsed)
            _, calls = self.execute(delays)
            expected = [] if count == 2 else ['toggle' if count == 1 else 'reset']
            self.assertEqual([call['data']['command'] for call in calls], expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
