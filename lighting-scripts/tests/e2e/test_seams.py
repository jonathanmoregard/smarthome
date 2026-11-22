"""Seams scenarios need: the house description, seeds, wall power, remotes, helper services.

The unguarded cases use synthetic names only (`bulb_a`, `input_text.x`). The
guarded cases run the real backends and read every catalog name at run time;
none is written into this file.
"""
from __future__ import annotations
from datetime import datetime
import json
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from zoneinfo import ZoneInfo

from tests.e2e import env
from tests.e2e.backend import Session, parse_request
from tests.e2e.codec import (Advance, HelperInfo, HouseInfo, LampInfo, PowerCut, PowerRestore, RemoteInfo, Seed,
                             decode, encode)
from tests.e2e.router import Context, HaStart, Mqtt, StateChanged
from tests.e2e.runner import BackendError
from tests.e2e.services import install
from tests.e2e.test_runner import StandIn, on_start, publish, world
from tests.e2e.world import BulbInfo, Kelvin, Off, On, World

STOCKHOLM = ZoneInfo('Europe/Stockholm')
START = datetime(2026, 10, 23, 12, 0, tzinfo=STOCKHOLM)
ROOT = Path(__file__).resolve().parents[2]
ENGINE = ROOT / 'src' / 'runtime' / 'engine.ts'
BLOCKS = ('day', 'cosy', 'night')
HELPER_SETTINGS = {'light', 'start', 'weekend', 'fade', 'own_light', 'own_timing'}


def session(sim, automations, the_world, backend='reference', seeds=()):
    return Session(sim, backend, automations, plugs=[], world=the_world, start=START, seeds=seeds)


def lit(the_world, name='bulb_a', now=0.0):
    the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
        'topic': f'zigbee2mqtt/{name}/set', 'payload': json.dumps({'state': 'ON', 'brightness': 120, 'color_temp': 370})}},
        now)


class Codec(unittest.TestCase):
    def test_new_kinds_round_trip(self):
        house = HouseInfo(rooms=('room_a',), lamps=(LampInfo('light.lamp_a', 'room_a', ('bulb_a',), True),),
                          remotes=(RemoteInfo('room_a', 'zigbee2mqtt/remote_a/action', ('on', 'off')),
                                   RemoteInfo(None, 'zigbee2mqtt/remote_b/action', ('on',))),
                          plugs=('switch.plug_x',),
                          helpers=(HelperInfo('input_text.x', None, None, 'day', 'light'),
                                   HelperInfo('input_number.y', 'room_a', 'light.lamp_a', 'cosy', 'fade')),
                          dashboard_options={'script_a.block': ('day', 'cosy')})
        for value in (house, Seed('input_text.x', 'v', {'a': [1, 2]}), PowerCut(('bulb_a',)), PowerRestore(('bulb_a',))):
            with self.subTest(kind=type(value).__name__):
                self.assertEqual(decode(json.loads(json.dumps(encode(value)))), value)

    def test_a_request_carries_its_seeds(self):
        seeds = [Seed('input_text.x', 'v', {})]
        start, steps, carried = parse_request('port', encode({'start': START, 'steps': [HaStart()], 'seeds': seeds}))
        self.assertEqual(carried, seeds)
        self.assertEqual(parse_request('port', encode({'start': START, 'steps': []}))[2], [])

    def test_a_seed_that_is_not_a_seed_is_refused(self):
        with self.assertRaises(BackendError) as raised:
            parse_request('port', encode({'start': START, 'steps': [], 'seeds': [HaStart()]}))
        self.assertEqual(raised.exception.kind, 'MalformedRequest')


class Seeds(unittest.TestCase):
    FOLLOW = {'automation_follow': {'triggers': [{'trigger': 'state', 'entity_id': 'input_text.x'}], 'actions': []}}

    def test_seed_is_silent(self):
        sim = StandIn({'automation_follow': lambda sim, trigger: None})
        [checkpoint] = session(sim, self.FOLLOW, world(), seeds=[Seed('input_text.x', 'v', {'a': 1})]).run([HaStart()])
        self.assertEqual(sim.log, [])
        self.assertEqual((sim.state['input_text.x']['state'], sim.state['input_text.x']['attributes']), ('v', {'a': 1}))
        self.assertEqual(checkpoint.step, 0)

    def test_a_later_change_starts_from_the_seed(self):
        sim = StandIn({'automation_follow': lambda sim, trigger: None})
        step = StateChanged('input_text.x', None, {'state': 'w', 'attributes': {}}, Context('c', None))
        session(sim, self.FOLLOW, world(), seeds=[Seed('input_text.x', 'v', {})]).run([step])
        [(_, _, trigger)] = sim.log
        self.assertEqual((trigger['from_state']['state'], trigger['to_state']['state']), ('v', 'w'))

    def test_a_seed_on_an_entity_the_world_owns_is_refused(self):
        # The world writes its lights and switches back over anything seeded there, so such a seed would vanish.
        sim = StandIn()
        with self.assertRaises(BackendError) as raised:
            session(sim, {}, world('bulb_a'), seeds=[Seed('light.lamp_bulb_a', 'off', {})])
        self.assertEqual(raised.exception.kind, 'MalformedRequest')


class Power(unittest.TestCase):
    def test_power_cut_then_restore(self):
        the_world = world('bulb_a')
        lit(the_world)
        the_world.power_cut(['bulb_a'], 1.0)
        self.assertEqual(the_world.bulb('bulb_a', 1.0), Off())
        self.assertEqual(the_world.ha_states(1.0)['light.lamp_bulb_a'], {
            'entity_id': 'light.lamp_bulb_a', 'state': 'unavailable', 'attributes': {}})
        the_world.power_restore(['bulb_a'], 2.0)
        self.assertEqual(the_world.bulb('bulb_a', 2.0), On(120, Kelvin(2703), 'none'))
        self.assertEqual(the_world.ha_states(2.0)['light.lamp_bulb_a']['state'], 'on')
        self.assertEqual(the_world.ha_states(2.0)['light.lamp_bulb_a']['attributes']['brightness'], 120)

    def test_commands_to_an_unpowered_bulb_are_ignored(self):
        the_world = World(bulbs={name: BulbInfo(name, False) for name in ('bulb_a', 'bulb_b')},
                          groups={'group/ab': ['bulb_a', 'bulb_b']}, switches=[],
                          ha_lights={'light.lamp_a': ['bulb_a'], 'light.lamp_b': ['bulb_b']})
        lit(the_world)
        lit(the_world, 'bulb_b')
        the_world.power_cut(['bulb_a'], 1.0)
        for topic in ('bulb_a', 'group/ab'):
            the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
                'topic': f'zigbee2mqtt/{topic}/set', 'payload': json.dumps({'brightness': 30, 'transition': 1})}}, 2.0)
        the_world.apply({'action': 'light.turn_on', 'target': {'entity_id': 'light.lamp_a'}, 'data': {'brightness': 40}},
                        2.0)
        self.assertEqual(the_world.bulb('bulb_a', 2.0), Off())
        self.assertEqual(the_world.fading(2.0), frozenset({'bulb_b'}))   # a dark bulb starts no fade
        self.assertEqual(the_world.bulb('bulb_b', 3.0).level, 30)
        the_world.power_restore(['bulb_a'], 3.0)
        self.assertEqual(the_world.bulb('bulb_a', 3.0), On(120, Kelvin(2703), 'none'))
        for state in ('OFF', 'ON'):   # nor does it remember a level it never received
            the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
                'topic': 'zigbee2mqtt/bulb_a/set', 'payload': json.dumps({'state': state})}}, 4.0)
        self.assertEqual(the_world.bulb('bulb_a', 4.0).level, 120)

    def test_a_cut_mid_fade_restores_the_level_it_had_reached(self):
        the_world = world('bulb_a')
        lit(the_world)
        the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
            'topic': 'zigbee2mqtt/bulb_a/set', 'payload': json.dumps({'brightness': 20, 'transition': 10})}}, 0.0)
        the_world.power_cut(['bulb_a'], 5.0)
        self.assertEqual(the_world.fading(5.0), frozenset())
        the_world.power_restore(['bulb_a'], 60.0)
        self.assertEqual(the_world.bulb('bulb_a', 60.0).level, 70)

    def test_the_firmware_candle_does_not_survive_a_power_cut(self):
        the_world = world('bulb_a')
        lit(the_world)
        the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
            'topic': 'zigbee2mqtt/bulb_a/set', 'payload': json.dumps({'effect': 'channel_change'})}}, 0.0)
        the_world.power_cut(['bulb_a'], 1.0)
        the_world.power_restore(['bulb_a'], 2.0)
        self.assertEqual(the_world.bulb('bulb_a', 2.0).effect, 'none')

    def test_a_bulb_that_was_off_comes_back_off(self):
        # Zigbee2MQTT power_on_behavior `previous` restores the power state the bulb had, as well as its light.
        the_world = world('bulb_a')
        the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
            'topic': 'zigbee2mqtt/bulb_a/set', 'payload': json.dumps({'state': 'OFF'})}}, 0.0)
        the_world.power_cut(['bulb_a'], 1.0)
        the_world.power_restore(['bulb_a'], 2.0)
        self.assertEqual(the_world.bulb('bulb_a', 2.0), Off())
        self.assertEqual(the_world.ha_states(2.0)['light.lamp_bulb_a']['state'], 'off')

    def test_a_lamp_is_unavailable_only_when_every_bulb_is(self):
        the_world = World(bulbs={name: BulbInfo(name, False) for name in ('bulb_a', 'bulb_b')}, groups={},
                          switches=[], ha_lights={'light.lamp_ab': ['bulb_a', 'bulb_b']})
        lit(the_world)
        lit(the_world, 'bulb_b')
        the_world.power_cut(['bulb_a'], 1.0)
        self.assertEqual(the_world.ha_states(1.0)['light.lamp_ab']['state'], 'on')
        the_world.power_cut(['bulb_b'], 1.0)
        self.assertEqual(the_world.ha_states(1.0)['light.lamp_ab']['state'], 'unavailable')

    def test_cutting_an_unpowered_bulb_or_restoring_a_powered_one_is_refused(self):
        the_world = world('bulb_a')
        with self.assertRaises(ValueError):
            the_world.power_restore(['bulb_a'], 0.0)
        the_world.power_cut(['bulb_a'], 0.0)
        with self.assertRaises(ValueError):
            the_world.power_cut(['bulb_a'], 0.0)

    def test_write_back_keeps_unavailable(self):
        # A script that turns the lamp back on, through the sim's own light state as well as a bulb command,
        # still leaves an unpowered bulb's light unavailable.
        def turn_on(sim, trigger):
            publish(sim, 'bulb_a', {'state': 'ON'})
            sim.put('light.lamp_bulb_a', 'on', {'brightness': 254})

        automations = {'automation_relight': {'triggers': [
            {'trigger': 'state', 'entity_id': 'light.lamp_bulb_a', 'to': 'unavailable'}], 'actions': []}}
        sim = StandIn({'automation_relight': turn_on})
        [checkpoint] = session(sim, automations, world('bulb_a')).run([PowerCut(('bulb_a',))])
        self.assertEqual([name for name, *_ in sim.log], ['automation_relight'])
        self.assertEqual(sim.state['light.lamp_bulb_a']['state'], 'unavailable')
        self.assertEqual(checkpoint.bulbs['bulb_a'], Off())

    def test_power_restore_is_routed_unavailable_to_on(self):
        seen = []
        automations = {'automation_follow': {'triggers': [
            {'trigger': 'state', 'entity_id': 'light.lamp_bulb_a'}], 'actions': []}}
        sim = StandIn({'automation_follow': lambda sim, trigger: seen.append(
            (trigger['from_state']['state'], trigger['to_state']['state']))})
        checkpoints = session(sim, automations, world('bulb_a')).run(
            [PowerCut(('bulb_a',)), Advance(300), PowerRestore(('bulb_a',))])
        self.assertEqual(seen, [('on', 'unavailable'), ('unavailable', 'on')])
        self.assertEqual(checkpoints[-1].bulbs['bulb_a'], On(254, None, 'none'))


# --- helper services: the reference sim writes state text as the port's sim does --------------------------

SERVICE_CASES = [
    ('input_number.set_value', {'entity_id': 'input_number.n'}, {'value': value})
    for value in (0, -1, 3, 1.5, 2.0, -0.0, 1e-7, 0.000001, 1e21, 123456789012345680000.0, 0.1 + 0.2)
] + [
    ('input_text.set_value', {'entity_id': 'input_text.t'}, {'value': value})
    for value in ('', 'abc', '2026-10-23T12:00:00.600000+02:00', 7)
] + [
    ('input_select.select_option', {'entity_id': 'input_select.s'}, {'option': 'cosy'}),
    ('input_boolean.turn_on', {'entity_id': ['input_boolean.b']}, {}),
    ('input_boolean.turn_off', {'entity_id': 'input_boolean.b'}, {}),
    ('timer.start', {'entity_id': 'timer.c'}, {'duration': '00:00:03'}),
    ('timer.cancel', {'entity_id': 'timer.c'}, {}),
    ('input_datetime.set_datetime', {'entity_id': 'input_datetime.d'}, {'time': '07:30:00'}),
    ('input_number.set_value', {}, {'entity_id': 'input_number.n', 'value': 4}),
]
SERVICE_STATE = {entity: {'entity_id': entity, 'state': state, 'attributes': {'kept': True}}
                 for entity, state in (('input_number.n', '9'), ('input_text.t', 'old'), ('input_select.s', 'day'),
                                       ('input_boolean.b', 'off'), ('timer.c', 'idle'),
                                       ('input_datetime.d', '06:00:00'))}

PORT_PROBE = '''
import {{ execute }} from {engine};
const cases = {cases};
const out = [];
for (const [service, target, data] of cases) {{
  const snapshot = {{ state: structuredClone({state}), areas: {{}}, members: [], now: '2026-10-23T12:00:00+02:00' }};
  const handlers = {{ probe: (ctx) => {{ ctx.emit(service, data, Object.keys(target).length ? target : undefined); return null; }} }};
  const result = execute({{ script: 'probe', args: {{}}, snapshot }}, handlers);
  out.push(Object.fromEntries(Object.entries(result.snapshot.state).map(([entity, value]) =>
    [entity, [value.state, value.attributes]])));
}}
console.log(JSON.stringify(out));
'''


class ServiceSim:
    """The reference sim's `put` and call recorder (effects-promotion harness `Sim`), nothing else."""

    def __init__(self, state):
        self.state = json.loads(json.dumps(state))
        self.calls, self.elapsed, self.fallen_through = [], 0.0, []
        self.service = lambda action, target, data: self.fallen_through.append(action)

    def put(self, entity, state, attributes=None):
        previous = self.state.get(entity, {})
        self.state[entity] = {'entity_id': entity, 'state': str(state), 'attributes': json.loads(json.dumps(
            attributes if attributes is not None else previous.get('attributes', {})))}


class HelperServices(unittest.TestCase):
    def port_states(self):
        with tempfile.TemporaryDirectory(prefix='e2e-probe-') as directory:
            probe = Path(directory) / 'probe.ts'
            probe.write_text(PORT_PROBE.format(engine=json.dumps(ENGINE.as_uri()), cases=json.dumps(SERVICE_CASES),
                                               state=json.dumps(SERVICE_STATE)))
            completed = subprocess.run(['node', '--experimental-strip-types', '--no-warnings', str(probe)], cwd=ROOT,
                                       capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_helper_service_state_text_matches_port(self):
        port = self.port_states()
        for (service, target, data), expected in zip(SERVICE_CASES, port, strict=True):
            with self.subTest(service=service, data=data):
                sim = ServiceSim(SERVICE_STATE)
                install(sim)
                sim.service(service, target, data)
                self.assertEqual({entity: [value['state'], value['attributes']] for entity, value in sim.state.items()},
                                 expected)
                self.assertEqual([call['action'] for call in sim.calls], [service])
                self.assertEqual(sim.fallen_through, [])

    def test_other_services_fall_through(self):
        sim = ServiceSim({})
        install(sim)
        sim.service('light.turn_on', {'entity_id': 'light.x'}, {})
        self.assertEqual((sim.fallen_through, sim.calls), (['light.turn_on'], []))

    def test_a_profile_store_keeps_its_template_light(self):
        # The reference's template-light shim mirrors a saved profile into its `light.ls_*`; the text it
        # writes into the store is the port's.
        sim = ServiceSim({})
        install(sim)
        value = '{"on": true, "b": 150}'
        sim.service('input_text.set_value', {'entity_id': 'input_text.ls_x'}, {'value': value})
        self.assertEqual(sim.fallen_through, ['input_text.set_value'])
        self.assertEqual(sim.state['input_text.ls_x']['state'], value)

    def test_a_missing_value_is_refused(self):
        sim = ServiceSim(SERVICE_STATE)
        install(sim)
        for service, data in (('input_number.set_value', {}), ('input_select.select_option', {})):
            with self.subTest(service=service), self.assertRaises(KeyError):
                sim.service(service, {'entity_id': 'input_number.n'}, data)


# --- the real backends ------------------------------------------------------------------------------------

@unittest.skipUnless(env.reference_available(), 'private reference or HA wrapper missing')
class RealBackends(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from tests.e2e.runner import describe_house
        cls.house = describe_house()

    def test_describe_lists_rooms_lamps_remotes_plugs_helpers(self):
        house = self.house
        self.assertIsInstance(house, HouseInfo)
        self.assertTrue(house.rooms)
        self.assertEqual(list(house.rooms), sorted(set(house.rooms)))
        lamps = {lamp.lamp for lamp in house.lamps}
        self.assertTrue(lamps)
        for lamp in house.lamps:
            self.assertIn(lamp.room, house.rooms)
            self.assertTrue(lamp.bulbs)
        self.assertEqual(len({bulb for lamp in house.lamps for bulb in lamp.bulbs}),
                         sum(len(lamp.bulbs) for lamp in house.lamps))   # a bulb belongs to at most one lamp
        self.assertEqual(len(house.plugs), len(house.rooms))
        self.assertTrue(house.remotes)
        self.assertTrue(any(remote.room is not None for remote in house.remotes))
        for remote in house.remotes:
            self.assertTrue(remote.room is None or remote.room in house.rooms)
            self.assertTrue(remote.topic.startswith('zigbee2mqtt/'))
            self.assertTrue(remote.presses)
        self.assertEqual(len({remote.topic for remote in house.remotes}), len(house.remotes))
        settings = {helper.setting for helper in house.helpers}
        self.assertEqual(settings, HELPER_SETTINGS)
        for helper in house.helpers:
            self.assertTrue(helper.room is None or helper.room in house.rooms)
            self.assertTrue(helper.lamp is None or helper.lamp in lamps)
            self.assertIn(helper.block, BLOCKS)
        house_light = {(helper.block, helper.setting) for helper in house.helpers if helper.room is None}
        self.assertTrue({(block, setting) for block in BLOCKS for setting in ('light', 'start', 'weekend', 'fade')}
                        <= house_light)
        self.assertTrue(any(helper.lamp is not None for helper in house.helpers))
        self.assertEqual(house.dashboard_options['ls_override_block.block'], BLOCKS)

    def test_remote_press_runs_on_both_backends(self):
        # Each press reaches its remote's own gesture script. A remote whose device has an area goes on to
        # the remote command for that room, and one whose device has none stops there, on both backends.
        from tests.e2e.test_env import isolated
        presses = [(remote.topic, press) for remote in self.house.remotes for press in remote.presses]
        placed = {remote.topic: remote.room is not None for remote in self.house.remotes}
        runs = {}
        for backend in ('reference', 'port'):
            runs[backend] = isolated(f'''
                import json
                from datetime import datetime
                from zoneinfo import ZoneInfo
                from tests.e2e.backend import Session
                from tests.e2e.codec import Advance
                from tests.e2e.env import open_sim
                from tests.e2e.router import HaStart, Mqtt
                with open_sim({backend!r}) as sim:
                    session = Session.open(sim, {backend!r}, datetime(2026, 10, 23, 12, tzinfo=ZoneInfo('Europe/Stockholm')))
                    session.run([HaStart()])
                    ran, run = [], sim.run
                    def recording(name, **args):
                        ran.append(name)
                        return run(name, **args)
                    sim.run = recording
                    sim.script_runs = ran   # the port's own script starts inside one RPC
                    gestures = []
                    for topic, press in {presses!r}:
                        ran.clear()
                        session.run([Mqtt(topic, press), Advance(120)])
                        gestures.append([sorted({{name for name in ran if name.startswith('ls_remote_gesture_')}}),
                                         'ls_remote_command' in ran])
                    print(json.dumps(gestures))
            ''')
        for backend, gestures in runs.items():
            with self.subTest(backend=backend):
                by_topic = {}
                for (topic, press), (names, commanded) in zip(presses, gestures, strict=True):
                    self.assertEqual(len(names), 1, (backend, press, names))
                    self.assertEqual(commanded, placed[topic], (backend, press))
                    by_topic.setdefault(topic, set()).update(names)
                self.assertTrue(all(len(names) == 1 for names in by_topic.values()), by_topic)
                self.assertEqual(len({name for names in by_topic.values() for name in names}), len(by_topic))
        self.assertEqual(runs['reference'], runs['port'])


if __name__ == '__main__':
    unittest.main()
