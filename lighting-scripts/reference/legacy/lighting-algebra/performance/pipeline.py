"""Build room-local lighting execution with one synchronous override writer.

All functions operate on exported configuration. No HA access or deployment.
"""
from copy import deepcopy
from pathlib import Path
import json

ROOT = Path('/tmp/lighting-algebra')
RUNTIME = 'sensor.ls_effects_runtime'


def var(**values): return {'variables': values}
def call(name, data=None, response=None):
    result = {'action': 'script.' + name}
    if data is not None: result['data'] = data
    if response: result['response_variable'] = response
    return result
def ret(name='result'): return {'stop': 'Return result', 'response_variable': name}
def cond(value): return {'condition': 'template', 'value_template': value}
def script(alias, sequence, fields=(), mode='parallel'):
    result = {'alias': alias, 'mode': mode, 'sequence': sequence,
              'fields': {field: {'selector': {'object': {}}} for field in fields}}
    if mode in ('parallel', 'queued'): result['max'] = 100
    return result
def replace(value, old='sensor.effects_controller', new=RUNTIME):
    if isinstance(value, dict): return {k: replace(v, old, new) for k, v in value.items()}
    if isinstance(value, list): return [replace(v, old, new) for v in value]
    return value.replace(old, new) if isinstance(value, str) else value


def build(configs):
    configs = deepcopy(configs)
    result = {}
    # All existing consumers use the same synchronous runtime entity.
    for name, config in configs.items():
        changed = replace(config)
        if changed != config: result[name] = changed

    update = (ROOT/'store_update.jinja').read_text()
    commit = [
        var(accepted="{{ data.get('expected_revision') in [none,states.sensor.ls_overrides.last_updated.isoformat()] }}"),
        {'if':[cond('{{ not accepted }}')], 'then':[var(result={'accepted':False}),ret()]},
        var(before="{{ state_attr('sensor.ls_overrides','overrides') or {} }}",
            stamp='{{ now().isoformat() }}',
            trigger="{{ {'event':{'data':data,'context':{'user_id':data.get('who')}}} }}"),
        var(attributes=update),
        var(pending="{{ state_attr('sensor.ls_overrides','pending_rooms') or {} }}",
            affected="""{% set n=namespace(rooms=[]) %}
{% if data.get('area') %}{% set n.rooms=n.rooms+[data.area] %}{% endif %}
{% for record in data.get('records',[]) %}
 {% set previous=before.get(record.get('key',record.kind~':'~record.get('source',record.target)),{}) %}
 {% for item in [previous,record] if item.get('scope')=='room' %}{% set n.rooms=n.rooms+[item.target] %}{% endfor %}
{% endfor %}{{ n.rooms|unique|list }}""",
            full="{{ data.get('via')!='remote' or data.get('op')=='render_request' or data.get('op')=='clear' or data.get('op')=='clear_all' or data.get('records',[])|selectattr('kind','eq','mode')|list|count>0 }}"),
        var(attributes="""{% set n=namespace(pending=pending) %}
{% for room in affected %}{% set n.pending=dict(n.pending,**{room:stamp}) %}{% endfor %}
{% set p={'pending_rooms':n.pending,'last_request':stamp,'received_at':data.get('received_at',as_timestamp(now()))} %}
{% if full %}
 {% set old=state_attr('sensor.ls_overrides','full_version') %}
 {% set unhandled=old!=(state_attr('sensor.ls_effects_runtime','handled_full') or none) %}
 {% set previous_lights=(state_attr('sensor.ls_overrides','full_lights') or []) if unhandled else [] %}
 {% set previous_reason=state_attr('sensor.ls_overrides','full_reason') if unhandled else none %}
 {% set reason=data.get('reason','remote' if data.get('via')=='remote' else 'config') %}
 {% set reason='config' if reason=='tick' and previous_reason and previous_reason!='tick' else reason %}
 {% set p=dict(p,full_version=stamp,full_reason=reason,full_lights=(previous_lights+data.get('lights',[]))|unique|list) %}
{% endif %}{{ dict(attributes,**p) }}"""),
        {'action':'variable.update_sensor','target':{'entity_id':'sensor.ls_overrides'},
         'data':{'value':'{{ stamp }}','attributes':'{{ attributes }}','replace_attributes':False}},
        {'action':'script.turn_on','target':{'entity_id':'script.ls_render'}},
        var(result="{{ {'accepted':true,'revision':states.sensor.ls_overrides.last_updated.isoformat(),'committed_at':as_timestamp(now())} }}"),ret(),
    ]
    result['ls_commit'] = script('Lighting · Commit Input',commit,['data'],mode='queued')
    writer = deepcopy(configs['automation_lighting_schedule_override_store_writer'])
    writer['actions'] = [call('ls_commit',{'data':'{{ dict(trigger.event.data,who=trigger.event.data.get("who") or trigger.event.context.user_id) }}'})]
    writer['description'] = 'Event adapter. All mutation/CAS checks and render scheduling belong to the synchronous queued ls_commit script.'
    result['automation_lighting_schedule_override_store_writer'] = writer

    # The remote calculator remains pure and is reused for CAS retries and dry calls.
    remote = deepcopy(configs['ls_remote_command'])
    calculate = remote['sequence'][:4]
    calculate[0]['variables']['input_revision'] = '{{ states.sensor.ls_overrides.last_updated.isoformat() }}'
    fallback = calculate[3]['then']
    for branch in fallback:
        for action in branch.get('then',[]):
            if action.get('action') == 'script.ls_plan':
                action['action'] = 'script.ls_room_plan'
                action['data'] = {'room':'{{ room }}','overrides':'{{ overrides }}',
                                  'cache':"{{ state_attr('sensor.ls_cache_'~room,'cache') or {} }}",'reason':'remote'}
    # Effects are a small immutable catalogue; avoid a script round trip on arrows.
    catalog = configs['effects_catalog']['sequence'][0]['variables']['result']
    for branch in fallback:
        for index, action in enumerate(branch.get('then',[])):
            if action.get('action') == 'script.effects_catalog':
                branch['then'][index] = var(catalog=catalog)
    calculate += [var(result="{{ dict(result,input_revision=input_revision,received_at=stamp,request_id=request_id) }}"),ret()]
    result['ls_remote_plan'] = script('Lighting · Pure Remote Input',calculate,['source','area','command'])
    run_remote = [
        {'if':[cond('{{ dry_run|default(false) }}')],'then':[
            call('ls_remote_plan',{'source':'{{ source }}','area':'{{ area }}','command':'{{ command }}'},'result'),ret()]},
        {'repeat':{'sequence':[
            call('ls_remote_plan',{'source':'{{ source }}','area':'{{ area }}','command':'{{ command }}'},'result'),
            {'if':[cond("{{ result.op=='noop' }}")],'then':[var(committed={'accepted':True})], 'else':[
                call('ls_commit',{'data':"{{ dict(result,expected_revision=result.input_revision,area=area,via='remote',source=source) }}"},'committed')
            ]},
        ],'until':[cond('{{ committed.accepted }}')]}},
        {'if':[cond("{{ result.op=='power' }}")], 'then':[
            {'action':'{{ "homeassistant.turn_on" if result.on else "homeassistant.turn_off" }}','target':{'entity_id':'{{ result.targets }}'}},
            # Power reports can arrive after the first render. Explicit lamp-on
            # work is retained, and no kitchen-specific sleep is needed.
            {'if':[cond('{{ result.on }}')], 'then':[call('ls_apply',{'reason':'lamp_on','lights':'{{ result.targets }}'})]},
        ]},
    ]
    result['ls_remote_command'] = script('Lighting · Room Remote Input',run_remote,['source','area','command','dry_run'],mode='queued')

    assign = replace(configs['effects_assign'])
    for branch in assign['sequence']:
        if 'then' not in branch: continue
        converted=[]
        for action in branch['then']:
            if 'wait_template' in action: continue
            if action.get('action')=='script.turn_off' and action.get('target',{}).get('entity_id')=='script.effects_engine':
                action={'if':[cond('{{ assignments|count==0 }}')],'then':[action]}
            if action.get('action')=='mqtt.publish' and action['data']['topic']=='house/v1/effects/controller':
                action={'action':'variable.update_sensor','target':{'entity_id':RUNTIME},'data':{
                    'value':'{{ generation }}','replace_attributes':False,'attributes':"""
{% set applied=state_attr('sensor.ls_effects_runtime','applied') %}
{% set applied=state_attr('sensor.ls_effects_runtime','targets') or {} if applied is none else applied %}
{% set applied=dict(applied.items()|rejectattr(0,'in',invalidate|default([]))|list) %}
{{ {'targets':targets,'assignments':assignments,'applied':applied,'revision':revision,'generation':generation,'plan_order':plan_order}|to_json|from_json }}"""}}
            converted.append(action)
        branch['then']=converted
    assign['fields'].pop('gradients',None)
    result['effects_assign']=assign

    dispatch=replace(configs['ls_dispatch'])
    seq=dispatch['sequence']
    # Emit the first effect sample as part of the interactive change; later
    # animation samples belong exclusively to the paced manager.
    seq[4]['variables']['ordinary'] = """{% set n=namespace(t={}) %}
{% for L,t in lamp_targets.items() if is_state(L,'on') and (L in requested or baseline.targets[L].get('send',true))
 and (L in requested or (L in previous_effects and L not in resolved.assignments) or t!=previous.get(L)) %}
 {% set n.t=dict(n.t,**{L:t}) %}
{% endfor %}{{ n.t }}"""
    seq[5]['data'].pop('gradients',None)
    seq[6]['data']['transition_cap']="{{ 0.5 if plan.get('remote',false) or plan.get('remote_rooms',[]) else none }}"
    seq[6]['data']['transition_rooms']="{{ plan.get('remote_rooms',[]) if not plan.get('remote',false) else none }}"
    seq[9]['then'][0] = {'action':'variable.update_sensor','target':{'entity_id':RUNTIME},'data':{
        'value':'{{ assigned.generation }}','replace_attributes':False,
        'attributes':"{% set prior=state_attr('sensor.ls_effects_runtime','applied') or {} %}{{ {'applied':dict(prior|to_json|from_json,**ordinary)} }}"}}
    seq[10]['repeat']['for_each']='{{ plan.switches.keys()|list }}'
    seq += [var(result="{{ {'completed':emission.completed and revision==states.sensor.ls_overrides.last_updated.isoformat() and assigned.generation==state_attr('sensor.ls_effects_runtime','generation'),'published_at':emission.get('published_at',[])} }}"),ret()]
    dispatch['description']='Serialize current output; commit runtime directly and preserve invalidated applied entries until emission completes. No MQTT echo wait or artificial output pacing.'
    result['ls_dispatch']=dispatch
    frame=deepcopy(configs['effects_frame_plan'])
    frame['fields']['transition_rooms']={'selector':{'object':{}}}
    for step in frame['sequence'][1]['repeat']['sequence']:
        if 'payload' in step.get('variables',{}) and 'transition_cap' in str(step['variables']['payload']):
            step['variables']['payload']=step['variables']['payload'].replace(
                'if transition_cap|default(none) is number else transition',
                'if transition_cap|default(none) is number and (transition_rooms|default(none) is not sequence or target.area in transition_rooms) else transition')
    result['effects_frame_plan']=frame

    full_plan=replace(configs['ls_plan'])
    full_plan['sequence'][4]['data']['cached']="{% set n=namespace(g={}) %}{% for room in baseline.targets.values()|map(attribute='area')|unique|list %}{% set cache=state_attr('sensor.ls_cache_'~room,'cache') or {} %}{% set n.g=dict(n.g,**cache.get('gradients',{})) %}{% endfor %}{{ n.g }}"
    result['ls_plan']=full_plan

    render=[
        var(started_at='{{ as_timestamp(now()) }}',revision='{{ states.sensor.ls_overrides.last_updated.isoformat() }}',
            received_at="{{ state_attr('sensor.ls_overrides','received_at') }}",request_id="{{ state_attr('sensor.ls_overrides','last_request') }}",
            pending="{{ state_attr('sensor.ls_overrides','pending_rooms') or {} }}",
            handled="{{ state_attr('sensor.ls_effects_runtime','handled_rooms') or {} }}",
            full_version="{{ state_attr('sensor.ls_overrides','full_version') }}",
            full="{{ full_version and full_version!=state_attr('sensor.ls_effects_runtime','handled_full') }}"),
        var(rooms="{% set n=namespace(rooms=[]) %}{% for room,version in pending.items() if version!=handled.get(room) %}{% set n.rooms=n.rooms+[room] %}{% endfor %}{{ n.rooms }}"),
        cond('{{ full or rooms|count>0 }}'),
        {'choose':[{'conditions':[cond('{{ full }}')],'sequence':[
            call('ls_plan',{'reason':"{{ state_attr('sensor.ls_overrides','full_reason') or 'config' }}"},'planned'),
            var(plan="{{ dict(planned.plan,remote_rooms=rooms) }}",lights="{{ state_attr('sensor.ls_overrides','full_lights') or [] }}"),
            var(cache_updates="""{% set n=namespace(updates={}) %}
{% for room in plan.base.values()|map(attribute='area')|unique|list if room %}
 {% set old=state_attr('sensor.ls_cache_'~room,'cache') or {} %}{% set g=namespace(values={}) %}
 {% for key,t in plan.base.items() if t.area==room and key in plan.gradients %}{% set g.values=dict(g.values,**{key:plan.gradients[key]}) %}{% endfor %}
 {% if g.values!=old.get('gradients') %}{% set n.updates=dict(n.updates,**{room:dict(old,gradients=g.values)}) %}{% endif %}
{% endfor %}{{ n.updates }}"""),
        ]}], 'default':[
            var(merged_targets="{{ state_attr('sensor.ls_effects_runtime','targets') or {} }}",
                merged_assignments="{{ state_attr('sensor.ls_effects_runtime','assignments') or {} }}",
                bases={},switches={},mirrors=[],stale=[],cache_updates={},lights=[]),
            {'repeat':{'for_each':'{{ rooms }}','sequence':[
                var(room='{{ repeat.item }}'),
                call('ls_room_plan',{'room':'{{ room }}','overrides':"{{ state_attr('sensor.ls_overrides','overrides') or {} }}",'cache':"{{ state_attr('sensor.ls_cache_'~room,'cache') or {} }}",'reason':'remote'},'planned'),
                var(merged_targets="{% set keep=namespace(t={}) %}{% for key,t in merged_targets.items() if t.area!=room %}{% set keep.t=dict(keep.t,**{key:t}) %}{% endfor %}{{ dict(keep.t,**planned.plan.resolved.targets) }}",
                    merged_assignments="{% set keep=namespace(t={}) %}{% for key,t in merged_assignments.items() if t.area!=room %}{% set keep.t=dict(keep.t,**{key:t}) %}{% endfor %}{{ dict(keep.t,**planned.plan.resolved.assignments) }}",
                    bases='{{ dict(bases,**planned.plan.base) }}',switches='{{ dict(switches,**planned.plan.switches) }}',
                    mirrors='{{ mirrors+planned.plan.mirror }}',stale='{{ (stale+planned.plan.stale_keys)|unique|list }}',
                    cache_updates="{{ dict(cache_updates,**{room:planned.cache_update}) if planned.cache_update is mapping else cache_updates }}"),
            ]}},
            var(plan="{{ {'base':bases,'resolved':{'targets':merged_targets,'assignments':merged_assignments},'switches':switches,'mirror':mirrors,'stale_keys':stale,'revision':revision,'plan_order':started_at,'remote':false,'remote_rooms':rooms,'sara_mirror':planned.plan.sara_mirror} }}"),
        ]},
        cond('{{ revision==states.sensor.ls_overrides.last_updated.isoformat() }}'),
        # Persist derived caches only when present; a future room without a cache
        # helper remains correct through its pure local fallback.
        {'repeat':{'for_each':"{{ (cache_updates|default({})).items()|list }}",'sequence':[
            {'if':[cond("{{ has_value('sensor.ls_cache_'~repeat.item[0]) }}")],'then':[
                {'action':'variable.update_sensor','target':{'entity_id':"{{ 'sensor.ls_cache_'~repeat.item[0] }}"},'data':{'value':'{{ now().isoformat() }}','attributes':"{{ {'cache':repeat.item[1]} }}",'replace_attributes':False}}
            ]},
        ]}},
        # Only selected room bases enter output filtering; retained other-room
        # runtime targets are included for ownership, not as new desired sends.
        var(plan="{% set selected=plan.base.keys()|list %}{{ dict(plan,output_targets=selected) if not full else plan }}",planned_at='{{ as_timestamp(now()) }}'),
        call('ls_dispatch',{'plan':'{{ plan }}','lights':'{{ lights }}'},'emission'),
        cond("{{ emission is mapping and emission.get('completed',false) and revision==states.sensor.ls_overrides.last_updated.isoformat() }}"),
        {'action':'variable.update_sensor','target':{'entity_id':RUNTIME},'data':{
            'value':'{{ now().isoformat() }}','replace_attributes':False,
            'attributes':"{{ {'handled_rooms':pending,'handled_full':full_version if full else state_attr('sensor.ls_effects_runtime','handled_full'),'last_latency':{'request_id':request_id,'received_at':received_at,'started_at':started_at,'planned_at':planned_at,'published_at':emission.get('published_at',[]),'completed_at':as_timestamp(now()),'rooms':rooms,'full':full|bool}} }}"}},
    ]
    result['ls_render']=script('Lighting · Render Latest Pending State',render,mode='queued')
    # Runtime contains all rooms, but a local plan only evaluates its own output.
    seq[3]['variables']['lamp_targets']=seq[3]['variables']['lamp_targets'].replace(
        'if not t.is_room and', "if not t.is_room and (not plan.get('output_targets') or L in plan.output_targets) and")
    seq[3]['variables']['lamp_targets']=seq[3]['variables']['lamp_targets'].replace(
        ' and (not requested or L in requested)', '')
    apply=deepcopy(configs['ls_apply'])
    apply['sequence']=[apply['sequence'][0],
        {'if':[cond('{{ dry_run|default(false) }}')],'then':[
            call('ls_plan',{'reason':"{{ reason|default('config') }}",'test_now':'{{ test_now|default(none) }}','test_overrides':'{{ test_overrides|default(none) }}'},'result'),ret()]},
        call('ls_commit',{'data':"{{ {'op':'render_request','via':'render_request','reason':reason|default('config'),'lights':lights|default([])} }}"}),
    ]
    result['ls_apply']=apply
    scheduler=deepcopy(configs['automation_lighting_schedule_engine'])
    scheduler['triggers']=[t for t in scheduler['triggers'] if t.get('entity_id')!='sensor.ls_overrides']
    scheduler['actions'][0]['default'][0]['data']['reason']='{{ trigger.id }}'
    # Group planning handles lamp-on batching; no fixed kitchen latency.
    scheduler['actions'][0]['choose'][0]['sequence']=[call('ls_apply',{'reason':'lamp_on','lights':'{{ [trigger.entity_id] }}'})]
    scheduler['description']='Clock/profile/start/lamp-on inputs request durable full work. Override commits schedule rendering directly, without a state-event echo.'
    result['automation_lighting_schedule_engine']=scheduler
    result['automation_lighting_output_recovery']={
        'id':'lighting_output_recovery','alias':'Lighting · Recover Pending Output','mode':'single',
        'triggers':[{'trigger':'time_pattern','seconds':'/5'},{'trigger':'state','entity_id':'binary_sensor.zigbee2mqtt_bridge_connection_state','to':'on'},{'trigger':'homeassistant','event':'start'}],
        'conditions':[{'condition':'state','entity_id':'binary_sensor.zigbee2mqtt_bridge_connection_state','state':'on'},cond("{% set n=namespace(dirty=(state_attr('sensor.ls_overrides','full_version')!=state_attr('sensor.ls_effects_runtime','handled_full'))) %}{% for room,v in (state_attr('sensor.ls_overrides','pending_rooms') or {}).items() if v!=(state_attr('sensor.ls_effects_runtime','handled_rooms') or {}).get(room) %}{% set n.dirty=true %}{% endfor %}{{ n.dirty }}")],
        'actions':[{'action':'script.turn_on','target':{'entity_id':'script.ls_render'}}],
    }
    return result
