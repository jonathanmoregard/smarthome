"""Offline complete behavioral gate with immutable-candidate fingerprint check."""
import hashlib
import json
import os
from pathlib import Path
import unittest

ROOT = Path('/tmp/lighting-algebra')
CANDIDATE = ROOT / 'performance/candidate'
os.environ['LIGHTING_CANDIDATE'] = str(CANDIDATE)
os.environ['LIGHTING_CORE_DIR'] = str(CANDIDATE)

def hashes():
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(CANDIDATE.glob('*.json'))}

before = hashes()
(ROOT / 'tests/performance-candidate-hashes.json').write_text(json.dumps(before, indent=2) + '\n')
suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'))
result = unittest.TextTestRunner(verbosity=2).run(suite)
after = hashes()
assert before == after, 'Candidate changed during verification; rerun affected coverage.'
print(f'Candidate fingerprint stable: {len(before)} JSON files.', flush=True)
raise SystemExit(0 if result.wasSuccessful() else 1)
