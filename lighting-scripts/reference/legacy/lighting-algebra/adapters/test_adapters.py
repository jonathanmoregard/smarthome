"""Offline checks of actual adapter scripts; no HA/network clients."""
import copy, json, math, random, sys
from pathlib import Path
sys.path.insert(0,'/tmp/lighting-algebra/tests')
from dry_harness import DrySim
ROOT=Path('/tmp/lighting-algebra'); OWN=ROOT/'adapters'
s=DrySim()
s.env.filters['log']=math.log
for p in OWN.glob('*.json'):
 c=json.loads(p.read_text())
 if 'sequence' in c:s.config[p.stem]=c
 elif 'actions' in c:s.automations[p.stem]=c
 def containers(value):
  if isinstance(value,list):
   for child in value:containers(child)
  elif isinstance(value,dict):
   for key,child in value.items():
    if key in ['event_data','target','data']:assert isinstance(child,dict),(p.name,key,child)
    containers(child)
 containers(c)
print('PASS: HA event_data, target and data containers are native mappings')
catalog=s.pure('effects_catalog')
# Current-state fixture is an explicit dependency seam, not an alternative resolver.
base={}; resolved={}
for target in list(catalog['members'])+['room:'+a for a in set(s.areas.values())]:
 base[target]={'brightness':120,'color':{'kelvin':2700},'area':s.areas.get(target,target.removeprefix('room:'))}
 resolved[target]={'level':140,'brightness':{'kind':'effect','effect':'Candle','base':140},'color':{'kind':'effect','effect':'Candle','base':{'kelvin':2700}}}
fixture={'plan':{'base':base,'resolved':{'targets':resolved}}}
s.config['ls_apply']={'sequence':[{'variables':{'result':fixture}},{'stop':'fixture','response_variable':'result'}]}

def proposed(source,attribute,value):return s.pure('effects_set',source=source,attribute=attribute,value=value,dry_run=True)

def one(source,attribute,value):
 result=proposed(source,attribute,value)
 assert result['valid'],result
 assert not result['commands']
 assert len(result['records'])==1,result
 return result['records'][0]

lamp=next(iter(catalog['members']))
a=one(lamp,'brightness','180')
assert set(a['value']['channels'])=={'brightness'} and a['scope']=='lamp'
assert a['value']['channels']['brightness']['value']==180
b=one(lamp,'rgb','1,2,3')
assert set(b['value']['channels'])=={'color'}
assert a['key']==b['key']
c=one(lamp,'effect','Candle')
assert set(c['value']['channels'])==set(catalog['effects']['Candle']['channels'])
normal=one(lamp,'effect','Normal light')
assert normal['value']['channels']['brightness']['value']==140
assert normal['value']['channels']['color']['value']=={'kelvin':2700}
# Observed effect-frame attributes are deliberately different and cannot leak in.
s.put(lamp,'on',{'brightness':3,'rgb_color':[1,1,1]})
assert one(lamp,'effect','Normal light')['value']==normal['value']
room=one('light.living_room','brightness',220)
assert room['scope']=='room' and room['target']=='living_room'
home=proposed('light.home','effect','Candle')
assert home['valid'] and len({r['value']['channels']['brightness']['instance'] for r in home['records']})==1
assert any(r['target']=='jonathan_bedroom' for r in home['records'])
assert all(r['scope']=='room' for r in home['records'])
print('PASS: channel-only controls, stable records, group scopes/shared instances, underlying Normal light values')

power=proposed('light.living_room','power','OFF')
assert power['valid'] and not power['records']
assert power['events']==[{'op':'power','area':'living_room','on':False,'via':'effects-house'}]
assert power['commands'][0]['action']=='homeassistant.turn_off'
solo=proposed(lamp,'power','OFF')
assert solo['events']==[] and solo['records']==[]
solo=proposed(lamp,'power','ON')
assert solo['events']==[{'op':'power','area':s.areas[lamp],'on':True,'via':'effects-house'}]
assert solo['commands'][0]['target']=={'entity_id':[lamp]} and not solo['records']
assert proposed('light.ls_house_day','effect','Candle')['commands'][0]['action']=='script.ls_store'
assert proposed('light.ls_house_day','temperature',500)['commands'][0]['data']=={'color_temp_kelvin':2000}
for attr,value in [('brightness','bad'),('brightness',-1),('brightness',256),('temperature',0),('rgb',[0,0,300]),('effect','not an effect'),('power','maybe')]:
 result=proposed(lamp,attr,value)
 assert not result['valid'] and not result['events'] and not result['commands']
print('PASS: persistent power plans, profile forwarding, invalid-input rejection, dry purity')

# Run live branches only in the fail-closed simulator. No service leaves this process.
s.calls.clear();s.events.clear()
s.run('effects_set',source=lamp,attribute='brightness',value=170)
assert len(s.events)==1 and s.events[0][0]=='ls_override'
assert not any(c['action'] in ['light.turn_on','light.turn_off','mqtt.publish','homeassistant.turn_on','homeassistant.turn_off'] for c in s.calls)
print('PASS: channel changes only emit override intent, never direct lamp/effect transport')

for attr,value,data in [('brightness',170,{'brightness':170}),('rgb','12,34,56',{'rgb_color':[12,34,56]}),('temperature',500,{'color_temp_kelvin':2000}),('power','ON',{}),('power','OFF',{})]:
 s.calls.clear();s.events.clear()
 s.run('effects_set',source='light.ls_house_day',attribute=attr,value=value)
 calls=[c for c in s.calls if c['action'].startswith('light.')]
 assert len(calls)==1 and calls[0]['target']=={'entity_id':'light.ls_house_day'}
 assert calls[0]['action']==('light.turn_off' if value=='OFF' else 'light.turn_on')
 assert calls[0]['data']==data and not s.events
print('PASS: native mapping dispatch preserves exact profile payloads and omitted fields')

stamp=s.now.timestamp()
def native(sd):return s.pure('effects_native_plan',sd=sd,catalog=catalog,current=fixture,stamp=stamp)['records']
records=native({'entity_id':lamp,'rgb_color':[10,20,30]})
assert len(records)==1 and set(records[0]['value']['channels'])=={'color'}
records=native({'entity_id':'light.kitchen_pendant_bulb_1','brightness_pct':50})
assert len(records)==1 and records[0]['target']=='light.kitchen_pendant'
assert records[0]['value']['channels']['brightness']['value']==127.5
records=native({'entity_id':'light.living_room','brightness':200})
assert len(records)==1 and records[0]['scope']=='room'
assert native({'entity_id':lamp})==[]
for data,expected in [({'hs_color':[0,100]},[255,0,0]),({'hs_color':[120,100]},[0,255,0]),({'hs_color':[240,100]},[0,0,255]),({'hs_color':[0,0]},[255,255,255]),({'color_name':'rebeccapurple'},[102,51,153]),({'rgbw_color':[0,0,0,255]},[255,255,255])]:
 rec=native({'entity_id':lamp,**data})[0]
 assert rec['value']['channels']['color']['value']=={'rgb':expected},(data,rec)
for data in [{'xy_color':[0.3,0.3]},{'rgbww_color':[0,0,0,200,100]}]:
 rgb=native({'entity_id':lamp,**data})[0]['value']['channels']['color']['value']['rgb']
 assert len(rgb)==3 and all(0<=v<=255 for v in rgb)
records=native({'entity_id':'light.home','effect':'Candle'})
assert len({r['value']['channels']['brightness']['instance'] for r in records})==1
print('PASS: native bulb-to-lamp mapping, room scopes, colour conversion, shared effect instance, power-only calls have no channel override')

detector='automation_lighting_schedule_lamp_change_detector'
def capture(sd,user='test-user',context_id='user-call',service='turn_on'):
 s.calls.clear();s.events.clear()
 s.run_automation(detector,{'event':{'context':{'user_id':user,'id':context_id},'data':{'service':service,'service_data':sd}}})
 return [data for event,data in s.events if event=='ls_override']
events=capture({'entity_id':lamp})
assert events==[{'op':'power','area':s.areas[lamp],'on':True,'via':'app','who':'test-user'}]
assert not any(c['action'] in ['light.turn_on','light.turn_off','mqtt.publish','homeassistant.turn_on','homeassistant.turn_off'] for c in s.calls)
events=capture({'entity_id':lamp,'brightness':180})
assert [e['op'] for e in events]==['power','set']
assert events[1]['records'][0]['value']['channels']['brightness']['value']==180
assert capture({'entity_id':lamp},user=None)==[]
assert capture({'entity_id':lamp},service='turn_off')==[]
from types import SimpleNamespace
s.put('script.active_test','on',{})
previous=s.states['script.active_test']
# State view constructs contexts on demand; provide a running context through a
# controlled state-list dependency, keeping the real automation guard intact.
old_states=s.env.globals['states']
class RunningStates:
 script=[SimpleNamespace(state='on',context=SimpleNamespace(id='script-call'))]
s.env.globals['states']=RunningStates()
try: assert capture({'entity_id':lamp},context_id='script-call')==[]
finally: s.env.globals['states']=old_states
print('PASS: explicit native ON opens only its room gate before channel intents; automation, script and OFF calls are ignored')

rng=random.Random(1882)
for _ in range(200):
 brightness=rng.randint(0,255);rgb=[rng.randint(0,255) for _ in range(3)]
 result=native({'entity_id':lamp,'brightness':brightness,'rgb_color':rgb})[0]
 assert result['value']['channels']['brightness']['value']==brightness
 assert result['value']['channels']['color']['value']=={'rgb':rgb}
print('PASS: 200 seeded native brightness/colour combinations preserve channel values')

sync=s.config['effects_ui_sync']
row=next(r for r in sync['sequence'][1]['variables']['rows'] if r['source']==lamp)

def mirrored(target, force=True):
 s.put('sensor.effects_controller','current',{'targets':{lamp:target},'assignments':{lamp:target}})
 return {m['topic']:m['payload'] for m in s.pure('effects_ui_sync',dry_run=True,force=force)['messages']}
s.put(lamp,'on',{'brightness':4,'color_mode':'rgb','rgb_color':[180,40,0]})
target={'level':140,'brightness':{'kind':'effect','effect':'Candle'},'color':{'kind':'effect','effect':'Candle'}}
messages=mirrored(target)
assert messages[row['topics']['brightness']]=='140'
assert messages[row['topics']['effect']]=='Candle'
assert messages[row['topics']['rgb']]=='180,40,0'
target['color']={'kind':'constant','value':{'rgb':[255,105,180]},'policy':'sara'}
messages=mirrored(target)
assert messages[row['topics']['rgb']]=='255,105,180' and messages[row['topics']['effect']]=='Candle'
target['brightness']['effect']='Breathe';target['color']={'kind':'effect','effect':'Colour loop'}
assert mirrored(target)[row['topics']['effect']]==''
target={'level':130,'brightness':{'kind':'constant','value':130},'color':{'kind':'constant','value':{'kelvin':2500}}}
messages=mirrored(target)
assert messages[row['topics']['effect']]=='Normal light' and messages[row['topics']['temperature']]=='400'
profile_row=next(r for r in sync['sequence'][1]['variables']['rows'] if r['source']=='light.ls_house_day')
s.store('input_text.ls_house_day',{'on':True,'b':150,'m':'ct','k':3000,'effect':'Candle','effect_channels':[]})
assert mirrored(target)[profile_row['topics']['effect']]=='Normal light'
s.store('input_text.ls_house_day',{'on':True,'b':150,'m':'ct','k':3000,'effect':'Candle','effect_channels':['brightness']})
assert mirrored(target)[profile_row['topics']['effect']]=='Candle'
s.put(row['proxy'],'on',{'effect':'Normal light','brightness':130,'color_mode':'color_temp','color_temp_kelvin':2500})
assert not set(mirrored(target,force=False)).intersection(row['topics'].values())
assert all(topic.startswith('house/v1/effect_preview/') and '/set/' not in topic for topic in messages)
print('PASS: UI logical levels, observed effect colour, Sara constant colour, mixed/partial effects, no-op suppression, dry purity')
