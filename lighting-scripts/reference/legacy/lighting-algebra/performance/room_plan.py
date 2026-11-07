"""Build pure room-local HA planner scripts without importing shared builders.

build_scripts(configs=None) returns {script_id: raw_config}. Required inputs are
existing ls_base/effects_catalog configs; omitted inputs are read from candidate/.
No files, HA state, events or services are mutated by this module.

ls_room_plan(room, overrides={}, cache={}, reason='remote', test_now=None,
             power=None, ranges=None, defaults=None) returns
{plan: existing_plan_contract, cache_update: mapping_or_none, cache_hit: bool}.
The caller owns cache persistence and merges room output into runtime state.
Cache entries are internal generated data. Pass sensor.ls_cache_<room>'s `cache`
attribute explicitly. An invalid cache falls back ONLY to this room's baseline.
Active schedule/wake fades are deliberately uncached to preserve exact interpolation.
Shared Sara/house records are never globally cleared by this room-local planner.
"""
import copy
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build_scripts(configs=None):
    configs = configs or {}
    def config(name):
        value = configs.get(name)
        if value is None:
            value = json.loads((ROOT / 'candidate' / (name + '.json')).read_text())
        return copy.deepcopy(value.get('config', value))
    original = config('ls_base')
    catalog = config('effects_catalog')['sequence'][0]['variables']['result']
    source = Path(__file__).read_text() + ''.join(p.read_text() for p in sorted((ROOT / 'performance').glob('room_*.jinja')))
    version = hashlib.sha256((json.dumps([original, catalog, config('effects_gradient_plan')], sort_keys=True)+source).encode()).hexdigest()
    local = copy.deepcopy(original)
    local['alias'] = 'Lighting · Room Scheduled Base'
    variables = local['sequence'][0]['variables']
    variables['room_only'] = '{{ room }}'
    variables['lights'] = "{{ (label_entities('house_schedule')+(label_devices('house_schedule')|map('device_entities')|sum(start=[])))|select('match','light\\.')|select('in',area_entities(room))|unique|list }}"
    # Empty rooms must not accidentally remove the original only-filter.
    variables['plan'] = variables['plan'].replace(
        "if (not only or L in only) -%}",
        "if area_id(L)==room and (not only or L in only) -%}")
    assert "if area_id(L)==room and" in variables['plan']
    local['fields']['room'] = {'required': True, 'selector': {'text': {}}}

    def template(name):
        return (ROOT / 'performance' / (name + '.jinja')).read_text()
    def var(**values): return {'variables': values}
    def call(name, data, response): return {'action': 'script.' + name, 'data': data, 'response_variable': response}
    fields = {name: {'selector': {'object': {}}} for name in ['room','overrides','cache','reason','test_now','power','ranges','defaults']}
    for name, default in [('overrides',{}),('cache',{}),('reason','remote')]:fields[name]['default']=default
    fields['room']['required'] = True
    sequence = [
        var(cache_version=version, at="{{ as_timestamp(test_now) if test_now|default(none) else as_timestamp(now()) }}",
            revision="{{ states.sensor.ls_overrides.last_updated.isoformat() }}",plan_order='{{ as_timestamp(now()) }}',
            warm_end="{{ (state_attr('light.candle_test_rgb_warm_end','rgb_color') or [255,126,0])|list }}",
            cache=template('room_cache_guard')),
        var(dependencies=template('room_dependencies')),
        var(period_boundary="{{ cache.get('baseline',{}).get('schedule',{}).get('schedule_details',{}).get(room,{}).get('last_fs',0) }}"),
        var(periods=template('room_period_signature')),
        var(cache_hit="{{ cache.get('version')==cache_version and cache.get('room')==room and cache.get('dependencies')==dependencies and cache.get('periods')==periods and cache.get('valid_from',1e20)<=at<cache.get('valid_until',0) and cache.get('baseline') is mapping and cache.get('gradients') is mapping and cache.get('catalog') is mapping }}"),
        {'if':[{'condition':'template','value_template':'{{ cache_hit }}'}],
         'then':[var(baseline='{{ cache.baseline }}',gradients='{{ cache.gradients }}',catalog='{{ cache.catalog }}',cache_update=None)],
         'else':[
             call('ls_room_base',{'room':'{{ room }}','overrides':'{{ overrides }}','test_now':'{{ test_now|default(none) }}','reason':'{{ reason }}'},'baseline'),
             var(catalog_config=catalog),var(catalog=template('room_catalog')),
             call('effects_gradient_plan',{'base':'{{ baseline.targets }}','warm_end':'{{ warm_end }}','cached':"{{ cache.get('gradients',{}) }}"},'compiled'),
             var(gradients='{{ compiled.gradients }}',period_boundary="{{ baseline.schedule.schedule_details.get(room,{}).get('last_fs',0) }}"),
             var(periods=template('room_period_signature')),
             var(cache_update=template('room_cache_update')),
         ]},
        var(baseline=template('room_refresh')),
        var(active="{{ dict(overrides.items()|rejectattr(0,'in',baseline.schedule.stale_keys)|list) }}"),
        call('effects_resolve',{'base':'{{ baseline.targets }}','overrides':'{{ active }}','catalog':'{{ catalog }}',
             'sara':"{{ 'mode:sara' in active }}",'private':"{{ label_areas('private_room') }}",
             'power':"{{ power if power|default(none) is mapping else state_attr('sensor.ls_overrides','power') or {} }}",
             'warm_end':'{{ warm_end }}','gradients':'{{ gradients }}'},'resolved'),
        call('ls_switch_plan',{'targets':'{{ resolved.targets }}',
             'ranges':"{{ ranges if ranges|default(none) is mapping else state_attr('sensor.ls_overrides','switch_ranges') or {} }}",
             'defaults':"{{ defaults if defaults|default(none) is mapping else state_attr('sensor.ls_overrides','range_defaults') or {'bright':[90,100],'cosy':[30,60]} }}"},'switch_plan'),
        var(result="{% set wanted='on' if 'mode:sara' in active else 'off' %}{{ {'plan':dict(baseline.schedule,room=room,base=baseline.targets,resolved=resolved,gradients=gradients,catalog=catalog,switches=switch_plan.switches,revision=revision,plan_order=plan_order,remote=reason=='remote',sara_mirror=(wanted if states('input_boolean.ls_sara_mode_mirror')!=wanted else none)), 'cache_update':cache_update,'cache_hit':cache_hit}|to_json|from_json }}"),
        {'stop':'Return pure room plan','response_variable':'result'},
    ]
    return {'ls_room_base':local,'ls_room_plan':{'alias':'Lighting · Pure Room Plan','mode':'parallel','max':50,'fields':fields,'sequence':sequence}}
