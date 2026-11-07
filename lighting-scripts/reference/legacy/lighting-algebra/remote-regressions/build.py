"""Minimal transforms over the already deployed runtime script snapshot."""
import json
from pathlib import Path

STAGE = Path(__file__).parent
BASE = STAGE.parent/'input-processors/candidate'


def build_dispatch():
    cfg = json.loads((BASE/'ls_dispatch.json').read_text())
    variable = cfg['sequence'][4]['variables']
    old = "(L in requested or baseline.targets[L].get('send',true))"
    new = "(L in requested or t.area in plan.get('remote_rooms',[]) or baseline.targets[L].get('send',true))"
    assert variable['ordinary'].count(old) == 1
    variable['ordinary'] = variable['ordinary'].replace(old, new)
    cfg['description'] += ' Pending room input remains eligible for output when coalesced into a quiet scheduled tick.'
    (STAGE/'candidate/ls_dispatch.json').write_text(json.dumps(cfg, indent=2)+'\n')


def build_gesture(room):
    cfg = json.loads((BASE/('ls_remote_gesture_'+room+'.json')).read_text())
    counts = {'reset': 0, 'previous': 0, 'delta': 0}
    cursor = 'input_number.ls_'+room+'_remote_preset'

    def visit(item):
        if isinstance(item, list):
            for value in item:
                visit(value)
        elif isinstance(item, dict):
            if (item.get('action') == 'input_number.set_value'
                    and item.get('target',{}).get('entity_id') == cursor
                    and item.get('data',{}).get('value') == 0):
                item['data']['value'] = -1
                counts['reset'] += 1
            variables = item.get('variables', {})
            if 'previous' in variables:
                variables['previous'] = variables['previous'].replace('|float(-1)', '|float(-2)')
                counts['previous'] += 1
            if 'delta' in variables:
                variables['delta'] = "{{ (1 if index==0 else 4 if index==4 else -1) if previous==-1 else (index-previous|int)%5 if previous in [0,1,2,3,4] else -1 }}"
                counts['delta'] += 1
            for value in item.values():
                visit(value)

    visit(cfg)
    assert counts == {'reset':1,'previous':1,'delta':1}, counts
    cfg['description'] += ' Cursor -1 means the hardware was reset but no first preset has been observed; first 0/4 is right/left. Unavailable cursor remains unknown.'
    (STAGE/'candidate'/('ls_remote_gesture_'+room+'.json')).write_text(json.dumps(cfg,indent=2)+'\n')


if __name__ == '__main__':
    build_dispatch()
    for room in ['bedroom','living_room']:
        build_gesture(room)
