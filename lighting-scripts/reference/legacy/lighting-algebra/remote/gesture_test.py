"""Replay native adapter actions offline with clocks and local service sinks."""
import copy
import json
import sys
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, '/tmp/lighting-algebra/tests')
from dry_harness import DrySim, End

ROOT = Path(__file__).parent
REMOTES = {
    'bedroom': ('0x385b44fffea4fc67', '0e973e9202acb5ace9a8e6a8b336891d', 'jonathan_bedroom'),
    'living_room': ('0x385b44fffea50c99', '0752f2b4e9a0992ac8efc2af1f53c62a', 'living_room'),
}
PRESETS = [200, 285, 370, 454, 588]


def power(at, room='bedroom', payload='on'):
    return {'time': at, 'topic': 'zigbee2mqtt/' + REMOTES[room][0] + '/action', 'payload': payload}


def arrow(at, value, room='bedroom', action='color_temperature_move'):
    return {'time': at, 'topic': 'zigbee2mqtt/' + REMOTES[room][0],
            'payload_json': {'action': action, 'action_color_temperature': value}}


def direction(at, direction, room='bedroom'):
    return power(at, room, 'brightness_step_' + direction)


def brightness(at, value, room='bedroom'):
    return {'time': at, 'topic': 'zigbee2mqtt/' + REMOTES[room][0],
            'payload_json': {'action': 'brightness_move_to_level', 'action_level': value}}


def chord(at=0, room='bedroom', gap=.02):
    return [power(at, room), power(at + .1, room),
            *[arrow(at + .1 + gap * (i + 1), value, room) for i, value in enumerate([588, 200, 588, 200])]]


class Replay(DrySim):
    def __init__(self, events=(), defer_commands=False):
        super().__init__()
        self.pending = sorted(copy.deepcopy(events), key=lambda e: e['time'])
        self.commands = []
        self.timers = {}
        self.debounces = {}
        self.sara = False
        self.sara_states = []
        self.pending_commands = []
        self.defer_commands = defer_commands
        for name, (_, device, area) in REMOTES.items():
            self.areas[device] = area
            script = 'ls_remote_gesture_' + name
            self.config[script] = json.loads((ROOT / (script + '.json')).read_text())
            debounce='ls_remote_power_quiet_'+name
            self.config[debounce]=json.loads((ROOT/(debounce+'.json')).read_text())
            for kind in ['center', 'directions', 'presets']:
                self.automations[kind + '_' + name] = json.loads((ROOT / ('gesture_' + kind + '_' + name + '.json')).read_text())
            self.put('input_number.ls_' + name + '_remote_chord_step', '0')
            self.put('input_number.ls_' + name + '_remote_preset', '4')
            self.put('timer.ls_' + name + '_remote_chord', 'idle', {})
            self.put('input_text.ls_' + name + '_remote_power_token', '')
            self.put('input_number.ls_' + name + '_remote_power_count', '0')

    def cond(self, value, context):
        if isinstance(value, dict) and value.get('condition') == 'template':
            rendered = self.render(value['value_template'], context)
            assert isinstance(rendered, bool), ('HA condition must return boolean', value, rendered)
        return super().cond(value, context)

    def advance(self, seconds=1):
        super().advance(seconds)

    def execute_intent(self, data):
        if data['command'] == 'sara_toggle':
            self.sara = not self.sara
            self.sara_states.append(self.sara)

    def flush_commands(self):
        while self.pending_commands:
            self.execute_intent(self.pending_commands.pop(0))

    def service(self, action, target, data):
        if action.startswith('script.ls_remote_gesture_'):
            return self.run(action.removeprefix('script.'), **data)
        if action == 'script.turn_on':
            variables=copy.deepcopy(data['variables'])
            entity=target['entity_id']
            if entity=='script.ls_remote_command':
                self.commands.append({'time': self.elapsed, **variables})
                self.pending_commands.append(variables)
            elif entity.startswith('script.ls_remote_power_quiet_'):
                cfg=self.config[entity.removeprefix('script.')]
                assert cfg['mode']=='restart' and cfg['sequence'][0]=={'delay':{'milliseconds':400}}
                self.debounces[entity]=(self.elapsed+.4,variables['token'])
            elif entity.startswith('script.ls_remote_gesture_'):
                self.run(entity.removeprefix('script.'),**variables)
            else:raise AssertionError(('unexpected async script',entity))
        elif action in ['input_number.set_value','input_text.set_value']:
            self.put(target['entity_id'], data['value'])
        elif action == 'timer.start':
            timer = target['entity_id']
            seconds = 3
            assert data['duration']=='00:00:03'
            # Actual HA timer entities floor their start epoch to whole seconds.
            end=self.now.replace(microsecond=0)+timedelta(seconds=seconds)
            self.timers[timer] = self.elapsed + (end-self.now).total_seconds()
            self.put(timer, 'active', {'finishes_at': end.isoformat()})
        elif action == 'timer.cancel':
            self.timers.pop(target['entity_id'], None)
            self.put(target['entity_id'], 'idle', {})
        else:
            raise AssertionError(('unexpected external action', action, target, data))

    @staticmethod
    def match(event, triggers):
        return next((t for t in triggers if t['topic'] == event.get('topic')
                     and ('payload' not in t or t['payload'] == event.get('payload'))), None)

    def noncenter(self, event):
        if 'assign_area' in event:
            self.areas[REMOTES[event['remote']][1]] = event['assign_area']
            return
        for name in REMOTES:
            for kind in ['directions', 'presets']:
                key = kind + '_' + name
                trigger = self.match(event, self.automations[key]['triggers'])
                if trigger:
                    self.run_automation(key, dict(event, id=trigger.get('id')))

    def seq(self, steps, context):
        for step in steps:
            assert 'wait_for_trigger' not in step and 'wait_template' not in step and 'delay' not in step
            super().seq([step], context)

    def drive(self):
        while self.pending or self.timers or self.debounces:
            next_timer = min(self.timers, key=self.timers.get) if self.timers else None
            next_debounce=min(self.debounces,key=lambda k:self.debounces[k][0]) if self.debounces else None
            if next_debounce and (not next_timer or self.debounces[next_debounce][0]<=self.timers[next_timer]) and (not self.pending or self.debounces[next_debounce][0]<=self.pending[0]['time']):
                deadline,token=self.debounces.pop(next_debounce)
                self.advance(deadline-self.elapsed)
                self.seq(self.config[next_debounce.removeprefix('script.')]['sequence'][1:],{'token':token})
                continue
            if next_timer and (not self.pending or self.timers[next_timer] <= self.pending[0]['time']):
                deadline=self.timers.pop(next_timer)
                self.advance(deadline-self.elapsed)
                self.put(next_timer,'idle',{})
                continue
            event = self.pending.pop(0)
            self.advance(event['time'] - self.elapsed)
            self.noncenter(event)
            for name in REMOTES:
                key = 'center_' + name
                if self.match(event, self.automations[key]['triggers']):
                    self.run_automation(key, event)
        if not self.defer_commands:self.flush_commands()
        return self.commands

    def gesture(self, name, command, **fields):
        self.run('ls_remote_gesture_' + name, command=command, **fields)


class ChordTests(unittest.TestCase):
    def test_fast_secret_consumes_all_arrows_before_center_quiet_window(self):
        sim = Replay(chord())
        result = sim.drive()
        self.assertEqual([c['command'] for c in result], ['sara_toggle'])
        self.assertAlmostEqual(result[0]['time'], .18)
        self.assertEqual(sim.sara_states, [True])

    def test_repeated_secret_toggles_on_and_off(self):
        sim = Replay(chord() + chord(1))
        self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle', 'sara_toggle'])
        self.assertEqual(sim.sara_states, [True, False])

    def test_ordinary_center_semantics_preserved(self):
        for times, expected in [([0], ['toggle']), ([0, .1], []), ([0, .1, .2], ['reset']), ([0, .1, .2, .3, .4], ['reset'])]:
            result = Replay([power(t) for t in times]).drive()
            self.assertEqual([c['command'] for c in result], expected)
            if result:
                self.assertAlmostEqual(result[0]['time'], times[-1] + .4)

    def test_up_down_never_wait_and_cancel_incomplete_secret(self):
        result = Replay([power(0), direction(.05, 'up'), power(.1), direction(.12, 'down'), arrow(.15, 588)]).drive()
        self.assertEqual([c['command'] for c in result], ['up', 'down', 'left'])
        self.assertEqual([c['time'] for c in result], [.05, .12, .15])

    def test_wrong_arrow_is_normal_input_without_stale_activation(self):
        result = Replay([power(0), power(.1), arrow(.12, 588), arrow(.14, 454), arrow(.16, 588), arrow(.18, 454), arrow(.2, 588)]).drive()
        self.assertEqual([c['command'] for c in result], ['left', 'right', 'left', 'right'])

    def test_timeout_starts_normal_input_and_extends_per_matched_step(self):
        sim = Replay([power(0), power(.1), arrow(3.11, 588), arrow(3.2, 200)])
        self.assertEqual([c['command'] for c in sim.drive()], ['left', 'right'])
        sim = Replay(chord(gap=1.9))
        self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle'])

    def test_secret_state_is_per_remote(self):
        sim = Replay()
        sim.gesture('bedroom', 'power')
        sim.gesture('bedroom', 'power')
        sim.gesture('living_room', 'power')
        sim.gesture('living_room', 'power')
        sim.gesture('bedroom', 'left')
        sim.gesture('living_room', 'right')  # Wrong for this remote only.
        for command in ['right', 'left', 'right']:
            sim.gesture('bedroom', command)
        self.assertEqual([(c['source'], c['command']) for c in sim.commands],
                         [(REMOTES['living_room'][0], 'right'), (REMOTES['bedroom'][0], 'sara_toggle')])

    def test_input_between_power_presses_prevents_secret_arming(self):
        sim = Replay(chord() + [direction(.05, 'up')])
        self.assertEqual([c['command'] for c in sim.drive()], ['up', 'left', 'right', 'left', 'right'])

    def test_unknown_and_nonadjacent_presets_cancel_but_duplicates_do_not(self):
        for value in [999, 285]:
            sim = Replay([power(0), power(.1), arrow(.12, value), arrow(.14, 454)])
            self.assertNotIn('sara_toggle', [c['command'] for c in sim.drive()])
            self.assertEqual(sim.states('input_number.ls_bedroom_remote_chord_step'), '0')
        sim = Replay(chord() + [arrow(.13, 588), brightness(.15, 254)])
        self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle'])

    def test_recorded_missing_companions_still_decode_secret(self):
        events = [power(0), power(.1), brightness(.12, 2), arrow(.125, 588),
                  brightness(.14, 254), brightness(.16, 2), arrow(.165, 588), arrow(.18, 200)]
        sim = Replay(events)
        sim.put('input_number.ls_bedroom_remote_preset', '0')
        self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle'])
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_preset'), '0')
        # Labelled calibration proves the POWER pair resets hardware index 0.
        sim = Replay(events)
        sim.put('input_number.ls_bedroom_remote_preset', '1')
        self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle'])

    def test_labelled_power_pair_resets_cursor_two_before_first_arrow(self):
        for name in REMOTES:
            for family in ['temperature', 'brightness', 'both']:
                events = [power(0, name, 'off'), power(.1, name, 'on')]
                for i, (temp, level) in enumerate([(588,2), (200,254), (588,2), (200,254)]):
                    at = .12 + i*.02
                    if family in ['brightness','both']:
                        events.append(brightness(at, level, name))
                    if family in ['temperature','both']:
                        events.append(arrow(at+.005, temp, name))
                sim = Replay(events)
                sim.put('input_number.ls_' + name + '_remote_preset', '2')
                self.assertEqual([c['command'] for c in sim.drive()], ['sara_toggle'])
                self.assertEqual(sim.states('input_number.ls_' + name + '_remote_preset'), '0')

    def test_brightness_first_or_color_first_partner_is_deduplicated(self):
        for events in [[brightness(0, 76), arrow(.01, 454)], [arrow(0, 454), brightness(.01, 76)]]:
            sim = Replay(events)
            self.assertEqual([c['command'] for c in sim.drive()], ['left'])

    def test_triple_press_cancels_secret_before_delayed_reset(self):
        sim = Replay([power(0), power(.1), power(.11), arrow(.12, 588), arrow(.14, 200)])
        self.assertEqual([c['command'] for c in sim.drive()], ['left', 'right', 'reset'])

    def test_both_remote_decoders_preserve_all_edges_including_wrap(self):
        for name in REMOTES:
            for old in range(5):
                for delta, command in [(-1, 'left'), (1, 'right')]:
                    for event in [arrow(0, PRESETS[(old + delta) % 5], name),
                                  brightness(0, [254,229,178,76,2][(old + delta) % 5], name)]:
                        sim = Replay([event])
                        sim.put('input_number.ls_' + name + '_remote_preset', old)
                        self.assertEqual([c['command'] for c in sim.drive()], [command])

    def test_dynamic_room_and_restart_do_not_leave_stale_secret(self):
        sim = Replay(chord() + [{'time': .17, 'remote': 'bedroom', 'assign_area': 'kitchen'}])
        self.assertEqual(sim.drive()[0]['area'], 'kitchen')
        sim = Replay([arrow(0, 454)])
        sim.put('input_number.ls_bedroom_remote_chord_step', '3')
        self.assertEqual([c['command'] for c in sim.drive()], ['left'])
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_chord_step'), '0')

    def test_native_schema_and_nonwaiting_gesture_handlers(self):
        helpers = json.loads((ROOT / 'gesture_helpers.json').read_text())
        for name in REMOTES:
            self.assertFalse(helpers['timer']['ls_' + name + '_remote_chord']['restore'])
            self.assertNotIn('initial', helpers['input_number']['ls_' + name + '_remote_preset'])
            cfg = json.loads((ROOT / ('ls_remote_gesture_' + name + '.json')).read_text())
            self.assertEqual(cfg['mode'], 'queued')
            self.assertNotIn('wait_for_trigger', json.dumps(cfg))
            self.assertNotIn('wait_template', json.dumps(cfg))
        def validate(value):
            if isinstance(value, list):
                for v in value: validate(v)
            elif isinstance(value, dict):
                for key, v in value.items():
                    if key in ['target', 'data', 'event_data']:
                        self.assertIsInstance(v, dict)
                    validate(v)
        for p in list(ROOT.glob('gesture_*.json')) + list(ROOT.glob('ls_remote_gesture_*.json')):
            candidate=json.loads(p.read_text())
            validate(candidate)
            self.assertNotIn('wait_for_trigger',json.dumps(candidate))
            self.assertNotIn('wait_template',json.dumps(candidate))

    def test_blocked_logical_dispatch_cannot_drop_second_or_third_power(self):
        sim=Replay([direction(0,'up'),power(.01),power(.02),power(.03)],defer_commands=True)
        self.assertEqual([c['command'] for c in sim.drive()],['up','reset'])
        self.assertEqual(len(sim.pending_commands),2)
        self.assertAlmostEqual(sim.commands[-1]['time'],.43)
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_power_count'),'0')
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_chord_step'),'0')

    def test_blocked_logical_dispatch_keeps_raw_cursor_reset_and_decode_in_order(self):
        events=[direction(0,'up')]+chord(.01)
        sim=Replay(events,defer_commands=True)
        sim.put('input_number.ls_bedroom_remote_preset','2')
        self.assertEqual([c['command'] for c in sim.drive()],['up','sara_toggle'])
        self.assertEqual(sim.sara_states,[])  # Downstream controller is still blocked.
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_preset'),'0')
        sim.flush_commands()
        self.assertEqual(sim.sara_states,[True])

    def test_stale_quiet_expiry_is_ignored_after_new_power_restarts_timer(self):
        sim=Replay(defer_commands=True)
        sim.gesture('bedroom','power')
        old_token=sim.states('input_text.ls_bedroom_remote_power_token')
        sim.advance(.2)
        sim.gesture('bedroom','power')
        sim.gesture('bedroom','power_done',token=old_token)
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_power_count'),'2')
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_chord_step'),'1')
        self.assertEqual(sim.commands,[])
        sim.drive()
        self.assertEqual(sim.states('input_number.ls_bedroom_remote_power_count'),'0')
        self.assertEqual(sim.commands,[])

    def test_delayed_finished_event_cannot_merge_separate_power_bursts(self):
        sim=Replay(defer_commands=True)
        sim.gesture('bedroom','power')
        old_token=sim.states('input_text.ls_bedroom_remote_power_token')
        sim.advance(.5)
        sim.gesture('bedroom','power')  # Finish old single before recording new first.
        self.assertEqual([c['command'] for c in sim.commands],['toggle'])
        sim.gesture('bedroom','power_done',token=old_token)
        self.assertEqual([c['command'] for c in sim.commands],['toggle'])
        sim.drive()
        self.assertEqual([c['command'] for c in sim.commands],['toggle','toggle'])

    def test_delayed_triple_completion_is_preserved_before_new_power(self):
        sim=Replay(defer_commands=True)
        for i in range(3):
            if i:sim.advance(.1)
            sim.gesture('bedroom','power')
        old_token=sim.states('input_text.ls_bedroom_remote_power_token')
        sim.advance(.5)
        sim.gesture('bedroom','power')
        self.assertEqual([c['command'] for c in sim.commands],['reset'])
        sim.gesture('bedroom','power_done',token=old_token)
        self.assertEqual([c['command'] for c in sim.commands],['reset'])
        sim.drive()
        self.assertEqual([c['command'] for c in sim.commands],['reset','toggle'])

    def test_debounce_is_relative_four_hundred_ms_at_fractional_wall_clock(self):
        sim=Replay([power(0)])
        sim.now=sim.now.replace(microsecond=693611)
        self.assertEqual([c['command'] for c in sim.drive()],['toggle'])
        self.assertAlmostEqual(sim.commands[0]['time'],.4)
        self.assertEqual(sim.now.microsecond,93611)
        cfg=sim.config['ls_remote_power_quiet_bedroom']
        self.assertEqual(cfg['mode'],'restart')
        self.assertEqual(cfg['sequence'][0],{'delay':{'milliseconds':400}})

    def test_stale_probe_completion_is_read_only(self):
        sim=Replay()
        before=copy.deepcopy(sim.state)
        sim.gesture('bedroom','power_done',token='stale-probe')
        self.assertEqual(sim.state,before)
        self.assertEqual(sim.commands,[])

    def test_automations_are_thin_routes_and_actor_is_the_only_helper_writer(self):
        sim=Replay()
        for config in sim.automations.values():
            if not str(config.get('id','')).startswith('lighting_remote_'):continue
            if config not in [sim.automations[k+'_'+n] for n in REMOTES for k in ['center','directions','presets']]:continue
            self.assertTrue(all(a.get('action','').startswith('script.ls_remote_gesture_') for a in config['actions']))
        for name in REMOTES:
            helper=json.loads((ROOT/'gesture_helpers.json').read_text())['input_number']['ls_'+name+'_remote_power_count']
            self.assertEqual(helper['initial'],0)


if __name__ == '__main__':
    unittest.main()
