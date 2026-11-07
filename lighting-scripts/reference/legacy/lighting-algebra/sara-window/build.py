"""Change only the user-approved Power recognition window, preserving scripts."""
import json
from pathlib import Path
import shutil

STAGE = Path(__file__).resolve().parent
BASE = STAGE.parent / 'remote-ranges/candidate'
OUT = STAGE / 'candidate'
OUT.mkdir(exist_ok=True)
for path in BASE.glob('*.json'):
    shutil.copyfile(path, OUT / path.name)

for room in ['bedroom', 'living_room']:
    actor = OUT / ('ls_remote_gesture_' + room + '.json')
    config = json.loads(actor.read_text())
    expression = config['sequence'][2]['variables']['quiet_active']
    assert expression.count('+0.4>') == 1
    config['sequence'][2]['variables']['quiet_active'] = expression.replace('+0.4>', '+0.6>')
    actor.write_text(json.dumps(config, indent=2) + '\n')
    json.loads(actor.read_text())

    quiet = OUT / ('ls_remote_power_quiet_' + room + '.json')
    config = json.loads(quiet.read_text())
    assert config['sequence'][0]['delay'] == {'milliseconds': 400}
    config['sequence'][0]['delay']['milliseconds'] = 600
    quiet.write_text(json.dumps(config, indent=2) + '\n')
    json.loads(quiet.read_text())

from test_sara_window import WindowReplay
env = WindowReplay().env
def validate(value):
    if isinstance(value, dict):
        for item in value.values():
            validate(item)
    elif isinstance(value, list):
        for item in value:
            validate(item)
    elif isinstance(value, str) and ('{{' in value or '{%' in value):
        env.parse(value)

changed = []
for path in OUT.glob('*.json'):
    config = json.loads(path.read_text())
    if config != json.loads((BASE / path.name).read_text()):
        changed.append(path.stem)
        validate(config)
assert len(changed) == 4, changed
(STAGE / 'changed.json').write_text(json.dumps(changed, indent=2) + '\n')
print('Validated JSON/Jinja for four scripts; only recognition window changed')
