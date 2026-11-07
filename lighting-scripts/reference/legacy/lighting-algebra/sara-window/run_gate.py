"""Relevant gesture suites against the exact four-script window change."""
import hashlib
import json
import os
from pathlib import Path
import unittest

STAGE = Path(__file__).resolve().parent
os.environ['LIGHTING_CANDIDATE'] = str(STAGE / 'candidate')
from test_sara_window import SaraWindowTests, WindowReplay
import test_gesture_integration as integration
import test_gesture_native_conditions as native

# Reuse the actual-script test fixtures with the generic external timer sink.
integration.IntegratedReplay = WindowReplay
native.NativeConditionReplay = WindowReplay

def hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((STAGE / 'candidate').glob('*.json'))}

before = hashes()
suite = unittest.TestSuite()
suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(SaraWindowTests))
suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(native.NativeConditionGestureTests))
for name in unittest.defaultTestLoader.getTestCaseNames(integration.GestureIntegrationTests):
    # This historical test asserts .4-second completion; new tests cover the
    # user-approved .6-second burst, stale tokens and immediate arrow dispatch.
    if name != 'test_blocked_logical_dispatch_does_not_delay_third_power_or_arrow_capture':
        suite.addTest(integration.GestureIntegrationTests(name))
result = unittest.TextTestRunner(verbosity=2).run(suite)
assert hashes() == before, 'Candidate changed during checks'
if result.wasSuccessful():
    (STAGE / 'verified-hashes.json').write_text(json.dumps(before, indent=2) + '\n')
raise SystemExit(0 if result.wasSuccessful() else 1)
