"""Build native HA dashboard candidates; never talks to Home Assistant."""
import copy
import json
from pathlib import Path

ROOT = Path('/tmp/lighting-algebra')
OUT = ROOT / 'ui'


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def number(name, label, initial):
    return {'helper_type': 'input_number', 'helper_id': name, 'name': label,
            'min_value': 0, 'max_value': 100, 'step': 1, 'mode': 'box',
            'unit_of_measurement': '%', 'initial': initial,
            'icon': 'mdi:brightness-percent'}


helpers = []
for profile, title, lo, hi in [('bright', 'Bright Lamps', 90, 100), ('cosy', 'Cosy Lamps', 30, 60)]:
    helpers.extend([number(f'ls_range_{profile}_min', f'{title} Minimum', lo),
                    number(f'ls_range_{profile}_max', f'{title} Maximum', hi)])
write('helpers.json', helpers)

# The native script dialog supplies the entity picker and validates typed fields.
# No input_select holding a stale device inventory is necessary.
fields = {
    'entity': {'name': 'Lamp', 'required': True,
               'description': 'Choose the paired on/off lamp or smart plug.',
               'selector': {'entity': {'filter': [{'domain': 'switch'}, {'domain': 'light'}]}}},
    'profile': {'name': 'Brightness Range', 'required': True, 'default': 'bright',
                'selector': {'select': {'options': [
                    {'value': 'bright', 'label': 'Bright Default'},
                    {'value': 'cosy', 'label': 'Cosy Default'},
                    {'value': 'custom', 'label': 'Own Range'}], 'mode': 'dropdown'}}},
    'minimum': {'name': 'Own Range · From',
                'description': 'Used only with Own Range.',
                'selector': {'number': {'min': 0, 'max': 100, 'step': 1, 'mode': 'box', 'unit_of_measurement': '%'}}},
    'maximum': {'name': 'Own Range · Through',
                'description': 'Used only with Own Range. Both ends are included.',
                'selector': {'number': {'min': 0, 'max': 100, 'step': 1, 'mode': 'box', 'unit_of_measurement': '%'}}}
}
write('ls_range_save_fields.json', fields)

styles = {'margin': '0 6px 6px', 'border': 'var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0))'}

def range_card(profile, title, icon):
    return {'type': 'custom:vertical-stack-in-card', 'styles': copy.deepcopy(styles),
            'cards': [
                {'type': 'heading', 'heading': title, 'heading_style': 'subtitle', 'icon': icon},
                {'type': 'entities', 'show_header_toggle': False, 'entities': [
                    {'entity': f'input_number.ls_range_{profile}_min', 'name': 'From', 'icon': 'mdi:arrow-collapse-down'},
                    {'entity': f'input_number.ls_range_{profile}_max', 'name': 'Through', 'icon': 'mdi:arrow-collapse-up'}]}]}

saved_template = """{% set ranges = state_attr('sensor.ls_overrides', 'switch_ranges') or {} %}
{% set ns = namespace(cards=[]) %}
{% for entity, rule in ranges|dictsort if states[entity] is not none %}
  {% set profile = rule.get('profile', 'bright') %}
  {% set own = profile == 'custom' %}
  {% set minimum = rule.get('min', 0) if own else states('input_number.ls_range_' ~ profile ~ '_min')|int(90 if profile == 'bright' else 30) %}
  {% set maximum = rule.get('max', 100) if own else states('input_number.ls_range_' ~ profile ~ '_max')|int(100 if profile == 'bright' else 60) %}
  {% set label = 'Own Range' if own else ('Bright Default' if profile == 'bright' else 'Cosy Default') %}
  {% set title = entity_name(entity) %}
  {% set room = area_name(entity) or 'No Room Assigned' %}
  {% set ns.cards = ns.cards + [{'type': 'custom:mushroom-template-card', 'entity': entity, 'primary': title, 'secondary': room ~ ' · ' ~ label ~ ' · ' ~ minimum ~ '–' ~ maximum ~ '%', 'icon': 'mdi:power-socket-eu', 'tap_action': {'action': 'none'}, 'hold_action': {'action': 'none'}}] %}
{% endfor %}
{{ ns.cards }}"""

house_template = """{% set ranges = state_attr('sensor.ls_overrides', 'switch_ranges') or {} %}
{% set ns = namespace(cards=[]) %}
{% for entity, rule in ranges|dictsort if states[entity] is not none %}
  {% set ns.cards = ns.cards + [{'type': 'tile', 'entity': entity, 'name': (area_name(entity) or 'Home') ~ ' · ' ~ entity_name(entity), 'icon': 'mdi:power-socket-eu', 'tap_action': {'action': 'toggle'}, 'icon_tap_action': {'action': 'toggle'}, 'hold_action': {'action': 'none'}}] %}
{% endfor %}
{{ ns.cards }}"""

configure = {'type': 'tile', 'entity': 'script.ls_range_save', 'name': 'Configure Lamp…',
             'icon': 'mdi:lightbulb-cog-outline', 'hide_state': True,
             'tap_action': {'action': 'more-info'}, 'icon_tap_action': {'action': 'more-info'}}

switch_view = {'title': 'Switch Lamps', 'path': 'switch-lamps', 'icon': 'mdi:power-socket-eu',
               'type': 'sections', 'max_columns': 2, 'sections': [
    {'type': 'grid', 'cards': [
        {'type': 'heading', 'heading': 'House Defaults', 'icon': 'mdi:home-outline'},
        range_card('bright', 'Bright Lamps', 'mdi:white-balance-sunny'),
        range_card('cosy', 'Cosy Lamps', 'mdi:sofa'),
        {'type': 'markdown', 'text_only': True,
         'content': 'Lamps turn on within their room’s brightness range. Both ends are included.'}]},
    {'type': 'grid', 'cards': [
        {'type': 'heading', 'heading': 'Lamp Ranges', 'icon': 'mdi:lightbulb-group-outline'},
        configure,
        {'type': 'markdown', 'text_only': True,
         'content': "{% set ranges = state_attr('sensor.ls_overrides', 'switch_ranges') or {} %}{% if not ranges %}No switch lamps configured yet. Pair a lamp, assign its room, then choose **Configure Lamp**.{% else %}Choose **Configure Lamp** to change a lamp’s range. Lamps using a default follow changes to House Defaults.{% endif %}"},
        {'type': 'custom:auto-entities', 'card': {'type': 'vertical-stack'},
         'card_param': 'cards', 'show_empty': False, 'filter': {'template': saved_template}}]}
]}
write('switch_lamps_view.json', switch_view)

schedule = json.loads((ROOT / 'before' / 'schedule_dashboard.json').read_text())['config']
existing = {v.get('path') for v in schedule['views']}
assert 'switch-lamps' not in existing
schedule['views'].append(switch_view)
schedule['views'][0]['sections'][0]['cards'].insert(0, {
    'type': 'custom:mushroom-template-card', 'primary': 'Switch Lamps',
    'secondary': 'Brightness Ranges', 'icon': 'mdi:power-socket-eu',
    'tap_action': {'action': 'navigate', 'navigation_path': '/lighting-schedule/switch-lamps'},
    'grid_options': {'columns': 'full'}})
write('schedule_dashboard.json', schedule)

house = json.loads((ROOT / 'before' / 'house_dashboard.json').read_text())['config']
# Auto-entities already installed. Empty registry adds no visible House card.
house['views'][1]['sections'].append({'type': 'grid', 'cards': [
    {'type': 'custom:auto-entities',
     'card': {'type': 'custom:vertical-stack-in-card', 'title': 'Switch Lamps'},
     'card_param': 'cards', 'show_empty': False, 'filter': {'template': house_template}}
]})
write('house_dashboard.json', house)
write('ui_contract.json', {
    'state_entity': 'sensor.ls_overrides',
    'attribute': 'switch_ranges',
    'range_record': {'profile': 'bright|cosy|custom', 'min': 'custom only', 'max': 'custom only'},
    'save_script': 'script.ls_range_save',
    'save_fields': ['entity', 'profile', 'minimum', 'maximum'],
    'global_helpers': [f"input_number.{h['helper_id']}" for h in helpers],
    'eligibility': 'Validate physical on/off switch/light and assigned room; reject override helper switches, bridge permit_join, dimmable bulbs, and aggregate room entities.',
    'discovery': 'Configured switch_ranges keys feed dynamic House tiles and Schedule summaries. Do not require automatic label mutation.',
    'validation': 'Validate both bounds atomically before writing range record. Default profiles are references, not copied bounds.',
    'power': 'House toggle is persistent lamp power, never an expiring channel override.',
    'initial_inventory': 'No physical on/off switches registered at generation time.',
    'no_live_writes': True
})
print('Built four helpers, native script field schema, two dashboard candidates, and contract.')

validation_template = """{% set e = entity | default('') %}
{% set p = profile | default('bright') %}
{% set saved = (state_attr('sensor.ls_overrides', 'switch_ranges') or {}).get(e, {}) %}
{% set lo = minimum if minimum is defined and minimum is not none else saved.get('min') %}
{% set hi = maximum if maximum is defined and maximum is not none else saved.get('max') %}
{% set ns = namespace(errors=[], config={'profile':p}) %}
{% set domain = e.split('.')[0] if e is string else '' %}
{% set blocked = e.startswith(('switch.ls_', 'switch.ep_', 'light.ls_', 'light.ep_')) or 'permit_join' in e if e is string else true %}
{% if domain not in ['switch','light'] or states[e] is none or device_id(e) is none or blocked %}
  {% set ns.errors = ns.errors + ['Choose a physical on/off lamp or smart plug.'] %}
{% elif domain == 'light' and (state_attr(e, 'supported_color_modes') or []) != ['onoff'] %}
  {% set ns.errors = ns.errors + ['Choose an on/off lamp; dimmable lamps use the normal lighting settings.'] %}
{% endif %}
{% if domain in ['switch','light'] and states[e] is not none and area_id(e) is none %}
  {% set ns.errors = ns.errors + ['Assign this lamp to a room before configuring its range.'] %}
{% endif %}
{% if p not in ['bright','cosy','custom'] %}
  {% set ns.errors = ns.errors + ['Choose Bright Default, Cosy Default, or Own Range.'] %}
{% elif p == 'custom' %}
  {% if lo is not number or hi is not number or lo is boolean or hi is boolean or not (0 <= lo <= hi <= 100) %}
    {% set ns.errors = ns.errors + ['Enter both ends of Own Range: 0–100%, with From no higher than Through.'] %}
  {% else %}
    {% set ns.config = dict(ns.config, min=lo, max=hi) %}
  {% endif %}
{% endif %}
{{ {'valid':ns.errors|count == 0, 'errors':ns.errors, 'entity':e, 'config':ns.config} }}"""

save_fields = copy.deepcopy(fields)
save_fields['dry_run'] = {'name': 'Dry Run', 'advanced': True, 'default': False, 'selector': {'boolean': {}}}
save_script = {
    'alias': 'Switch Lamps · Save Range', 'description': 'Validate a physical on/off lamp and save its brightness-range binding. Range configuration is separate from temporary overrides. Dry run returns validation without writing any state or sending any event.',
    'icon': 'mdi:lightbulb-cog-outline', 'mode': 'queued', 'max': 20,
    'fields': save_fields,
    'sequence': [
        {'variables': {'result': validation_template}},
        {'if': [{'condition': 'template', 'value_template': '{{ dry_run | default(false) }}'}],
         'then': [{'stop': 'Return range validation without changes', 'response_variable': 'result'}]},
        {'if': [{'condition': 'template', 'value_template': '{{ not result.valid }}'}],
         'then': [{'stop': "{{ result.errors | join(' ') }}", 'error': True}]},
        {'event': 'ls_override', 'event_data': {
            'op': 'range_set', 'entity': '{{ result.entity }}', 'profile': '{{ result.config.profile }}',
            'min': "{{ result.config.get('min') }}", 'max': "{{ result.config.get('max') }}", 'via': 'schedule-ui'}},
        {'stop': 'Range saved', 'response_variable': 'result'}]
}
write('ls_range_save.json', save_script)

defaults_automation = {
    'id': 'lighting_switch_range_defaults', 'alias': 'Switch Lamps · Validate House Defaults',
    'description': 'Publish complete valid intervals through the sole configuration writer. Invalid editing values leave the last valid defaults active. This automation never operates devices.',
    'mode': 'queued', 'max': 10,
    'triggers': [
        {'trigger': 'state', 'entity_id': [f"input_number.{h['helper_id']}" for h in helpers]},
        {'trigger': 'homeassistant', 'event': 'start'}],
    'actions': [
        {'variables': {
            'requested': "{{ {'bright':[states('input_number.ls_range_bright_min')|float(-1),states('input_number.ls_range_bright_max')|float(-1)],'cosy':[states('input_number.ls_range_cosy_min')|float(-1),states('input_number.ls_range_cosy_max')|float(-1)]} }}"}},
        {'condition': 'template', 'value_template': "{{ 0 <= requested.bright[0] <= requested.bright[1] <= 100 and 0 <= requested.cosy[0] <= requested.cosy[1] <= 100 }}"},
        {'event': 'ls_override', 'event_data': {'op': 'range_defaults', 'ranges': '{{ requested }}', 'via': 'schedule-ui'}}]
}
write('automation_lighting_switch_range_defaults.json', defaults_automation)

# Display committed defaults, not an invalid in-progress helper edit.
for view in schedule['views']:
    if view.get('path') != 'switch-lamps':
        continue
    for i, (profile, fallback) in enumerate([('bright', [90, 100]), ('cosy', [30, 60])], start=1):
        note = "{% set active = (state_attr('sensor.ls_overrides', 'range_defaults') or {}).get('" + profile + "', " + str(fallback) + ") %}{% set lo = states('input_number.ls_range_" + profile + "_min')|float(-1) %}{% set hi = states('input_number.ls_range_" + profile + "_max')|float(-1) %}{% if not (0 <= lo <= hi <= 100) %}From must not exceed Through. {% endif %}Active: {{ active[0]|int }}–{{ active[1]|int }}%."
        view['sections'][0]['cards'][i]['cards'].append({'type': 'markdown', 'text_only': True, 'content': note})
    auto = view['sections'][1]['cards'][-1]
    template = auto['filter']['template']
    template = template.replace("{% set own = profile == 'custom' %}", "{% set own = profile == 'custom' %}\n  {% set pair = (state_attr('sensor.ls_overrides', 'range_defaults') or {}).get(profile, [90,100] if profile == 'bright' else [30,60]) %}")
    template = template.replace("states('input_number.ls_range_' ~ profile ~ '_min')|int(90 if profile == 'bright' else 30)", "pair[0]")
    template = template.replace("states('input_number.ls_range_' ~ profile ~ '_max')|int(100 if profile == 'bright' else 60)", "pair[1]")
    auto['filter']['template'] = template
    switch_view = view
write('switch_lamps_view.json', switch_view)
write('schedule_dashboard.json', schedule)
contract = json.loads((OUT / 'ui_contract.json').read_text())
contract['defaults_attribute'] = 'range_defaults'
contract['defaults_record'] = {'bright': [90, 100], 'cosy': [30, 60]}
contract['write_events'] = {'range_set': '{entity,profile,min,max}', 'range_defaults': '{ranges:{bright:[min,max],cosy:[min,max]}}'}
write('ui_contract.json', contract)
print('Built save validator, defaults automation, and committed-range summaries.')
