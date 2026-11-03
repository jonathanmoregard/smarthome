"""Explicitly freeze historical setup, stopping exactly at the original upgrade seam."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from portability import ROOT, LEGACY, Stage, dependencies, live_candidate

METHODS = ['test_migrated_candle_keeps_intensity_and_instance_across_adjustments',
           'test_migrated_remote_respects_newer_ui_brightness']


def capture():
    dependencies()
    fixtures = {}
    with Stage() as stage:
        candidate = live_candidate(stage.path)
        for key in ('LIGHTING_CANDIDATE', 'LIGHTING_CORE_DIR', 'INPUT_CANDIDATE'):
            os.environ[key] = str(candidate)
        sys.path[:0] = [str(stage.path / p) for p in ('lighting-algebra/input-processors/tests', 'lighting-algebra/tests', 'effects-promotion/tests')]
        import dry_harness
        import test_input_review as original
        original_run = dry_harness.DrySim.run
        original_old = original.ReviewRegressions.old
        active = {}

        def record_run(sim, name, **args):
            capturing = getattr(sim, '_capture_migration', False)
            level = getattr(sim, '_capture_depth', 0)
            before = copy.deepcopy(sim.state) if capturing and not level else None
            sim._capture_depth = level + 1
            try:
                result = original_run(sim, name, **args)
            finally:
                sim._capture_depth = level
            if before is not None:
                active['steps'].append({'script': name, 'args': copy.deepcopy(args), 'result': copy.deepcopy(result),
                                        'state_changes': {key: copy.deepcopy(value) for key, value in sim.state.items() if before.get(key) != value},
                                        'state_removed': [key for key in before if key not in sim.state],
                                        'now': sim.now.isoformat(), 'elapsed': sim.elapsed})
            return result

        def old(test):
            sim = original_old(test)
            active['initial'] = {'state': copy.deepcopy(sim.state), 'areas': sim.areas, 'members': sim.members,
                                 'now': sim.now.isoformat(), 'elapsed': sim.elapsed}
            sim._capture_migration = True
            return sim

        class Captured(Exception):
            pass

        def upgrade(test, sim):
            raise Captured()

        dry_harness.DrySim.run = record_run
        original.ReviewRegressions.old = old
        original.ReviewRegressions.upgrade = upgrade
        for method in METHODS:
            active = {'steps': []}
            test = original.ReviewRegressions(method)
            try:
                getattr(test, method)()
            except Captured:
                fixtures[method] = active
            else:
                raise AssertionError('Historical fixture never reached the upgrade seam: ' + method)
    paths = [LEGACY / 'lighting-algebra/input-processors/tests/test_input_review.py',
             *sorted((LEGACY / 'lighting-algebra/simple-effects/candidate').glob('*.json'))]
    return {'description': 'Historical execution only before original upgrade; not TypeScript verification.',
            'source_sha256': {str(path.relative_to(LEGACY)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
            'legacy_sha256': stage.before,
            'live_sha256': {str(path.relative_to(ROOT / 'reference/live')): hashlib.sha256(path.read_bytes()).hexdigest()
                           for path in sorted((ROOT / 'reference/live').rglob('*.json'))},
            'fixtures': fixtures}


if __name__ == '__main__':
    output = ROOT / 'tests/parity/migration-fixtures.json'
    output.write_text(json.dumps(capture(), indent=2) + '\n')
    print(output)
