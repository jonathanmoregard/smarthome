import copy
import json
import unittest
from test_autogroup_planner import ROOT, HomeAssistant, Template, cv, Script, Context

FIXTURE = json.loads((ROOT / 'autogroup-fixtures.json').read_text())

def groups(result, room, index=0):
    return [frozenset(r['entity'] for r in c) for c in [s for s in result['scenarios'] if s['room']==room][index]['cohorts']]

class CollectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.hass = HomeAssistant(str(ROOT / 'collector-isolated-ha'))
        self.catalog = copy.deepcopy(FIXTURE['catalog'])
        self.physical = {e:{'ieee_address':i,'endpoint':1} for e,i in FIXTURE['ieee'].items()}
        self.devices = {e:[['mqtt','zigbee2mqtt_'+i]] for e,i in FIXTURE['ieee'].items()}
        self.lighting_endpoints = {i:[1] for i in FIXTURE['ieee'].values()}
        self.config=json.loads((ROOT / 'autogroup-collector.json').read_text())
        cv.SCRIPT_SCHEMA(copy.deepcopy(self.config['sequence']))
        self.template=Template((ROOT/'autogroup-collector.jinja').read_text(),self.hass)
        self.endpoint_template=Template((ROOT/'autogroup-endpoints.jinja').read_text(),self.hass)
        for entity in set(self.catalog['members']) | set(self.catalog['topics']):
            self.hass.states.async_set(entity,'on')

    async def asyncTearDown(self):
        await self.hass.async_stop()

    def snapshot(self,room='living_room',period='cosy',current=False):
        targets=copy.deepcopy(FIXTURE['baselines'][room][period]['targets'])
        if current:
            targets={k:dict(v,brightness={'kind':'constant','value':v['brightness']},color={'kind':'constant','value':v['color']}) for k,v in targets.items() if k.startswith('light.')}
        return {'room':room,'kind':'current' if current else 'baseline','targets':targets,'power':True}

    def collect(self,snapshots):
        result=self.template.async_render({'snapshots':snapshots,'catalog':self.catalog,'endpoints':self.physical,'existing_groups':[]},parse_result=True)
        self.assertIsInstance(result,dict)
        return result

    def test_actual_living_cosy_five_matches_day_and_night_differ(self):
        result=self.collect([self.snapshot(period=p) for p in ['cosy','day','night']])
        self.assertEqual([len(c) for c in groups(result,'living_room',0)],[5])
        self.assertEqual([len(c) for c in groups(result,'living_room',1)],[3])
        self.assertEqual(sorted(len(c) for c in groups(self.collect([self.snapshot(period='day',current=True)]),'living_room')),[2,3])
        self.assertEqual([len(c) for c in groups(result,'living_room',2)],[7])
        self.assertNotIn('light.living_room_window_lamp',groups(result,'living_room',0)[0])
        self.assertNotIn('light.living_room_yellow_retro_lamp',groups(result,'living_room',0)[0])

    def test_all_periods_all_rooms_compose_with_planner(self):
        result=self.collect([self.snapshot(room,p) for room in FIXTURE['baselines'] for p in ['day','cosy','night']])
        planner=json.loads((ROOT/'autogroup-planner.json').read_text())['sequence'][0]['variables']['result']
        plan=Template(planner,self.hass).async_render(result,parse_result=True)
        self.assertTrue(plan['valid'],plan)
        self.assertGreater(len(plan['groups']),4)
        self.assertEqual(len(result['scenarios']),15)
        for s in result['scenarios']:
            for c in s['cohorts']:
                for r in c:
                    self.assertEqual(r['room'],s['room'])
                    self.assertIn(r['entity'],self.catalog['members'][r['owner']])

    def test_baseline_off_hardware_is_prewarmed_current_off_excluded(self):
        self.hass.states.async_set('light.kitchen_pendant','off')
        self.hass.states.async_set('light.kitchen_spots_1_bulb_1','off')
        result=self.collect([self.snapshot('kitchen'),self.snapshot('kitchen',current=True)])
        self.assertEqual([len(c) for c in groups(result,'kitchen',0)],[9])
        self.assertEqual([len(c) for c in groups(result,'kitchen',1)],[5])

    def test_current_effect_channels_and_room_power_excluded(self):
        snap=self.snapshot(current=True)
        snap['targets']['light.living_room_window_lamp']['brightness']['kind']='effect'
        snap['targets']['light.living_room_yellow_retro_lamp']['color']['kind']='effect'
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'living_room')],[5])
        snap['power']=False
        self.assertEqual(groups(self.collect([snap]),'living_room'),[])

    def test_final_payload_rounding_clamping_rgb_and_transition_partitions(self):
        snap=self.snapshot('kitchen',current=True)
        ts=list(snap['targets'].values())
        ts[0]['brightness']['value']=255
        ts[1]['brightness']['value']=254.4
        ts[2]['brightness']['value']=1000
        for t in ts:t['color']['value']={'rgb':[255,56,0]}
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'kitchen')],[9])
        ts[1]['owners']={'brightness':'channels:manual'}
        self.assertEqual(sorted(len(c) for c in groups(self.collect([snap]),'kitchen')),[3,6])
        ts[1]['owners']={}
        ts[1]['color']['value']={'rgb':[255,55,0]}
        self.assertEqual(sorted(len(c) for c in groups(self.collect([snap]),'kitchen')),[3,6])

    def test_kelvin_differences_with_identical_mired_payload_can_share(self):
        snap=self.snapshot('kitchen',current=True)
        for t,k in zip(snap['targets'].values(),[3000,3001,3002]):t['color']['value']={'kelvin':k}
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'kitchen')],[9])

    def test_endpoint_mapping_only_unambiguous_known_lighting_endpoint(self):
        entities=list(self.devices)
        self.lighting_endpoints[FIXTURE['ieee'][entities[0]]]=[1,2]
        del self.lighting_endpoints[FIXTURE['ieee'][entities[1]]]
        self.devices[entities[2]].append(['mqtt','zigbee2mqtt_0x0000000000000001'])
        result=self.endpoint_template.async_render({'devices':self.devices,'lighting_endpoints':self.lighting_endpoints},parse_result=True)
        for e in entities[:3]:self.assertNotIn(e,result)
        self.assertEqual(len(result),len(self.devices)-3)
        self.physical=result
        self.collect([self.snapshot(room,p) for room in FIXTURE['baselines'] for p in ['day','cosy','night']])

    def test_unknown_mapping_not_assigned_and_wrong_room_not_accepted(self):
        snap=self.snapshot()
        entity='light.living_room_desk_ceiling'
        del self.physical[entity]
        snap['targets']['light.living_room_hall_ceiling']['area']='kitchen'
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'living_room')],[3])

    def test_malformed_channels_excluded_without_guessing(self):
        snap=self.snapshot(current=True)
        for e in list(snap['targets'])[:3]:snap['targets'][e]['color']={'kind':'constant','value':{'kelvin':0}}
        self.assertEqual(sorted(len(c) for c in groups(self.collect([snap]),'living_room')),[2,2])

    def test_off_frames_group_even_animated_channels_and_room_power_off(self):
        snap=self.snapshot(current=True)
        snap['power']=False
        for t in snap['targets'].values():
            t['on']=False
            t['brightness']={'kind':'effect','effect':'Candle'}
            t['color']={'kind':'effect','effect':'Candle'}
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'living_room')],[7])
        self.hass.states.async_set('light.living_room_hall_ceiling','off')
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'living_room')],[6])
        snap['kind']='baseline'
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'living_room')],[7])
        snap['targets']['light.living_room_desk_ceiling']['transition']=4
        self.assertEqual([len(c) for c in groups(self.collect([snap]),'living_room')],[6])

    def test_duplicate_physical_aliases_are_all_rejected(self):
        entities=list(self.devices)
        self.devices[entities[0]]=copy.deepcopy(self.devices[entities[1]])
        result=self.endpoint_template.async_render({'devices':self.devices,'lighting_endpoints':self.lighting_endpoints},parse_result=True)
        self.assertNotIn(entities[0],result)
        self.assertNotIn(entities[1],result)
        self.assertEqual(len(result),len(self.devices)-2)

    async def test_actual_script_collects_dynamic_rooms_and_returns_verified_groups(self):
        from homeassistant import loader
        from homeassistant.core import SupportsResponse
        from homeassistant.helpers import area_registry,device_registry,entity_registry,label_registry
        loader.async_setup(self.hass)
        device_registry.async_setup(self.hass)
        await device_registry.async_load(self.hass,load_empty=True)
        await entity_registry.async_load(self.hass,load_empty=True)
        await area_registry.async_load(self.hass,load_empty=True)
        await label_registry.async_load(self.hass,load_empty=True)
        ar=area_registry.async_get(self.hass)
        er=entity_registry.async_get(self.hass)
        dr=device_registry.async_get(self.hass)
        label=label_registry.async_get(self.hass).async_create('house_schedule').label_id
        for room,periods in FIXTURE['baselines'].items():
            ar.async_create(room)
            for lamp,t in periods['day']['targets'].items():
                if lamp not in self.catalog['members']:continue
                for entity in set([lamp,*self.catalog['members'][lamp]]):
                    ieee=FIXTURE['ieee'].get(entity)
                    device=ieee or entity
                    # Bedroom exists via device labels alone; others via entity labels.
                    dr.devices[device]=device_registry.DeviceEntry(id=device,area_id=room,identifiers={('mqtt','zigbee2mqtt_'+ieee)} if ieee else set(),labels={label} if room=='bedroom' else set())
                    self.hass.states.async_remove(entity)
                    er.async_get_or_create('light','mqtt',entity,suggested_object_id=entity.split('.',1)[1],device_id=device)
                    if room!='bedroom' and lamp==entity:er.async_update_entity(entity,labels={label})
                    self.hass.states.async_set(entity,'on')
        calls=[]
        async def catalog(call):
            calls.append(('catalog',dict(call.data)))
            return self.catalog
        async def baseline(call):
            calls.append(('baseline',dict(call.data)))
            room=call.data['room']; record=call.data['overrides']['block:'+room]
            self.assertEqual(call.data['reason'],'remote')
            self.assertEqual(record['target'],room)
            self.assertEqual(record['kind'],'block')
            self.assertIn('T',record['when'])
            return FIXTURE['baselines'][room][record['value']]
        self.hass.services.async_register('script','effects_catalog',catalog,supports_response=SupportsResponse.ONLY)
        self.hass.services.async_register('script','ls_room_base',baseline,supports_response=SupportsResponse.ONLY)
        current=self.snapshot(current=True)['targets']
        raw_groups=copy.deepcopy(FIXTURE['bridge_groups'])+[{'friendly_name':'ls_auto_living_room_1','id':3333,'members':[]}]
        self.hass.states.async_set('sensor.ls_effects_runtime','ready',{'targets':current,'auto_endpoints':self.lighting_endpoints,'auto_groups':raw_groups})
        self.hass.states.async_set('sensor.ls_overrides','ready',{'power':{'living_room':False}})
        script=Script(self.hass,cv.SCRIPT_SCHEMA(copy.deepcopy(self.config['sequence'])),'collector','script')
        run=await script.async_run({},Context())
        result=run.service_response
        self.assertEqual(len(calls),16)
        self.assertEqual(len(result['scenarios']),20)
        self.assertEqual({s['room'] for s in result['scenarios']},set(FIXTURE['baselines']))
        self.assertEqual([len(c) for c in groups(result,'living_room',1)],[5])
        self.assertEqual(groups(result,'living_room',3),[])
        for g in result['existing_groups']:
            self.assertEqual(g['verified'],g['friendly_name']!='fx_candle_active' and not g['friendly_name'].startswith('ls_auto_'))
        self.assertEqual(len(result['existing_groups']),len(raw_groups))
        self.assertEqual(self.config['sequence'][-2]['variables']['result'],(ROOT/'autogroup-collector.jinja').read_text())

if __name__=='__main__':unittest.main(verbosity=2)
