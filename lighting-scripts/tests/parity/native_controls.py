"""Native HA vs TypeScript native/UI plan contracts with identical fixed dependencies."""
import json,asyncio,random,subprocess,tempfile
from types import SimpleNamespace
from portability import dependencies,ROOT
dependencies()
from homeassistant.core import HomeAssistant
from homeassistant.helpers.template import Template
from homeassistant.helpers import area_registry, device_registry, entity_registry
from homeassistant import loader

async def main():
 temporary=tempfile.TemporaryDirectory(prefix='smarthome-native-controls-')
 hass=HomeAssistant(temporary.name)
 loader.async_setup(hass)
 device_registry.async_setup(hass)
 await device_registry.async_load(hass,load_empty=True)
 await entity_registry.async_load(hass,load_empty=True)
 await area_registry.async_load(hass,load_empty=True)
 configs={n:json.loads((ROOT/f'reference/live/scripts/{n}.json').read_text())['config'] for n in ['effects_native_plan','effects_set']}
 templates={n:Template(c['sequence'][0 if n=='effects_native_plan' else 4]['variables']['result'],hass) for n,c in configs.items()}
 areas={'light.a':'living','light.b':'living','light.c':'bedroom','light.bulb':'living','switch.fixture':'living'}
 for area in set(areas.values()):area_registry.async_get(hass).async_create(area)
 for entity,area in areas.items():
  domain,oid=entity.split('.')
  reg=entity_registry.async_get(hass)
  entry=reg.async_get_or_create(domain,'fixture',entity,suggested_object_id=oid)
  reg.async_update_entity(entry.entity_id,area_id=area)
 groups={'light.living':['light.a','light.b'],'light.all':['light.a','light.b','light.c'],'light.partial':['light.a']}
 catalog={'members':{'light.a':['light.bulb'],'light.b':['light.b'],'light.c':['light.c']},'groups':groups,'effects':{'Candle':{'channels':['brightness']},'Colour loop':{'channels':['color']}}}
 base={t:{'brightness':110,'color':{'kelvin':2200}} for t in [*catalog['members'],'room:living','room:bedroom']}
 resolved={t:{'level':110,'brightness':{'kind':'constant','value':110},'color':{'kind':'constant','value':{'kelvin':2200}}} for t in base}
 resolved['light.a']['color']={'kind':'constant','policy':'sara','value':{'rgb':[255,105,180]}}
 resolved['light.b']['color']={'kind':'effect','base':{'kelvin':2100}}
 current={'plan':{'base':base,'resolved':{'targets':resolved}}}
 state={'input_text.ls_house_day':{'state':'{}','attributes':{}},'sensor.ls_overrides':{'state':'0','attributes':{'switch_ranges':{'switch.fixture':[0,1]}}},'light.a':{'state':'on','attributes':{'min_color_temp_kelvin':1700,'max_color_temp_kelvin':6500}},'light.bulb':{'state':'on','attributes':{}},'light.group':{'state':'on','attributes':{'entity_id':['light.a','light.b']}}}
 for entity,value in state.items():hass.states.async_set(entity,value['state'],value['attributes'])
 snapshot={'now':'2026-10-26T12:00:00.000001+01:00','state':state,'areas':areas,'members':[],'devices':{'device':['light.bulb']},'labels':{'label':['light.c']}}
 names=configs['effects_native_plan']['sequence'][0]['variables']['color_names']
 inputs=[{'color_name':name} for name in names]+[{'hs_color':[h,s]} for h in [-30,0,30,59,60,90,120,180,240,300,360] for s in [0,25.5,100]]+[{'xy_color':xy} for xy in [[0,0],[.1,.2],[.3,.7],[.45,.32],[.01,.99]]]+[{'rgbw_color':[20,100,7,180]},{'rgbww_color':[20,100,7,80,170]},{'kelvin':2300},{'white':81},{'rgb_color':[1,2,3]},{'effect':'colorloop','brightness_pct':50},{'effect':'none'},{'brightness_step_pct':10},{'brightness_step':-200},{'brightness':True},{'effect':'candle','brightness':80}]
 rng=random.Random(123)
 requests=[];expected=[]
 helpers={'area_id':lambda e:areas.get(e),'area_entities':lambda a:[e for e,v in areas.items() if v==a],'device_entities':lambda d:snapshot['devices'].get(d,[]),'label_entities':lambda l:snapshot['labels'].get(l,[]),'expand':lambda ids:[SimpleNamespace(entity_id=e) for e in ids if e in state and e!='light.group']+([SimpleNamespace(entity_id=e) for e in ['light.a','light.b']] if 'light.group' in ids else [])}
 helpers.pop('expand')
 for i,sd in enumerate(inputs):
  sd={**rng.choice([{'entity_id':'light.a'},{'entity_id':'light.living'},{'entity_id':'light.all'},{'entity_id':'light.partial'},{'entity_id':'light.bulb'},{'entity_id':'light.group'},{'area_id':'living'},{'device_id':'device'},{'label_id':'label'}]),**sd}
  args={'sd':sd,'catalog':catalog,'current':current,'stamp':5}
  requests.append({'script':'effects_native_plan','args':args,'snapshot':snapshot})
  expected.append(templates['effects_native_plan'].async_render({**args,**helpers,'color_names':names},strict=True))
 for source in ['light.a','light.living','light.all','light.partial','light.ls_house_day','light.ls_missing','light.unknown']:
  for attribute,values in [('power',['ON','OFF','bad']),('brightness',[0,255,80.5,'80',True,-1,256,None]),('rgb',[[1,2,3],'10,20,30',[1,2],[1,2,256],[False,2,3]]),('temperature',[100,400,1000,99,None]),('effect',['Candle','Normal Light','Normal light','missing']),('garbage',[0])]:
   for value in values:
    args={'source':source,'attribute':attribute,'value':value,'catalog':catalog,'current':current,'dry_run':True}
    requests.append({'script':'effects_set','args':args,'snapshot':snapshot})
    ref={**args,**helpers,'is_profile':source.startswith('light.ls_'),'targets':groups.get(source,[source]),'stamp':1793012400.000001}
    if value=='Normal Light':ref['value']='Normal light'
    expected.append(templates['effects_set'].async_render(ref,strict=True))
 proc=subprocess.run(['node','--experimental-strip-types',str(ROOT/'tests/parity/native_controls_rpc.mjs')],input='\n'.join(json.dumps(r) for r in requests)+'\n',text=True,capture_output=True,check=True)
 for i,(request,line,want) in enumerate(zip(requests,proc.stdout.splitlines(),expected,strict=True)):
  actual=json.loads(line)
  if actual.get('result')!=want:
   raise AssertionError(('Native control mismatch',i,request,actual,want))
 print(json.dumps({'native_ha_live_native_plan_cases':len(inputs),'native_ha_live_ui_plan_cases':len(requests)-len(inputs),'typescript_matches':True}))
 await hass.async_stop()
 temporary.cleanup()
asyncio.run(main())
