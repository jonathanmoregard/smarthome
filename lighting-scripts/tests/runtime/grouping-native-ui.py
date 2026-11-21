"""Native HA vs TypeScript UI messages and range validation; never publishes."""
import sys, json, asyncio, tempfile, copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'parity'))
from portability import dependencies,Stage,ROOT
dependencies()
from rpc import Rpc
from adapters import equal_results
from homeassistant.core import HomeAssistant
from homeassistant.helpers.template import Template

async def main():
 with Stage() as stage, tempfile.TemporaryDirectory(prefix='ui-native-') as temporary:
  sys.path[:0]=[str(stage.path/'lighting-algebra/tests'),str(stage.path/'effects-promotion/tests')]
  from dry_harness import DrySim
  sim=DrySim()
  hass=HomeAssistant(temporary)
  config=json.loads((ROOT/'reference/live/scripts/effects_ui_sync.json').read_text())['config']
  rows=config['sequence'][1]['variables']['rows']
  template=Template(config['sequence'][2]['variables']['messages'],hass)
  catalog=sim.run('effects_catalog');catalog['ui_rows']=rows
  rpc=Rpc();comparisons=0
  from homeassistant.helpers import area_registry,device_registry,entity_registry
  from homeassistant import loader
  loader.async_setup(hass);device_registry.async_setup(hass)
  await device_registry.async_load(hass,load_empty=True);await entity_registry.async_load(hass,load_empty=True);await area_registry.async_load(hass,load_empty=True)
  ar=area_registry.async_get(hass);er=entity_registry.async_get(hass)
  for area in set(sim.areas.values()):ar.async_create(area)
  for entity,area in sim.areas.items():
   entry=er.async_get_or_create(entity.split('.')[0],'test',entity,suggested_object_id=entity.split('.')[1]);er.async_update_entity(entry.entity_id,area_id=area)
  for variant in ['empty','constants','mixed']:
   targets={}
   if variant!='empty':
    targets={lamp:{'level':123,'brightness':{'kind':'constant','value':123},'color':{'kind':'constant','value':{'rgb':[255,105,180]}}} for lamp in sim.members}
    targets.update({'room:'+room:{'level':177,'color':{'kind':'constant','value':{'kelvin':2200}}} for room in set(sim.areas.values())})
   if variant=='mixed':
    targets[sim.members[0]]['brightness']={'kind':'effect','effect':'Candle'}
    targets[sim.members[1]]['color']={'kind':'effect','effect':'Colour loop'}
   sim.put('sensor.ls_effects_runtime','1',{'targets':targets})
   for entity,state in sim.state.items():hass.states.async_set(entity,state['state'],state['attributes'])
   for force in [False,True]:
    variables={'rows':rows,'force':force,'area_id':lambda e:sim.areas.get(e)}
    expected={'messages':template.async_render(variables,strict=True)}
    snapshot={'state':copy.deepcopy(sim.state),'members':sim.members,'areas':sim.areas,'now':sim.now.isoformat(),'catalog':catalog}
    actual=rpc.call('effects_ui_sync',{'dry_run':True,'force':force},snapshot)['result']
    try:equal_results(actual,expected)
    except AssertionError:
     print('variant',variant,'force',force);raise
    comparisons+=1
  range_config=json.loads((ROOT/'reference/live/scripts/ls_range_save.json').read_text())['config']
  range_template=Template(range_config['sequence'][0]['variables']['result'],hass)
  for name,modes in [('switch.test',None),('light.test',['onoff']),('light.dimmer',['brightness']),('switch.ls_fake',None)]:
   attrs={'supported_color_modes':modes} if modes else {}
   sim.put(name,'off',attrs);sim.areas[name]='studio';hass.states.async_set(name,'off',attrs)
  for entity in ['switch.test','light.test','light.dimmer','switch.ls_fake','switch.missing']:
   for lo,hi in [(30,60),(True,80),(80,30),(None,None)]:
    args={'entity':entity,'profile':'custom','minimum':lo,'maximum':hi,'dry_run':True}
    expected=range_template.async_render({**args,'device_id':lambda e:'device' if e!='switch.missing' else None,'area_id':lambda e:sim.areas.get(e)},strict=True)
    snapshot={'state':copy.deepcopy(sim.state),'members':sim.members,'areas':sim.areas,'now':sim.now.isoformat(),'catalog':catalog,'devices':{'device':['switch.test','light.test','light.dimmer','switch.ls_fake']}}
    actual=rpc.call('ls_range_save',args,snapshot)['result'];equal_results(actual,expected);comparisons+=1
  print(json.dumps({'native_ui_and_range_comparisons':comparisons,'failures':0}))
  rpc.close();await hass.async_stop()
asyncio.run(main())
