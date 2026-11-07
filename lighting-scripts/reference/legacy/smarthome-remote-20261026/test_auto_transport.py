import copy
import json
import sys
import unittest
from pathlib import Path
import test_gestures
from homeassistant.core import HomeAssistant, Context
from homeassistant import loader
from homeassistant.helpers import area_registry, device_registry, entity_registry, config_validation as cv
from homeassistant.helpers.script import Script
from homeassistant.util.dt import utcnow

ROOT=Path(__file__).parent
CONFIG_PATH=Path(sys.argv.pop(1))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.configs=json.loads(CONFIG_PATH.read_text())
        self.fixture=json.loads((ROOT/'autogroup-fixtures.json').read_text())
        self.hass=HomeAssistant(str(ROOT/'transport-ha'))
        loader.async_setup(self.hass)
        device_registry.async_setup(self.hass)
        await device_registry.async_load(self.hass,load_empty=True)
        await entity_registry.async_load(self.hass,load_empty=True)
        await area_registry.async_load(self.hass,load_empty=True)
        ar=area_registry.async_get(self.hass)
        er=entity_registry.async_get(self.hass)
        dr=device_registry.async_get(self.hass)
        catalog=self.fixture['catalog']
        areas={lamp:room for room,periods in self.fixture['baselines'].items() for lamp,t in periods['day']['targets'].items() if not t['is_room']}
        for room in set(areas.values()): ar.async_create(room)
        for lamp,members in catalog['members'].items():
            for entity in set([lamp,*members]):
                ieee=self.fixture['ieee'].get(entity)
                device=ieee or entity
                dr.devices[device]=device_registry.DeviceEntry(id=device,area_id=areas[lamp],identifiers={('mqtt','zigbee2mqtt_'+ieee)} if ieee else set())
                er.async_get_or_create('light','mqtt',entity,suggested_object_id=entity.split('.',1)[1],device_id=device)
                self.hass.states.async_set(entity,'on')
        self.entities=['light.living_room_desk_ceiling','light.living_room_hall_ceiling','light.living_room_vicky_desk_lamp']
        self.physical=[{'ieee_address':self.fixture['ieee'][e],'endpoint':1} for e in self.entities]
        self.name='ls_auto_living_room_1'
        self.groups=[{'friendly_name':self.name,'id':3001,'members':self.physical},*self.fixture['bridge_groups']]
        self.hass.states.async_set('binary_sensor.zigbee2mqtt_bridge_connection_state','on')
        self.hass.states.async_set('automation.effects_auto_group_state','on')
        self.hass.states.async_set('sensor.ls_overrides','ready',{'power':{'living_room':True}})
        self.runtime={'generation':'test','auto_groups':self.groups,'auto_endpoints':{ieee:[1] for ieee in self.fixture['ieee'].values()},'auto_groups_observed_at':utcnow().timestamp()+1,'auto_devices_observed_at':utcnow().timestamp()+1,'auto_syncing':False}
        self.set_runtime()
        self.published=[]
        async def publish(call): self.published.append(dict(call.data))
        self.hass.services.async_register('mqtt','publish',publish)

    def set_runtime(self): self.hass.states.async_set('sensor.ls_effects_runtime','test',copy.deepcopy(self.runtime))

    async def asyncTearDown(self): await self.hass.async_stop()

    async def run_script(self,key,variables=None):
        config=self.configs[key].get('config',self.configs[key])
        script=Script(self.hass,cv.SCRIPT_SCHEMA(copy.deepcopy(config['sequence'])),key,'script',script_mode=config.get('mode','single'))
        result=await script.async_run(variables or {},Context())
        await script.async_stop()
        return result.service_response

    async def catalog(self): return await self.run_script('effects_catalog')

    def command(self):
        return {'topic':'zigbee2mqtt/'+self.name+'/set','payload':{'brightness':100,'color_temp':455,'transition':0.2},'members':self.entities,'owners':self.entities,'group':self.name,'managed':True,'physical_members':self.physical}

    async def emit(self,command=None):
        return await self.run_script('effects_emit',{'commands':[command or self.command()],'revision':self.hass.states.get('sensor.ls_overrides').last_updated.isoformat(),'generation':'test'})

    async def test_fresh_membership_appears_in_catalog(self):
        result=await self.catalog()
        groups=[g for g in result['multicast'] if g['topic']=='zigbee2mqtt/'+self.name+'/set']
        self.assertEqual(len(groups),1)
        self.assertEqual(set(groups[0]['members']),set(self.entities))
        self.assertEqual(groups[0]['physical_members'],sorted(self.physical,key=lambda x:(x['ieee_address'],x['endpoint'])))

    async def test_unknown_actual_member_excludes_entire_group(self):
        self.groups[0]['members'].append({'ieee_address':'0x0000000000000001','endpoint':1})
        self.set_runtime()
        result=await self.catalog()
        self.assertNotIn('zigbee2mqtt/'+self.name+'/set',[g['topic'] for g in result['multicast']])

    async def test_stale_or_missing_device_snapshot_excludes_multicast(self):
        for key in ['auto_groups_observed_at','auto_devices_observed_at']:
            original=self.runtime[key]; self.runtime[key]=0;self.set_runtime()
            self.assertEqual((await self.catalog())['multicast'],[])
            self.runtime[key]=original

    async def test_syncing_excludes_managed_but_keeps_existing_static_groups(self):
        self.runtime['auto_syncing']=True; self.set_runtime()
        topics=[g['topic'] for g in (await self.catalog())['multicast']]
        self.assertNotIn('zigbee2mqtt/'+self.name+'/set',topics)
        self.assertIn('zigbee2mqtt/kitchen/all/set',topics)
        self.assertNotIn('zigbee2mqtt/fx_candle_active/set',topics)

    async def test_planner_carries_actual_membership_to_emit(self):
        cat=await self.catalog()
        group={'id':self.name,'topic':'zigbee2mqtt/'+self.name+'/set','members':self.entities,'verified':True,'managed':True,'physical_members':self.physical}
        rows=[{'entity':e,'owner':e,'topic':cat['topics'][e],'payload':{'brightness':100}} for e in self.entities]
        plan=await self.run_script('effects_group_plan',{'rows':rows,'groups':[group]})
        self.assertEqual(plan['command_count'],1)
        self.assertEqual(plan['commands'][0].get('physical_members'),self.physical)
        self.assertTrue(plan['commands'][0].get('managed'))

    async def test_current_verified_group_is_emitted(self):
        result=await self.emit()
        self.assertTrue(result['completed'])
        self.assertEqual(len(self.published),1)

    async def test_syncing_or_changed_membership_blocks_queued_group_command(self):
        for alteration in ['syncing','changed','stale']:
            self.runtime['auto_syncing']=alteration=='syncing'
            self.runtime['auto_groups_observed_at']=0 if alteration=='stale' else utcnow().timestamp()+1
            self.groups[0]['members']=self.physical[:-1] if alteration=='changed' else self.physical
            self.set_runtime(); self.published=[]
            result=await self.emit()
            self.assertFalse(result['completed'],alteration)
            self.assertEqual(self.published,[],alteration)


if __name__=='__main__': unittest.main(verbosity=2)
