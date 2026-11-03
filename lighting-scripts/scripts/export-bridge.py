#!/usr/bin/env python3
"""Build reviewable HA trigger bridges locally; never contact or modify HA."""
import argparse
import copy
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RETAINED = {
    'house_schedule': 'Disabled legacy automation; keep disabled.',
    'house_lamps_follow_mode': 'Disabled legacy automation; keep disabled.',
    'house_sunrise_before_alarm': 'Disabled legacy automation; keep disabled.',
    'wake_light_jonathan': 'Existing wake blueprint writes the wake helper; retain it.',
    'lighting_recover_failed_zigbee_commands': 'Existing infrastructure recovery ledger remains in HA.',
}
COMMAND_SCRIPTS = {
    'effects_set', 'effects_ui_catalog', 'effects_ui_sync', 'effects_candle_sync',
    'ls_apply', 'ls_clear_overrides', 'ls_override_block', 'ls_remote_command',
    'ls_sara_mode', 'ls_store', 'ls_range_save', 'ls_render',
}
# HA State/Event objects are not accepted by the template to_json filter directly.
# Forward the fields consumed by the typed trigger adapters, using HA's own as_dict.
TRIGGER_DATA = """{% set n=namespace(data={}) %}
{% for key in ['id','platform','entity_id','topic','payload','payload_json'] %}
 {% if trigger[key] is defined %}{% set n.data=dict(n.data,**{key:trigger[key]}) %}{% endif %}
{% endfor %}
{% for key in ['to_state','from_state','event'] %}
 {% if trigger[key] is defined %}{% set value=trigger[key] %}
  {% set n.data=dict(n.data,**{key:(value.as_dict() if value is not none else none)}) %}
 {% endif %}
{% endfor %}
{{ n.data | to_json | from_json }}"""


def script_bridge(name, original):
    result = copy.deepcopy(original)
    fields = list(original.get('fields', {}))
    if not all(re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', field) for field in fields):
        raise ValueError(f'Invalid script field in {name}')
    forwarding = '{% set n=namespace(args={}) %}'
    for field in fields:
        forwarding += '{% if ' + field + ' is defined %}{% set n.args=dict(n.args,' + field + '=' + field + ') %}{% endif %}'
    forwarding += '{{ n.args }}'
    result['sequence'] = [
        {'condition': 'template', 'value_template': '{{ not (dry_run | default(false)) }}'},
        {'event': 'smarthome_script', 'event_data': {'script': name, 'args': forwarding}},
    ]
    result['description'] = 'Command-only TypeScript bridge. Dry-run/response queries use local RPC. '
    return result


def bridge(slug, original):
    result = copy.deepcopy(original)
    action = original.get('actions', original.get('action', []))
    rooms = set(re.findall(r'script\.ls_remote_gesture_([a-z0-9_]+)', json.dumps(action)))
    args = {'trigger': TRIGGER_DATA}
    if rooms:
        if len(rooms) != 1:
            raise ValueError(f'Ambiguous remote room in {slug}')
        args['room'] = rooms.pop()
    result.pop('action', None)
    result['actions'] = [{'event': 'smarthome_script', 'event_data': {
        'script': 'automation.' + slug, 'args': args,
    }}]
    result['description'] = 'TypeScript trigger bridge. ' + result.get('description', '')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'reference/live/automations')
    parser.add_argument('--output', type=Path, default=ROOT / '.runtime/bridge')
    args = parser.parse_args()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest = {'bridges': [], 'script_bridges': [], 'retained': RETAINED, 'applied': False,
                'response_queries': 'Local src/rpc.ts only; HA script bridges are commands, with dry_run suppressed.'}
    for path in sorted(args.source.glob('*.json')):
        if path.stem in RETAINED:
            continue
        envelope = json.loads(path.read_text())
        result = bridge(path.stem, envelope.get('config', envelope))
        destination = args.output / path.name
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(result, stream, indent=2)
            stream.write('\n')
        manifest['bridges'].append(path.stem)
    scripts = args.output / 'scripts'
    scripts.mkdir(mode=0o700, exist_ok=True)
    for path in sorted((args.source.parent / 'scripts').glob('*.json')):
        if path.stem not in COMMAND_SCRIPTS and not path.stem.startswith(('ls_remote_gesture_', 'ls_remote_power_quiet_')):
            continue
        envelope = json.loads(path.read_text())
        result = script_bridge(path.stem, envelope.get('config', envelope))
        descriptor = os.open(scripts / path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(result, stream, indent=2)
            stream.write('\n')
        manifest['script_bridges'].append(path.stem)
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Prepared {len(manifest['bridges'])} automation and {len(manifest['script_bridges'])} command bridges at {args.output}; nothing applied.")


if __name__ == '__main__':
    main()
