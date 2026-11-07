"""Build native RC250 adapters; no HA connection or device operation."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
REMOTES = {
    'bedroom': ('0x385b44fffea4fc67', '0e973e9202acb5ace9a8e6a8b336891d', "Bedroom"),
    'living_room': ('0x385b44fffea50c99', '0752f2b4e9a0992ac8efc2af1f53c62a', 'Living Room'),
}


def write(name, value):
    (ROOT / (name + '.json')).write_text(json.dumps(value, indent=2) + '\n')


def condition(value):
    return {'condition': 'template', 'value_template': value}


helpers = {'input_number': {}, 'timer': {}, 'input_text': {}}
for name, (ieee, device, title) in REMOTES.items():
    stem = 'ls_' + name + '_remote'
    step = 'input_number.' + stem + '_chord_step'
    timer = 'timer.' + stem + '_chord'
    cursor = 'input_number.' + stem + '_preset'
    count = 'input_number.' + stem + '_power_count'
    token_entity = 'input_text.' + stem + '_power_token'
    debounce_id = 'ls_remote_power_quiet_' + name
    script_id = 'ls_remote_gesture_' + name
    topic = 'zigbee2mqtt/' + ieee
    helpers['input_number'][stem + '_chord_step'] = {
        'name': title + ' Remote Chord Step', 'min': -1, 'max': 4, 'step': 1, 'mode': 'box', 'icon': 'mdi:gesture-tap',
    }
    helpers['input_number'][stem + '_preset'] = {
        'name': title + ' Remote Preset Cursor', 'min': -1 if name=='living_room' else 0, 'max': 4, 'step': 1, 'mode': 'box', 'icon': 'mdi:remote',
    }
    helpers['timer'][stem + '_chord'] = {
        'name': title + ' Remote Chord', 'duration': '00:00:03', 'restore': False,
    }
    helpers['input_number'][stem + '_power_count'] = {
        'name': title + ' Remote Power Count', 'min': 0, 'max': 3, 'step': 1, 'mode': 'box', 'initial': 0,
    }
    helpers['input_text'][stem + '_power_token'] = {
        'name': title + ' Remote Power Token', 'max': 255, 'initial': '',
    }

    def route(command):
        return {'action': 'script.' + script_id, 'data': {'command': command}}

    def set_step(value):
        return {'action': 'input_number.set_value', 'target': {'entity_id': step}, 'data': {'value': value}}

    clear = [set_step(0), {'action': 'timer.cancel', 'target': {'entity_id': timer}}]
    start = {'action': 'timer.start', 'target': {'entity_id': timer}, 'data': {'duration': '00:00:03'}}

    def dispatch(command):
        return [
            {'variables': {'room': "{{ area_id('" + device + "') }}"}},
            {'if': [condition('{{ room is string and room|length>0 }}')], 'then': [
             {'action': 'script.turn_on', 'target': {'entity_id': 'script.ls_remote_command'}, 'data': {'variables': {
                'source': ieee, 'area': '{{ room }}', 'command': command, 'dry_run': False,
             }}},
            ]},
        ]

    finish_power = [
        {'action': 'input_number.set_value', 'target': {'entity_id': count}, 'data': {'value': 0}},
        {'action': 'input_text.set_value', 'target': {'entity_id': token_entity}, 'data': {'value': ''}},
        {'if': [condition('{{ clicks==1 or clicks>=3 }}')], 'then': clear + dispatch("{{ 'toggle' if clicks==1 else 'reset' }}")},
    ]
    decode = [
        condition("{{ payload is mapping and payload.get('action') in ['color_temperature_move','brightness_move_to_level'] }}"),
        {'variables': {
            'presets': "{{ [200,285,370,454,588] if payload.action=='color_temperature_move' else [254,229,178,76,2] }}",
            'preset': "{{ payload.get('action_color_temperature') if payload.action=='color_temperature_move' else payload.get('action_level') }}",
            'previous': "{{ states('" + cursor + "')|float(-1) }}",
        }},
        {'if': [condition("{{ preset is not number or preset is boolean or preset not in presets }}")],
         'then': clear + [{'stop': 'Unknown preset cancels chord'}]},
        {'variables': {'index': '{{ presets.index(preset) }}'}},
        condition('{{ index!=previous }}'),
        {'variables': {'delta': '{{ (index-previous|int)%5 if previous in [0,1,2,3,4] else -1 }}'}},
        {'action': 'input_number.set_value', 'target': {'entity_id': cursor}, 'data': {'value': '{{ index }}'}},
        {'variables': {'command': "{{ 'right' if delta==1 else 'left' if delta==4 else 'cancel' }}"}},
    ]
    gesture = {
        'alias': 'Lighting · ' + title + ' Remote Gestures',
        'description': 'Single quick state owner for raw power/presets/directions. A token-guarded restart script debounces power; native timer bounds the secret chord. No waits here. Cursor reset and decoding are serialized. Logical commands launch asynchronously so actuator latency cannot drop input.',
        'mode': 'queued', 'max': 50,
        'fields': {'command': {'selector': {'text': {}}}, 'payload': {'default': {}, 'selector': {'object': {}}}, 'token': {'default': '', 'selector': {'text': {}}}},
        'sequence': [
            condition("{{ command in ['power','power_done','preset','cancel','left','right','up','down'] }}"),
            {'variables': {
                'step': "{{ states('" + step + "')|int(0) }}",
                'active': "{{ is_state('" + timer + "','active') }}",
                'clicks': "{{ states('" + count + "')|int(0) }}",
                'stored_token': "{{ states('" + token_entity + "') if has_value('" + token_entity + "') else '' }}",
            }},
            {'variables': {'quiet_active': '{{ clicks>0 and stored_token|length>0 and as_timestamp(stored_token,0)+0.4>as_timestamp(now()) }}'}},
            {'choose': [
                {'conditions': [condition("{{ command=='power_done' }}")], 'sequence': [
                    condition('{{ token|length>0 and token==stored_token and clicks>0 }}'),
                    *finish_power, {'stop': 'Completed quiet power burst'},
                ]},
                {'conditions': [condition("{{ command=='power' }}")], 'sequence': [
                    {'if': [condition('{{ clicks>0 and not quiet_active }}')], 'then': finish_power},
                    {'variables': {'clicks': '{{ [3,clicks+1]|min if quiet_active else 1 }}'}},
                    {'action': 'input_number.set_value', 'target': {'entity_id': count}, 'data': {'value': '{{ clicks }}'}},
                    {'choose': [
                        {'conditions': [condition('{{ clicks==1 }}')], 'sequence': [set_step(-1), start]},
                        {'conditions': [condition('{{ clicks==2 }}')], 'sequence': [
                            {'action': 'input_number.set_value', 'target': {'entity_id': cursor}, 'data': {'value': 0}},
                            {'if': [condition('{{ active and step==-1 }}')], 'then': [set_step(1), start], 'else': clear},
                        ]},
                    ], 'default': clear},
                    {'variables': {'fresh_token': '{{ now().isoformat() }}'}},
                    {'action': 'input_text.set_value', 'target': {'entity_id': token_entity}, 'data': {'value': '{{ fresh_token }}'}},
                    {'action': 'script.turn_on', 'target': {'entity_id': 'script.' + debounce_id}, 'data': {'variables': {'token': '{{ fresh_token }}'}}},
                    {'stop': 'Raw power recorded without waiting'},
                ]},
            ]},
            {'if': [condition("{{ command=='preset' }}")], 'then': decode},
            {'choose': [
                {'conditions': [condition("{{ active and step in [1,2,3,4] and command==['left','right','left','right'][step-1] }}")], 'sequence': [
                    {'if': [condition('{{ step==4 }}')],
                     'then': clear + dispatch('sara_toggle'),
                     'else': [set_step('{{ step+1 }}'), start]},
                    {'stop': 'Matched chord input consumed'},
                ]},
            ]},
            {'if': [condition('{{ step!=0 or active }}')], 'then': clear},
            condition("{{ command!='cancel' }}"),
        ] + dispatch('{{ command }}'),
    }
    write(script_id, gesture)

    center_triggers = [{'trigger': 'mqtt', 'topic': topic + '/action', 'payload': action} for action in ['on', 'off']]
    center = {
        'id': 'lighting_remote_' + ieee + '_center',
        'alias': 'Lighting · ' + title + ' Remote Center',
        'description': 'Queue every raw POWER event into its quick state owner; no listener gaps or waits.',
        'mode': 'queued', 'max': 50, 'triggers': center_triggers,
        'actions': [route('power')],
    }
    write('gesture_center_' + name, center)
    directions = {
        'id': 'lighting_remote_' + ieee + '_directions',
        'alias': 'Lighting · ' + title + ' Remote Directions',
        'description': 'Up/down pass through without a gesture wait; either cancels an incomplete arrow chord.',
        'mode': 'queued', 'max': 50,
        'triggers': [{'trigger': 'mqtt', 'topic': topic + '/action', 'payload': 'brightness_step_' + direction, 'id': direction}
                     for direction in ['up', 'down']],
        'actions': [route('{{ trigger.id }}')],
    }
    write('gesture_directions_' + name, directions)
    presets = {
        'id': 'lighting_remote_' + ieee + '_presets',
        'alias': 'Lighting · ' + title + ' Remote Preset Arrows',
        'description': 'Modulo-five preset decoder with both wraps. Full JSON colour-temperature and brightness preset actions map to the same hardware index; the first available family advances and its same-index partner is ignored. Ambiguous or unknown preset input cancels any pending secret chord, without guessing a direction.',
        'mode': 'queued', 'max': 50,
        'triggers': [{'trigger': 'mqtt', 'topic': topic}],
        'actions': [{'action': 'script.' + script_id, 'data': {'command': 'preset', 'payload': '{{ trigger.payload_json|default({}) }}'}}],
    }
    write('gesture_presets_' + name, presets)
    write(debounce_id, {
        'alias': 'Lighting · ' + title + ' Remote Power Quiet',
        'description': 'Restartable exact subsecond debounce. Carries its token back asynchronously; actor ignores superseded completions.',
        'mode': 'restart', 'fields': {'token': {'selector': {'text': {}}}},
        'sequence': [
            {'delay': {'milliseconds': 400}},
            {'action': 'script.turn_on', 'target': {'entity_id': 'script.' + script_id},
             'data': {'variables': {'command': 'power_done', 'token': '{{ token }}'}}},
        ],
    })

write('gesture_helpers', helpers)
manifest = {'scripts': [], 'automations': [], 'helpers': []}
for name, (ieee, device, title) in REMOTES.items():
    script_id = 'ls_remote_gesture_' + name
    manifest['scripts'].append({'entity_id': 'script.' + script_id, 'file': script_id + '.json'})
    debounce_id='ls_remote_power_quiet_'+name
    manifest['scripts'].append({'entity_id':'script.'+debounce_id,'file':debounce_id+'.json'})
    for kind in ['center','directions','presets']:
        manifest['automations'].append({
            'automation_id': 'lighting_remote_' + ieee + '_' + kind,
            'file': 'gesture_' + kind + '_' + name + '.json',
            'install': 'replace existing by stable id; create only if absent',
        })
for domain, configs in helpers.items():
    for object_id, config in configs.items():
        params = {'action': 'create', 'helper_type': domain, 'name': object_id}
        params.update({('min_value' if key=='min' else 'max_value' if key=='max' else key):value
                       for key,value in config.items() if key!='name'})
        entry = {'entity_id': domain + '.' + object_id, 'create_if_missing': params,
                 'name_after_create': config['name']}
        if object_id=='ls_bedroom_remote_preset':
            entry['existing'] = 'Preserve existing helper and cursor; do not reseed.'
        elif object_id=='ls_living_room_remote_preset':
            entry['seed_after_create_before_preset_automation'] = -1
        manifest['helpers'].append(entry)
manifest['notes'] = [
    'Create missing helpers, install scripts, then replace adapters by stable automation id; never install duplicates.',
    'create_if_missing uses the object id as the name to allocate the exact referenced entity id; optionally rename its display name after creation.',
    'Parent script.ls_remote_command must accept sara_toggle as a global policy toggle preserving room power/channel records.',
    'No initial value on preset helpers: restoration is intentional. New living cursor is explicitly seeded -1; existing bedroom cursor is not touched.',
]
write('gesture_manifest', manifest)
print('Built independent native RC250 chord scripts/helpers and adapter candidates for both remotes')
