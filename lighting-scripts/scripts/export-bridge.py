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
# Not bridged and not retained: the software candle these drove is gone. The
# bulb firmware renders Candle now, so cutover disables these in HA rather
# than pointing them at handlers that no longer exist.
RETIRED = {
    'effects_candle_group_state': 'Fed the software candle group reconciliation; the bulb firmware renders Candle.',
    'effects_candle_membership': 'Started the software candle group reconciliation; the bulb firmware renders Candle.',
    'effects_lifecycle': 'Restarted the frame engine; the bulbs run Candle, Breathe and Colour loop and there is no engine.',
}
COMMAND_SCRIPTS = {
    'effects_set', 'effects_ui_catalog', 'effects_ui_sync',
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


# The lamp change detector's own condition passes only a person's turn_on: the old scripts made no override of a
# power-only call. The port reads a person's turn_off as a lamp switched off (src/adapter/codecs/inputs.ts), so the
# detector's bridges pass turn_off too; nothing else about its condition changes.
DETECTOR = 'lighting_schedule_lamp_change_detector'
TURN_ON_ONLY = "trigger.event.data.service == 'turn_on'"
TURN_ON_OR_OFF = "trigger.event.data.service in ('turn_on', 'turn_off')"


def passing_turn_off(conditions):
    """The detector's conditions with its turn_on filter widened to turn_off."""
    return [dict(c, value_template=c['value_template'].replace(TURN_ON_ONLY, TURN_ON_OR_OFF))
            if isinstance(c, dict) and isinstance(c.get('value_template'), str) else c for c in conditions]


def bridge(slug, original):
    result = copy.deepcopy(original)
    if slug == DETECTOR:
        for key in ('conditions', 'condition'):
            if isinstance(result.get(key), list):
                result[key] = passing_turn_off(result[key])
    action = original.get('actions', original.get('action', []))
    rooms = set(re.findall(r'script\.ls_remote_gesture_([a-z0-9_]+)', json.dumps(action)))
    args = {'trigger': TRIGGER_DATA}
    # The automation's own variables (the dashboard controls' `sources`) are
    # what its conditions routed by, so the port reads the same mapping.
    for name in original.get('variables', {}):
        if not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]*', name) or name in ('trigger', 'room'):
            raise ValueError(f'{slug}: cannot forward the variable {name!r}')
        args[name] = '{{ ' + name + ' }}'
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


# Room-by-room rollout. The old automations keep running and skip rooms whose
# port switch input_boolean.ls_<room>_on_port is on; each rollout bridge is a
# NEW automation (id + '_port') that forwards to the port only for those rooms.
#
# House-wide store writers get no rollout bridge: the old scripts stay the one
# writer of the overlay store for every house-wide event, and the port renders
# what they commit through the recovery bridge (within its 5 s period). A
# second writer would commit every such event twice.
ROLLOUT_OLD_ONLY = {
    'lighting_schedule_override_store_writer': 'Commits the ls_override events the old automations fire; one writer for the overlay store.',
    'lighting_schedule_end_overrides': 'Expires overlays house-wide; the old scripts commit, the port renders from the store.',
    'lighting_schedule_sara_mode_switch': 'Sara mode is house-wide; the old scripts commit it, the port renders from the store.',
    'switch_lamps_validate_house_defaults': 'House switch ranges; the old scripts commit them, the port renders from the store.',
    'effects_refresh_native_light_controls': 'The dashboard mirror; the old scripts keep publishing it.',
}
ON_PORT = "is_state('input_boolean.ls_' ~ {area} ~ '_on_port', 'on')"
# A room's lamps switched from the app: the port's only when every lamp named is in a room on the port.
LAMP_CHANGE_ON_PORT = """{% set data = trigger.event.data.service_data | default({}) %}
{% set ids = data.entity_id | default([]) %}{% set ids = [ids] if ids is string else ids | list %}
{% set n = namespace(ok=ids | count > 0) %}
{% for e in ids %}{% if not """ + ON_PORT.format(area='area_id(e)') + """ %}{% set n.ok = false %}{% endif %}{% endfor %}
{{ n.ok }}"""
NATIVE_ON_PORT = ("{% set s = sources.get(trigger.topic.split('/')[3]) %}{{ s is not none and "
                  + ON_PORT.format(area='area_id(s)') + " }}")
ANY_ON_PORT = ("{{ states.input_boolean | selectattr('entity_id', 'search', '^input_boolean\\.ls_.+_on_port$')"
               " | selectattr('state', 'eq', 'on') | list | count > 0 }}")


def template(text):
    return {'condition': 'template', 'value_template': text}


def rollout_bridge(slug, original, remotes):
    """The bridge as a new automation beside the old one, acting only for rooms on the port."""
    if 'id' not in original:
        raise ValueError(f'{slug} has no id to derive the rollout id from')
    result = bridge(slug, original)
    result['id'] = str(original['id']) + '_port'
    result['alias'] = original.get('alias', slug) + ' (port)'
    conditions = list(result.get('conditions', result.get('condition', [])))
    result.pop('condition', None)
    room = result['actions'][0]['event_data']['args'].get('room')
    if room is not None:
        remote = remotes.get(room)
        if not isinstance(remote, dict) or not isinstance(remote.get('device_id'), str):
            raise ValueError(f'{slug}: no catalog.remotes.{room}.device_id to find the remote\'s room')
        conditions.append(template('{{ ' + ON_PORT.format(area="area_id('" + remote['device_id'] + "')") + ' }}'))
    elif slug == 'effects_native_light_controls':
        conditions.append(template(NATIVE_ON_PORT))
    elif slug == 'lighting_schedule_lamp_change_detector':
        conditions.append(template(LAMP_CHANGE_ON_PORT))
    elif slug == 'lighting_schedule_engine':
        # The tick and the lamp state triggers apply the whole house: the old
        # scripts commit those and the port renders them through recovery.
        result['triggers'] = [t for t in original.get('triggers', original.get('trigger', [])) if t.get('id') == 'lamp_on']
        result.pop('trigger', None)
        if not result['triggers']:
            raise ValueError(f'{slug} has no lamp_on trigger')
        conditions.append(template('{{ ' + ON_PORT.format(area='area_id(trigger.entity_id)') + ' }}'))
    elif slug == 'lighting_recover_pending_output':
        # Its own check reads the old scripts' render bookkeeping, which the port does not share.
        conditions = [c for c in conditions if 'ls_effects_runtime' not in json.dumps(c)]
        conditions.append(template(ANY_ON_PORT))
    else:
        raise ValueError(f'{slug}: the rollout does not know whether it is a room or the house; add it to a list')
    result['conditions'] = conditions
    result['description'] = 'Rollout bridge (rooms on the port only). ' + original.get('description', '')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'reference/live/automations')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--rollout', action='store_true',
                        help='Bridges that run beside the old automations, for rooms whose port switch is on.')
    parser.add_argument('--catalog', type=Path, default=ROOT / '.runtime/catalog.json',
                        help='Runtime catalog; --rollout reads each remote\'s device from it.')
    args = parser.parse_args()
    if args.output is None:
        args.output = ROOT / ('.runtime/bridge-rollout' if args.rollout else '.runtime/bridge')
    if args.rollout:
        rollout(args)
        return
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest = {'bridges': [], 'script_bridges': [], 'retained': RETAINED, 'retired': RETIRED, 'applied': False,
                'response_queries': 'Local src/rpc.ts only; HA script bridges are commands, with dry_run suppressed.'}
    for path in sorted(args.source.glob('*.json')):
        if path.stem in RETAINED or path.stem in RETIRED:
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


def write_new(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def rollout(args):
    remotes = json.loads(args.catalog.read_text()).get('remotes', {})
    prepared = []
    for path in sorted(args.source.glob('*.json')):
        if path.stem in RETAINED or path.stem in RETIRED or path.stem in ROLLOUT_OLD_ONLY:
            continue
        envelope = json.loads(path.read_text())
        prepared.append((path, rollout_bridge(path.stem, envelope.get('config', envelope), remotes)))
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    for path, result in prepared:
        write_new(args.output / path.name, result)
    manifest = {'mode': 'rollout', 'bridges': [path.stem for path, _ in prepared], 'old_only': ROLLOUT_OLD_ONLY,
                'retained': RETAINED, 'retired': RETIRED, 'script_bridges': [], 'applied': False,
                'scripts': 'No script shims during the rollout: the old scripts still call their own scripts.'}
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Prepared {len(prepared)} rollout bridges at {args.output}; nothing applied.")


if __name__ == '__main__':
    main()
