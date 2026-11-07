"""Actual HA scripts with a strictly offline state/service sink."""
import json
import os
import sys
from pathlib import Path

ROOT = Path('/tmp/lighting-algebra')
STAGE = ROOT / 'input-processors'
sys.path.insert(0, str(ROOT / 'tests'))
from performance_harness import PerformanceSim, RUNTIME  # noqa: E402

ROOM = 'living_room'
CANDLE = 'light.living_room_table_lamp'
NORMAL = 'light.living_room_hall_ceiling'
SOURCE = 'offline-input'
KEY = 'channels:' + SOURCE


class InputSim(PerformanceSim):
    def __init__(self, candidate=None, candle=False, expiry=False):
        super().__init__()
        candidate = Path(candidate or os.environ.get('INPUT_CANDIDATE', STAGE / 'candidate'))
        # PerformanceSim historically pins its exports. Overlay every candidate
        # config, including automations, so no old planner silently gets tested.
        for path in candidate.glob('*.json'):
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                continue
            config = value.get('config', value)
            if 'sequence' in config:
                self.config[path.stem] = config
            elif 'actions' in config:
                self.automations[path.stem] = config
        self.put('input_boolean.ls_ovr_next_block_on', 'on' if expiry else 'off')
        for period, brightness, kelvin in [('day', 220, 4000), ('cosy', 110, 2200), ('night', 3, 1950)]:
            self.store('input_text.ls_house_' + period,
                       {'on': True, 'b': brightness, 'm': 'ct', 'k': kelvin})
            if candle:
                self.store('input_text.ls_lamp_living_room_table_lamp_' + period,
                           {'own': True, 'on': True, 'b': 105, 'm': 'ct', 'k': 2200, 'effect': 'Candle'})

    def click(self, command='up', room=ROOM, source=SOURCE):
        return self.remote(room=room, command=command, source=source)

    def resolved(self):
        return self.pure('ls_plan')['plan']['resolved']['targets']

    def room_plan(self, cache=None):
        return self.pure('ls_room_plan', room=ROOM,
                         overrides=self.attr('sensor.ls_overrides', 'overrides'),
                         cache=cache or {}, reason='remote')

    def ui(self, attribute, value, source='light.living_room'):
        self.advance(.1)
        self.run('effects_set', source=source, attribute=attribute, value=value)

    def clear_observations(self):
        self.calls.clear()
        self.script_runs.clear()
        self.blocking_steps.clear()


def clamp(value, low=-2, high=2):
    return max(low, min(high, value))
