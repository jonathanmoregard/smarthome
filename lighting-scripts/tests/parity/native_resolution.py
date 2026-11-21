"""Supplement: native live resolver oracle against the real TypeScript dispatcher."""
import json,asyncio,random,tempfile
from rpc import Rpc, empty_snapshot
from portability import dependencies,ROOT
dependencies()
from homeassistant.core import HomeAssistant
from homeassistant.helpers.template import Template

async def main():
 temporary=tempfile.TemporaryDirectory(prefix='smarthome-resolution-native-')
 hass=HomeAssistant(temporary.name)
 cfg=json.loads((ROOT/'reference/live/scripts/effects_resolve.json').read_text())['config']
 template=Template(cfg['sequence'][0]['variables']['result'],hass)
 rng=random.Random(20261026)
 catalog={'effects':{'Candle':{'channels':['brightness']},'Pulse':{'channels':['brightness']},'Rainbow':{'channels':['color']}},'processors':{'Normal light':{'remote_adjustment':'gradient'}}}
 cases=[]
 for case in range(240):
  base={}
  for target,room,is_room in [('room:living','living',True),('lamp_a','living',False),('light.living_room_yellow_retro_lamp','living',False),('lamp_b','bedroom',False)]:
   day={'brightness':rng.choice([180,220,255]),'color':{'kelvin':rng.choice([3100,4000,6500])}}
   cosy={'brightness':rng.choice([20,90,110]),'color':rng.choice([{'kelvin':2200},{'rgb':[245,130,7]}])}
   base[target]={'area':room,'is_room':is_room,'period':rng.choice(['day','cosy','night']),'brightness':rng.choice([3,110,220]),'color':{'kelvin':2200},'day':day,'cosy':cosy,'effect':rng.choice(['Normal light','Candle']),'ignore_overrides':rng.choice([[],['a'],['mode:sara']])}
  overrides={}
  for index in range(8):
   scope=rng.choice(['room','house','lamp']);target={'room':'living','house':'house','lamp':rng.choice(['lamp_a','light.living_room_yellow_retro_lamp','lamp_b'])}[scope]
   record={'scope':scope,'target':target,'when':f'2026-10-26T12:00:00.00000{index}+01:00'}
   if rng.random()<.35 and scope=='room':
    record.update(kind='input',value={'selection':rng.choice([None,'day','cosy','Candle','Pulse','Rainbow']),'period':rng.choice(['day','cosy']),'adjustment':{'steps':rng.choice([-40,-10,-1,0,1,10,40]),'lower':-20,'upper':20,'updated':index,'anchor':rng.choice(['current','day','cosy']),'last':rng.choice(['up','down'])},'step_range':rng.choice([{'min':-10,'max':10},{'min':-20,'max':20},None])})
   elif rng.random()<.15:
    record.update(kind='light',scope='lamp',target=rng.choice(['lamp_a','light.living_room_yellow_retro_lamp']),value=rng.choice([None,{'brightness':80},{'effect':'Normal light'},{'effect':'Pulse','brightness':130}]))
   else:
    channels={}
    for channel in rng.sample(['brightness','color'],rng.choice([1,2])):
     kind=rng.choice(['constant','scale','effect','garbage'])
     if kind=='constant': value=rng.choice([0,3,76.5,150,255,True,None,'90',-1]) if channel=='brightness' else rng.choice([{'kelvin':2300},{'rgb':[1,2,3]},True,{'rgb':[0,0,False]}]);claim={'kind':kind,'value':value,'updated':index}
     elif kind=='scale':claim={'kind':kind,'position':rng.uniform(-3,3),'updated':index}
     elif kind=='effect':claim={'kind':kind,'effect':rng.choice(['Candle','Pulse','Rainbow','Missing']),'instance':'shared','updated':index,'underlying':{'kind':'constant','value':90 if channel=='brightness' else {'kelvin':2300},'updated':index-2}}
     else:claim={'kind':kind}
     channels[channel]=claim
    record.update(kind='channels',value={'channels':channels})
   overrides[chr(97+index)]=record
  args={k:v['default'] for k,v in cfg['fields'].items() if 'default' in v};args.update(base=base,overrides=overrides,catalog=catalog,sara=bool(case%2),private=['bedroom'],power={'living':bool(case%3)})
  cases.append(args)
 rpc=Rpc()
 try:
  actual=[rpc.call('effects_resolve', case, empty_snapshot()) for case in cases]
 finally:
  rpc.close()
 for index,(args,result) in enumerate(zip(cases,actual,strict=True)):
  expected=template.async_render(args,strict=True)
  assert result.get('result') == expected, ('Native live resolver mismatch',index,args,result,expected)
 print(json.dumps({'native_ha_live_resolution_cases':len(cases),'typescript_matches':True}))
 await hass.async_stop()
 temporary.cleanup()
asyncio.run(main())
