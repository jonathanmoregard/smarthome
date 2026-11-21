import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from scripts.audit_response_consumers import (
    dashboard_paths,
    find_response_consumers,
    inventory_changes,
    load_config,
    unexpected_response_consumers,
)


class ResponseConsumerAuditTests(unittest.TestCase):
    def test_finds_only_response_bearing_calls_to_shimmed_entrypoints(self):
        documents = [
            ('retained.json', {'actions': [
                {'action': 'script.ls_apply', 'response_variable': 'plan'},
                {'action': 'script.ls_apply'},
                {'action': 'script.effects_catalog', 'response_variable': 'catalog'},
            ]}),
            ('dashboard.json', {'tap_action': {
                'service': 'script.ls_override_block',
                'response_variable': 'result',
            }}),
        ]

        self.assertEqual(find_response_consumers(
            documents, {'ls_apply', 'ls_override_block'}), [
                {'source': 'retained.json', 'script': 'ls_apply', 'response_variable': 'plan'},
                {'source': 'dashboard.json', 'script': 'ls_override_block', 'response_variable': 'result'},
            ])

    def test_allows_only_reviewed_typescript_owned_response_consumers(self):
        consumers = [
            {'source': 'script:ls_override_block', 'script': 'ls_apply', 'response_variable': 'plan'},
            {'source': 'automation:retained', 'script': 'ls_apply', 'response_variable': 'plan'},
        ]

        self.assertEqual(unexpected_response_consumers(
            consumers, {('script:ls_override_block', 'ls_apply')}), [
                {'source': 'automation:retained', 'script': 'ls_apply', 'response_variable': 'plan'},
            ])

    def test_discovers_new_dashboard_capture_files(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            before = root / 'before'
            generated = root / 'generated'
            before.mkdir()
            generated.mkdir()
            (before / 'house_dashboard.json').write_text('{}')
            (generated / 'new_dashboard.json').write_text('{}')
            (generated / 'not-a-dashboard.json.txt').write_text('{}')

            self.assertEqual(dashboard_paths((before, generated)), [
                before / 'house_dashboard.json',
                generated / 'new_dashboard.json',
            ])

    def test_loads_dashboard_patch_lists_without_an_envelope(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / 'schedule_dashboard.patch.json'
            path.write_text('[{"op": "add"}]')

            self.assertEqual(load_config(path), [{'op': 'add'}])

    def test_treats_templated_response_action_as_unresolved_consumer(self):
        documents = [('retained.json', {
            'action': 'script.{{ selected_script }}',
            'response_variable': 'result',
        })]

        self.assertEqual(find_response_consumers(documents, {'ls_apply'}), [{
            'source': 'retained.json',
            'script': '<dynamic>',
            'response_variable': 'result',
            'action_fingerprint': 'f746b467483334c2071bc809f5d83e0d46d7b25108510e59739ca64d6f21c9c2',
        }])

    def test_dynamic_allowlist_is_bound_to_the_reviewed_template(self):
        consumers = find_response_consumers([
            ('retained.json', {
                'action': 'script.{{ selected_script }}',
                'response_variable': 'result',
            }),
            ('retained.json', {
                'action': 'script.{{ changed_script }}',
                'response_variable': 'result',
            }),
        ], {'ls_apply'})

        self.assertEqual(unexpected_response_consumers(
            consumers,
            set(),
            {('retained.json', 'f746b467483334c2071bc809f5d83e0d46d7b25108510e59739ca64d6f21c9c2')},
        ), [{
            'source': 'retained.json',
            'script': '<dynamic>',
            'response_variable': 'result',
            'action_fingerprint': 'e60c6f11f76e1e478ec7c743c4f5080d134a2c08e5e28edf57e8524c4773d913',
        }])

    def test_reports_missing_and_unexpected_shim_inventory(self):
        self.assertEqual(inventory_changes(
            {'ls_apply', 'ls_store'}, {'ls_apply', 'ls_render'}), {
                'missing': ['ls_render'],
                'unexpected': ['ls_store'],
            })


if __name__ == '__main__':
    unittest.main()
