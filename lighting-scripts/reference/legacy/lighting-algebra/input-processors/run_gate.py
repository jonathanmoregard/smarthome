"""Integrated current exports; superseded interpreted-remote tests replaced by input invariants."""
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

STAGE=Path(__file__).resolve().parent
for key in ['LIGHTING_CANDIDATE','LIGHTING_CORE_DIR','INPUT_CANDIDATE']:
    os.environ[key]=str(STAGE/'candidate')
sys.path.insert(0,str(STAGE.parent/'tests'))
sys.path.insert(0,str(STAGE/'tests'))
def hashes():
    return {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((STAGE/'candidate').glob('*.json'))}
before=hashes()
(STAGE/'verified-hashes.json').write_text(json.dumps(before,indent=2)+'\n')
suite=unittest.TestSuite()
# These two suites directly build the old scale-claim planner and assert that
# up/down steals effect channels. New input invariant tests supersede them.
superseded={'test_remote_fast','test_remote_store'}
for path in sorted((STAGE.parent/'tests').glob('test_*.py')):
    if path.stem not in superseded:
        suite.addTests(unittest.defaultTestLoader.loadTestsFromName(path.stem))
for path in sorted((STAGE/'tests').glob('test_*.py')):
    suite.addTests(unittest.defaultTestLoader.loadTestsFromName(path.stem))
result=unittest.TextTestRunner(verbosity=2).run(suite)
assert before==hashes(),'Candidate changed during integrated gate'
print('Verified immutable candidate:',len(before),'configs; superseded remote-scale suites:',sorted(superseded))
raise SystemExit(0 if result.wasSuccessful() else 1)
