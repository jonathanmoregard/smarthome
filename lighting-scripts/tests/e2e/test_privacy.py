"""No household identifier in the committed e2e harness or the M0 design documents (ruling 3: the repo is public).

Every area id, entity id, friendly name and device address the private captures hold is read as the reference
backend loads them, in a child process, and no committed file in scope may name one. Generic system helpers that
src/ already makes public are allowed by name. A failure gives file:line and the identifier's kind, never the
identifier itself.
"""
from __future__ import annotations
from collections.abc import Mapping
import re
import subprocess
import unittest

from tests.e2e import env
from tests.e2e.test_env import isolated

REPO = env.ROOT.parent
SCOPE = ('lighting-scripts/tests/e2e/',
         'docs/superpowers/specs/2026-11-22-lighting-architecture-design.md',
         'docs/superpowers/plans/2026-11-22-m0-e2e-harness.md')
# Generic system helpers, public in src/ by name or by the `ls_<scope>_<block>` pattern src/ builds them from
# (`house` is the scope every house has).
PUBLIC_HELPERS = frozenset({
    'sensor.ls_overrides', 'sensor.ls_effects_runtime',
    'script.ls_override_block', 'script.ls_clear_overrides', 'script.effects_engine',
    'input_boolean.ls_ovr_next_block_on', 'input_boolean.ls_ovr_after_on', 'input_number.ls_ovr_after_min',
    'input_text.ls_house_day', 'input_text.ls_house_cosy', 'light.ls_house_day', 'light.ls_house_cosy',
    'input_datetime.ls_house_day_start', 'input_datetime.ls_house_night_start',
    'switch.zigbee2mqtt_bridge_permit_join',   # Zigbee2MQTT's own bridge switch, which src/ refuses to touch
})
# Friendly names that are plain words the documents use for something else.
GENERIC_WORDS = frozenset({'Home'})   # as in "Home Assistant"


def leaks(files: Mapping[str, str], identifiers: Mapping[str, str], allowed: frozenset[str]) -> list[str]:
    """`path:line: kind` for each place a file names an identifier (whole words only); never the identifier."""
    checked = {identifier: kind for identifier, kind in identifiers.items() if identifier not in allowed}
    if not checked:
        return []
    pattern = re.compile('|'.join(rf'(?<!\w){re.escape(identifier)}(?!\w)'
                                  for identifier in sorted(checked, key=len, reverse=True)))
    found = []
    for path, text in sorted(files.items()):
        for number, line in enumerate(text.splitlines(), 1):
            for match in pattern.finditer(line):
                found.append(f'{path}:{number}: {checked[match.group()]}')
    return found


def committed_files() -> dict[str, str]:
    paths = subprocess.run(['git', 'ls-files', '--', *SCOPE], cwd=REPO, capture_output=True, text=True,
                           check=True).stdout.split('\n')
    return {path: (REPO / path).read_text() for path in paths if path and (REPO / path).is_file()}


HOUSE_IDENTIFIERS = '''
    import json
    from tests.e2e import env
    from tests.e2e.backend import remote_bindings
    from tests.e2e.world import World
    kinds = {}
    with env.open_sim('reference') as sim:
        for entity, value in sim.state.items():
            kinds.setdefault(entity, 'entity id')
            name = value.get('attributes', {}).get('friendly_name')
            if isinstance(name, str):
                kinds.setdefault(name, 'friendly name')
        for area in sim.areas.values():
            kinds.setdefault(area, 'area id')
        world = World.from_sim(sim)
        for address in [*world.bulb_names(), *world._groups]:
            kinds.setdefault(address, 'device address')
        for device, source in remote_bindings().values():
            kinds.setdefault(device, 'device address')
            kinds.setdefault(source, 'device address')
    print(json.dumps(kinds))
'''


class Leaks(unittest.TestCase):
    def test_finds_a_whole_word_and_reports_only_its_place_and_kind(self):
        files = {'a.py': 'x = 1\nlamp = "Bulb One"\n', 'b.md': 'Bulb Ones and xBulb One are other words\n'}
        found = leaks(files, {'Bulb One': 'friendly name'}, frozenset())
        self.assertEqual(found, ['a.py:2: friendly name'])

    def test_an_allowed_identifier_is_not_a_leak(self):
        self.assertEqual(leaks({'a.py': 'sensor.x_y'}, {'sensor.x_y': 'entity id'}, frozenset({'sensor.x_y'})), [])

    def test_an_entity_id_is_matched_with_its_domain(self):
        files = {'a.py': "'light.room_a' and light.room_a_2\n"}
        self.assertEqual(leaks(files, {'light.room_a': 'entity id'}, frozenset()), ['a.py:1: entity id'])


@unittest.skipUnless(env.reference_available(), 'private reference or HA wrapper missing: no identifiers to check')
class CommittedFiles(unittest.TestCase):
    def test_no_household_identifier_in_the_harness_or_its_documents(self):
        identifiers = isolated(HOUSE_IDENTIFIERS)
        self.assertGreater(len(identifiers), 0)
        found = leaks(committed_files(), identifiers, PUBLIC_HELPERS | GENERIC_WORDS)
        self.assertEqual(found, [], 'household identifiers in committed files:\n' + '\n'.join(found))

    def test_every_allowed_helper_is_one_the_house_has(self):
        identifiers = isolated(HOUSE_IDENTIFIERS)   # a stale entry would allow a name nobody checks any more
        self.assertEqual(sorted((PUBLIC_HELPERS | GENERIC_WORDS) - identifiers.keys()), [])


if __name__ == '__main__':
    unittest.main()
