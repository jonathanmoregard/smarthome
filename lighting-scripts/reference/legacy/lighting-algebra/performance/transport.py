"""Pure builder transform: immediate transport, animation-owned admission budget.

transform(configs, controller_entity=...) returns only the two replacement raw
HA script configs. It never mutates inputs, reads HA, or writes configuration.
Frame/group planning stays in the existing pure planner. One current command is
admitted after each 200 ms animation wait; no old frame queue is retained.
"""
from copy import deepcopy


def _replace(value, controller):
    if isinstance(value, dict):
        return {key: _replace(item, controller) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace(item, controller) for item in value]
    if isinstance(value, str):
        return value.replace('sensor.effects_controller', controller).replace('sensor.ls_effects_runtime', controller)
    return value


def _without_delays(value):
    if isinstance(value, dict):
        return {key: _without_delays(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_without_delays(item) for item in value
                if not (isinstance(item, dict) and 'delay' in item)]
    return value


def transform(configs, controller_entity='sensor.ls_effects_runtime'):
    """Return effects_emit/effects_engine replacements with preserved safety guards."""
    emitter = _without_delays(_replace(deepcopy(configs['effects_emit']), controller_entity))
    emitter['alias'] = 'Effects · Immediate guarded output'
    emitter['description'] = (
        'Serialize immediate current commands with per-command revision, generation, '
        'power, endpoint and bridge checks. Animation admission/pacing belongs to '
        'the effect manager; interactive and native-stop batches never sleep here.')
    emitter.setdefault('fields', {})['effect_targets'] = {
        'default': {}, 'selector': {'object': {}},
        'description': 'Optional animation ownership snapshot; empty for ordinary output.',
    }
    # Retain the original emitter conditions and augment only the animation path.
    steps = emitter['sequence'][1]['repeat']['sequence']
    assert 'allowed' in steps[0].get('variables', {}), 'unexpected emitter structure'
    steps.insert(1, {'variables': {'allowed': """
{% set n=namespace(ok=allowed) %}
{% if effect_targets|default({}) %}
 {% set current=state_attr('CONTROLLER','assignments') or {} %}
 {% for owner in command.owners %}
  {% if owner not in effect_targets or current.get(owner)!=effect_targets.get(owner) %}{% set n.ok=false %}{% endif %}
 {% endfor %}
{% endif %}
{{ n.ok }}
""".replace('CONTROLLER', controller_entity)}})

    active = """{{
(state_attr('CONTROLLER','assignments') or {})|count>0
}}""".replace('CONTROLLER', controller_entity)
    conditions = [
        {'condition':'template','value_template':active},
        {'condition':'state','entity_id':'binary_sensor.zigbee2mqtt_bridge_connection_state','state':'on'},
    ]
    engine = deepcopy(configs['effects_engine'])
    engine.update(alias='Effects · Fair animation manager', mode='single', max_exceeded='silent')
    engine.pop('max', None)
    engine['description'] = (
        'Animation-only 200 ms admissions. After each wait, snapshot current ownership '
        'and render fresh compatible groups; send at most one command, then discard '
        'the unsent frame. Least recently served physical members rotate fairly, '
        'with deterministic topic ties. No catch-up burst or sender-held sleep.')
    engine['sequence'] = [
        {'action':'script.effects_catalog','response_variable':'catalog'},
        {'variables':{
            'served':{}, 'admission':0,
        }},
        {'repeat':{'while':conditions,'sequence':[
            # Keep rotation across ordinary controller updates. Revision mismatch
            # temporarily suspends admissions, never terminates this manager.
            {'delay':{'milliseconds':200}},
            {'if':deepcopy(conditions)+[{'condition':'template','value_template':
                "{{ state_attr('CONTROLLER','revision')==states.sensor.ls_overrides.last_updated.isoformat() }}".replace('CONTROLLER',controller_entity),
            }],'then':[
            {'variables':{
                'revision':"{{ state_attr('CONTROLLER','revision') }}".replace('CONTROLLER',controller_entity),
                'generation':"{{ state_attr('CONTROLLER','generation') }}".replace('CONTROLLER',controller_entity),
                'targets':"""
{% set n=namespace(targets={}) %}
{% set power=state_attr('sensor.ls_overrides','power') or {} %}
{% for lamp,target in (state_attr('CONTROLLER','assignments') or {}).items()
   if lamp in catalog.members and is_state(lamp,'on') and target.on and power.get(area_id(lamp),true) %}
 {% set n.targets=dict(n.targets,**{lamp:target}) %}
{% endfor %}{{ n.targets|to_json|from_json }}
""".replace('CONTROLLER',controller_entity),
            }},
            {'action':'script.effects_frame_plan','data':{
                'targets':'{{ targets }}','catalog':'{{ catalog }}','timestamp':'{{ as_timestamp(now()) }}',
            },'response_variable':'batch'},
            {'variables':{'chosen':"""
{% set n=namespace(command=none,age=none) %}
{% for command in batch.commands|sort(attribute='topic') %}
 {% set age=namespace(value=-1) %}
 {% for member in command.members %}{% set age.value=[age.value,served.get(member,-1)]|max %}{% endfor %}
 {% if n.age is none or age.value<n.age %}{% set n.command=command %}{% set n.age=age.value %}{% endif %}
{% endfor %}{{ n.command|to_json|from_json }}
"""}},
            {'if':[{'condition':'template','value_template':'{{ chosen is mapping }}'}],'then':[
                {'action':'script.effects_emit','data':{
                    'commands':'{{ [chosen] }}','revision':'{{ revision }}','generation':'{{ generation }}',
                    'effect_targets':'{{ targets }}',
                },'response_variable':'emission'},
                {'variables':{'admission':'{{ admission+1 }}','served':"""
{% set n=namespace(served=served) %}
{% for member in chosen.members %}{% set n.served=dict(n.served,**{member:admission}) %}{% endfor %}
{{ n.served }}
"""}},
            ]},
            ]},
        ]}},
    ]
    return {'effects_emit':emitter,'effects_engine':engine}
