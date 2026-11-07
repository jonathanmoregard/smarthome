"""All active dry suites against the exact remote-range candidate."""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

STAGE = Path(__file__).resolve().parent
for key in ['LIGHTING_CANDIDATE', 'LIGHTING_CORE_DIR', 'INPUT_CANDIDATE']:
    os.environ[key] = str(STAGE / 'candidate')
directories = [STAGE.parent / 'tests', STAGE.parent / 'input-processors/tests', STAGE.parent / 'remote-regressions', STAGE]
for directory in directories:
    sys.path.insert(0, str(directory))

def hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((STAGE / 'candidate').glob('*.json'))}

before = hashes()
(STAGE / 'verified-hashes.json').write_text(json.dumps(before, indent=2) + '\n')
suite = unittest.TestSuite()
# Historical interpreted-channel tests were superseded by input invariants.
superseded = {'test_remote_fast', 'test_remote_store'}
for directory in directories:
    for path in sorted(directory.glob('test_*.py')):
        if path.stem not in superseded:
            suite.addTests(unittest.defaultTestLoader.loadTestsFromName(path.stem))
result = unittest.TextTestRunner(verbosity=2).run(suite)
assert before == hashes(), 'Candidate changed during integrated gate'
print('Verified immutable candidate:', len(before), 'configs')
raise SystemExit(0 if result.wasSuccessful() else 1)
