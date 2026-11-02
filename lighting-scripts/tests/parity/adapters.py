"""Replace execution seams, keeping the legacy scenario and assertion bodies."""
from __future__ import annotations
import ast
import copy
from collections import deque
import hashlib
import math
from datetime import datetime
import importlib
import inspect
import json
import os
from pathlib import Path
import re
import textwrap
from rpc import empty_snapshot, ROOT
from portability import LEGACY_AUTOMATION_ALIASES, LEGACY_SCRIPT_ALIASES


class RpcTemplate:
    """Legacy pure tests literal_eval render output; repr preserves that contract."""
    def __init__(self, rpc, name, oracle=None):
        self.rpc, self.name, self.oracle = rpc, name, oracle

    def render(self, **args):
        actual = self.rpc.pure(self.name, args)
        if self.oracle is not None:
            expected = ast.literal_eval(self.oracle.render(**args).strip())
            equal_results(actual, expected)
            self.rpc.comparisons += 1
        return repr(actual)


def equal_results(actual, expected, path='$'):
    if isinstance(actual, (int, float)) and not isinstance(actual, bool) and isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-9), (path, actual, expected)
    elif isinstance(actual, dict) and isinstance(expected, dict):
        assert actual.keys() == expected.keys(), (path, sorted(actual), sorted(expected))
        for key in actual:
            equal_results(actual[key], expected[key], path + '.' + str(key))
    elif isinstance(actual, list) and isinstance(expected, (list, tuple)):
        assert len(actual) == len(expected), (path, len(actual), len(expected))
        for index, (left, right) in enumerate(zip(actual, expected)):
            equal_results(left, right, path + '[' + str(index) + ']')
    else:
        assert type(actual) is type(expected) and actual == expected, (path, actual, expected)


def remote_binding(config):
    """Extract the single captured remote identity without exposing its value."""
    device_ids, source_ids = set(), set()

    def find(value):
        if isinstance(value, dict):
            if isinstance(value.get('device_id'), str):
                device_ids.add(value['device_id'])
            if isinstance(value.get('source'), str):
                source_ids.add(value['source'])
            for child in value.values():
                find(child)
        elif isinstance(value, list):
            for child in value:
                find(child)
        elif isinstance(value, str):
            device_ids.update(re.findall(r'(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])', value))

    find(config)
    assert len(device_ids) == 1 and len(source_ids) == 1, \
        f'Historical remote binding counts: remote={len(device_ids)}, source={len(source_ids)}'
    return device_ids.pop(), source_ids.pop()


def pure_templates(module, rpc, compare=False):
    if hasattr(module, 'TEMPLATES'):
        module.TEMPLATES = {name: RpcTemplate(rpc, name, template if compare else None) for name, template in module.TEMPLATES.items()}
    elif hasattr(module, 'TEMPLATE'):
        module.TEMPLATE = RpcTemplate(rpc, 'effects_group_plan', module.TEMPLATE if compare else None)
    else:
        raise AssertionError('No supported pure-template seam')


def simulator(stage, rpc, module_path=None):
    """Reuse state fixture builders, but never their sequence interpreter.

    Sim.__init__ invokes effects_catalog once to seed its fixture. Its original
    export is a literal object, read directly here, not evaluated with Jinja.
    Every run after construction crosses the TypeScript RPC boundary.
    """
    dry = importlib.import_module('dry_harness')
    original_init = dry.DrySim.__init__
    original_render = dry.DrySim.render
    catalog_path = stage / 'effects-promotion/live/effects_catalog.json'
    value = json.loads(catalog_path.read_text())
    catalog = value.get('config', value)['sequence'][0]['variables']['result']
    assert isinstance(catalog, dict), 'Fixture catalog must be literal, never executable'
    # The wake suite explicitly compares new results with this old independent
    # oracle. Permit only that exact preserved oracle, never a script fallback.
    legacy_apply = json.loads((stage / 'lighting-algebra/before/ls_apply.json').read_text())
    wake_oracle = legacy_apply['config']['sequence'][0]['variables']['plan']
    remote_catalog = {}
    candidate = Path(os.environ['LIGHTING_CANDIDATE'])
    for alias in ('gesture_script_bedroom', 'gesture_script_living_room'):
        config = json.loads((candidate / (alias + '.json')).read_text())
        device_id, source = remote_binding(config)
        remote_catalog[alias.removeprefix('gesture_script_')] = {
            'device_id': device_id, 'source': source,
        }
    automation_names = {}
    for path in (ROOT / 'reference/live/automations').glob('*.json'):
        document = json.loads(path.read_text())
        config = document.get('config', document)
        for key in (path.stem, str(config.get('id', path.stem))):
            automation_names['automation_' + key] = path.stem
    legacy_routes = {
        alias.removeprefix('gesture_'): {'entrypoint': current, 'role': alias.split('_')[1], 'room': alias.split('_', 2)[2]}
        for alias, current in LEGACY_AUTOMATION_ALIASES.items()
        if alias.startswith('gesture_')
    }
    class_service_modules = {
        'lighting-algebra/remote/gesture_test.py',
        'lighting-algebra/remote/preset_test.py',
        'lighting-algebra/remote/test_remote.py',
        'lighting-algebra/remote-regressions/test_first_arrow.py',
        'lighting-algebra/sara-window/test_sara_window.py',
        'lighting-algebra/tests/test_gesture_integration.py',
        'lighting-algebra/tests/test_gesture_native_conditions.py',
    }
    direct_script_service_modules = {
        'lighting-algebra/remote/preset_test.py',
        'lighting-algebra/remote/test_remote.py',
    }

    def initialize(self, *args, **kwargs):
        self._parity_initializing = True
        self._parity_catalog = copy.deepcopy(catalog)
        self._parity_catalog['remotes'] = {
            **copy.deepcopy(self._parity_catalog.get('remotes', {})), **copy.deepcopy(remote_catalog),
        }
        # The migrated runtime represents the legacy planner's one aggregate
        # group as data. Membership comes from this same preserved fixture.
        self._parity_catalog['baseline_groups'] = {
            'light.kitchen_all': copy.deepcopy(catalog['groups']['light.kitchen_all'])}
        self._parity_extra = {'labels': {'private_room': ['jonathan_bedroom']}}
        try:
            original_init(self, *args, **kwargs)
        finally:
            self._parity_initializing = False

    def snapshot(self):
        selected = self.config['effects_catalog']['sequence'][0]['variables']['result']
        assert isinstance(selected, dict), 'Catalog fixture must remain literal data'
        runtime_catalog = copy.deepcopy(selected)
        runtime_catalog['baseline_groups'] = self._parity_catalog['baseline_groups']
        runtime_catalog['remotes'] = copy.deepcopy(self._parity_catalog['remotes'])
        if 'effects_ui_sync' in self.config:
            runtime_catalog['ui_rows'] = self.config['effects_ui_sync']['sequence'][1]['variables']['rows']
        if 'effects_ui_catalog' in self.config:
            runtime_catalog['ui_discovery'] = self.config['effects_ui_catalog']['sequence'][2]['repeat']['for_each']
        return {'state': copy.deepcopy(self.state), 'areas': self.areas, 'members': self.members,
                'now': self.now.isoformat(), 'elapsed': self.elapsed,
                'catalog': runtime_catalog, **self._parity_extra}

    def restore(self, result):
        self._parity_extra = {key: value for key, value in result.items()
                             if key not in ('state', 'areas', 'members', 'now', 'elapsed', 'catalog')}
        self._parity_catalog = result.get('catalog', self._parity_catalog)
        self.state, self.areas, self.members = result['state'], result['areas'], result['members']
        self.now = datetime.fromisoformat(result['now'])
        self.elapsed = result.get('elapsed', self.elapsed)

    def run(self, name, **args):
        if getattr(self, '_parity_initializing', False):
            assert name == 'effects_catalog', f'Unexpected fixture execution: {name}'
            return copy.deepcopy(catalog)
        if getattr(self, '_parity_migration_steps', None) is not None:
            steps = self._parity_migration_steps
            assert steps, 'Historical fixture exhausted before the explicit upgrade seam'
            step = steps.popleft()
            assert (name, args) == (step['script'], step['args']), ('Historical fixture scenario changed', name, args, step['script'], step['args'])
            self.state.update(copy.deepcopy(step['state_changes']))
            for key in step['state_removed']:
                self.state.pop(key)
            self.now = datetime.fromisoformat(step['now'])
            self.elapsed = step['elapsed']
            return copy.deepcopy(step['result'])
        if name == 'ls_commit':
            self.advance(.000001)
        literal_returns = None
        if module_path == 'lighting-algebra/adapters/test_adapters.py' and name == 'effects_set':
            sequence = self.config['ls_apply']['sequence']
            assert len(sequence) == 2 and set(sequence[0]) == {'variables'} \
                and set(sequence[0]['variables']) == {'result'} \
                and sequence[1] == {'stop': 'fixture', 'response_variable': 'result'}, \
                'Adapter plan dependency must remain an exact literal return fixture'
            result = sequence[0]['variables']['result']
            assert isinstance(result, dict) and set(result) == {'plan'} \
                and isinstance(result['plan'], dict) and set(result['plan']) == {'base', 'resolved'}, \
                'Adapter plan dependency must contain only literal base/resolved data'
            literal_returns = {'ls_plan': copy.deepcopy(result)}
        observed_calls, observed_events, observed_scripts = 0, 0, 1

        def observe(response):
            nonlocal observed_calls, observed_events, observed_scripts
            for call in response.get('calls', [])[observed_calls:]:
                adapted = {'time': call.get('time', self.elapsed), 'action': call['service'],
                           'data': call['data'], 'target': call.get('target', {})}
                # These preserved Replay subclasses deliberately own their
                # service recorder. Feeding the same typed call to both that
                # observer and DrySim's generic recorder would count it twice.
                if not has_class_service:
                    self.calls.append(adapted)
                if call['service'] == 'script.turn_on' and adapted['target'].get('entity_id') == 'script.ls_render':
                    queue = getattr(self, 'render_jobs', self.output_jobs)
                    queue.append(copy.deepcopy(call['data'].get('variables', {})))
            observed_calls = len(response.get('calls', []))
            incoming_events = response.get('events', [])[observed_events:]
            self.events.extend((event['event'], event['data']) for event in incoming_events)
            observed_events = len(response.get('events', []))
            for incoming in incoming_events:
                if incoming['event'] == 'ls_override':
                    # Original DrySim's event sink invokes the override-writer
                    # synchronously. The same sink now invokes its typed commit.
                    self.run('ls_commit', data=incoming['data'])
            if hasattr(self, 'script_runs'):
                self.script_runs.extend(response.get('scriptRuns', [])[observed_scripts:])
            observed_scripts = len(response.get('scriptRuns', []))

        def callback(message):
            restore(self, message['snapshot'])
            observe(message)
            call, phase = message['call'], message['phase']
            action, target, data = call['service'], call.get('target', {}), call['data']
            hook = getattr(self, 'before_service' if phase == 'before' else 'after_service', None)
            if hook:
                hook(action, target, data)
            class_wrapper = getattr(type(self), 'service', None) if module_path in class_service_modules else None
            wrapper = self.__dict__.get('service')
            if wrapper is None and class_wrapper is not None and class_wrapper is not service:
                function = ast.parse(textwrap.dedent(inspect.getsource(class_wrapper))).body[0]
                assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ('seq', 'render', 'cond')
                               for node in ast.walk(function)), 'Unsupported class service observer: legacy interpreter call'
                wrapper = class_wrapper.__get__(self, type(self))
            internal_remote_run = re.fullmatch(r'script\.ls_remote_(?:gesture|power_quiet)(?:_[a-z0-9_]+)?', action)
            callback_entity = target.get('entity_id', data.get('entity_id', ''))
            observer_relevant = module_path != 'lighting-algebra/remote/test_remote.py' \
                or action == 'script.turn_on' and callback_entity == 'script.ls_remote_command'
            if phase == 'before' and wrapper is not None and not internal_remote_run and observer_relevant:
                if getattr(self, '_parity_validated_service', None) is not wrapper:
                    if 'service' in self.__dict__:
                        function = ast.parse(textwrap.dedent(inspect.getsource(wrapper))).body[0]
                        final = function.body[-1]
                        assert isinstance(final, ast.Return) and isinstance(final.value, ast.Call) and isinstance(final.value.func, ast.Name), 'Unsupported service wrapper: expected a final delegated return'
                        delegate = final.value.func.id
                        prior = ast.Module(body=function.body[:-1], type_ignores=[])
                        assert not any(isinstance(node, ast.Name) and node.id == delegate for node in ast.walk(prior)), 'Unsupported post-service wrapper logic'
                        bound = inspect.getclosurevars(wrapper).nonlocals.get(delegate)
                        assert getattr(bound, '__self__', None) is self and getattr(bound, '__func__', None) is service, 'Unsupported service delegate'
                    self._parity_validated_service = wrapper
                observing = getattr(self, '_parity_observing_service', False)
                self._parity_observing_service = True
                try:
                    observer_action, observer_target, observer_data = action, target, data
                    entity = callback_entity
                    normalize_script = module_path in direct_script_service_modules
                    if normalize_script and action == 'script.turn_on' and isinstance(entity, str) \
                            and entity.startswith('script.ls_remote_'):
                        observer_action = entity
                        observer_target = {}
                        observer_data = copy.deepcopy(data.get('variables', {}))
                    wrapper(observer_action, observer_target, observer_data)
                finally:
                    self._parity_observing_service = observing
            if phase == 'before' and action == 'script.ls_commit':
                self.advance(.000001)
            if phase == 'before' and action == 'script.effects_emit' and getattr(self, 'before_emit', None):
                before, self.before_emit = self.before_emit, None
                before(self, data)
            if phase == 'after' and action == 'mqtt.publish' and data.get('topic', '').startswith('zigbee2mqtt/') and self.on_publish:
                self.on_publish(self)
            if phase == 'after' and action == 'mqtt.publish' and data.get('topic', '').startswith('zigbee2mqtt/') and getattr(self, 'after_publish', None):
                self.after_publish(self, data)
            return snapshot(self)

        has_class_service = module_path in class_service_modules \
            and getattr(type(self), 'service', None) not in (None, service)
        mode = 'all' if 'service' in self.__dict__ or has_class_service or any(getattr(self, key, None) for key in ('before_service', 'after_service', 'on_publish', 'before_emit', 'after_publish')) else 'commit'
        response = rpc.call(name, args, snapshot(self), callback=callback, callback_mode=mode,
                            instrument_log=self.env.filters['log'] is not math.log,
                            literal_returns=literal_returns)
        restore(self, response['snapshot'])
        observe(response)
        self._parity_last_calls = copy.deepcopy(response.get('calls', []))
        for value in response.get('mathLogCalls', []):
            self.env.filters['log'](value)  # Instrumentation observer only; TS already computed its result.
        return response['result']

    def no_reference_execution(self, *args, **kwargs):
        raise AssertionError('Unsupported parity seam: direct legacy interpreter execution is reference-only')

    def service(self, action, target, data):
        if getattr(self, '_parity_observing_service', False):
            return None  # The suspended TypeScript action executes on resume.
        raise AssertionError('Unsupported parity seam: direct fixture service invocation')

    def render_oracle(self, value, context):
        assert value == wake_oracle, 'Unsupported parity seam: only the explicit frozen wake oracle may render'
        return original_render(self, value, context)

    def event(self, name, data):
        assert name == 'ls_override', f'Unsupported parity event: {name}'
        self.events.append((name, copy.deepcopy(data)))
        return self.run('ls_commit', data=data)

    def run_automation(self, name, trigger):
        # Resolve the captured id/slug exactly, never infer a different trigger
        # handler merely because a historical automation had a similar purpose.
        self.automations[name]
        if name in legacy_routes:
            route = legacy_routes[name]
            binding = remote_catalog[route['room']]
            return self.run('automation.' + route['entrypoint'], room=route['room'], device_id=binding['device_id'],
                            source=binding['source'], trigger=trigger)
        if name == 'preset':
            config = self.automations[name]
            binding = remote_catalog['bedroom']
            rooms = set(re.findall(r'ls_([a-z0-9_]+)_remote_preset', json.dumps(config)))
            assert not rooms or rooms == {'bedroom'}, f'Historical preset room binding count: room={len(rooms)}'
            return self.run('automation.remote_preset', room='bedroom', device_id=binding['device_id'],
                            source=binding['source'], trigger=trigger)
        if name == 'automation_remote_center':
            lookup = self.env.globals.get('area_id')
            assert callable(lookup), 'Historical center automation requires the fixture area lookup'
            room = lookup('parity.remote')
            assert isinstance(room, str) and room, 'Historical center automation resolved no fixture room'
            return self.run('automation.remote_center', room=room, trigger=trigger)
        assert name in automation_names, 'Unsupported historical automation: ' + name
        return self.run('automation.' + automation_names[name], trigger=trigger)

    def bounded_engine(self, seconds=5, **args):
        self.elapsed = 0
        self.max_elapsed = seconds
        try:
            self.run('effects_engine', **args)
            for _ in range(10000):
                tasks = self._parity_extra.get('scheduled', [])
                if not tasks:
                    break
                task = min(tasks, key=lambda item: item['due'])
                tasks.remove(task)
                due = datetime.fromtimestamp(task['due'] / 1000, tz=self.now.tzinfo)
                self.advance(max(0, (due - self.now).total_seconds()))
                if self.on_delay:
                    self.on_delay(self)
                if self.elapsed >= seconds:
                    break
                self.run(task['script'], **task['args'])
            else:
                raise AssertionError('Unbounded TypeScript scheduled continuation loop')
        except dry.Budget:
            # The original harness uses Budget as the requested timed stop.
            return None
        finally:
            self.max_elapsed = None

    dry.DrySim.__init__ = initialize
    dry.DrySim.run = run
    # No test-created Jinja wrapper or direct sequence execution may silently
    # count as a TypeScript result. Fixture .put/.store/.advance remain reusable.
    dry.DrySim.seq = no_reference_execution
    dry.DrySim.render = render_oracle
    dry.DrySim.run_automation = run_automation
    dry.DrySim.event = event
    dry.DrySim.service = service
    dry.DrySim.bounded_engine = bounded_engine
    return dry


def module_seams(module, module_path):
    """Bind narrow host continuations after the preserved module is loaded."""
    if module_path == 'lighting-algebra/remote/test_remote.py':
        def commands(_test, events):
            sim = module.GestureSim([])
            binding = sim._parity_catalog['remotes']['bedroom']
            sim.areas[binding['device_id']] = sim.area

            def matching(config, event):
                matches = []
                for trigger in config['triggers']:
                    if trigger.get('topic') != event.get('topic'):
                        continue
                    if 'payload' in trigger and trigger['payload'] != event.get('payload'):
                        continue
                    matches.append(trigger)
                assert len(matches) <= 1, 'Historical MQTT event matched multiple literal triggers'
                if not matches:
                    return None
                trigger = copy.deepcopy(event)
                if 'id' in matches[0]:
                    trigger['id'] = matches[0]['id']
                return trigger

            def drain(until=None):
                while True:
                    tasks = sim._parity_extra.get('scheduled', [])
                    ready = [task for task in tasks if until is None or task['due'] <= until]
                    if not ready:
                        return
                    task = min(ready, key=lambda item: item['due'])
                    tasks.remove(task)
                    due = datetime.fromtimestamp(task['due'] / 1000, tz=sim.now.tzinfo)
                    sim.advance(max(0, (due - sim.now).total_seconds()))
                    sim.run(task['script'], **task['args'])

            start = sim.now
            for event in sorted(events, key=lambda item: item['time']):
                event_time = start.timestamp() * 1000 + event['time'] * 1000
                drain(event_time)
                target = datetime.fromtimestamp(event_time / 1000, tz=start.tzinfo)
                sim.advance(max(0, (target - sim.now).total_seconds()))
                center = matching(module.CENTER, event)
                directions = matching(module.DIRECTIONS, event)
                if center:
                    sim.run('automation.remote_center', room='bedroom', device_id=binding['device_id'],
                            source=binding['source'], trigger=center)
                    quiet = [call for call in sim._parity_last_calls
                             if call['service'] == 'script.turn_on'
                             and call.get('target', {}).get('entity_id') == 'script.ls_remote_power_quiet_bedroom']
                    assert len(quiet) == 1, 'Typed center event must launch one quiet continuation'
                    sim.run('ls_remote_power_quiet_bedroom', **quiet[0]['data']['variables'])
                elif directions:
                    sim.run('automation.remote_directions', room='bedroom', device_id=binding['device_id'],
                            source=binding['source'], trigger=directions)
            drain()
            return sim.commands

        module.RemoteTests.commands = commands
        return

    quiet_classes = {
        'lighting-algebra/remote/gesture_test.py': 'Replay',
        'lighting-algebra/remote-regressions/test_first_arrow.py': 'CurrentReplay',
        'lighting-algebra/sara-window/test_sara_window.py': 'WindowReplay',
    }
    if module_path not in quiet_classes:
        return

    def quiet_continuation(self, steps, context):
        matches = [name for name, config in self.config.items()
                   if name.startswith('gesture_power_done_')
                   and config.get('sequence', [])[1:] == steps]
        assert len(matches) == 1 and set(context) == {'token'}, \
            'Unsupported historical quiet continuation'
        current = LEGACY_SCRIPT_ALIASES[matches[0]]
        before = list(self._parity_extra.get('scheduled', []))
        self.run(current, **context)
        tasks = self._parity_extra.get('scheduled', [])
        added = [task for task in tasks if task not in before]
        assert len(added) == 1 and added[0]['script'] == 'ls_remote_gesture', \
            'Typed quiet continuation must schedule one gesture completion'
        task = added[0]
        tasks.remove(task)
        # Replay.drive already advanced through the preserved delay before it
        # delegates the post-delay tail here; execute the typed scheduled task
        # without charging that same wait a second time.
        return self.run(task['script'], **task['args'])

    getattr(module, quiet_classes[module_path]).seq = quiet_continuation


def migration_fixtures(module, rpc):
    """Historical prefix is declared fixture replay; every post-upgrade run is TS."""
    document = json.loads((ROOT / 'tests/parity/migration-fixtures.json').read_text())
    for relative, expected in document['source_sha256'].items():
        actual = hashlib.sha256((ROOT / 'reference/legacy' / relative).read_bytes()).hexdigest()
        assert actual == expected, 'Historical migration fixture source changed: ' + relative
    for directory, key in (('legacy', 'legacy_sha256'), ('live', 'live_sha256')):
        for relative, expected in document[key].items():
            actual = hashlib.sha256((ROOT / 'reference' / directory / relative).read_bytes()).hexdigest()
            assert actual == expected, 'Historical fixture dependency changed: ' + relative
    original_old, original_upgrade = module.ReviewRegressions.old, module.ReviewRegressions.upgrade

    def old(test):
        fixture = copy.deepcopy(document['fixtures'][test._testMethodName])
        sim = original_old(test)
        initial = fixture['initial']
        sim.state, sim.areas, sim.members = initial['state'], initial['areas'], initial['members']
        sim.now, sim.elapsed = datetime.fromisoformat(initial['now']), initial['elapsed']
        sim._parity_migration_steps = deque(fixture['steps'])
        rpc.fixtures.append({'test': test.id(), 'historical_setup_requests': len(fixture['steps'])})
        return sim

    def upgrade(test, sim):
        assert not sim._parity_migration_steps, 'Original historical setup was not fully replayed'
        original_upgrade(test, sim)
        sim._parity_migration_steps = None

    module.ReviewRegressions.old, module.ReviewRegressions.upgrade = old, upgrade


def gestures(module, rpc, compare=False):
    reference_replay = module.replay

    async def replay(config, room, events, initial_cursor=0):
        expected = await reference_replay(config, room, events, initial_cursor) if compare else None
        snapshot = empty_snapshot()
        remote = {'kitchen': '1c125b382f1e1d19eb9e999b6cc07466',
                  'bedroom': '0e973e9202acb5ace9a8e6a8b336891d',
                  'living_room': '0752f2b4e9a0992ac8efc2af1f53c62a'}[room]
        snapshot['areas'][remote] = room
        prefix = 'ls_' + room + '_remote_'
        for entity, value in {'input_number.' + prefix + 'preset': initial_cursor,
                              'input_number.' + prefix + 'chord_step': 0,
                              'input_number.' + prefix + 'power_count': 0,
                              'input_text.' + prefix + 'power_token': '',
                              'timer.' + prefix + 'chord': 'idle'}.items():
            snapshot['state'][entity] = {'state': str(value), 'attributes': {}}
        output, timers = [], []
        for event in events:
            args = copy.deepcopy(event)
            if args['command'] == 'power_done':
                assert timers, 'Power completion without an emitted quiet timer'
                args['token'] = timers[-1]
            response = rpc.call('ls_remote_gesture_' + room, args, snapshot)
            snapshot = response['snapshot']
            for call in response['calls']:
                if call['service'] != 'script.turn_on':
                    continue
                entity = call.get('target', {}).get('entity_id', call['data'].get('entity_id', ''))
                variables = call['data'].get('variables', {})
                if entity == 'script.ls_remote_command':
                    output.append(variables['command'])
                elif entity.startswith('script.ls_remote_power_quiet_'):
                    timers.append(variables['token'])
        actual = output, float(snapshot['state']['input_number.' + prefix + 'preset']['state'])
        if compare:
            assert actual == expected, ('Native HA gesture differential', actual, expected)
            rpc.comparisons += 1
        return actual
    module.replay = replay
