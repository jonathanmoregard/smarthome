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
from tests.e2e.backend import PROBE_START, Session, _mode_switch, candle_probe_seeds, parse_request
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


class ProfileStandIn(StandIn):
    """A stand-in with the simulator's profile store: the `input_text` and its template light, as `Sim.store` writes."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.stored = []

    def store(self, entity, value):
        self.stored.append((entity, value))
        self.put(entity, json.dumps(value), self.state.get(entity, {}).get('attributes'))
        self.put(entity.replace('input_text.', 'light.'), 'on' if value.get('on', True) else 'off',
                 {'brightness': value.get('b', 150)})


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
                          helpers=(HelperInfo('input_text.x', None, None, 'day', 'light', '{"on": true}', {'max': 255}),
                                   HelperInfo('input_number.y', 'room_a', 'light.lamp_a', 'cosy', 'fade', '20',
                                              {'min': 0, 'max': 120})),
                          dashboard_options={'script_a.block': ('day', 'cosy')},
                          mode_switch='input_boolean.mode_x', candle_lamps=('light.lamp_a',),
                          overlay_rules=(Seed('input_number.ls_ovr_after_min', '180.0', {'min': 15}),))
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

    def test_a_profile_seed_goes_through_its_template_light(self):
        # In HA the block light `light.ls_*` is a template light over its `input_text` store, and the scripts
        # read both, so a seeded profile reaches the light too, as the simulator's own store writes it.
        sim = ProfileStandIn(state={'light.ls_x_day': {'state': 'on', 'attributes': {'brightness': 150}}})
        session(sim, {}, world(), seeds=[Seed('input_text.ls_x_day', '{"on": false, "b": 40}', {'max': 255})])
        self.assertEqual(sim.stored, [('input_text.ls_x_day', {'on': False, 'b': 40})])
        self.assertEqual(sim.state['input_text.ls_x_day']['attributes'], {'max': 255})
        self.assertEqual(sim.state['light.ls_x_day']['state'], 'off')

    def test_a_profile_store_changed_by_a_step_goes_through_its_template_light(self):
        # Ruling 63: a step writing the store reaches the template light as a seed does, and the change is
        # routed with the store's new text.
        follow = {'automation_follow': {'triggers': [{'trigger': 'state', 'entity_id': 'input_text.ls_x_day'}],
                                        'actions': []}}
        sim = ProfileStandIn({'automation_follow': lambda sim, trigger: None}, state={
            'input_text.ls_x_day': {'state': '{"on": true, "b": 150}', 'attributes': {'max': 255}},
            'light.ls_x_day': {'state': 'on', 'attributes': {'brightness': 150}}})
        text = '{"on": false, "b": 40}'
        session(sim, follow, world()).run(
            [StateChanged('input_text.ls_x_day', None, {'state': text, 'attributes': {'max': 255}}, Context('c', None))])
        self.assertEqual(sim.stored, [('input_text.ls_x_day', {'on': False, 'b': 40})])
        self.assertEqual((sim.state['input_text.ls_x_day']['state'], sim.state['input_text.ls_x_day']['attributes']),
                         (text, {'max': 255}))
        self.assertEqual(sim.state['light.ls_x_day']['state'], 'off')
        [(_, _, trigger)] = [entry for entry in sim.log if entry[0] == 'automation_follow']
        self.assertEqual(trigger['to_state']['state'], text)

    def test_a_step_on_a_store_with_no_template_light_is_written_as_it_is(self):
        sim = ProfileStandIn(state={'input_text.x': {'state': '{"a": 0}', 'attributes': {}}})
        session(sim, {}, world()).run([StateChanged('input_text.x', None, {'state': '{"a": 1}', 'attributes': {}},
                                                    Context('c', None))])
        self.assertEqual(sim.stored, [])
        self.assertEqual(sim.state['input_text.x']['state'], '{"a": 1}')

    def test_a_seed_with_no_template_light_is_put_as_it_is(self):
        sim = ProfileStandIn()
        session(sim, {}, world(), seeds=[Seed('input_text.x', '{"a": 1}', {}), Seed('input_number.y', '3', {})])
        self.assertEqual(sim.stored, [])
        self.assertEqual((sim.state['input_text.x']['state'], sim.state['input_number.y']['state']), ('{"a": 1}', '3'))

    def test_a_seed_on_any_light_or_switch_is_refused(self):
        # The world is built before the seeds, so a light or switch it does not know would be half seeded (ruling 41).
        for entity in ('light.unknown_x', 'switch.unknown_x'):
            with self.subTest(entity=entity), self.assertRaises(BackendError) as raised:
                session(StandIn(), {}, world('bulb_a'), seeds=[Seed(entity, 'on', {})])
            self.assertEqual(raised.exception.kind, 'MalformedRequest')


def probe_helper(entity, room, lamp, block, setting, state='x'):
    return HelperInfo(entity, room, lamp, block, setting, state, {'captured': entity})


class Describe(unittest.TestCase):
    def test_the_candle_probe_gives_each_candle_capable_lamp_a_candle_in_cosy(self):
        # Ruling 56: the lamp's own cosy store when it has one, else its room's (with the room's own light on),
        # else the house's; the house's starts put the probe's instant in cosy. Captured attributes are kept.
        lamps = (LampInfo('light.lamp_a1', 'room_a', ('bulb_a1',), True),
                 LampInfo('light.lamp_b1', 'room_b', ('bulb_b1',), True),
                 LampInfo('light.lamp_c1', 'room_c', ('bulb_c1',), True),
                 LampInfo('light.lamp_d1', 'room_d', ('bulb_d1',), False))
        helpers = [probe_helper('input_text.ls_lamp_lamp_a1_cosy', 'room_a', 'light.lamp_a1', 'cosy', 'light'),
                   probe_helper('input_text.ls_room_b_cosy', 'room_b', None, 'cosy', 'light'),
                   probe_helper('input_boolean.ls_room_b_cosy_own_light', 'room_b', None, 'cosy', 'own_light'),
                   probe_helper('input_text.ls_lamp_lamp_d1_cosy', 'room_d', 'light.lamp_d1', 'cosy', 'light')]
        for block in BLOCKS:
            helpers += [probe_helper(f'input_text.ls_house_{block}', None, None, block, 'light'),
                        probe_helper(f'input_datetime.ls_house_{block}_start', None, None, block, 'start'),
                        probe_helper(f'input_datetime.ls_house_{block}_weekend', None, None, block, 'weekend')]
        seeds = {seed.entity: seed for seed in candle_probe_seeds(helpers, lamps)}
        for seed in seeds.values():
            self.assertEqual(seed.attributes, {'captured': seed.entity})
        effects = {entity: json.loads(seed.state) for entity, seed in seeds.items() if entity.startswith('input_text.')}
        self.assertEqual({entity for entity, light in effects.items() if light['effect'] == 'Candle'},
                         {'input_text.ls_lamp_lamp_a1_cosy', 'input_text.ls_room_b_cosy', 'input_text.ls_house_cosy'})
        self.assertTrue(effects['input_text.ls_lamp_lamp_a1_cosy']['own'])
        self.assertEqual(seeds['input_boolean.ls_room_b_cosy_own_light'].state, 'on')
        starts = {block: seeds[f'input_datetime.ls_house_{block}_start'].state for block in BLOCKS}
        for block in BLOCKS:
            self.assertEqual(seeds[f'input_datetime.ls_house_{block}_weekend'].state, starts[block])
        probe = PROBE_START.strftime('%H:%M:%S')
        self.assertTrue(starts['day'] < starts['cosy'] <= probe < starts['night'])

    def test_a_mode_switch_needs_one_entity_flipped_both_ways(self):
        flips = [{'trigger': 'state', 'entity_id': 'input_boolean.m', 'from': 'off', 'to': 'on'},
                 {'trigger': 'state', 'entity_id': 'input_boolean.m', 'from': 'on', 'to': 'off'}]
        self.assertEqual(_mode_switch({'a': {'triggers': flips}}), 'input_boolean.m')
        unnamed = [{key: value for key, value in trigger.items() if key != 'entity_id'} for trigger in flips]
        self.assertIsNone(_mode_switch({'a': {'triggers': unnamed}}))
        either = [{'trigger': 'state', 'entity_id': 'input_boolean.m', 'to': 'on'}, flips[1]]
        self.assertIsNone(_mode_switch({'a': {'triggers': either}}))


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

    def test_a_restored_level_is_the_one_a_bare_on_comes_back_to(self):
        # Cut at 70 on the way down to 20: the bulb comes back at 70, and so does a later bare ON.
        the_world = world('bulb_a')
        lit(the_world)
        the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
            'topic': 'zigbee2mqtt/bulb_a/set', 'payload': json.dumps({'brightness': 20, 'transition': 10})}}, 0.0)
        the_world.power_cut(['bulb_a'], 5.0)
        the_world.power_restore(['bulb_a'], 6.0)
        for state in ('OFF', 'ON'):
            the_world.apply({'action': 'mqtt.publish', 'target': {}, 'data': {
                'topic': 'zigbee2mqtt/bulb_a/set', 'payload': json.dumps({'state': state})}}, 7.0)
        self.assertEqual(the_world.bulb('bulb_a', 7.0), On(70, Kelvin(2703), 'none'))

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

    def test_an_unavailable_light_keeps_only_its_group_members(self):
        # As HA: an unavailable light has no brightness or colour; a group keeps the members it is made of.
        sim = StandIn(state={'light.lamp_bulb_a': {'state': 'on', 'attributes': {'entity_id': ['light.x']}}})
        session(sim, {}, world('bulb_a')).run([PowerCut(('bulb_a',))])
        self.assertEqual(sim.state['light.lamp_bulb_a']['state'], 'unavailable')
        self.assertEqual(sim.state['light.lamp_bulb_a']['attributes'], {'entity_id': ['light.x']})

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
  const handlers = {{ probe: (ctx) => {{ ctx.emit(service, data, Object.keys(target).length === 0 ? undefined : target); return null; }} }};
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
        self.assertTrue(house.mode_switch.startswith('input_boolean.'))

    def test_helpers_carry_their_captured_state(self):
        from tests.e2e.test_env import isolated
        captured = isolated('''
            import json
            from tests.e2e.backend import DESCRIBE_START, Session
            from tests.e2e.env import open_sim
            with open_sim('reference') as sim:
                Session.open(sim, 'reference', DESCRIBE_START)
                print(json.dumps({entity: [value['state'], value['attributes']] for entity, value in sim.state.items()}))
        ''')
        for helper in self.house.helpers:
            with self.subTest(helper=helper.setting):
                self.assertEqual([helper.state, dict(helper.attributes)], captured[helper.entity])
        rules = {entity for entity in captured if entity.split('.', 1)[1].startswith('ls_ovr_')}
        self.assertTrue(rules)
        self.assertEqual({rule.entity for rule in self.house.overlay_rules}, rules)
        for rule in self.house.overlay_rules:
            self.assertEqual([rule.state, dict(rule.attributes)], captured[rule.entity])

    def test_candle_lamps_are_lamps_the_reference_ran_a_candle_on(self):
        lamps = {lamp.lamp for lamp in self.house.lamps}
        self.assertTrue(self.house.candle_lamps)
        self.assertTrue(set(self.house.candle_lamps) <= lamps)
        self.assertEqual(list(self.house.candle_lamps), sorted(set(self.house.candle_lamps)))

    def test_a_profile_seed_reaches_its_template_light_on_both_backends(self):
        from tests.e2e.test_env import isolated
        store = next(helper for helper in self.house.helpers if helper.setting == 'light')
        profile = {'on': True, 'b': 37, 'm': 'ct', 'k': 2500, 'own': False, 'effect': 'Normal light'}
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                light = isolated(f'''
                    import json
                    from tests.e2e.backend import DESCRIBE_START, Session
                    from tests.e2e.codec import Seed
                    from tests.e2e.env import open_sim
                    with open_sim({backend!r}) as sim:
                        Session.open(sim, {backend!r}, DESCRIBE_START,
                                     [Seed({store.entity!r}, {json.dumps(profile)!r}, {dict(store.attributes)!r})])
                        print(json.dumps(sim.state[{store.entity.replace('input_text.', 'light.')!r}]))
                ''')
                self.assertEqual((light['state'], light['attributes']['brightness'],
                                  light['attributes']['color_temp_kelvin']), ('on', 37, 2500))

    def test_a_range_saved_for_a_plug_reaches_the_dashboard_on_both_backends(self):
        # The range save refuses a switch with no device; each synthetic plug has one, on both backends.
        from tests.e2e.router import ScriptCall
        from tests.e2e.runner import run_backend
        plug = self.house.plugs[0]
        steps = [HaStart(), ScriptCall('ls_range_save', {'entity': plug, 'profile': 'bright'}, Context('e2e-r', 'e2e-person'))]
        for backend in ('reference', 'port'):
            with self.subTest(backend=backend):
                final = run_backend(backend, steps, START).checkpoints[-1]
                self.assertEqual(final.dashboard['switch_ranges'][plug]['profile'], 'bright')

    def test_remote_press_switches_its_room_on_both_backends(self):
        # Judged by what the bulbs show, not by which scripts ran: the port reads a press in one turn and starts
        # no gesture or command script. Every press of every remote, each followed by a settled gap. A remote
        # whose device has an area switches the power of its room's lamps, and of no other, with some press; one
        # whose device has none switches nothing; and both backends switch the same bulbs the same way each press.
        from tests.e2e.runner import run_backend
        presses = [(remote, press) for remote in self.house.remotes for press in remote.presses]
        steps = [HaStart()]
        for remote, press in presses:
            steps += [Mqtt(remote.topic, press), Advance(120)]
        switched = {}
        for backend in ('reference', 'port'):
            settled = {}
            for checkpoint in run_backend(backend, steps, START).checkpoints:
                settled[checkpoint.step] = {bulb: 'off' if isinstance(state, Off) else 'on'
                                            for bulb, state in checkpoint.bulbs.items()}
            # Press k is step 2k + 1; the house before it is step 2k's last checkpoint, after it step 2k + 2's.
            switched[backend] = [{bulb: power for bulb, power in settled[2 * index + 2].items()
                                  if settled[2 * index][bulb] != power} for index in range(len(presses))]
        for backend, changes in switched.items():
            for remote in self.house.remotes:
                with self.subTest(backend=backend, remote=remote.topic):
                    own = [change for (pressed, _), change in zip(presses, changes, strict=True) if pressed is remote]
                    reached = {bulb for change in own for bulb in change}
                    if remote.room is None:
                        self.assertEqual(reached, set())
                    else:
                        room_bulbs = {bulb for lamp in self.house.lamps if lamp.room == remote.room for bulb in lamp.bulbs}
                        self.assertTrue(reached)
                        self.assertLessEqual(reached, room_bulbs)
        self.assertEqual(switched['reference'], switched['port'])


if __name__ == '__main__':
    unittest.main()
