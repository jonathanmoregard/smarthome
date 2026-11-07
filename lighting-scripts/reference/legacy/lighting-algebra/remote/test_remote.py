"""Drive the actual native gesture actions with a simulated MQTT event timeline.

All dispatches are captured locally. No networking, light calls, or HA mutations.
"""
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, '/tmp/lighting-algebra/tests')
from dry_harness import DrySim, End

ROOT = Path(__file__).parent
IEEE = '0x385b44fffea50c99'
TOPIC = f'zigbee2mqtt/{IEEE}/action'
CENTER = json.loads((ROOT / 'automation_remote_center.json').read_text())
DIRECTIONS = json.loads((ROOT / 'automation_remote_directions.json').read_text())


def mqtt(at, payload, topic=TOPIC):
    return {'time': at, 'topic': topic, 'payload': payload}


class GestureSim(DrySim):
    def __init__(self, events):
        super().__init__(candidate=ROOT)
        self.pending = sorted(events, key=lambda event: event['time'])
        self.area = 'living_room'
        self.env.globals['area_id'] = lambda _: self.area
        self.commands = []
        self.busy = False

    @staticmethod
    def match(event, triggers):
        return next((trigger for trigger in triggers if trigger['topic'] == event.get('topic') and trigger['payload'] == event.get('payload')), None)

    def dispatch_directions(self, event):
        matched = self.match(event, DIRECTIONS['triggers'])
        if matched:
            self.seq(DIRECTIONS['actions'], {'trigger': dict(event, id=matched['id'])})

    def seq(self, steps, context):
        for step in steps:
            if 'wait_for_trigger' in step:
                timeout = self.render(step['timeout'], context)
                deadline = self.elapsed + timeout.get('seconds', 0) + timeout.get('milliseconds', 0) / 1000
                matched = None
                while self.pending and self.pending[0]['time'] <= deadline + 1e-12:
                    event = self.pending.pop(0)
                    self.advance(event['time'] - self.elapsed)
                    if 'assign_area' in event:
                        self.area = event['assign_area']
                        continue
                    self.dispatch_directions(event)
                    matched = self.match(event, step['wait_for_trigger'])
                    if matched:
                        context['wait'] = {'completed': True, 'trigger': event}
                        break
                if not matched:
                    self.advance(deadline - self.elapsed)
                    context['wait'] = {'completed': False, 'trigger': None}
            elif 'repeat' in step and 'until' in step['repeat']:
                count = 0
                while True:
                    count += 1
                    assert count <= 1000, 'unbounded simulated gesture'
                    context['repeat'] = {'index': count}
                    self.seq(step['repeat']['sequence'], context)
                    if self.cond(step['repeat']['until'], context):
                        break
                context.pop('repeat', None)
            else:
                super().seq([step], context)

    def service(self, action, target, data):
        assert action == 'script.ls_remote_command', ('unexpected external action', action)
        self.commands.append({'time': self.elapsed, **data})

    def drive(self):
        assert CENTER['mode'] == 'single'
        while self.pending:
            event = self.pending.pop(0)
            self.advance(event['time'] - self.elapsed)
            if 'assign_area' in event:
                self.area = event['assign_area']
                continue
            self.dispatch_directions(event)
            if self.match(event, CENTER['triggers']):
                self.busy = True
                try:
                    self.seq(CENTER['actions'], {'trigger': event})
                except End:
                    pass
                self.busy = False
        return self.commands


class RemoteTests(unittest.TestCase):
    def commands(self, events):
        return GestureSim(events).drive()

    def test_single_click_delays_then_toggles_once(self):
        result = self.commands([mqtt(0, 'on')])
        self.assertEqual([r['command'] for r in result], ['toggle'])
        self.assertAlmostEqual(result[0]['time'], 0.4)

    def test_triple_click_never_toggles_and_resets_once(self):
        result = self.commands([mqtt(t, 'on') for t in [0, 0.2, 0.4]])
        self.assertEqual([r['command'] for r in result], ['reset'])
        self.assertAlmostEqual(result[0]['time'], 0.8)

    def test_alternating_hardware_on_off_actions_are_one_gesture(self):
        result = self.commands([mqtt(0, 'on'), mqtt(0.2, 'off'), mqtt(0.4, 'on')])
        self.assertEqual([r['command'] for r in result], ['reset'])
        self.assertEqual([r['command'] for r in self.commands([mqtt(0, 'off')])], ['toggle'])

    def test_double_click_is_noop(self):
        self.assertEqual(self.commands([mqtt(0, 'on'), mqtt(0.2, 'on')]), [])

    def test_long_burst_cannot_leave_a_trailing_toggle(self):
        self.assertEqual([r['command'] for r in self.commands([mqtt(t / 10, 'on') for t in range(8)])], ['reset'])

    def test_directions_are_processed_during_center_wait(self):
        result = self.commands([mqtt(0, 'on'), mqtt(0.1, 'brightness_step_up'), mqtt(0.2, 'on'), mqtt(0.3, 'brightness_step_down'), mqtt(0.4, 'on')])
        self.assertEqual([r['command'] for r in result], ['up', 'down', 'reset'])
        self.assertAlmostEqual(result[0]['time'], 0.1)
        self.assertAlmostEqual(result[1]['time'], 0.3)

    def test_runtime_room_lookup_and_stable_remote_source(self):
        result = self.commands([mqtt(0, 'on'), {'time': 0.2, 'assign_area': 'kitchen'}])
        self.assertEqual(result[0]['area'], 'kitchen')
        self.assertEqual(result[0]['source'], IEEE)

    def test_scene_values_cannot_be_misread_as_arrows(self):
        self.assertEqual(self.commands([mqtt(0, 'brightness_move_to_level'), mqtt(0.01, 'color_temperature_move')]), [])

    def test_unrelated_remote_cannot_complete_triple_click(self):
        result = self.commands([mqtt(0, 'on'), mqtt(0.1, 'on', 'zigbee2mqtt/other/action'), mqtt(0.2, 'on', 'zigbee2mqtt/other/action')])
        self.assertEqual([r['command'] for r in result], ['toggle'])

    def test_distinct_clicks_remain_distinct_gestures(self):
        result = self.commands([mqtt(0, 'on'), mqtt(0.6, 'on'), mqtt(1.2, 'on')])
        self.assertEqual([r['command'] for r in result], ['toggle', 'toggle', 'toggle'])

    def test_seeded_random_bursts_have_exactly_one_semantic_result(self):
        rng = random.Random(20261024)
        for case in range(100):
            count = rng.randint(1, 12)
            times = [0]
            for _ in range(count - 1):
                times.append(times[-1] + rng.uniform(0.01, 0.39))
            result = self.commands([mqtt(t, rng.choice(['on', 'off'])) for t in times])
            expected = ['toggle'] if count == 1 else [] if count == 2 else ['reset']
            with self.subTest(case=case):
                self.assertEqual([r['command'] for r in result], expected)
                if result:
                    self.assertAlmostEqual(result[0]['time'], times[-1] + 0.4)


if __name__ == '__main__':
    unittest.main(verbosity=2)
