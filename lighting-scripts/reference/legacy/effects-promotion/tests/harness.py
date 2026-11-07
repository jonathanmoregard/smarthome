"""Offline execution of exported HA script sequences. No network or HA clients.
External effects are fail-closed memory sinks; native light->store adapter is a shim.
"""
import sys, json, ast, re, hashlib, colorsys, copy, argparse, traceback
from pathlib import Path
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo
sys.path[:0]=['/nix/store/35jf5h0ml9gfbr2w0cwjjj12l8f91al7-jinja2-3.1.6/lib/python3.11/site-packages','/nix/store/0bs4s1cgi7xv82mdbndl8g1jz87c9cdp-markupsafe-3.0.3/lib/python3.11/site-packages']
from jinja2 import Environment, StrictUndefined
LIVE=Path('/tmp/effects-promotion/live')
class End(Exception):
 def __init__(self,value=None):self.value=value
class Budget(Exception):pass
class Domain:
 def __init__(self,states,prefix):self.states,self.prefix=states,prefix
 def __getattr__(self,key):return self.states[self.prefix+'.'+key]
class States:
 def __init__(self,sim):self.sim=sim
 def __call__(self,key):return self.sim.state.get(key,{}).get('state','unknown')
 def __getitem__(self,key):
  d=self.sim.state.get(key)
  return SimpleNamespace(**{**d,'last_updated':datetime.fromisoformat(d.get('last_updated',self.sim.now.isoformat()))}) if d else None
 def __getattr__(self,key):return Domain(self,key)
class Sim:
 def __init__(self,candidate=None):
  self.config={}
  for p in LIVE.glob('*.json'):
   d=json.loads(p.read_text());d=d.get('config',d) if isinstance(d,dict) else d
   if isinstance(d,dict) and 'sequence' in d:self.config[p.stem]=d
  fallback=Path('/tmp/ha-effects-live/module/effect_candle_frame.json')
  self.config.setdefault('effect_candle_frame',json.loads(fallback.read_text()))
  if candidate:
   for p in Path(candidate).glob('*.json'):
    d=json.loads(p.read_text());d=d.get('config',d)
    if 'sequence' in d:self.config[p.stem]=d
  self.helper_options={}
  for info in json.loads(Path('/tmp/effects-promotion/audit/helper_configs.json').read_text()).values():
   opts=info['entry']['options'];store=opts['turn_off'][0]['data']['store'];self.helper_options[store.replace('input_text.','light.')]=opts
  self.state={x['entity_id']:copy.deepcopy(x) for x in json.loads((LIVE/'states_snapshot.json').read_text())}
  self.now=datetime(2026,10,23,12,tzinfo=ZoneInfo('Europe/Stockholm'))
  self.calls=[];self.events=[];self.elapsed=0.;self.max_elapsed=None;self.on_delay=None
  self.states=States(self)
  self.env=Environment(undefined=StrictUndefined)
  def fj(v,default=None):
   try:return json.loads(v)
   except:return default
  def dt(v):return datetime.fromtimestamp(v,self.now.tzinfo) if isinstance(v,(int,float)) else datetime.fromisoformat(str(v))
  def ts(v,default=None):
   try:return dt(v).timestamp() if not isinstance(v,datetime) else v.timestamp()
   except:return default
  self.env.filters.update(from_json=fj,to_json=json.dumps,bool=lambda v:str(v).lower() in ['true','on','yes','1'],regex_match=lambda v,p:re.match(p,str(v)) is not None,as_local=lambda v:v.astimezone(self.now.tzinfo),sha256=lambda v:hashlib.sha256(str(v).encode()).hexdigest())
  self.env.tests.update(list=lambda v:isinstance(v,list),match=lambda v,p:re.match(p,v) is not None,is_state=self.is_state,has_value=self.has_value)
  self.env.globals.update(states=self.states,state_attr=self.attr,is_state=self.is_state,has_value=self.has_value,now=lambda:self.now,timedelta=timedelta,as_timestamp=ts,as_datetime=dt,dict=dict,label_entities=lambda lab:self.members if lab=='house_schedule' else [],label_devices=lambda _:[],device_entities=lambda _:[],area_id=lambda e:self.areas.get(e),label_areas=lambda _:['jonathan_bedroom'])
  self.env.filters.update(device_entities=lambda _:[],area_id=lambda e:self.areas.get(e))
  cat=self.run('effects_catalog');self.members=list(cat['members']);self.areas={}
  for group,members in cat['groups'].items():
   if group=='light.home':continue
   area=group.removeprefix('light.').removesuffix('_all')
   for m in members:self.areas[m]=area
  self.put('sensor.ls_overrides','0',{'overrides':{}})
  self.put('sensor.effects_controller','0',{'assignments':{},'revision':self.now.isoformat()})
  self.put('script.effects_engine','off');self.put('binary_sensor.zigbee2mqtt_bridge_connection_state','on')
  for b,t in [('day','07:00:00'),('cosy','18:00:00'),('night','23:00:00')]:
   for suffix in ['start','weekend']:self.put(f'input_datetime.ls_house_{b}_{suffix}',t)
   self.put(f'input_number.ls_house_{b}_fade','20')
  for k in list(self.state):
   if k.startswith('input_boolean.ls_') and k.endswith(('_own_light','_own_timing')):self.put(k,'off')
   if k.startswith('input_text.ls_'):
    self.store(k,{'on':True,'b':150,'m':'ct','k':3000,'own':False,'effect':'Normal light'})
  for m in self.members:self.put(m,'on',{'brightness':150,'color_mode':'color_temp','color_temp_kelvin':3000,'rgb_color':[255,180,100]})
  for ends in cat['members'].values():
   for e in ends:
    if e not in self.state:self.put(e,'on',{'brightness':150})
 def put(self,e,s,attrs=None):
  prev=self.state.get(e,{});self.state[e]={'entity_id':e,'state':str(s),'attributes':copy.deepcopy(attrs if attrs is not None else prev.get('attributes',{})),'last_updated':self.now.isoformat()}
 def attr(self,e,k):return self.state.get(e,{}).get('attributes',{}).get(k)
 def is_state(self,e,s):return self.states(e)==s
 def has_value(self,e):return self.states(e) not in ['unavailable','unknown']
 def store(self,e,v):
  self.put(e,json.dumps(v));le=e.replace('input_text.','light.')
  rgb=[round(x*255) for x in colorsys.hsv_to_rgb(v.get('h',0)/360,v.get('s',0)/100,1)]
  self.put(le,'on' if v.get('on',True) else 'off',{'brightness':v.get('b',150),'color_mode':'hs' if v.get('m')=='hs' else 'color_temp','rgb_color':rgb,'color_temp_kelvin':v.get('k',3000)})
 def render(self,x,ctx):
  if isinstance(x,dict):return {k:self.render(v,ctx) for k,v in x.items()}
  if isinstance(x,list):return [self.render(v,ctx) for v in x]
  if not isinstance(x,str) or ('{{' not in x and '{%' not in x):return x
  out=self.env.from_string(x).render(ctx).strip()
  if '|to_json' in x.replace(' ',''):return out
  try:return ast.literal_eval(out)
  except (ValueError,SyntaxError):return out
 def cond(self,c,ctx):
  if isinstance(c,list):return all(self.cond(a,ctx) for a in c)
  if isinstance(c,str):return bool(self.render(c,ctx))
  if c['condition']=='template':return bool(self.render(c['value_template'],ctx))
  if c['condition']=='state':return self.is_state(c['entity_id'],c['state'])
  raise AssertionError(('unknown condition',c))
 def run(self,name,**ctx):
  assert name in self.config,('unknown script',name)
  try:self.seq(self.config[name]['sequence'],ctx)
  except End as e:return e.value
 def seq(self,steps,ctx):
  for step in steps:
   if 'variables' in step:
    for k,v in step['variables'].items():ctx[k]=self.render(v,ctx)
   elif 'condition' in step:
    if not self.cond(step,ctx):raise End()
   elif 'choose' in step:
    for branch in step['choose']:
     if self.cond(branch['conditions'],ctx):self.seq(branch['sequence'],ctx);break
    else:self.seq(step.get('default',[]),ctx)
   elif 'if' in step:self.seq(step.get('then' if self.cond(step['if'],ctx) else 'else',[]),ctx)
   elif 'repeat' in step:
    r=step['repeat'];prior=ctx.get('repeat')
    if 'for_each' in r:
     for i,item in enumerate(self.render(r['for_each'],ctx)):ctx['repeat']={'item':item,'index':i+1};self.seq(r['sequence'],ctx)
    elif 'while' in r:
     i=0
     while self.cond(r['while'],ctx):
      i+=1
      if i>10000:raise AssertionError('unbounded loop')
      ctx['repeat']={'index':i};self.seq(r['sequence'],ctx)
    else:raise AssertionError(('unknown repeat',r))
    if prior is None:ctx.pop('repeat',None)
    else:ctx['repeat']=prior
   elif 'stop' in step:raise End(ctx.get(step.get('response_variable')))
   elif 'delay' in step:
    d=self.render(step['delay'],ctx);seconds=d.get('seconds',0)+d.get('milliseconds',0)/1000 if isinstance(d,dict) else d
    self.elapsed+=seconds;self.now+=timedelta(seconds=seconds)
    if self.on_delay:self.on_delay(self)
    if self.max_elapsed is not None and self.elapsed>=self.max_elapsed:raise Budget()
   elif 'wait_template' in step:assert self.render(step['wait_template'],ctx),('wait unresolved',step['wait_template'])
   elif 'event' in step:self.event(step['event'],self.render(step.get('event_data',{}),ctx))
   elif 'action' in step:
    result=self.service(self.render(step['action'],ctx),self.render(step.get('target',{}),ctx),self.render(step.get('data',{}),ctx))
    if 'response_variable' in step:ctx[step['response_variable']]=result
   else:raise AssertionError(('unknown step',step))
 def event(self,name,data):
  self.events.append((name,data))
  if name=='ls_override':
   o=copy.deepcopy(self.attr('sensor.ls_overrides','overrides'))
   if data['op']=='set':
    for r in data['records']:o[r['kind']+':'+r['target']]={**r,'when':self.now.isoformat()}
   elif data['op']=='clear_all':o={}
   elif data['op']=='clear':
    for k in data['keys']:o.pop(k,None)
   else:raise AssertionError(data)
   self.put('sensor.ls_overrides',len(o),{'overrides':o})
  elif name!='ls_lamp_store_changed':raise AssertionError(('unknown event',name))
 def service(self,action,target,data):
  self.calls.append({'time':self.elapsed,'action':action,'target':copy.deepcopy(target),'data':copy.deepcopy(data)})
  ids=target.get('entity_id',[]);ids=[ids] if isinstance(ids,str) else ids
  if action.startswith('script.') and action not in ['script.turn_on','script.turn_off']:return self.run(action[7:],**data)
  if action in ['script.turn_on','script.turn_off']:
   for e in ids:self.put(e,'on' if action.endswith('turn_on') else 'off')
  elif action=='mqtt.publish':
   if data['topic']=='house/v1/effects/controller':
    d=json.loads(data['payload']);self.put('sensor.effects_controller',len(d['assignments']),d)
  elif action=='input_text.set_value':
   for e in ids:self.store(e,json.loads(data['value']))
  elif action in ['light.turn_on','light.turn_off']:
   for e in ids:
    if e.startswith('light.ls_'):
     # Native template-light adapter shim, not production code under test.
     p={'store':e.replace('light.','input_text.'),'on':True}
     if action.endswith('off'):p['on']=False
     elif data:
      if 'brightness' in data:p['brightness']=data['brightness']
      if 'color_temp_kelvin' in data:p['kelvin']=data['color_temp_kelvin']
      if 'rgb_color' in data:
       h,s,v=colorsys.rgb_to_hsv(*(x/255 for x in data['rgb_color']));p['hs']=[h*360,s*100]
     else:p['on']=True
     if e in self.helper_options:
      ctx={**data}
      if 'rgb_color' in data:ctx['hs']=p['hs']
      handler='turn_off' if action.endswith('off') else 'set_hs' if 'rgb_color' in data else 'set_temperature' if 'color_temp_kelvin' in data else 'set_level' if 'brightness' in data else 'turn_on'
      self.seq(self.helper_options[e][handler],ctx)
     else:self.run('ls_store',**p)
    else:self.put(e,'off' if action.endswith('off') else 'on',{**(self.attr(e,'__unused__') or self.state.get(e,{}).get('attributes',{})),**data})
  elif action in ['input_select.select_option','input_boolean.turn_on','input_boolean.turn_off','homeassistant.turn_on','homeassistant.turn_off']:
   for e in ids:self.put(e,data.get('option','on' if action.endswith('on') else 'off'))
  else:raise AssertionError(('Unknown external action blocked',action))
 def plan(self,**kw):return self.run('ls_apply',dry_run=True,reason='config',**kw)['plan']
 def reconcile(self,**kw):return self.run('ls_apply',reason='config',**kw)
 def assignments(self):return self.attr('sensor.effects_controller','assignments')
 def physical(self):return [c for c in self.calls if c['action']=='mqtt.publish' and c['data']['topic'].startswith('zigbee2mqtt/') or c['action'] in ['light.turn_on','light.turn_off'] and any(not e.startswith('light.ls_') for e in ([c['target']['entity_id']] if isinstance(c['target']['entity_id'],str) else c['target']['entity_id']))]
