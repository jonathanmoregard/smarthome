"""Validate the generated HA shims with HA's own template engine, without I/O."""
import asyncio
import importlib.util
import json
import tempfile
from pathlib import Path
from portability import ROOT, dependencies

dependencies()
from homeassistant.core import Context, Event, HomeAssistant, State
from homeassistant.helpers.template import Template


async def main():
    spec = importlib.util.spec_from_file_location('export_bridge', ROOT / 'scripts/export-bridge.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='smarthome-native-bridge-') as temporary:
        hass = HomeAssistant(temporary)
        count = 0
        for path in sorted((ROOT / 'reference/live/scripts').glob('*.json')):
            if path.stem not in module.COMMAND_SCRIPTS and not path.stem.startswith(('ls_remote_gesture_', 'ls_remote_power_quiet_')):
                continue
            original = json.loads(path.read_text())['config']
            shim = module.script_bridge(path.stem, original)
            template = Template(shim['sequence'][1]['event_data']['args'], hass)
            assert template.async_render({}, strict=True) == {}
            for value in (False, 0, None, 'fixture'):
                data = dict.fromkeys(original.get('fields', {}), value)
                assert template.async_render(data, strict=True) == data, path.stem
                count += 1
            guard = Template(shim['sequence'][0]['value_template'], hass)
            assert guard.async_render({}, strict=True) is True
            assert guard.async_render({'dry_run': True}, strict=True) is False
        trigger = {'id': 'on', 'entity_id': 'light.example', 'to_state': State('light.example', 'on', context=Context(user_id='fixture-user'))}
        forwarded = Template(module.TRIGGER_DATA, hass).async_render({'trigger': trigger}, strict=True)
        assert forwarded['to_state']['context']['user_id'] == 'fixture-user'
        assert forwarded['to_state']['state'] == 'on'
        event = Event('ls_override', {'op': 'clear_all'}, context=Context(user_id='fixture-user'))
        forwarded = Template(module.TRIGGER_DATA, hass).async_render({'trigger': {'event': event}}, strict=True)
        assert forwarded['event']['data'] == {'op': 'clear_all'}
        assert forwarded['event']['context']['user_id'] == 'fixture-user'
        await hass.async_stop()
    print(json.dumps({'native_ha_bridge_field_cases': count, 'state_context_serialization': True, 'dry_run_guard': True}))


if __name__ == '__main__':
    asyncio.run(main())
