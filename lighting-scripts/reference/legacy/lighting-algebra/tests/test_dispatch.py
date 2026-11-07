"""Pure input planning and versioned delta dispatch, using actual scripts."""
import copy
import json
import unittest

from dry_harness import RUNTIME, DrySim


class DispatchTests(unittest.TestCase):
    def device_sends(self, sim):
        return [call for call in sim.calls if call['action'] == 'mqtt.publish'
                and call['data']['topic'].startswith('zigbee2mqtt/')]

    def test_input_planners_do_not_enter_or_wait_for_output_scripts(self):
        for entry, args in [
            ('ls_plan', {'room': 'living_room'}),
            ('ls_remote_command', {'source': 'offline-remote', 'area': 'living_room', 'command': 'up', 'dry_run': True}),
            ('effects_set', {'source': 'light.living_room', 'attribute': 'effect', 'value': 'Candle', 'dry_run': True}),
        ]:
            with self.subTest(entry=entry):
                sim = DrySim()
                # Represent an actuator already occupied. Any route into these
                # scripts fails immediately instead of simulating a fake queue.
                sim.put('script.ls_dispatch', 'on')
                sim.put('script.effects_engine', 'on')
                service = sim.service
                def guarded(action, target, data):
                    self.assertNotIn(action, ['script.ls_apply', 'script.ls_dispatch',
                                             'script.effects_assign', 'script.effects_emit',
                                             'script.effects_frame_plan'])
                    return service(action, target, data)
                sim.service = guarded
                elapsed = sim.elapsed
                sim.pure(entry, **args)
                self.assertEqual(sim.elapsed, elapsed)

    def test_room_only_plan_matches_full_plan_without_materializing_lamps(self):
        sim = DrySim()
        sim.run('effects_set', source='light.living_room', attribute='brightness', value=211)
        sim.advance(1)
        sim.run('effects_set', source='light.living_room', attribute='effect', value='Candle')
        full = sim.pure('ls_plan')['plan']['resolved']['targets']
        for area in ['living_room', 'kitchen', 'jonathan_bedroom']:
            with self.subTest(area=area):
                plan = sim.pure('ls_plan', room=area)['plan']
                self.assertEqual(set(plan['resolved']['targets']), {'room:' + area})
                self.assertEqual(plan['resolved']['targets']['room:' + area], full['room:' + area])
                self.assertEqual(set(plan['base']), {'room:' + area})

    def test_repeating_identical_configuration_sends_no_ordinary_commands(self):
        sim = DrySim()
        sim.apply( reason='config')
        self.assertTrue(self.device_sends(sim))
        sim.calls.clear()
        sim.apply( reason='config')
        self.assertEqual(self.device_sends(sim), [])

    def test_room_input_does_not_resend_unchanged_other_rooms(self):
        sim = DrySim()
        sim.apply( reason='config')
        sim.advance(1)
        sim.run('effects_set', source='light.living_room', attribute='brightness', value=211)
        sim.calls.clear()
        sim.apply( reason='config')
        batches = [call['data']['targets'] for call in sim.calls
                   if call['action'] == 'script.effects_frame_plan']
        self.assertTrue(any(batches))
        self.assertTrue(all(sim.areas[lamp] == 'living_room' for batch in batches for lamp in batch))
        catalog = sim.run('effects_catalog')
        endpoint_rooms = {endpoint: sim.areas[lamp] for lamp, members in catalog['members'].items()
                          for endpoint in members}
        topic_members = {topic: [endpoint] for endpoint, topic in catalog['topics'].items()}
        topic_members.update({group['topic']: group['members'] for group in catalog['multicast']})
        for call in self.device_sends(sim):
            self.assertTrue(all(endpoint_rooms[endpoint] == 'living_room'
                                for endpoint in topic_members[call['data']['topic']]))
            self.assertEqual(json.loads(call['data']['payload']).get('transition'), .2)

    def test_explicit_lamp_on_resends_selected_lamp_after_identical_resolution(self):
        sim = DrySim()
        lamp = 'light.kitchen_pendant'
        sim.apply( reason='config')
        sim.calls.clear()
        sim.apply( reason='lamp_on', lights=[lamp])
        batches = [call['data']['targets'] for call in sim.calls
                   if call['action'] == 'script.effects_frame_plan']
        self.assertEqual(set().union(*(set(batch) for batch in batches)), {lamp})
        self.assertTrue(self.device_sends(sim))

    def test_burst_then_reset_rejects_all_queued_old_plans_without_replay(self):
        sim = DrySim()
        sim.apply( reason='config')
        pending = []
        for command in ['up', 'up', 'up', 'down']:
            sim.advance(.1)
            sim.run('ls_remote_command', source='offline-remote', area='living_room', command=command)
            pending.append(sim.pure('ls_plan')['plan'])
        sim.advance(.1)
        sim.run('ls_remote_command', source='offline-remote', area='living_room', command='reset')
        for plan in pending:
            sim.pure('ls_dispatch', plan=plan, lights=[])
        sim.calls.clear()
        sim.apply( reason='config')
        self.assertEqual(self.device_sends(sim), [])
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides'), {})
        self.assertTrue(all(owner == 'base' for target in sim.attr(RUNTIME, 'targets').values()
                            for owner in target['owners'].values()))

    def test_newest_plan_can_run_before_old_queue_entries_without_rollback(self):
        sim = DrySim()
        sim.advance(1)
        sim.run('ls_remote_command', source='offline-remote', area='living_room', command='up')
        stale = sim.pure('ls_plan')['plan']
        sim.advance(1)
        sim.run('ls_remote_command', source='offline-remote', area='living_room', command='up')
        latest = sim.pure('ls_plan')['plan']
        sim.run('ls_dispatch', plan=latest, lights=[])
        controller = copy.deepcopy(sim.state[RUNTIME])
        sim.pure('ls_dispatch', plan=stale, lights=[])
        self.assertEqual(sim.state[RUNTIME], controller)

    def test_newer_saved_profile_plan_wins_even_with_same_override_revision(self):
        sim = DrySim()
        older = sim.pure('ls_plan')['plan']
        sim.advance(.01)
        sim.store('input_text.ls_house_day', {'on': True, 'b': 220, 'm': 'ct', 'k': 3000})
        newer = sim.pure('ls_plan')['plan']
        self.assertEqual(older['revision'], newer['revision'])
        self.assertGreater(newer['plan_order'], older['plan_order'])
        sim.run('ls_dispatch', plan=newer, lights=[])
        controller = copy.deepcopy(sim.state[RUNTIME])
        sim.pure('ls_dispatch', plan=older, lights=[])
        self.assertEqual(sim.state[RUNTIME], controller)
        self.assertEqual(sim.attr(RUNTIME, 'targets')['room:living_room']['level'], 220)

    def test_effect_release_resends_prior_constant_before_becoming_silent(self):
        sim = DrySim()
        lamp = 'light.living_room_hall_ceiling'
        sim.apply( reason='config')
        baseline = copy.deepcopy(sim.attr(RUNTIME, 'applied')[lamp])
        sim.advance(1)
        sim.run('effects_set', source=lamp, attribute='effect', value='Candle')
        sim.apply( reason='config')
        self.assertIn(lamp, sim.attr(RUNTIME, 'assignments'))
        if 'ls_commit' in sim.config:
            self.assertEqual(sim.attr(RUNTIME, 'applied')[lamp], sim.attr(RUNTIME, 'targets')[lamp])
        else:
            self.assertEqual(sim.attr(RUNTIME, 'applied')[lamp], baseline)
        sim.advance(1)
        sim.run('ls_remote_command', source='offline-remote', area='living_room', command='reset')
        sim.calls.clear()
        sim.apply( reason='config')
        batches = [call['data']['targets'] for call in sim.calls
                   if call['action'] == 'script.effects_frame_plan']
        self.assertEqual(set().union(*(set(batch) for batch in batches)), {lamp})
        self.assertEqual(sim.attr(RUNTIME, 'applied')[lamp], baseline)
        self.assertTrue(self.device_sends(sim))
        self.assertTrue(all(json.loads(call['data']['payload'])['brightness'] == baseline['brightness']['value']
                            for call in self.device_sends(sim)))
        sim.calls.clear()
        sim.apply( reason='config')
        self.assertEqual(self.device_sends(sim), [])

    def test_cancelled_batch_keeps_unapplied_targets_and_same_plan_retries(self):
        sim = DrySim()
        sim.apply( reason='config')
        before = copy.deepcopy(sim.attr(RUNTIME, 'applied'))
        sim.advance(1)
        sim.run('effects_set', source='light.living_room', attribute='brightness', value=211)
        plan = sim.pure('ls_plan')['plan']
        sim.calls.clear()
        def lose_bridge(current):
            current.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'off')
        sim.on_publish = lose_bridge
        sim.run('ls_dispatch', plan=plan, lights=[])
        self.assertEqual(len(self.device_sends(sim)), 1)
        remaining = sim.attr(RUNTIME, 'applied')
        changed = {lamp for lamp in before if lamp in sim.members and sim.areas[lamp] == 'living_room'}
        self.assertTrue(changed.isdisjoint(remaining))
        self.assertEqual(remaining, {lamp: value for lamp, value in before.items() if lamp not in changed})
        self.assertNotEqual(sim.attr(RUNTIME, 'targets'), before)
        sim.on_publish = None
        sim.put('binary_sensor.zigbee2mqtt_bridge_connection_state', 'on')
        sim.calls.clear()
        sim.run('ls_dispatch', plan=plan, lights=[])
        batches = [call['data']['targets'] for call in sim.calls
                   if call['action'] == 'script.effects_frame_plan']
        retried = set().union(*(set(batch) for batch in batches))
        expected = {lamp for lamp in plan['resolved']['targets']
                    if lamp in sim.members and sim.areas[lamp] == 'living_room'}
        self.assertEqual(retried, expected)
        self.assertTrue(self.device_sends(sim))
        applied = sim.attr(RUNTIME, 'applied')
        self.assertTrue(all(applied[lamp] == plan['resolved']['targets'][lamp] for lamp in expected))
        sim.calls.clear()
        sim.run('ls_dispatch', plan=plan, lights=[])
        self.assertEqual(self.device_sends(sim), [])

    def test_partial_output_then_reset_restores_touched_lamp_even_at_old_cached_value(self):
        sim = DrySim()
        lamp = 'light.kitchen_pendant'
        sim.apply( reason='config')
        baseline = copy.deepcopy(sim.attr(RUNTIME, 'applied')[lamp])
        sim.advance(1)
        sim.run('effects_set', source=lamp, attribute='brightness', value=211)
        pending = sim.pure('ls_plan')['plan']
        interrupted = []
        def reset_after_first_send(current):
            if interrupted:
                return
            interrupted.append(True)
            current.advance(.01)
            current.event('ls_override', {'op': 'clear_room', 'area': 'kitchen'})
        sim.on_publish = reset_after_first_send
        sim.calls.clear()
        sim.run('ls_dispatch', plan=pending, lights=[])
        sent = self.device_sends(sim)
        self.assertEqual(len(sent), 1)
        self.assertEqual(json.loads(sent[0]['data']['payload'])['brightness'], 211)
        self.assertNotIn(lamp, sim.attr(RUNTIME, 'applied'))
        sim.on_publish = None
        sim.calls.clear()
        sim.apply( reason='config')
        batches = [call['data']['targets'] for call in sim.calls
                   if call['action'] == 'script.effects_frame_plan']
        self.assertEqual(set().union(*(set(batch) for batch in batches)), {lamp})
        sent = self.device_sends(sim)
        self.assertTrue(sent)  # A verified whole-lamp group may carry all three bulbs.
        self.assertTrue(all(json.loads(call['data']['payload'])['brightness'] == baseline['brightness']['value']
                            for call in sent))
        self.assertEqual(sim.attr(RUNTIME, 'applied')[lamp], baseline)

    def test_changed_revision_during_output_cannot_clear_refreshed_override(self):
        sim = DrySim()
        sim.now = sim.now.replace(hour=18, minute=5)
        sim.put('input_boolean.ls_ovr_next_block_on', 'on')
        key = 'channels:offline-room'
        old = {'kind': 'channels', 'scope': 'room', 'target': 'living_room',
               'when': '2026-10-23T17:00:00+02:00', 'value': {'channels': {}}}
        sim.put('sensor.ls_overrides', '1', {'overrides': {key: old}})
        plan = sim.pure('ls_plan')['plan']
        self.assertIn(key, plan['stale_keys'])
        seen = []
        def update_during_output(current):
            if seen:
                return
            seen.append(True)
            current.advance(.01)
            current.event('ls_override', {'op': 'set', 'records': [{
                'kind': 'channels', 'key': key, 'source': 'offline-room',
                'scope': 'room', 'target': 'living_room',
                'value': {'channels': {'brightness': {'kind': 'constant', 'value': 222,
                          'updated': current.now.timestamp()}}}}]})
        sim.on_publish = update_during_output
        sim.run('ls_dispatch', plan=plan, lights=[])
        self.assertTrue(seen)
        self.assertIn(key, sim.attr('sensor.ls_overrides', 'overrides'),
                      'stale expiry deleted a record refreshed during output')
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides')[key]['value']['channels']['brightness']['value'], 222)

    def test_changed_revision_during_mirroring_cannot_clear_refreshed_override(self):
        sim = DrySim()
        sim.now = sim.now.replace(hour=18, minute=5)
        sim.put('input_boolean.ls_ovr_next_block_on', 'on')
        key = 'channels:offline-room'
        old = {'kind': 'channels', 'scope': 'room', 'target': 'living_room',
               'when': '2026-10-23T17:00:00+02:00', 'value': {'channels': {}}}
        sim.put('sensor.ls_overrides', '1', {'overrides': {key: old}})
        plan = sim.pure('ls_plan')['plan']
        self.assertIn(key, plan['stale_keys'])
        seen = []
        def update_during_output(current):
            if seen:
                return
            seen.append(True)
            current.advance(.01)
            current.event('ls_override', {'op': 'set', 'records': [{
                'kind': 'channels', 'key': key, 'source': 'offline-room',
                'scope': 'room', 'target': 'living_room',
                'value': {'channels': {'brightness': {'kind': 'constant', 'value': 222,
                          'updated': current.now.timestamp()}}}}]})
        service = sim.service
        def update_during_mirror(action, target, data):
            if action in ['input_select.select_option', 'input_boolean.turn_on', 'input_boolean.turn_off']:
                update_during_output(sim)
            return service(action, target, data)
        sim.service = update_during_mirror
        sim.run('ls_dispatch', plan=plan, lights=[])
        self.assertTrue(seen)
        self.assertIn(key, sim.attr('sensor.ls_overrides', 'overrides'),
                      'stale expiry deleted a record refreshed during output')
        self.assertEqual(sim.attr('sensor.ls_overrides', 'overrides')[key]['value']['channels']['brightness']['value'], 222)


if __name__ == '__main__':
    unittest.main(verbosity=2)
