"""Fast remote path compared with the actual production fallback and writer."""
import copy
import random
import unittest

from dry_harness import DrySim

SOURCE = 'offline-fast'
KEY = 'channels:' + SOURCE
EXPENSIVE = {'script.ls_room_plan', 'script.ls_room_base', 'script.ls_plan', 'script.ls_base', 'script.effects_resolve',
             'script.effects_catalog', 'script.ls_switch_plan', 'script.effects_scale'}


class DeferredWriterSim(DrySim):
    """Explicitly delay event delivery until the actual remote wait is reached.

    This tests the acknowledgement protocol, not HA's concurrent scheduler.
    """
    def __init__(self):
        super().__init__()
        self.pending_writes = []
        self.waited_for_write = 0

    def event(self, name, data):
        if name == 'ls_override' and data.get('request_id'):
            self.pending_writes.append((name, copy.deepcopy(data)))
        else:
            super().event(name, data)

    def seq(self, steps, context):
        for step in steps:
            if 'wait_template' in step and self.pending_writes:
                assert not self.render(step['wait_template'], context), 'remote did not wait for new writer commit'
                self.waited_for_write += 1
                self.advance(.04)
                name, data = self.pending_writes.pop(0)
                DrySim.event(self, name, data)
                assert self.render(step['wait_template'], context), 'actual writer did not acknowledge matching request'
            super().seq([step], context)


class RemoteFastTests(unittest.TestCase):
    def sim(self, expiry=False):
        sim = DrySim()
        sim.put('input_boolean.ls_ovr_next_block_on', 'on' if expiry else 'off')
        return sim

    def click(self, sim, command='up', room='living_room'):
        sim.run('ls_remote_command', source=SOURCE, area=room, command=command)

    def costly(self, sim):
        return [call['action'] for call in sim.calls if call['action'] in EXPENSIVE]

    def test_seeded_up_down_calls_no_planner_resolver_catalog_or_switch_planner(self):
        sim = self.sim()
        self.click(sim)
        self.assertIn(('script.ls_room_plan' if 'ls_commit' in sim.config else 'script.ls_plan'), self.costly(sim))
        sim.calls.clear()
        for command in ['up', 'up', 'down', 'down', 'up']:
            sim.advance(.1)
            self.click(sim, command)
        self.assertEqual(self.costly(sim), [])
        self.assertEqual(sim.physical(), [])
        self.assertEqual(set(sim.attr('sensor.ls_overrides', 'overrides')), {KEY})

    def test_random_burst_matches_actual_slow_path_with_one_stable_record(self):
        fast, slow = self.sim(), self.sim()
        # Disable only the optimization result. Both sides still execute the
        # exported command builder and actual queued writer; no second model.
        for step in slow.config['ls_remote_plan' if 'ls_commit' in slow.config else 'ls_remote_command']['sequence']:
            if 'variables' in step and 'result' in step['variables']:
                step['variables']['result'] = '{{ none }}'
                break
        rng = random.Random(4049)
        for command in ['up'] + [rng.choice(['up', 'down']) for _ in range(70)]:
            for sim in [fast, slow]:
                sim.advance(.1)
                self.click(sim, command)
            actual = fast.attr('sensor.ls_overrides', 'overrides')
            expected = slow.attr('sensor.ls_overrides', 'overrides')
            self.assertEqual(set(actual), {KEY})
            self.assertEqual(actual[KEY], expected[KEY])
        self.assertEqual(sum(call['action'] == ('script.ls_room_plan' if 'ls_commit' in fast.config else 'script.ls_plan') for call in fast.calls), 1)

    def test_next_fade_boundary_invalidates_fast_path(self):
        sim = self.sim(expiry=True)
        sim.now = sim.now.replace(hour=17, minute=39, second=55)
        self.click(sim)
        boundary = sim.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['remote_valid_until']
        self.assertGreater(boundary, sim.now.timestamp())
        sim.calls.clear()
        sim.advance(1)
        self.click(sim)
        self.assertEqual(self.costly(sim), [])
        sim.advance(boundary - sim.now.timestamp() + .1)
        sim.calls.clear()
        self.click(sim)
        self.assertIn(('script.ls_room_plan' if 'ls_commit' in sim.config else 'script.ls_plan'), self.costly(sim))

    def test_timing_configuration_change_invalidates_fast_path(self):
        sim = self.sim(expiry=True)
        self.click(sim)
        sim.advance(1)
        sim.put('input_datetime.ls_house_cosy_start', '18:30:00')
        sim.calls.clear()
        self.click(sim)
        self.assertIn(('script.ls_room_plan' if 'ls_commit' in sim.config else 'script.ls_plan'), self.costly(sim))

    def competitor(self, sim, channel, value, scope='room', target='living_room'):
        sim.advance(1)
        sim.event('ls_override', {'op': 'set', 'records': [{
            'kind': 'channels', 'key': 'channels:other', 'scope': scope, 'target': target,
            'value': {'channels': {channel: dict(value, updated=sim.now.timestamp())}}}]})
        sim.advance(1)
        sim.calls.clear()

    def test_competing_brightness_and_effect_claims_fall_back(self):
        for value in [{'kind': 'constant', 'value': 91},
                      {'kind': 'effect', 'effect': 'Breathe', 'instance': 'other'}]:
            for scope, target in [('room', 'living_room'), ('house', 'house')]:
                with self.subTest(value=value, scope=scope):
                    sim = self.sim()
                    self.click(sim)
                    self.competitor(sim, 'brightness', value, scope, target)
                    self.click(sim)
                    self.assertIn(('script.ls_room_plan' if 'ls_commit' in sim.config else 'script.ls_plan'), self.costly(sim))

    def test_new_color_only_claim_does_not_invalidate_scale_coordinate(self):
        sim = self.sim()
        self.click(sim)
        prior = sim.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['position']
        self.competitor(sim, 'color', {'kind': 'effect', 'effect': 'Colour loop', 'instance': 'other'})
        self.click(sim)
        self.assertEqual(self.costly(sim), [])
        channels = sim.attr('sensor.ls_overrides', 'overrides')[KEY]['value']['channels']
        self.assertAlmostEqual(channels['brightness']['position'], prior + .1)
        self.assertEqual(channels['color']['kind'], 'scale')

    def test_common_area_house_claim_does_not_invalidate_private_room(self):
        sim = self.sim()
        self.click(sim, room='jonathan_bedroom')
        self.competitor(sim, 'brightness', {'kind': 'constant', 'value': 91}, 'house', 'house')
        self.click(sim, room='jonathan_bedroom')
        self.assertEqual(self.costly(sim), [])

    def test_toggle_and_reset_skip_schedule_planning(self):
        for command in ['toggle', 'reset']:
            with self.subTest(command=command):
                sim = self.sim()
                self.click(sim, command)
                self.assertFalse(set(self.costly(sim)) - {'script.effects_catalog'})
                if command == 'reset':
                    self.assertEqual(self.costly(sim), [])

    def test_remote_waits_for_actual_writer_commit_before_next_click(self):
        sim = DeferredWriterSim()
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        self.click(sim)
        first = copy.deepcopy(sim.attr('sensor.ls_overrides', 'overrides')[KEY])
        self.click(sim)
        second = sim.attr('sensor.ls_overrides', 'overrides')[KEY]
        self.assertEqual(sim.waited_for_write, 0 if 'ls_commit' in sim.config else 2)
        self.assertEqual(sim.pending_writes, [])
        self.assertAlmostEqual(second['value']['position'], first['value']['position'] + .1)
        self.assertEqual(first['created'], second['created'])
        self.assertEqual(sum(call['action'] == ('script.ls_room_plan' if 'ls_commit' in sim.config else 'script.ls_plan') for call in sim.calls), 1)
        self.assertTrue(sim.attr('sensor.ls_overrides', 'remote_ack')[SOURCE].startswith(SOURCE + ':'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
