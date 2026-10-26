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
