"""Isolated path-only copies of immutable legacy sources; no global /tmp aliases."""
from __future__ import annotations
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import site
import re
import tempfile

ROOT = Path(__file__).resolve().parents[2]
LEGACY = ROOT / 'reference' / 'legacy'
HA_WRAPPER = Path(os.environ.get('HA_WRAPPER', '/nix/store/lrb2mmjfq9f6ikv454cn499xw4d2drsp-homeassistant-2026.7.4/bin/.hass-wrapped'))

LEGACY_SCRIPT_ALIASES = {
    'gesture_script_bedroom': 'ls_remote_gesture_bedroom',
    'gesture_power_done_bedroom': 'ls_remote_power_quiet_bedroom',
    'gesture_script_living_room': 'ls_remote_gesture_living_room',
    'gesture_power_done_living_room': 'ls_remote_power_quiet_living_room',
}
LEGACY_AUTOMATION_ALIASES = {
    'automation_remote_center': 'lighting_jonathan_s_bedroom_remote_center',
    'gesture_center_bedroom': 'lighting_jonathan_s_bedroom_remote_center',
    'gesture_directions_bedroom': 'lighting_jonathan_s_bedroom_remote_directions',
    'gesture_presets_bedroom': 'lighting_bedroom_remote_preset_arrows',
    'gesture_center_living_room': 'lighting_living_room_remote_center',
    'gesture_directions_living_room': 'lighting_living_room_remote_directions',
    'gesture_presets_living_room': 'lighting_living_room_remote_preset_arrows',
}


def dependencies():
    if HA_WRAPPER.exists():
        for node in ast.walk(ast.parse(HA_WRAPPER.read_text())):
            if isinstance(node, ast.List) and node.elts and all(isinstance(x, ast.Constant) and isinstance(x.value, str) and x.value.startswith('/nix/store/') for x in node.elts):
                for path in ast.literal_eval(node):
                    site.addsitedir(path)


def hashes():
    return {str(p.relative_to(LEGACY)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(LEGACY.rglob('*')) if p.is_file() and '__pycache__' not in p.parts}


def live_candidate(stage):
    """Normalize captured envelopes and preserve historical automation aliases."""
    candidate = stage / 'live-candidate'
    candidate.mkdir()
    helpers = stage / 'lighting-algebra/remote/gesture_helpers.json'
    assert helpers.is_file(), 'Missing preserved helper declarations for live gesture source'
    shutil.copyfile(helpers, candidate / helpers.name)
    for path in (ROOT / 'reference/live/scripts').glob('*.json'):
        value = json.loads(path.read_text())
        (candidate / path.name).write_text(json.dumps(value.get('config', value)))
    for path in (ROOT / 'reference/live/automations').glob('*.json'):
        value = json.loads(path.read_text())
        config = value.get('config', value)
        names = {path.stem, str(config.get('id', path.stem))}
        for name in names:
            assert re.fullmatch(r'[\w-]+', name), 'Invalid fixture automation id'
            (candidate / ('automation_' + name + '.json')).write_text(json.dumps(config))
    for alias, source in LEGACY_SCRIPT_ALIASES.items():
        path = ROOT / 'reference/live/scripts' / (source + '.json')
        assert path.is_file(), 'Missing current script capture: ' + source
        value = json.loads(path.read_text())
        config = value.get('config', value)
        assert isinstance(config, dict) and isinstance(config.get('sequence'), list), 'Invalid current script capture: ' + source
        (candidate / (alias + '.json')).write_text(json.dumps(config))
    for alias, source in LEGACY_AUTOMATION_ALIASES.items():
        path = ROOT / 'reference/live/automations' / (source + '.json')
        assert path.is_file(), 'Missing current automation capture: ' + source
        value = json.loads(path.read_text())
        config = value.get('config', value)
        assert isinstance(config, dict) and isinstance(config.get('triggers'), list) and isinstance(config.get('actions'), list), 'Invalid current automation capture: ' + source
        (candidate / (alias + '.json')).write_text(json.dumps(config))
    return candidate


class Stage:
    def __enter__(self):
        self.before = hashes()
        self.temp = tempfile.TemporaryDirectory(prefix='smarthome-parity-')
        self.path = Path(self.temp.name)
        shutil.copytree(LEGACY, self.path, dirs_exist_ok=True)
        self.rewrites = {}
        for path in self.path.rglob('*.py'):
            source = path.read_text()
            rewritten = source
            for directory in LEGACY.iterdir():
                if directory.is_dir():
                    rewritten = rewritten.replace('/tmp/' + directory.name, str(self.path / directory.name))
            # The native tests' only remaining machine-specific path is their
            # dependency closure. An empty Python file is its portable equivalent;
            # installed packages are already on sys.path in a normal virtualenv.
            wrapper = str(HA_WRAPPER)
            if not HA_WRAPPER.exists():
                empty = self.path / 'installed-dependencies.py'
                empty.write_text('# Dependencies are supplied by this Python environment.\n')
                wrapper = str(empty)
            rewritten = rewritten.replace('/nix/store/lrb2mmjfq9f6ikv454cn499xw4d2drsp-homeassistant-2026.7.4/bin/.hass-wrapped', wrapper)
            if rewritten != source:
                path.write_text(rewritten)
                self.rewrites[str(path.relative_to(self.path))] = 'absolute filesystem paths only'
        return self

    def __exit__(self, *exception):
        after = hashes()
        try:
            assert self.before == after, 'Preserved legacy sources changed during parity execution'
        finally:
            self.temp.cleanup()

    def rewrite_path(self, source, target):
        """Redirect one staged absolute path without changing preserved evidence."""
        source, target = Path(source), Path(target)
        assert source.is_absolute() and target.is_absolute(), 'Parity path rewrites must be absolute'
        assert target.is_dir(), 'Parity path rewrite target is missing: ' + str(target)
        replacements = 0
        for path in self.path.rglob('*.py'):
            text = path.read_text()
            count = text.count(str(source))
            if not count:
                continue
            path.write_text(text.replace(str(source), str(target)))
            relative = str(path.relative_to(self.path))
            detail = self.rewrites.get(relative, 'absolute filesystem paths only')
            self.rewrites[relative] = detail + '; selected live candidate path'
            replacements += count
        assert replacements == 1, f'Expected one staged path rewrite for {source}, found {replacements}'

    def rewrite_module_path(self, relative, source, target):
        """Redirect one module's source root before import, without editing evidence."""
        source, target = Path(source), Path(target)
        path = self.path / relative
        assert path.is_file() and source.is_absolute() and target.is_absolute() and target.is_dir(), \
            'Invalid module path rewrite'
        text = path.read_text()
        count = text.count(str(source))
        assert count == 1, f'Expected one source-root binding in {relative}, found {count}'
        path.write_text(text.replace(str(source), str(target)))
        detail = self.rewrites.get(relative, 'absolute filesystem paths only')
        self.rewrites[relative] = detail + '; selected live source root before import'
