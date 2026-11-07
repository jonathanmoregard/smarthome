"""Offline actual-script runner with explicitly deferred render scheduling.

This is a deterministic interleaving harness, not a real HA asyncio scheduler.
Only script.turn_on(ls_render) is queued here; effect-engine starts are captured
by the existing simulator and never run implicitly. Tests inject competing
commits at actual service boundaries. No service can reach a real device.
"""
import copy
import os
from collections import deque
from dry_harness import DrySim, ROOT

RUNTIME = 'sensor.ls_effects_runtime'


class PerformanceSim(DrySim):
    def __init__(self):
        self.render_jobs = deque()
        self.script_runs = []
        self.blocking_steps = []
        self.before_service = None
        self.after_service = None
        super().__init__(candidate=os.environ.get('LIGHTING_CANDIDATE', ROOT / 'performance/candidate'))
        self.put(RUNTIME, '0', {'assignments': {}, 'targets': {}, 'applied': {},
                              'handled_rooms': {}, 'revision': self.now.isoformat()})
        for room in set(self.areas.values()):
            self.put('sensor.ls_cache_' + room, '0', {'cache': {}})

    def run(self, name, **context):
        self.script_runs.append(name)
        return super().run(name, **context)

    def seq(self, steps, context):
        for step in steps:
            if any(key in step for key in ('delay', 'wait_template', 'wait_for_trigger')):
                self.blocking_steps.append(copy.deepcopy(step))
            super().seq([step], context)

    def service(self, action, target, data):
        if self.before_service:
            self.before_service(action, target, data)
        if action == 'script.turn_on' and target.get('entity_id') == 'script.ls_render':
            self.calls.append({'time': self.elapsed, 'action': action,
                               'target': copy.deepcopy(target), 'data': copy.deepcopy(data)})
            self.render_jobs.append(copy.deepcopy(data.get('variables', {})))
            result = None
        else:
            result = super().service(action, target, data)
        if self.after_service:
            self.after_service(action, target, data)
        return result

    def drain_one(self):
        return self.run('ls_render', **self.render_jobs.popleft())

    def drain(self, limit=100):
        count = 0
        while self.render_jobs:
            assert count < limit, 'render scheduling loop'
            self.drain_one()
            count += 1
        return count

    def seed(self):
        self.run('ls_apply', reason='config')
        self.drain()
        self.calls.clear()
        self.script_runs.clear()

    def remote(self, room='living_room', command='up', source=None):
        self.advance(.01)
        return self.run('ls_remote_command', source=source or 'offline-' + room,
                        area=room, command=command)

    def sends(self):
        return [call for call in self.calls if call['action'] == 'mqtt.publish'
                and call['data']['topic'].startswith('zigbee2mqtt/')]

    def framed_lamps(self):
        return set().union(*(set(call['data']['targets']) for call in self.calls
                             if call['action'] == 'script.effects_frame_plan'))

    def pending_rooms(self):
        handled = self.attr(RUNTIME, 'handled_rooms') or {}
        return {room for room, version in (self.attr('sensor.ls_overrides', 'pending_rooms') or {}).items()
                if version != handled.get(room)}
