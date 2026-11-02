#!/usr/bin/env python3
"""Fail when a captured external HA caller consumes a shimmed script response."""
import importlib.util
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REMOTE_PREFIXES = ('ls_remote_gesture_', 'ls_remote_power_quiet_')
EXPECTED_SHIMMED_ENTRYPOINTS = {
    'effects_candle_sync', 'effects_set', 'effects_ui_catalog', 'effects_ui_sync',
    'ls_apply', 'ls_clear_overrides', 'ls_override_block', 'ls_range_save',
    'ls_remote_command', 'ls_remote_gesture_bedroom', 'ls_remote_gesture_kitchen',
    'ls_remote_gesture_living_room', 'ls_remote_power_quiet_bedroom',
    'ls_remote_power_quiet_kitchen', 'ls_remote_power_quiet_living_room',
    'ls_render', 'ls_sara_mode', 'ls_store',
}
REVIEWED_INTERNAL_CONSUMERS = {
    ('automation:lighting_schedule_lamp_change_detector', 'ls_apply'),
    ('script:ls_override_block', 'ls_apply'),
}
REVIEWED_DYNAMIC_NONSHIM_CALLERS = {
    ('script:effects_frame_plan', '5462df49e76e2b9919f78183989f104ec50e0cda456f30049b1ff00a179d2a25'),
}
DASHBOARD_DIRECTORIES = (
    ROOT / 'reference/legacy/lighting-algebra/before',
    ROOT / 'reference/legacy/lighting-algebra/ui',
)


def dashboard_paths(directories):
    paths = []
    for directory in directories:
        if not directory.is_dir():
            raise RuntimeError(f'Captured dashboard directory is unavailable: {directory}')
        paths.extend(directory.glob('*dashboard*.json'))
    if not paths:
        raise RuntimeError('No captured dashboards found')
    return sorted(paths)


def mappings(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from mappings(child)


def find_response_consumers(documents, shimmed_entrypoints):
    consumers = []
    for source, document in documents:
        for value in mappings(document):
            if 'response_variable' not in value:
                continue
            for key in ('action', 'service'):
                action = value.get(key)
                if not isinstance(action, str):
                    continue
                dynamic = '{{' in action or '{%' in action
                script = action.removeprefix('script.') if action.startswith('script.') else ''
                if not dynamic and script not in shimmed_entrypoints:
                    continue
                consumer = {
                    'source': source,
                    'script': '<dynamic>' if dynamic else script,
                    'response_variable': str(value['response_variable']),
                }
                if dynamic:
                    consumer['action_fingerprint'] = hashlib.sha256(action.encode()).hexdigest()
                consumers.append(consumer)
                break
    return consumers


def unexpected_response_consumers(consumers, allowed, allowed_dynamic=()):
    unexpected = []
    for consumer in consumers:
        if consumer['script'] == '<dynamic>':
            reviewed = (consumer['source'], consumer['action_fingerprint']) in allowed_dynamic
        else:
            reviewed = (consumer['source'], consumer['script']) in allowed
        if not reviewed:
            unexpected.append(consumer)
    return unexpected


def inventory_changes(actual, expected):
    return {
        'missing': sorted(expected - actual),
        'unexpected': sorted(actual - expected),
    }


def load_config(path):
    document = json.loads(path.read_text())
    return document.get('config', document) if isinstance(document, dict) else document


def bridge_inventory():
    path = ROOT / 'scripts/export-bridge.py'
    spec = importlib.util.spec_from_file_location('export_bridge', path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'Cannot load {path.relative_to(ROOT)}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    scripts = ROOT / 'reference/live/scripts'
    if not scripts.is_dir():
        raise RuntimeError('Captured scripts are unavailable under reference/live/scripts')
    names = set(module.COMMAND_SCRIPTS)
    names.update(path.stem for path in scripts.glob('*.json')
                 if path.stem.startswith(REMOTE_PREFIXES))
    return names


def captured_callers():
    documents = []
    for kind in ('automations', 'scripts'):
        directory = ROOT / 'reference/live' / kind
        if not directory.is_dir():
            raise RuntimeError(f'Captured {kind} are unavailable under reference/live/{kind}')
        singular = kind.removesuffix('s')
        documents.extend((f'{singular}:{path.stem}', load_config(path))
                         for path in sorted(directory.glob('*.json')))
    for path in dashboard_paths(DASHBOARD_DIRECTORIES):
        documents.append((f'dashboard:{path.parent.name}/{path.stem}', load_config(path)))
    return documents


def response_capable_scripts(shimmed_entrypoints):
    scripts = ROOT / 'reference/live/scripts'
    return sorted(path.stem for path in scripts.glob('*.json')
                  if path.stem in shimmed_entrypoints
                  and any('stop' in value and 'response_variable' in value
                          for value in mappings(load_config(path))))


def main():
    shimmed = bridge_inventory()
    inventory = inventory_changes(shimmed, EXPECTED_SHIMMED_ENTRYPOINTS)
    consumers = find_response_consumers(captured_callers(), shimmed)
    unexpected = unexpected_response_consumers(
        consumers, REVIEWED_INTERNAL_CONSUMERS, REVIEWED_DYNAMIC_NONSHIM_CALLERS)
    observed = {(item['source'], item['script']) for item in consumers}
    missing = sorted(REVIEWED_INTERNAL_CONSUMERS - observed)
    failed = bool(unexpected or missing or inventory['missing'] or inventory['unexpected'])
    report = {
        'status': 'audit_requires_review' if failed else 'no_external_response_consumers',
        'shimmed_entrypoints': len(shimmed),
        'shim_inventory_changes': inventory,
        'response_capable_scripts': response_capable_scripts(shimmed),
        'reviewed_internal_response_consumers': sum(
            (item['source'], item['script']) in REVIEWED_INTERNAL_CONSUMERS
            for item in consumers
        ),
        'reviewed_dynamic_nonshim_calls': sum(
            (item['source'], item.get('action_fingerprint')) in REVIEWED_DYNAMIC_NONSHIM_CALLERS
            for item in consumers
        ),
        'external_response_consumers': unexpected,
        'missing_reviewed_internal_consumers': [
            {'source': source, 'script': script} for source, script in missing
        ],
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return int(failed)


if __name__ == '__main__':
    raise SystemExit(main())
