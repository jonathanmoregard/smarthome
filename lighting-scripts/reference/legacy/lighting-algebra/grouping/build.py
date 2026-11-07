"""Build pure HA script and proposed groups. Never communicates with HA or Zigbee."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
CATALOG = json.loads((ROOT.parent / 'before/effects_catalog.json').read_text())['config']['sequence'][0]['variables']['result']
MEMBERS = CATALOG['members']

COHORTS = {
    'fx_candle_cross_a': [
        'light.living_room_hall_ceiling', 'light.living_room_window_lamp',
        'light.meditation_floor_lamp', 'light.kitchen_pendant',
    ],
    'fx_candle_cross_b': [
        'light.living_room_desk_ceiling', 'light.living_room_sofa_table_ceiling',
        'light.meditation_ceiling', 'light.kitchen_spots_1',
    ],
    'fx_candle_cross_c': [
        'light.living_room_yellow_retro_lamp', 'light.kitchen_spots_2',
        'light.upper_hall_stair_lamp',
    ],
    'fx_candle_cross_d': [
        'light.living_room_vicky_desk_lamp', 'light.upper_hall_ceiling',
    ],
}

def group(name, lamps):
    endpoints = sorted(e for lamp in lamps for e in MEMBERS[lamp])
    assert len(endpoints) == len(set(endpoints)), (name, 'overlapping lamp ontology')
    return {
        'id': name, 'topic': f'zigbee2mqtt/{name}/set',
        'lamps': lamps, 'members': endpoints, 'verified': False,
        'member_topics': {e: CATALOG['topics'][e] for e in endpoints},
        'phase_cohort': next((key for key, cohort in COHORTS.items() if all(lamp in cohort for lamp in lamps)), name),
        'devices': [CATALOG['topics'][e].removeprefix('zigbee2mqtt/').removesuffix('/set') for e in endpoints],
    }

groups = [group(name, lamps) for name, lamps in COHORTS.items()]
for lamp, endpoints in MEMBERS.items():
    if len(endpoints) > 1:
        groups.append(group('fx_lamp_' + lamp.removeprefix('light.'), [lamp]))

phases = {lamp: lamp for lamp in MEMBERS}
for name, lamps in COHORTS.items():
    for lamp in lamps:
        phases[lamp] = name

config = {
    'alias': 'Effects · Pure multicast plan',
    'description': 'Pure planner: verified complete multicast memberships only; exact payload equality, exclusive endpoint coverage, deterministic largest-first selection, otherwise unicast. Does not call services or read state.',
    'mode': 'parallel', 'max': 50,
    'fields': {'rows': {'required': True, 'selector': {'object': {}}}, 'groups': {'required': True, 'selector': {'object': {}}}},
    'sequence': [
        {'variables': {'result': (ROOT / 'group_plan.jinja').read_text()}},
        {'stop': 'Return transport plan without sending', 'response_variable': 'result'},
    ],
}
(ROOT / 'effects_group_plan.json').write_text(json.dumps(config, indent=2) + '\n')
(ROOT / 'proposed_groups.json').write_text(json.dumps(groups, indent=2) + '\n')
(ROOT / 'candle_phases.json').write_text(json.dumps(phases, indent=2) + '\n')
print(f'Built pure script, {len(groups)} proposed groups, and {len(phases)} lamp phase keys')
