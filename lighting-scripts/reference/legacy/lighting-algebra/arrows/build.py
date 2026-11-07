"""Stage only the remote correction; no network or device commands."""
import json
from pathlib import Path

ROOT = Path(__file__).parent


def guard_stop(value, message):
    return {'if': [{'condition': 'template', 'value_template': value}],
            'then': [{'stop': message}]}


for room in ['bedroom', 'living_room']:
    name = 'ls_remote_gesture_' + room
    config = json.loads((ROOT / 'before' / (name + '.json')).read_text())
    seq = config['sequence']
    decode = seq[4]['then']
    assert 'payload is mapping' in decode[0]['value_template']
    decode[0] = guard_stop(
        "{{ payload is not mapping or payload.get('action') not in ['color_temperature_move','brightness_move_to_level'] }}",
        'Ignore unrelated MQTT payload')
    assert decode[4]['value_template'] == '{{ index!=previous }}'
    decode[4] = guard_stop('{{ index==previous }}', 'Ignore duplicate preset companion')
    complete = seq[3]['choose'][0]['sequence']
    assert 'token==stored_token' in complete[0]['value_template']
    complete[0] = guard_stop('{{ token|length==0 or token!=stored_token or clicks<=0 }}',
                            'Ignore stale power completion')
    assert seq[7]['value_template'] == "{{ command!='cancel' }}"
    seq[7]['value_template'] = "{{ command in ['left','right','up','down'] }}"
    (ROOT / 'candidate' / (name + '.json')).write_text(json.dumps(config, indent=2) + '\n')

name = 'ls_remote_plan'
config = json.loads((ROOT / 'before' / (name + '.json')).read_text())
template = config['sequence'][3]['then'][-1]['variables']['result']
before = "catalog.effects.keys()|reject('eq','Candle')|list"
assert before in template
config['sequence'][3]['then'][-1]['variables']['result'] = template.replace(
    before, "catalog.effects.keys()|reject('in',['Candle','Colour loop','Breathe'])|list")
(ROOT / 'candidate' / (name + '.json')).write_text(json.dumps(config, indent=2) + '\n')
print('Built three remote script corrections')
