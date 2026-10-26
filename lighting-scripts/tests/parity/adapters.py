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
from pathlib import Path
import textwrap
from rpc import empty_snapshot, ROOT


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


def pure_templates(module, rpc, compare=False):
    if hasattr(module, 'TEMPLATES'):
        module.TEMPLATES = {name: RpcTemplate(rpc, name, template if compare else None) for name, template in module.TEMPLATES.items()}
    elif hasattr(module, 'TEMPLATE'):
        module.TEMPLATE = RpcTemplate(rpc, 'effects_group_plan', module.TEMPLATE if compare else None)
    else:
        raise AssertionError('No supported pure-template seam')


def simulator(stage, rpc):
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
    automation_names = {}
    for path in (ROOT / 'reference/live/automations').glob('*.json'):
        document = json.loads(path.read_text())
        config = document.get('config', document)
        for key in (path.stem, str(config.get('id', path.stem))):
            automation_names['automation_' + key] = path.stem

    def initialize(self, *args, **kwargs):
        self._parity_initializing = True
        self._parity_catalog = copy.deepcopy(catalog)
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
        observed_calls, observed_events, observed_scripts = 0, 0, 1

        def observe(response):
            nonlocal observed_calls, observed_events, observed_scripts
            for call in response.get('calls', [])[observed_calls:]:
                adapted = {'time': call.get('time', self.elapsed), 'action': call['service'],
                           'data': call['data'], 'target': call.get('target', {})}
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
            if phase == 'before' and 'service' in self.__dict__:
                wrapper = self.__dict__['service']
                if getattr(self, '_parity_validated_service', None) is not wrapper:
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
                    wrapper(action, target, data)
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

        mode = 'all' if 'service' in self.__dict__ or any(getattr(self, key, None) for key in ('before_service', 'after_service', 'on_publish', 'before_emit', 'after_publish')) else 'commit'
        response = rpc.call(name, args, snapshot(self), callback=callback, callback_mode=mode,
                            instrument_log=self.env.filters['log'] is not math.log)
        restore(self, response['snapshot'])
        observe(response)
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
