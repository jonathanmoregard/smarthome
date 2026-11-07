"""Behavioral and seeded relational tests of the actual pure HA scripts."""
import copy
import json
import os
import random
import unittest
from pathlib import Path

from dry_harness import DrySim, ROOT

LIVING = 'light.test_living_a'
OTHER = 'light.test_living_b'
KITCHEN = 'light.test_kitchen'
PRIVATE = 'light.test_bedroom'
STAMP = 1_800_000_000
CATALOG = {'effects': {
    'Candle': {'channels': ['brightness', 'color'], 'renderer': 'script.effect_candle_frame'},
    'Pulse': {'channels': ['brightness'], 'renderer': 'script.effect_pulse_frame'},
    'Colour loop': {'channels': ['color'], 'renderer': 'script.effect_colour_frame'},
}}


def constant(value, stamp=STAMP):
    return {'kind': 'constant', 'value': value, 'updated': stamp}


def effect(name='Candle', stamp=STAMP, instance='shared-effect'):
    return {'kind': 'effect', 'effect': name, 'instance': instance, 'updated': stamp}


def record(target, channels, scope='lamp', when='2026-10-23T12:00:00+02:00'):
    return {'kind': 'channels', 'scope': scope, 'target': target, 'when': when,
            'value': {'channels': channels}}


def base_fixture(period='cosy'):
    day = {'brightness': 220, 'color': {'kelvin': 4000}}
    cosy = {'brightness': 110, 'color': {'kelvin': 2200}}
    rows = [(LIVING, 'living_room', False), (OTHER, 'living_room', False),
            (KITCHEN, 'kitchen', False), (PRIVATE, 'bedroom', False),
            ('room:living_room', 'living_room', True),
            ('room:kitchen', 'kitchen', True), ('room:bedroom', 'bedroom', True)]
    return {entity: {'area': area, 'is_room': is_room, 'brightness': 110,
                     'color': {'kelvin': 2200}, 'effect': 'Normal light',
                     'period': period, 'on': True, 'day': copy.deepcopy(day),
                     'cosy': copy.deepcopy(cosy),
                     'observed': {'brightness': 81, 'color': {'rgb': [20, 30, 40]}}}
            for entity, area, is_room in rows}


class CoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim = DrySim()
        for name in ['effects_resolve', 'effects_scale']:
            path = Path(os.environ.get('LIGHTING_CORE_DIR', ROOT / 'candidate')) / (name + '.json')
            if not path.exists():
                path = ROOT / 'core' / (name + '.json')
            value = json.loads(path.read_text())
            cls.sim.config[name] = value.get('config', value)

    def resolve(self, overrides=None, base=None, **kwargs):
        return self.sim.pure('effects_resolve', base=base or base_fixture(),
                             overrides=overrides or {}, catalog=CATALOG,
                             private=['bedroom'], **kwargs)

    def test_independent_latest_channels_and_revealed_previous_owner(self):
        records = {
            'lamp-old': record(LIVING, {'brightness': effect(stamp=STAMP),
                                      'color': effect(stamp=STAMP)}),
            'room-new': record('living_room', {'color': constant({'rgb': [4, 8, 16]}, STAMP + 1)}, 'room'),
        }
        target = self.resolve(records)['targets'][LIVING]
        self.assertEqual(target['brightness']['kind'], 'effect')
        self.assertEqual(target['color']['value'], {'rgb': [4, 8, 16]})
        self.assertEqual(target['owners']['color'], 'room-new')
        del records['room-new']
        self.assertEqual(self.resolve(records)['targets'][LIVING]['color']['kind'], 'effect')

    def test_new_room_command_beats_old_lamp_and_new_lamp_beats_room(self):
        records = {'lamp': record(LIVING, {'brightness': constant(80)}),
                   'room': record('living_room', {'brightness': constant(180, STAMP + 1)}, 'room')}
        result = self.resolve(records)['targets']
        self.assertEqual(result[LIVING]['brightness']['value'], 180)
        self.assertEqual(result[OTHER]['brightness']['value'], 180)
        records['lamp']['value']['channels']['brightness']['updated'] = STAMP + 2
        result = self.resolve(records)['targets']
        self.assertEqual(result[LIVING]['brightness']['value'], 80)
        self.assertEqual(result[OTHER]['brightness']['value'], 180)

    def test_only_claimed_channel_stamp_changes_priority(self):
        records = {'remote': record('living_room', {'brightness': constant(80),
                                                   'color': constant({'rgb': [20, 30, 40]})}, 'room'),
                   'lamp': record(LIVING, {'brightness': constant(180, STAMP + 1)})}
        before = self.resolve(records)['targets'][LIVING]['brightness']
        records['remote']['when'] = '2040-01-01T00:00:00+00:00'
        records['remote']['value']['channels']['color'] = constant({'rgb': [255, 0, 20]}, STAMP + 2)
        after = self.resolve(records)['targets'][LIVING]
        self.assertEqual(after['brightness'], before)
        self.assertEqual(after['color']['value'], {'rgb': [255, 0, 20]})

    def test_partial_effects_can_coexist(self):
        records = {'pulse': record(LIVING, {'brightness': effect('Pulse')}),
                   'colour': record(LIVING, {'color': effect('Colour loop', STAMP + 1)})}
        result = self.resolve(records)
        target = result['targets'][LIVING]
        self.assertEqual(target['brightness']['effect'], 'Pulse')
        self.assertEqual(target['color']['effect'], 'Colour loop')
        self.assertIn(LIVING, result['assignments'])
        self.assertNotIn('room:living_room', result['assignments'])

    def test_shared_instance_identity_survives_per_lamp_resolution(self):
        records = {'house-candle': record('house', {'brightness': effect(), 'color': effect()}, 'house')}
        targets = self.resolve(records)['targets']
        for entity in [LIVING, OTHER, KITCHEN]:
            self.assertEqual(targets[entity]['brightness']['instance'], 'shared-effect')
            self.assertEqual(targets[entity]['color']['instance'], 'shared-effect')
        self.assertEqual(targets[PRIVATE]['brightness']['kind'], 'constant')

    def test_stable_remote_scale_to_effect_keeps_each_lamps_underlying_level(self):
        base = base_fixture()
        base[OTHER]['day']['brightness'] = 180
        base[OTHER]['cosy']['brightness'] = 90
        scale = {'kind': 'scale', 'position': 0.5, 'updated': STAMP}
        before = self.resolve({'remote': record('living_room', {'brightness': scale, 'color': scale}, 'room')}, base)
        claimed = {channel: {**effect(stamp=STAMP + 10), 'underlying': copy.deepcopy(scale)}
                   for channel in ['brightness', 'color']}
        after = self.resolve({'remote': record('living_room', claimed, 'room')}, base)
        levels = []
        for lamp in [LIVING, OTHER]:
            old = before['targets'][lamp]
            new = after['targets'][lamp]
            self.assertEqual(new['brightness']['kind'], 'effect')
            self.assertEqual(new['brightness']['base'], old['brightness']['value'])
            self.assertEqual(new['brightness']['intensity'], old['brightness']['value'])
            self.assertEqual(new['color']['base'], old['color']['value'])
            self.assertEqual(new['level'], old['level'])
            levels.append(new['level'])
        self.assertNotEqual(*levels)

    def test_carried_old_baseline_does_not_mask_newer_other_source(self):
        scale = {'kind': 'scale', 'position': 0.5, 'updated': STAMP}
        channels = {channel: {**effect(stamp=STAMP + 20), 'underlying': copy.deepcopy(scale)}
                    for channel in ['brightness', 'color']}
        records = {'remote': record('living_room', channels, 'room'),
                   'app': record(LIVING, {'brightness': constant(190, STAMP + 10),
                                         'color': constant({'rgb': [20, 40, 80]}, STAMP + 10)})}
        target = self.resolve(records)['targets'][LIVING]
        self.assertEqual(target['brightness']['kind'], 'effect')
        self.assertEqual(target['owners']['brightness'], 'remote')
        self.assertEqual(target['brightness']['intensity'], 190)
        self.assertEqual(target['color']['base'], {'rgb': [20, 40, 80]})

    def test_sara_preserves_brightness_and_candle_instance(self):
        records = {'candle': record('house', {'brightness': effect(), 'color': effect()}, 'house')}
        ordinary = self.resolve(records)['targets']
        pink = self.resolve(records, sara=True)['targets']
        for entity in ordinary:
            self.assertEqual(pink[entity]['brightness'], ordinary[entity]['brightness'])
        self.assertEqual(pink[LIVING]['color']['value'], {'rgb': [255, 105, 180]})
        self.assertEqual(pink[PRIVATE]['color'], ordinary[PRIVATE]['color'])
        self.assertEqual(self.resolve(records)['targets'], ordinary)

    def test_sara_checks_effective_period_per_target(self):
        base = base_fixture('day')
        base[LIVING]['period'] = 'night'
        records = {'colour': record('house', {'color': constant({'rgb': [5, 10, 15]}, STAMP + 100)}, 'house')}
        targets = self.resolve(records, base, sara=True)['targets']
        self.assertEqual(targets[LIVING]['color']['value'], {'rgb': [5, 10, 15]})
        self.assertEqual(targets[OTHER]['color']['value'], {'rgb': [255, 105, 180]})
        night = self.resolve(records, base_fixture('night'), sara=True)['targets']
        plain = self.resolve(records, base_fixture('night'))['targets']
        self.assertEqual(night, plain)

    def test_power_gates_without_discarding_channel_owners(self):
        records = {'candle': record('living_room', {'brightness': effect(), 'color': effect()}, 'room')}
        enabled = self.resolve(records)['targets']
        disabled = self.resolve(records, power={'living_room': False})['targets']
        for entity in [LIVING, OTHER, 'room:living_room']:
            self.assertFalse(disabled[entity]['on'])
            self.assertEqual(disabled[entity]['brightness'], enabled[entity]['brightness'])
            self.assertEqual(disabled[entity]['color'], enabled[entity]['color'])
        self.assertTrue(disabled[KITCHEN]['on'])
        cleared = self.resolve({}, power={'living_room': False})['targets']
        self.assertFalse(cleared[LIVING]['on'])

    def test_lexical_tie_is_deterministic(self):
        a = record(LIVING, {'brightness': constant(80)})
        z = record(LIVING, {'brightness': constant(190)})
        first = self.resolve({'z': z, 'a': a})
        second = self.resolve({'a': a, 'z': z})
        self.assertEqual(first, second)
        self.assertEqual(first['targets'][LIVING]['brightness']['value'], 190)

    def test_missing_source_timestamp_uses_record_time(self):
        earlier = record(LIVING, {'brightness': {'kind': 'constant', 'value': 80}},
                         when='2026-10-23T12:00:00+02:00')
        later = record('living_room', {'brightness': {'kind': 'constant', 'value': 190}}, 'room',
                       when='2026-10-23T12:01:00+02:00')
        result = self.resolve({'later': later, 'earlier': earlier})['targets'][LIVING]
        self.assertEqual(result['brightness']['value'], 190)

    def test_effect_frames_cannot_change_logical_room_level(self):
        plain = self.resolve()['targets']['room:living_room']['level']
        records = {'pulse': record('living_room', {'brightness': effect('Pulse')}, 'room')}
        result = self.resolve(records)['targets']['room:living_room']
        self.assertEqual(result['level'], plain)
        self.sim.advance(1000)
        self.assertEqual(self.resolve(records)['targets']['room:living_room']['level'], plain)

    def test_invalid_new_claim_falls_back_without_reviving_old_effect(self):
        records = {'old': record(LIVING, {'color': effect()}),
                   'new': record(LIVING, {'color': effect('Missing', STAMP + 1)})}
        target = self.resolve(records)['targets'][LIVING]
        self.assertEqual(target['color']['kind'], 'constant')
        self.assertEqual(target['color']['value'], base_fixture()[LIVING]['color'])

    def test_effect_cannot_claim_a_channel_it_does_not_declare(self):
        records = {'wrong-channel': record(LIVING, {'color': effect('Pulse')})}
        target = self.resolve(records)['targets'][LIVING]
        self.assertEqual(target['color']['kind'], 'constant')
        self.assertEqual(target['color']['value'], base_fixture()[LIVING]['color'])

    def test_legacy_null_hold_preserves_observed_lamp_state(self):
        records = {'light:' + LIVING: {'kind': 'light', 'target': LIVING, 'value': None,
                                      'when': '2026-10-23T12:00:00+02:00'}}
        target = self.resolve(records)['targets'][LIVING]
        self.assertEqual(target['brightness']['value'], 81)
        self.assertEqual(target['color']['value'], {'rgb': [20, 30, 40]})

    def test_malformed_channel_values_never_reach_outputs(self):
        invalid = {'brightness': [None, True, -1, 256, float('nan'), float('inf'), '120'],
                   'color': [None, {'rgb': [0, 0]}, {'rgb': [0, 0, 256]},
                             {'rgb': [0, 0, False]}, {'kelvin': 0},
                             {'kelvin': 2200, 'rgb': [255, 0, 0]}]}
        for channel, values in invalid.items():
            for value in values:
                with self.subTest(channel=channel, value=value):
                    target = self.resolve({'invalid': record(LIVING, {channel: constant(value)})})['targets'][LIVING]
                    self.assertEqual(target[channel]['kind'], 'constant')
                    self.assertEqual(target[channel]['value'], base_fixture()[LIVING][channel])

    def test_randomized_scope_isolation_field_independence_and_order(self):
        rng = random.Random(20261023)
        for case in range(500):
            with self.subTest(case=case):
                records = {}
                for index in range(rng.randrange(1, 12)):
                    scope, target = rng.choice([('lamp', LIVING), ('lamp', OTHER),
                                                ('room', 'living_room'), ('room', 'kitchen'),
                                                ('house', 'house')])
                    channel = rng.choice(['brightness', 'color'])
                    value = rng.randrange(256) if channel == 'brightness' else {'rgb': [rng.randrange(256) for _ in range(3)]}
                    records[f'r-{index}'] = record(target, {channel: constant(value, STAMP + index)}, scope)
                before = self.resolve(records)
                items = list(records.items())
                rng.shuffle(items)
                self.assertEqual(self.resolve(dict(items)), before)
                newest = copy.deepcopy(records)
                brightness = rng.randrange(256)
                newest['remote-newest'] = record('living_room', {'brightness': constant(brightness, STAMP + 100)}, 'room')
                after = self.resolve(newest)
                for entity in [LIVING, OTHER, 'room:living_room']:
                    self.assertEqual(after['targets'][entity]['brightness']['value'], brightness)
                    self.assertEqual(after['targets'][entity]['color'], before['targets'][entity]['color'])
                for entity in [KITCHEN, PRIVATE, 'room:kitchen', 'room:bedroom']:
                    self.assertEqual(after['targets'][entity], before['targets'][entity])

    def scale(self, position, day=None, cosy=None):
        return self.sim.pure('effects_scale', position=position,
                             day=day or {'brightness': 220, 'color': {'kelvin': 4000}},
                             cosy=cosy or {'brightness': 110, 'color': {'kelvin': 2200}})

    def test_scale_recovers_anchors_and_rgb_crossover(self):
        self.assertEqual(self.scale(0)['brightness'], 110)
        self.assertEqual(self.scale(0)['color'], {'kelvin': 2200})
        self.assertEqual(self.scale(1)['brightness'], 220)
        self.assertEqual(self.scale(1)['color'], {'kelvin': 4000})
        self.assertEqual(self.scale(-1)['color'], {'rgb': [255, 134, 7]})
        self.assertEqual(self.scale(-2)['color'], {'rgb': [255, 126, 0]})
        self.assertEqual(self.scale(2)['brightness'], 255)

    def test_scale_color_keeps_moving_after_brightness_saturates(self):
        low = [self.scale(value) for value in [-1, -1.5, -2]]
        self.assertEqual(len({frame['brightness'] for frame in low}), 1)
        self.assertNotEqual(low[0]['color'], low[-1]['color'])
        day = {'brightness': 255, 'color': {'kelvin': 4000}}
        high = [self.scale(value, day=day) for value in [1, 1.5, 2]]
        self.assertTrue(all(frame['brightness'] == 255 for frame in high))
        self.assertNotEqual(high[0]['color'], high[-1]['color'])

    def test_scale_reaches_floor_even_with_close_or_equal_anchor_levels(self):
        cosy = {'brightness': 110, 'color': {'kelvin': 2200}}
        for day_b in [110, 120, 220]:
            with self.subTest(day_b=day_b):
                day = {'brightness': day_b, 'color': {'kelvin': 4000}}
                self.assertEqual(self.scale(-2, day=day, cosy=cosy)['brightness'], 76.5)

    def test_scale_preserves_configured_dim_anchors_without_brightening_on_down(self):
        cosy = {'brightness': 30, 'color': {'rgb': [255, 0, 0]}}
        day = {'brightness': 180, 'color': {'kelvin': 4000}}
        for position in [0, -0.25, -1, -2]:
            self.assertLessEqual(self.scale(position, day=day, cosy=cosy)['brightness'], 30)

    def test_mixed_rgb_and_white_anchors_preserve_endpoints_and_valid_colours(self):
        for day_color, cosy_color in [({'kelvin': 4000}, {'rgb': [20, 30, 255]}),
                                      ({'rgb': [255, 90, 20]}, {'kelvin': 2200}),
                                      ({'rgb': [0, 255, 0]}, {'rgb': [0, 0, 255]})]:
            day = {'brightness': 220, 'color': day_color}
            cosy = {'brightness': 110, 'color': cosy_color}
            self.assertEqual(self.scale(0, day=day, cosy=cosy)['color'], cosy_color)
            self.assertEqual(self.scale(1, day=day, cosy=cosy)['color'], day_color)
            for position in [-1.5, -0.5, 0.25, 0.75, 1.5]:
                color = self.scale(position, day=day, cosy=cosy)['color']
                self.assertEqual(len(color), 1)
                if 'rgb' in color:
                    self.assertTrue(all(0 <= component <= 255 for component in color['rgb']))
                else:
                    self.assertTrue(1000 <= color['kelvin'] <= 10000)

    def test_randomized_scale_is_monotone_and_bounded(self):
        rng = random.Random(1950)
        for case in range(150):
            cosy_b = rng.randrange(77, 180)
            day_b = rng.randrange(cosy_b, 256)
            cosy = {'brightness': cosy_b, 'color': {'kelvin': rng.randrange(1950, 2801)}}
            day = {'brightness': day_b, 'color': {'kelvin': rng.randrange(3000, 6501)}}
            positions = sorted([-2, -1, 0, 1, 2] + [rng.uniform(-3, 3) for _ in range(10)])
            frames = [self.scale(value, day=day, cosy=cosy) for value in positions]
            levels = [frame['brightness'] for frame in frames]
            self.assertEqual(levels, sorted(levels), case)
            for frame in frames:
                self.assertGreaterEqual(frame['brightness'], 76.5)
                self.assertLessEqual(frame['brightness'], 255)
                self.assertGreaterEqual(frame['position'], -2)
                self.assertLessEqual(frame['position'], 2)
                color = frame['color']
                self.assertEqual(len(color), 1)
                if 'rgb' in color:
                    self.assertEqual(len(color['rgb']), 3)
                    self.assertTrue(all(0 <= value <= 255 for value in color['rgb']))
                else:
                    self.assertTrue(1950 <= color['kelvin'] <= 6500)


if __name__ == '__main__':
    unittest.main(verbosity=2)
