"""Tagged JSON codec: every step, input, context, bulb state and checkpoint survives a JSON trip."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import json
import unittest
from zoneinfo import ZoneInfo

from tests.e2e.codec import (Advance, Checkpoint, PersonLightChange, PressSwitch, MalformedKind, UnknownKind, decode, encode)
from tests.e2e.router import Context, Event, HaStart, Mqtt, ScriptCall, StateChanged, Tick
from tests.e2e.world import Kelvin, Off, On, Rgb

STOCKHOLM = ZoneInfo('Europe/Stockholm')
CONTEXT = Context(id='ctx-1', user_id='person_a', parent_id=None)
NOW = datetime(2026, 3, 29, 3, 30, tzinfo=STOCKHOLM)

CHECKPOINT = Checkpoint(
    step=3, t=61.5,
    bulbs={'bulb_a': On(level=200, colour=Kelvin(2700), effect='none'),
           'bulb_b': On(level=10, colour=Rgb(255, 0, 128), effect='candle'),
           'bulb_c': On(level=254, colour=None, effect='none'),
           'bulb_d': Off()},
    switches={'plug_x': 'on', 'plug_y': 'off'},
    dashboard={'switch_ranges': {'plug_x': [['08:00', '09:00']]}, 'range_defaults': {}},
    in_fade=frozenset({'bulb_a', 'bulb_b'}),
    not_ported=('automation_a', 'automation_b'))

EVERY_KIND = [
    HaStart(), Tick(now=NOW),
    StateChanged(entity='light.lamp_a', old=None, new={'state': 'on', 'attributes': {'brightness': 5}}, context=CONTEXT),
    StateChanged(entity='light.lamp_a', old={'state': 'off', 'attributes': {}}, new={'state': 'on', 'attributes': {}},
                 context=Context(id='c2', user_id=None, parent_id='c1')),
    Event(type='event_a', data={'k': [1, 2.5, None, True]}, context=CONTEXT),
    Mqtt(topic='zigbee2mqtt/bulb_a', payload='{"x": 1}'),
    ScriptCall(script='script_a', data={'nested': {'a': 1}}, context=CONTEXT),
    CONTEXT,
    Advance(seconds=90.5), PressSwitch(entity='switch.plug_x'),
    PersonLightChange(entities=['light.lamp_a', 'light.lamp_b'], service_data={'brightness_pct': 40}),
    Off(), On(level=1, colour=None, effect='none'), Kelvin(4000), Rgb(1, 2, 3),
    CHECKPOINT,
]


class RoundTrip(unittest.TestCase):
    def test_round_trip_every_kind(self):
        for value in EVERY_KIND:
            with self.subTest(kind=type(value).__name__):
                wire = json.loads(json.dumps(encode(value)))
                self.assertEqual(decode(wire), value)
                self.assertIs(type(decode(wire)), type(value))

    def test_every_kind_is_tagged_with_its_class_name(self):
        for value in EVERY_KIND:
            self.assertEqual(encode(value)['kind'], type(value).__name__)

    def test_checkpoint_keeps_container_types(self):
        back = decode(json.loads(json.dumps(encode(CHECKPOINT))))
        self.assertIsInstance(back.in_fade, frozenset)
        self.assertIsInstance(back.not_ported, tuple)
        self.assertIsInstance(back.bulbs['bulb_d'], Off)

    def test_datetime_is_iso_with_offset_and_exact(self):
        wire = encode(Tick(now=NOW))
        self.assertEqual(wire['now'], {'kind': 'datetime', 'iso': '2026-03-29T03:30:00+02:00'})
        for moment in (NOW, datetime(2026, 10, 25, 2, 30, tzinfo=timezone(timedelta(hours=1)))):
            back = decode(json.loads(json.dumps(encode(Tick(now=moment)))))
            self.assertEqual(back.now, moment)
            self.assertEqual(back.now.utcoffset(), moment.utcoffset())

    def test_a_plain_dict_with_a_kind_key_is_not_mistaken_for_a_tag(self):
        value = Event(type='e', data={'kind': 'Off'}, context=CONTEXT)
        self.assertEqual(decode(json.loads(json.dumps(encode(value)))), value)

    def test_unknown_kind_raises(self):
        with self.assertRaises(UnknownKind):
            decode({'kind': 'NotAThing'})

    def test_missing_field_names_the_kind_and_field(self):
        wire = encode(PressSwitch(entity='switch.plug_x'))
        del wire['entity']
        with self.assertRaisesRegex(MalformedKind, r"PressSwitch.*missing.*entity"):
            decode(wire)

    def test_extra_field_names_the_kind_and_field(self):
        wire = encode(PressSwitch(entity='switch.plug_x'))
        wire['surplus'] = 1
        with self.assertRaisesRegex(MalformedKind, r"PressSwitch.*unexpected.*surplus"):
            decode(wire)

    def test_unencodable_value_raises(self):
        with self.assertRaises(TypeError):
            encode(object())


if __name__ == '__main__':
    unittest.main()
