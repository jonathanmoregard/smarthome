"""Compare complete baseline responses against native HA templates, including diagnostics.

Only fixture registry/time/I/O are substituted. The captured source is unchanged.
Run: python3 tests/runtime/grouping-native-schedule.py
"""
import sys, json, asyncio, tempfile, copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'parity'))
from portability import dependencies,Stage,ROOT
dependencies()
from rpc import Rpc
from adapters import equal_results
from homeassistant.core import HomeAssistant
from homeassistant.helpers.template import Template
from homeassistant.helpers import area_registry,device_registry,entity_registry
from homeassistant import loader
from homeassistant.util import dt as dt_util

async def main():
 with Stage() as stage, tempfile.TemporaryDirectory(prefix='schedule-native-') as temporary:
  sys.path[:0]=[str(stage.path/'lighting-algebra/tests'),str(stage.path/'effects-promotion/tests')]
  from dry_harness import DrySim
  sim=DrySim()
  hass=HomeAssistant(temporary)
  loader.async_setup(hass)
  device_registry.async_setup(hass)
  await device_registry.async_load(hass,load_empty=True)
  await entity_registry.async_load(hass,load_empty=True)
  await area_registry.async_load(hass,load_empty=True)
  ar=area_registry.async_get(hass);er=entity_registry.async_get(hass)
  for area in set(sim.areas.values()):ar.async_create(area)
  for entity,area in sim.areas.items():
   entry=er.async_get_or_create(entity.split('.')[0],'test',entity,suggested_object_id=entity.split('.')[1]);er.async_update_entity(entry.entity_id,area_id=area)
  dt_util.set_default_time_zone(dt_util.get_time_zone('Europe/Stockholm'))
  rpc=Rpc()
  configs={n:json.loads((ROOT/'reference/live/scripts'/f'{n}.json').read_text())['config'] for n in ['ls_base','ls_room_base']}
  catalog=sim.run('effects_catalog')
  catalog['baseline_groups']={'light.kitchen_all':['light.kitchen_pendant','light.kitchen_spots_1','light.kitchen_spots_2']}
  comparisons=0
  for variant in ['ordinary','wake','custom','expired']:
   records={}
   if variant=='wake':
    sim.put('input_datetime.ls_living_room_wake','2026-10-23T06:00:00+02:00',{'timestamp':1792728000})
    sim.put('input_number.ls_living_room_wake_fade','30')
   if variant=='custom':
    sim.store('input_text.ls_house_day',{'on':True,'b':240,'m':'ct','k':4500})
    sim.store('input_text.ls_house_cosy',{'on':True,'b':90,'m':'hs','h':30,'s':90})
    sim.store('input_text.ls_house_night',{'on':False,'b':12,'m':'ct','k':2000})
    sim.store('input_text.ls_lamp_living_room_hall_ceiling_day',{'own':True,'on':True,'b':170,'m':'ct','k':3900})
    records={'custom':{'kind':'channels','scope':'room','target':'living_room','when':'2026-10-23T06:01:00+02:00','value':{'period':'cosy','channels':{}}}}
   if variant=='expired':
    sim.put('input_boolean.ls_ovr_next_block_on','on')
    records={'custom':{'kind':'channels','scope':'room','target':'living_room','when':'2026-10-23T05:00:00+02:00','value':{'period':'cosy','channels':{}}}}
   for entity,state in sim.state.items():hass.states.async_set(entity,state['state'],state['attributes'])
   for name in configs:
    for time in ['06:15:00','06:50:00','12:00:00','17:50:00','23:30:00']:
     args={'room':'living_room','room_only':'','test_now':'2026-10-23T'+time+'+02:00','overrides':records,'reason':'remote','debug':True}
     variables={**args,'room_only':'living_room' if name=='ls_room_base' else '', 'test_overrides':records,'force_all':True,
        'lights':[e for e in sim.members if sim.areas[e]=='living_room'] if name=='ls_room_base' else [],
        'label_entities':lambda label:sim.members if label=='house_schedule' else [],'label_devices':lambda label:[],
        'label_areas':lambda label:['jonathan_bedroom'],'device_entities':lambda dev:[], 'area_id':lambda entity:sim.areas.get(entity)}
     variables['plan']=Template(configs[name]['sequence'][0]['variables']['plan'],hass).async_render(variables,strict=True)
     expected=Template(configs[name]['sequence'][1]['variables']['result'],hass).async_render(variables,strict=True)
     snapshot={'state':copy.deepcopy(sim.state),'members':sim.members,'areas':sim.areas,'now':sim.now.isoformat(),'catalog':catalog,'labels':{'private_room':['jonathan_bedroom']}}
     snapshot['state']['sensor.ls_overrides']['last_updated']=hass.states.get('sensor.ls_overrides').last_updated.isoformat()
     actual=rpc.call(name,args,snapshot)['result']
     try:equal_results(actual,expected)
     except AssertionError as e:
      print(name,time,e)
      Path('/tmp/schedule-expected.json').write_text(json.dumps(expected,indent=2));Path('/tmp/schedule-actual.json').write_text(json.dumps(actual,indent=2));raise
     comparisons+=1
  print(json.dumps({'native_full_schedule_comparisons':comparisons,'failures':0}))
  rpc.close(); await hass.async_stop()
asyncio.run(main())
