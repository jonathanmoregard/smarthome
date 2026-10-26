#!/usr/bin/env python3
"""Extract literal resident configuration once; never evaluate a Jinja template."""
import argparse
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def config(source, name):
    value = json.loads((source / 'scripts' / (name + '.json')).read_text())
    return value.get('config', value)


def catalog_from(source):
    catalog = config(source, 'effects_catalog')['sequence'][0]['variables']['result']
    if not isinstance(catalog, dict):
        raise ValueError('effects_catalog must contain literal data')
    ui = config(source, 'effects_ui_catalog')['sequence']
    catalog['ui_choices'] = ui[1]['variables']['choices']
    catalog['ui_discovery'] = ui[2]['repeat']['for_each']
    catalog['ui_rows'] = config(source, 'effects_ui_sync')['sequence'][1]['variables']['rows']
    catalog['baseline_groups'] = {'light.kitchen_all': catalog['groups']['light.kitchen_all']}
    catalog['remotes'] = {}
    for path in sorted((source / 'scripts').glob('ls_remote_gesture_*.json')):
        room = path.stem.removeprefix('ls_remote_gesture_')
        sequence = config(source, path.stem)['sequence']
        def values(value, key):
            if isinstance(value, dict):
                for k, child in value.items():
                    if k == key:
                        yield child
                    yield from values(child, key)
            elif isinstance(value, list):
                for child in value:
                    yield from values(child, key)
        sources = {value for value in values(sequence, 'source') if isinstance(value, str) and '{{' not in value}
        devices = set(re.findall(r"area_id\('([a-z0-9]+)'\)", json.dumps(sequence)))
        if len(sources) != 1 or len(devices) != 1:
            raise ValueError(f'Ambiguous remote metadata: {room}')
        catalog['remotes'][room] = {'source': sources.pop(), 'device_id': devices.pop()}
    for key in ('ui_choices', 'ui_discovery', 'ui_rows'):
        if not isinstance(catalog[key], list):
            raise ValueError(f'{key} must be literal data')
    return catalog


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'reference/live')
    parser.add_argument('--output', type=Path, default=ROOT / '.runtime/catalog.json')
    args = parser.parse_args()
    value = catalog_from(args.source)
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Refuse to overwrite resident edits with the historical bootstrap snapshot.
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    print(f'Created {args.output}; future topology edits belong in this runtime file.')


if __name__ == '__main__':
    main()
