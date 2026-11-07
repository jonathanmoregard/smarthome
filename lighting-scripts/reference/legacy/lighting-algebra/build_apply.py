import json,sys
from pathlib import Path
sys.path.insert(0,'/tmp/lighting-algebra')
from build import script,variables,call,ret,save,old,ROOT,template

save('ls_switch_plan',script('Lighting · Switch range plan',[variables(result=template('switch_plan')),ret()],['targets','ranges','defaults']))

planning=[
 variables(overrides="{{ test_overrides if test_overrides|default(none) is mapping else state_attr('sensor.ls_overrides','overrides') or {} }}",revision="{{ states.sensor.ls_overrides.last_updated.isoformat() }}",plan_order='{{ as_timestamp(now()) }}'),
 call('ls_base',{'overrides':'{{ overrides }}','test_now':'{{ test_now|default(none) }}','reason':"{{ reason|default('config') }}",'room_only':"{{ room|default('') }}"},'baseline'),
 call('effects_catalog',response='catalog'),
 variables(active="{{ dict(overrides.items()|rejectattr(0,'in',baseline.schedule.stale_keys)|list) }}",warm_end="{{ state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0] }}"),
 call('effects_gradient_plan',{'base':'{{ baseline.targets }}','warm_end':'{{ warm_end }}','cached':"{{ state_attr('sensor.effects_controller','gradients') or {} }}"},'compiled'),
 call('effects_resolve',{'base':'{{ baseline.targets }}','overrides':'{{ active }}','catalog':'{{ catalog }}','sara':"{{ 'mode:sara' in active }}",'private':"{{ label_areas('private_room') }}",'power':"{{ state_attr('sensor.ls_overrides','power') or {} }}",'warm_end':'{{ warm_end }}','gradients':'{{ compiled.gradients }}'},'resolved'),
 call('ls_switch_plan',{'targets':'{{ resolved.targets }}','ranges':"{{ state_attr('sensor.ls_overrides','switch_ranges') or {} }}",'defaults':"{{ state_attr('sensor.ls_overrides','range_defaults') or {'bright':[90,100],'cosy':[30,60]} }}"},'switch_plan'),
 variables(plan="{% set wanted='on' if 'mode:sara' in active else 'off' %}{{ dict(baseline.schedule,base=baseline.targets,resolved=resolved,gradients=compiled.gradients,switches=switch_plan.switches,revision=revision,plan_order=plan_order,remote=(reason|default('config')=='remote'),sara_mirror=(wanted if states('input_boolean.ls_sara_mode_mirror')!=wanted else none)) }}"),
 variables(result="{{ {'plan':plan} }}"),ret()
]
save('ls_plan',script('Lighting · Pure Plan',planning,['room','reason','test_now','test_overrides']))

dispatch=[
 variables(revision='{{ plan.revision }}',resolved='{{ plan.resolved }}',baseline="{{ {'targets':plan.base} }}"),
 {'condition':'template','value_template':"{{ revision==states.sensor.ls_overrides.last_updated.isoformat() and plan.plan_order>=(state_attr('sensor.effects_controller','plan_order') or 0) }}"},
 call('effects_catalog',response='catalog'),
 variables(previous="{% set applied=state_attr('sensor.effects_controller','applied') %}{{ (state_attr('sensor.effects_controller','targets') or {}) if applied is none else applied }}",previous_effects="{{ state_attr('sensor.effects_controller','assignments') or {} }}",requested="{{ (lights if lights is list else [lights]) if lights|default(none) else [] }}",lamp_targets="{% set n=namespace(t={}) %}{% for L,t in resolved.targets.items() if not t.is_room and (not requested or L in requested) %}{% set n.t=dict(n.t,**{L:t}) %}{% endfor %}{{ n.t }}"),
 variables(ordinary="{% set n=namespace(t={}) %}{% for L,t in lamp_targets.items() if (L not in resolved.assignments or not t.on) and is_state(L,'on') and baseline.targets[L].get('send',true) and (L in requested or L in previous_effects or t!=previous.get(L)) %}{% set n.t=dict(n.t,**{L:t}) %}{% endfor %}{{ n.t }}"),
 call('effects_assign',{'targets':'{{ resolved.targets }}','assignments':'{{ resolved.assignments }}','revision':'{{ revision }}','invalidate':'{{ ordinary.keys()|list }}','plan_order':'{{ plan.plan_order }}','gradients':"{{ plan.get('gradients',state_attr('sensor.effects_controller','gradients') or {}) }}"},'assigned'),
 call('effects_frame_plan',{'targets':'{{ ordinary }}','catalog':'{{ catalog }}','timestamp':'{{ as_timestamp(now()) }}','transition_cap':"{{ 0.5 if plan.get('remote',false) else none }}"},'batch'),
 call('effects_emit',{'commands':'{{ batch.commands }}','revision':'{{ revision }}','generation':'{{ assigned.generation }}'},'emission'),
 {'condition':'template','value_template':"{{ revision==states.sensor.ls_overrides.last_updated.isoformat() and assigned.generation==state_attr('sensor.effects_controller','generation') }}"},
 {'if':[{'condition':'template','value_template':'{{ ordinary|count>0 and emission.completed }}'}],'then':[
  {'action':'mqtt.publish','data':{'topic':'house/v1/effects/controller','qos':0,'retain':True,'payload':"{% set prior=state_attr('sensor.effects_controller','applied') or {} %}{% set applied=dict(prior|to_json|from_json,**ordinary) %}{{ {'targets':resolved.targets,'assignments':resolved.assignments,'applied':applied,'revision':revision,'generation':assigned.generation,'plan_order':plan.plan_order,'gradients':plan.get('gradients',state_attr('sensor.effects_controller','gradients') or {})}|to_json }}"}}
 ]},
 {'repeat':{'for_each':"{{ plan.switches.keys()|select('in',requested)|list if requested else plan.switches.keys()|list }}",'sequence':[
  variables(L='{{ repeat.item }}',switch='{{ plan.switches[L] }}'),
  {'if':[{'condition':'template','value_template':"{{ revision==states.sensor.ls_overrides.last_updated.isoformat() and not is_state(L,'on' if switch.on else 'off') }}"}],'then':[{'action':'{{ "homeassistant.turn_on" if switch.on else "homeassistant.turn_off" }}','target':{'entity_id':'{{ L }}'}}]}
 ]}},
]
# Only the output layer queues. Old plans are discarded before touching the controller.
mirrors=old('ls_apply')['sequence'][6:9]
mirrors[-1]['then'][0]['event_data']['expected_revision']='{{ revision }}'
dispatch += [{'condition':'template','value_template':"{{ revision==states.sensor.ls_overrides.last_updated.isoformat() }}"}]+mirrors
save('ls_dispatch',script('Lighting · Apply Changed Targets',dispatch,['plan','lights'],mode='queued'))

seq=[
 {'condition':'template','value_template':"{{ dry_run|default(false) or ((test_now is not defined or not test_now) and test_overrides is not defined and not (force_all|default(false))) }}"},
 call('ls_plan',{'reason':"{{ reason|default('config') }}",'test_now':'{{ test_now|default(none) }}','test_overrides':'{{ test_overrides|default(none) }}'},'result'),
 {'if':[{'condition':'template','value_template':'{{ dry_run|default(false) }}'}],'then':[ret()]},
 call('ls_dispatch',{'plan':'{{ result.plan }}','lights':'{{ lights|default([]) }}'})
]
(ROOT/'apply_sequence.json').write_text(json.dumps(seq,indent=2)+'\n')
apply=old('ls_apply');apply['sequence']=seq
apply['mode']='parallel';apply['max']=30
apply['description']='Plan independently of output. Dry runs return immediately; live plans enter the version-checked dispatcher, which sends only changed lamps. Remote/UI reads use the pure planner directly.'
save('ls_apply',apply)
engine=old('automation_lighting_schedule_engine')
for trigger in engine['triggers']:
 if trigger.get('entity_id')=='sensor.ls_overrides':trigger.pop('attribute',None)
engine['actions'][0]['default'][0]['data']['reason']="{{ 'remote' if trigger.get('entity_id')=='sensor.ls_overrides' and trigger.to_state.attributes.get('last_via')=='remote' else trigger.id }}"
save('automation_lighting_schedule_engine',engine)
print('Integrated apply sequence built')
