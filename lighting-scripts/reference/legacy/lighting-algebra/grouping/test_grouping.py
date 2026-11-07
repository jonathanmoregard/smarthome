"""Exercise the actual exported Jinja planner without clients, services or network."""
import ast
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import random
import sys
import unittest

sys.path[:0] = [
    '/nix/store/35jf5h0ml9gfbr2w0cwjjj12l8f91al7-jinja2-3.1.6/lib/python3.11/site-packages',
    '/nix/store/0bs4s1cgi7xv82mdbndl8g1jz87c9cdp-markupsafe-3.0.3/lib/python3.11/site-packages',
]
from jinja2 import Environment, StrictUndefined

ROOT = Path(__file__).parent
CONFIG = json.loads((ROOT / 'effects_group_plan.json').read_text())
TEMPLATE = Environment(undefined=StrictUndefined).from_string(CONFIG['sequence'][0]['variables']['result'])


def row(entity, value=90, **extra):
    return dict(entity=entity, owner='lamp_' + entity, topic=f'zigbee2mqtt/{entity}/set', payload={'brightness': value}, **extra)


def group(name, members, verified=True):
    return {'id': name, 'topic': f'zigbee2mqtt/{name}/set', 'members': members, 'verified': verified}


def plan(rows, groups):
    before = deepcopy((rows, groups))
    result = ast.literal_eval(TEMPLATE.render(rows=rows, groups=groups).strip())
    assert (rows, groups) == before, 'planner mutated its input'
    return result


class PlannerTests(unittest.TestCase):
    def assert_conserved(self, rows, groups, result):
        by_entity = {r['entity']: r for r in rows}
        coverage = Counter(e for c in result['commands'] for e in c['members'])
        self.assertEqual(coverage, Counter({e: 1 for e in by_entity}))
        self.assertLessEqual(result['command_count'], len(by_entity))
        self.assertEqual(result['command_count'], len(result['commands']))
        for command in result['commands']:
            self.assertEqual(command['owners'], sorted({by_entity[e]['owner'] for e in command['members']}))
            for entity in command['members']:
                self.assertEqual(command['payload'], by_entity[entity]['payload'])
            if command['group'] is None:
                self.assertEqual(len(command['members']), 1)
                self.assertEqual(command['topic'], by_entity[command['members'][0]]['topic'])
            else:
                matching = [g for g in groups if g['id'] == command['group'] and g['verified'] is True]
                self.assertEqual(len(matching), 1)
                self.assertEqual(command['members'], sorted(matching[0]['members']))
                self.assertEqual(command['topic'], matching[0]['topic'])

    def test_no_input_no_output(self):
        self.assertEqual(plan([], [])['commands'], [])

    def test_whole_lamp_and_cross_room_multicast(self):
        rows = [row(e) for e in ['living', 'mys_1', 'mys_2', 'kitchen_1', 'kitchen_2', 'kitchen_3']]
        groups = [group('lamp_mys', ['mys_1', 'mys_2']), group('cross', [r['entity'] for r in rows])]
        result = plan(rows, groups)
        self.assertEqual(result['command_count'], 1)
        self.assertEqual(result['commands'][0]['group'], 'cross')
        self.assert_conserved(rows, groups, result)

    def test_missing_off_or_unavailable_member_prevents_group(self):
        groups = [group('cross', ['a', 'b', 'c']), group('lamp', ['a', 'b'])]
        rows = [row('a'), row('b')]
        result = plan(rows, groups)
        self.assertEqual(result['commands'][0]['group'], 'lamp')
        self.assert_conserved(rows, groups, result)

    def test_any_payload_difference_prevents_multicast(self):
        base = {'brightness': 90, 'color': {'rgb': '255,105,180'}, 'transition': 0.2}
        for changed in [dict(base, brightness=91), dict(base, color={'rgb': '255,134,7'}), dict(base, transition=0.3), {'brightness': 90}]:
            rows = [dict(row('a'), payload=base), dict(row('b'), payload=changed)]
            result = plan(rows, [group('pair', ['a', 'b'])])
            self.assertEqual(result['command_count'], 2)
            self.assertTrue(all(c['group'] is None for c in result['commands']))

    def test_unverified_membership_cannot_multicast(self):
        rows = [row('a'), row('b')]
        for verified in [False, None, 1, 'true']:
            self.assertEqual(plan(rows, [group('pair', ['a', 'b'], verified)])['command_count'], 2)

    def test_malformed_group_falls_back(self):
        rows = [row('a'), row('b')]
        bad = [None, {}, group('pair', ['a', 'a']), group('pair', ['a', None]), group('pair', 'ab'), group('pair', {'a': 1, 'b': 2}), dict(group('pair', ['a', 'b']), topic='wrong/pair/set')]
        result = plan(rows, bad)
        self.assertEqual(result['command_count'], 2)
        self.assertTrue(all(c['group'] is None for c in result['commands']))

    def test_conflicting_rows_fail_closed_without_group_leak(self):
        groups = [group('pair', ['a', 'b'])]
        for field, value in [('payload', {'brightness': 91}), ('owner', 'other'), ('topic', 'zigbee2mqtt/other/set')]:
            rows = [row('a'), row('b'), dict(row('a'), **{field: value})]
            result = plan(rows, groups)
            self.assertEqual(result['commands'][0]['members'], ['b'])
            self.assertEqual(result['endpoint_count'], 1)
            self.assertEqual(result['rejected'][0]['reason'], 'conflicting_endpoint_rows')

    def test_identical_rows_are_deduplicated(self):
        rows = [row('a'), row('a'), row('b')]
        result = plan(rows, [group('pair', ['a', 'b'])])
        self.assertEqual(result['command_count'], 1)
        self.assertEqual(result['endpoint_count'], 2)
        self.assertEqual(result['rejected'], [])

    def test_conflicting_membership_for_same_topic_cannot_multicast(self):
        result = plan([row(e) for e in 'abc'], [group('pair', ['a', 'b']), group('pair', ['b', 'c'])])
        self.assertEqual(result['command_count'], 3)
        self.assertTrue(all(c['group'] is None for c in result['commands']))

    def test_largest_first_and_deterministic_tie(self):
        rows = [row(e) for e in 'abcde']
        groups = [group('z_first', list('abc')), group('a_first', list('bcd')), group('small', list('ae'))]
        result = plan(rows, groups)
        self.assertEqual([c['group'] for c in result['commands']], ['a_first', 'small'])
        self.assertEqual(result, plan(list(reversed(rows)), list(reversed(groups))))
        self.assert_conserved(rows, groups, result)

    def test_proposed_groups_preserve_complete_lamps(self):
        catalog = json.loads((ROOT.parent / 'before/effects_catalog.json').read_text())['config']['sequence'][0]['variables']['result']
        proposed = json.loads((ROOT / 'proposed_groups.json').read_text())
        phases = json.loads((ROOT / 'candle_phases.json').read_text())
        for g in proposed:
            self.assertIs(g['verified'], False)
            expected = sorted(e for lamp in g['lamps'] for e in catalog['members'][lamp])
            self.assertEqual(g['members'], expected)
            self.assertEqual(g['member_topics'], {e: catalog['topics'][e] for e in expected})
            self.assertEqual({phases[lamp] for lamp in g['lamps']}, {g['phase_cohort']})
        self.assertEqual(phases['light.living_room_hall_ceiling'], phases['light.living_room_window_lamp'])
        self.assertNotEqual(phases['light.living_room_desk_ceiling'], phases['light.living_room_vicky_desk_lamp'])

    def test_seeded_randomized_conservation_and_permutation(self):
        rng = random.Random(20261023)
        for case in range(1000):
            entities = [f'e{i}' for i in range(rng.randint(2, 24))]
            active = [e for e in entities if rng.random() < 0.85]
            rows = [row(e, rng.choice([30, 30, 30, 90])) for e in active]
            for r in rows:
                if rng.random() < 0.3:
                    r['payload']['color'] = {'rgb': rng.choice(['255,105,180', '255,134,7'])}
            groups = [group(f'g{i}', rng.sample(entities, rng.randint(2, min(8, len(entities)))), rng.random() < 0.9) for i in range(rng.randint(0, 14))]
            result = plan(rows, groups)
            with self.subTest(case=case):
                self.assert_conserved(rows, groups, result)
                rng.shuffle(rows)
                rng.shuffle(groups)
                self.assertEqual(result, plan(rows, groups))


if __name__ == '__main__':
    unittest.main(verbosity=2)
