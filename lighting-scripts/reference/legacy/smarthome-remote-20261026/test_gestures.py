import ast
import asyncio
import copy
import json
from pathlib import Path
import site
import sys

# Use the installed production HA version and its exact dependency closure.
wrapper = Path('/nix/store/lrb2mmjfq9f6ikv454cn499xw4d2drsp-homeassistant-2026.7.4/bin/.hass-wrapped')
for node in ast.walk(ast.parse(wrapper.read_text())):
    if isinstance(node, ast.List) and node.elts and all(isinstance(x, ast.Constant) and isinstance(x.value, str) and x.value.startswith('/nix/store/') for x in node.elts):
        for path in ast.literal_eval(node):
            site.addsitedir(path)

from homeassistant.core import HomeAssistant, Context
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.script import Script
from homeassistant.helpers import area_registry, device_registry, entity_registry
from homeassistant import loader


async def replay(config, room, events, initial_cursor=0):
    hass = HomeAssistant('/tmp/smarthome-remote-20261026/isolated-ha')
    loader.async_setup(hass)
    device_registry.async_setup(hass)
    await device_registry.async_load(hass, load_empty=True)
    await entity_registry.async_load(hass, load_empty=True)
    await area_registry.async_load(hass, load_empty=True)
    area_registry.async_get(hass).async_create(room)
    remote_id = {'kitchen':'1c125b382f1e1d19eb9e999b6cc07466','bedroom':'0e973e9202acb5ace9a8e6a8b336891d','living_room':'0752f2b4e9a0992ac8efc2af1f53c62a'}[room]
    device_registry.async_get(hass).devices[remote_id] = device_registry.DeviceEntry(id=remote_id, area_id=room)
    output = []
    timers = []
    prefix = 'ls_' + room + '_remote_'
    for entity, value in {
        'input_number.'+prefix+'preset': initial_cursor,
        'input_number.'+prefix+'chord_step': 0,
        'input_number.'+prefix+'power_count': 0,
        'input_text.'+prefix+'power_token': '',
        'timer.'+prefix+'chord': 'idle',
    }.items():
        hass.states.async_set(entity, str(value))

    # Only service I/O is replaced. The production sequence, templates, branch
    # execution and variable scopes are executed by Home Assistant itself.
    async def service(call):
        ids = call.data.get('entity_id', [])
        ids = [ids] if isinstance(ids, str) else ids
        for entity in ids:
            if call.domain in ('input_number', 'input_text'):
                hass.states.async_set(entity, str(call.data['value']))
            elif call.domain == 'timer':
                hass.states.async_set(entity, 'active' if call.service == 'start' else 'idle')
            elif entity == 'script.ls_remote_command':
                output.append(call.data['variables']['command'])
            elif entity.startswith('script.ls_remote_power_quiet_'):
                timers.append(call.data['variables']['token'])
            else:
                raise AssertionError(f'unexpected service target: {entity}')

    for domain, name in [('input_number','set_value'),('input_text','set_value'),('timer','start'),('timer','cancel'),('script','turn_on')]:
        hass.services.async_register(domain, name, service)
    sequence = cv.SCRIPT_SCHEMA(copy.deepcopy(config['sequence']))
    script = Script(hass, sequence, 'replay', 'script', script_mode='queued', max_runs=50)
    for event in events:
        data = copy.deepcopy(event)
        if data['command'] == 'power_done':
            data['token'] = timers[-1]
        await script.async_run(data, Context())
    cursor = float(hass.states.get('input_number.'+prefix+'preset').state)
    await script.async_stop()
    await hass.async_stop()
    return output, cursor


def preset(index, family='color'):
    if family == 'color':
        return {'command':'preset','payload':{'action':'color_temperature_move','action_color_temperature':[200,285,370,454,588][index]}}
    return {'command':'preset','payload':{'action':'brightness_move_to_level','action_level':[254,229,178,76,2][index]}}


async def main():
    document = json.loads(Path(sys.argv[1]).read_text())
    configs = document.get('original', document)
    failures = []
    checks = 0
    power = {'command':'power'}
    done = {'command':'power_done'}
    cases = [
        ('first right after power, delayed companion', 0, [power,done,preset(0),preset(0,'brightness')], ['toggle','right'], 0),
        ('first left after power', 4, [power,done,preset(4,'brightness'),preset(4)], ['toggle','left'], 4),
        ('right wrap', 4, [preset(0),preset(0,'brightness')], ['right'], 0),
        ('left wrap', 0, [preset(4,'brightness'),preset(4)], ['left'], 4),
        ('completion does not reset newer cursor', 0, [power,preset(0),done,preset(1),preset(1,'brightness')], ['right','toggle','right'], 1),
        ('double power then first right', 2, [power,power,done,preset(0),preset(0,'brightness')], ['right'], 0),
        ('triple power preserves reset', 3, [power,power,power,done,preset(0),preset(0,'brightness')], ['reset','right'], 0),
        ('secret chord', 0, [power,power,preset(4),preset(4,'brightness'),preset(0),preset(0,'brightness'),preset(4),preset(4,'brightness'),preset(0),preset(0,'brightness'),done], ['sara_toggle'], 0),
        ('malformed preset does not move cursor', 2, [{'command':'preset','payload':{'action':'color_temperature_move','action_color_temperature':999}}], [], 2),
        ('late brightness companion across power is not another arrow', 4, [preset(0),power,preset(0,'brightness'),done], ['right','toggle'], -1),
        ('brightness then power then colour still counts one arrow', 4, [preset(0,'brightness'),power,preset(0),done], ['right','toggle'], 0),
    ]
    for room in ['kitchen','bedroom','living_room']:
        config = configs['ls_remote_gesture_'+room]['config']
        for name, initial, events, expected, cursor in cases:
            actual = await replay(config, room, events, initial)
            checks += 1
            if actual != (expected, cursor):
                failures.append({'room':room,'case':name,'expected':[expected,cursor],'actual':actual})
    print(json.dumps({'checks':checks,'failures':failures}, indent=2))
    raise SystemExit(bool(failures))


if __name__ == '__main__':
    asyncio.run(main())
