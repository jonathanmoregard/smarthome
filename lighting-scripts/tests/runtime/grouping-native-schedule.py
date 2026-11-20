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

OFF_LIGHT_FIELDS=('brightness','color')
def without_off_light(actual,expected):
 """Named divergence "off has no colour": the Jinja oracle carries an off scene's stored level and colour on an
 off target or profile; the port gives an off lamp neither. Drop exactly those two keys from the oracle's entry,
 only where both sides say on: false and the port's entry lacks the key. Returns how many keys were dropped."""
 dropped=0
 sections=[(actual.get('targets',{}),expected.get('targets',{})),
   (actual.get('schedule',{}).get('profiles',{}),expected.get('schedule',{}).get('profiles',{}))]
 for ours,theirs in sections:
  for key,entry in theirs.items():
   mine=ours.get(key)
   if not isinstance(mine,dict) or not isinstance(entry,dict) or mine.get('on') is not False or entry.get('on') is not False:continue
   for field in OFF_LIGHT_FIELDS:
    if field in entry and field not in mine:del entry[field];dropped+=1
 return dropped

def wake_progress(state,at):
 """Each room's wake-fade progress at `at`, for the rooms whose wake fade is running."""
 out={}
 for entity,value in state.items():
  if not (entity.startswith('input_datetime.ls_') and entity.endswith('_wake')):continue
  room=entity[len('input_datetime.ls_'):-len('_wake')];start=value.get('attributes',{}).get('timestamp')
  fade=float(state.get(f'input_number.ls_{room}_wake_fade',{}).get('state',37.5))*60
  if isinstance(start,(int,float)) and 0<=at-start<fade:out[room]=(at-start)/fade
 return out

def off_on_ramp(actual,expected,state,wake_p):
 """Named divergence "scheduled fades are gradual in both directions": in a moving stage whose start is off and
 whose end is lit, the Jinja oracle jumps to the lit end's level; the port ramps max(1, round(1 + (level - 1) * p)).
 Rewrite the oracle's level to that ramp only where both sides are lit in the same colour, the stage's start is
 off (its scene, or for a fade-out the lamp itself), and the port's level is exactly the ramp of the oracle's at the
 stage's p. Commands follow their lamps' rewritten profiles. Returns how many levels were rewritten."""
 details=expected.get('schedule',{}).get('schedule_details',{})
 def is_off(entity):return state.get(entity,{}).get('state')=='off'
 def own(lamp,block):
  try:saved=json.loads(state.get(f'input_text.ls_lamp_{lamp.split(".")[1]}_{block}',{}).get('state',''))
  except ValueError:return False
  return isinstance(saved,dict) and saved.get('own') is True
 def scene_off(lamp,room,block):
  # The scene the stage starts from, chosen as the schedule chooses it (lamp's own, room's own, house).
  scope=room if state.get(f'input_boolean.ls_{room}_{block}_own_light',{}).get('state')=='on' else 'house'
  if lamp is None:return is_off(f'light.ls_{scope}_{block}')
  for entity in ([f'light.ls_lamp_{lamp.split(".")[1]}_{block}'] if own(lamp,block) else [])+[f'light.ls_{scope}_{block}',f'light.ls_house_{block}']:
   if state.get(entity,{}).get('state','') not in ('unknown','unavailable'):return is_off(entity)
  return False
 stages={}
 for line in expected.get('schedule',{}).get('dbg',[]):
  lamp,rooms,source,move=line.split(' ')[:4];room=rooms.split('/')[0];start=move.split('>')[0];S=details.get(room,{})
  if source=='schedule' and S.get('fading') and scene_off(lamp,room,start):stages[lamp]=S['p']
  elif source=='wake' and room in wake_p and scene_off(lamp,room,start):stages[lamp]=wake_p[room]
  elif source=='fadeout' and is_off(lamp):stages[lamp]=min(1,3/max(S.get('left',1),1))
 for area,S in details.items():
  if S.get('fading') and scene_off(None,area,S['cur']):stages[f'room:{area}']=S['p']
  elif area in wake_p and not S.get('fading') and S.get('cur')=='night' and scene_off(None,area,'night'):stages[f'room:{area}']=wake_p[area]
 rewritten=0;levels={}
 for ours,theirs in [(actual.get('targets',{}),expected.get('targets',{})),
   (actual.get('schedule',{}).get('profiles',{}),expected.get('schedule',{}).get('profiles',{}))]:
  for key,entry in theirs.items():
   mine=ours.get(key);p=stages.get(key)
   if p is None or not isinstance(mine,dict) or not isinstance(entry,dict) or mine.get('on') is False or entry.get('on') is False:continue
   if entry.get('color')!=mine.get('color') or not isinstance(entry.get('brightness'),(int,float)):continue
   ramp=max(1,round(1+(entry['brightness']-1)*p))
   if mine.get('brightness')!=entry['brightness'] and mine.get('brightness')==ramp:entry['brightness']=ramp;rewritten+=1;levels[key]=ramp
 return rewritten,levels

def ramped_commands(expected,levels,groups):
 """The oracle's lit commands at their lamps' rewritten levels, regrouped by the same key the schedule uses."""
 cmds=expected.get('schedule',{}).get('cmds')
 if not isinstance(cmds,list) or not levels:return
 out={}
 for cmd in cmds:
  ids=cmd.get('ids',[]);members=[m for i in ids for m in groups.get(i,[i])]
  wanted={levels[m] for m in members if m in levels}
  if 'brightness' in cmd and len(wanted)==1 and all(m in levels for m in members):cmd={**cmd,'brightness':max(wanted.pop(),1)}
  key=json.dumps({k:v for k,v in cmd.items() if k!='ids'})
  if key in out:out[key]['ids']+=ids
  else:out[key]={**cmd,'ids':list(ids)}
 expected['schedule']['cmds']=list(out.values())

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
  comparisons=0;off_light_dropped=0;ramp_rewritten=0
  from datetime import datetime
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
     off_light_dropped+=without_off_light(actual,expected)
     rewritten,levels=off_on_ramp(actual,expected,snapshot['state'],wake_progress(snapshot['state'],datetime.fromisoformat(args['test_now']).timestamp()))
     ramped_commands(expected,levels,catalog['baseline_groups']);ramp_rewritten+=rewritten
     try:equal_results(actual,expected)
     except AssertionError as e:
      print(name,time,e)
      Path('/tmp/schedule-expected.json').write_text(json.dumps(expected,indent=2));Path('/tmp/schedule-actual.json').write_text(json.dumps(actual,indent=2));raise
     comparisons+=1
  print(json.dumps({'native_full_schedule_comparisons':comparisons,'failures':0,'off_has_no_colour_keys_dropped':off_light_dropped,
   'off_to_on_ramp_levels_rewritten':ramp_rewritten}))
  rpc.close(); await hass.async_stop()
asyncio.run(main())
