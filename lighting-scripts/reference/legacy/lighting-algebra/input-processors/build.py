"""Build input-processor runtime scripts from the frozen, verified live baseline."""
import copy
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
BASE=ROOT.parent/'simple-effects/candidate'
CANDIDATE=ROOT/'candidate'
configs={p.stem:json.loads(p.read_text()) for p in BASE.glob('*.json')}

def replace_strings(value, fn):
    if isinstance(value,dict):return {k:replace_strings(v,fn) for k,v in value.items()}
    if isinstance(value,list):return [replace_strings(v,fn) for v in value]
    return fn(value) if isinstance(value,str) else value

catalog=configs['effects_catalog']['sequence'][0]['variables']['result']
processors={'Normal light':{'channels':['brightness','color'],'remote_adjustment':'gradient','animated':False}}
processors.update({name:{'channels':definition['channels'],'remote_adjustment':'ignore','animated':True}
                   for name,definition in catalog['effects'].items()})

def add_processors(value):
    if isinstance(value,dict):
        if 'effects' in value and 'members' in value:value['processors']=copy.deepcopy(processors)
        for v in list(value.values()):add_processors(v)
    elif isinstance(value,list):
        for v in value:add_processors(v)
for config in configs.values():add_processors(config)

# Time/preset selection is still input, consumed by the existing schedule planner.
def kinds(s):
    return s.replace("r.get('kind')=='channels'","r.get('kind') in ['channels','input']").replace("r.kind=='channels'","r.kind in ['channels','input']")
for name in ['ls_base','ls_room_base','ls_room_plan']:
    configs[name]=replace_strings(configs[name],kinds)
configs['ls_room_plan']=replace_strings(configs['ls_room_plan'],lambda s:s.replace(
    "{'effects':catalog_config.effects}","{'effects':catalog_config.effects,'processors':catalog_config.processors}"))
configs['ls_room_plan']['sequence'][0]['variables']['cache_version']+=':input-processors-v1'

remote=configs['ls_remote_plan']
old=remote['sequence']
stream=(ROOT/'input_stream.jinja').read_text()
old[0]['variables']['input_key']=stream+"\n{{ latest_remote_key(overrides,room)|from_json }}"
old[0]['variables']['input_record']="{{ overrides.get(input_key,{}) }}"
catalog_step=old[3]['then'][1]['then'][0]
remote['sequence']=[old[0],old[1],{'variables':{'needs_context':"""
{% set value=input_record.get('value',{}) %}
{{ command in ['left','right'] or (command in ['up','down'] and is_state('input_boolean.ls_ovr_next_block_on','on') and (value.get('remote_valid_until',0)<=stamp or value.get('remote_timing_revision')!=timing_revision)) }}
"""}},
 {'if':[{'condition':'template','value_template':'{{ needs_context }}'}],
  'then':[old[3]['then'][0]['then'][0]]},
 {'if':[{'condition':'template','value_template':"{{ command in ['toggle','left','right'] }}"}],
  'then':[catalog_step]},
 {'variables':{'result':(ROOT/'remote_input.jinja').read_text()}},old[-2],old[-1]]
remote['description']='Store compact button input in one stable room/source record; interpretation belongs to processors. No channel or colour calculation in the click path.'

resolve=(ROOT.parent/'core/resolve.jinja').read_text()
resolve=resolve.replace("{% set out=namespace(targets={}, assignments={}) %}\n{% for target,item in base|dictsort %}","""
{% set out=namespace(targets={},assignments={},inputs={},streams={},order=[]) %}
{% for target,item in base|dictsort if item.get('is_room',false) %}{% set out.order=out.order+[target] %}{% endfor %}
{% for target,item in base|dictsort if not item.get('is_room',false) %}{% set out.order=out.order+[target] %}{% endfor %}
{% for target in out.order %}{% set item=base[target] %}
""")
resolve=resolve.replace("{% set area=item.area %}","""
{% set area=item.area %}
{% if area not in out.streams %}{% set out.streams=dict(out.streams,**{area:latest_remote_key(overrides,area)|from_json}) %}{% endif %}
""")
resolve=resolve.replace("{% if applies %}","""
{% if record.get('scope')=='room' and (record.get('kind')=='input' or (record.get('kind')=='channels' and record.get('via')=='remote')) and key!=out.streams.get(area) %}{% set applies=false %}{% endif %}
{% if applies %}
""")
resolve=resolve.replace("{% if record.get('kind') == 'channels' and value is mapping and value.get('channels') is mapping %}","""
{% if record.get('kind') == 'input' and value is mapping %}
 {% set patch=value.get('legacy_channels',{}) %}
 {% for claim in input_claims(value,key,stamp)|from_json %}
  {% for channel in ['brightness','color'] if claim.kind=='input' or channel in effect_channels(claim.get('effect'))|from_json %}
   {% set n.candidates=dict(n.candidates,**{channel:n.candidates[channel]+[{'key':key,'updated':claim.updated,'source':claim,'baseline_only':false}]}) %}
  {% endfor %}
 {% endfor %}
{% elif record.get('kind') == 'channels' and value is mapping and value.get('channels') is mapping %}
""")
resolve=resolve.replace("{% set source=patch[channel] %}","""
{% set source=patch[channel] %}
{# Read compatibility for remote records written before this deployment. #}
{% if record.get('via')=='remote' and source is mapping and source.get('kind')=='scale' %}
 {% set source={'kind':'input','input':{'steps':0,'lower':-20,'upper':20,'legacy_position':source.position},'updated':source.get('updated',stamp)} %}
{% endif %}
""")
resolve=resolve.replace("namespace(valid=false,value=initial,selected={})","namespace(valid=false,ignore=false,value=initial,selected={})")
resolve=resolve.replace("{% elif source.get('kind') == 'scale' %}\n          {% set p=source.get('position') %}","""
{% elif source.get('kind') in ['scale','input'] %}
          {% set p=source.get('position') %}
          {% if source.kind=='input' %}
           {% set input=source.get('input',{}) %}
           {% set valid=namespace(ok=input is mapping and item.get('day') is mapping and item.get('cosy') is mapping) %}
           {% for field in ['steps','lower','upper'] %}
            {% set v=input.get(field) if input is mapping else none %}
            {% if v is not number or v is boolean or v!=v or v < -40 or v > 40 %}{% set valid.ok=false %}{% endif %}
           {% endfor %}
           {% if valid.ok and -20<=input.lower<=input.upper<=20 %}
            {% set ref=candidate.key~':'~candidate.updated %}
            {% set position=out.inputs.get(ref) %}
            {% if position is none %}
             {% set level=c.underlying if channel=='brightness' else n.underlying.get('brightness',item.brightness) %}
             {% set position={'position':normal_position(input,item,level)|from_json,'level':level} %}
             {% if is_room %}{% set out.inputs=dict(out.inputs,**{ref:position}) %}{% endif %}
            {% endif %}
            {% set p=position.position %}
            {% set processor=c.source.effect if c.source.kind=='effect' else 'Normal light' %}
            {% set strategy=catalog.get('processors',{}).get(processor,{}).get('remote_adjustment','gradient' if processor=='Normal light' else 'ignore') %}
            {% set check.ignore=strategy!='gradient' %}
           {% else %}{% set check.ignore=true %}{% endif %}
          {% endif %}
""")
resolve=resolve.replace("{% if p is number and p is not boolean and p > -1e20", "{% if not check.ignore and p is number and p is not boolean and p > -1e20")
resolve=resolve.replace("{% set check.valid=true %}{% set check.value=scaled[channel] %}","""
{% set check.valid=true %}{% set check.value=scaled[channel] %}
            {# A down input must never brighten a below-floor Night baseline. #}
            {% if source.kind=='input' and channel=='brightness' and input.get('last')=='down' and not input.get('has_up',false) and position.level<[76.5,item.cosy.brightness]|min and input.get('anchor','current')=='current' and input.steps<=0 %}
             {% set check.value=[c.underlying,check.value]|min %}
            {% endif %}
""")
resolve=resolve.replace("{% if candidate.baseline_only %}","{% if not check.ignore %}\n      {% if candidate.baseline_only %}")
resolve=resolve.replace("{% if not candidate.baseline_only %}{% set c.owner=candidate.key %}{% endif %}","{% if not candidate.baseline_only %}{% set c.owner=candidate.key %}{% endif %}\n      {% endif %}")
(ROOT/'resolve.jinja').write_text(resolve)
normal=(ROOT/'normal_input.jinja').read_text()
macros=(ROOT.parent/'core/scale_macros.jinja').read_text()+'\n'+(ROOT.parent/'core/gradient_macros.jinja').read_text()
configs['effects_resolve']['sequence'][0]['variables']['result']=macros+'\n'+stream+'\n'+normal+'\n'+resolve
configs['effects_resolve']['description']='Resolve explicit channel claims and input overrides chronologically. Normal Light interprets remote ticks using cached gradients; animation processors ignore remote adjustments. Pure, no state access or actions.'

changed=[]
for name,config in configs.items():
    old=json.loads((BASE/(name+'.json')).read_text())
    if config!=old:changed.append(name)
    (CANDIDATE/(name+'.json')).write_text(json.dumps(config,indent=2)+'\n')
(ROOT/'changed.json').write_text(json.dumps(changed,indent=2)+'\n')
print('Changed: '+', '.join(changed))
