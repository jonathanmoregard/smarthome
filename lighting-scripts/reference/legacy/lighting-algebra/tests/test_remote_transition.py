"""Remote-only fade cap through the actual writer, engine and dispatcher."""
import copy
import json
import unittest

from dry_harness import RUNTIME, DrySim


class RemoteTransitionTests(unittest.TestCase):
    def sim(self):
        sim = DrySim()
        sim.put('input_boolean.ls_ovr_next_block_on', 'off')
        sim.store('input_text.ls_house_day', {'on': True, 'b': 230, 'm': 'ct', 'k': 4100})
        sim.store('input_text.ls_house_cosy', {'on': True, 'b': 110, 'm': 'ct', 'k': 2200})
        return sim

    def gradients(self, sim):
        if 'ls_commit' not in sim.config:
            return sim.attr(RUNTIME, 'gradients')
        curves = {}
        for room in set(sim.areas.values()):
            curves.update((sim.attr('sensor.ls_cache_' + room, 'cache') or {}).get('gradients', {}))
        return curves

    def engine(self, sim, identifier='config', entity='sensor.ls_overrides'):
        trigger = {'id': identifier, 'entity_id': entity}
        if entity:
            trigger['to_state'] = sim.states[entity]
        if 'ls_commit' not in sim.config or entity != 'sensor.ls_overrides':
            sim.run_automation('automation_lighting_schedule_engine', trigger)
        sim.drain_output()

    def payloads(self, sim):
        return [json.loads(call['data']['payload']) for call in sim.calls
                if call['action'] == 'mqtt.publish' and call['data']['topic'].startswith('zigbee2mqtt/')]

    def assert_only_living_room(self, sim):
        targets = [call['data']['targets'] for call in sim.calls
                   if call['action'] == 'script.effects_frame_plan']
        lamps = set().union(*(set(batch) for batch in targets))
        self.assertTrue(lamps)
        self.assertTrue(all(sim.areas[lamp] == 'living_room' for lamp in lamps))

    def test_remote_up_and_reset_use_cap_without_resending_other_rooms_or_rebuilding_cache(self):
        sim = self.sim()
        sim.apply( reason='config')
        gradients = copy.deepcopy(self.gradients(sim))
        self.assertTrue(gradients)
        baseline = copy.deepcopy(sim.attr(RUNTIME, 'targets'))
        sim.advance(.01)
        sim.run('ls_remote_command', source='offline-cap', area='living_room', command='up')
        self.assertEqual(sim.attr('sensor.ls_overrides', 'last_via'), 'remote')
        sim.calls.clear()
        self.engine(sim)
        self.assert_only_living_room(sim)
        self.assertTrue(self.payloads(sim))
        self.assertEqual({p['transition'] for p in self.payloads(sim)}, {.2})
        self.assertEqual(self.gradients(sim), gradients)
        sim.advance(.01)
        sim.run('ls_remote_command', source='offline-cap', area='living_room', command='reset')
        sim.calls.clear()
        self.engine(sim)
        self.assert_only_living_room(sim)
        self.assertTrue(self.payloads(sim))
        self.assertEqual({p['transition'] for p in self.payloads(sim)}, {.5})
        self.assertEqual(self.gradients(sim), gradients)
        self.assertEqual(sim.attr(RUNTIME, 'targets'), baseline)
        sim.calls.clear()
        sim.apply( reason='config')
        self.assertEqual(self.payloads(sim), [])

    def test_stale_remote_origin_does_not_cap_a_later_profile_edit(self):
        sim = self.sim()
        sim.run('ls_remote_command', source='offline-cap', area='living_room', command='reset')
        self.assertEqual(sim.attr('sensor.ls_overrides', 'last_via'), 'remote')
        sim.drain_output()
        sim.advance(.01)
        sim.store('input_text.ls_house_day', {'on': True, 'b': 220, 'm': 'ct', 'k': 4000})
        sim.calls.clear()
        self.engine(sim, entity='input_text.ls_house_day')
        self.assertTrue(self.payloads(sim))
        self.assertEqual({p['transition'] for p in self.payloads(sim)}, {3})

    def test_scheduled_tick_fade_stays_sixty_seconds_after_remote_origin(self):
        sim = self.sim()
        sim.run('ls_remote_command', source='offline-cap', area='living_room', command='reset')
        sim.drain_output()
        sim.now = sim.now.replace(hour=17, minute=50)
        sim.calls.clear()
        self.engine(sim, identifier='tick', entity=None)
        self.assertTrue(self.payloads(sim))
        self.assertEqual({p['transition'] for p in self.payloads(sim)}, {60})

    def test_cap_preserves_existing_short_effect_transition(self):
        sim = self.sim()
        sim.run('effects_set', source='light.kitchen_pendant', attribute='effect', value='Candle')
        plan = sim.pure('ls_plan')['plan']
        targets = {'light.kitchen_pendant': plan['resolved']['targets']['light.kitchen_pendant']}
        catalog = sim.pure('effects_catalog')
        normal = sim.pure('effects_frame_plan', targets=targets, catalog=catalog, timestamp=123456)
        capped = sim.pure('effects_frame_plan', targets=targets, catalog=catalog, timestamp=123456,
                          transition_cap=.5)
        self.assertTrue(normal['commands'])
        self.assertEqual(capped, normal)
        self.assertTrue(all(command['payload']['transition'] <= .5 for command in capped['commands']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
