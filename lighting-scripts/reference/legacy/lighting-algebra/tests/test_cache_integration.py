"""Compiled gradients survive actual planner/controller persistence boundaries."""
import copy
import math
import unittest

from dry_harness import DrySim, RUNTIME

LAMP = 'light.living_room_hall_ceiling'


class CacheIntegrationTests(unittest.TestCase):
    def gradients(self, sim):
        if 'ls_commit' not in sim.config:
            return sim.attr(RUNTIME, 'gradients')
        result = {}
        for room in set(sim.areas.values()):
            result.update((sim.attr('sensor.ls_cache_' + room, 'cache') or {}).get('gradients', {}))
        return result

    def sim(self):
        sim = DrySim()
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        sim.store('input_text.ls_house_day', {'on': True, 'b': 230, 'm': 'ct', 'k': 4100})
        sim.store('input_text.ls_house_cosy', {'on': True, 'b': 110, 'm': 'hs', 'h': 25, 's': 100})
        return sim

    def test_unchanged_configuration_reuses_persisted_curves_without_colour_conversion(self):
        sim = self.sim()
        conversions = []
        def log(value):
            conversions.append(value)
            return math.log(value)
        sim.env.filters['log'] = log
        sim.apply( reason='config')
        before = copy.deepcopy(self.gradients(sim))
        self.assertGreater(len(before), 1)
        self.assertTrue(conversions)
        conversions.clear()
        plan = sim.pure('ls_plan')['plan']
        self.assertEqual(plan['gradients'], before)
        self.assertEqual(conversions, [])
        room = sim.pure('ls_plan', room='living_room')['plan']
        self.assertEqual(room['gradients'], {'room:living_room': before['room:living_room']})
        self.assertEqual(conversions, [])
        sim.apply( reason='config')
        self.assertEqual(self.gradients(sim), before)
        self.assertEqual(conversions, [])

    def test_one_lamp_anchor_change_updates_only_its_persisted_curve(self):
        sim = self.sim()
        sim.apply( reason='config')
        before = copy.deepcopy(self.gradients(sim))
        sim.advance(.01)
        sim.store('input_text.ls_lamp_living_room_hall_ceiling_day',
                  {'own': True, 'on': True, 'b': 180, 'm': 'ct', 'k': 3800})
        sim.apply( reason='config')
        after = self.gradients(sim)
        self.assertEqual(set(after), set(before))
        self.assertEqual({target for target in before if before[target] != after[target]}, {LAMP})
        self.assertEqual(after['room:living_room'], before['room:living_room'])

    def test_full_gradient_refresh_preserves_validity_and_remote_warms_room_cache(self):
        sim = self.sim()
        if 'ls_commit' not in sim.config:
            self.skipTest('per-room cache is the performance pipeline contract')
        sim.apply(reason='config')
        sim.run('ls_remote_command', source='cache-remote', area='living_room', command='up')
        sim.drain_output()
        first = copy.deepcopy(sim.attr('sensor.ls_cache_living_room', 'cache'))
        self.assertIn('baseline', first)
        sim.advance(.01)
        sim.store('input_text.ls_lamp_living_room_hall_ceiling_day',
                  {'own': True, 'on': True, 'b': 180, 'm': 'ct', 'k': 3800})
        sim.apply(reason='config')
        refreshed = sim.attr('sensor.ls_cache_living_room', 'cache')
        self.assertEqual(refreshed['dependencies'], first['dependencies'])
        self.assertNotEqual(refreshed['gradients'][LAMP], first['gradients'][LAMP])
        conversions = []
        sim.env.filters['log'] = lambda value: (conversions.append(value), math.log(value))[1]
        sim.run('ls_remote_command', source='cache-remote', area='living_room', command='down')
        sim.drain_output()
        self.assertEqual(conversions, [])
        cache = sim.attr('sensor.ls_cache_living_room', 'cache')
        warm = sim.pure('ls_room_plan', room='living_room', cache=cache,
                       overrides=sim.attr('sensor.ls_overrides', 'overrides'))
        self.assertTrue(warm['cache_hit'])
        self.assertEqual(conversions, [])
        full = sim.pure('ls_plan')['plan']['resolved']['targets']
        self.assertEqual(warm['plan']['resolved']['targets'],
                         {key: value for key, value in full.items() if value['area'] == 'living_room'})

    def test_cached_planner_channels_equal_uncached_resolver_for_off_grid_positions(self):
        sim = self.sim()
        sim.apply( reason='config')
        catalog = sim.pure('effects_catalog')
        for position in [-1.93, -.543, .217, 1.893]:
            with self.subTest(position=position):
                sim.advance(.01)
                claim = {'kind': 'scale', 'position': position, 'updated': sim.now.timestamp()}
                sim.event('ls_override', {'op': 'set', 'records': [{
                    'kind': 'channels', 'key': 'channels:cache-test', 'scope': 'room', 'target': 'living_room',
                    'value': {'channels': {'brightness': claim, 'color': claim}}}]})
                plan = sim.pure('ls_plan')['plan']
                fallback = sim.pure('effects_resolve', base=plan['base'], catalog=catalog,
                                    overrides=sim.attr('sensor.ls_overrides', 'overrides'),
                                    private=['jonathan_bedroom'], power={}, sara=False, gradients={},
                                    warm_end=sim.attr('light.candle_test_rgb_warm_end', 'rgb_color') or [255, 126, 0])
                self.assertEqual(plan['resolved'], fallback)


if __name__ == '__main__':
    unittest.main(verbosity=2)
