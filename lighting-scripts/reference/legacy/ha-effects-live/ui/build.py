import copy
import json
import re
from pathlib import Path

BASE = Path('/tmp/effect-native-copies')
OUT = Path('/tmp/ha-effects-live/ui')

def read(name):
    return json.loads((BASE / name).read_text())

def write(name, value):
    path = OUT / name
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    assert json.loads(path.read_text()) == value

def replace(value, mapping):
    if isinstance(value, str):
        for old, new in sorted(mapping.items(), key=lambda kv: -len(kv[0])):
            value = re.sub(r'(?<![\w.])' + re.escape(old) + r'(?![\w])', new, value)
        return value
    if isinstance(value, list):
        return [replace(v, mapping) for v in value]
    if isinstance(value, dict):
        return {k: replace(v, mapping) for k, v in value.items()}
    return value

entity_map = read('entity-map.json')
light_map = {k: v for k, v in entity_map.items() if k.startswith('light.')}
helper_reverse = {v: k for k, v in entity_map.items() if not k.startswith('light.')}
house = replace(read('house-final.json'), helper_reverse)
house['views'][0]['sections'][0] = replace(read('house-source.json')['views'][0]['sections'][0], light_map)
for card in house['views'][0]['sections'][0]['cards']:
    if card.get('entity', '').startswith('light.'):
        card.update(state_content=['effect', 'brightness', 'color_temp_kelvin'],
                    tap_action={'action': 'more-info'}, icon_tap_action={'action': 'more-info'})
house['views'][0]['sections'][0]['cards'].insert(0, {
    'type': 'markdown', 'text_only': True,
    'content': 'Choose **Effect** inside a light to set a temporary override. **Cancel All Overrides** returns lights to their current schedule.'})
for section in house['views'][1]['sections']:
    for card in section.get('cards', []):
        if card.get('type') == 'markdown' and 'preview' in card.get('content', '').lower():
            card['content'] = 'Choose **Effect** inside a lamp to set a temporary override.'
schedule = replace(read('schedule-final.json'), helper_reverse)
schedule['views'][0]['sections'][0]['cards'][0]['content'] = 'Set **Effect** inside each **Day / Cosy / Night Light** to set its scheduled baseline. **Override Light** and **Lamps…** include the effect.'
write('house.json', house)
write('schedule.json', schedule)

configs = json.loads(Path('/tmp/ha-effects-live/virtual-configs.json').read_text())
inventory = read('inventory.json')
source_states = read('source-states.json')
area_groups = {'light.kitchen_all': 'kitchen', 'light.living_room': 'living_room',
               'light.upper_hall': 'hall_overvaning', 'light.jonathan_bedroom': 'bedroom',
               'light.meditation_mys_all': 'meditation_mys'}
command_sources = {}
rows = []
for item in configs:
    cfg = item['config']
    unique = cfg['unique_id']
    prefix = 'house/v1/effect_preview/' + unique + '/set/'
    command_sources[unique] = item['source']
    for key, field in [('command_topic','power'), ('brightness_command_topic','brightness'),
                       ('rgb_command_topic','rgb'), ('color_temp_command_topic','temperature'),
                       ('effect_command_topic','effect')]:
        cfg[key] = prefix + field
    cfg.update(retain=False, effect_list=['Normal light', 'Candle', 'Breathe', 'Colour loop'])
    cfg['availability_topic'] = 'house/v1/effect_preview/' + unique + '/availability'
    source = item['source']
    if source == 'light.home':
        members = [r['id'] for r in inventory]
    elif source in area_groups:
        members = [r['id'] for r in inventory if r['area_id'] == area_groups[source]]
    else:
        members = [source]
    rows.append({'source': source, 'proxy': item['entity'], 'members': members,
                 'store': source.replace('light.', 'input_text.', 1) if source.startswith('light.ls_') else '',
                 'topics': {field: cfg[key] for field, key in [
                     ('power','state_topic'), ('brightness','brightness_state_topic'),
                     ('rgb','rgb_state_topic'), ('temperature','color_temp_state_topic'), ('effect','effect_state_topic'),
                     ('availability','availability_topic')]}})
write('discovery.json', configs)
write('source-map.json', command_sources)
write('sync-rows.json', rows)

command = {
    'id': 'effects_ui_commands', 'alias': 'Effects: native light controls',
    'description': 'One command adapter. State topics are separate and never execute controls.',
    'mode': 'queued', 'max': 100,
    'triggers': [{'trigger': 'mqtt', 'topic': 'house/v1/effect_preview/+/set/+'}],
    'variables': {'sources': command_sources},
    'conditions': [{'condition': 'template', 'value_template':
                    "{{ trigger.topic.split('/')[3] in sources and trigger.topic.split('/')[-1] in ['power','brightness','rgb','temperature','effect'] }}"}],
    'actions': [{'action': 'script.effects_set', 'data': {
        'source': "{{ sources[trigger.topic.split('/')[3]] }}",
        'attribute': "{{ trigger.topic.split('/')[-1] }}", 'value': '{{ trigger.payload }}'}},
        {'action': 'script.turn_on', 'target': {'entity_id': 'script.effects_ui_sync'}}]}
write('effects_ui_commands.json', command)

sync_template = '''
{% set assignments = state_attr('sensor.effects_controller', 'assignments') or {} %}
{% set ns = namespace(messages=[]) %}
{% for row in rows %}
  {% set source = row.source %}
  {% set proxy = row.proxy %}
  {% set available = states(source) in ['on', 'off'] %}
  {% if force | default(false) or available != (states(proxy) in ['on', 'off']) %}
    {% set ns.messages = ns.messages + [{'topic': row.topics.availability, 'payload': 'online' if available else 'offline'}] %}
  {% endif %}
  {% set profile = states(row.store) | from_json({}) if row.store else {} %}
  {% set fx = namespace(names=[], levels=[]) %}
  {% for member in row.members %}
    {% set entry = assignments.get(member, {}) %}
    {% set name = entry.get('effect', 'Normal light') if entry is mapping else entry %}
    {% set fx.names = fx.names + [name | default('Normal light', true)] %}
    {% if entry is mapping and entry.get('brightness') is number %}
      {% set fx.levels = fx.levels + [entry.brightness] %}
    {% endif %}
  {% endfor %}
  {% set unique_effects = fx.names | unique | list %}
  {% set effect = profile.get('effect', 'Normal light') if row.store else (unique_effects[0] if unique_effects | count == 1 else '') %}
  {% set power = 'ON' if is_state(source, 'on') else 'OFF' %}
  {% set b = state_attr(source, 'brightness') %}
  {% set k = state_attr(source, 'color_temp_kelvin') %}
  {% set rgb = state_attr(source, 'rgb_color') %}
  {% set mode = state_attr(source, 'color_mode') %}
  {% if not row.store and effect not in ['', 'Normal light'] and fx.levels | count == row.members | count %}
    {% set b = (fx.levels | sum / fx.levels | count) | round(0) | int %}
  {% endif %}
  {% if states(source) in ['on', 'off'] %}
    {% if force | default(false) or states(proxy) != states(source) %}
      {% set ns.messages = ns.messages + [{'topic': row.topics.power, 'payload': power}] %}
    {% endif %}
    {% if force | default(false) or state_attr(proxy, 'effect') != effect %}
      {% set ns.messages = ns.messages + [{'topic': row.topics.effect, 'payload': effect}] %}
    {% endif %}
    {% if b is number and (force | default(false) or state_attr(proxy, 'brightness') != b) %}
      {% set ns.messages = ns.messages + [{'topic': row.topics.brightness, 'payload': b | int | string}] %}
    {% endif %}
    {% if mode == 'color_temp' and k is number and k > 0 %}
      {% set mired = (1000000 / k) | round(0) | int %}
      {% set proxy_k = state_attr(proxy, 'color_temp_kelvin') | float(0) %}
      {% set proxy_mired = (1000000 / proxy_k) | round(0) | int if proxy_k > 0 else 0 %}
      {% if force | default(false) or state_attr(proxy, 'color_mode') != 'color_temp' or proxy_mired != mired %}
        {% set ns.messages = ns.messages + [{'topic': row.topics.temperature, 'payload': mired | string}] %}
      {% endif %}
    {% elif rgb is sequence and rgb | count == 3 %}
      {% if force | default(false) or state_attr(proxy, 'color_mode') != 'rgb' or (state_attr(proxy, 'rgb_color') or []) | list != rgb | list %}
        {% set ns.messages = ns.messages + [{'topic': row.topics.rgb, 'payload': rgb | join(',')}] %}
      {% endif %}
    {% endif %}
  {% endif %}
{% endfor %}
{{ ns.messages }}
'''.strip()
sync = {
    'alias': 'Effects: mirror native light controls', 'mode': 'single', 'max_exceeded': 'silent',
    'description': 'At most one UI state refresh every five seconds; no Zigbee commands. Publish only changed values.',
    'fields': {'force': {'description': 'Republish retained UI state after startup', 'default': False, 'selector': {'boolean': {}}}},
    'sequence': [{'variables': {'rows': rows}}, {'variables': {'messages': sync_template}},
                 {'repeat': {'for_each': '{{ messages }}', 'sequence': [
                     {'action': 'mqtt.publish', 'data': {'topic': '{{ repeat.item.topic }}',
                      'payload': '{{ repeat.item.payload }}', 'qos': 0, 'retain': True}}]}}]}
write('effects_ui_sync.json', sync)
sync_automation = {
    'id': 'effects_ui_refresh', 'alias': 'Effects: refresh native light controls', 'mode': 'single', 'max_exceeded': 'silent',
    'triggers': [{'trigger': 'time_pattern', 'seconds': '/5', 'id': 'periodic'},
                 {'trigger': 'homeassistant', 'event': 'start', 'id': 'start'},
                 {'trigger': 'state', 'entity_id': 'sensor.effects_controller', 'attribute': 'assignments', 'id': 'assignments'},
                 {'trigger': 'state', 'entity_id': 'sensor.ls_overrides', 'attribute': 'overrides', 'id': 'overrides'},
                 {'trigger': 'state', 'entity_id': [r['store'] for r in rows if r['store']], 'id': 'profiles'}],
    'actions': [{'action': 'script.effects_ui_sync', 'data': {'force': "{{ trigger.id == 'start' }}"}}]}
write('effects_ui_refresh.json', sync_automation)
write('checks.json', {'profiles': sum(bool(r['store']) for r in rows), 'physical_proxies': sum(not r['store'] for r in rows),
                     'helper_clones_remaining': re.findall(r'(?:input_boolean|input_datetime|input_number|input_select)\.ep_\w+', json.dumps([house, schedule])),
                     'source_map_count': len(command_sources), 'effects': configs[0]['config']['effect_list']})
assert len(configs) == 88
assert not json.loads((OUT / 'checks.json').read_text())['helper_clones_remaining']
assert all(c['config']['command_topic'] != c['config']['state_topic'] for c in configs)
assert all(c['config']['retain'] is False for c in configs)
print(json.dumps(json.loads((OUT / 'checks.json').read_text()), indent=2))
