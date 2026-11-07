"""Exercise the actual command/store Jinja together with the actual resolver.

These are the build inputs used by the candidate HA scripts, evaluated directly
so command and persistence integration can be checked before the bundle exists.
"""
import copy
import json
import random
import unittest

from dry_harness import DrySim, ROOT
from test_core import CATALOG, base_fixture, constant


class RemoteStoreTests(unittest.TestCase):
    def setUp(self):
        self.sim = DrySim()
        self.sim.config['effects_resolve'] = json.loads((ROOT / 'core/effects_resolve.json').read_text())
        self.base = base_fixture()
        self.sim.areas.update({entity: item['area'] for entity, item in self.base.items()})
        self.catalog = self.sim.run('effects_catalog')
        self.catalog['effects'] = copy.deepcopy(CATALOG['effects'])
        self.source = 'remote:offline'
        self.key = 'channels:' + self.source
        self.command_template = (ROOT / 'remote_command.jinja').read_text()
        self.store_template = (ROOT / 'store_update.jinja').read_text()

    def overrides(self):
        return self.sim.attr('sensor.ls_overrides', 'overrides') or {}

    def apply(self, data):
        attributes = self.sim.render(self.store_template,
                                     {'trigger': {'event': {'data': data,
                                                           'context': {'user_id': 'offline-user'}}}})
        self.sim.service('variable.update_sensor', {'entity_id': 'sensor.ls_overrides'},
                         {'value': self.sim.now.isoformat(), 'attributes': attributes,
                          'replace_attributes': False})

    def command(self, command, source=None, room='living_room'):
        current = self.sim.pure('effects_resolve', base=self.base, catalog=self.catalog,
                                overrides=self.overrides(), private=['bedroom'],
                                power=self.sim.attr('sensor.ls_overrides', 'power') or {})
        result = self.sim.render(self.command_template,
                                 {'source': source or self.source, 'room': room, 'command': command,
                                  'overrides': self.overrides(), 'catalog': self.catalog,
                                  'stamp': self.sim.now.timestamp(),
                                  'current': {'plan': {'base': self.base, 'resolved': current}}})
        self.apply(result)
        self.sim.advance(1)
        return result

    def test_repeated_remote_clicks_reuse_one_record(self):
        rng = random.Random(104)
        self.command('up')
        created = self.overrides()[self.key]['created']
        for _ in range(200):
            self.command(rng.choice(['up', 'down']))
            self.assertEqual(set(self.overrides()), {self.key})
            self.assertEqual(self.overrides()[self.key]['created'], created)
            channels = self.overrides()[self.key]['value']['channels']
            self.assertEqual(set(channels), {'brightness', 'color'})
            self.assertEqual(channels['brightness']['position'], channels['color']['position'])

    def test_effect_selection_changes_only_its_declared_channels(self):
        self.command('up')
        existing = self.overrides()[self.key]
        brightness = copy.deepcopy(existing['value']['channels']['brightness'])
        existing['value']['selection'] = 'Pulse'
        self.sim.put('sensor.ls_overrides', 'fixture', {'overrides': {self.key: existing}})
        self.command('right')  # Pulse -> Colour loop, which owns colour only.
        channels = self.overrides()[self.key]['value']['channels']
        self.assertEqual(channels['brightness'], brightness)
        self.assertEqual(channels['color']['kind'], 'effect')
        self.assertEqual(channels['color']['effect'], 'Colour loop')
        self.assertGreater(channels['color']['updated'], brightness['updated'])

    def test_up_down_reclaims_both_channels_from_effect(self):
        self.command('right')  # Cosy -> Candle.
        self.assertTrue(all(source['kind'] == 'effect'
                            for source in self.overrides()[self.key]['value']['channels'].values()))
        self.command('down')
        channels = self.overrides()[self.key]['value']['channels']
        self.assertEqual(set(channels), {'brightness', 'color'})
        self.assertTrue(all(source['kind'] == 'scale' for source in channels.values()))

    def test_cycle_after_candle_claims_only_next_effect_channels(self):
        self.command('right')  # Cosy -> Candle.
        candle = copy.deepcopy(self.overrides()[self.key]['value']['channels'])
        self.command('right')  # Candle -> Pulse (Sara is a separate toggle).
        record = self.overrides()[self.key]
        self.assertEqual(record['value']['selection'], 'Pulse')
        self.assertNotIn('mode:sara', self.overrides())
        self.assertEqual(record['value']['channels']['color'], candle['color'])
        self.assertEqual(record['value']['channels']['brightness']['effect'], 'Pulse')

    def test_power_does_not_create_or_modify_override_records(self):
        self.command('up')
        before = copy.deepcopy(self.overrides())
        self.command('toggle')
        self.assertFalse(self.sim.attr('sensor.ls_overrides', 'power')['living_room'])
        self.assertEqual(self.overrides(), before)
        self.command('toggle')
        self.assertTrue(self.sim.attr('sensor.ls_overrides', 'power')['living_room'])
        self.assertEqual(self.overrides(), before)

    def test_reset_room_preserves_power_other_rooms_and_global_sara(self):
        self.command('up')
        self.command('up', source='remote:kitchen', room='kitchen')
        self.apply({'op': 'set', 'records': [{'kind': 'mode', 'target': 'sara', 'value': 'on'}]})
        self.command('toggle')
        self.command('reset')
        self.assertNotIn(self.key, self.overrides())
        self.assertIn('channels:remote:kitchen', self.overrides())
        self.assertIn('mode:sara', self.overrides())
        self.assertFalse(self.sim.attr('sensor.ls_overrides', 'power')['living_room'])
        once = copy.deepcopy(self.overrides())
        self.command('reset')
        self.assertEqual(self.overrides(), once)

    def test_partial_app_updates_keep_other_channel_timestamp(self):
        key = 'channels:app'
        first = {'kind': 'channels', 'key': key, 'scope': 'room', 'target': 'living_room',
                 'value': {'channels': {'brightness': constant(90, 100),
                                        'color': constant({'rgb': [30, 40, 50]}, 100)}}}
        self.apply({'op': 'set', 'records': [first]})
        self.sim.advance(10)
        later = {**first, 'value': {'channels': {'color': constant({'rgb': [10, 20, 30]}, 110)}}}
        self.apply({'op': 'set', 'records': [later]})
        channels = self.overrides()[key]['value']['channels']
        self.assertEqual(channels['brightness'], constant(90, 100))
        self.assertEqual(channels['color'], constant({'rgb': [10, 20, 30]}, 110))


if __name__ == '__main__':
    unittest.main(verbosity=2)
