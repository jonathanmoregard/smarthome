"""Actual frame composition and paced output, entirely against memory sinks."""
import copy
import json
import unittest

from dry_harness import RUNTIME, DrySim, check_traffic

LAMP = 'light.kitchen_pendant'
OTHER = 'light.living_room_hall_ceiling'


def source(effect='Candle', channel='brightness', intensity=180):
    return {'kind': 'effect', 'effect': effect, 'instance': 'shared:' + effect,
            'updated': 1, 'intensity': intensity,
            'base': intensity if channel == 'brightness' else {'rgb': [255, 134, 7]}}


def target(brightness=None, color=None):
    return {'on': True, 'brightness': brightness or source(),
            'color': color or source(channel='color')}


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.sim = DrySim()
        self.catalog = self.sim.run('effects_catalog')
        self.catalog['multicast'] = []
        for owner in [LAMP, OTHER]:
            self.sim.put(owner, 'on')
            for entity in self.catalog['members'][owner]:
                self.sim.put(entity, 'on')
        self.targets = {LAMP: target(), OTHER: target()}
        self.revision = self.sim.states['sensor.ls_overrides'].last_updated.isoformat()
        self.generation = 'offline-generation'
        self.sim.put(RUNTIME, '2',
                     {'revision': self.revision, 'generation': self.generation,
                      'targets': self.targets, 'assignments': self.targets})
        self.sim.calls.clear()

    def plan(self, timestamp=1_000_000, targets=None):
        return self.sim.pure('effects_frame_plan', targets=targets or self.targets,
                             catalog=self.catalog, timestamp=timestamp)

    def emit(self, commands, revision=None, generation=None):
        self.sim.run('effects_emit', commands=commands,
                     revision=revision or self.revision,
                     generation=generation or self.generation)
        return [call for call in self.sim.calls if call['action'] == 'mqtt.publish'
                and call['data']['topic'].startswith('zigbee2mqtt/')]

    def multicast(self):
        members = self.catalog['members'][LAMP] + self.catalog['members'][OTHER]
        group = {'id': 'offline-cross-room', 'topic': 'zigbee2mqtt/offline-cross-room/set',
                 'members': members, 'verified': True}
        self.catalog['multicast'] = [group]
        self.catalog['phases'][LAMP] = self.catalog['phases'][OTHER] = 'shared-fixture-phase'
        return group

    def test_one_candle_sample_per_lamp_not_per_bulb_or_channel(self):
        result = self.plan(targets={LAMP: target()})
        render_calls = [call for call in self.sim.calls
                        if call['action'] == 'script.effect_candle_frame']
        self.assertEqual(len(render_calls), 1)
        payloads = [command['payload'] for command in result['commands']]
        self.assertEqual(len(payloads), len(self.catalog['members'][LAMP]))
        self.assertTrue(all(payload == payloads[0] for payload in payloads))

    def test_constant_colour_overrides_candle_colour_but_keeps_flicker(self):
        targets = {LAMP: target(color={'kind': 'constant', 'value': {'rgb': [255, 105, 180]}})}
        levels = []
        for index in range(40):
            commands = self.plan(timestamp=1_000_000 + index * 0.15, targets=targets)['commands']
            for command in commands:
                self.assertEqual(command['payload']['color']['rgb'], '255,105,180')
            levels.append(commands[0]['payload']['brightness'])
        self.assertGreater(len(set(levels)), 1)

    def test_colour_effect_does_not_take_constant_brightness(self):
        targets = {LAMP: target(brightness={'kind': 'constant', 'value': 64},
                                color=source('Colour loop', 'color'))}
        colours = []
        for index in range(8):
            commands = self.plan(timestamp=1_000_000 + index, targets=targets)['commands']
            self.assertTrue(all(command['payload']['brightness'] == 64 for command in commands))
            colours.append(commands[0]['payload']['color']['rgb'])
        self.assertGreater(len(set(colours)), 1)

    def test_compatible_cross_room_lamps_share_one_multicast(self):
        group = self.multicast()
        commands = self.plan()['commands']
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0]['topic'], group['topic'])
        self.assertEqual(set(commands[0]['members']), set(group['members']))

    def test_different_resolved_brightness_prevents_multicast(self):
        group = self.multicast()
        self.targets[OTHER] = target(brightness={'kind': 'constant', 'value': 12})
        commands = self.plan()['commands']
        self.assertFalse(any(command['topic'] == group['topic'] for command in commands))
        payload = next(command['payload'] for command in commands if OTHER in command['owners'])
        self.assertEqual(payload['brightness'], 12)

    def test_off_endpoint_is_excluded_before_group_selection(self):
        group = self.multicast()
        excluded = self.catalog['members'][LAMP][0]
        self.sim.put(excluded, 'off')
        commands = self.plan()['commands']
        covered = [entity for command in commands for entity in command['members']]
        self.assertNotIn(excluded, covered)
        self.assertEqual(set(covered), set(group['members']) - {excluded})
        self.assertFalse(any(command['topic'] == group['topic'] for command in commands))
        sent = self.emit(commands)
        self.assertEqual(len(sent), len(covered))

    def test_unavailable_endpoint_does_not_starve_healthy_lamp_members(self):
        excluded = self.catalog['members'][LAMP][0]
        self.sim.put(excluded, 'unavailable')
        commands = self.plan(targets={LAMP: target()})['commands']
        covered = [entity for command in commands for entity in command['members']]
        self.assertEqual(set(covered), set(self.catalog['members'][LAMP]) - {excluded})

    def test_stale_generation_and_revision_emit_nothing(self):
        commands = self.plan()['commands']
        self.assertEqual(self.emit(commands, generation='stale-generation'), [])
        self.assertEqual(self.emit(commands, revision='stale-revision'), [])

    def test_ownership_revision_change_discards_remaining_batch(self):
        commands = self.plan()['commands']
        self.sim.on_publish = lambda sim: (sim.advance(.001), sim.put('sensor.ls_overrides', 'changed', {'overrides': {}}))
        sent = self.emit(commands)
        self.assertEqual(len(sent), 1)

    def test_room_power_off_prevents_effect_output(self):
        self.sim.put('sensor.ls_overrides', '0', {'overrides': {}, 'power': {'kitchen': False}})
        commands = self.plan(targets={LAMP: target()})['commands']
        self.assertEqual(self.emit(commands), [])

    def test_power_off_between_plan_and_emit_invalidates_group(self):
        self.multicast()
        commands = self.plan()['commands']
        self.sim.put(self.catalog['members'][LAMP][0], 'off')
        self.assertEqual(self.emit(commands), [])

    def test_bridge_disconnect_stops_remaining_batch(self):
        commands = self.plan()['commands']
        self.sim.on_publish = lambda sim: sim.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'off')
        self.assertEqual(len(self.emit(commands)), 1)

    def test_manual_sender_has_no_sleep_while_animation_budget_stays_at_producer(self):
        commands = self.plan()['commands']
        self.emit(commands)
        self.emit(commands)
        immediate = 'ls_commit' in self.sim.config
        sends = check_traffic(self.sim.calls, None if immediate else 5)
        self.assertEqual(len(sends), 2 * len(commands))
        if immediate:
            self.assertEqual(self.sim.elapsed, 0)

    def test_engine_uses_bounded_shared_transport(self):
        self.sim.calls.clear()
        self.sim.bounded_engine(seconds=3)
        sends = check_traffic(self.sim.calls, 5)
        self.assertGreater(len(sends), 1)
        for send in sends:
            payload = json.loads(send['data']['payload'])
            self.assertNotIn('state', payload)
            self.assertNotIn('effect', payload)


if __name__ == '__main__':
    unittest.main(verbosity=2)
