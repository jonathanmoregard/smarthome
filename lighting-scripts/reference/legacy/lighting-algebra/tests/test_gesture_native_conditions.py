"""Regressions for HA branch-local condition aborts observed in native traces.

Breaks caught: duplicate preset/companion frames cancel the secret chord;
unrelated full MQTT payloads escape as logical 'preset' commands; duplicate
or wrapping frames advance the software preset more than once.
"""
import unittest

from test_gesture_integration import IntegratedReplay, REMOTES, arrow, brightness, power


class NativeConditionReplay(IntegratedReplay):
    def seq(self, steps, context):
        # HA condition actions end their containing sequence only. An explicit
        # stop propagates through nested sequences and ends the script.
        for step in steps:
            if 'condition' in step:
                if not self.cond(step, context):
                    return
            elif 'if' in step:
                self.seq(step.get('then' if self.cond(step['if'], context) else 'else', []), context)
            elif 'choose' in step:
                branch = next((b for b in step['choose'] if self.cond(b['conditions'], context)), None)
                self.seq(branch['sequence'] if branch else step.get('default', []), context)
            else:
                super().seq([step], context)


def raw(at, payload, room='bedroom'):
    return {'time': at, 'topic': 'zigbee2mqtt/' + REMOTES[room][0], 'payload_json': payload}


class NativeConditionGestureTests(unittest.TestCase):
    def test_unrelated_mqtt_messages_do_not_emit_commands_or_cancel_chord(self):
        for room in REMOTES:
            events = [power(0, room), raw(.01, {'action': 'on'}, room),
                      power(.1, room), raw(.11, {'action': 'off'}, room),
                      arrow(.12, 588, room), raw(.125, {'battery': 100}, room),
                      arrow(.14, 200, room), arrow(.16, 588, room), arrow(.18, 200, room)]
            sim = NativeConditionReplay(events)
            self.assertEqual([r['command'] for r in sim.drive()], ['sara_toggle'])
            self.assertEqual(sim.physical(), [])

    def test_duplicate_companion_presets_do_not_cancel_secret_chord(self):
        for room in REMOTES:
            events = [power(0, room), power(.1, room),
                      arrow(.12, 588, room), brightness(.125, 2, room),
                      arrow(.14, 200, room), brightness(.145, 254, room),
                      arrow(.16, 588, room), brightness(.165, 2, room),
                      arrow(.18, 200, room), brightness(.185, 254, room)]
            sim = NativeConditionReplay(events)
            self.assertEqual([r['command'] for r in sim.drive()], ['sara_toggle'])

    def test_wrapping_edges_emit_one_direction_per_press_without_sara(self):
        for room in REMOTES:
            for previous, temp, level, command in [(4, 200, 254, 'right'), (0, 588, 2, 'left')]:
                sim = NativeConditionReplay([arrow(0, temp, room), brightness(.01, level, room)])
                sim.put('input_number.ls_' + room + '_remote_preset', previous)
                result = sim.drive()
                self.assertEqual([r['command'] for r in result], [command])
                self.assertNotIn('mode:sara', sim.attr('sensor.ls_overrides', 'overrides'))

    def test_unrelated_messages_on_idle_remote_are_noop(self):
        for payload in [{'action': 'on'}, {'action': 'off'}, {'action': 'brightness_step_up'}, {'battery': 90}]:
            sim = NativeConditionReplay([raw(0, payload)])
            self.assertEqual(sim.drive(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
