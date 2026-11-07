"""Behavioral room cache checks; all calls use the isolated action sink."""
import copy
import importlib.util
import json
import os
import random
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from collections.abc import Sequence

from dry_harness import DrySim

ROOT=Path('/tmp/lighting-algebra')
spec=importlib.util.spec_from_file_location('room_plan',ROOT/'performance/room_plan.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CONFIGS=module.build_scripts()
if os.environ.get('LIGHTING_CANDIDATE'):
    CONFIGS={name:json.loads((Path(os.environ['LIGHTING_CANDIDATE'])/(name+'.json')).read_text())
             for name in ['ls_room_base','ls_room_plan']}
ROOM='living_room'
LAMP='light.living_room_hall_ceiling'


class RoomCacheTests(unittest.TestCase):
    def setUp(self):
        self.sim=DrySim()
        self.sim.config.update(copy.deepcopy(CONFIGS))
        for e in list(self.sim.state):
            if e.startswith('input_datetime.ls_') and e.endswith('_wake'):
                self.sim.put(e,'unknown',{})
        for period,b,k in [('day',240,4500),('cosy',105,2300),('night',3,1950)]:
            self.sim.store('input_text.ls_house_'+period,{'on':True,'b':b,'m':'ct','k':k})
        self.sim.put('input_boolean.ls_ovr_next_block_on','on')

    def plan(self,room=ROOM,cache=None,overrides=None,at=None,**extra):
        return self.sim.pure('ls_room_plan',room=room,cache=cache or {},overrides=overrides or {},test_now=at,**extra)

    def assert_equivalent(self,cache,**kwargs):
        hit=self.plan(cache=cache,**kwargs)
        fresh=self.plan(**kwargs)
        self.assertEqual(hit['plan'],fresh['plan'])
        return hit

    def channels(self,position=0.37,when=None,period=None):
        stamp=self.sim.now.timestamp()
        value={'channels':{c:{'kind':'scale','position':position,'updated':stamp} for c in ['brightness','color']}}
        if period:value.update(period=period,period_updated=stamp)
        return {'remote':{'kind':'channels','scope':'room','target':ROOM,'when':when or self.sim.now.isoformat(),'value':value}}

    def test_warm_override_path_avoids_baseline_compile_and_catalog_calls(self):
        first=self.plan()
        self.sim.advance(.1)
        start=len(self.sim.calls)
        hit=self.plan(cache=first['cache_update'],overrides=self.channels())
        self.assertTrue(hit['cache_hit'])
        names=[c['action'] for c in self.sim.calls[start:]]
        self.assertNotIn('script.ls_room_base',names)
        self.assertNotIn('script.ls_base',names)
        self.assertNotIn('script.effects_gradient_plan',names)
        self.assertNotIn('script.effects_catalog',names)
        self.assertIsNone(hit['cache_update'])
        self.assertEqual(hit['plan'],self.plan(overrides=self.channels())['plan'])

    def test_malformed_old_cache_and_wrapped_cache_fail_safe(self):
        good=self.plan()['cache_update']
        for bad in [None,{'baseline':None},{'baseline':{}},dict(good,version='old'),dict(good,baseline={'targets':{}})]:
            self.assertFalse(self.assert_equivalent(bad)['cache_hit'])
        class Wrapped(dict):
            def __repr__(self):return '<ReadOnly '+super().__repr__()+'>'
        def wrap(value):
            if isinstance(value,dict):return Wrapped({k:wrap(v) for k,v in value.items()})
            if isinstance(value,list):return [wrap(v) for v in value]
            return value
        self.assertTrue(self.assert_equivalent(wrap(good))['cache_hit'])

    def test_rgb_sequence_proxies_are_normalized_before_json_serialization(self):
        # HA is not installed locally. Reproduce TupleWrapper's important boundary:
        # iterable/read-only sequence, but NOT a list/tuple recognized by json.dumps.
        class TupleWrapper(Sequence):
            def __init__(self,values):self.values=tuple(values)
            def __len__(self):return len(self.values)
            def __getitem__(self,key):return self.values[key]
            def __repr__(self):return repr(self.values)
        with self.assertRaises(TypeError):json.dumps(TupleWrapper([1,2,3]))
        plain=self.plan()
        original=self.sim.env.globals['state_attr']
        def wrapped(entity,key):
            value=original(entity,key)
            return TupleWrapper(value) if key=='rgb_color' and isinstance(value,(list,tuple)) else value
        self.sim.env.globals['state_attr']=wrapped
        first=self.plan()
        self.assertEqual(first['plan'],plain['plan'])
        self.assertIsInstance(first['cache_update']['dependencies']['warm'],list)
        self.assertTrue(self.assert_equivalent(first['cache_update'])['cache_hit'])

    def test_sara_toggle_and_private_room_policy_are_live_on_cache_hits(self):
        for room in [ROOM,'jonathan_bedroom']:
            cache=self.plan(room=room)['cache_update']
            overrides={'mode:sara':{'kind':'mode','target':'sara','value':'on','when':self.sim.now.isoformat()}}
            on=self.assert_equivalent(cache,room=room,overrides=overrides)
            self.assertTrue(on['cache_hit'])
            owner=on['plan']['resolved']['targets']['room:'+room]['owners']['color']
            self.assertEqual(owner=='mode:sara',room==ROOM)
            off=self.assert_equivalent(cache,room=room,overrides={})
            self.assertNotEqual(off['plan']['resolved']['targets']['room:'+room]['owners']['color'],'mode:sara')

    def test_room_targets_match_full_house_reference_and_keep_lamp_anchors(self):
        self.sim.store('input_text.ls_lamp_living_room_hall_ceiling_day',{'own':True,'on':True,'b':175,'m':'ct','k':3800})
        for time in ['06:50:00','12:00:00','17:50:00','23:30:00']:
            at='2026-10-23T'+time+'+02:00'
            local=self.plan(at=at)['plan']
            all_base=self.sim.pure('ls_base',overrides={},test_now=at,reason='remote',room_only='')['targets']
            expected={L:v for L,v in all_base.items() if v['area']==ROOM}
            self.assertEqual(local['base'],expected)
            self.assertNotIn('members',local['catalog'])
            self.assertEqual(local['catalog']['effects'],self.sim.pure('effects_catalog')['effects'])
        self.assertEqual(local['base'][LAMP]['day']['brightness'],175)
        self.assertEqual(local['base']['room:'+ROOM]['day']['brightness'],240)

    def test_config_profile_timing_warm_endpoint_and_membership_invalidation(self):
        mutations=[
            lambda:s.store('input_text.ls_house_day',{'on':True,'b':230,'m':'ct','k':5100}),
            lambda:s.put('input_number.ls_house_cosy_fade','45'),
            lambda:s.put('input_boolean.ls_living_room_day_own_light','on'),
            lambda:s.store('input_text.ls_lamp_living_room_hall_ceiling_cosy',{'own':True,'on':True,'b':70,'m':'hs','h':25,'s':85}),
            lambda:s.put('light.candle_test_rgb_warm_end','on',{'rgb_color':[240,110,1]}),
            lambda:s.areas.__setitem__(LAMP,'kitchen'),
        ]
        for mutate in mutations:
            self.setUp();s=self.sim;cache=self.plan()['cache_update'];mutate()
            self.assertFalse(self.assert_equivalent(cache)['cache_hit'])

    def test_foreign_room_changes_do_not_invalidate_or_leak_into_room(self):
        cache=self.plan()['cache_update']
        self.sim.store('input_text.ls_kitchen_day',{'on':True,'b':1,'m':'hs','h':270,'s':100})
        self.sim.put('input_datetime.ls_kitchen_cosy_start','14:30:00')
        overrides={'elsewhere':{'kind':'channels','scope':'room','target':'kitchen','when':self.sim.now.isoformat(),'value':{'period':'night','channels':{}}}}
        hit=self.assert_equivalent(cache,overrides=overrides)
        self.assertTrue(hit['cache_hit'])
        self.assertTrue(all(t['area']==ROOM for t in hit['plan']['resolved']['targets'].values()))
        self.assertNotIn('members',hit['plan']['catalog'])
        self.assertNotIn('members',cache['catalog'])

    def test_live_observations_power_and_switch_ranges_are_not_frozen(self):
        cache=self.plan()['cache_update']
        self.sim.put(LAMP,'on',{'brightness':42,'color_mode':'rgb','rgb_color':[1,2,3]})
        override={'legacy':{'kind':'light','target':LAMP,'value':None,'when':self.sim.now.isoformat()}}
        hit=self.assert_equivalent(cache,overrides=override,power={ROOM:False})
        self.assertTrue(hit['cache_hit'])
        self.assertEqual(hit['plan']['resolved']['targets'][LAMP]['brightness']['value'],42)
        self.assertFalse(hit['plan']['resolved']['targets'][LAMP]['on'])
        self.sim.areas['switch.room_test']=ROOM
        hit=self.assert_equivalent(cache,ranges={'switch.room_test':{'profile':'bright'}},defaults={'bright':[90,100],'cosy':[30,60]})
        self.assertTrue(hit['cache_hit'])
        self.assertIn('switch.room_test',hit['plan']['switches'])

    def test_period_change_and_reset_invalidate_but_channel_clicks_reuse(self):
        cache=self.plan()['cache_update']
        period=self.channels(period='cosy')
        first=self.assert_equivalent(cache,overrides=period)
        self.assertFalse(first['cache_hit'])
        self.sim.advance(.1)
        period['remote']['when']=self.sim.now.isoformat()
        period['remote']['value']['channels']['brightness']['position']=.7
        second=self.assert_equivalent(first['cache_update'],overrides=period)
        self.assertTrue(second['cache_hit'])
        reset=self.assert_equivalent(first['cache_update'],overrides={})
        self.assertFalse(reset['cache_hit'])

    def test_expiry_is_recomputed_for_new_records_and_never_globally_clears_sara(self):
        old=self.channels(when='2026-10-23T05:00:00+02:00')
        old['mode:sara']={'kind':'mode','target':'sara','value':'on','when':'2026-10-23T05:00:00+02:00'}
        old['house']={'kind':'channels','scope':'house','target':'house','when':'2026-10-23T05:00:00+02:00','value':{'channels':{}}}
        first=self.plan(overrides=old)
        self.assertNotIn('mode:sara',first['plan']['stale_keys'])
        self.assertNotIn('house',first['plan']['stale_keys'])
        self.assertIn('remote',first['plan']['stale_keys'])
        old['remote']['when']=self.sim.now.isoformat()
        new=self.assert_equivalent(first['cache_update'],overrides=old)
        self.assertTrue(new['cache_hit'])
        self.assertNotIn('remote',new['plan']['stale_keys'])
        self.assertEqual(new['plan']['resolved']['targets']['room:'+ROOM]['owners']['brightness'],'remote')
        self.assertNotEqual(new['plan']['resolved']['targets']['room:'+ROOM]['owners']['color'],'mode:sara')

    def test_fade_boundaries_wake_and_clock_rollback_use_exact_local_fallback(self):
        cache=self.plan(at='2026-10-23T17:39:00+02:00')['cache_update']
        for time in ['17:39:30','17:41:00','17:50:00','18:00:00','16:00:00']:
            at='2026-10-23T'+time+'+02:00'
            hit=self.assert_equivalent(cache,at=at)
            self.assertEqual(hit['cache_hit'],time=='17:39:30')
        wake=datetime.fromisoformat('2026-10-23T06:00:00+02:00')
        self.sim.put('input_datetime.ls_living_room_wake',wake.isoformat(),{'timestamp':wake.timestamp()})
        self.sim.put('input_number.ls_living_room_wake_fade','30')
        cache=self.plan(at='2026-10-23T05:59:00+02:00')['cache_update']
        for time in ['06:00:00','06:15:00','06:29:00','06:30:00','06:40:00','07:00:00']:
            at='2026-10-23T'+time+'+02:00'
            hit=self.assert_equivalent(cache,at=at)
            self.assertFalse(hit['cache_hit'])
            if time=='06:15:00':self.assertEqual(hit['cache_update']['valid_until'],hit['cache_update']['valid_from'])
            self.assertEqual(hit['plan']['base']['room:'+ROOM]['brightness'],hit['plan']['base'][LAMP]['brightness'])

    def test_seeded_cached_uncached_equivalence_across_times_and_records(self):
        rng=random.Random(24012026)
        for case in range(65):
            hour=rng.randrange(24);minute=rng.randrange(60)
            at=datetime.fromisoformat(f'2026-10-23T{hour:02}:{minute:02}:00+02:00')
            cache=self.plan(at=at.isoformat())['cache_update']
            overrides=self.channels(position=rng.uniform(-2,2),when=at.isoformat())
            if case%7==0:overrides['remote']['value']['period']=rng.choice(['day','cosy','night'])
            if case%9==0:self.sim.store('input_text.ls_house_cosy',{'on':True,'b':rng.randint(1,200),'m':'ct','k':rng.randint(1950,4000)})
            later=at+timedelta(seconds=rng.choice([.1,10,90,600,3600,-60]))
            with self.subTest(case=case):self.assert_equivalent(cache,at=later.isoformat(),overrides=overrides)


if __name__=='__main__':unittest.main()
