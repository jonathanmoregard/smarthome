"""Logical cycle wrap and independent global Sara toggle, actual scripts only."""
import copy
import unittest

from dry_harness import DrySim

SOURCE = 'offline-cycle'
KEY = 'channels:' + SOURCE


class RemoteCycleTests(unittest.TestCase):
    def sim(self):
        sim = DrySim()
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        return sim

    def click(self, sim, command, area='living_room', source=SOURCE):
        sim.advance(.01)
        sim.run('ls_remote_command', source=source, area=area, command=command)

    def choices(self, sim):
        return ['day', 'cosy', 'Candle']

    def test_forward_and_backward_wrap_without_sara_or_colour_loop(self):
        for area in ['living_room', 'jonathan_bedroom']:
            with self.subTest(area=area):
                sim = self.sim()
                choices = self.choices(sim)
                current = 0  # Fixture starts in Day.
                for direction in ['right', 'left']:
                    step = 1 if direction == 'right' else -1
                    for _ in range(len(choices) * 2):
                        current = (current + step) % len(choices)
                        self.click(sim, direction, area)
                        records = sim.attr('sensor.ls_overrides', 'overrides')
                        self.assertEqual(records[KEY]['value']['selection'], choices[current])
                        self.assertNotIn('mode:sara', records)
                        self.assertEqual(set(records), {KEY})
                self.assertEqual(sim.physical(), [])

    def test_left_from_day_wraps_to_last_effect_and_right_returns_day(self):
        sim = self.sim()
        choices = self.choices(sim)
        self.click(sim, 'left')
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['selection'], choices[-1])
        self.click(sim, 'right')
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['selection'], 'day')

    def test_cycle_does_not_change_existing_global_sara_mode(self):
        sim = self.sim()
        sim.event('ls_override', {'op': 'set', 'records': [{'kind': 'mode', 'target': 'sara', 'value': 'on'}]})
        original = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides')['mode:sara'])
        for _ in self.choices(sim):
            self.click(sim, 'right')
            self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides')['mode:sara'], original)

    def test_direct_sara_toggle_preserves_room_records_channels_cursor_and_power(self):
        sim = self.sim()
        sim.run('effects_set', source='light.living_room', attribute='effect', value='Candle')
        self.click(sim, 'up', area='jonathan_bedroom')
        sim.event('ls_override', {'op': 'power', 'area': 'living_room', 'on': False})
        original = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides'))
        power = copy.deepcopy(sim.attr('sensor.ls_overrides', 'power'))
        for enabled in [True, False, True, False]:
            self.click(sim, 'sara_toggle', area='jonathan_bedroom', source='offline-easter-egg')
            records = sim.attr('sensor.ls_overrides', 'overrides')
            self.assertEqual('mode:sara' in records, enabled)
            self.assertEqual({key: value for key, value in records.items() if key != 'mode:sara'}, original)
            self.assertEqual(sim.attr('sensor.ls_overrides', 'power'), power)
        self.assertEqual(sim.physical(), [])

    def test_sara_toggle_retains_candle_brightness_and_non_night_common_area_guard(self):
        sim = self.sim()
        for source in ['light.living_room', 'light.jonathan_bedroom']:
            sim.run('effects_set', source=source, attribute='effect', value='Candle')
        before_day = sim.pure('ls_plan')['plan']['resolved']['targets']
        before_night = sim.pure('ls_plan', test_now='2026-10-23T23:30:00+02:00')['plan']['resolved']['targets']
        self.click(sim, 'sara_toggle', area='jonathan_bedroom')
        after_day = sim.pure('ls_plan')['plan']['resolved']['targets']
        after_night = sim.pure('ls_plan', test_now='2026-10-23T23:30:00+02:00')['plan']['resolved']['targets']
        for entity, old in before_day.items():
            self.assertEqual(after_day[entity]['brightness'], old['brightness'])
            self.assertEqual(after_night[entity]['color'], before_night[entity]['color'])
            if old['area'] == 'jonathan_bedroom':
                self.assertEqual(after_day[entity]['color'], old['color'])
            else:
                self.assertEqual(after_day[entity]['color']['value'], {'rgb': [255, 105, 180]})
        self.assertEqual(after_day['room:living_room']['brightness']['kind'], 'effect')

    def test_direct_sara_toggle_has_pure_dry_entry_and_no_planning_dependencies(self):
        sim = self.sim()
        result = sim.pure('ls_remote_command', source=SOURCE, area='living_room',
                          command='sara_toggle', dry_run=True)
        self.assertIn(result['op'], ['set', 'clear'])
        for call in sim.calls:
            self.assertNotIn(call['action'], ['script.ls_plan', 'script.ls_base',
                                             'script.effects_resolve', 'script.effects_catalog',
                                             'script.effects_assign', 'script.effects_emit'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
