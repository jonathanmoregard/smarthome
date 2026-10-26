#!/usr/bin/env python3
"""Run original scenarios/assertions against reference HA/Jinja or TypeScript.

Default runs every inventoried behavioral module and fails on uncovered seams.
Use --suite for bounded development gates; coverage is always printed explicitly.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import unittest
from portability import LEGACY, ROOT, Stage, dependencies, live_candidate

ALIASES = {
    'gestures': 'smarthome-remote-20261026/test_gestures.py',
    'core': 'lighting-algebra/core/test_core.py',
    'core-relational': 'lighting-algebra/tests/test_core.py',
    'grouping': 'lighting-algebra/grouping/test_grouping.py',
    'input': 'lighting-algebra/input-processors/tests/test_input_processors.py',
    'input-edges': 'lighting-algebra/input-processors/tests/test_input_edges.py',
    'input-review': 'lighting-algebra/input-processors/tests/test_input_review.py',
    'gradient': 'lighting-algebra/tests/test_gradient_cache.py',
}


def inventory():
    paths = sorted(p for p in LEGACY.rglob('*.py')
                   if p.name.startswith('test_') or p.name in ('gesture_test.py', 'preset_test.py', 'test_logic.py'))
    rows = []
    for path in paths:
        name = str(path.relative_to(LEGACY))
        seam = 'simulator'
        classification = 'historical-behavior'
        reason = 'Retained assertions; current-source compatibility must be demonstrated by execution.'
        if path.parent.name in ('tests', 'remote-regressions', 'remote-ranges') and 'lighting-algebra' in path.parts:
            classification = 'active-in-remote-ranges-gate'
            reason = 'Included by preserved remote-ranges/run_gate.py; newer live behavior still needs verification.'
        if name == ALIASES['gestures']:
            seam, classification, reason = 'gestures', 'current-native-regression', '33 native HA gesture cases from the deployed revision.'
        elif name in (ALIASES['core'], ALIASES['grouping']):
            seam = 'pure-template'
        elif name.startswith('smarthome-remote-20261026/'):
            seam, classification, reason = 'unsupported', 'undeployed-autogroup-candidate', 'Automatic group provisioning is an unfinished candidate, not deployed behavior.'
        elif path.name in ('test_harness.py', 'test_gradient_cache.py', 'test_gesture_native_conditions.py'):
            classification, reason = 'reference-implementation-contract', 'Contains Python/Jinja interpreter, macro instrumentation, or sequence-shape assertions; unsupported execution fails explicitly.'
        elif name == 'effects-promotion/tests/test_logic.py':
            seam = 'unsupported'
        if name in ('lighting-algebra/tests/test_remote_fast.py', 'lighting-algebra/tests/test_remote_store.py'):
            classification = 'explicitly-superseded'
            reason = 'input-processors/run_gate.py and remote-ranges/run_gate.py explicitly replace old scale-claim assertions with input invariants.'
        rows.append({'path': name, 'seam': seam, 'classification': classification, 'reason': reason})
    return rows


def load(path):
    spec = importlib.util.spec_from_file_location('parity_original', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def assertion_operands(value):
    """Lossless assertion diagnostics except numerically equivalent int/float JSON."""
    if isinstance(value, dict):
        if all(isinstance(key, str) for key in value):
            return {key: assertion_operands(item) for key, item in value.items()}
        return {'mapping': [[assertion_operands(key), assertion_operands(item)]
                            for key, item in sorted(value.items(), key=lambda entry: repr(entry[0]))]}
    if isinstance(value, tuple):
        return {'tuple': [assertion_operands(item) for item in value]}
    if isinstance(value, set):
        return {'set': [assertion_operands(item) for item in sorted(value, key=repr)]}
    if isinstance(value, list):
        return [assertion_operands(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return {'type': type(value).__name__, 'repr': repr(value)}


class ObservedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.operands = {}

    def remember(self, test, error):
        if error and hasattr(error[1], 'parity_operands'):
            from rpc import encode_numbers
            self.operands[test.id()] = encode_numbers(assertion_operands(error[1].parity_operands))

    def addFailure(self, test, error):
        self.remember(test, error)
        super().addFailure(test, error)

    def addSubTest(self, test, subtest, error):
        self.remember(subtest, error)
        super().addSubTest(test, subtest, error)


def observe_equal_assertions():
    original = unittest.TestCase.assertEqual

    def observed(self, first, second, msg=None):
        try:
            return original(self, first, second, msg)
        except AssertionError as error:
            error.parity_operands = [first, second]
            raise
    unittest.TestCase.assertEqual = observed


def execute(args, row):
    dependencies()
    from adapters import gestures, migration_fixtures, pure_templates, simulator
    from rpc import Rpc
    with Stage() as stage:
        root = stage.path
        sys.path[:0] = [str(root / p) for p in (
            'lighting-algebra/input-processors/tests', 'lighting-algebra/tests',
            'effects-promotion/tests', 'lighting-algebra/remote')]
        path = root / row['path']
        sys.path.insert(0, str(path.parent))
        if args.source == 'live':
            source = ROOT / 'reference/live/scripts'
            assert any(source.glob('*.json')), 'No live snapshot available'
            # Historical candidates were bare configs; captured live documents
            # are envelopes. Preserve the exports and normalize only this
            # isolated candidate directory for tests that read configs directly.
            candidate = live_candidate(root)
            for key in ('LIGHTING_CANDIDATE', 'LIGHTING_CORE_DIR', 'INPUT_CANDIDATE'):
                os.environ[key] = str(candidate)
        rpc = Rpc() if args.backend == 'typescript' else None
        try:
            if rpc and row['seam'] == 'unsupported':
                raise AssertionError('Uncovered TypeScript adapter: ' + row['path'])
            if rpc and row['seam'] == 'simulator':
                simulator(root, rpc)
            module = load(path)
            if rpc and row['path'] == ALIASES['input-review']:
                migration_fixtures(module, rpc)
            if args.source == 'live' and row['seam'] == 'pure-template':
                # Preserve test scenarios while selecting the actual live reference.
                from jinja2 import Environment, StrictUndefined
                if hasattr(module, 'CONFIGS'):
                    for name in module.CONFIGS:
                        value = json.loads((source / (name + '.json')).read_text())
                        module.CONFIGS[name] = value.get('config', value)
                        module.TEMPLATES[name] = module.ENV.from_string(module.CONFIGS[name]['sequence'][0]['variables']['result'])
                else:
                    value = json.loads((source / 'effects_group_plan.json').read_text())
                    module.CONFIG = value.get('config', value)
                    module.TEMPLATE = Environment(undefined=StrictUndefined).from_string(module.CONFIG['sequence'][0]['variables']['result'])
            if rpc and row['seam'] == 'pure-template':
                pure_templates(module, rpc, args.differential)
            if row['seam'] == 'gestures':
                if rpc:
                    gestures(module, rpc, args.differential)
                if args.source == 'live':
                    document = {name: json.loads((source / (name + '.json')).read_text())
                                for name in ('ls_remote_gesture_kitchen', 'ls_remote_gesture_bedroom', 'ls_remote_gesture_living_room')}
                    fixture = root / 'live-gestures.json'
                    fixture.write_text(json.dumps(document))
                else:
                    fixture = root / 'smarthome-remote-20261026/deployed.json'
                sys.argv = [str(path), str(fixture)]
                try:
                    asyncio.run(module.main())
                except SystemExit as outcome:
                    print('PARITY_OUTCOME ' + json.dumps({'checks': 33, 'exit_code': int(outcome.code or 0)}))
                    return int(outcome.code or 0)
                return 0
            suite = unittest.defaultTestLoader.loadTestsFromModule(module)
            if args.test:
                suite = unittest.TestSuite(test for group in suite for test in group if args.test in test.id())
            assert suite.countTestCases(), 'No unittest cases discovered; module-level assertions are not an adequate gate'
            observe_equal_assertions()
            result = unittest.TextTestRunner(verbosity=2, resultclass=ObservedResult).run(suite)
            print('PARITY_OUTCOME ' + json.dumps({
                'tests': result.testsRun,
                'failures': [{'id': test.id(), 'error': normalized_error(error),
                              **({'operands': result.operands[test.id()]} if test.id() in result.operands else {})}
                             for test, error in result.failures],
                'errors': [{'id': test.id(), 'error': normalized_error(error)} for test, error in result.errors],
                'skipped': [{'id': test.id(), 'reason': reason} for test, reason in result.skipped],
            }))
            return 0 if result.wasSuccessful() else 1
        finally:
            if rpc:
                print(json.dumps({'backend': 'typescript', 'original': row['path'], 'requests': rpc.requests,
                                  'entrypoints': sorted(rpc.entrypoints), 'differential_comparisons': rpc.comparisons,
                                  'historical_fixtures': rpc.fixtures,
                                  'path_rewrites': len(stage.rewrites)}), flush=True)
                rpc.close()


def normalized_error(error):
    # Compare exception identity/message, never machine paths or implementation
    # stack frames. Tracebacks remain visible in the complete run output.
    lines = error.rstrip().splitlines()
    return '\n'.join(line for line in lines if re.match(r'^[A-Za-z][A-Za-z0-9_.]*(Error|Exception):', line)) or lines[-1]


def outcome_from(output):
    lines = [line.removeprefix('PARITY_OUTCOME ') for line in output.splitlines() if line.startswith('PARITY_OUTCOME ')]
    return json.loads(lines[-1]) if lines else None


def execution_metadata(output):
    for line in reversed(output.splitlines()):
        if line.startswith('{"backend": "typescript", "original":'):
            return json.loads(line)
    return None


def comparable(run):
    # Keep exact failed identities and actual operands. Python's failure repr
    # abbreviates dictionaries differently for 225 versus 225.0; those strings
    # must not obscure an otherwise identical failed assertion.
    value = json.loads(json.dumps(run))
    if value['outcome']:
        for failure in value['outcome'].get('failures', []):
            if 'operands' in failure:
                failure['error'] = failure['error'].split(':', 1)[0]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', choices=['reference', 'typescript', 'compare'], default='typescript')
    parser.add_argument('--source', choices=['live', 'historical'], default='live')
    parser.add_argument('--suite', action='append', help='Alias or exact inventory path; repeatable. Default: all.')
    parser.add_argument('--test', help='Optional test id substring')
    parser.add_argument('--inventory', action='store_true')
    parser.add_argument('--report', type=Path, help='Write structured result/coverage JSON')
    parser.add_argument('--differential', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--worker', help=argparse.SUPPRESS)
    args = parser.parse_args()
    rows = inventory()
    if args.inventory:
        print(json.dumps({'aliases': ALIASES, 'modules': rows}, indent=2))
        return 0
    if args.worker:
        return execute(args, next(row for row in rows if row['path'] == args.worker))
    selected = {ALIASES.get(value, value) for value in (args.suite or [row['path'] for row in rows])}
    unknown = selected - {row['path'] for row in rows}
    assert not unknown, f'Unknown suite(s): {sorted(unknown)}'
    results = []
    for row in rows:
        if row['path'] not in selected:
            continue
        runs = {}
        for backend in (('reference', 'typescript') if args.backend == 'compare' else (args.backend,)):
            command = [sys.executable, str(Path(__file__).resolve()), '--worker', row['path'], '--backend', backend, '--source', args.source]
            if args.test:
                command.extend(['--test', args.test])
            if args.backend == 'compare' and backend == 'typescript' and row['seam'] in ('pure-template', 'gestures'):
                command.append('--differential')
            print(f'\n=== {backend} {row["path"]} ({args.source}) ===', flush=True)
            completed = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            print(completed.stdout, end='', flush=True)
            runs[backend] = {'exit_code': completed.returncode, 'outcome': outcome_from(completed.stdout)}
        metadata = execution_metadata(completed.stdout)
        exit_code = runs[next(iter(runs))]['exit_code']
        if args.backend == 'compare':
            equal = runs['reference']['outcome'] is not None and comparable(runs['reference']) == comparable(runs['typescript'])
            exit_code = int(not equal)
        results.append({'module': row['path'], 'exit_code': exit_code, 'classification': row['classification'],
                        'runs': runs, 'typescript_execution': metadata})
    report = {'results': results, 'selected_modules': len(results), 'inventoried_modules': len(rows),
              'not_selected': [row['path'] for row in rows if row['path'] not in selected],
              'gate': 'identical outcomes including baseline failures; value differential for pure templates and native gestures' if args.backend == 'compare' else 'original assertions',
              'test_sha256': {row['path']: hashlib.sha256((LEGACY / row['path']).read_bytes()).hexdigest() for row in rows},
              'live_script_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT / 'reference/live/scripts').glob('*.json'))}}
    print(json.dumps(report, indent=2))
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    return int(any(result['exit_code'] != 0 for result in results))


if __name__ == '__main__':
    raise SystemExit(main())
