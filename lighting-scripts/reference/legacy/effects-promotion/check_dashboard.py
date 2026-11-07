"""Read-only promotion checks over exported HA configuration and state."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parent

def read(name, candidate=False):
    data = json.loads((ROOT / ('candidate' if candidate else 'live') / (name + '.json')).read_text())
    return data.get('config', data)

def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)

class PromotionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.house = read('house-lights', True)
        cls.schedule = read('lighting-schedule', True)
        cls.states = {s['entity_id']: s for s in json.loads((ROOT/'live/states_snapshot.json').read_text())}
        cls.sources = read('ui_automation')['variables']['sources']
        cls.catalog = read('effects_ui_catalog')['sequence'][2]['repeat']['for_each']
        cls.discovery = {row['source']:row['config'] for row in cls.catalog}

    def test_main_titles_and_existing_deep_links(self):
        self.assertEqual(self.house['title'], 'House')
        self.assertEqual(self.schedule['title'], 'Lighting schedule')
        self.assertEqual([v['path'] for v in self.house['views']], ['lights', 'lamps'])
        self.assertEqual([v['path'] for v in self.schedule['views']], ['schedule'])

    def test_all_entity_references_exist(self):
        for dashboard in [self.house, self.schedule]:
            refs = set(re.findall(r'\b(?:light|switch|sensor|script|input_boolean|input_text|input_number|input_datetime|input_select)\.[a-z0-9_]+\b', json.dumps(dashboard)))
            self.assertGreater(len(refs), 20)
            for entity in refs:
                with self.subTest(entity=entity):
                    self.assertIn(entity, self.states)

    def test_all_schedule_controls_are_real_native_effect_lights(self):
        controls = {n['entity'] for n in nodes(self.schedule) if str(n.get('entity', '')).startswith('light.')}
        self.assertEqual(len(controls), 66)
        for entity in controls:
            with self.subTest(entity=entity):
                self.assertTrue(entity.startswith('light.ep_ls_'))
                self.assertIn('Candle', self.states[entity]['attributes']['effect_list'])
                source = self.sources[entity.removeprefix('light.')]
                self.assertIn(source.replace('light.', 'input_text.'), self.states)
                self.assertNotIn(self.states[entity]['state'], ('unknown', 'unavailable'))

    def test_discovery_command_and_state_channels_do_not_overlap(self):
        self.assertEqual(len(self.catalog), 88)
        for source, config in self.discovery.items():
            with self.subTest(source=source):
                unique = config['unique_id']
                self.assertEqual(self.sources[unique], source)
                self.assertNotIn('Party', config['effect_list'])
                for channel in ['command_topic', 'brightness_command_topic', 'rgb_command_topic', 'color_temp_command_topic', 'effect_command_topic']:
                    self.assertIn('/set/', config[channel])
                    self.assertTrue(config[channel].startswith('house/v1/effect_preview/'))
                for channel in ['state_topic', 'brightness_state_topic', 'rgb_state_topic', 'color_temp_state_topic', 'effect_state_topic']:
                    self.assertNotIn('/set/', config[channel])
                self.assertFalse(config.get('retain', False))

    def test_all_popup_navigation_targets_resolve_once(self):
        links = [n['navigation_path'] for n in nodes(self.schedule) if str(n.get('navigation_path', '')).startswith('#')]
        hashes = [n['hash'] for n in nodes(self.schedule) if n.get('card_type') == 'pop-up']
        self.assertEqual(len(links), 18)
        self.assertEqual(len(hashes), 18)
        self.assertEqual(len(set(hashes)), 18)
        self.assertEqual(set(links), set(hashes))

    def test_pairing_and_clear_overrides_are_original_controls(self):
        original = read('main_house')
        for entity in ['switch.zigbee2mqtt_bridge_permit_join', 'script.ls_clear_overrides', 'input_boolean.ls_sara_mode_mirror']:
            before = [n for n in nodes(original) if n.get('entity') == entity]
            after = [n for n in nodes(self.house) if n.get('entity') == entity]
            self.assertEqual(before, after)

    def test_all_lamps_exposes_the_real_effect_members(self):
        members = self.states['light.ep_home']['attributes']['group_entities']
        self.assertEqual(len(members), 16)
        fixtures = {n['entity'] for n in nodes(self.house['views'][1]) if str(n.get('entity','')).startswith('light.')}
        self.assertEqual(set(members), fixtures)
        self.assertEqual([self.sources[m.removeprefix('light.')] for m in members], self.states['light.home']['attributes']['entity_id'])

    def test_layout_and_existing_controls_preserved(self):
        old_house = read('preview_house'); old_house['title'] = 'House'
        self.assertEqual(old_house, self.house)
        old_schedule = read('preview_schedule'); old_schedule['title'] = 'Lighting schedule'
        old_schedule['views'][0]['sections'][0]['cards'][0] = self.schedule['views'][0]['sections'][0]['cards'][0]
        self.assertEqual(old_schedule, self.schedule)

    def test_override_notice_is_read_only(self):
        card = self.schedule['views'][0]['sections'][0]['cards'][0]
        self.assertEqual(card['type'], 'markdown')
        self.assertEqual(card['entity_id'], ['sensor.ls_overrides'])
        self.assertIn('Schedule changes are saved', card['content'])
        self.assertIn('/house-lights/lights', card['content'])
        self.assertNotIn('tap_action', card)

    def test_every_schedule_store_has_an_engine_trigger(self):
        triggers = read('engine_automation')['triggers']
        watched = set()
        for trigger in triggers:
            ids = trigger.get('entity_id', [])
            watched.update([ids] if isinstance(ids, str) else ids)
        self.assertTrue(any(t.get('event_type') == 'ls_lamp_store_changed' for t in triggers))
        self.assertTrue(any(t.get('trigger') == 'time_pattern' and t.get('minutes') == '/1' for t in triggers))
        for source in self.sources.values():
            if not source.startswith('light.ls_'):
                continue
            store = source.replace('light.', 'input_text.')
            with self.subTest(store=store):
                if store.startswith('input_text.ls_lamp_'):
                    self.assertIn('ls_lamp_store_changed', json.dumps(read('ls_store')))
                else:
                    self.assertIn(store, watched)

    def test_schedule_timing_and_inheritance_controls_wake_engine(self):
        watched = set()
        for trigger in read('engine_automation')['triggers']:
            ids = trigger.get('entity_id', [])
            watched.update([ids] if isinstance(ids, str) else ids)
        for node in nodes(self.schedule):
            entity = node.get('entity', '')
            if re.fullmatch(r'input_(?:number|datetime|boolean)\.ls_.+_(?:day|cosy|night)_(?:start|weekend|fade|own_timing|own_light)', entity):
                with self.subTest(entity=entity):
                    self.assertIn(entity, watched)

if __name__ == '__main__':
    unittest.main(verbosity=2)
