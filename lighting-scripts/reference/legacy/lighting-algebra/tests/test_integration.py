"""Exercise production entry points against the isolated action sink."""
import json
import unittest

from dry_harness import RUNTIME, DrySim


class IntegrationTests(unittest.TestCase):
    def configured(self, candidate=True):
        sim = DrySim() if candidate else DrySim(candidate=None)
        for period, values in {
            'day': {'on': True, 'b': 230, 'm': 'ct', 'k': 4100},
            'cosy': {'on': True, 'b': 110, 'm': 'ct', 'k': 2200},
            'night': {'on': True, 'b': 8, 'm': 'hs', 'h': 0, 's': 100},
        }.items():
            sim.store('input_text.ls_house_' + period, values)
        return sim

    def old_targets(self, sim, plan):
        catalog = sim.run('effects_catalog')
        targets = {}
        for command in plan['cmds']:
            lamps = [lamp for entity in command['ids']
                     for lamp in catalog['groups'].get(entity, [entity])]
            for lamp in lamps:
                if command['kind'] == 'ct':
                    targets[lamp] = (command['brightness'], {'kelvin': command['kelvin']})
                elif command['kind'] == 'rgb':
                    targets[lamp] = (command['brightness'], {'rgb': command['rgb']})
        return targets

    def test_scheduled_day_cosy_night_targets_preserve_existing_lamp_ontology(self):
        for hour in [12, 19, 23]:
            with self.subTest(hour=hour):
                old = self.configured(candidate=False)
                new = self.configured()
                timestamp = f'2026-10-23T{hour:02}:30:00+02:00'
                before = old.pure('ls_apply', dry_run=True, force_all=True,
                                  reason='config', test_now=timestamp, test_overrides={})['plan']
                after = new.pure('ls_apply', dry_run=True, force_all=True,
                                 reason='config', test_now=timestamp, test_overrides={})['plan']
                expected = self.old_targets(old, before)
                actual = {lamp: (target['brightness']['value'], target['color']['value'])
                          for lamp, target in after['resolved']['targets'].items()
                          if not target['is_room']}
                self.assertEqual(actual, expected)

    def test_scheduled_profile_off_still_sends_off_to_powered_lamps(self):
        sim = self.configured()
        sim.store('input_text.ls_house_night', {'on': False, 'b': 8, 'm': 'hs', 'h': 0, 's': 100})
        sim.now = sim.now.replace(hour=23, minute=30)
        sim.calls.clear()
        sim.apply( reason='config')
        off = []
        for call in sim.physical():
            if call['action'] in ['light.turn_off', 'homeassistant.turn_off']:
                off.append(call)
            elif call['action'] == 'mqtt.publish' and json.loads(call['data']['payload']).get('state') == 'OFF':
                off.append(call)
        self.assertTrue(off, 'scheduled off profile emitted no off command')

    def test_ordinary_output_preserves_existing_transition_durations(self):
        for hour, minute, reason in [(12, 0, 'config'), (17, 50, 'tick')]:
            with self.subTest(hour=hour, minute=minute, reason=reason):
                old = self.configured(candidate=False)
                new = self.configured()
                old.now = old.now.replace(hour=hour, minute=minute)
                new.now = new.now.replace(hour=hour, minute=minute)
                old_plan = old.pure('ls_apply', dry_run=True, reason=reason)['plan']
                expected = {command['transition'] for command in old_plan['cmds']
                            if command['kind'] in ['ct', 'rgb']}
                new.calls.clear()
                new.apply( reason=reason)
                actual = {json.loads(call['data']['payload'])['transition'] for call in new.physical()
                          if call['action'] == 'mqtt.publish'
                          and 'brightness' in json.loads(call['data']['payload'])}
                self.assertTrue(actual)
                self.assertEqual(actual, expected)

    def test_stable_tick_does_not_resend_ordinary_lamps(self):
        sim = self.configured()
        sim.now = sim.now.replace(hour=12, minute=30)
        sim.calls.clear()
        sim.apply( reason='tick')
        self.assertEqual(sim.physical(), [])

    def test_legacy_hold_fades_back_using_existing_schedule_curve(self):
        lamp = 'light.living_room_hall_ceiling'
        for minute in [41, 50, 59]:
            with self.subTest(minute=minute):
                old, new = self.configured(False), self.configured()
                for sim in [old, new]:
                    sim.put('input_boolean.ls_ovr_next_block_on', 'on')
                record = {'kind': 'light', 'target': lamp, 'value': None,
                          'when': '2026-10-23T17:00:00+02:00'}
                args = dict(dry_run=True, force_all=True, reason='tick',
                            test_now=f'2026-10-23T17:{minute}:00+02:00',
                            test_overrides={'light:' + lamp: record})
                before = old.pure('ls_apply', **args)['plan']
                after = new.pure('ls_apply', **args)['plan']['resolved']['targets'][lamp]
                self.assertEqual((after['brightness']['value'], after['color']['value']),
                                 self.old_targets(old, before)[lamp])
                self.assertEqual(after['owners'], {'brightness': 'base', 'color': 'base'})

    def test_expiring_room_override_releases_logical_level_as_well_as_lamps(self):
        sim = self.configured()
        sim.put('input_boolean.ls_ovr_next_block_on', 'on')
        stamp = sim.env.globals['as_timestamp']('2026-10-23T17:00:00+02:00')
        record = {'kind': 'channels', 'scope': 'room', 'target': 'living_room',
                  'when': '2026-10-23T17:00:00+02:00',
                  'value': {'channels': {'brightness': {'kind': 'constant',
                                                       'value': 250, 'updated': stamp}}}}
        targets = sim.pure('ls_apply', dry_run=True, force_all=True, reason='tick',
                           test_now='2026-10-23T17:50:00+02:00',
                           test_overrides={'channels:room-control': record})['plan']['resolved']['targets']
        self.assertEqual(targets['light.living_room_hall_ceiling']['owners']['brightness'], 'base')
        self.assertEqual(targets['room:living_room']['owners']['brightness'], 'base')
        self.assertLess(targets['room:living_room']['level'], 250)

    def test_synthetic_time_cannot_enter_live_apply_path(self):
        sim = DrySim()
        start = len(sim.calls)
        sim.apply( reason='config', test_now='2026-10-23T12:00:00+02:00')
        self.assertEqual(sim.writes_since(start), [])

    def test_synthetic_overrides_cannot_enter_live_apply_path(self):
        sim = DrySim()
        start = len(sim.calls)
        sim.apply( reason='config', test_overrides={})
        self.assertEqual(sim.writes_since(start), [])

    def test_force_all_cannot_enter_live_apply_path(self):
        sim = DrySim()
        start = len(sim.calls)
        sim.apply( reason='config', force_all=True)
        self.assertEqual(sim.writes_since(start), [])

    def test_synthetic_inputs_are_allowed_in_dry_path(self):
        sim = DrySim()
        result = sim.pure('ls_apply', dry_run=True, reason='config',
                          test_now='2026-10-23T12:00:00+02:00',
                          test_overrides={}, force_all=True)
        self.assertIn('plan', result)


class SwitchRangeTests(unittest.TestCase):
    def setUp(self):
        self.sim = DrySim()
        self.sim.areas.update({'switch.bright': 'living_room', 'switch.cosy': 'living_room',
                              'switch.custom': 'living_room'})
        self.defaults = {'bright': [90, 100], 'cosy': [30, 60]}
        self.ranges = {'switch.bright': {'profile': 'bright'},
                       'switch.cosy': {'profile': 'cosy'},
                       'switch.custom': {'profile': 'custom', 'min': 95, 'max': 100}}

    def plan(self, percent, on=True, extra=None):
        group = {'level': percent * 255 / 100, 'on': on, **(extra or {})}
        return self.sim.pure('ls_switch_plan', targets={'room:living_room': group},
                             ranges=self.ranges, defaults=self.defaults)['switches']

    def test_inclusive_bright_and_cosy_boundaries(self):
        for level, expected in [(89, False), (90, True), (100, True)]:
            self.assertEqual(self.plan(level)['switch.bright']['on'], expected)
        for level, expected in [(29, False), (30, True), (60, True), (61, False)]:
            self.assertEqual(self.plan(level)['switch.cosy']['on'], expected)

    def test_global_changes_only_affect_following_lamps(self):
        before = self.plan(85)
        self.assertFalse(before['switch.bright']['on'])
        self.defaults['bright'] = [80, 100]
        after = self.plan(85)
        self.assertTrue(after['switch.bright']['on'])
        self.assertEqual(before['switch.custom'], after['switch.custom'])
        self.assertEqual(before['switch.cosy'], after['switch.cosy'])

    def test_effect_frame_values_and_period_names_do_not_drive_switches(self):
        expected = self.plan(90)
        for period in ['day', 'cosy', 'night']:
            for rendered in [0, 1, 76, 255]:
                result = self.plan(90, extra={'period': period, 'brightness': rendered,
                                              'color': {'rgb': [255, 105, 180]},
                                              'effect': 'Candle'})
                self.assertEqual(result, expected)

    def test_room_power_wins_even_when_zero_is_in_range(self):
        self.ranges['switch.custom'] = {'profile': 'custom', 'min': 0, 'max': 100}
        for level in [0, 30, 45, 90, 100]:
            self.assertTrue(all(not item['on'] for item in self.plan(level, on=False).values()))

    def test_invalid_intervals_do_not_become_active_rules(self):
        for low, high in [(90, 30), (-1, 40), (0, 101), (None, 90), ('30', 90)]:
            self.ranges['switch.custom'] = {'profile': 'custom', 'min': low, 'max': high}
            self.assertNotIn('switch.custom', self.plan(45))

    def test_single_point_interval_is_valid(self):
        self.ranges['switch.custom'] = {'profile': 'custom', 'min': 45, 'max': 45}
        self.assertTrue(self.plan(45)['switch.custom']['on'])
        self.assertFalse(self.plan(44)['switch.custom']['on'])
        self.assertFalse(self.plan(46)['switch.custom']['on'])


class RemoteEntryPointTests(unittest.TestCase):
    def test_all_remote_commands_have_pure_dry_entry(self):
        for command in ['up', 'down', 'left', 'right', 'toggle', 'reset']:
            with self.subTest(command=command):
                sim = DrySim()
                result = sim.pure('ls_remote_command', source='remote:offline',
                                  area='living_room', command=command, dry_run=True)
                self.assertIn(result['op'], ['set', 'power', 'clear_room'])

    def test_runtime_remote_event_updates_stable_record_through_actual_writer(self):
        sim = DrySim()
        for command in ['up', 'up', 'down']:
            sim.run('ls_remote_command', source='remote:offline',
                    area='living_room', command=command)
            sim.advance(1)
        records = sim.attr('sensor.ls_overrides', 'overrides')
        self.assertEqual(set(records), {'channels:remote:offline'})
        record=records['channels:remote:offline']
        if record['kind']=='input':
            self.assertEqual(record['value']['adjustment']['steps'],1)
            self.assertNotIn('channels',record['value'])
        else:
            self.assertEqual(set(record['value']['channels']),{'brightness','color'})
        self.assertEqual(sim.physical(), [])

    def test_runtime_reset_leaves_room_off(self):
        sim = DrySim()
        sim.run('ls_remote_command', source='remote:offline', area='living_room', command='up')
        sim.advance(1)
        sim.run('ls_remote_command', source='remote:offline', area='living_room', command='toggle')
        sim.advance(1)
        before = len(sim.calls)
        sim.run('ls_remote_command', source='remote:offline', area='living_room', command='reset')
        self.assertFalse(sim.attr('sensor.ls_overrides', 'power')['living_room'])
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), {})
        self.assertFalse(any(call['action'] in ['light.turn_on', 'homeassistant.turn_on']
                             for call in sim.calls[before:]))

    def test_unknown_room_or_command_is_a_dry_noop(self):
        for room, command in [('missing-room', 'up'), ('living_room', 'missing-command')]:
            sim = DrySim()
            result = sim.pure('ls_remote_command', source='remote:offline',
                              area=room, command=command, dry_run=True)
            self.assertEqual(result['op'], 'noop')
            self.assertNotIn('records', result)
            self.assertNotIn('targets', result)


if __name__ == '__main__':
    unittest.main(verbosity=2)
