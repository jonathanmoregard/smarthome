"""Actual transport scripts against memory sinks; no HA/network operations."""
import copy
import importlib.util
import json
import os
import unittest
from pathlib import Path

from dry_harness import DrySim, check_traffic

ROOT = Path('/tmp/lighting-algebra')
CONTROLLER = 'sensor.ls_effects_runtime'
LAMPS = ['light.living_room_hall_ceiling', 'light.living_room_table_lamp',
         'light.living_room_window_lamp']


def effect_target():
    def source(channel):
        return {'kind':'effect','effect':'Candle','instance':'shared', 'updated':1,
                'intensity':180,'base':180 if channel=='brightness' else {'rgb':[255,134,7]}}
    return {'on':True,'brightness':source('brightness'),'color':source('color')}


class TransportSim(DrySim):
    def __init__(self):
        super().__init__()
        self.after_publish = None
        self.before_emit = None

    def service(self, action, target, data):
        if action=='script.effects_emit' and self.before_emit:
            hook,self.before_emit=self.before_emit,None
            hook(self,data)
        result=super().service(action,target,data)
        if action=='mqtt.publish' and data['topic'].startswith('zigbee2mqtt/') and self.after_publish:
            self.after_publish(self,data)
        return result


class EffectPacingTests(unittest.TestCase):
    def setUp(self):
        self.sim=TransportSim()
        self.controller=CONTROLLER
        if os.environ.get('LIGHTING_TRANSPORT_BASELINE'):
            self.controller='sensor.effects_controller'
        else:
            spec=importlib.util.spec_from_file_location('transport',ROOT/'performance/transport.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            original=copy.deepcopy(self.sim.config)
            self.sim.config.update(module.transform(self.sim.config))
            self.assertEqual(original['effects_frame_plan'],self.sim.config['effects_frame_plan'])
        self.catalog=self.sim.run('effects_catalog')
        self.catalog['multicast']=[]
        self.sim.config['effects_catalog']['sequence'][0]['variables']['result']=self.catalog
        self.targets={lamp:effect_target() for lamp in LAMPS}
        for lamp in LAMPS:
            self.sim.put(lamp,'on')
            for entity in self.catalog['members'][lamp]:self.sim.put(entity,'on')
        self.revision=self.sim.states['sensor.ls_overrides'].last_updated.isoformat()
        self.generation='test-generation'
        self.runtime()
        self.sim.calls.clear()

    def runtime(self,**updates):
        value={'revision':self.revision,'generation':self.generation,
               'targets':self.targets,'assignments':self.targets}
        value.update(updates);self.sim.put(self.controller,'fixture',value)

    def sends(self):
        return [c for c in self.sim.calls if c['action']=='mqtt.publish' and c['data']['topic'].startswith('zigbee2mqtt/')]

    def batch(self):
        return self.sim.pure('effects_frame_plan',targets=self.targets,catalog=self.catalog,timestamp=self.sim.now.timestamp())['commands']

    def test_ordinary_batch_has_no_artificial_delay(self):
        commands=self.batch();before=self.sim.elapsed
        result=self.sim.run('effects_emit',commands=commands,revision=self.revision,generation=self.generation)
        self.assertTrue(result['completed'])
        self.assertEqual(self.sim.elapsed,before)
        self.assertEqual(len(self.sends()),len(commands))
        self.assertEqual({send['time'] for send in self.sends()},{before})

    def test_animation_admits_one_command_per_fresh_frame(self):
        self.sim.bounded_engine(seconds=1.05)
        calls=[c for c in self.sim.calls if c['action']=='script.effects_emit']
        self.assertGreaterEqual(len(calls),4)
        self.assertTrue(all(len(c['data']['commands'])==1 for c in calls))
        check_traffic(self.sim.calls,5)

    def test_round_robin_serves_all_endpoints_fairly(self):
        self.sim.bounded_engine(seconds=3.05)
        counts={self.catalog['topics'][entity]:0 for lamp in LAMPS for entity in self.catalog['members'][lamp]}
        for call in self.sends():counts[call['data']['topic']]+=1
        self.assertTrue(all(counts.values()),counts)
        self.assertLessEqual(max(counts.values())-min(counts.values()),1)
        check_traffic(self.sim.calls,5)

    def test_interactive_output_during_animation_wait_is_immediate(self):
        commands=self.batch();observed=[]
        def during_wait(sim):
            sim.on_delay=None;start=sim.elapsed
            sim.run('effects_emit',commands=commands,revision=self.revision,generation=self.generation)
            observed.append((start,sim.elapsed,len(self.sends())))
        self.sim.on_delay=during_wait
        self.sim.bounded_engine(seconds=.65)
        self.assertEqual(observed,[(.2,.2,len(commands))])

    def test_revision_change_during_wait_stops_without_stale_frame(self):
        self.sim.on_delay=lambda sim:sim.put('sensor.ls_overrides','new',{'overrides':{}})
        self.sim.bounded_engine(seconds=1)
        self.assertEqual(self.sends(),[])

    def test_generation_change_during_wait_uses_latest_snapshot(self):
        self.sim.on_delay=lambda sim:self.runtime(generation='new')
        self.sim.bounded_engine(seconds=1)
        self.assertGreater(len(self.sends()),0)
        calls=[c for c in self.sim.calls if c['action']=='script.effects_emit']
        self.assertTrue(all(c['data']['generation']=='new' for c in calls))

    def test_latest_partial_channel_assignment_is_rendered_after_wait(self):
        def change(sim):
            sim.on_delay=None
            self.targets[LAMPS[0]]['color']={'kind':'constant','value':{'rgb':[9,8,7]}}
            self.runtime()
        self.sim.on_delay=change
        self.sim.bounded_engine(seconds=.85)
        topics={self.catalog['topics'][e] for e in self.catalog['members'][LAMPS[0]]}
        selected=[c for c in self.sends() if c['data']['topic'] in topics]
        self.assertTrue(selected)
        self.assertTrue(all(json.loads(c['data']['payload'])['color']['rgb']=='9,8,7' for c in selected))

    def test_ownership_change_between_render_and_admission_is_rejected(self):
        def replace(sim,data):
            self.runtime(assignments={})
        self.sim.before_emit=replace
        self.sim.bounded_engine(seconds=.65)
        self.assertEqual(self.sends(),[])

    def test_current_power_off_and_bridge_off_reject_output(self):
        for kind in ['power','bridge']:
            with self.subTest(kind=kind):
                self.setUp()
                if kind=='power':
                    self.sim.on_delay=lambda sim:sim.put('sensor.ls_overrides','changed',{'overrides':{},'power':{'living_room':False}})
                else:self.sim.on_delay=lambda sim:sim.put('binary_sensor.zigbee2mqtt_bridge_connection_state','off')
                self.sim.bounded_engine(seconds=.65)
                self.assertEqual(self.sends(),[])

    def test_normal_emitter_rechecks_revision_after_each_publish(self):
        def change(sim,data):
            sim.advance(.001)
            sim.put('sensor.ls_overrides','changed',{'overrides':{}})
        self.sim.after_publish=change
        result=self.sim.run('effects_emit',commands=self.batch(),revision=self.revision,generation=self.generation)
        self.assertFalse(result['completed'])
        self.assertEqual(len(self.sends()),1)

    def test_compatible_multicast_keeps_group_safety_and_fairness(self):
        members=[entity for lamp in LAMPS[:2] for entity in self.catalog['members'][lamp]]
        self.catalog['multicast']=[{'id':'verified','topic':'zigbee2mqtt/fixture_group/set','members':members,'verified':True}]
        for lamp in LAMPS[:2]:self.catalog['phases'][lamp]='shared-phase'
        self.sim.config['effects_catalog']['sequence'][0]['variables']['result']=self.catalog
        self.sim.bounded_engine(seconds=1.25)
        topics=[c['data']['topic'] for c in self.sends()]
        self.assertIn('zigbee2mqtt/fixture_group/set',topics)
        self.assertTrue(any(topic!='zigbee2mqtt/fixture_group/set' for topic in topics))
        check_traffic(self.sim.calls,5)
        # A partial group must fall back rather than touching an OFF member.
        self.sim.calls.clear();self.sim.put(members[0],'off')
        self.sim.bounded_engine(seconds=.65)
        self.assertNotIn('zigbee2mqtt/fixture_group/set',[c['data']['topic'] for c in self.sends()])

    def test_slow_iteration_does_not_catch_up_with_burst(self):
        def slow_once(sim,data):
            sim.after_publish=None;sim.advance(1.3)
        self.sim.after_publish=slow_once
        self.sim.bounded_engine(seconds=2.5)
        calls=check_traffic(self.sim.calls,5)
        self.assertGreater(len(calls),2)
        self.assertGreater(calls[1]['time']-calls[0]['time'],1.3)

    def test_generation_updates_preserve_rotation_and_spacing(self):
        count={'value':0}
        def update(sim,data):
            count['value']+=1
            self.runtime(generation='update-'+str(count['value']))
        self.sim.after_publish=update
        self.sim.bounded_engine(seconds=2.5)
        sends=check_traffic(self.sim.calls,5)
        self.assertEqual(len(sends),12)
        self.assertAlmostEqual(sends[0]['time'],.2)
        counts={self.catalog['topics'][entity]:0 for lamp in LAMPS for entity in self.catalog['members'][lamp]}
        for call in sends:counts[call['data']['topic']]+=1
        self.assertTrue(all(counts.values()),counts)
        self.assertLessEqual(max(counts.values())-min(counts.values()),1)

    def test_temporary_revision_mismatch_resumes_same_rotation(self):
        def change(sim):
            if .39<sim.elapsed<.41:
                sim.put('sensor.ls_overrides','new',{'overrides':{}})
            if .79<sim.elapsed<.81:
                self.revision=sim.states['sensor.ls_overrides'].last_updated.isoformat()
                self.runtime(generation='resumed')
                sim.on_delay=None
        self.sim.on_delay=change
        self.sim.bounded_engine(seconds=1.45)
        sends=check_traffic(self.sim.calls,5)
        self.assertGreaterEqual(len(sends),4)
        self.assertAlmostEqual(sends[0]['time'],.2)
        self.assertAlmostEqual(sends[1]['time'],.8)
        self.assertNotEqual(sends[0]['data']['topic'],sends[1]['data']['topic'])

    def test_generation_change_after_render_drops_frame_then_resumes(self):
        def change(sim,data):self.runtime(generation='changed-after-render')
        self.sim.before_emit=change
        self.sim.bounded_engine(seconds=1.05)
        sends=check_traffic(self.sim.calls,5)
        self.assertEqual(len(sends),4)
        self.assertAlmostEqual(sends[0]['time'],.4)

    def test_transform_does_not_mutate_input_and_supports_controller_override(self):
        spec=importlib.util.spec_from_file_location('transport',ROOT/'performance/transport.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        source=DrySim().config;snapshot=copy.deepcopy(source)
        transformed=module.transform(source,controller_entity='sensor.fixture_runtime')
        self.assertEqual(source,snapshot)
        self.assertEqual(set(transformed),{'effects_emit','effects_engine'})
        serialized=json.dumps(transformed)
        self.assertIn('sensor.fixture_runtime',serialized)
        self.assertNotIn('sensor.effects_controller',serialized)


if __name__=='__main__':unittest.main(verbosity=2)
