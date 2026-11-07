"""Execute exported HA scripts offline, with all external effects captured.

The reused interpreter evaluates the actual script sequence and Jinja source.
This adapter adds the current exports, actual override-writer automation, and
assertions that dry entry points neither mutate simulated state nor emit calls.
There are no network clients, sockets, MQTT clients, or live-service adapters.
"""
from __future__ import annotations

import copy
import ast
import json
import math
import os
from collections import deque
import re
import sys
from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, '/tmp/effects-promotion/tests')
from harness import Budget, End, Sim, States  # noqa: E402

ROOT = Path('/tmp/lighting-algebra')
DEFAULT_CANDIDATE = Path(os.environ.get('LIGHTING_CANDIDATE', ROOT / 'candidate'))
RUNTIME = 'sensor.ls_effects_runtime' if (DEFAULT_CANDIDATE / 'ls_commit.json').exists() else 'sensor.effects_controller'


class StateDomain:
    def __init__(self, states, prefix):
        self.states, self.prefix = states, prefix

    def __getattr__(self, key):
        return self.states[self.prefix + '.' + key]

    def __iter__(self):
        return (self.states[key] for key in self.states.sim.state
                if key.startswith(self.prefix + '.'))


class StateViews(States):
    def __getattr__(self, key):
        return StateDomain(self, key)

    def __getitem__(self, key):
        value = super().__getitem__(key)
        if value is not None and not hasattr(value, 'context'):
            value.context = SimpleNamespace(id=None, user_id=None, parent_id=None)
        return value


class DrySim(Sim):
    def __init__(self, candidate: str | Path | None = DEFAULT_CANDIDATE):
        super().__init__()
        self.automations = {}
        for directory in (ROOT / 'before', Path(candidate) if candidate else None):
            if directory is None:
                continue
            for path in directory.glob('*.json'):
                value = json.loads(path.read_text())
                if not isinstance(value, dict):
                    continue
                config = value.get('config', value)
                if not isinstance(config, dict):
                    continue
                if 'sequence' in config:
                    self.config[path.stem] = config
                elif 'actions' in config:
                    self.automations[path.stem] = config
        self.states = StateViews(self)
        self.env.globals['states'] = self.states
        self.env.globals['is_state_attr'] = lambda entity, key, value: self.attr(entity, key) == value
        self.env.globals['is_number'] = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool)
        self.env.globals['area_entities'] = lambda area: [entity for entity, value in self.areas.items() if value == area]
        self.env.globals['expand'] = self.expand
        self.env.filters['log'] = math.log
        self.env.from_string = lru_cache(maxsize=256)(self.env.from_string)
        self.output_jobs = deque()
        self.on_publish = None
        if 'ls_commit' in self.config:
            self.put('sensor.ls_effects_runtime', '0', {'assignments': {}, 'targets': {},
                     'applied': {}, 'handled_rooms': {}, 'revision': self.now.isoformat()})
            for room in set(self.areas.values()):
                self.put('sensor.ls_cache_' + room, '0', {'cache': {}})
        self.calls.clear()
        self.events.clear()

    def advance(self, seconds=1):
        self.now += timedelta(seconds=seconds)
        self.elapsed += seconds

    def render(self, value, context):
        if isinstance(value, dict):
            return {key: self.render(item, context) for key, item in value.items()}
        if isinstance(value, list):
            return [self.render(item, context) for item in value]
        if not isinstance(value, str) or ('{{' not in value and '{%' not in value):
            return value
        output = self.env.from_string(value).render(context).strip()
        # A direct JSON serialization is a payload string. JSON used *inside*
        # helper macros must not suppress native conversion of the final result.
        if '{%' not in value and re.search(r'\|\s*to_json\s*}}\s*$', value):
            return output
        try:
            parsed = ast.literal_eval(output)
        except (ValueError, SyntaxError):
            return output
        # HA only promotes decimal numeric text. Python literal_eval alone
        # wrongly turns hexadecimal device/source ids into integers. Verified
        # against strict HA rendering of "0x385b44fffea50c99".
        numeric_text = re.fullmatch(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?', output)
        if isinstance(parsed, complex) or (isinstance(parsed, (int, float))
                                           and not isinstance(parsed, bool) and not numeric_text):
            return output
        return parsed

    def expand(self, entities):
        pending = [entities] if isinstance(entities, str) else list(entities)
        expanded, seen = [], set()
        while pending:
            entity = pending.pop(0)
            if entity in seen:
                continue
            seen.add(entity)
            children = self.attr(entity, 'entity_id')
            if isinstance(children, list):
                pending.extend(children)
            elif self.states[entity] is not None:
                expanded.append(self.states[entity])
        return expanded

    def run(self, name, **context):
        if name == 'ls_commit':
            self.advance(.000001)  # Distinct real service invocations must not alias versions.
        assert name in self.config, ('unknown script', name)
        defaults = {key: field['default'] for key, field in self.config[name].get('fields', {}).items()
                    if 'default' in field}
        return super().run(name, **(defaults | context))

    def cond(self, condition, context):
        if isinstance(condition, dict):
            kind = condition.get('condition')
            if kind in ('and', 'or', 'not'):
                values = [self.cond(item, context) for item in condition['conditions']]
                return all(values) if kind == 'and' else any(values) if kind == 'or' else not any(values)
            if kind == 'trigger':
                identifiers = condition['id']
                identifiers = [identifiers] if isinstance(identifiers, str) else identifiers
                return context.get('trigger', {}).get('id') in identifiers
        return super().cond(condition, context)

    def queue_mqtt(self, arrivals):
        """Schedule synthetic messages at absolute simulator elapsed seconds."""
        self.mqtt_queue = sorted(copy.deepcopy(arrivals), key=lambda message: message['time'])

    def seq(self, steps, context):
        for step in steps:
            if 'wait_for_trigger' in step:
                triggers = self.render(step['wait_for_trigger'], context)
                assert all(trigger['trigger'] == 'mqtt' for trigger in triggers), 'unsupported wait trigger'
                timeout = self.render(step['timeout'], context)
                seconds = timeout.get('seconds', 0) + timeout.get('milliseconds', 0) / 1000
                deadline = self.elapsed + seconds
                found = None
                queue = getattr(self, 'mqtt_queue', [])
                while queue and queue[0]['time'] <= deadline:
                    message = queue.pop(0)
                    if message['time'] < self.elapsed:
                        continue
                    self.advance(message['time'] - self.elapsed)
                    if any(message['topic'] == trigger['topic'] and
                           message.get('payload') == trigger.get('payload') for trigger in triggers):
                        found = message
                        break
                if found is None:
                    self.advance(deadline - self.elapsed)
                context['wait'] = {'completed': found is not None, 'trigger': found,
                                   'remaining': max(0, deadline - self.elapsed)}
                if found is None and not step.get('continue_on_timeout', True):
                    raise End()
            elif 'repeat' in step and 'until' in step['repeat']:
                repeat = step['repeat']
                prior = context.get('repeat')
                for index in range(1, 10001):
                    context['repeat'] = {'index': index, 'first': index == 1}
                    self.seq(repeat['sequence'], context)
                    if self.cond(repeat['until'], context):
                        break
                else:
                    raise AssertionError('unbounded repeat-until')
                if prior is None:
                    context.pop('repeat', None)
                else:
                    context['repeat'] = prior
            else:
                super().seq([step], context)

    def run_automation(self, name, trigger):
        config = self.automations[name]
        context = {'trigger': trigger}
        for key, value in config.get('variables', {}).items():
            context[key] = self.render(value, context)
        if not self.cond(config.get('conditions', []), context):
            return
        try:
            self.seq(config['actions'], context)
        except End as end:
            return end.value

    def event(self, name, data):
        writer = self.automations.get('automation_lighting_schedule_override_store_writer')
        if name == 'ls_override' and writer:
            self.events.append((name, copy.deepcopy(data)))
            context = {'trigger': {'event': {'data': data, 'context': {'user_id': None}}}}
            try:
                self.seq(writer['actions'], context)
            except End:
                pass
            return
        super().event(name, data)

    def apply(self, **context):
        """Request an apply, then explicitly settle its queued output in tests."""
        result = self.run('ls_apply', **context)
        self.drain_output()
        return result

    def drain_output(self, limit=100):
        count = 0
        while self.output_jobs:
            assert count < limit, 'render scheduling loop'
            self.run('ls_render', **self.output_jobs.popleft())
            count += 1
        return count

    def service(self, action, target, data):
        if action == 'script.turn_on' and target.get('entity_id') == 'script.ls_render':
            self.calls.append({'time': self.elapsed, 'action': action,
                               'target': copy.deepcopy(target), 'data': copy.deepcopy(data)})
            self.output_jobs.append(copy.deepcopy(data.get('variables', {})))
            return
        if action == 'variable.update_sensor':
            self.calls.append({'time': self.elapsed, 'action': action,
                               'target': copy.deepcopy(target), 'data': copy.deepcopy(data)})
            entities = target.get('entity_id', [])
            entities = [entities] if isinstance(entities, str) else entities
            for entity in entities:
                attributes = {} if data.get('replace_attributes', False) else copy.deepcopy(
                    self.state.get(entity, {}).get('attributes', {}))
                attributes.update(data.get('attributes', {}))
                self.put(entity, data.get('value', self.states(entity)), attributes)
            return
        result = super().service(action, target, data)
        if action == 'mqtt.publish' and data['topic'].startswith('zigbee2mqtt/') and self.on_publish:
            self.on_publish(self)
        return result

    def writes_since(self, start):
        return [call for call in self.calls[start:]
                if not call['action'].startswith('script.')
                or call['action'] in ('script.turn_on', 'script.turn_off')]

    def pure(self, name, **context):
        before = copy.deepcopy(self.state)
        call_count, event_count = len(self.calls), len(self.events)
        result = self.run(name, **context)
        assert self.state == before, f'{name} mutated state in dry execution'
        assert len(self.events) == event_count, f'{name} emitted an event in dry execution'
        assert self.writes_since(call_count) == [], f'{name} called an external action in dry execution'
        return result

    def bounded_engine(self, seconds=5, **context):
        self.elapsed = 0
        self.max_elapsed = seconds
        try:
            self.run('effects_engine', **context)
        except Budget:
            pass
        finally:
            self.max_elapsed = None


def check_traffic(calls, budget):
    """Check actual captured publish times, not a copy of pacing logic."""
    sends = [call for call in calls if call['action'] == 'mqtt.publish'
             and call['data']['topic'].startswith('zigbee2mqtt/')]
    for send in sends:
        assert send['data'].get('qos', 0) == 0
        assert send['data'].get('retain', False) is False
    for earlier, later in zip(sends, sends[1:]) if budget else []:
        assert later['time'] - earlier['time'] >= 1 / budget - 1e-6, (earlier, later)
    return sends
