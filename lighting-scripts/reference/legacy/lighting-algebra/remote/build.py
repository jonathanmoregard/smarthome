"""Build remote adapters only for action values verified from the actual device."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
DEVICE = '0752f2b4e9a0992ac8efc2af1f53c62a'
IEEE = '0x385b44fffea50c99'
TOPIC = f'zigbee2mqtt/{IEEE}/action'
# Both directions are physically observed. Scene actions lack a verified arrow identity.
DIRECTIONS = {'brightness_step_up': 'up', 'brightness_step_down': 'down'}
CENTER = ['on', 'off']

def trigger(action, ident=None):
    return dict({'trigger': 'mqtt', 'topic': TOPIC, 'payload': action}, **({'id': ident} if ident else {}))

def command(value):
    return {
        'action': 'script.ls_remote_command',
        'data': {'source': IEEE, 'area': '{{ area_id("' + DEVICE + '") }}', 'command': value, 'dry_run': False},
    }

center = {
    'id': 'lighting_remote_' + IEEE + '_center',
    'alias': 'Lighting · Living Room Remote Center',
    'description': 'Verified Innr RC250 on/off actions. One press toggles after a 400ms quiet interval; three or more presses reset room overrides once. Two presses do nothing. Single mode consumes the whole burst without intermediate power toggles. Area is looked up when dispatching.',
    'mode': 'single', 'max_exceeded': 'silent',
    'triggers': [trigger(action) for action in CENTER],
    'actions': [
        {'variables': {'clicks': 1}},
        {'repeat': {
            'sequence': [
                {'wait_for_trigger': [trigger(action) for action in CENTER], 'timeout': {'milliseconds': 400}, 'continue_on_timeout': True},
                {'if': [{'condition': 'template', 'value_template': '{{ wait.completed }}'}], 'then': [{'variables': {'clicks': '{{ [3, clicks + 1]|min }}'}}]},
            ],
            'until': [{'condition': 'template', 'value_template': '{{ not wait.completed }}'}],
        }},
        {'choose': [
            {'conditions': [{'condition': 'template', 'value_template': '{{ clicks == 1 }}'}], 'sequence': [command('toggle')]},
            {'conditions': [{'condition': 'template', 'value_template': '{{ clicks >= 3 }}'}], 'sequence': [command('reset')]},
        ]},
    ],
}
directions = {
    'id': 'lighting_remote_' + IEEE + '_directions',
    'alias': 'Lighting · Living Room Remote Directions',
    'description': 'Verified Innr RC250 brightness-step actions map to room up/down. Separate queued adapter remains responsive while the center gesture waits. Scene arrows await a verified hardware mapping.',
    'mode': 'queued', 'max': 30,
    'triggers': [trigger(action, value) for action, value in DIRECTIONS.items()],
    'actions': [command('{{ trigger.id }}')],
}
for suffix, config in [('center', center), ('directions', directions)]:
    (ROOT / ('automation_remote_' + suffix + '.json')).write_text(json.dumps(config, indent=2) + '\n')
print('Built verified center and up/down adapters; scene arrows are not guessed')
