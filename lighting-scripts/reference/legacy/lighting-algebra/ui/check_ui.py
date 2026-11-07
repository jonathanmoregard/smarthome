"""Offline behavioral checks of the exact native dashboard/script candidates."""
import copy
import json
import random
import sys
from pathlib import Path
sys.path.insert(0, '/tmp/lighting-algebra/tests')
from dry_harness import DrySim

ROOT = Path('/tmp/lighting-algebra')
UI = ROOT / 'ui'
load = lambda name: json.loads((UI / name).read_text())

class RangeSim(DrySim):
    def event(self, name, data):
        # Capture the script boundary; parent tests the sole writer separately.
        self.events.append((name, copy.deepcopy(data)))

sim = RangeSim(candidate=None)
sim.config['ls_range_save'] = load('ls_range_save.json')
sim.automations['defaults'] = load('automation_lighting_switch_range_defaults.json')
sim.env.globals.update(device_id=lambda e: 'device-' + e if e in ['switch.test_plug', 'light.test_onoff', 'light.test_dimmable', 'switch.zigbee2mqtt_bridge_permit_join'] else None,
                       entity_name=lambda e: {'switch.test_plug': 'Window Lamp', 'light.test_onoff': 'Bright LED'}.get(e, e),
                       area_name=lambda e: 'Living Room' if sim.areas.get(e) else None)
for e, attrs in [('switch.test_plug', {}), ('light.test_onoff', {'supported_color_modes': ['onoff']}), ('light.test_dimmable', {'supported_color_modes': ['brightness']}), ('switch.zigbee2mqtt_bridge_permit_join', {})]:
    sim.put(e, 'off', attrs)
    sim.areas[e] = 'living_room'

for entity in ['switch.test_plug', 'light.test_onoff']:
    result = sim.pure('ls_range_save', entity=entity, profile='bright', dry_run=True)
    assert result['valid'] and result['config'] == {'profile': 'bright'}
for entity in ['light.test_dimmable', 'switch.zigbee2mqtt_bridge_permit_join', 'switch.not_real', 'switch.ls_lamp_kitchen_pendant_day_override']:
    assert not sim.pure('ls_range_save', entity=entity, profile='bright', dry_run=True)['valid']
sim.areas.pop('switch.test_plug')
assert not sim.pure('ls_range_save', entity='switch.test_plug', profile='bright', dry_run=True)['valid']
sim.areas['switch.test_plug'] = 'living_room'

rng = random.Random(2388)
for _ in range(700):
    lo, hi = rng.randint(-20, 120), rng.randint(-20, 120)
    result = sim.pure('ls_range_save', entity='switch.test_plug', profile='custom', minimum=lo, maximum=hi, dry_run=True)
    assert result['valid'] == (0 <= lo <= hi <= 100)
    if result['valid']:
        assert result['config'] == {'profile': 'custom', 'min': lo, 'max': hi}
for lo, hi in [(None, 100), (0, None), ('30', 60), (30, '60'), (float('nan'), 100), (0, float('inf')), (False, 100)]:
    assert not sim.pure('ls_range_save', entity='switch.test_plug', profile='custom', minimum=lo, maximum=hi, dry_run=True)['valid']
print('PASS: physical-entity validation, 700 seeded range cases, invalid inputs, dry-run purity')

sim.calls.clear(); sim.events.clear()
sim.run('ls_range_save', entity='switch.test_plug', profile='custom', minimum=30, maximum=60)
assert sim.events == [('ls_override', {'op': 'range_set', 'entity': 'switch.test_plug', 'profile': 'custom', 'min': 30, 'max': 60, 'via': 'schedule-ui'})]
assert not sim.calls
for profile, pair in [('bright', [90,100]), ('cosy', [30,60])]:
    for suffix, value in zip(['min', 'max'], pair): sim.put(f'input_number.ls_range_{profile}_{suffix}', value)
sim.events.clear()
sim.run_automation('defaults', {})
assert sim.events[-1][1]['ranges']['bright'] == [90., 100.]
sim.events.clear()
sim.put('input_number.ls_range_bright_min', 101)
sim.run_automation('defaults', {})
assert sim.events == []
print('PASS: saves emit only configuration events; invalid default drafts emit nothing')

schedule = load('schedule_dashboard.json')
house = load('house_dashboard.json')
original_schedule = json.loads((ROOT / 'before/schedule_dashboard.json').read_text())['config']
original_house = json.loads((ROOT / 'before/house_dashboard.json').read_text())['config']
old_schedule = copy.deepcopy(schedule); old_schedule['views'].pop(); old_schedule['views'][0]['sections'][0]['cards'].pop(0)
old_house = copy.deepcopy(house); old_house['views'][1]['sections'].pop()
assert old_schedule == original_schedule
assert old_house == original_house

view = schedule['views'][-1]
saved_template = view['sections'][1]['cards'][-1]['filter']['template']
house_template = house['views'][1]['sections'][-1]['cards'][0]['filter']['template']
sim.put('sensor.ls_overrides', 'same', {'overrides': {}, 'switch_ranges': {}, 'range_defaults': {'bright': [90,100], 'cosy':[30,60]}})
assert sim.render(saved_template, {}) == []
assert sim.render(house_template, {}) == []
attrs = sim.state['sensor.ls_overrides']['attributes']
attrs['switch_ranges'] = {'switch.test_plug': {'profile':'cosy'}, 'light.test_onoff': {'profile':'custom','min':95,'max':100}, 'switch.deleted': {'profile':'bright'}}
rendered = sim.render(saved_template, {})
assert len(rendered) == 2
assert any('Cosy Default · 30–60%' in c['secondary'] for c in rendered)
assert any('Own Range · 95–100%' in c['secondary'] for c in rendered)
attrs['range_defaults']['cosy'] = [35,65]
rendered = sim.render(saved_template, {})
assert any('Cosy Default · 35–65%' in c['secondary'] for c in rendered)
assert any('Own Range · 95–100%' in c['secondary'] for c in rendered)
rendered_house = sim.render(house_template, {})
assert {c['entity'] for c in rendered_house} == {'switch.test_plug', 'light.test_onoff'}
assert all(c['tap_action'] == {'action': 'toggle'} and 'features' not in c for c in rendered_house)
note = sim.render(view['sections'][0]['cards'][1]['cards'][-1]['content'], {})
assert 'From must not exceed Through' in note and 'Active: 90–100%' in note
print('PASS: dynamic defaults/custom ranges, missing entities, House power-only controls, invalid-draft warning')

for path in UI.glob('*.json'): json.loads(path.read_text())
def refs(obj):
    result = set()
    if isinstance(obj, dict):
        if isinstance(obj.get('entity'), str): result.add(obj['entity'])
        for value in obj.values(): result |= refs(value)
    elif isinstance(obj, list):
        for value in obj: result |= refs(value)
    return result
expected = {f"input_number.{h['helper_id']}" for h in load('helpers.json')} | {'script.ls_range_save'}
assert (refs(schedule) | refs(house)) - (refs(original_schedule) | refs(original_house)) == expected
print('PASS: JSON, references, and exact preservation of existing dashboard content')
