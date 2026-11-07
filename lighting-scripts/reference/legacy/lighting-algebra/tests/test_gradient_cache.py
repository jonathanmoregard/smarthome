"""Continuous compiled gradients versus the frozen, pre-cache production formula.

All script execution uses the memory-only HA interpreter. The reference was
copied before the implementation changed; it does not call the new compiler or
sampler. Instrument the actual log/from_json filters to count expensive work.
"""
import copy
import json
import math
import random
import unittest
from pathlib import Path

from dry_harness import DrySim

ROOT = Path('/tmp/lighting-algebra')
LAMP = 'light.living_room_hall_ceiling'


def target(day, cosy):
    return {'area': 'living_room', 'is_room': False, 'period': 'day', 'on': True,
            'brightness': day['brightness'], 'color': day['color'],
            'day': day, 'cosy': cosy}


class GradientTests(unittest.TestCase):
    def setUp(self):
        self.sim = DrySim(ROOT / 'core')
        reference = (ROOT / 'tests/test_gradient_reference.jinja').read_text()
        compiled = (ROOT / 'core/scale_macros.jinja').read_text() + (ROOT / 'core/gradient_macros.jinja').read_text()
        for name, macros, expression in [
            ('gradient_reference', reference, 'scale_value(day,cosy,p,warm_end)'),
            ('gradient_samples', compiled, 'gradient_sample(curve,p)'),
        ]:
            self.sim.config[name] = {'sequence': [
                {'variables': {'result': macros + '\n{% set n=namespace(v=[]) %}{% for p in positions %}'
                               '{% set n.v=n.v+[' + expression + '|from_json] %}{% endfor %}{{ {"samples":n.v} }}'}},
                {'stop': 'Return samples', 'response_variable': 'result'}]}
        self.day = {'brightness': 243.25, 'color': {'kelvin': 4737}}
        self.cosy = {'brightness': 111.75, 'color': {'rgb': [253, 137, 21]}}
        self.base = {LAMP: target(self.day, self.cosy)}

    def compile(self, base=None, cached=None, warm_end=None):
        return self.sim.pure('effects_gradient_plan', base=base or self.base,
                             cached=cached or {}, warm_end=warm_end or [255,126,0])['gradients']

    def resolve(self, gradients=None, position=.314159265, channels=('brightness', 'color'), base=None):
        claim = {'kind': 'scale', 'position': position, 'updated': 1}
        records = {'remote': {'kind': 'channels', 'scope': 'room', 'target': 'living_room',
                              'when': self.sim.now.isoformat(),
                              'value': {'channels': {channel: claim for channel in channels}}}}
        return self.sim.pure('effects_resolve', base=base or self.base, overrides=records,
                             catalog={'effects': {}}, gradients=gradients or {})

    def count_conversions(self):
        counts = {'log': 0, 'samples': 0}
        original_json = self.sim.env.filters['from_json']
        def logarithm(value):
            counts['log'] += 1
            return math.log(value)
        def deserialize(value, *args, **kwargs):
            result = original_json(value, *args, **kwargs)
            if isinstance(result, dict) and set(result) == {'brightness', 'color', 'position'}:
                counts['samples'] += 1
            return result
        self.sim.env.filters['log'] = logarithm
        self.sim.env.filters['from_json'] = deserialize
        return counts

    def test_randomized_off_grid_samples_equal_frozen_formula_exactly(self):
        rng = random.Random(28012026)
        edges = [-8, -2, -1.999999999, -1.000000001, -1, -.999999999,
                 -.000000001, 0, .000000001, .999999999, 1, 1.000000001, 2, 8]
        cases = [(self.day, self.cosy)]
        for index in range(180):
            def color(rgb):
                return {'rgb': [rng.uniform(0,255) for _ in range(3)]} if rgb else {'kelvin': rng.uniform(1000,10000)}
            cases.append(({'brightness': rng.uniform(0,255), 'color': color(index % 2)},
                          {'brightness': rng.uniform(0,255), 'color': color(index % 4 >= 2)}))
        for day, cosy in cases:
            warm = [rng.uniform(0,255) for _ in range(3)]
            positions = edges + [rng.uniform(-2,2) for _ in range(25)]
            base = {LAMP: target(day, cosy)}
            curve = self.compile(base, warm_end=warm)[LAMP]['curve']
            expected = self.sim.pure('gradient_reference', day=day, cosy=cosy,
                                     warm_end=warm, positions=positions)
            actual = self.sim.pure('gradient_samples', curve=curve, positions=positions)
            self.assertEqual(actual, expected, (day, cosy, warm))

    def test_hits_and_cached_resolution_do_no_kelvin_conversion(self):
        counts = self.count_conversions()
        gradients = self.compile()
        self.assertGreater(counts['log'], 0)
        counts['log'] = 0
        self.assertEqual(self.compile(cached=gradients), gradients)
        self.assertEqual(counts['log'], 0)
        actual = self.resolve(gradients)
        self.assertEqual(counts['log'], 0)
        self.assertEqual(counts['samples'], 1, 'both channels must share one sample')
        expected = self.resolve()
        self.assertGreater(counts['log'], 0, 'uncached mixed colour must convert Kelvin')
        self.assertEqual(actual, expected)

    def test_only_changed_anchor_recompiles_and_removed_targets_are_dropped(self):
        counts = self.count_conversions()
        base = {LAMP: target(self.day, self.cosy), 'room:living_room': target(self.day, self.cosy)}
        initial = self.compile(base)
        original_count = counts['log']
        counts['log'] = 0
        changed = copy.deepcopy(base)
        changed[LAMP]['day'] = dict(changed[LAMP]['day'], brightness=self.day['brightness']-1)
        updated = self.compile(changed, cached=initial)
        self.assertEqual(counts['log'] * 2, original_count)
        self.assertEqual(updated['room:living_room'], initial['room:living_room'])
        self.assertNotEqual(updated[LAMP]['signature'], initial[LAMP]['signature'])
        self.assertEqual(set(self.compile(cached=updated)), {LAMP})

    def test_warm_end_and_anchor_changes_invalidate_cache(self):
        initial = self.compile()
        changed = self.compile(cached=initial, warm_end=[251,121,3])
        self.assertNotEqual(initial[LAMP]['signature'], changed[LAMP]['signature'])
        base = copy.deepcopy(self.base)
        base[LAMP]['cosy']['color'] = {'kelvin': 1870}
        self.assertEqual(self.resolve(initial, base=base), self.resolve(base=base))

    def test_missing_stale_and_malformed_cache_fall_back(self):
        expected = self.resolve()
        entry = self.compile()[LAMP]
        variants = [None, {}, {'signature': entry['signature']},
                    {'signature': entry['signature'], 'curve': {}},
                    {'signature': ['old'], 'curve': entry['curve']}]
        invalid = copy.deepcopy(entry)
        invalid['curve']['colors']['lower']['start'] = 'broken'
        variants.append(invalid)
        for variant in variants:
            self.assertEqual(self.resolve({LAMP: variant}), expected)
            self.assertEqual(self.compile(cached={LAMP: variant}), {LAMP: entry})

    def test_anchor_wrappers_are_canonical_and_do_not_poison_signature(self):
        class Wrapped(dict):
            def __repr__(self):
                return '<ReadOnly ' + super().__repr__() + '>'
        wrapped = copy.deepcopy(self.base)
        wrapped[LAMP]['day'] = Wrapped(wrapped[LAMP]['day'])
        wrapped[LAMP]['day']['color'] = Wrapped(kelvin=4737, irrelevant_metadata='discard')
        wrapped[LAMP]['cosy']['color'] = Wrapped(rgb=(253,137,21))
        plain = self.compile()
        def wrap(value):
            if isinstance(value, dict):
                return Wrapped({key:wrap(item) for key,item in value.items()})
            if isinstance(value, list):
                return [wrap(item) for item in value]
            return value
        wrapped_cache = self.compile(wrapped, cached=wrap(plain))
        self.assertEqual(wrapped_cache, plain)
        self.assertEqual(self.resolve(wrapped_cache, base=wrapped), self.resolve(plain))

    def test_equal_brightness_and_below_floor_profiles_keep_exact_anchors(self):
        for brightness in [0, 15.5, 76.5, 150, 255]:
            day = {'brightness': brightness, 'color': {'rgb': [123.25,32,14]}}
            cosy = {'brightness': brightness, 'color': {'kelvin':1950}}
            curve = self.compile({LAMP:target(day,cosy)})[LAMP]['curve']
            positions = [-2,-1.47,-1,-.5,0,.314159,1,1.71,2]
            self.assertEqual(self.sim.pure('gradient_samples',curve=curve,positions=positions),
                             self.sim.pure('gradient_reference',day=day,cosy=cosy,warm_end=[255,126,0],positions=positions))


if __name__ == '__main__':
    unittest.main(verbosity=2)
