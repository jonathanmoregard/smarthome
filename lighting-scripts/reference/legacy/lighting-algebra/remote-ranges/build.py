"""Make the existing bounded remote-input domain explicit on its own record."""
import json
from pathlib import Path

STAGE = Path(__file__).parent
BASE = STAGE.parent / 'remote-regressions/candidate'
DEFAULT = "{'min':-20,'max':20}"
VALID = "bounds is mapping and bounds.get('min') is number and bounds.min is not boolean and bounds.get('max') is number and bounds.max is not boolean and -20<=bounds.min<=bounds.max<=20"
PROJECT = """{% set lo=[bounds.min,[bounds.max,a.v.lower]|min]|max %}
  {% set hi=[bounds.min,[bounds.max,a.v.upper]|min]|max %}
  {% set a.v=dict(a.v,steps=(0 if lo==hi else a.v.steps),lower=lo,upper=hi) %}"""


def replace(text, before, after, count=1):
    assert text.count(before) == count, (before, text.count(before))
    return text.replace(before, after)


remote = json.loads((BASE / 'ls_remote_plan.json').read_text())
t = remote['sequence'][5]['variables']['result']
t = replace(t, "{% set n=namespace(result={'op':'noop'},value=value) %}",
    "{% set bounds=value.get('step_range'," + DEFAULT + ") %}\n"
    "{% set bounds_valid=" + VALID + " %}\n"
    "{% set n=namespace(result={'op':'noop'},value=value) %}")
t = replace(t, "{% if room and command in ['up','down','left','right','toggle','reset','sara_toggle'] %}",
    "{% if room and command in ['up','down','left','right','toggle','reset','sara_toggle'] and (bounds_valid or command in ['toggle','reset','sara_toggle']) %}")
t = replace(t, "{'steps':0,'lower':-20,'upper':20,'anchor':'current','updated':stamp}",
    "{'steps':0,'lower':bounds.min,'upper':bounds.max,'anchor':'current','updated':stamp}")
t = replace(t, "{% if a.restart %}{% set a.v=identity %}{% endif %}",
    "{% if a.restart %}{% set a.v=identity %}{% endif %}\n  " + PROJECT)
t = replace(t, "{% set n.value=dict(value.items()|rejectattr(0,'in',['channels','position'])|list) %}",
    "{% set n.value=dict(value.items()|rejectattr(0,'in',['channels','position'])|list,step_range=bounds) %}")
t = replace(t, "{% set lo=[-20,[20,a.v.lower+d]|min]|max %}{% set hi=[-20,[20,a.v.upper+d]|min]|max %}",
    "{% set lo=[bounds.min,[bounds.max,a.v.lower+d]|min]|max %}{% set hi=[bounds.min,[bounds.max,a.v.upper+d]|min]|max %}")
t = replace(t, "Lower/upper retain saturation history: a down click after many ups responds immediately.",
    "The remote record declares step_range; lower/upper compact saturation history.\n   Excess clicks at either endpoint are discarded, independently of output rendering.")
remote['sequence'][5]['variables']['result'] = t
remote['description'] += ' step_range declares this remote override\'s shared tick limits within the supported -20..20 domain; missing limits preserve existing behavior.'

# Rotation selects a remembered preset context; it never resets the shared input.
t = replace(t, "{% set a=namespace(v=value.get('adjustment'),restart=false) %}",
    "{% set a=namespace(v=value.get('adjustment') if value.get('adjustment') is mapping else value.get('selection_input'),restart=false) %}")
t = replace(t, "{% if a.restart %}{% set a.v=identity %}{% endif %}",
    "{% if a.restart and command in ['up','down'] %}{% set a.v=identity %}{% endif %}")
old_rotation = """   {% set n.value=dict(n.value.items()|rejectattr(0,'eq','legacy_channels')|list) %}
   {% set choices=['day','cosy','Candle'] + (catalog.effects.keys()|reject('in',['Candle','Colour loop','Breathe','Normal light'])|list) %}
   {% set group=current.plan.resolved.targets.get('room:'~room,{}) %}
   {% set selected=value.get('selection',group.get('period','day')) %}
   {% set index=choices.index(selected) if selected in choices else 0 %}
   {% set selected=choices[(index+(1 if command=='right' else -1)) % (choices|count)] %}
   {% set n.value=dict(n.value,selection=selected,selection_updated=stamp) %}
   {% if selected in ['day','cosy'] %}
    {% set n.value=dict(n.value,period=selected,period_updated=stamp,adjustment=dict(identity,anchor=selected),selection_input=none) %}
   {% else %}
    {% set n.value=dict(n.value,selection_input=a.v,selection_instance=source~':'~selected,adjustment=none) %}
   {% endif %}"""
new_rotation = """   {% set choices=['day','cosy','Candle'] + (catalog.effects.keys()|reject('in',['Candle','Colour loop','Breathe','Normal light'])|list) %}
   {% set group=current.plan.resolved.targets.get('room:'~room,{}) %}
   {% set selected=value.get('selection',group.get('period','day')) %}
   {% set fields=['period','period_updated','selection_updated','selection_input','selection_instance','legacy_channels'] %}
   {% set contexts=value.get('preset_contexts',{}) %}
   {% set contexts=contexts if contexts is mapping else {} %}
   {% set contexts=dict(contexts,**{selected:dict(n.value.items()|selectattr(0,'in',fields)|list)}) %}
   {% set index=choices.index(selected) if selected in choices else 0 %}
   {% set selected=choices[(index+(1 if command=='right' else -1)) % (choices|count)] %}
   {% set saved=contexts.get(selected) %}
   {% if saved is not mapping %}
    {% if selected in ['day','cosy'] %}
     {% set saved={'period':selected,'period_updated':stamp,'selection_updated':stamp} %}
    {% else %}
     {% set saved=dict(n.value.items()|selectattr(0,'in',['period','period_updated'])|list,selection_updated=stamp,selection_input=a.v,selection_instance=source~':'~selected) %}
    {% endif %}
   {% endif %}
   {% set n.value=dict(n.value.items()|rejectattr(0,'in',fields)|list,selection=selected,adjustment=a.v,preset_contexts=contexts,**saved) %}"""
t = replace(t, old_rotation, new_rotation)
remote['sequence'][5]['variables']['result'] = t
remote['description'] += ' Preset rotation preserves shared adjustment and resumes each preset\'s prior context; opposite rotations restore the previous lighting meaning.'

resolve = json.loads((BASE / 'effects_resolve.json').read_text())
t = resolve['sequence'][0]['variables']['result']
for field in ['selection_input', 'adjustment']:
    t = replace(t, "'input':value." + field + ",",
        "'input':dict(value." + field + ",step_range=value.get('step_range'," + DEFAULT + "),anchor=(value.get('period') if value." + field + ".get('anchor') in ['day','cosy'] and value.get('period') in ['day','cosy'] else value." + field + ".get('anchor','current')))," )
t = replace(t, "{% if value.get('adjustment') is mapping %}",
    "{% if value.get('adjustment') is mapping and (value.get('selection') in ['day','cosy',none] or value.get('adjustment')!=value.get('selection_input')) %}")
t = replace(t, "{% if valid.ok and -20<=input.lower<=input.upper<=20 %}",
    "{% set bounds=input.get('step_range'," + DEFAULT + ") if input is mapping else none %}\n"
    "           {% if valid.ok and -20<=input.lower<=input.upper<=20 and " + VALID + " %}\n"
    "            {% set input=dict(input,lower=[bounds.min,[bounds.max,input.lower]|min]|max,upper=[bounds.min,[bounds.max,input.upper]|min]|max) %}")
resolve['sequence'][0]['variables']['result'] = t
resolve['description'] += ' Remote step ranges constrain input before interpretation; explicit channel and other override types retain their existing semantics.'

configs = {'ls_remote_plan': remote, 'effects_resolve': resolve}

# Periods and channels must read the same latest snapshot of a room's input.
# Keep all records available to expiry cleanup; filter only period competition.
stream = (STAGE.parent / 'input-processors/input_stream.jinja').read_text()
is_remote = "r.get('scope')=='room' and (r.get('kind')=='input' or (r.get('kind')=='channels' and r.get('via')=='remote'))"
for name in ['ls_base', 'ls_room_base']:
    config = json.loads((BASE / (name + '.json')).read_text())
    t = config['sequence'][0]['variables']['plan']
    t = stream + "\n{% set remote_streams=namespace(by_room={}) %}\n" + t
    t = replace(t, "{%- set ts = room or 'house' -%}",
        "{%- set ts = room or 'house' -%}\n"
        "{% if ts not in remote_streams.by_room %}{% set remote_streams.by_room=dict(remote_streams.by_room,**{ts:latest_remote_key(ovr,ts)|from_json}) %}{% endif %}")
    t = replace(t, "{%- if matches and period in blocks and stamp>=pick.stamp",
        "{%- if matches and (not (" + is_remote + ") or key==remote_streams.by_room[ts]) and period in blocks and stamp>=pick.stamp")
    config['sequence'][0]['variables']['plan'] = t
    t = stream + '\n' + config['sequence'][1]['variables']['result']
    t = replace(t, "{% set period=namespace(value=S.cur or 'night',stamp=0,explicit=false) %}",
        "{% set remote_input_key=latest_remote_key(overrides,area)|from_json %}\n"
        " {% set period=namespace(value=S.cur or 'night',stamp=0,explicit=false) %}")
    t = replace(t, "{% if matches and chosen in ['day','cosy','night']",
        "{% if matches and (not (" + is_remote + ") or key==remote_input_key) and chosen in ['day','cosy','night']")
    config['sequence'][1]['variables']['result'] = t
    config['description'] = config.get('description', '') + ' Period selection uses only the latest room remote snapshot, matching channel resolution; expiry still inspects every record.'
    configs[name] = config

config = json.loads((BASE / 'ls_room_plan.json').read_text())
config['sequence'][0]['variables']['cache_version'] += ':preset-stream-v1'
replaced = []

def period_cache(value):
    if isinstance(value, dict):
        if 'periods' in value.get('variables', {}):
            t = value['variables']['periods']
            t = stream + "\n{% set remote_input_key=latest_remote_key(overrides,room)|from_json %}\n" + t
            t = replace(t, "{% if applies and period in ['day','cosy','night'] %}",
                "{% if applies and (not (" + is_remote + ") or key==remote_input_key) and period in ['day','cosy','night'] %}")
            t = replace(t, "{key:[r.get('kind'),r.get('scope')",
                "{('remote-input:'~room if " + is_remote + " else key):[r.get('kind'),r.get('scope')")
            value['variables']['periods'] = t
            replaced.append(True)
        for item in value.values():
            period_cache(item)
    elif isinstance(value, list):
        for item in value:
            period_cache(item)

period_cache(config)
assert len(replaced) == 2
config['description'] = config.get('description', '') + ' Cache period identity tracks the logical room input, independent of which remote last updated it.'
configs['ls_room_plan'] = config

for name, config in configs.items():
    (STAGE / 'candidate' / (name + '.json')).write_text(json.dumps(config, indent=2) + '\n')
print('Built ' + ', '.join(configs))
