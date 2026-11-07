"""Focused behavioral tests of the actual exported pure Jinja scripts."""
import ast
from copy import deepcopy
from datetime import datetime
import json
import math
from pathlib import Path
import sys
import unittest

sys.path[:0] = [
    '/nix/store/35jf5h0ml9gfbr2w0cwjjj12l8f91al7-jinja2-3.1.6/lib/python3.11/site-packages',
    '/nix/store/0bs4s1cgi7xv82mdbndl8g1jz87c9cdp-markupsafe-3.0.3/lib/python3.11/site-packages',
]
from jinja2 import Environment, StrictUndefined

ROOT = Path(__file__).parent
ENV = Environment(undefined=StrictUndefined)
ENV.filters.update(log=math.log, to_json=json.dumps, from_json=json.loads)


def timestamp(value, default=0):
    try:
        return datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError):
        return default


ENV.globals['as_timestamp'] = timestamp
CONFIGS = {name: json.loads((ROOT / (name + '.json')).read_text()) for name in ['effects_resolve', 'effects_scale']}
TEMPLATES = {name: ENV.from_string(config['sequence'][0]['variables']['result']) for name, config in CONFIGS.items()}
CATALOG = {'effects': {'Candle': {'channels': ['brightness', 'color']}, 'Pulse': {'channels': ['brightness']}, 'Rainbow': {'channels': ['color']}, 'Broken': {'channels': ['power']}}}
DAY = {'brightness': 230, 'color': {'kelvin': 4000}}
COSY = {'brightness': 110, 'color': {'kelvin': 2300}}


def lamp(area='living', **changes):
    return dict({'area': area, 'is_room': False, 'brightness': 110, 'color': {'kelvin': 2300}, 'effect': 'Normal light', 'period': 'cosy', 'on': True, 'day': deepcopy(DAY), 'cosy': deepcopy(COSY)}, **changes)


def constant(value, updated=1):
    return {'kind': 'constant', 'value': value, 'updated': updated}


def effect(name='Candle', updated=1, instance='shared'):
    return {'kind': 'effect', 'effect': name, 'updated': updated, 'instance': instance}


def record(channels, target='lamp_a', scope='lamp', when='2026-10-23T22:00:00+02:00'):
    return {'kind': 'channels', 'target': target, 'scope': scope, 'value': {'channels': channels}, 'when': when}


def run(name, **context):
    defaults = {key: value['default'] for key, value in CONFIGS[name]['fields'].items() if 'default' in value}
    supplied = defaults | context
    before = deepcopy(supplied)
    result = ast.literal_eval(TEMPLATES[name].render(**supplied).strip())
    assert supplied == before
    return result


def resolve(overrides=None, base=None, **extra):
    return run('effects_resolve', base=base or {'lamp_a': lamp()}, overrides=overrides or {}, catalog=CATALOG, **extra)


class ResolverTests(unittest.TestCase):
    def test_channel_precedence_across_scope_and_independent_updates(self):
        overrides = {
            'lamp': record({'brightness': constant(80, 2), 'color': constant({'rgb': [1, 2, 3]}, 5)}),
            'room': record({'brightness': constant(150, 4)}, 'living', 'room'),
            'house': record({'brightness': constant(200, 3)}, 'house', 'house'),
        }
        target = resolve(overrides)['targets']['lamp_a']
        self.assertEqual(target['brightness']['value'], 150)
        self.assertEqual(target['color']['value'], {'rgb': [1, 2, 3]})
        self.assertEqual(target['owners'], {'brightness': 'room', 'color': 'lamp'})

    def test_source_time_beats_record_time_and_ties_are_stable(self):
        records = {'a': record({'brightness': constant(80, 5)}), 'z': record({'brightness': constant(90, 5)}, when='2020-01-01T00:00:00+00:00')}
        self.assertEqual(resolve(records)['targets']['lamp_a']['brightness']['value'], 90)
        self.assertEqual(resolve(records), resolve(dict(reversed(list(records.items())))))

    def test_partial_effect_handoff_preserves_other_channel(self):
        records = {'candle': record({'brightness': effect(), 'color': effect()}), 'blue': record({'color': constant({'rgb': [0, 0, 255]}, 2)})}
        target = resolve(records)['assignments']['lamp_a']
        self.assertEqual(target['brightness']['kind'], 'effect')
        self.assertEqual(target['color']['value'], {'rgb': [0, 0, 255]})

    def test_effect_intensity_uses_underlying_constant_and_then_newer_constant_wins(self):
        records = {'level': record({'brightness': constant(70, 1)}), 'candle': record({'brightness': effect(updated=2), 'color': effect(updated=2)})}
        target = resolve(records)['targets']['lamp_a']
        self.assertEqual(target['brightness']['base'], 70)
        self.assertEqual(target['brightness']['intensity'], 70)
        self.assertEqual(target['level'], 70)
        records['later'] = record({'brightness': constant(150, 3)})
        target = resolve(records)['targets']['lamp_a']
        self.assertEqual(target['brightness']['value'], 150)
        self.assertEqual(target['color']['intensity'], 150)

    def test_stable_record_scale_to_effect_preserves_each_lamp_anchor(self):
        base = {'lamp_a': lamp(), 'lamp_b': lamp(day={'brightness': 200, 'color': {'kelvin': 3500}}, cosy={'brightness': 80, 'color': {'kelvin': 2100}})}
        channels = {channel: {'kind': 'scale', 'position': 0.5, 'updated': 1} for channel in ['brightness', 'color']}
        before = resolve({'remote': record(channels, 'living', 'room')}, base)['targets']
        sources = {channel: dict(effect(updated=3), underlying=source) for channel, source in channels.items()}
        after = resolve({'remote': record(sources, 'living', 'room')}, base)['targets']
        for target in base:
            self.assertEqual(after[target]['level'], before[target]['level'])
            self.assertEqual(after[target]['brightness']['base'], before[target]['brightness']['value'])
            self.assertEqual(after[target]['color']['base'], before[target]['color']['value'])
            self.assertEqual(after[target]['owners'], {'brightness': 'remote', 'color': 'remote'})
        self.assertNotEqual(after['lamp_a']['level'], after['lamp_b']['level'])

    def test_carried_input_uses_original_stamp_against_other_sources(self):
        carried = dict(effect(updated=5), underlying=constant(70, 1))
        records = {'remote': record({'brightness': carried}), 'ui': record({'brightness': constant(150, 3)})}
        target = resolve(records)['targets']['lamp_a']
        self.assertEqual(target['brightness']['kind'], 'effect')
        self.assertEqual(target['brightness']['intensity'], 150)
        records['ui']['value']['channels']['brightness']['updated'] = 0
        self.assertEqual(resolve(records)['targets']['lamp_a']['brightness']['intensity'], 70)
        records['ui']['value']['channels']['brightness']['updated'] = 6
        target = resolve(records)['targets']['lamp_a']
        self.assertEqual(target['brightness']['kind'], 'constant')
        self.assertEqual(target['brightness']['value'], 150)

    def test_repeated_effect_replacement_retains_carried_value_without_claiming_channel(self):
        carried = dict(effect(updated=5), underlying=dict(effect(updated=3), underlying=constant(70, 1)))
        target = resolve({'remote': record({'brightness': carried})})['targets']['lamp_a']
        self.assertEqual(target['brightness']['kind'], 'effect')
        self.assertEqual(target['brightness']['intensity'], 70)
        self.assertEqual(target['brightness']['updated'], 5)

    def test_invalid_or_future_carried_input_does_not_replace_valid_baseline(self):
        for underlying in [constant(70, 10), constant(300, 1), {'kind': 'constant', 'value': 70}, constant(True, 1)]:
            records = {'remote': record({'brightness': dict(effect(updated=5), underlying=underlying)}), 'ui': record({'brightness': constant(150, 3)})}
            target = resolve(records)['targets']['lamp_a']
            self.assertEqual(target['brightness']['kind'], 'effect')
            self.assertEqual(target['brightness']['intensity'], 150)

    def test_different_effects_can_own_different_channels(self):
        target = resolve({'p': record({'brightness': effect('Pulse')}), 'r': record({'color': effect('Rainbow', 2, 'rainbow')})})['targets']['lamp_a']
        self.assertEqual(target['brightness']['effect'], 'Pulse')
        self.assertEqual(target['color']['effect'], 'Rainbow')

    def test_sara_only_common_non_night_and_preserves_flicker(self):
        base = {'lamp_a': lamp(effect='Candle'), 'night': lamp(period='night', effect='Candle'), 'bed': lamp(area='bedroom', effect='Candle')}
        result = resolve(base=base, sara=True, private=['bedroom'])['targets']
        self.assertEqual(result['lamp_a']['color']['value'], {'rgb': [255, 105, 180]})
        self.assertEqual(result['lamp_a']['brightness']['kind'], 'effect')
        self.assertEqual(result['night']['color']['kind'], 'effect')
        self.assertEqual(result['bed']['color']['kind'], 'effect')
        self.assertEqual(resolve(base=base, sara=False)['targets']['lamp_a']['color']['kind'], 'effect')

    def test_fade_ignore_list_is_per_target_and_does_not_drop_shared_record(self):
        overrides = {'house_level': record({'brightness': constant(205, 2)}, 'house', 'house')}
        base = {'lamp_a': lamp(ignore_overrides=['house_level']), 'lamp_b': lamp(area='kitchen')}
        result = resolve(overrides, base)['targets']
        self.assertEqual(result['lamp_a']['brightness']['value'], 110)
        self.assertEqual(result['lamp_b']['brightness']['value'], 205)
        self.assertEqual(overrides['house_level']['value']['channels']['brightness']['value'], 205)

    def test_sara_fade_ignore_is_per_target_and_requires_a_list(self):
        base = {'lamp_a': lamp(ignore_overrides=['mode:sara']), 'lamp_b': lamp(area='kitchen'), 'malformed': lamp(ignore_overrides='mode:sara')}
        result = resolve(base=base, sara=True)['targets']
        self.assertEqual(result['lamp_a']['color']['value'], {'kelvin': 2300})
        self.assertEqual(result['lamp_b']['color']['value'], {'rgb': [255, 105, 180]})
        self.assertEqual(result['malformed']['color']['value'], {'rgb': [255, 105, 180]})

    def test_invalid_sources_fail_to_base_not_older_effect(self):
        for source in [effect('Missing', 2), effect('Broken', 2), effect('Rainbow', 2), constant(256, 2), constant(True, 2), {'kind': 'effect', 'effect': 'Candle', 'updated': 2}]:
            result = resolve({'old': record({'brightness': effect()}), 'new': record({'brightness': source})})['targets']['lamp_a']
            self.assertEqual(result['brightness']['kind'], 'constant')
            self.assertEqual(result['brightness']['value'], 110)
            self.assertEqual(result['brightness']['origin'], 'invalid_source')

    def test_room_target_ignores_lamp_claim_and_house_excludes_private(self):
        base = {'lamp_a': lamp(), 'room:living': lamp(is_room=True), 'bed': lamp(area='bedroom')}
        overrides = {'lamp': record({'brightness': constant(20)}), 'house': record({'color': constant({'rgb': [255, 0, 0]}, 2)}, 'house', 'house')}
        targets = resolve(overrides, base, private=['bedroom'])['targets']
        self.assertEqual(targets['room:living']['level'], 110)
        self.assertEqual(targets['lamp_a']['level'], 20)
        self.assertEqual(targets['bed']['color']['value'], {'kelvin': 2300})

    def test_power_and_period_are_external_inputs_not_override_channels(self):
        overrides = {'attempt': record({'power': constant(True), 'period': constant('day')})}
        overrides['attempt']['value']['period'] = 'day'
        result = resolve(overrides, {'lamp_a': lamp(period='night', effect='Candle')}, power={'living': False})['targets']['lamp_a']
        self.assertFalse(result['on'])
        self.assertEqual(result['period'], 'night')
        self.assertEqual(result['brightness']['kind'], 'effect')

    def test_baseline_channel_restriction_and_legacy_hold(self):
        result = resolve(base={'lamp_a': lamp(effect='Candle', effect_channels=['brightness'])})['targets']['lamp_a']
        self.assertEqual(result['brightness']['kind'], 'effect')
        self.assertEqual(result['color']['kind'], 'constant')
        observed = {'brightness': 18, 'color': {'rgb': [1, 3, 5]}}
        record = {'kind': 'light', 'target': 'lamp_a', 'value': None, 'when': '2026-10-23T22:00:00+02:00'}
        result = resolve({'light:lamp_a': record}, {'lamp_a': lamp(observed=observed)})['targets']['lamp_a']
        self.assertEqual(result['brightness']['value'], 18)
        self.assertEqual(result['color']['value'], observed['color'])

    def test_legacy_effect_brightness_initializes_without_stealing_channel(self):
        record = {'kind': 'light', 'target': 'lamp_a', 'value': {'effect': 'Candle', 'brightness': 95}, 'when': '2026-10-23T22:00:00+02:00'}
        result = resolve({'legacy': record})['targets']['lamp_a']
        self.assertEqual(result['brightness']['kind'], 'effect')
        self.assertEqual(result['brightness']['intensity'], 95)
        self.assertEqual(result['color']['intensity'], 95)

    def test_scale_sources_follow_each_lamp_anchors_and_keep_logical_room_level(self):
        base = {'lamp_a': lamp(), 'room:living': lamp(is_room=True, day={'brightness': 255, 'color': {'kelvin': 4000}})}
        overrides = {'room': record({c: {'kind': 'scale', 'position': 0.5, 'updated': 1} for c in ['brightness', 'color']}, 'living', 'room')}
        targets = resolve(overrides, base)['targets']
        self.assertEqual(targets['lamp_a']['level'], 170)
        self.assertEqual(targets['room:living']['level'], 182.5)
        self.assertEqual(targets['lamp_a']['color']['value'], {'kelvin': 3150})


class ScaleTests(unittest.TestCase):
    def scale(self, position, **changes):
        return run('effects_scale', **({'day': DAY, 'cosy': COSY, 'position': position} | changes))

    def test_anchors_headroom_and_crossover(self):
        for position, anchor in [(0, COSY), (1, DAY)]:
            result = self.scale(position)
            self.assertEqual(result['brightness'], anchor['brightness'])
            self.assertEqual(result['color'], anchor['color'])
        self.assertEqual(self.scale(2)['brightness'], 255)
        self.assertEqual(self.scale(2)['color'], {'kelvin': 6500})
        self.assertEqual(self.scale(-1)['color'], {'rgb': [255, 134, 7]})
        self.assertEqual(self.scale(-2)['color'], {'rgb': [255, 126, 0]})

    def test_monotone_brightness_floor_and_parameter_saturation(self):
        levels = [self.scale(x / 100)['brightness'] for x in range(-300, 301)]
        self.assertEqual(levels, sorted(levels))
        self.assertGreaterEqual(min(levels), 76.5)
        self.assertLessEqual(max(levels), 255)
        self.assertEqual(self.scale(-30), self.scale(-2))
        self.assertEqual(self.scale(30), self.scale(2))

    def test_brightness_and_kelvin_continuity_at_anchors(self):
        for anchor in [0, 1]:
            a, b = self.scale(anchor - 1e-7), self.scale(anchor + 1e-7)
            self.assertLess(abs(a['brightness'] - b['brightness']), 1e-4)
            self.assertLess(abs(a['color']['kelvin'] - b['color']['kelvin']), 1e-3)
        self.assertLess(abs(self.scale(-1 + 1e-7)['color']['kelvin'] - 1950), 1e-3)

    def test_lower_endpoint_reaches_floor_with_equal_or_close_anchors(self):
        for day_level in [110, 120, 230]:
            day = dict(DAY, brightness=day_level)
            self.assertEqual(self.scale(-2, day=day)['brightness'], 76.5)

    def test_mixed_color_anchors_and_existing_low_anchor_survive(self):
        rgb_cosy = dict(COSY, color={'rgb': [180, 20, 150]})
        self.assertEqual(self.scale(0, cosy=rgb_cosy)['color'], rgb_cosy['color'])
        mixed = self.scale(0.5, cosy=rgb_cosy)['color']['rgb']
        self.assertTrue(all(0 <= x <= 255 for x in mixed))
        low = dict(COSY, brightness=10)
        self.assertEqual(self.scale(-0.1, cosy=low)['brightness'], 10)


if __name__ == '__main__':
    unittest.main(verbosity=2)
