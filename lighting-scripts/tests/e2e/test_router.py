"""The trigger router, driven by synthetic automation configs only."""
from __future__ import annotations
from datetime import datetime, timedelta, timezone
import json
import unittest
from zoneinfo import ZoneInfo

from tests.e2e.env import reference_available
from tests.e2e.router import (AutomationRun, Context, Event, HaStart, House, Mqtt, ScriptCall, ScriptRun,
                              StateChanged, Tick, UnsupportedTrigger, load_automations, route)

STOCKHOLM = ZoneInfo('Europe/Stockholm')
PERSON = Context(id='ctx-1', user_id='person')


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=STOCKHOLM) if '+' not in text else datetime.fromisoformat(text)


def house(*triggers, helpers=None, labels=None, render=None, name='automation_a') -> House:
    return House(automations={name: {'triggers': list(triggers), 'actions': []}},
                 helpers=helpers or {}, labels=labels or {}, render=render)


def names(runs) -> list[str]:
    return [run.name for run in runs]


def state(value: str, **attributes) -> dict:
    return {'state': value, 'attributes': attributes}


def changed(entity: str, old: dict | None, new: dict) -> StateChanged:
    return StateChanged(entity, old, new, PERSON)


class HomeAssistantStartTests(unittest.TestCase):
    def test_fires_on_start_only(self):
        h = house({'trigger': 'homeassistant', 'event': 'start'})
        self.assertEqual(route(h, HaStart(), None), [AutomationRun('automation_a', {
            'platform': 'homeassistant', 'event': 'start', 'id': '0', 'idx': '0'})])
        self.assertEqual(route(h, Tick(at('2026-01-01T10:00:00')), at('2026-01-01T09:59:00')), [])


class StateTests(unittest.TestCase):
    def test_to_fires_and_other_value_does_not(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'to': 'on'})
        self.assertEqual(len(route(h, changed('sensor.x', state('off'), state('on')), None)), 1)
        self.assertEqual(route(h, changed('sensor.x', state('on'), state('off')), None), [])
        self.assertEqual(route(h, changed('sensor.y', state('off'), state('on')), None), [])

    def test_trigger_dict_carries_entity_and_both_states(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'to': 'on'})
        old, new = state('off'), state('on')
        [run] = route(h, changed('sensor.x', old, new), None)
        self.assertEqual(run.trigger['entity_id'], 'sensor.x')
        self.assertEqual(run.trigger['from_state'], old)
        self.assertEqual(run.trigger['to_state'], new)
        self.assertEqual(run.trigger['platform'], 'state')

    def test_entity_id_may_be_a_list(self):
        h = house({'trigger': 'state', 'entity_id': ['sensor.x', 'sensor.y'], 'to': 'on'})
        self.assertEqual(len(route(h, changed('sensor.y', state('off'), state('on')), None)), 1)
        self.assertEqual(route(h, changed('sensor.z', state('off'), state('on')), None), [])

    def test_from_and_to_accept_lists(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'from': ['unavailable', 'unknown'], 'to': ['on', 'home']})
        self.assertEqual(len(route(h, changed('sensor.x', state('unknown'), state('home')), None)), 1)
        self.assertEqual(route(h, changed('sensor.x', state('off'), state('on')), None), [])
        self.assertEqual(route(h, changed('sensor.x', state('unknown'), state('off')), None), [])

    def test_not_to_excludes_listed_states(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'not_to': ['unavailable', 'unknown']})
        self.assertEqual(len(route(h, changed('sensor.x', state('on'), state('off')), None)), 1)
        self.assertEqual(route(h, changed('sensor.x', state('on'), state('unavailable')), None), [])

    def test_without_filters_any_state_or_attribute_change_fires(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x'})
        self.assertEqual(len(route(h, changed('sensor.x', state('on', a=1), state('on', a=2)), None)), 1)
        self.assertEqual(len(route(h, changed('sensor.x', state('on'), state('off')), None)), 1)

    def test_attribute_only_change_does_not_fire_with_to(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'to': 'on'})
        self.assertEqual(route(h, changed('sensor.x', state('on', a=1), state('on', a=2)), None), [])

    def test_attribute_only_change_does_not_fire_with_from_or_not_to(self):
        for option in ({'from': 'on'}, {'not_to': 'off'}):
            with self.subTest(option=option):
                h = house({'trigger': 'state', 'entity_id': 'sensor.x', **option})
                self.assertEqual(route(h, changed('sensor.x', state('on', a=1), state('on', a=2)), None), [])

    def test_attribute_trigger_fires_only_when_that_attribute_changes(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'attribute': 'a'})
        self.assertEqual(len(route(h, changed('sensor.x', state('on', a=1, b=1), state('on', a=2, b=1)), None)), 1)
        self.assertEqual(route(h, changed('sensor.x', state('on', a=1, b=1), state('on', a=1, b=2)), None), [])
        self.assertEqual(route(h, changed('sensor.x', state('on', a=1), state('off', a=1)), None), [])

    def test_attribute_trigger_with_to_compares_the_attribute(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'attribute': 'a', 'to': 5})
        self.assertEqual(len(route(h, changed('sensor.x', state('on', a=1), state('on', a=5)), None)), 1)
        self.assertEqual(route(h, changed('sensor.x', state('on', a=1), state('on', a=2)), None), [])

    def test_new_entity_with_no_old_state(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'to': 'on'})
        self.assertEqual(len(route(h, changed('sensor.x', None, state('on')), None)), 1)
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'from': 'off'})
        self.assertEqual(route(h, changed('sensor.x', None, state('on')), None), [])


class TimePatternTests(unittest.TestCase):
    def test_quarter_minute_seconds_fire_once_per_instant_in_window(self):
        h = house({'trigger': 'time_pattern', 'seconds': '/15'})
        runs = route(h, Tick(at('2026-01-01T10:01:01')), at('2026-01-01T10:00:07'))
        self.assertEqual([run.trigger['now'] for run in runs], [
            '2026-01-01T10:00:15+01:00', '2026-01-01T10:00:30+01:00',
            '2026-01-01T10:00:45+01:00', '2026-01-01T10:01:00+01:00'])

    def test_window_is_open_at_previous_tick_and_closed_at_now(self):
        h = house({'trigger': 'time_pattern', 'seconds': '/15'})
        runs = route(h, Tick(at('2026-01-01T10:00:30')), at('2026-01-01T10:00:15'))
        self.assertEqual([run.trigger['now'] for run in runs], ['2026-01-01T10:00:30+01:00'])

    def test_minutes_pattern_fires_on_the_minute(self):
        h = house({'trigger': 'time_pattern', 'minutes': '/5'})
        runs = route(h, Tick(at('2026-01-01T10:11:00')), at('2026-01-01T10:04:30'))
        self.assertEqual([run.trigger['now'] for run in runs], ['2026-01-01T10:05:00+01:00', '2026-01-01T10:10:00+01:00'])

    def test_no_previous_tick_fires_nothing(self):
        h = house({'trigger': 'time_pattern', 'seconds': '/15'})
        self.assertEqual(route(h, Tick(at('2026-01-01T10:00:30')), None), [])

    def test_instants_are_ordered_across_automations(self):
        h = House(automations={
            'automation_a': {'triggers': [{'trigger': 'time_pattern', 'seconds': '/30'}], 'actions': []},
            'automation_b': {'triggers': [{'trigger': 'time_pattern', 'seconds': '/15'}], 'actions': []},
        }, helpers={}, labels={})
        runs = route(h, Tick(at('2026-01-01T10:00:30')), at('2026-01-01T10:00:00'))
        self.assertEqual(names(runs), ['automation_b', 'automation_a', 'automation_b'])


class TimeTests(unittest.TestCase):
    def test_literal_fires_when_crossed_and_not_otherwise(self):
        h = house({'trigger': 'time', 'at': '08:00:00'})
        self.assertEqual(len(route(h, Tick(at('2026-01-01T08:00:30')), at('2026-01-01T07:59:30'))), 1)
        self.assertEqual(route(h, Tick(at('2026-01-01T07:59:59')), at('2026-01-01T07:59:00')), [])
        self.assertEqual(route(h, Tick(at('2026-01-01T08:01:00')), at('2026-01-01T08:00:00')), [])

    def test_literal_fires_on_the_closing_instant(self):
        h = house({'trigger': 'time', 'at': '08:00:00'})
        self.assertEqual(len(route(h, Tick(at('2026-01-01T08:00:00')), at('2026-01-01T07:59:00'))), 1)

    def test_literal_fires_once_per_day_crossed(self):
        h = house({'trigger': 'time', 'at': '08:00:00'})
        runs = route(h, Tick(at('2026-01-03T09:00:00')), at('2026-01-01T09:00:00'))
        self.assertEqual(len(runs), 2)

    def test_local_time_is_stockholm_in_summer(self):
        h = house({'trigger': 'time', 'at': '08:00:00'})
        utc = timezone.utc
        # 06:00 UTC is 08:00 in Stockholm in July (UTC+2).
        runs = route(h, Tick(datetime(2026, 7, 1, 6, 0, 30, tzinfo=utc)), datetime(2026, 7, 1, 5, 59, 30, tzinfo=utc))
        self.assertEqual(len(runs), 1)
        self.assertEqual(route(h, Tick(datetime(2026, 7, 1, 7, 0, 30, tzinfo=utc)), datetime(2026, 7, 1, 6, 59, 30, tzinfo=utc)), [])

    def test_literal_across_spring_forward(self):
        h = house({'trigger': 'time', 'at': '03:30:00'})
        # 2026-03-29: 02:00 CET jumps to 03:00 CEST; 03:30 CEST is 01:30 UTC.
        utc = timezone.utc
        runs = route(h, Tick(datetime(2026, 3, 29, 1, 31, tzinfo=utc)), datetime(2026, 3, 29, 1, 29, tzinfo=utc))
        self.assertEqual(len(runs), 1)
        self.assertEqual(route(h, Tick(datetime(2026, 3, 29, 2, 31, tzinfo=utc)), datetime(2026, 3, 29, 2, 29, tzinfo=utc)), [])

    def test_literal_across_fall_back_fires_in_both_folds(self):
        # HA fires an ambiguous local time in both folds: homeassistant/util/dt.py
        # find_next_time_expression_time (lines 524-552), reached via async_track_time_change.
        h = house({'trigger': 'time', 'at': '02:30:00'})
        utc = timezone.utc
        # 2026-10-25: 03:00 CEST falls back to 02:00 CET; 02:30 is 00:30 UTC (CEST) and 01:30 UTC (CET).
        runs = route(h, Tick(datetime(2026, 10, 25, 2, 0, tzinfo=utc)), datetime(2026, 10, 24, 22, 0, tzinfo=utc))
        self.assertEqual([run.trigger['now'] for run in runs], ['2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00'])

    def test_literal_in_the_skipped_hour_does_not_fire_that_day(self):
        h = house({'trigger': 'time', 'at': '02:30:00'})
        # 2026-03-29 02:00 CET jumps to 03:00 CEST, so 02:30 does not exist; it fires the next day.
        runs = route(h, Tick(at('2026-03-30T03:00:00')), at('2026-03-28T03:00:00'))
        self.assertEqual([run.trigger['now'] for run in runs], ['2026-03-30T02:30:00+02:00'])

    def test_literal_accepts_hours_and_minutes(self):
        h = house({'trigger': 'time', 'at': '08:00'})
        self.assertEqual(len(route(h, Tick(at('2026-01-01T08:00:30')), at('2026-01-01T07:59:30'))), 1)

    def test_helper_time_fires_only_when_crossed(self):
        h = house({'trigger': 'time', 'at': 'input_datetime.wake'},
                  helpers={'input_datetime.wake': state('06:30:00', has_date=False, has_time=True)})
        self.assertEqual(len(route(h, Tick(at('2026-01-01T06:31:00')), at('2026-01-01T06:29:00'))), 1)
        self.assertEqual(route(h, Tick(at('2026-01-01T06:29:00')), at('2026-01-01T06:28:00')), [])

    def test_helper_without_value_never_fires(self):
        for value in ('unknown', 'unavailable', ''):
            with self.subTest(value=value):
                h = house({'trigger': 'time', 'at': 'input_datetime.wake'},
                          helpers={'input_datetime.wake': state(value, has_date=False, has_time=True)})
                self.assertEqual(route(h, Tick(at('2026-01-02T00:00:00')), at('2026-01-01T00:00:00')), [])
        h = house({'trigger': 'time', 'at': 'input_datetime.missing'})
        self.assertEqual(route(h, Tick(at('2026-01-02T00:00:00')), at('2026-01-01T00:00:00')), [])

    def test_helper_with_date_and_time_fires_once_on_that_day(self):
        h = house({'trigger': 'time', 'at': 'input_datetime.when'},
                  helpers={'input_datetime.when': state('2026-01-02 07:00:00', has_date=True, has_time=True)})
        self.assertEqual(route(h, Tick(at('2026-01-01T09:00:00')), at('2026-01-01T08:00:00')), [])
        self.assertEqual(len(route(h, Tick(at('2026-01-02T07:00:30')), at('2026-01-02T06:59:30'))), 1)
        self.assertEqual(route(h, Tick(at('2026-01-03T07:00:30')), at('2026-01-03T06:59:30')), [])

    def test_helper_with_date_only_fires_at_midnight(self):
        h = house({'trigger': 'time', 'at': 'input_datetime.day'},
                  helpers={'input_datetime.day': state('2026-01-02', has_date=True, has_time=False)})
        self.assertEqual(len(route(h, Tick(at('2026-01-02T00:00:30')), at('2026-01-01T23:59:30'))), 1)

    def test_entity_with_offset_fires_before_the_timestamp(self):
        h = house({'trigger': 'time', 'at': {'entity_id': 'sensor.alarm', 'offset': '-00:30:00'}},
                  helpers={'sensor.alarm': state('2026-01-02T06:00:00+00:00')})
        # The alarm is 07:00 Stockholm; the trigger is 30 minutes earlier.
        self.assertEqual(len(route(h, Tick(at('2026-01-02T06:30:30')), at('2026-01-02T06:29:30'))), 1)
        self.assertEqual(route(h, Tick(at('2026-01-02T07:00:30')), at('2026-01-02T06:59:30')), [])

    def test_entity_with_offset_and_no_value_never_fires(self):
        h = house({'trigger': 'time', 'at': {'entity_id': 'sensor.alarm', 'offset': '-00:30:00'}},
                  helpers={'sensor.alarm': state('unknown')})
        self.assertEqual(route(h, Tick(at('2026-01-03T00:00:00')), at('2026-01-01T00:00:00')), [])

    def test_trigger_dict(self):
        h = house({'trigger': 'time', 'at': '08:00:00', 'id': 'day'})
        [run] = route(h, Tick(at('2026-01-01T08:00:30')), at('2026-01-01T07:59:30'))
        self.assertEqual(run.trigger, {'platform': 'time', 'now': '2026-01-01T08:00:00+01:00', 'id': 'day', 'idx': '0'})


class TimePatternDstTests(unittest.TestCase):
    def instants(self, pattern, start, end):
        h = house({'trigger': 'time_pattern', **pattern})
        return [run.trigger['now'] for run in route(h, Tick(end), start)]

    def test_minutes_across_spring_forward_skip_the_missing_hour(self):
        utc = timezone.utc
        # The clocks jump at 01:00 UTC (02:00 CET -> 03:00 CEST); no local 02:xx exists.
        got = self.instants({'minutes': '/30'}, datetime(2026, 3, 29, 0, 45, tzinfo=utc), datetime(2026, 3, 29, 2, 15, tzinfo=utc))
        self.assertEqual(got, ['2026-03-29T03:00:00+02:00', '2026-03-29T03:30:00+02:00', '2026-03-29T04:00:00+02:00'])

    def test_seconds_across_fall_back_fire_in_both_folds_without_duplicates(self):
        utc = timezone.utc
        # The clocks fall back at 01:00 UTC (03:00 CEST -> 02:00 CET).
        got = self.instants({'seconds': '/30'}, datetime(2026, 10, 25, 0, 59, 15, tzinfo=utc), datetime(2026, 10, 25, 1, 0, 45, tzinfo=utc))
        self.assertEqual(got, ['2026-10-25T02:59:30+02:00', '2026-10-25T02:00:00+01:00', '2026-10-25T02:00:30+01:00'])

    def test_minutes_across_fall_back_fire_once_per_real_instant(self):
        utc = timezone.utc
        got = self.instants({'minutes': '/30'}, datetime(2026, 10, 24, 23, 45, tzinfo=utc), datetime(2026, 10, 25, 2, 15, tzinfo=utc))
        self.assertEqual(got, ['2026-10-25T02:00:00+02:00', '2026-10-25T02:30:00+02:00', '2026-10-25T02:00:00+01:00',
                               '2026-10-25T02:30:00+01:00', '2026-10-25T03:00:00+01:00'])


class EventTests(unittest.TestCase):
    def call(self, **data) -> Event:
        return Event('call_service', data, PERSON)

    def test_type_and_data_subset(self):
        h = house({'trigger': 'event', 'event_type': 'call_service', 'event_data': {'domain': 'light'}})
        self.assertEqual(len(route(h, self.call(domain='light', service='turn_on'), None)), 1)
        self.assertEqual(route(h, self.call(domain='switch', service='turn_on'), None), [])
        self.assertEqual(route(h, Event('other', {'domain': 'light'}, PERSON), None), [])

    def test_without_event_data_any_event_of_the_type_fires(self):
        h = house({'trigger': 'event', 'event_type': 'call_service'})
        self.assertEqual(len(route(h, self.call(), None)), 1)

    def test_trigger_dict_carries_the_event_and_context(self):
        h = house({'trigger': 'event', 'event_type': 'call_service'})
        [run] = route(h, Event('call_service', {'domain': 'light'}, Context('c', 'u', 'p')), None)
        self.assertEqual(run.trigger['event'], {
            'event_type': 'call_service', 'data': {'domain': 'light'},
            'context': {'id': 'c', 'user_id': 'u', 'parent_id': 'p'}})

    def test_ls_override_events_are_never_routed(self):
        h = house({'trigger': 'event', 'event_type': 'ls_override'})
        self.assertEqual(route(h, Event('ls_override', {}, PERSON), None), [])


class MqttTests(unittest.TestCase):
    def test_exact_topic_and_plus_wildcard(self):
        h = house({'trigger': 'mqtt', 'topic': 'base/+/action'})
        self.assertEqual(len(route(h, Mqtt('base/remote/action', 'x'), None)), 1)
        self.assertEqual(route(h, Mqtt('base/remote/deep/action', 'x'), None), [])
        self.assertEqual(route(h, Mqtt('base/remote', 'x'), None), [])
        h = house({'trigger': 'mqtt', 'topic': 'base/remote'})
        self.assertEqual(route(h, Mqtt('base/remote/x', 'x'), None), [])

    def test_payload_must_match_exactly(self):
        h = house({'trigger': 'mqtt', 'topic': 't', 'payload': 'on'})
        self.assertEqual(len(route(h, Mqtt('t', 'on'), None)), 1)
        self.assertEqual(route(h, Mqtt('t', 'off'), None), [])
        self.assertEqual(route(h, Mqtt('t', 'on '), None), [])

    def test_mqtt_payload_json(self):
        h = house({'trigger': 'mqtt', 'topic': 't'})
        [run] = route(h, Mqtt('t', '{"a": [1, 2]}'), None)
        self.assertEqual(run.trigger, {'platform': 'mqtt', 'topic': 't', 'payload': '{"a": [1, 2]}',
                                       'payload_json': {'a': [1, 2]}, 'id': '0', 'idx': '0'})
        [run] = route(h, Mqtt('t', 'plain'), None)
        self.assertNotIn('payload_json', run.trigger)

    def test_value_template_without_payload_fires_whatever_it_renders(self):
        # HA only renders the template to compare it with `payload`; with no `payload` it fires unconditionally.
        def render(template, context):
            raise AssertionError('not rendered')

        h = house({'trigger': 'mqtt', 'topic': 't', 'value_template': '{{ tpl }}'}, render=render)
        self.assertEqual(len(route(h, Mqtt('t', '{"ok": false}'), None)), 1)

    def test_value_template_output_is_compared_with_payload(self):
        seen = []

        def render(template, context):
            seen.append((template, context))
            return 'failed' if context.get('value') == 'raw' else 'fine'

        h = house({'trigger': 'mqtt', 'topic': 't', 'payload': 'failed', 'value_template': '{{ tpl }}'}, render=render)
        [run] = route(h, Mqtt('t', 'raw'), None)
        self.assertEqual(run.trigger['payload'], 'raw')   # the trigger carries the raw message
        self.assertEqual(route(h, Mqtt('t', 'other'), None), [])
        self.assertEqual(seen[0], ('{{ tpl }}', {'value': 'raw'}))

    def test_value_template_sees_value_json_of_a_json_message(self):
        seen = []
        h = house({'trigger': 'mqtt', 'topic': 't', 'payload': 'x', 'value_template': '{{ tpl }}'},
                  render=lambda template, context: seen.append(context) or 'x')
        [run] = route(h, Mqtt('t', '{"a": 1}'), None)
        self.assertEqual(seen, [{'value': '{"a": 1}', 'value_json': {'a': 1}}])
        self.assertEqual(run.trigger['payload_json'], {'a': 1})   # parsed from the raw message

    def test_value_template_render_error_never_matches(self):
        def render(template, context):
            raise ValueError('boom')

        h = house({'trigger': 'mqtt', 'topic': 't', 'payload': 'failed', 'value_template': '{{ tpl }}'}, render=render)
        self.assertEqual(route(h, Mqtt('t', 'x'), None), [])

    def test_value_template_with_payload_needs_a_renderer(self):
        h = house({'trigger': 'mqtt', 'topic': 't', 'payload': 'x', 'value_template': '{{ tpl }}'})
        with self.assertRaises(RuntimeError):
            route(h, Mqtt('t', 'x'), None)


class LightTurnedOnTests(unittest.TestCase):
    LABELS = {'lamps': ['light.a', 'light.b'], 'other': ['light.c']}

    def test_light_turned_on_by_label_off_to_on_only(self):
        h = house({'trigger': 'light.turned_on', 'target': {'label_id': 'lamps'}}, labels=self.LABELS)
        old, new = state('off'), state('on')
        [run] = route(h, changed('light.a', old, new), None)
        self.assertEqual(run.trigger, {'platform': 'light.turned_on', 'entity_id': 'light.a',
                                       'from_state': old, 'to_state': new, 'id': '0', 'idx': '0'})
        self.assertEqual(route(h, changed('light.a', state('on'), state('off')), None), [])
        self.assertEqual(route(h, changed('light.a', state('on', b=1), state('on', b=2)), None), [])
        self.assertEqual(route(h, changed('light.a', state('unavailable'), state('on')), None), [])
        self.assertEqual(route(h, changed('light.c', state('off'), state('on')), None), [])
        self.assertEqual(route(h, changed('light.zzz', state('off'), state('on')), None), [])


class FiringRuleTests(unittest.TestCase):
    def test_automation_fires_once_with_first_matching_trigger(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'to': 'on', 'id': 'first'},
                  {'trigger': 'state', 'entity_id': 'sensor.x', 'id': 'second'})
        [run] = route(h, changed('sensor.x', state('off'), state('on')), None)
        self.assertEqual(run.trigger['id'], 'first')
        [run] = route(h, changed('sensor.x', state('off'), state('off', a=1)), None)
        self.assertEqual(run.trigger['id'], 'second')

    def test_trigger_id_defaults_to_index(self):
        h = house({'trigger': 'state', 'entity_id': 'sensor.x', 'to': 'on'},
                  {'trigger': 'state', 'entity_id': 'sensor.y', 'to': 'on'},
                  {'trigger': 'state', 'entity_id': 'sensor.z', 'to': 'on', 'id': 'named'})
        [run] = route(h, changed('sensor.y', state('off'), state('on')), None)
        self.assertEqual((run.trigger['id'], run.trigger['idx']), ('1', '1'))
        [run] = route(h, changed('sensor.z', state('off'), state('on')), None)
        self.assertEqual((run.trigger['id'], run.trigger['idx']), ('named', '2'))

    def test_triggers_may_share_an_id(self):
        h = house({'trigger': 'mqtt', 'topic': 'a', 'id': 'same'}, {'trigger': 'mqtt', 'topic': 'b', 'id': 'same'})
        self.assertEqual([run.trigger['id'] for run in route(h, Mqtt('b', 'x'), None)], ['same'])

    def test_automations_fire_in_house_order(self):
        h = House(automations={
            'automation_b': {'triggers': [{'trigger': 'homeassistant', 'event': 'start'}], 'actions': []},
            'automation_a': {'triggers': [{'trigger': 'homeassistant', 'event': 'start'}], 'actions': []},
        }, helpers={}, labels={})
        self.assertEqual(names(route(h, HaStart(), None)), ['automation_b', 'automation_a'])

    def test_trigger_dicts_are_json_safe(self):
        h = House(automations={
            'automation_a': {'triggers': [
                {'trigger': 'homeassistant', 'event': 'start'},
                {'trigger': 'state', 'entity_id': 'sensor.x'},
                {'trigger': 'time_pattern', 'seconds': '/15'},
                {'trigger': 'time', 'at': '10:00:15'},
                {'trigger': 'event', 'event_type': 'e'},
                {'trigger': 'mqtt', 'topic': 't'},
                {'trigger': 'light.turned_on', 'target': {'label_id': 'lamps'}},
            ], 'actions': []}}, helpers={}, labels={'lamps': ['light.a']})
        inputs = [HaStart(), changed('sensor.x', state('a'), state('b')), Event('e', {'k': 1}, PERSON), Mqtt('t', '{"k": 1}'),
                  changed('light.a', state('off'), state('on'))]
        runs = [run for inp in inputs for run in route(h, inp, None)]
        runs += route(h, Tick(at('2026-01-01T10:00:30')), at('2026-01-01T10:00:00'))
        self.assertGreaterEqual(len(runs), 7)
        for run in runs:
            self.assertEqual(json.loads(json.dumps(run.trigger)), run.trigger)


class ScriptCallTests(unittest.TestCase):
    def test_dashboard_scripts_run_with_their_data(self):
        h = House(automations={}, helpers={}, labels={})
        for name in ('ls_override_block', 'ls_clear_overrides', 'ls_range_save'):
            with self.subTest(name=name):
                self.assertEqual(route(h, ScriptCall(name, {'k': 1}, PERSON), None), [ScriptRun(name, {'k': 1})])

    def test_other_scripts_are_not_dashboard_calls(self):
        h = House(automations={}, helpers={}, labels={})
        with self.assertRaises(ValueError):
            route(h, ScriptCall('ls_apply', {}, PERSON), None)


class LoadTests(unittest.TestCase):
    class FakeSim:
        def __init__(self, automations):
            self.automations = automations

    TRIGGERS = [{'trigger': 'homeassistant', 'event': 'start'}]

    def test_load_automations_one_per_capture(self):
        config = {'id': '1791919631065', 'triggers': self.TRIGGERS, 'actions': []}
        other = {'id': '42', 'triggers': self.TRIGGERS, 'actions': [], 'alias': 'x'}
        sim = self.FakeSim({
            'automation_one': config, 'automation_1791919631065': dict(config),
            'automation_two': other, 'automation_42': dict(other),
            'gesture_one': dict(config), 'automation_old_only': {'triggers': [], 'actions': []},
        })
        loaded = load_automations(sim, captured=['one', 'two', 'blueprint'])
        self.assertEqual(list(loaded), ['automation_one', 'automation_two'])
        self.assertIs(loaded['automation_one'], config)

    def test_unsupported_trigger_raises_at_load(self):
        for trigger in ({'trigger': 'sun', 'event': 'sunset'},
                        {'trigger': 'state', 'entity_id': 'sensor.x', 'for': '00:00:05'},
                        {'trigger': 'time_pattern', 'hours': '/2'},
                        {'trigger': 'homeassistant', 'event': 'shutdown'},
                        {'trigger': 'mqtt', 'topic': 'a/#'},
                        {'trigger': 'time', 'at': '10:00:00', 'weekday': ['mon']}):
            with self.subTest(trigger=trigger):
                sim = self.FakeSim({'automation_a': {'triggers': [trigger], 'actions': []}})
                with self.assertRaises(UnsupportedTrigger):
                    load_automations(sim, captured=['a'])

    def test_malformed_shapes_raise_at_load(self):
        for trigger in ({'trigger': 'time', 'at': 'not a time'},
                        {'trigger': 'time', 'at': '25:00:00'},
                        {'trigger': 'time', 'at': 7},
                        {'trigger': 'time', 'at': ['08:00:00']},
                        {'trigger': 'time', 'at': 'light.lamp'},
                        {'trigger': 'time'},
                        {'trigger': 'time', 'at': {'entity_id': 'sensor.x', 'offset': 'soon'}},
                        {'trigger': 'time', 'at': {'entity_id': 'sensor.x', 'extra': 1}},
                        {'trigger': 'time', 'at': {'offset': '00:30:00'}},
                        {'trigger': 'event'},
                        {'trigger': 'event', 'event_type': ['a']},
                        {'trigger': 'event', 'event_type': 'a', 'event_data': 'x'},
                        {'trigger': 'light.turned_on'},
                        {'trigger': 'light.turned_on', 'target': {'entity_id': 'light.a'}},
                        {'trigger': 'light.turned_on', 'target': {'label_id': 3}}):
            with self.subTest(trigger=trigger):
                sim = self.FakeSim({'automation_a': {'triggers': [trigger], 'actions': []}})
                with self.assertRaises(UnsupportedTrigger):
                    load_automations(sim, captured=['a'])

    def test_note_and_id_are_accepted_on_any_trigger(self):
        sim = self.FakeSim({'automation_a': {'triggers': [
            {'trigger': 'state', 'entity_id': 'sensor.x', 'id': 'i', 'note': 'comment'}], 'actions': []}})
        self.assertEqual(list(load_automations(sim, captured=['a'])), ['automation_a'])


@unittest.skipUnless(reference_available(), 'private reference or HA wrapper missing')
class CapturedAutomationTests(unittest.TestCase):
    def test_every_captured_trigger_loads(self):
        from tests.e2e.env import open_sim
        with open_sim('reference') as sim:
            loaded = load_automations(sim)
        self.assertGreater(len(loaded), 20)
        for config in loaded.values():
            self.assertIsInstance(config['triggers'], list)


if __name__ == '__main__':
    unittest.main()
