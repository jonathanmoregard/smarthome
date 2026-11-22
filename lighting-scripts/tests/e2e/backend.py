"""Run one scenario on one backend: `python3 -m tests.e2e.backend <reference|port> <result file>`.

Reads the encoded `{start, steps}` from stdin, runs the steps on a fresh
simulator and writes exactly one encoded outcome to the result file:
`{'checkpoints': [...]}`, or `{'error': {'kind', 'message'}}` (plus
`last_inputs` for a settle loop). Stdout stays free for logs.

Each step is applied, routed to the automations Home Assistant would run, run,
and then settled: the calls the backend recorded move the `World`, queued
renders and due continuations run, the world's light and switch states are
written back into the simulator, and every state that changed is routed again,
until nothing moves. A checkpoint is taken after each step, and at each clock
tick while a bulb is mid-transition.
"""
from __future__ import annotations
from collections import deque
from collections.abc import Mapping, Sequence
import copy
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import sys
import traceback

from tests.e2e.codec import Advance, Checkpoint, PersonLightChange, PressSwitch, Step, decode, encode
from tests.e2e.router import (LOCAL, AutomationRun, Context, Event, HaStart, House, Input, Mqtt, Run, ScriptCall,
                              StateChanged, Tick, load_automations, route)
from tests.e2e.runner import LAST_INPUTS, SETTLE_LIMIT, BackendError, SettleLoop
from tests.e2e.world import On, World

TICK_SECONDS = 60
PLUG = 'switch.e2e_plug_{}'
PLUG_LABEL = 'on_off'
SCHEDULE_LABEL = 'house_schedule'
RUNTIME = 'sensor.ls_effects_runtime'
OVERRIDES = 'sensor.ls_overrides'
DASHBOARD_ATTRIBUTES = ('switch_ranges', 'range_defaults')
CANDLE = 'Candle'
PERSON = 'e2e-person'   # the user id a person's own change carries
INPUTS = (HaStart, Tick, StateChanged, Event, Mqtt, ScriptCall)
STEPS = (*INPUTS, Advance, PressSwitch, PersonLightChange)
# `adapters.simulator` refuses these before any RPC: the harness routed something the
# adapter cannot map, a setup fault rather than port behaviour (ruling 25).
ROUTING_ERRORS = ('Unsupported historical automation', 'Historical center automation')
NOT_PORTED = 'TypeScript automation.{0}: Unsupported script: automation.{0}'   # tests/parity/rpc.py:108


class Session:
    """One backend's simulator, its world and the scenario clock."""

    def __init__(self, sim, backend: str, automations: Mapping[str, dict], plugs: Sequence[str], world: World,
                 start: datetime):
        self.sim, self.backend, self.automations, self.plugs, self.world = sim, backend, automations, list(plugs), world
        self.start = start.astimezone(timezone.utc)
        self.t = 0.0                      # nominal seconds since start; never the drifting sim clock
        self.previous_tick = self.start
        self.recent: deque[Input] = deque(maxlen=LAST_INPUTS)
        self.not_ported: list[str] = []
        self.contexts = 0
        self.seen_calls = len(sim.calls)
        self._set_clock(self.start)
        self._write_back()                # silent: the world's first light is not a change anybody made
        self.known = {entity: self._known(value, None) for entity, value in sim.state.items()}

    @staticmethod
    def open(sim, backend: str, start: datetime) -> 'Session':
        """Seed the synthetic plugs, then build the house's automations and world from the simulator."""
        plugs = seed_plugs(sim, backend)
        return Session(sim, backend, load_automations(sim), plugs, World.from_sim(sim), start)

    def run(self, steps: Sequence[Step]) -> list[Checkpoint]:
        checkpoints: list[Checkpoint] = []
        for index, step in enumerate(steps):
            self.not_ported = []
            sampled = self._advance(index, step.seconds) if isinstance(step, Advance) else self._step(step)
            final = self._checkpoint(index)
            if sampled and sampled[-1].t == final.t:
                sampled.pop()
            checkpoints.extend([*sampled, final])
        return checkpoints

    # --- steps ---------------------------------------------------------------

    def _step(self, step: Step) -> list[Checkpoint]:
        if isinstance(step, StateChanged):
            # Routed as HA hands it over: the state as written, carrying the step's context, and
            # the simulator's previous state unless the step names its own.
            previous = self._as_input(step.entity)
            self._write(step.entity, step.new, step.context)
            self._dispatch(StateChanged(step.entity, previous if step.old is None else step.old,
                                        self._as_input(step.entity), step.context))
        elif isinstance(step, PressSwitch):
            old = self._as_input(step.entity)
            self.world.press_switch_button(step.entity)
            context = self._context(None)
            attributes = self.sim.state.get(step.entity, {}).get('attributes', {})
            self._write(step.entity, {'state': self.world.switch(step.entity), 'attributes': attributes}, context)
            self._dispatch(StateChanged(step.entity, old, self._as_input(step.entity), context))
        elif isinstance(step, PersonLightChange):
            event = Event('call_service', {'domain': 'light', 'service': 'turn_on', 'service_data': {
                'entity_id': list(step.entities), **step.service_data}}, self._context(PERSON))
            self.world.apply({'time': self.sim.elapsed, 'action': 'light.turn_on',
                              'target': {'entity_id': list(step.entities)}, 'data': dict(step.service_data)},
                             self.sim.elapsed)
            self._dispatch(event)
        else:
            self._dispatch(step)
        self._settle()
        return []

    def _advance(self, index: int, seconds: float) -> list[Checkpoint]:
        """60 s ticks at absolute instants `start + n·60 s`, each routed and settled."""
        target = self.t + seconds
        sampled = []
        tick = math.floor(self.t / TICK_SECONDS) + 1
        while tick * TICK_SECONDS <= target:
            instant = self._instant(tick * TICK_SECONDS)
            self._continue_until(instant)
            self.t = float(tick * TICK_SECONDS)
            self._set_clock(instant)
            self._dispatch(Tick(instant))
            self.previous_tick = instant
            self._settle()
            if self.world.fading(self.sim.elapsed):
                sampled.append(self._checkpoint(index))
            tick += 1
        end = self._instant(target)
        self._continue_until(end)
        self.t = target
        self._set_clock(end)
        return sampled

    # --- routing and runs ----------------------------------------------------

    def _dispatch(self, inp: Input) -> None:
        self.recent.append(inp)
        house = House(self.automations, self.sim.state,
                      {SCHEDULE_LABEL: list(self.sim.members), PLUG_LABEL: list(self.plugs)}, self.sim.e2e_render)
        runs = route(house, inp, self.previous_tick)
        if isinstance(inp, Tick):
            runs = self._once_per_tick(runs)
        for run in runs:
            self._run(run)

    def _once_per_tick(self, runs: list[Run]) -> list[Run]:
        """Sub-minute `time_pattern`s fire once per tick, at the tick's last matching instant (ruling 17)."""
        last = {}
        for position, run in enumerate(runs):
            if isinstance(run, AutomationRun) and self._sub_minute(run):
                last[run.name] = position
        return [run for position, run in enumerate(runs)
                if not (isinstance(run, AutomationRun) and self._sub_minute(run)) or last[run.name] == position]

    def _sub_minute(self, run: AutomationRun) -> bool:
        config = self.automations[run.name]
        trigger = config.get('triggers', config.get('trigger', []))[int(run.trigger['idx'])]
        return run.trigger['platform'] == 'time_pattern' and 'seconds' in trigger

    def _run(self, run: Run) -> None:
        try:
            if isinstance(run, AutomationRun):
                self.sim.run_automation(run.name, run.trigger)
            else:
                self.sim.run(run.name, **run.data)
        except Exception as error:
            message = str(error)
            if isinstance(run, AutomationRun) and self.backend == 'port' \
                    and message == NOT_PORTED.format(run.name.removeprefix('automation_')):
                self.not_ported.append(run.name)
                return
            kind = 'AdapterRouting' if message.startswith(ROUTING_ERRORS) else 'RunFailed'
            raise BackendError(self.backend, kind, f'{run.name}: {type(error).__name__}: {message}') from error

    # --- settling ------------------------------------------------------------

    def _settle(self) -> None:
        for _ in range(SETTLE_LIMIT + 1):
            moved = self._apply_calls()
            if self.sim.output_jobs:
                self.sim.drain_output()
                moved = True
            moved = self._continue_until(self.sim.now, settle=False) or moved
            self._write_back()
            changes = self._changes()
            for change in changes:
                self._dispatch(change)
            if not (moved or changes):
                return
        raise SettleLoop(list(self.recent))

    def _apply_calls(self) -> bool:
        calls = self.sim.calls[self.seen_calls:]
        self.seen_calls = len(self.sim.calls)
        for call in calls:
            self.world.apply(call, call['time'])
        return bool(calls)

    def _continue_until(self, instant: datetime, settle: bool = True) -> bool:
        """Run the port's queued continuations due by `instant`, in time order, each at its own instant.

        The reference has none to run: it runs every `delay` inline, moving its own clock.
        """
        if self.backend != 'port':
            return False
        ran = False
        while True:
            tasks = self.sim._parity_extra.get('scheduled', [])
            due = [task for task in tasks if task['due'] <= instant.timestamp() * 1000]
            if not due:
                return ran
            task = min(due, key=lambda item: item['due'])
            tasks.remove(task)
            at = datetime.fromtimestamp(task['due'] / 1000, timezone.utc)
            if at > self.sim.now:   # an overdue task runs now; the clock never steps back for it
                self._set_clock(at)
            self._run_continuation(task)
            ran = True
            if settle:
                self._settle()

    def _run_continuation(self, task: dict) -> None:
        try:
            self.sim.run(task['script'], **task['args'])
        except Exception as error:
            raise BackendError(self.backend, 'RunFailed',
                               f"continuation {task['script']}: {type(error).__name__}: {error}") from error

    def _write_back(self) -> None:
        """The world's end states into the simulator: attributes merged, so a group keeps its `entity_id` list."""
        for entity, wanted in self.world.ha_states(math.inf).items():
            current = self.sim.state.get(entity)
            attributes = {**(current or {}).get('attributes', {}), **wanted['attributes']}
            if current is None or current.get('state') != wanted['state'] or current.get('attributes') != attributes:
                self.sim.put(entity, wanted['state'], attributes)

    def _changes(self) -> list[StateChanged]:
        """Every entity whose state or attributes moved since the last round; `last_updated` alone is no change."""
        changes = []
        for entity, value in list(self.sim.state.items()):
            known = self.known.get(entity)
            if known is not None and known['state'] == value.get('state') \
                    and known['attributes'] == value.get('attributes'):
                continue
            context = self._context(None)
            self.known[entity] = self._known(value, context)
            changes.append(StateChanged(entity, None if known is None else copy.deepcopy(known),
                                        copy.deepcopy(self.known[entity]), context))
        return changes

    def _write(self, entity: str, new: Mapping, context: Context) -> None:
        self.sim.put(entity, new['state'], copy.deepcopy(new.get('attributes', {})))
        self.known[entity] = self._known(self.sim.state[entity], context)

    def _as_input(self, entity: str) -> dict | None:
        known = self.known.get(entity)
        return None if known is None else copy.deepcopy(known)

    @staticmethod
    def _known(value: Mapping, context: Context | None) -> dict:
        """A state as a trigger carries it: the entity's state object with the context that last changed it."""
        return {**copy.deepcopy(dict(value)), 'context': {
            'id': None if context is None else context.id,
            'user_id': None if context is None else context.user_id,
            'parent_id': None if context is None else context.parent_id}}

    def _context(self, user_id: str | None) -> Context:
        self.contexts += 1
        return Context(id=f'e2e-{self.contexts}', user_id=user_id)

    # --- clock and checkpoints -------------------------------------------------

    def _instant(self, seconds: float) -> datetime:
        return self.start + timedelta(seconds=seconds)

    def _set_clock(self, instant: datetime) -> None:
        self.sim.now = instant.astimezone(LOCAL)
        self.sim.elapsed = (instant - self.start).total_seconds()

    def _checkpoint(self, index: int) -> Checkpoint:
        now = self.sim.elapsed   # the world's time: calls are stamped with the sim's elapsed seconds
        bulbs = {name: self.world.bulb(name, now) for name in self.world.bulb_names()}
        for lamp in self._candle_lamps():
            for name in self.world.bulbs_of(lamp):
                state = bulbs[name]
                if isinstance(state, On):
                    bulbs[name] = On(state.level, state.colour, 'candle')
        attributes = self.sim.state.get(OVERRIDES, {}).get('attributes', {})
        return Checkpoint(
            step=index, t=self.t, bulbs=bulbs,
            switches={entity: self.world.switch(entity) for entity in self.world.switch_names()},
            dashboard={key: copy.deepcopy(attributes[key]) for key in DASHBOARD_ATTRIBUTES if key in attributes},
            in_fade=self.world.fading(now), not_ported=tuple(self.not_ported))

    def _candle_lamps(self) -> list[str]:
        """Lamps whose runtime assignment holds a Candle effect record: the software candle the world cannot see."""
        assignments = self.sim.state.get(RUNTIME, {}).get('attributes', {}).get('assignments')
        if not isinstance(assignments, Mapping):
            return []
        return [lamp for lamp, record in assignments.items() if isinstance(record, Mapping) and any(
            isinstance(channel, Mapping) and channel.get('kind') == 'effect' and channel.get('effect') == CANDLE
            for channel in record.values())]


def seed_plugs(sim, backend: str) -> list[str]:
    """One synthetic plug per room, off, in that room, labelled `on_off`, identically on both backends."""
    rooms = sorted(set(sim.areas.values()))
    plugs = [PLUG.format(n) for n in range(len(rooms))]
    for plug, room in zip(plugs, rooms):
        sim.put(plug, 'off', {})
        sim.areas[plug] = room
    if backend == 'reference':
        stub = sim.env.globals['label_entities']
        sim.env.globals['label_entities'] = lambda label: list(plugs) if label == PLUG_LABEL else stub(label)
    else:
        sim._parity_extra['labels'][PLUG_LABEL] = list(plugs)
    return plugs


def parse_request(backend: str, payload: object) -> tuple[datetime, list[Step]]:
    request = decode(payload)
    if not isinstance(request, dict) or set(request) != {'start', 'steps'}:
        raise BackendError(backend, 'MalformedRequest', f'expected {{start, steps}}, got {request!r}')
    start, steps = request['start'], request['steps']
    if not isinstance(start, datetime) or not isinstance(steps, list):
        raise BackendError(backend, 'MalformedRequest', f'start {start!r}, steps {type(steps).__name__}')
    for index, step in enumerate(steps):
        if not isinstance(step, STEPS):
            raise BackendError(backend, 'UnknownStep', f'step {index}: {step!r}')
    return start, steps


def execute(backend: str, text: str) -> dict:
    """The outcome of one scenario, every failure included; never raises."""
    try:
        start, steps = parse_request(backend, json.loads(text))
        from tests.e2e.env import open_sim
        with open_sim(backend) as sim:
            return {'checkpoints': Session.open(sim, backend, start).run(steps)}
    except Exception as error:
        return failure(error)


def failure(error: Exception) -> dict:
    if isinstance(error, SettleLoop):
        return {'error': {'kind': 'SettleLoop', 'message': str(error), 'last_inputs': error.last_inputs}}
    if isinstance(error, BackendError):
        return {'error': {'kind': error.kind, 'message': error.message}}
    return {'error': {'kind': type(error).__name__, 'message': ''.join(traceback.format_exception(error))}}


def main(argv: Sequence[str]) -> int:
    backend, result = argv
    outcome = execute(backend, sys.stdin.read())
    try:
        text = json.dumps(encode(outcome))
    except (TypeError, ValueError) as error:   # an outcome the codec cannot carry is itself a failure
        text = json.dumps(encode(failure(error)))
    Path(result).write_text(text)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
