import json, copy
from pathlib import Path

ROOT=Path('/tmp/lighting-algebra')
OUT=ROOT/'candidate'
OUT.mkdir(exist_ok=True)
def old(name): return json.loads((ROOT/'before'/f'{name}.json').read_text())['config']
def save(name,c):
    (OUT/f'{name}.json').write_text(json.dumps(c,indent=2)+'\n')
def variables(**kw): return {'variables':kw}
def call(name,data=None,response=None):
    x={'action':'script.'+name}
    if data is not None:x['data']=data
    if response:x['response_variable']=response
    return x
def script(alias,seq,fields=(),mode='parallel'):
    x={'alias':alias,'mode':mode,'sequence':seq}
    if mode in ['parallel','queued']:x['max']=50
    if fields:x['fields']={k:{'selector':{'object':{}}} for k in fields}
    return x
def ret(name='result'):return {'stop':'Return result','response_variable':name}
def template(name): return (ROOT/f'{name}.jinja').read_text()

# Keep the existing schedule clock, weekend/fade/wake behavior and saved profiles.
base=old('ls_apply')['sequence'][0]['variables']['plan']
# Cache only the next expiry boundary for repeated remote scale increments.
base=base.replace('nxt_f=0, last_fs=0)', 'nxt_f=0, last_fs=0, next_fs=0)')
base=base.replace("{%- if its - f <= as_timestamp(T)", "{%- if its-f>as_timestamp(T) and (t.next_fs==0 or its-f<t.next_fs) -%}{%- set t.next_fs=its-f -%}{%- endif -%}\n        {%- if its - f <= as_timestamp(T)",1)
base=base.replace("'last_fs': t.last_fs,", "'last_fs': t.last_fs, 'next_fs':t.next_fs,")
base=base.replace("{%- set blocks =", "{%- set rooms=([room_only] if room_only in rooms else []) if room_only else rooms -%}\n{%- set blocks =",1)
base=base.replace("label_entities('house_schedule') + label_entities('on_off')", "label_entities('house_schedule') + label_entities('on_off') + (state_attr('sensor.ls_overrides','switch_ranges') or {}).keys()|list",1)
base=base.replace("{%- set sara = 'mode:sara' in ovr -%}","{%- set sara = false -%}")
base=base.replace("{%- set lrec = ovr.get('light:' ~ L) -%}","{%- set lrec = none -%}")
base=base.replace("{%- set lrec = none -%}","""{%- set expired=namespace(keys=[],rec=none) -%}
{%- if is_state('input_boolean.ls_ovr_next_block_on','on') -%}
 {%- for key,r in ovr|dictsort if r is mapping -%}
  {%- set applies=(r.kind=='light' and r.target==L) or (r.kind=='channels' and ((r.get('scope')=='lamp' and r.target==L) or (r.get('scope')=='room' and r.target==ts) or (r.get('scope')=='house' and a not in private))) or (key=='mode:sara' and a not in private) -%}
  {%- if applies and as_timestamp(r.get('when'),0)<=S.last_fs -%}{%- set expired.keys=expired.keys+[key] -%}{%- set expired.rec={'when':r.when,'value':none} -%}{%- endif -%}
 {%- endfor -%}
{%- endif -%}{%- set lrec=expired.rec if S.fading else none -%}""",1)
base=base.replace("{%- set send_now = st.src != 'held' and (why != 'tick' or st.moving or st.edge) -%}","{%- set send_now = true -%}")
base=base.replace("{%- set orec = ovr.get('block:' ~ ts) -%}", """{%- set pick = namespace(rec=ovr.get('block:' ~ ts),stamp=as_timestamp(ovr.get('block:' ~ ts,{}).get('when'),0)) -%}
{%- for key,r in ovr|dictsort if r is mapping and r.get('kind')=='channels' and r.get('value') is mapping -%}
 {%- set matches=(r.get('scope')=='lamp' and r.target==L) or (r.get('scope')=='room' and r.target==ts) or (r.get('scope')=='house' and a not in private) -%}
 {%- set period=r.value.get('period') -%}{%- set stamp=r.value.get('period_updated',as_timestamp(r.get('when'),0))|float -%}
 {%- if matches and period in blocks and stamp>=pick.stamp and not (is_state('input_boolean.ls_ovr_next_block_on','on') and as_timestamp(r.when,0)<=S.last_fs) -%}{%- set pick.rec={'value':period,'when':r.when} -%}{%- set pick.stamp=stamp -%}{%- endif -%}
{%- endfor -%}{%- set orec=pick.rec -%}
{%- if orec is mapping and is_state('input_boolean.ls_ovr_next_block_on','on') and not S.fading and as_timestamp(orec.when,0)<=S.last_fs -%}{%- set orec=none -%}{%- endif -%}""")
base=base.replace("'on':true if effect_record is mapping else pr.get('on',true)","'on':pr.get('on',true),'period':eb,'area':a,'effect_channels':pr.get('effect_channels',['brightness','color']),'send':(why!='tick' or st.moving or st.edge),'ignore_overrides':expired.keys")
base=base.replace("'sched': mir.sched,", "'sched': mir.sched, 'schedule_details':ns.sched,")
base=base.replace("{%- set a = (area_id(r.target) if r.kind == 'light' else r.target) -%}","{%- set a = (area_id(r.target) if r.kind == 'light' or r.get('scope')=='lamp' else r.target) -%}")
base=base.replace("{%- if as_timestamp(r.when, 0) <= ns.sched[sc].last_fs and not ns.sched[sc].fading -%}{%- set skeys.list = skeys.list + [k] -%}{%- endif -%}","""{%- set expired_all=namespace(yes=true) -%}
{%- set scopes=(rooms|reject('in',private)|list) if r.get('scope')=='house' or k=='mode:sara' else [sc] -%}
{%- for scope in scopes -%}{%- if as_timestamp(r.when,0)>ns.sched[scope].last_fs or ns.sched[scope].fading -%}{%- set expired_all.yes=false -%}{%- endif -%}{%- endfor -%}
{%- if scopes and expired_all.yes -%}{%- set skeys.list=skeys.list+[k] -%}{%- endif -%}""")
save('ls_base',script('Lighting · Scheduled base',[
    variables(reason="{{ reason|default('config') }}",room_only="{{ room_only|default('') }}",lights="{{ ['room:'~room_only] if room_only else [] }}",force_all=True,test_overrides='{{ overrides }}',plan=base),
    variables(result=template('base_targets').replace("if area!='house'", "if area!='house' and (not room_only or area==room_only)")),ret()
],['overrides','test_now','reason','room_only']))

# Single queued persistence owner. Power/ranges are separate attributes, never expiring overrides.
writer=old('automation_lighting_schedule_override_store_writer')
writer['description']='Single queued writer. Source-keyed channel records merge per channel; no cross-scope deletion. Persistent power and range configuration are separate from expiring overrides.'
writer['actions']=[{'condition':'template','value_template':"{{ trigger.event.data.get('expected_revision') in [none,states.sensor.ls_overrides.last_updated.isoformat()] }}"},variables(result=template('store_update')),
 {'action':'variable.update_sensor','target':{'entity_id':'sensor.ls_overrides'},'data':{'value':'{{ now().isoformat() }}','attributes':'{{ result }}','replace_attributes':False}}]
save('automation_lighting_schedule_override_store_writer',writer)

store_config=old('ls_store')
store_config['description']='Merge saved block settings. Explicit brightness or colour releases only that effect channel; selecting an effect claims its declared channels. Power remains an independent saved block setting.'
store_config['sequence'].insert(0,call('effects_catalog',response='catalog'))
patch=store_config['sequence'][1]['variables']['patch']
start=patch.index('{% if effect is defined and effect is not none %}')
patch=patch[:start]+"""{% set active=current.get('effect','Normal light') %}{% set channels=current.get('effect_channels',catalog.effects.get(active,{}).get('channels',[])) %}
{% if effect is defined and effect is not none %}{% set p=dict(p,effect=effect,effect_channels=catalog.effects.get(effect,{}).get('channels',[])) %}
{% else %}{% if brightness is defined and brightness is not none %}{% set channels=channels|reject('eq','brightness')|list %}{% endif %}
{% if (kelvin is defined and kelvin is not none) or (mireds is defined and mireds is not none) or (hs is defined and hs is not none) %}{% set channels=channels|reject('eq','color')|list %}{% endif %}
{% set p=dict(p,effect_channels=channels) %}{% endif %}{{ p }}"""
store_config['sequence'][1]['variables']['patch']=patch
save('ls_store',store_config)

catalog=old('effects_catalog')
c=catalog['sequence'][0]['variables']['result']
c['effects']={
 'Candle':{'renderer':'script.effect_candle_frame','channels':['brightness','color']},
 'Breathe':{'renderer':'script.effect_breathe_frame','channels':['brightness']},
 'Colour loop':{'renderer':'script.effect_colour_loop_frame','channels':['color']}}
c['multicast']=json.loads((ROOT/'grouping/proposed_groups.json').read_text())
c['phases']=json.loads((ROOT/'grouping/candle_phases.json').read_text())
c['budget']=5
save('effects_catalog',catalog)

candle=old('effect_candle_frame')
v=candle['sequence'][0]['variables']['result']
v=v.replace("':research-v1'","':' ~ (phase|default('default')) ~ ':research-v2'")
candle['sequence'][0]['variables']['result']=v
candle['fields']['phase']={'selector':{'text':{}}}
candle['description']='Pure Candle sample. One phase per logical lamp/cohort and one timestamp per batch; all constituent bulbs share the sample. No device writes.'
save('effect_candle_frame',candle)
save('effect_breathe_frame',script('Effects · Breathe frame',[
 variables(result="{% set q=((timestamp|float % 6)/3) %}{% set x=q if q<=1 else 2-q %}{{ {'brightness':([1,brightness|float*(0.35+0.65*x)]|max)|round|int,'transition':transition|default(0.4)|float} }}"),ret()
],['timestamp','brightness','transition','phase']))
save('effect_colour_loop_frame',script('Effects · Colour loop frame',[
 variables(result="{% set h=(timestamp|float % 30)/5 %}{% set i=h|int %}{% set x=(255*(h-i))|round|int %}{% set rgb=[[255,x,0],[255-x,255,0],[0,255,x],[0,255-x,255],[x,0,255],[255,0,255-x]][i] %}{{ {'rgb':rgb,'transition':transition|default(0.4)|float} }}"),ret()
],['timestamp','brightness','transition','phase']))

save('effects_frame_plan',script('Effects · Compose lamp frames',[
 variables(rows=[],frames={}),
 {'repeat':{'for_each':'{{ targets.keys()|list }}','sequence':[
  variables(lamp='{{ repeat.item }}',target='{{ targets[lamp] }}',payload={},frames={}),
  {'repeat':{'for_each':['brightness','color'],'sequence':[
   variables(channel='{{ repeat.item }}',source='{{ target[channel] }}',value='{{ source.get("value") }}'),
   {'if':[{'condition':'template','value_template':"{{ source.kind=='effect' and source.effect in catalog.effects }}"}], 'then':[
    variables(frame_key='{{ source.instance ~ ":" ~ source.effect }}'),
    {'if':[{'condition':'template','value_template':'{{ frame_key not in frames }}'}], 'then':[
     {'action':'{{ catalog.effects[source.effect].renderer }}','data':{'timestamp':'{{ timestamp }}','brightness':'{{ source.intensity }}','transition':0.4,'phase':'{{ catalog.phases.get(lamp,lamp) }}'},'response_variable':'frame'},
     variables(frames='{{ dict(frames,**{frame_key:frame}) }}')]},
    variables(value="{{ frames[frame_key].brightness if channel=='brightness' else {'rgb':frames[frame_key].rgb} }}") ]},
   variables(payload="{{ dict(payload,brightness=([1,[254,value|float]|min]|max)|round|int) if channel=='brightness' else dict(payload,**({'color_temp':(1000000/value.kelvin)|round|int} if 'kelvin' in value else {'color':{'rgb':value.rgb|join(',')}})) }}")
  ]}},
  variables(payload="{% set manual=target.get('owners',{}).values()|select('match','^channels:')|list|count>0 %}{% set transition=(0.4 if target.brightness.kind=='effect' or target.color.kind=='effect' else 0.2 if manual else target.get('transition',3)) if target.on else target.get('transition',3) %}{% set transition=[transition,transition_cap]|min if transition_cap|default(none) is number else transition %}{{ dict(payload,transition=transition) if target.on else {'state':'OFF','transition':transition} }}",rows="{% set n=namespace(rows=rows) %}{% if is_state(lamp,'on') %}{% for E in catalog.members.get(lamp,[]) if is_state(E,'on') %}{% set n.rows=n.rows+[{'entity':E,'owner':lamp,'topic':catalog.topics[E],'payload':payload}] %}{% endfor %}{% endif %}{{ n.rows }}")
 ]}},
 call('effects_group_plan',{'rows':'{{ rows }}','groups':'{{ catalog.multicast }}'},'result'),ret()
],['targets','catalog','timestamp','transition_cap']))

save('effects_emit',script('Effects · Paced output',[
 variables(completed=True),
 {'repeat':{'for_each':'{{ commands }}','sequence':[
  variables(command='{{ repeat.item }}',allowed="{% set n=namespace(ok=revision==states.sensor.ls_overrides.last_updated.isoformat() and generation==state_attr('sensor.effects_controller','generation')) %}{% for L in command.owners %}{% if not is_state(L,'on') or (command.payload.get('state')!='OFF' and not (state_attr('sensor.ls_overrides','power') or {}).get(area_id(L),true)) %}{% set n.ok=false %}{% endif %}{% endfor %}{% for E in command.members %}{% if not is_state(E,'on') %}{% set n.ok=false %}{% endif %}{% endfor %}{{ n.ok }}"),
  {'if':[{'condition':'template','value_template':'{{ allowed }}'},{'condition':'state','entity_id':'binary_sensor.zigbee2mqtt_bridge_connection_state','state':'on'}], 'then':[
   {'action':'mqtt.publish','data':{'topic':'{{ command.topic }}','payload':'{{ command.payload|to_json }}','qos':0,'retain':False}},
   {'delay':{'milliseconds':200}}], 'else':[variables(completed=False)]}
 ]}},
 variables(result="{{ {'completed':completed and revision==states.sensor.ls_overrides.last_updated.isoformat() and generation==state_attr('sensor.effects_controller','generation')} }}"),ret()
],['commands','revision','generation'],mode='queued'))

assign=script('Effects · Assign channel ownership',[
 {'if':[{'condition':'template','value_template':"{{ revision!=states.sensor.ls_overrides.last_updated.isoformat() }}"}], 'then':[variables(result="{{ {'generation':state_attr('sensor.effects_controller','generation')} }}"),ret()]},
 variables(rev='{{ revision }}',old="{{ state_attr('sensor.effects_controller','assignments') or {} }}",old_targets="{{ state_attr('sensor.effects_controller','targets') or {} }}",changed="{{ targets != (state_attr('sensor.effects_controller','targets') or {}) or revision != state_attr('sensor.effects_controller','revision') or invalidate|default([])|count>0 }}",generation="{{ state_attr('sensor.effects_controller','generation') }}",plan_order="{{ plan_order|default(state_attr('sensor.effects_controller','plan_order') or 0) }}"),
 {'if':[{'condition':'template','value_template':'{{ changed }}'}],'then':[
  {'action':'script.turn_off','target':{'entity_id':'script.effects_engine'}},
  variables(generation='{{ now().isoformat() }}')
 ]},
 {'if':[{'condition':'template','value_template':"{{ changed or plan_order>(state_attr('sensor.effects_controller','plan_order') or 0) }}"}],'then':[
  {'action':'mqtt.publish','data':{'topic':'house/v1/effects/controller','qos':0,'retain':True,'payload':"{% set applied=state_attr('sensor.effects_controller','applied') %}{% set applied=state_attr('sensor.effects_controller','targets') or {} if applied is none else applied %}{% set applied=dict(applied.items()|rejectattr(0,'in',invalidate|default([]))|list) %}{{ {'targets':targets,'assignments':assignments,'applied':applied|to_json|from_json,'revision':revision,'generation':generation,'plan_order':plan_order,'gradients':gradients|default(state_attr('sensor.effects_controller','gradients') or {})}|to_json }}"}},
  {'wait_template':"{{ state_attr('sensor.effects_controller','generation')==generation and state_attr('sensor.effects_controller','plan_order')==plan_order }}",'timeout':3,'continue_on_timeout':False}
 ]},
 {'if':[{'condition':'template','value_template':'{{ changed }}'}],'then':[
  call('effects_catalog',response='catalog'),
  variables(native_stops="""{% set n=namespace(commands=[]) %}
{% for L,t in targets.items() if not t.is_room %}
 {% set stop=namespace(needed=old.get(L,{}).get('effect') in ['Breathe','Colour loop']) %}
 {% for channel in ['brightness','color'] %}
  {% if t[channel].kind=='effect' and t.owners[channel].startswith('channels:native:') and t[channel].updated!=old_targets.get(L,{}).get(channel,{}).get('updated') %}{% set stop.needed=true %}{% endif %}
 {% endfor %}
 {% if stop.needed %}{% for E in catalog.members.get(L,[]) if is_state(E,'on') %}{% for effect in ['stop_colorloop','stop_effect'] %}
  {% set n.commands=n.commands+[{'topic':catalog.topics[E],'payload':{'effect':effect},'members':[E],'owners':[L],'group':false}] %}
 {% endfor %}{% endfor %}{% endif %}
{% endfor %}{{ n.commands }}"""),
  call('effects_emit',{'commands':'{{ native_stops }}','revision':'{{ revision }}','generation':'{{ generation }}'})
 ]},
 {'if':[{'condition':'template','value_template':'{{ assignments|count>0 }}'}],'then':[{'action':'script.turn_on','target':{'entity_id':'script.effects_engine'}}]},
 variables(result="{{ {'generation':state_attr('sensor.effects_controller','generation')} }}"),ret()
],['targets','assignments','revision','invalidate','plan_order','gradients'],mode='queued')
save('effects_assign',assign)

engine=script('Effects · Central engine',[
 call('effects_catalog',response='catalog'),
 {'repeat':{'while':[
  {'condition':'template','value_template':"{{ state_attr('sensor.effects_controller','revision')==states.sensor.ls_overrides.last_updated.isoformat() and (state_attr('sensor.effects_controller','assignments') or {})|count>0 }}"},
  {'condition':'state','entity_id':'binary_sensor.zigbee2mqtt_bridge_connection_state','state':'on'}], 'sequence':[
   variables(revision="{{ state_attr('sensor.effects_controller','revision') }}",generation="{{ state_attr('sensor.effects_controller','generation') }}",targets="{% set n=namespace(t={}) %}{% for L,t in (state_attr('sensor.effects_controller','assignments') or {}).items() if is_state(L,'on') and t.on %}{% set n.t=dict(n.t,**{L:t}) %}{% endfor %}{{ n.t }}"),
   call('effects_frame_plan',{'targets':'{{ targets }}','catalog':'{{ catalog }}','timestamp':'{{ as_timestamp(now()) }}'},'batch'),
   call('effects_emit',{'commands':'{{ batch.commands }}','revision':'{{ revision }}','generation':'{{ generation }}'}),
   {'delay':{'milliseconds':200}}
 ]}}
],mode='single')
engine['max_exceeded']='silent'
save('effects_engine',engine)

for name in ['effects_group_plan']:
 save(name,json.loads((ROOT/'grouping'/f'{name}.json').read_text()))

if (ROOT/'core/effects_resolve.json').exists():save('effects_resolve',json.loads((ROOT/'core/effects_resolve.json').read_text()))
if (ROOT/'core/effects_scale.json').exists():save('effects_scale',json.loads((ROOT/'core/effects_scale.json').read_text()))
if (ROOT/'core/effects_gradient_plan.json').exists():save('effects_gradient_plan',json.loads((ROOT/'core/effects_gradient_plan.json').read_text()))
for directory in ['adapters','ui','remote']:
 for path in (ROOT/directory).glob('*.json'):
  value=json.loads(path.read_text())
  if isinstance(value,dict) and ('sequence' in value or 'triggers' in value):save(path.stem,value)

# Reads never enter the queued actuator. Keep the existing native UI data contract.
native= json.loads((OUT/'effects_set.json').read_text())
for step in native['sequence']:
 for child in step.get('then',[]):
  if child.get('action')=='script.ls_apply' and child.get('data',{}).get('dry_run') is True:
   child['action']='script.ls_plan'
   child['data'].pop('dry_run')
save('effects_set',native)

save('ls_remote_command',script('Lighting · Room remote command',[
 variables(overrides="{{ state_attr('sensor.ls_overrides','overrides') or {} }}",stamp='{{ as_timestamp(now()) }}',room="{{ area if area_entities(area) else '' }}",catalog={},current={'plan':{'base':{},'resolved':{'targets':{}}}}),
 variables(timing_revision=template('remote_timing_revision'),request_id="{{ source~':'~stamp }}"),
 variables(result=template('remote_fast')),
 {'if':[{'condition':'template','value_template':'{{ result is not mapping }}'}],'then':[
  {'if':[{'condition':'template','value_template':"{{ command not in ['toggle','reset','sara_toggle'] }}"}],'then':[call('ls_plan',{'room':'{{ room }}','reason':'config'},'current')]},
  {'if':[{'condition':'template','value_template':"{{ command in ['toggle','left','right'] }}"}],'then':[call('effects_catalog',response='catalog')]},
  variables(result=template('remote_command'))
 ]},
 {'if':[{'condition':'template','value_template':'{{ dry_run|default(false) }}'}],'then':[ret()]},
 {'if':[{'condition':'template','value_template':"{{ result.op=='power' }}"}],'then':[
  {'event':'ls_override','event_data':{'op':'power','area':'{{ result.area }}','on':'{{ result.on }}','via':'remote','source':'{{ source }}','request_id':'{{ request_id }}'}},
  {'action':'homeassistant.turn_on' if False else '{{ "homeassistant.turn_on" if result.on else "homeassistant.turn_off" }}','target':{'entity_id':'{{ result.targets }}'}}
 ],'else':[{'choose':[
  {'conditions':[{'condition':'template','value_template':"{{ result.op=='set' }}"}],'sequence':[{'event':'ls_override','event_data':{'op':'set','records':'{{ result.records }}','via':'remote','source':'{{ source }}','request_id':'{{ request_id }}'}}]},
  {'conditions':[{'condition':'template','value_template':"{{ result.op=='clear' }}"}],'sequence':[{'event':'ls_override','event_data':{'op':'clear','keys':"{{ result['keys'] }}",'via':'remote','source':'{{ source }}','request_id':'{{ request_id }}'}}]},
  {'conditions':[{'condition':'template','value_template':"{{ result.op=='clear_room' }}"}],'sequence':[{'event':'ls_override','event_data':{'op':'clear_room','area':'{{ result.area }}','via':'remote','source':'{{ source }}','request_id':'{{ request_id }}'}}]}
 ]}]},
 {'if':[{'condition':'template','value_template':"{{ result.op!='noop' }}"}],'then':[{'wait_template':"{{ (state_attr('sensor.ls_overrides','remote_ack') or {}).get(source)==request_id }}",'timeout':2,'continue_on_timeout':False}]}
],['source','area','command','dry_run'],mode='queued'))

if (ROOT/'apply_sequence.json').exists():
 apply=old('ls_apply');apply['sequence']=json.loads((ROOT/'apply_sequence.json').read_text());apply['description']='Resolve scheduled base and per-channel ownership. dry_run returns the full plan without state writes, events, or device commands. Synthetic inputs are rejected on live calls. Existing schedule clock/fades/wake are retained.';save('ls_apply',apply)

print('Built',len(list(OUT.glob('*.json'))),'candidate configurations')
