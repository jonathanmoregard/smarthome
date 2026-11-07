"""Offline wake regression using the real old planner as the lamp oracle."""
import json
import unittest
from datetime import datetime
from pathlib import Path

from dry_harness import DrySim

ROOT = Path('/tmp/lighting-algebra')
AREA = 'jonathan_bedroom'


class RoomWakeBaselineTests(unittest.TestCase):
    def configured(self):
        sim = DrySim()
        # Exercise the edited source without running any shared builder.
        sim.config['ls_base']['sequence'][1]['variables']['result'] = (ROOT / 'base_targets.jinja').read_text()
        self.legacy = json.loads((ROOT / 'before/ls_apply.json').read_text())['config']['sequence'][0]['variables']['plan']
        for period, values in {
            'night': {'on': True, 'b': 3, 'm': 'ct', 'k': 2000},
            'day': {'on': True, 'b': 255, 'm': 'ct', 'k': 5000},
            'cosy': {'on': True, 'b': 90, 'm': 'ct', 'k': 2500},
        }.items():
            sim.store('input_text.ls_house_' + period, values)
        for suffix in ['start', 'weekend']:
            sim.put('input_datetime.ls_house_day_' + suffix, '08:00:00')
        wake = datetime.fromisoformat('2026-10-23T06:00:00+02:00')
        sim.put('input_datetime.ls_' + AREA + '_wake', wake.isoformat(), {'timestamp': wake.timestamp()})
        sim.put('input_number.ls_' + AREA + '_wake_fade', '30')
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        return sim

    def baseline(self, sim, time, overrides=None):
        return sim.pure('ls_base', test_now='2026-10-23T' + time + '+02:00',
                        overrides=overrides or {}, reason='config')['targets']

    def oracle(self, sim, time, lamp):
        plan = sim.render(self.legacy, {'test_now': '2026-10-23T' + time + '+02:00',
                                       'test_overrides': {}, 'reason': 'config', 'force_all': True})
        command = next(c for c in plan['cmds'] if lamp in c['ids'])
        if command['kind'] == 'off':
            return None, None, False
        color = {'kelvin': command['kelvin']} if command['kind'] == 'ct' else {'rgb': command['rgb']}
        return command['brightness'], color, True

    def test_room_tracks_original_wake_fade_and_completed_day_hold(self):
        for time, period in [('05:59:00', 'night'), ('06:00:00', 'night'),
                             ('06:07:00', 'night'), ('06:15:00', 'night'),
                             ('06:29:00', 'night'), ('06:30:00', 'day'),
                             ('07:00:00', 'day'), ('07:50:00', 'day'), ('08:01:00', 'day')]:
            with self.subTest(time=time):
                sim = self.configured()
                lamps = [L for L in sim.members if sim.areas[L] == AREA]
                targets = self.baseline(sim, time)
                room = targets['room:' + AREA]
                expected = self.oracle(sim, time, lamps[0])
                self.assertEqual((room['brightness'], room['color'], room['on']), expected)
                self.assertEqual(room['period'], period)
                for lamp in lamps:
                    self.assertEqual((targets[lamp]['brightness'], targets[lamp]['color'], targets[lamp]['on']), expected)

    def test_wake_uses_room_profiles_without_flattening_lamp_anchors(self):
        sim = self.configured()
        for period, b, k in [('day', 210, 4400), ('night', 11, 2100)]:
            sim.put('input_boolean.ls_' + AREA + '_' + period + '_own_light', 'on')
            sim.store('input_text.ls_' + AREA + '_' + period, {'on': True, 'b': b, 'm': 'ct', 'k': k})
        lamp = next(L for L in sim.members if sim.areas[L] == AREA)
        for period, b, k in [('day', 170, 3900), ('cosy', 60, 2300)]:
            sim.store('input_text.ls_lamp_' + lamp.split('.')[1] + '_' + period,
                      {'own': True, 'on': True, 'b': b, 'm': 'ct', 'k': k})
        targets = self.baseline(sim, '06:15:00')
        room, own = targets['room:' + AREA], targets[lamp]
        self.assertEqual(room['brightness'], 110)
        self.assertEqual(room['color'], {'kelvin': 3250})
        self.assertEqual(own['brightness'], 90)
        self.assertEqual(own['color'], {'kelvin': 3000})
        self.assertEqual(own['day'], {'brightness': 170, 'color': {'kelvin': 3900}})
        self.assertEqual(own['cosy'], {'brightness': 60, 'color': {'kelvin': 2300}})
        self.assertEqual(room['day'], {'brightness': 210, 'color': {'kelvin': 4400}})

    def test_explicit_period_takes_priority_over_wake(self):
        sim = self.configured()
        for kind in ['block', 'channels']:
            record = {'kind': kind, 'target': AREA, 'when': '2026-10-23T06:01:00+02:00'}
            if kind == 'block':
                record['value'] = 'cosy'
            else:
                record.update(scope='room', value={'period': 'cosy', 'channels': {}})
            for time in ['06:15:00', '07:00:00']:
                targets = self.baseline(sim, time, {'override': record})
                room = targets['room:' + AREA]
                self.assertEqual((room['period'], room['brightness'], room['color']),
                                 ('cosy', 90, {'kelvin': 2500}))

    def test_rgb_and_profile_off_fades_match_existing_planner(self):
        for night_on, day_on in [(True, True), (False, True), (True, False)]:
            sim = self.configured()
            sim.store('input_text.ls_house_night', {'on': night_on, 'b': 12, 'm': 'hs', 'h': 20, 's': 100})
            sim.store('input_text.ls_house_day', {'on': day_on, 'b': 250, 'm': 'hs', 'h': 210, 's': 50})
            lamp = next(L for L in sim.members if sim.areas[L] == AREA)
            room = self.baseline(sim, '06:15:00')['room:' + AREA]
            self.assertEqual((room['brightness'], room['color'], room['on']), self.oracle(sim, '06:15:00', lamp))

    def test_regular_schedule_fade_keeps_existing_interpolation(self):
        sim = self.configured()
        lamp = next(L for L in sim.members if sim.areas[L] == AREA)
        room = self.baseline(sim, '17:50:00')['room:' + AREA]
        self.assertEqual((room['brightness'], room['color'], room['on']), self.oracle(sim, '17:50:00', lamp))


if __name__ == '__main__':
    unittest.main()
