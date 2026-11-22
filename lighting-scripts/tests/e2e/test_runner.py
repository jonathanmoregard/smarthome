"""Backends settle each step and report checkpoints.

The unguarded cases drive `Session` in this process with a stand-in simulator
(synthetic names only). The guarded cases run the real backends, each in its
own process, through `run_backend`/`run_both`; they read every catalog name at
run time and never write one into this file.
"""
from __future__ import annotations
from collections import deque
from datetime import datetime, timedelta
import json
from pathlib import Path
import unittest
from zoneinfo import ZoneInfo

from tests.e2e import env
from tests.e2e.backend import SOFTWARE_CANDLE, Session, enabled_automations, failure, parse_request
from tests.e2e.codec import Advance, PersonLightChange, PressSwitch, decode, encode
from tests.e2e.compare import compare
from tests.e2e.router import Context, HaStart, StateChanged
from tests.e2e.runner import SETTLE_LIMIT, BackendError, BackendRun, SettleLoop, run_backend, run_both, run_of
from tests.e2e.world import BulbInfo, Kelvin, Off, On, World

STOCKHOLM = ZoneInfo('Europe/Stockholm')
START = datetime(2026, 10, 23, 12, 0, tzinfo=STOCKHOLM)
RUNTIME_DIR = Path(__file__).resolve().parents[2] / '.runtime' / 'e2e'
NOT_PORTED = 'TypeScript automation.{0}: Unsupported script: automation.{0}'


def publish(sim, topic, payload):
    sim.calls.append({'time': sim.elapsed, 'action': 'mqtt.publish', 'target': {},
                      'data': {'topic': f'zigbee2mqtt/{topic}/set', 'payload': json.dumps(payload)}})


class StandIn:
    """Just enough of `DrySim` for `Session`: state, recorded calls, render jobs and a clock.

    `actions` maps an automation or script name to a function of (sim, trigger or data).
    """

    def __init__(self, actions=None, state=None, scheduled=None):
        self.actions = actions or {}
        self.state = {entity: {'entity_id': entity, **value} for entity, value in (state or {}).items()}
        self.calls, self.output_jobs, self.members, self.areas = [], deque(), [], {}
        self.now, self.elapsed = START, 0.0
        self.log = []
        if scheduled is not None:
            self._parity_extra = {'scheduled': scheduled, 'labels': {}}

    def put(self, entity, state, attributes=None):
        self.state[entity] = {'entity_id': entity, 'state': str(state), 'attributes': dict(attributes or {}),
                              'last_updated': self.now.isoformat()}

    def run_automation(self, name, trigger):
        self.log.append((name, self.now, trigger))
        return self.actions[name](self, trigger)

    def run(self, name, **data):
        self.log.append((name, self.now, data))
        return self.actions[name](self, data)

    def drain_output(self):
        jobs = len(self.output_jobs)
        self.output_jobs.clear()
        return jobs

    def e2e_render(self, template, variables):
        raise AssertionError('no template rendering in these cases')


def world(*bulbs, switches=()):
    return World(bulbs={name: BulbInfo(topic=name, candle_capable=False) for name in bulbs}, groups={},
                 switches=list(switches), ha_lights={f'light.lamp_{name}': [name] for name in bulbs})


def session(sim, automations, the_world, backend='reference'):
    return Session(sim, backend, automations, plugs=[], world=the_world, start=START)


def on_start(name='automation_a'):
    return {name: {'triggers': [{'trigger': 'homeassistant', 'event': 'start'}], 'actions': []}}


class Settle(unittest.TestCase):
    def test_settle_loop_raises_with_inputs(self):
        def republish(sim, trigger):
            publish(sim, 'bulb_a', {'brightness': 1 + len(sim.log) % 200})

        automations = {'automation_echo': {'triggers': [
            {'trigger': 'homeassistant', 'event': 'start'},
            {'trigger': 'state', 'entity_id': 'light.lamp_bulb_a'}], 'actions': []}}
        sim = StandIn({'automation_echo': republish})
        with self.assertRaises(SettleLoop) as raised:
            session(sim, automations, world('bulb_a')).run([HaStart()])
        inputs = raised.exception.last_inputs
        self.assertEqual(len(inputs), 10)
        self.assertTrue(all(isinstance(inp, StateChanged) and inp.entity == 'light.lamp_bulb_a' for inp in inputs))
        self.assertLessEqual(len(sim.log), SETTLE_LIMIT + 2)

    def test_world_changes_are_written_back_and_routed_until_quiet(self):
        seen = []

        def turn_on(sim, trigger):
            publish(sim, 'bulb_a', {'state': 'ON', 'brightness': 40})

        def follow(sim, trigger):
            seen.append(trigger['to_state']['attributes']['brightness'])

        automations = {**on_start('automation_a'), 'automation_follow': {'triggers': [
            {'trigger': 'state', 'entity_id': 'light.lamp_bulb_a'}], 'actions': []}}
        sim = StandIn({'automation_a': turn_on, 'automation_follow': follow})
        [checkpoint] = session(sim, automations, world('bulb_a')).run([HaStart()])
        self.assertEqual(seen, [40])
        self.assertEqual(sim.state['light.lamp_bulb_a']['attributes']['brightness'], 40)
        self.assertEqual(checkpoint.bulbs['bulb_a'], On(40, None, 'none'))

    def test_the_initial_write_back_is_silent(self):
        automations = {'automation_follow': {'triggers': [
            {'trigger': 'state', 'entity_id': 'light.lamp_bulb_a'}], 'actions': []}}
        sim = StandIn({'automation_follow': lambda sim, trigger: None},
                      state={'light.lamp_bulb_a': {'state': 'off', 'attributes': {'entity_id': ['x']}}})
        session(sim, automations, world('bulb_a')).run([HaStart()])
        self.assertEqual(sim.log, [])
        self.assertEqual(sim.state['light.lamp_bulb_a']['state'], 'on')
        self.assertEqual(sim.state['light.lamp_bulb_a']['attributes']['entity_id'], ['x'])

    def test_last_updated_alone_is_not_a_change(self):
        automations = {'automation_follow': {'triggers': [
            {'trigger': 'state', 'entity_id': 'sensor.x'}], 'actions': []}}
        sim = StandIn({'automation_follow': lambda sim, trigger: None, 'automation_a': lambda sim, trigger:
                       sim.put('sensor.x', sim.state['sensor.x']['state'], sim.state['sensor.x']['attributes'])},
                      state={'sensor.x': {'state': '1', 'attributes': {}}})
        session(sim, {**on_start(), **automations}, world()).run([HaStart()])
        self.assertEqual([name for name, *_ in sim.log], ['automation_a'])

    def test_state_changed_step_is_written_then_routed_once(self):
        automations = {'automation_follow': {'triggers': [
            {'trigger': 'state', 'entity_id': 'input_text.x'}], 'actions': []}}
        sim = StandIn({'automation_follow': lambda sim, trigger: None},
                      state={'input_text.x': {'state': 'u', 'attributes': {}}})
        new = {'entity_id': 'input_text.x', 'state': 'v', 'attributes': {}}
        session(sim, automations, world()).run([StateChanged('input_text.x', None, new, Context('c', 'u'))])
        self.assertEqual(sim.state['input_text.x']['state'], 'v')
        [(name, _, trigger)] = sim.log
        self.assertEqual(name, 'automation_follow')
        # As HA hands them over: the state before the step, and the new one with the step's context.
        self.assertEqual((trigger['from_state']['state'], trigger['to_state']['state']), ('u', 'v'))
        self.assertEqual(trigger['to_state']['context']['user_id'], 'u')


class Errors(unittest.TestCase):
    def test_a_bare_tick_is_not_a_step(self):
        from tests.e2e.router import Tick
        with self.assertRaises(BackendError) as raised:
            parse_request('port', encode({'start': START, 'steps': [Tick(START)]}))
        self.assertEqual(raised.exception.kind, 'UnknownStep')

    def test_backend_error_is_structured(self):
        with self.assertRaises(BackendError) as raised:
            run_backend('reference', [{'kind': 'Teleport'}], START)
        self.assertEqual((raised.exception.backend, raised.exception.kind), ('reference', 'UnknownStep'))
        self.assertIn('Teleport', raised.exception.message)

    def test_settle_loop_crosses_the_process_boundary(self):
        inputs = [StateChanged('light.lamp_a', None, {'state': 'on', 'attributes': {}}, Context('c', None))]
        outcome = decode(json.loads(json.dumps(encode(failure(SettleLoop(inputs))))))
        with self.assertRaises(SettleLoop) as raised:
            run_of('port', outcome)
        self.assertEqual(raised.exception.last_inputs, inputs)

    def test_port_without_a_handler_is_not_ported(self):
        def missing(sim, trigger):
            raise AssertionError(NOT_PORTED.format('a'))

        sim = StandIn({'automation_a': missing}, scheduled=[])
        [checkpoint] = session(sim, on_start(), world(), backend='port').run([HaStart()])
        self.assertEqual(checkpoint.not_ported, ('automation_a',))

    def test_other_run_errors_are_backend_errors(self):
        cases = [('port', NOT_PORTED.format('b'), 'RunFailed'),
                 ('reference', NOT_PORTED.format('a'), 'RunFailed'),
                 ('port', 'TypeScript automation.a: room must be a string, got undefined', 'RunFailed'),
                 ('port', 'Unsupported historical automation: automation_a', 'AdapterRouting'),
                 ('port', 'Historical center automation resolved no fixture room', 'AdapterRouting')]
        for backend, message, kind in cases:
            with self.subTest(message=message):
                def fail(sim, trigger, message=message):
                    raise AssertionError(message)

                sim = StandIn({'automation_a': fail}, scheduled=[] if backend == 'port' else None)
                with self.assertRaises(BackendError) as raised:
                    session(sim, on_start(), world(), backend=backend).run([HaStart()])
                self.assertEqual((raised.exception.backend, raised.exception.kind), (backend, kind))


class Time(unittest.TestCase):
    def test_queued_continuation_runs_at_its_instant(self):
        due = START + timedelta(seconds=30)

        def queue(sim, trigger):
            sim._parity_extra['scheduled'].append(
                {'script': 'ls_later', 'args': {'k': 1}, 'due': due.timestamp() * 1000})

        def later(sim, data):
            publish(sim, 'bulb_a', {'state': 'OFF'})

        sim = StandIn({'automation_a': queue, 'ls_later': later}, scheduled=[])
        checkpoints = session(sim, on_start(), world('bulb_a'), backend='port').run([HaStart(), Advance(60)])
        self.assertEqual([(c.step, c.t) for c in checkpoints], [(0, 0.0), (1, 60.0)])
        # Drained before the step's checkpoint, as the reference's inline wait would have run it.
        self.assertEqual(checkpoints[0].bulbs['bulb_a'], Off())
        [(name, now, data)] = [entry for entry in sim.log if entry[0] == 'ls_later']
        self.assertEqual((now, data), (due, {'k': 1}))
        self.assertEqual(sim._parity_extra['scheduled'], [])

    def test_queued_continuations_drain_in_time_order_each_at_its_instant(self):
        def queue(sim, trigger):
            sim._parity_extra['scheduled'].append({'script': 'ls_second', 'args': {}, 'due': at(50)})
            sim._parity_extra['scheduled'].append({'script': 'ls_first', 'args': {}, 'due': at(30)})

        def first(sim, data):   # a continuation that queues another one
            sim._parity_extra['scheduled'].append({'script': 'ls_third', 'args': {}, 'due': at(40)})

        def at(seconds):
            return (START + timedelta(seconds=seconds)).timestamp() * 1000

        sim = StandIn({'automation_a': queue, 'ls_first': first, 'ls_second': lambda sim, data: None,
                       'ls_third': lambda sim, data: None}, scheduled=[])
        session(sim, on_start(), world(), backend='port').run([HaStart()])
        self.assertEqual([(name, (now - START).total_seconds()) for name, now, _ in sim.log[1:]],
                         [('ls_first', 30), ('ls_third', 40), ('ls_second', 50)])

    def test_a_ticks_continuations_drain_before_its_checkpoint(self):
        automations = {'automation_tick': {'triggers': [{'trigger': 'time_pattern', 'minutes': '/1'}], 'actions': []}}

        def queue(sim, trigger):
            sim._parity_extra['scheduled'].append(
                {'script': 'ls_later', 'args': {}, 'due': (sim.now + timedelta(seconds=5)).timestamp() * 1000})

        sim = StandIn({'automation_tick': queue, 'ls_later': lambda sim, data: publish(sim, 'bulb_a', {'state': 'OFF'})},
                      scheduled=[])
        [checkpoint] = session(sim, automations, world('bulb_a'), backend='port').run([Advance(60)])
        self.assertEqual(checkpoint.bulbs['bulb_a'], Off())
        self.assertEqual([(name, (now - START).total_seconds()) for name, now, _ in sim.log],
                         [('automation_tick', 60), ('ls_later', 65)])

    def test_a_wait_past_the_next_tick_is_refused(self):
        def wait(sim, trigger):
            sim.now += timedelta(seconds=90)   # an inline reference delay longer than a tick
            sim.elapsed += 90

        sim = StandIn({'automation_a': wait})
        with self.assertRaises(BackendError) as raised:
            session(sim, on_start(), world()).run([HaStart(), Advance(60)])
        self.assertEqual(raised.exception.kind, 'ClockBackwards')

    def test_ticks_land_on_absolute_instants_despite_a_drifting_clock(self):
        automations = {'automation_tick': {'triggers': [{'trigger': 'time_pattern', 'minutes': '/1'}], 'actions': []}}

        def drift(sim, trigger):
            sim.now += timedelta(seconds=7)   # as an inline reference delay does
            sim.elapsed += 7

        sim = StandIn({'automation_tick': drift})
        session(sim, automations, world()).run([Advance(180)])
        self.assertEqual([now for _, now, _ in sim.log],
                         [START + timedelta(seconds=60 * n) for n in (1, 2, 3)])

    def test_sub_minute_patterns_fire_once_per_tick_at_the_last_instant(self):
        automations = {'automation_fast': {'triggers': [{'trigger': 'time_pattern', 'seconds': '/5'}], 'actions': []}}
        sim = StandIn({'automation_fast': lambda sim, trigger: None})
        session(sim, automations, world()).run([Advance(120)])
        self.assertEqual([trigger['now'] for _, _, trigger in sim.log],
                         [(START + timedelta(seconds=s)).isoformat() for s in (60, 120)])

    def test_two_sub_minute_triggers_of_one_automation_each_fire_once_per_tick(self):
        automations = {'automation_fast': {'triggers': [{'trigger': 'time_pattern', 'seconds': '/15', 'id': 'quarter'},
                                                        {'trigger': 'time_pattern', 'seconds': '/5', 'id': 'five'}],
                                           'actions': []}}
        sim = StandIn({'automation_fast': lambda sim, trigger: None})
        session(sim, automations, world()).run([Advance(60)])
        self.assertEqual([(trigger['id'], trigger['now']) for _, _, trigger in sim.log],
                         [('five', (START + timedelta(seconds=55)).isoformat()),
                          ('quarter', (START + timedelta(seconds=60)).isoformat())])

    def test_fade_sampled_at_each_tick_while_a_line_runs(self):
        automations = {**on_start(), 'automation_tick': {'triggers': [
            {'trigger': 'time_pattern', 'minutes': '/1'}], 'actions': []}}
        levels = iter([200, 150, 100])

        def fade(sim, trigger):
            level = next(levels, None)
            if level is not None:
                publish(sim, 'bulb_a', {'brightness': level, 'transition': 60})

        sim = StandIn({'automation_a': lambda sim, trigger: None, 'automation_tick': fade})
        checkpoints = session(sim, automations, world('bulb_a')).run([HaStart(), Advance(300)])
        advance = [c for c in checkpoints if c.step == 1]
        self.assertEqual([c.t for c in advance], [60.0, 120.0, 180.0, 300.0])
        self.assertEqual([bool(c.in_fade) for c in advance], [True, True, True, False])
        self.assertEqual(advance[-1].bulbs['bulb_a'].level, 100)


class Steps(unittest.TestCase):
    def test_press_switch_flips_the_plug_and_routes_its_change(self):
        automations = {'automation_plug': {'triggers': [
            {'trigger': 'state', 'entity_id': 'switch.plug_x', 'to': 'on'}], 'actions': []}}
        sim = StandIn({'automation_plug': lambda sim, trigger: None},
                      state={'switch.plug_x': {'state': 'off', 'attributes': {}}})
        [checkpoint] = session(sim, automations, world(switches=['switch.plug_x'])).run([PressSwitch('switch.plug_x')])
        self.assertEqual(checkpoint.switches, {'switch.plug_x': 'on'})
        [(_, _, trigger)] = sim.log
        self.assertEqual(trigger['to_state']['state'], 'on')
        self.assertIsNone(trigger['to_state']['context']['user_id'])

    def test_person_light_change_emits_call_service_then_changes_the_world(self):
        automations = {'automation_detector': {'triggers': [
            {'trigger': 'event', 'event_type': 'call_service', 'event_data': {'domain': 'light'}}], 'actions': []}}
        seen = []
        sim = StandIn({'automation_detector': lambda sim, trigger: seen.append(trigger['event'])})
        [checkpoint] = session(sim, automations, world('bulb_a')).run(
            [PersonLightChange(['light.lamp_bulb_a'], {'brightness': 30})])
        [event] = seen
        self.assertEqual(event['data'], {'domain': 'light', 'service': 'turn_on',
                                         'service_data': {'entity_id': ['light.lamp_bulb_a'], 'brightness': 30}})
        self.assertIsNotNone(event['context']['user_id'])
        self.assertEqual(checkpoint.bulbs['bulb_a'].level, 30)

    def test_dashboard_and_switches_are_reported(self):
        def save(sim, trigger):
            sim.put('sensor.ls_overrides', '0', {'switch_ranges': {'switch.plug_x': [1, 2]}, 'overrides': {}})

        sim = StandIn({'automation_a': save})
        [checkpoint] = session(sim, on_start(), world(switches=['switch.plug_x'])).run([HaStart()])
        self.assertEqual(checkpoint.dashboard, {'switch_ranges': {'switch.plug_x': [1, 2]}})
        self.assertEqual(checkpoint.switches, {'switch.plug_x': 'off'})


class Candle(unittest.TestCase):
    def runtime(self, effect):
        return {'sensor.ls_effects_runtime': {'state': '1', 'attributes': {'assignments': {'light.lamp_bulb_a': {
            'brightness': {'kind': 'effect', 'effect': effect, 'instance': 'i', 'updated': 0},
            'color': {'kind': 'none', 'updated': 0}}}}}}

    def colour(self, sim, trigger):
        publish(sim, 'bulb_a', {'state': 'ON', 'brightness': 90, 'color_temp': 500})

    def test_reference_reports_a_candle_assignment_as_candle_and_counts_it(self):
        sim = StandIn({'automation_a': self.colour}, state=self.runtime('Candle'))
        the_session = session(sim, on_start(), world('bulb_a', 'bulb_b'))
        checkpoints = the_session.run([HaStart(), Advance(0)])
        self.assertEqual([c.bulbs['bulb_a'] for c in checkpoints], [On(90, Kelvin(2000), 'candle')] * 2)
        self.assertEqual(checkpoints[0].bulbs['bulb_b'].effect, 'none')
        self.assertEqual(dict(the_session.adjustments), {SOFTWARE_CANDLE: 2})   # one per bulb per checkpoint

    def test_port_is_judged_on_what_its_own_commands_did(self):
        sim = StandIn({'automation_a': self.colour}, state=self.runtime('Candle'), scheduled=[])
        the_session = session(sim, on_start(), world('bulb_a'), backend='port')
        [checkpoint] = the_session.run([HaStart()])
        self.assertEqual(checkpoint.bulbs['bulb_a'], On(90, Kelvin(2000), 'none'))
        self.assertEqual(dict(the_session.adjustments), {})

    def test_other_effects_are_reported_as_the_world_holds_them(self):
        sim = StandIn({'automation_a': lambda sim, trigger: None}, state=self.runtime('Breathe'))
        [checkpoint] = session(sim, on_start(), world('bulb_a')).run([HaStart()])
        self.assertEqual(checkpoint.bulbs['bulb_a'].effect, 'none')


class Enabled(unittest.TestCase):
    CAPTURE = {'automation.renamed_entity': {'state': 'off', 'attributes': {'id': '17'}},
               'automation.b': {'state': 'off', 'attributes': {'id': 'other'}},
               'automation.c': {'state': 'on', 'attributes': {'id': 'c'}},
               'automation.no_id': {'state': 'off', 'attributes': {}},
               'automation.gone': {'state': 'unavailable', 'attributes': {'id': 'g'}},
               'script.u': {'state': 'off', 'attributes': {'id': 'u'}}}

    def test_automations_off_in_the_live_capture_are_not_routed(self):
        automations = {'automation_a': {'id': '17'}, 'automation_b': {'id': 'b'}, 'automation_c': {'id': 'c'},
                       'automation_unlisted': {'id': 'u'}, 'automation_without_id': {}, 'automation_gone': {'id': 'g'}}
        self.assertEqual(list(enabled_automations(automations, self.CAPTURE)),
                         ['automation_c', 'automation_unlisted', 'automation_without_id'])


class ScriptStarts(unittest.TestCase):
    def test_script_turn_on_runs_its_target_after_the_run_in_call_order(self):
        def start(sim, trigger):
            for name, value in (('script.ls_first', 1), ('script.ls_render', 0), ('script.effects_engine', 0),
                                ('script.ls_second', 2)):
                sim.calls.append({'time': sim.elapsed, 'action': 'script.turn_on', 'target': {'entity_id': name},
                                  'data': {'variables': {'n': value}}})
            sim.log.append(('automation_a done', sim.now, {}))

        sim = StandIn({'automation_a': start, 'ls_first': lambda sim, data: None,
                       'ls_second': lambda sim, data: None})
        session(sim, on_start(), world()).run([HaStart()])
        self.assertEqual([(name, data) for name, _, data in sim.log[1:]],
                         [('automation_a done', {}), ('ls_first', {'n': 1}), ('ls_second', {'n': 2})])


@unittest.skipUnless(env.reference_available(), 'private reference or HA wrapper missing')
class RealBackends(unittest.TestCase):
    def test_continuation_runs_at_its_instant(self):
        # No routed input reaches the port's one delayed continuation: the captured remote automations fail
        # in the parity adapter (it passes them no room), before they start the gesture script. So the
        # press is recorded as that automation's own action would be, a start of the room's gesture
        # script, and everything after it is the real port: the gesture starts its quiet script, which
        # queues power_done 600 ms later.
        from tests.e2e.test_env import isolated
        result = isolated('''
            import json
            from datetime import datetime, timezone
            from tests.e2e.backend import Session
            from tests.e2e.env import open_sim
            from tests.e2e.router import Context, HaStart, StateChanged
            start = datetime(2026, 10, 23, 10, tzinfo=timezone.utc)
            with open_sim('port') as sim:
                session = Session.open(sim, 'port', start)
                session.run([HaStart()])
                room = sorted(sim._parity_catalog['remotes'])[0]
                sim.calls.append({'time': sim.elapsed, 'action': 'script.turn_on', 'data': {'variables': {'command': 'power'}},
                                  'target': {'entity_id': 'script.ls_remote_gesture_' + room}})
                ran, wrote, run = [], {}, sim.run
                def recording(name, **args):
                    if args.get('command') != 'power_done':
                        return run(name, **args)
                    ran.append(sim.now.timestamp() - start.timestamp())
                    before = {entity: value['state'] for entity, value in sim.state.items()}
                    result = run(name, **args)
                    wrote.update({entity: value['state'] for entity, value in sim.state.items()
                                  if before.get(entity) != value['state']})
                    return result
                sim.run = recording
                marker = StateChanged('input_text.e2e_marker', None, {'state': 'x', 'attributes': {}}, Context('m', None))
                session.run([marker])
                print(json.dumps({'ran': ran, 'wrote': len(wrote), 'left': len(sim._parity_extra.get('scheduled', [])),
                                  'kept': all(sim.state[entity]['state'] == state for entity, state in wrote.items())}))
        ''')
        # Drained within the step, at its own instant, as the reference's inline 600 ms wait runs it.
        self.assertEqual(len(result['ran']), 1)
        self.assertAlmostEqual(result['ran'][0], 0.6, delta=0.01)
        self.assertEqual(result['left'], 0)
        self.assertGreater(result['wrote'], 0)
        self.assertTrue(result['kept'])   # what it wrote is the state the step's checkpoint is taken in

    def test_plugs_seeded(self):
        from tests.e2e.test_env import isolated
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                result = isolated(f'''
                    import json
                    from datetime import datetime, timezone
                    from tests.e2e.backend import Session
                    from tests.e2e.env import open_sim
                    with open_sim({backend!r}) as sim:
                        session = Session.open(sim, {backend!r}, datetime(2026, 10, 23, 10, tzinfo=timezone.utc))
                        # The house's day block wants on/off plugs on, so the schedule names every plug it sees.
                        sim.put('input_boolean.ls_house_day_on_off', 'on', {{}})
                        base = sim.run('ls_base', reason='config', overrides={{}})
                        wanted = [entity for command in base['schedule']['cmds'] if command.get('kind') == 'switch'
                                  for entity in command['ids']]
                        print(json.dumps({{'plugs': session.plugs, 'switches': session.world.switch_names(),
                                          'wanted': wanted}}))
                ''')
                self.assertGreaterEqual(len(result['plugs']), 1)
                self.assertTrue(set(result['plugs']) <= set(result['switches']))
                self.assertEqual(sorted(result['wanted']), sorted(result['plugs']))

    def test_reference_and_port_agree_on_ha_start(self):
        reference, port = run_both([HaStart(), Advance(60)], START)
        result = compare(reference.checkpoints, port.checkpoints)
        dump = RUNTIME_DIR / 'ha-start-differences.json'   # git-ignored: the differences name catalog entities
        if result.differences:
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            dump.write_text(json.dumps([vars(difference) for difference in result.differences], indent=1, default=repr))
        self.assertEqual(len(result.differences), 0, f'{len(result.differences)} differences, listed in {dump}')

    def test_fade_sampled_every_tick(self):
        # A cosy profile unlike the default one, so the fade into cosy has somewhere to go.
        cosy = {'on': True, 'b': 60, 'm': 'ct', 'k': 2200, 'own': False, 'effect': 'Normal light'}
        person = Context('e2e-profile', 'e2e-person')
        steps = [StateChanged('input_text.ls_house_cosy', None,
                              {'entity_id': 'input_text.ls_house_cosy', 'state': json.dumps(cosy), 'attributes': {}}, person),
                 StateChanged('light.ls_house_cosy', None,
                              # The profile light as the simulator's own store writes it, rgb_color included.
                              {'entity_id': 'light.ls_house_cosy', 'state': 'on', 'attributes': {
                                  'brightness': 60, 'color_mode': 'color_temp', 'color_temp_kelvin': 2200,
                                  'rgb_color': [255, 255, 255]}}, person),
                 HaStart(), Advance(40 * 60)]
        start = datetime(2026, 10, 23, 17, 30, tzinfo=STOCKHOLM)   # the house fades into cosy before 18:00
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                checkpoints = [c for c in run_backend(backend, steps, start).checkpoints if c.step == 3]
                fading = [c.t for c in checkpoints if c.in_fade]
                self.assertGreaterEqual(len(fading), 10)
                ticks = [t for t in fading if t % 60 == 0]
                self.assertEqual(ticks, fading)
                self.assertEqual(fading, [fading[0] + 60 * n for n in range(len(fading))])


if __name__ == '__main__':
    unittest.main()
