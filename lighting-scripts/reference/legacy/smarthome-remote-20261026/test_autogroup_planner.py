import ast
import copy
import json
from pathlib import Path
import random
import site
import unittest

ROOT = Path('/tmp/smarthome-remote-20261026')
WRAPPER = Path('/nix/store/lrb2mmjfq9f6ikv454cn499xw4d2drsp-homeassistant-2026.7.4/bin/.hass-wrapped')
for node in ast.walk(ast.parse(WRAPPER.read_text())):
    if isinstance(node, ast.List) and node.elts and all(isinstance(x, ast.Constant) and isinstance(x.value, str) and x.value.startswith('/nix/store/') for x in node.elts):
        for path in ast.literal_eval(node):
            site.addsitedir(path)

from homeassistant.core import HomeAssistant, Context
from homeassistant.helpers.template import Template
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import Script


def row(i, room='living_room', **changes):
    return dict(entity=f'light.bulb_{i}', owner=f'light.lamp_{i}', topic=f'zigbee2mqtt/bulb_{i}/set', ieee_address=f'0x{i:016x}', endpoint=1, **changes)


def cohort(*indices):
    return [row(i) for i in indices]


def scenario(*cohorts, room='living_room'):
    return {'room': room, 'cohorts': list(cohorts)}


def existing(name, indices, id=10, verified=True):
    return {'friendly_name': name, 'id': id, 'members': [{'ieee_address': f'0x{i:016x}', 'endpoint': 1} for i in indices], 'verified': verified}


def member_sets(result):
    return {frozenset(m['entity'] for m in g['members']) for g in result['groups'] if g['members']}


class PlannerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass = HomeAssistant(str(ROOT / 'planner-isolated-ha'))
        config = json.loads((ROOT / 'autogroup-planner.json').read_text())
        self.config = config
        cv.SCRIPT_SCHEMA(copy.deepcopy(config['sequence']))
        self.template = Template(config['sequence'][0]['variables']['result'], self.hass)

    async def asyncTearDown(self):
        await self.hass.async_stop()

    def plan(self, scenarios, groups=()):
        result = self.template.async_render({'scenarios': scenarios, 'existing_groups': list(groups)}, parse_result=True)
        self.assertIsInstance(result, dict)
        return result

    def test_heterogeneous_room_keeps_distinct_compatible_sets(self):
        result = self.plan([scenario(cohort(1,2,3,4,5), cohort(6), cohort(7))])
        self.assertTrue(result['valid'])
        self.assertEqual(member_sets(result), {frozenset(f'light.bulb_{i}' for i in [1,2,3,4,5])})
        self.assertEqual(result['groups'][0]['name'], 'ls_auto_living_room_1')

    def test_union_across_periods_and_current_deduplicates_memberships(self):
        result = self.plan([scenario(cohort(1,2,3),cohort(4,5)), scenario(cohort(1,2)), scenario(cohort(2,3)), scenario(cohort(1,2,3))])
        self.assertTrue(result['valid'])
        self.assertEqual(member_sets(result), {frozenset(f'light.bulb_{i}' for i in ids) for ids in [(1,2,3),(4,5),(1,2),(2,3)]})
        self.assertEqual(len(result['groups']), 4)

    def test_keeps_matching_slots_reuses_surplus_and_empties_unneeded(self):
        groups = [existing('ls_auto_living_room_1',[8,9],11), existing('ls_auto_living_room_2',[1,2],12), existing('ls_auto_living_room_3',[5,6],13)]
        result = self.plan([scenario(cohort(1,2),cohort(3,4))], groups)
        self.assertTrue(result['valid'])
        by_slot = {g['slot']:g for g in result['groups']}
        self.assertEqual([m['entity'] for m in by_slot[2]['members']], ['light.bulb_1','light.bulb_2'])
        self.assertEqual([m['entity'] for m in by_slot[1]['members']], ['light.bulb_3','light.bulb_4'])
        self.assertEqual(by_slot[3]['members'], [])
        self.assertEqual({g['id'] for g in result['groups']}, {11,12,13})

    def test_exact_verified_external_group_avoids_redundant_slot(self):
        result = self.plan([scenario(cohort(1,2))], [existing('living/all',[1,2])])
        self.assertTrue(result['valid'])
        self.assertEqual(result['groups'], [])
        self.assertEqual(len(result['reused_external']), 1)

    def test_partial_superset_or_unverified_external_does_not_cover(self):
        for group in [existing('partial',[1]),existing('superset',[1,2,3]),existing('unverified',[1,2],verified=False)]:
            with self.subTest(group=group['friendly_name']):
                result = self.plan([scenario(cohort(1,2))], [group])
                self.assertTrue(result['valid'])
                self.assertEqual(len(result['groups']),1)

    def test_conflicting_entity_or_physical_or_owner_room_fails_closed(self):
        variants = [
            [scenario(cohort(1,2)),scenario([dict(row(1),ieee_address='0x0000000000000009'),row(3)])],
            [scenario(cohort(1,2)),scenario([dict(row(3),ieee_address=row(1)['ieee_address']),row(4)])],
            [scenario(cohort(1,2)),scenario(cohort(1,3),room='kitchen')],
            [scenario(cohort(1,2)),scenario([dict(row(3),topic=row(1)['topic']),row(4)])],
            [scenario(cohort(1,2)),scenario([dict(row(3),owner=row(1)['owner']),row(4)],room='kitchen')],
        ]
        for scenarios in variants:
            with self.subTest(scenarios=scenarios):
                result=self.plan(scenarios)
                self.assertFalse(result['valid'])
                self.assertEqual(result['groups'], [])
                self.assertTrue(result['errors'])

    def test_duplicate_identical_rows_do_not_duplicate_members(self):
        result=self.plan([scenario(cohort(1,2,1,2))])
        self.assertTrue(result['valid'])
        self.assertEqual(len(result['groups'][0]['members']),2)

    def test_room_boundaries_and_removed_room_slots(self):
        result=self.plan([scenario(cohort(1,2)),scenario(cohort(3,4),room='kitchen')], [existing('ls_auto_removed_room_1',[8,9],88)])
        self.assertTrue(result['valid'])
        self.assertEqual({g['room'] for g in result['groups']}, {'living_room','kitchen','removed_room'})
        for group in result['groups']:
            if group['room']=='living_room': self.assertEqual([m['entity'] for m in group['members']],['light.bulb_1','light.bulb_2'])
            if group['room']=='kitchen': self.assertEqual([m['entity'] for m in group['members']],['light.bulb_3','light.bulb_4'])
            if group['room']=='removed_room': self.assertEqual(group['members'],[])

    def test_permutations_do_not_change_plan(self):
        source=[scenario(cohort(1,2,3),cohort(4,5)),scenario(cohort(1,2)),scenario(cohort(2,3),room='living_room')]
        groups=[existing('ls_auto_living_room_9',[4,5],90),existing('ls_auto_living_room_2',[8,9],20)]
        expected=self.plan(source,groups)
        rng=random.Random(19)
        for _ in range(15):
            current=copy.deepcopy(source); prior=copy.deepcopy(groups)
            rng.shuffle(current);rng.shuffle(prior)
            for s in current:
                rng.shuffle(s['cohorts'])
                for c in s['cohorts']:rng.shuffle(c)
            for g in prior:rng.shuffle(g['members'])
            self.assertEqual(self.plan(current,prior),expected)

    def test_changing_cohorts_reuse_bounded_slot_count(self):
        groups=[]
        rng=random.Random(23)
        for turn in range(30):
            ids=list(range(1,9));rng.shuffle(ids)
            result=self.plan([scenario(cohort(*ids[:3]),cohort(*ids[3:6]))],groups)
            self.assertTrue(result['valid'])
            self.assertEqual(len(result['groups']),2)
            groups=[{'friendly_name':g['name'],'id':g['id'] or i+100,'verified':True,'members':[{'ieee_address':m['ieee_address'],'endpoint':m['endpoint']} for m in g['members']]} for i,g in enumerate(result['groups'])]

    def test_malformed_scenarios_and_ambiguous_managed_names_fail_closed(self):
        fixtures=[([scenario(cohort(1,2),room='../bad')],[]),([scenario([dict(row(1),endpoint=0),row(2)])],[]),([scenario(cohort(1,2))],[existing('ls_auto_living_room_1',[1,2],1),existing('ls_auto_living_room_1',[3,4],2)])]
        for scenarios,groups in fixtures:
            result=self.plan(scenarios,groups)
            self.assertFalse(result['valid'])
            self.assertEqual(result['groups'],[])

    def test_explicit_wrong_room_and_overlapping_partition_fail_closed(self):
        fixtures=[
            [scenario([dict(row(1),room='kitchen'),row(2)])],
            [scenario(cohort(1,2),cohort(2,3))],
        ]
        for scenarios in fixtures:
            result=self.plan(scenarios)
            self.assertFalse(result['valid'])
            self.assertEqual(result['groups'],[])

    async def test_real_script_returns_plan_without_services(self):
        script=Script(self.hass,cv.SCRIPT_SCHEMA(copy.deepcopy(self.config['sequence'])),'planner','script')
        result=await script.async_run({'scenarios':[scenario(cohort(1,2))],'existing_groups':[]},Context())
        self.assertTrue(result.service_response['valid'])
        self.assertEqual(member_sets(result.service_response),{frozenset(['light.bulb_1','light.bulb_2'])})
        await script.async_stop()


if __name__=='__main__': unittest.main(verbosity=2)
