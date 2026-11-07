import json
from pathlib import Path

P=Path('/tmp/ha-effects-live'); O=P/'module'; O.mkdir(exist_ok=True)
def read(n): return json.loads((P/n).read_text())
def save(n,c):
    p=O/(n+'.json'); p.write_text(json.dumps(c,indent=2).replace("states('sensor.ls_overrides')", "states.sensor.ls_overrides.last_updated.isoformat()")); json.loads(p.read_text())
def call(a,data=None,target=None,**kw):
    d={'action':a,**kw}
    if data is not None:d['data']=data
    if target is not None:d['target']={'entity_id':target}
    return d
def cond(s):return {'condition':'template','value_template':s}
def iff(s,then,otherwise=None):
    d={'if':[cond(s)],'then':then}
    if otherwise:d['else']=otherwise
    return d
def script(alias,seq,mode='queued',fields=None,description=''):
    d={'alias':alias,'description':description,'mode':mode,'sequence':seq}
    if mode in ('queued','parallel'):d['max']=50
    if mode=='single':d['max_exceeded']='silent'
    if fields:d['fields']={k:{'selector':{'object':{}}} for k in fields}
    return d
def ret(var='result'):return {'stop':'Return result','response_variable':var}
def mqtt(topic,payload,retain=False):return call('mqtt.publish',{'topic':topic,'payload':payload,'qos':0,'retain':retain})
def v(**kw):return {'variables':kw}

fixtures=json.loads(Path('/tmp/effect-native-copies/inventory.json').read_text())
topics={a['entity']:a['topic'] for a in read('endpoint-topics.json')}
for a in read('candle_test_run.json')['config']['sequence'][0]['variables']['lamps'].values(): topics[a['entity']]=a['topic']
topics.update({'light.upper_hall_ceiling':'zigbee2mqtt/0xa4c138f013c2624e/set','light.upper_hall_stair_lamp':'zigbee2mqtt/0xa4c138b95e526424/set'})
members={a['id']:[a['id']] for a in fixtures}
for name,count in [('kitchen_pendant',3),('kitchen_spots_1',3),('kitchen_spots_2',3),('meditation_floor_lamp',2)]:members['light.'+name]=['light.'+name+'_bulb_'+str(i) for i in range(1,count+1)]
groups={'light.home':[a['id'] for a in fixtures]}
for group,area in [('kitchen_all','kitchen'),('living_room','living_room'),('upper_hall','hall_overvaning'),('jonathan_bedroom','bedroom'),('meditation_mys_all','meditation_mys')]:groups['light.'+group]=[a['id'] for a in fixtures if a['area_id']==area]
registry={'Candle':{'renderer':'script.effect_candle_frame'},'Breathe':{'native':'breathe'},'Colour loop':{'native':'colorloop'}}
save('effects_catalog',script('Effects · Catalogue',[v(result={'effects':registry,'members':members,'groups':groups,'topics':topics,'budget':10}),ret()],mode='parallel',description='Single registration point for effects and transport endpoints. Renderers return a payload; the central engine owns all sending and timing.'))

# Pure, shared-time version of the approved Research filter. Five filter taps
# leave <0.6% residual; no mutable random state is duplicated per lamp.
frame='''{% set frame = (timestamp|float / 0.15)|int %}
{% set n=namespace(x=28 * 0.35**6) %}
{% for i in range(6) %}
  {% set seed = ((frame-i)|string ~ ':research-v1')|sha256 %}
  {% set raw = 20 + (seed[:8]|int(base=16) % 17) %}
  {% set n.x=n.x + 0.65 * 0.35**i * raw %}
{% endfor %}
{% set noise=states('input_number.candle_test_noise')|float(0.8) %}
{% set ceiling=[1,[254,brightness|int(150)]|min]|max %}
{% set floor=[1,(ceiling/4)|round|int]|max %}
{% set lo=[floor,[ceiling,(ceiling*(28-8*noise)/36)|round|int]|min]|max %}
{% set hi=[lo,[ceiling,(ceiling*(28+8*noise)/36)|round|int]|min]|max %}
{% set level=[floor,[ceiling,(ceiling*(28+noise*(n.x-28))/36)|round|int]|min]|max %}
{% set mix=[0,[1,(level-lo)/([1,hi-lo]|max)]|min]|max %}
{% set A=state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0] %}
{% set B=state_attr('light.candle_test_rgb_crossover','rgb_color') or [255,139,22] %}
{% set rgb=[(A[0]+(B[0]-A[0])*mix)|round|int,(A[1]+(B[1]-A[1])*mix)|round|int,(A[2]+(B[2]-A[2])*mix)|round|int] %}
{{ {'brightness':level,'rgb':rgb,'transition':transition|float(0.2)} }}'''
save('effect_candle_frame',script('Effects · Candle research renderer',[v(result=frame),ret()],mode='parallel',fields=['timestamp','brightness','transition'],description='Pure Research candle frame: shared 150 ms clock, 0.35/0.65 low-pass noise, brightness-linked RGB. No device writes, schedules, ownership or timers. Selfmade remains separate.'))

state_topic='house/v1/effects/controller'
sensor={'name':'Effects controller','unique_id':'effects_controller','default_entity_id':'sensor.effects_controller','state_topic':state_topic,'value_template':"{{ value_json.assignments|count }}",'json_attributes_topic':state_topic,'icon':'mdi:creation','entity_category':'diagnostic'}
save('sensor_discovery',sensor)

# Engine is the only emitter of custom frames. One paced unicast at a time,
# no catch-up/replay; group fixtures expand to individual bulb endpoints.
eligible="""{% set ns=namespace(rows=[]) %}{% for L,a in (state_attr('sensor.effects_controller','assignments') or {}).items() if is_state(L,'on') %}{% for E in catalog.members.get(L,[]) if is_state(E,'on') %}{% set ns.rows=ns.rows+[{'owner':L,'entity':E,'topic':catalog.topics[E],'effect':a.effect,'brightness':a.brightness}] %}{% endfor %}{% endfor %}{{ ns.rows }}"""
valid="{{ state_attr('sensor.effects_controller','revision') == states('sensor.ls_overrides') and is_state('binary_sensor.zigbee2mqtt_bridge_connection_state','on') }}"
engine=script('Effects · Central engine',[
    call('script.effects_catalog',response_variable='catalog'),
    v(cursor=0,previous={},color_at={},native_done={}),
    {'repeat':{'while':[cond(valid),cond("{{ (state_attr('sensor.effects_controller','assignments') or {})|count > 0 }}")], 'sequence':[
        v(rows=eligible),
        iff('{{ rows|count == 0 }}',[{'stop':'No powered lamps'}]),
        v(row='{{ rows[cursor|int % (rows|count)] }}',now_ts='{{ as_timestamp(now()) }}',definition='{{ catalog.effects.get(row.effect,{}) }}',pace='{{ 150 if rows|count == 1 else (1000/catalog.budget)|round|int }}',fade='{{ [0.5,[0.2,(rows|count)/catalog.budget]|max]|min }}'),
        {'choose':[
            {'conditions':[cond("{{ 'renderer' in definition }}")], 'sequence':[
                call('{{ definition.renderer }}',{'timestamp':'{{ now_ts }}','brightness':'{{ row.brightness }}','transition':'{{ fade }}'},response_variable='frame'),
                v(with_color="{{ now_ts|float - color_at.get(row.entity,0)|float >= 1 }}",payload="{{ dict({'brightness':frame.brightness,'transition':frame.transition}, **({'color':{'rgb':frame.rgb|join(',')}} if with_color else {})) }}"),
                iff("{{ valid_now and is_state(row.owner,'on') and is_state(row.entity,'on') and (with_color or previous.get(row.entity) != frame.brightness) }}",[
                    mqtt('{{ row.topic }}','{{ payload|to_json }}'),
                    v(previous='{{ dict(previous, **{row.entity:frame.brightness}) }}',color_at='{{ dict(color_at, **{row.entity:now_ts}) if with_color else color_at }}')
                ])
            ]},
            {'conditions':[cond("{{ 'native' in definition and native_done.get(row.entity) != row.effect }}")], 'sequence':[
                iff("{{ valid_now and is_state(row.owner,'on') and is_state(row.entity,'on') }}",[
                    mqtt('{{ row.topic }}',"{{ {'brightness':[1,[254,row.brightness|int]|min]|max,'effect':definition.native}|to_json }}"),v(native_done='{{ dict(native_done, **{row.entity:row.effect}) }}')
                ])
            ]}
        ]},
        v(cursor='{{ cursor|int + 1 }}'),{'delay':{'milliseconds':'{{ pace }}'}}
    ]}}
],mode='single',description='Central owner and transport clock. Maximum 10 unicast publishes/s total, no retained commands and no replay. Samples a shared effect clock; more lamps reduce sampling per lamp. Offline/off/override changes stop writes immediately at next paced step.')
# Check revision immediately before the write rather than only at loop entry.
for branch in engine['sequence'][-1]['repeat']['sequence'][3]['choose']:
    for act in branch['sequence']:
        if 'if' in act:act['if'][0]['value_template']=act['if'][0]['value_template'].replace('valid_now',valid[3:-3])
save('effects_engine',engine)

# Stop first, publish ownership second, then start; queued calls serialize
# assignment changes. Non-retained commands mean restart cannot replay frames.
save('effects_assign',script('Effects · Assign ownership',[
    v(rev="{{ revision|default(states('sensor.ls_overrides')) }}",old="{{ state_attr('sensor.effects_controller','assignments') or {} }}"),
    iff("{{ assignments != old or state_attr('sensor.effects_controller','revision') != rev }}",[
        call('script.turn_off',target='script.effects_engine'),
        call('script.effects_catalog',response_variable='catalog'),
        # Stop bulb-native effects only on owners being changed/removed.
        {'repeat':{'for_each':"{{ old.keys()|list }}",'sequence':[
            v(owner='{{ repeat.item }}'),
            iff("{{ old[owner] != assignments.get(owner) and 'native' in catalog.effects.get(old[owner].effect,{}) and is_state(owner,'on') }}",[
                {'repeat':{'for_each':'{{ catalog.members.get(owner,[]) }}','sequence':[
                    mqtt('{{ catalog.topics[repeat.item] }}', '{"effect":"stop_colorloop"}'),
                    {'delay':{'milliseconds':100}},
                    mqtt('{{ catalog.topics[repeat.item] }}', '{"effect":"stop_effect"}'),
                    {'delay':{'milliseconds':100}}
                ]}}
            ])
        ]}},
        mqtt(state_topic,"{{ {'assignments':assignments,'revision':rev}|to_json }}",True),
        {'wait_template':"{{ state_attr('sensor.effects_controller','assignments') == assignments and state_attr('sensor.effects_controller','revision') == rev }}",'timeout':2,'continue_on_timeout':False}
    ]),
    iff("{{ assignments|count > 0 and is_state('script.effects_engine','off') and rev == states('sensor.ls_overrides') }}",[call('script.turn_on',target='script.effects_engine')])
],fields=['assignments','revision']))

save('effects_filter_commands',script('Effects · Filter ordinary writes',[
    call('script.effects_catalog',response_variable='catalog'),
    v(result="""{% set active=(state_attr('sensor.effects_controller','assignments') or {}).keys()|list %}{% set out=namespace(cmds=[]) %}{% for c in commands %}{% set ns=namespace(ids=[]) %}{% for L in c.ids %}{% set members=catalog.groups.get(L,[L]) %}{% set ns.ids=ns.ids + ((members|reject('in',active)|list) if members|select('in',active)|list|count else [L]) %}{% endfor %}{% set ids=ns.ids|unique|list %}{% if ids %}{% set out.cmds=out.cmds+[dict(c,ids=ids)] %}{% endif %}{% endfor %}{{ {'commands':out.cmds} }}"""),ret()
],mode='parallel',fields=['commands']))

save('effects_route',script('Effects · Apply profile assignments',[
    call('script.effects_catalog',response_variable='catalog'),
    v(assignments="""{% set n=namespace(a={}) %}{% for L,a in (state_attr('sensor.effects_controller','assignments') or {}).items() if L not in profiles %}{% set n.a=dict(n.a,**{L:a}) %}{% endfor %}{% for L,p in profiles.items() if p.effect in catalog.effects and p.on %}{% set n.a=dict(n.a,**{L:{'effect':p.effect,'brightness':p.brightness}}) %}{% endfor %}{{ n.a }}"""),
    call('script.effects_assign',{'assignments':'{{ assignments }}','revision':'{{ revision }}'}),
    call('script.effects_filter_commands',{'commands':'{{ commands }}'},response_variable='result'),ret()
],fields=['profiles','commands','revision'],description='Small integration boundary: ordinary control supplies desired profiles; this module owns execution and filters writes to effect-owned lamps.'))

save('effects_release',script('Effects · Release targets',[
    v(assignments="{% set n=namespace(a={}) %}{% for L,a in (state_attr('sensor.effects_controller','assignments') or {}).items() if L not in targets %}{% set n.a=dict(n.a,**{L:a}) %}{% endfor %}{{ n.a }}"),
    call('script.effects_assign',{'assignments':'{{ assignments }}'})
],fields=['targets']))

# Store only a generic effect property. No algorithm resides in the scheduler.
s=read('ls_store.json')['config']
s['fields']['effect']={'name':'Effect','selector':{'text':{}}}
s['description']+=' The generic effect property is interpreted by the Effects module; explicit colour selects Normal light.'
patch=s['sequence'][0]['variables']['patch']
patch=patch.replace('{{ p }}',"{% if effect is defined and effect is not none %}{% set p=dict(p,effect=effect) %}{% elif (kelvin is defined and kelvin is not none) or (mireds is defined and mireds is not none) or (hs is defined and hs is not none) %}{% set p=dict(p,effect='Normal light') %}{% endif %}{{ p }}")
s['sequence'][0]['variables']['patch']=patch
save('ls_store',s)

a=read('ls_apply.json')['config']; plan=a['sequence'][0]['variables']['plan']
plan=plan.replace('namespace(cmds={}, dbg=[])','namespace(cmds={}, dbg=[], profiles={})')
needle="  {%- set lrec = ovr.get('light:' ~ L) -%}"
plan=plan.replace(needle,needle+"\n  {%- set effect_record = lrec if (lrec is mapping and lrec.value is mapping and 'effect' in lrec.value and not (S.fading and as_timestamp(lrec.when,0) <= S.last_fs)) else none -%}\n  {%- if effect_record is mapping -%}{%- set lrec = none -%}{%- endif -%}")
needle="  {%- set obj = L.split('.')[1] -%}"
profile="""
  {%- if not is_plug -%}
    {%- set eb = st.to if st.fr == 'lamp' else st.fr -%}
    {%- set esc = room if (room and is_state('input_boolean.ls_' ~ room ~ '_' ~ eb ~ '_own_light','on')) else 'house' -%}
    {%- set lp = states('input_text.ls_lamp_' ~ obj ~ '_' ~ eb)|from_json(default={}) -%}
    {%- set pr = lp if lp.get('own',false) else states('input_text.ls_' ~ esc ~ '_' ~ eb)|from_json(default={}) -%}
    {%- set effect = pr.get('effect','Normal light') if st.src != 'held' else 'Normal light' -%}
    {%- set bright = pr.get('b',255)|int -%}
    {%- if effect_record is mapping -%}
      {%- set effect = effect_record.value.effect -%}
      {%- set bright = effect_record.value.get('brightness',bright)|int -%}
    {%- endif -%}
    {%- if lamp_sara and a not in private -%}{%- set effect='Normal light' -%}{%- endif -%}
    {%- set out.profiles=dict(out.profiles,**{L:{'effect':effect,'brightness':bright,'on':true if effect_record is mapping else pr.get('on',true)}}) -%}
  {%- endif -%}
"""
plan=plan.replace(needle,needle+profile)
plan=plan.replace("    {%- set tr = 60 if (st.moving and why == 'tick') else 3 -%}", "    {%- if effect_record is not mapping -%}{%- set out.profiles=dict(out.profiles,**{L:dict(out.profiles[L],brightness=tgt.b|default(1),on=tgt.on)}) -%}{%- endif -%}\n    {%- set tr = 60 if (st.moving and why == 'tick') else 3 -%}")
plan=plan.replace("'cmds': res.list,", "'cmds': res.list, 'profiles':out.profiles, 'revision':states('sensor.ls_overrides'),")
a['sequence'][0]['variables']['plan']=plan
a['sequence'][2:2]=[
    cond("{{ plan.revision == states('sensor.ls_overrides') }}"),
    call('script.effects_route',{'profiles':'{{ plan.profiles }}','commands':'{{ plan.cmds }}','revision':'{{ plan.revision }}'},response_variable='routed'),
    v(plan='{{ dict(plan,cmds=routed.commands) }}')
]
settle=a['sequence'][-1]['then']
settle[1:1]=[
    cond("{{ plan.revision == states('sensor.ls_overrides') }}"),
    call('script.effects_filter_commands',{'commands':'{{ plan.cmds }}'},response_variable='settled'),v(plan='{{ dict(plan,cmds=settled.commands) }}')
]
save('ls_apply',a)
(O/'plan.jinja').write_text(plan)

save('effects_set',script('Effects · Native control adapter',[
    call('script.effects_catalog',response_variable='catalog'),
    cond("{{ attribute in ['power','brightness','rgb','temperature','effect'] }}"),
    cond("{{ attribute != 'effect' or value in ['Normal light'] + catalog.effects.keys()|list }}"),
    v(is_profile="{{ source.startswith('light.ls_') }}",targets='{{ catalog.groups.get(source,[source]) }}',stamp='{{ as_timestamp(now()) }}'),
    {'choose':[{'conditions':[cond('{{ is_profile }}')],'sequence':[
        cond("{{ states[source.replace('light.','input_text.')] is not none }}"),
        {'choose':[
            {'conditions':[cond("{{ attribute == 'effect' }}")],'sequence':[call('script.ls_store',{'store':"{{ source.replace('light.','input_text.') }}",'effect':'{{ value }}'})]},
            {'conditions':[cond("{{ attribute == 'power' and value == 'OFF' }}")],'sequence':[call('light.turn_off',target='{{ source }}')]}
        ],'default':[call('light.turn_on',target='{{ source }}',data="{{ {'brightness':value|int} if attribute == 'brightness' else {'rgb_color':(value.split(',') if value is string else value)|map('int')|list} if attribute == 'rgb' else {'color_temp_kelvin':(1000000/(value|float))|round|int} if attribute == 'temperature' else {} }}")]}
    ]}], 'default':[
        cond("{{ targets|reject('in',catalog.members)|list|count == 0 }}"),
        {'choose':[{'conditions':[cond("{{ attribute == 'power' }}")],'sequence':[
            iff("{{ value == 'OFF' }}",[call('script.effects_release',{'targets':'{{ targets }}'}),call('light.turn_off',target='{{ targets }}')],[call('light.turn_on',target='{{ targets }}')])
        ]}], 'default':[
            v(records="""{% set n=namespace(r=[]) %}{% set active=state_attr('sensor.effects_controller','assignments') or {} %}{% set overrides=state_attr('sensor.ls_overrides','overrides') or {} %}{% for L in targets %}{% set record=overrides.get('light:' ~ L) %}{% set prior=record.get('value') if record is mapping else none %}{% set prior=prior if prior is mapping else {} %}{% set previous_effect=prior.get('effect','Normal light') if record is mapping else active.get(L,{}).get('effect','Normal light') %}{% set ef=value if attribute=='effect' else previous_effect if attribute=='brightness' else 'Normal light' %}{% set b=value|int if attribute=='brightness' else prior.get('brightness',active.get(L,{}).get('brightness',state_attr(L,'brightness')|int(150))) %}{% set val={'effect':ef,'brightness':b,'token':stamp} if attribute=='effect' or (attribute=='brightness' and ef!='Normal light') else {'brightness':b} if attribute=='brightness' else none %}{% set n.r=n.r+[{'kind':'light','target':L,'value':val}] %}{% endfor %}{{ n.r }}"""),
            {'event':'ls_override','event_data':{'op':'set','records':'{{ records }}','via':'effects-house'}},
            {'wait_template':"{% set ns=namespace(ok=true) %}{% for r in records %}{% set stored=(state_attr('sensor.ls_overrides','overrides') or {}).get('light:' ~ r.target,{}) %}{% if stored.get('value') != r.value or as_timestamp(stored.get('when'),0) < stamp|float %}{% set ns.ok=false %}{% endif %}{% endfor %}{{ ns.ok }}",'timeout':3,'continue_on_timeout':False},
            v(normal_targets="{% set n=namespace(ids=[]) %}{% for r in records if r.value is not mapping or 'effect' not in r.value %}{% set n.ids=n.ids+[r.target] %}{% endfor %}{{ n.ids }}"),
            iff("{{ attribute in ['rgb','temperature','brightness'] and normal_targets|count > 0 }}",[
                call('script.effects_release',{'targets':'{{ normal_targets }}'}),
                call('light.turn_on',target='{{ normal_targets }}',data="{{ {'brightness':value|int} if attribute=='brightness' else {'rgb_color':(value.split(',') if value is string else value)|map('int')|list} if attribute=='rgb' else {'color_temp_kelvin':(1000000/(value|float))|round|int} }}")
            ])
        ]}
    ]}
],fields=['source','attribute','value'],description='House commands become existing light overrides; profile commands update existing baseline stores. Brightness adjusts an active effect intensity; explicit colour returns to ordinary control.'))

save('effects_lifecycle',{'alias':'Effects · Lifecycle','mode':'restart','triggers':[
    {'trigger':'homeassistant','event':'start'},
    {'trigger':'state','entity_id':'binary_sensor.zigbee2mqtt_bridge_connection_state','to':'on'},
    {'trigger':'time_pattern','seconds':'/15'}
], 'conditions':[{'condition':'state','entity_id':'script.effects_engine','state':'off'},cond("{{ (state_attr('sensor.effects_controller','assignments') or {})|count > 0 }}")], 'actions':[call('script.ls_apply',{'reason':'config'})]})

save('module_contract',{'scripts':['effects_catalog','effect_candle_frame','effects_engine','effects_assign','effects_filter_commands','effects_route','effects_release','effects_set'],'scheduler_hooks':['generic effect stored by ls_store','ls_apply passes profiles to effects_route; filters its settle resend'],'registry':registry,'transport':'10 unicasts/s total; sampling shared-time frames; no missed-frame replay','fixtures':members})
print('Built',len(list(O.glob('*.json'))),'JSON artifacts')
