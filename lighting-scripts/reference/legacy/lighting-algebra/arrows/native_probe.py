"""Run the real gesture sequence in HA with helper writes replaced by local data.

Every external action is rejected unless explicitly replaced. The probe may only
read live device-to-room mapping; it cannot write helpers or command lamps.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent


def expr(value):
    if isinstance(value, str) and value.startswith('{{') and value.endswith('}}'):
        return value[2:-2].strip()
    return json.dumps(value)


def data_only(value):
    if isinstance(value, str):
        value = value.replace('now().isoformat()', 'probe_now').replace('now()', 'probe_now')
        value = re.sub(r"states\('(input_(?:number|text)\.[^']+)'\)", r"shadow.get('\1','')", value)
        value = re.sub(r"has_value\('(input_(?:number|text)\.[^']+)'\)", r"(shadow.get('\1','')!='')", value)
        return re.sub(r"is_state\('(timer\.[^']+)','active'\)", r"(shadow.get('\1')=='active')", value)
    if isinstance(value, list):
        return [data_only(item) for item in value]
    if isinstance(value, dict):
        if 'action' in value:
            action, entity = value['action'], value.get('target', {}).get('entity_id')
            if action in ['input_number.set_value', 'input_text.set_value']:
                expression = data_only(expr(value['data']['value']))
                return {'variables': {'shadow': "{{ dict(shadow, **{'" + entity + "': " + expression + '}) }}'}}
            if action in ['timer.start', 'timer.cancel']:
                return {'variables': {'shadow': "{{ dict(shadow, **{'" + entity + "': '" + ('active' if action=='timer.start' else 'idle') + "'}) }}"}}
            if action == 'script.turn_on' and entity == 'script.ls_remote_command':
                return {'variables': {'intents': '{{ intents + [' + expr(value['data']['variables']['command']) + '] }}'}}
            if action == 'script.turn_on' and entity.startswith('script.ls_remote_power_quiet_'):
                return {'variables': {'quiet_started': True}}
            raise AssertionError(('External action not replaced', value))
        if 'stop' in value:
            return {'stop': value['stop'], 'response_variable': 'probe_result'}
        return {key: data_only(item) for key, item in value.items()}
    return value


def capture_before_stops(value):
    if isinstance(value, list):
        result = []
        for item in value:
            if isinstance(item, dict) and 'stop' in item:
                result.append({'variables': {'probe_result': "{{ {'shadow':shadow,'intents':intents} }}"}})
            result.append(capture_before_stops(item))
        return result
    if isinstance(value, dict):
        return {key: capture_before_stops(item) for key, item in value.items()}
    return value


for version in ['before', 'candidate']:
    config = json.loads((ROOT / version / 'ls_remote_gesture_bedroom.json').read_text())
    sequence = [{'variables': {'intents': []}}] + config['sequence'] + [{'stop': 'Return probe result'}]
    sequence = capture_before_stops(data_only(sequence))
    probe = {'alias': 'Lighting · Pure Arrow Replay ' + version, 'mode': 'parallel',
             'fields': {name: {'selector': {'object': {}}} for name in ['command','payload','token','shadow','probe_now']},
             'sequence': sequence}
    text = json.dumps(probe, indent=2) + '\n'
    assert '"action":' not in text and '"event":' not in text
    (ROOT / ('native_probe_' + version + '.json')).write_text(text)
print('Built pure native probes: no external actions or events')
