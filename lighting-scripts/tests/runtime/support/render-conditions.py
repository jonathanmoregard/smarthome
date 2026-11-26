#!/usr/bin/env python3
"""Render an automation's template conditions as Home Assistant 2026.7.4 decides them, for the close-out round 3
reproducers (tests/runtime/closeout-r3.test.ts).

Reads one JSON object on stdin: {conditions, trigger, areas, on}. `areas` maps an entity, device or label id to its area
(`area_id`); `on` lists the entities `is_state(..., 'on')` holds for. Jinja and `result_as_boolean` come from the Home
Assistant closure (tests/parity/portability.py), the registry functions are stubs over `areas` and `on`, and `states`
holds no running script. Prints one JSON line: each template condition's verdict, in order.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'parity'))
from portability import dependencies  # noqa: E402

dependencies()
import jinja2  # noqa: E402
from homeassistant.helpers.template.helpers import result_as_boolean  # noqa: E402

given = json.load(sys.stdin)
environment = jinja2.Environment(extensions=['jinja2.ext.loopcontrols'])
environment.globals.update(
    area_id=lambda lookup: given['areas'].get(lookup),
    is_state=lambda entity, state: state == 'on' and entity in given['on'],
)
verdicts = [result_as_boolean(environment.from_string(condition['value_template']).render(
    trigger=given['trigger'], states={'script': []}).strip())
    for condition in given['conditions'] if condition.get('condition') == 'template']
print(json.dumps(verdicts))
