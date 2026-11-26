"""World model: the service calls a backend records become bulb and switch state.

Synthetic names only (bulb_a, group/ab, plug_x, light.lamp_a). `from_sim` is
checked against a stub catalog here, and against the private reference when it
is present, without naming anything from it.
"""
import json
from types import SimpleNamespace
import unittest

from tests.e2e import env
from tests.e2e.world import BulbInfo, Kelvin, Line, Off, On, Rgb, UnhandledPayload, UnknownTarget, World


def publish(topic, payload):
    return {'time': 0, 'action': 'mqtt.publish', 'target': {},
            'data': {'topic': f'zigbee2mqtt/{topic}/set', 'payload': json.dumps(payload), 'qos': 0, 'retain': False}}


def service(action, entity_id, data=None):
    return {'time': 0, 'action': action, 'target': {'entity_id': entity_id}, 'data': data or {}}


def make_world():
    return World(
        bulbs={name: BulbInfo(topic=name, candle_capable=True) for name in ('bulb_a', 'bulb_b', 'bulb_c')},
        groups={'group/ab': ['bulb_a', 'bulb_b']},
        switches=['switch.plug_x'],
        ha_lights={'light.lamp_a': ['bulb_a'], 'light.group_ab': ['bulb_a', 'bulb_b'],
                   'light.lamp_c': ['bulb_c']},
    )


class DirectPublish(unittest.TestCase):
    def test_direct_publish_sets_level_and_kelvin(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 120, 'color_temp': 370}), 0)
        self.assertEqual(world.bulb('bulb_a', 0), On(level=120, colour=Kelvin(round(1e6 / 370)), effect='none'))

    def test_rgb_string_colour(self):
        world = make_world()
        world.apply(publish('bulb_a', {'color': {'rgb': '255,120,10'}}), 0)
        self.assertEqual(world.bulb('bulb_a', 0).colour, Rgb(255, 120, 10))

    def test_payload_is_parsed_not_compared_as_text(self):
        world = make_world()
        call = publish('bulb_a', {'brightness': 7})
        call['data']['payload'] = '{ "brightness" : 7 }'
        world.apply(call, 0)
        self.assertEqual(world.bulb('bulb_a', 0).level, 7)

    def test_group_publish_changes_members_only(self):
        world = make_world()
        before_c = world.bulb('bulb_c', 0)
        world.apply(publish('group/ab', {'state': 'ON', 'brightness': 99}), 0)
        self.assertEqual(world.bulb('bulb_a', 0).level, 99)
        self.assertEqual(world.bulb('bulb_b', 0).level, 99)
        self.assertEqual(world.bulb('bulb_c', 0), before_c)

    def test_off_is_off(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'OFF'}), 0)
        self.assertEqual(world.bulb('bulb_a', 0), Off())

    def test_colour_survives_off_and_on(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 80, 'color_temp': 400}), 0)
        world.apply(publish('bulb_a', {'state': 'OFF'}), 1)
        world.apply(publish('bulb_a', {'state': 'ON'}), 2)
        self.assertEqual(world.bulb('bulb_a', 2), On(level=80, colour=Kelvin(2500), effect='none'))


class Transitions(unittest.TestCase):
    def test_transition_is_a_straight_line(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'OFF'}), 0)
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 200, 'color_temp': 400, 'transition': 10}), 0)
        self.assertEqual(world.bulb('bulb_a', 5).level, 100)
        self.assertEqual(world.bulb('bulb_a', 10).level, 200)

    def test_fade_to_off(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 200}), 0)
        world.apply(publish('bulb_a', {'state': 'OFF', 'transition': 10}), 0)
        self.assertEqual(world.bulb('bulb_a', 5).level, 100)
        self.assertEqual(world.bulb('bulb_a', 10), Off())

    def test_new_command_starts_from_the_interpolated_level(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'OFF'}), 0)
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 200, 'transition': 10}), 0)
        world.apply(publish('bulb_a', {'brightness': 50, 'transition': 10}), 5)
        self.assertEqual(world.bulb('bulb_a', 10).level, 75)
        self.assertEqual(world.bulb('bulb_a', 15).level, 50)

    def test_line_records_a_transition_in_progress(self):
        line = Line(start=Off(), end=On(200, None, 'none'), t0=0.0, t1=10.0)
        self.assertEqual((line.t0, line.t1), (0.0, 10.0))

    def test_effect_or_colour_alone_leaves_a_running_level_line(self):
        # Zigbee level and colour are separate clusters: a send with neither brightness nor state
        # does not stop a level move in progress.
        world = make_world()
        world.apply(publish('bulb_a', {'brightness': 200, 'transition': 10}), 0)
        world.apply(publish('bulb_a', {'effect': 'channel_change'}), 2)
        world.apply(publish('bulb_a', {'color': {'rgb': '1,2,3'}}), 4)
        self.assertEqual(world.bulb('bulb_a', 5), On(227, Rgb(1, 2, 3), 'candle'))
        self.assertEqual(world.fading(5), frozenset({'bulb_a'}))
        self.assertEqual(world.bulb('bulb_a', 10), On(200, Rgb(1, 2, 3), 'candle'))

    def test_colour_alone_during_a_fade_to_off_keeps_the_fade(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'OFF', 'transition': 10}), 0)
        world.apply(publish('bulb_a', {'color_temp': 400}), 5)
        self.assertEqual(world.bulb('bulb_a', 5), On(127, Kelvin(2500), 'none'))
        self.assertEqual(world.bulb('bulb_a', 10), Off())

    def test_fading_names_bulbs_with_a_line_from_t0_until_t1(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'OFF'}), 0)
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 200, 'transition': 10}), 0)
        world.apply(publish('bulb_b', {'brightness': 9}), 0)
        self.assertEqual(world.fading(0), frozenset({'bulb_a'}))
        self.assertEqual(world.fading(9.5), frozenset({'bulb_a'}))
        self.assertEqual(world.fading(10), frozenset())


class Inventory(unittest.TestCase):
    def test_names_and_lamp_membership(self):
        world = make_world()
        self.assertEqual(world.bulb_names(), ['bulb_a', 'bulb_b', 'bulb_c'])
        self.assertEqual(world.switch_names(), ['switch.plug_x'])
        self.assertEqual(world.bulbs_of('light.group_ab'), ['bulb_a', 'bulb_b'])
        self.assertEqual(world.bulbs_of('light.not_a_lamp'), [])


class Candle(unittest.TestCase):
    def candle_world(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 120, 'color_temp': 400}), 0)
        world.apply(publish('bulb_a', {'effect': 'channel_change'}), 1)
        return world

    def test_candle_starts_after_colour(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'ON', 'color_temp': 400}), 0)
        world.apply(publish('bulb_a', {'effect': 'channel_change'}), 1)
        state = world.bulb('bulb_a', 1)
        self.assertEqual(state.effect, 'candle')
        self.assertEqual(state.colour, Kelvin(2500))

    def test_brightness_ends_candle(self):
        world = self.candle_world()
        world.apply(publish('bulb_a', {'brightness': 50}), 2)
        self.assertEqual(world.bulb('bulb_a', 2).effect, 'none')

    def test_on_ends_candle(self):
        world = self.candle_world()
        world.apply(publish('bulb_a', {'state': 'ON'}), 2)
        self.assertEqual(world.bulb('bulb_a', 2).effect, 'none')

    def test_stop_effect_and_stop_colorloop_end_candle(self):
        for stop in ('stop_effect', 'stop_colorloop'):
            with self.subTest(stop=stop):
                world = self.candle_world()
                world.apply(publish('bulb_a', {'effect': stop}), 2)
                self.assertEqual(world.bulb('bulb_a', 2).effect, 'none')

    def test_colour_alone_keeps_candle(self):
        world = self.candle_world()
        world.apply(publish('bulb_a', {'color': {'rgb': '1,2,3'}}), 2)
        state = world.bulb('bulb_a', 2)
        self.assertEqual(state.effect, 'candle')
        self.assertEqual(state.colour, Rgb(1, 2, 3))

    def test_off_ends_candle(self):
        world = self.candle_world()
        world.apply(publish('bulb_a', {'state': 'OFF'}), 2)
        world.apply(publish('bulb_a', {'state': 'ON'}), 3)
        self.assertEqual(world.bulb('bulb_a', 3).effect, 'none')


class HomeAssistantCalls(unittest.TestCase):
    def test_homeassistant_turn_on_mixed_list(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'OFF'}), 0)
        world.apply(service('homeassistant.turn_on', ['light.lamp_a', 'switch.plug_x']), 1)
        self.assertEqual(world.bulb('bulb_a', 1).level, 254)
        self.assertEqual(world.switch('switch.plug_x'), 'on')

    def test_homeassistant_turn_off_mixed_list(self):
        world = make_world()
        world.apply(service('homeassistant.turn_on', 'switch.plug_x'), 0)
        world.apply(service('homeassistant.turn_off', ['light.lamp_a', 'switch.plug_x']), 1)
        self.assertEqual(world.bulb('bulb_a', 1), Off())
        self.assertEqual(world.switch('switch.plug_x'), 'off')

    def test_light_turn_on_ha_group_expands(self):
        world = make_world()
        world.apply(service('light.turn_on', 'light.group_ab', {
            'brightness': 33, 'color_temp_kelvin': 3000, 'transition': 0}), 0)
        for name in ('bulb_a', 'bulb_b'):
            self.assertEqual(world.bulb(name, 0), On(level=33, colour=Kelvin(3000), effect='none'))
        self.assertNotEqual(world.bulb('bulb_c', 0), On(level=33, colour=Kelvin(3000), effect='none'))

    def test_light_turn_on_rgb_colour(self):
        world = make_world()
        world.apply(service('light.turn_on', 'light.lamp_c', {'rgb_color': [9, 8, 7]}), 0)
        self.assertEqual(world.bulb('bulb_c', 0).colour, Rgb(9, 8, 7))

    def test_light_turn_off_ha_group(self):
        world = make_world()
        world.apply(service('light.turn_off', 'light.group_ab'), 0)
        self.assertEqual(world.bulb('bulb_a', 0), Off())
        self.assertEqual(world.bulb('bulb_b', 0), Off())

    def test_profile_light_ignored(self):
        world = make_world()
        before = world.bulb('bulb_a', 0)
        world.apply(service('light.turn_off', 'light.ls_profile_x'), 0)
        self.assertEqual(world.bulb('bulb_a', 0), before)

    def test_switch_turn_on_and_off(self):
        world = make_world()
        world.apply(service('switch.turn_on', 'switch.plug_x'), 0)
        self.assertEqual(world.switch('switch.plug_x'), 'on')
        world.apply(service('switch.turn_off', ['switch.plug_x']), 1)
        self.assertEqual(world.switch('switch.plug_x'), 'off')

    def test_switch_button_flips_power(self):
        world = make_world()
        start = world.switch('switch.plug_x')
        world.press_switch_button('switch.plug_x')
        self.assertNotEqual(world.switch('switch.plug_x'), start)
        world.press_switch_button('switch.plug_x')
        self.assertEqual(world.switch('switch.plug_x'), start)

    def test_other_actions_are_not_world_state(self):
        world = make_world()
        before = world.ha_states(0)
        for action in ('variable.update_sensor', 'script.turn_on', 'event.fire'):
            world.apply({'time': 0, 'action': action, 'target': {'entity_id': 'sensor.x'}, 'data': {'a': 1}}, 0)
        world.apply({'time': 0, 'action': 'mqtt.publish', 'target': {},
                     'data': {'topic': 'house/v1/other', 'payload': '{}'}}, 0)
        self.assertEqual(world.ha_states(0), before)


class HomeAssistantStates(unittest.TestCase):
    def test_states_report_lights_and_switches(self):
        world = make_world()
        world.apply(publish('bulb_a', {'state': 'ON', 'brightness': 120, 'color_temp': 400}), 0)
        world.apply(publish('bulb_b', {'state': 'OFF'}), 0)
        states = world.ha_states(0)
        self.assertEqual(states['light.lamp_a']['state'], 'on')
        self.assertEqual(states['light.lamp_a']['attributes']['brightness'], 120)
        self.assertEqual(states['light.lamp_a']['attributes']['color_temp_kelvin'], 2500)
        self.assertEqual(states['light.group_ab']['state'], 'on')
        self.assertEqual(states['switch.plug_x']['state'], 'off')
        world.apply(publish('bulb_a', {'state': 'OFF'}), 1)
        self.assertEqual(world.ha_states(1)['light.group_ab']['state'], 'off')


class Refusals(unittest.TestCase):
    def test_unknown_payload_key_raises(self):
        with self.assertRaises(UnhandledPayload):
            make_world().apply(publish('bulb_a', {'state': 'ON', 'flash': 'short'}), 0)

    def test_unknown_effect_raises(self):
        with self.assertRaises(UnhandledPayload):
            make_world().apply(publish('bulb_a', {'effect': 'breathe'}), 0)

    def test_unknown_topic_raises(self):
        with self.assertRaises(UnknownTarget):
            make_world().apply(publish('bulb_z', {'state': 'ON'}), 0)

    def test_unknown_light_entity_raises(self):
        with self.assertRaises(UnknownTarget):
            make_world().apply(service('light.turn_on', 'light.lamp_z'), 0)

    def test_unknown_switch_entity_raises(self):
        with self.assertRaises(UnknownTarget):
            make_world().apply(service('switch.turn_on', 'switch.plug_z'), 0)

    def test_rejected_payload_changes_nothing(self):
        world = make_world()
        before = world.bulb('bulb_a', 0)
        with self.assertRaises(UnhandledPayload):
            world.apply(publish('bulb_a', {'brightness': 5, 'flash': 'short'}), 0)
        self.assertEqual(world.bulb('bulb_a', 0), before)


class FromSim(unittest.TestCase):
    def stub(self):
        catalog = {
            'members': {'light.lamp_a': ['light.bulb_a'], 'light.lamp_ab': ['light.bulb_a', 'light.bulb_b']},
            'groups': {'light.group_x': ['light.lamp_a', 'light.lamp_ab']},
            'topics': {'light.bulb_a': 'zigbee2mqtt/addr_a/set', 'light.bulb_b': 'zigbee2mqtt/Name B/set'},
            'multicast': [
                {'id': 'fx_x', 'topic': 'zigbee2mqtt/group/ab/set', 'phase_cohort': 'fx_x',
                 'member_topics': {'light.bulb_a': 'zigbee2mqtt/addr_a/set',
                                   'light.bulb_b': 'zigbee2mqtt/Name B/set'}}],
        }
        state = {
            'light.group_x': {'attributes': {'entity_id': ['light.lamp_a', 'light.lamp_ab']}},
            'light.lamp_a': {'attributes': {}},
            'light.ls_profile_x': {'attributes': {}},
            'switch.plug_x': {'attributes': {}},
            'switch.ls_lamp_x_day_override': {'attributes': {}},
            'switch.zigbee2mqtt_bridge_permit_join': {'attributes': {}},
        }
        return SimpleNamespace(run=lambda name: catalog, members=list(catalog['members']), state=state)

    def test_membership_from_the_catalog(self):
        world = World.from_sim(self.stub())
        world.apply(publish('group/ab', {'state': 'ON', 'brightness': 10}), 0)
        world.apply(publish('addr_a', {'brightness': 20}), 0)
        world.apply(publish('Name B', {'brightness': 30}), 0)
        self.assertEqual(world.bulb('addr_a', 0).level, 20)
        self.assertEqual(world.bulb('Name B', 0).level, 30)
        world.apply(service('light.turn_off', 'light.group_x'), 1)
        self.assertEqual(world.bulb('addr_a', 1), Off())
        self.assertEqual(world.bulb('Name B', 1), Off())

    def test_lamps_expand_to_their_bulbs(self):
        world = World.from_sim(self.stub())
        world.apply(service('light.turn_on', 'light.lamp_ab', {'brightness': 44}), 0)
        self.assertEqual((world.bulb('addr_a', 0).level, world.bulb('Name B', 0).level), (44, 44))

    def test_plugs_are_switches_but_profile_and_bridge_switches_are_not(self):
        world = World.from_sim(self.stub())
        world.apply(service('switch.turn_on', 'switch.plug_x'), 0)
        self.assertEqual(world.switch('switch.plug_x'), 'on')
        with self.assertRaises(UnknownTarget):
            world.apply(service('switch.turn_on', 'switch.zigbee2mqtt_bridge_permit_join'), 0)

    def test_candle_capability_from_catalog_cohorts(self):
        catalog_world = World.from_sim(self.stub())
        self.assertTrue(catalog_world._bulbs['addr_a'].candle_capable)

    @unittest.skipUnless(env.reference_available(), 'private reference not present')
    def test_reference_catalog_builds_a_world(self):
        with env.open_sim('reference') as sim:
            world = World.from_sim(sim)
            catalog = sim.run('effects_catalog')
            self.assertEqual(len(world._bulbs), len(set(catalog['topics'].values())))
            for lamp, ends in catalog['members'].items():
                self.assertEqual(len(world._ha_lights[lamp]), len(ends))
            for group in catalog['multicast']:
                stem = group['topic'].removeprefix('zigbee2mqtt/').removesuffix('/set')
                self.assertEqual(len(world._groups[stem]), len(group['member_topics']))


if __name__ == '__main__':
    unittest.main()
