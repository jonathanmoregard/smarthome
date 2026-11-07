"""Restrict offered effects without changing active lighting or stored profiles."""
import json
from pathlib import Path

ROOT = Path(__file__).parent


def read(name):
    return json.loads((ROOT / 'before' / (name + '.json')).read_text())


def write(name, config):
    (ROOT / 'candidate' / (name + '.json')).write_text(json.dumps(config, indent=2) + '\n')


catalog = read('effects_ui_catalog')
catalog['sequence'][1]['variables']['choices'] = ['Normal Light', 'Candle']
for row in catalog['sequence'][2]['repeat']['for_each']:
    row['config']['effect_list'] = ['Normal Light', 'Candle']
write('effects_ui_catalog', catalog)

adapter = read('effects_set')
adapter['sequence'].insert(0, {'variables': {
    'value': "{{ 'Normal light' if attribute=='effect' and value=='Normal Light' else value }}",
}})
write('effects_set', adapter)

sync = read('effects_ui_sync')
message = sync['sequence'][2]['variables']['messages']
marker = " {% set power='ON'"
assert message.count(marker) == 1
sync['sequence'][2]['variables']['messages'] = message.replace(marker,
    " {% set effect='Normal Light' if effect=='Normal light' else effect %}\n" + marker)
write('effects_ui_sync', sync)

remote = read('ls_remote_plan')
step = remote['sequence'][3]['then'][-1]['variables']
old = "reject('in',['Candle','Colour loop'])"
assert old in step['result']
step['result'] = step['result'].replace(old, "reject('in',['Candle','Colour loop','Breathe'])")
write('ls_remote_plan', remote)
print('Built four script updates; 88 native effect menus')
