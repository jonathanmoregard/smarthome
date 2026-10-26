#!/usr/bin/env python3
"""Current-source compatibility gate; baseline defects remain separately counted."""
import json
from pathlib import Path
import subprocess
import sys
from portability import ROOT
from run import ALIASES, inventory

SUITES = ['gestures', 'core', 'core-relational', 'grouping', 'input-edges',
          'lighting-algebra/tests/test_room_cache.py',
          'lighting-algebra/tests/test_room_wake_baseline.py',
          'lighting-algebra/tests/test_effect_pacing.py',
          'lighting-algebra/tests/test_state_sequences.py',
          'lighting-algebra/tests/test_performance_pipeline.py',
          'lighting-algebra/tests/test_native_controls.py',
          'lighting-algebra/tests/test_remote_transition.py',
          'input', 'lighting-algebra/tests/test_dispatch.py',
          'lighting-algebra/tests/test_final_regressions.py',
          'lighting-algebra/tests/test_integration.py',
          'lighting-algebra/tests/test_transport.py',
          'lighting-algebra/tests/test_remote_cycle.py',
          'lighting-algebra/tests/test_cache_integration.py',
          'lighting-algebra/remote-ranges/test_period_stream.py',
          'lighting-algebra/remote-ranges/test_preset_roundtrip.py',
          'lighting-algebra/remote-ranges/test_remote_ranges.py']
SUPPLEMENTS = ['native_gradient.py', 'native_resolution.py', 'native_controls.py', 'native_drift.py', 'native_bridges.py',
               '../runtime/automations-native.py', '../runtime/grouping-native-schedule.py', '../runtime/grouping-native-ui.py']


def omissions():
    selected = {ALIASES.get(name, name) for name in SUITES}
    reasons = {
        'lighting-algebra/tests/test_gradient_cache.py': 'Jinja macro/instrumentation assertions; native_gradient.py independently compares 7059 public-function samples.',
        'lighting-algebra/tests/test_harness.py': 'Tests the original interpreter itself, not the migrated domain.',
        'lighting-algebra/input-processors/tests/test_input_review.py': 'Historical two-version upgrade tests require the separately reported frozen-prefix fixture seam.',
        'lighting-algebra/tests/test_native_controls.py': 'Original automation execution seam remains uncovered; native_controls.py covers pure native/UI plans with explicit dependencies.',
        'lighting-algebra/adapters/test_adapters.py': 'Module-level assertions have no supported per-test outcome adapter yet.',
        'effects-promotion/tests/test_logic.py': 'Older standalone simulator entrypoint has no migrated adapter yet.',
    }
    result = []
    for row in inventory():
        if row['path'] in selected:
            continue
        reason = reasons.get(row['path'])
        if reason is None:
            if row['classification'] == 'explicitly-superseded':
                reason = row['reason']
            elif row['classification'] == 'undeployed-autogroup-candidate':
                reason = row['reason']
            else:
                reason = 'Retained and runnable through run.py, but not yet established as a compatible current-source regression gate; remaining legacy execution/version seams are reported, not skipped inside this suite.'
        result.append({'module': row['path'], 'reason': reason})
    return result


def failed_ids(outcome):
    # unittest counts a method once even when several subtests fail.
    return {entry['id'].split(' (', 1)[0] for kind in ('failures', 'errors') for entry in outcome.get(kind, [])}


def main():
    report_path = ROOT / 'tests/parity/gate-comparison-report.json'
    command = [sys.executable, str(ROOT / 'tests/parity/run.py'), '--backend', 'compare', '--report', str(report_path)]
    for name in SUITES:
        command.extend(['--suite', name])
    print('Running preserved current-source scenarios on reference and TypeScript...', flush=True)
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output = []
    for line in process.stdout:
        output.append(line)
        if line.startswith('==='):
            print(line.strip(), flush=True)
    process.stdout.close()
    result = subprocess.CompletedProcess(command, process.wait(), ''.join(output), '')
    comparison = json.loads(report_path.read_text()) if report_path.exists() else {'results': []}
    modules, defects, clean = [], [], 0
    for module in comparison['results']:
        outcomes = module['runs']
        baseline = outcomes['reference']['outcome']
        typed = outcomes['typescript']['outcome']
        if baseline is None or typed is None:
            modules.append({'module': module['module'], 'status': 'infrastructure_failure'})
            continue
        failed = failed_ids(baseline)
        checks = baseline.get('tests', baseline.get('checks', 0))
        matched = module['exit_code'] == 0
        clean_count = checks - len(failed) if matched else 0
        clean += clean_count
        defects.extend({'module': module['module'], 'test': name} for name in sorted(failed))
        modules.append({'module': module['module'], 'equivalent': matched,
                        'clean_assertion_tests': clean_count, 'baseline_defect_tests': len(failed),
                        'execution': module['typescript_execution']})
        print(f'{module["module"]}: {clean_count} clean tests; {len(failed)} retained baseline defects; equivalent={matched}', flush=True)
    supplements = []
    for script in SUPPLEMENTS:
        completed = subprocess.run([sys.executable, str(ROOT / 'tests/parity' / script)], cwd=ROOT, capture_output=True, text=True)
        data = None
        if completed.returncode == 0:
            try:
                data = json.loads(completed.stdout)
            except json.JSONDecodeError as error:
                data = {'report_error': str(error)}
                completed.returncode = 1
                print(f'{script}: invalid verification report: {error}', file=sys.stderr)
        supplements.append({'script': script, 'exit_code': completed.returncode, 'evidence': data})
        if completed.returncode:
            print(completed.stdout + completed.stderr, file=sys.stderr)
    bridge = subprocess.run([sys.executable, '-W', 'error::ResourceWarning', '-m', 'unittest', 'discover', '-s', 'tests/parity', '-p', 'test_bridge.py'], cwd=ROOT, capture_output=True, text=True)
    failed = result.returncode != 0 or bridge.returncode != 0 or any(item['exit_code'] for item in supplements)
    summary = {'status': 'regression_or_uncovered_seam' if failed else 'selected_scope_compatible',
               'clean_original_assertion_tests': clean, 'baseline_defects_not_counted_as_passes': defects,
               'modules': modules, 'supplements': supplements, 'bridge_test_exit_code': bridge.returncode,
               'omitted_modules': omissions(), 'complete_legacy_coverage': False}
    (ROOT / 'tests/parity/gate-report.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2))
    if result.returncode:
        print(result.stdout[-15000:] + result.stderr, file=sys.stderr)
    if bridge.returncode:
        print(bridge.stdout + bridge.stderr, file=sys.stderr)
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
