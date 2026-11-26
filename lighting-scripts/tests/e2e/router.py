"""Route Home Assistant inputs to the automations they fire.

Given one input (a start, a clock tick, a state change, an event, an MQTT
message or a dashboard script call) and the captured automations, `route`
answers what Home Assistant would run and with which `trigger` variable. It is
backend-blind: it never looks at what either backend can execute, and it does
not touch the World. Conditions are not evaluated here; the run does that.

Each automation fires at most once per instant, with its first matching
trigger. A `Tick` can span several instants (`time_pattern`, `time`), and each
instant is its own firing.
"""
from __future__ import annotations
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import json
import re
from typing import Union
from zoneinfo import ZoneInfo

LOCAL = ZoneInfo('Europe/Stockholm')
DASHBOARD_SCRIPTS = ('ls_override_block', 'ls_clear_overrides', 'ls_range_save')
# Never routed: `DrySim.event` already runs the store writer inline for these.
INLINE_EVENTS = ('ls_override',)
# Options every trigger kind accepts. `note` is a free-text comment the captures carry.
COMMON_OPTIONS = frozenset({'trigger', 'platform', 'id', 'note'})
STATE_OPTIONS = frozenset({'entity_id', 'to', 'from', 'not_to', 'attribute'})
UNAVAILABLE = ('unknown', 'unavailable', '')
_TIME_ENTITY = re.compile(r'(input_datetime|sensor)\.[a-z0-9_]+')
_OFFSET = re.compile(r'-?\d+:\d{2}(:\d{2})?')


class UnsupportedTrigger(ValueError):
    """A captured trigger uses a kind or option the router does not model."""


@dataclass(frozen=True)
class Context:
    id: str
    user_id: str | None
    parent_id: str | None = None


@dataclass(frozen=True)
class HaStart:
    pass


@dataclass(frozen=True)
class Tick:
    now: datetime


@dataclass(frozen=True)
class StateChanged:
    entity: str
    old: dict | None
    new: dict
    context: Context


@dataclass(frozen=True)
class Event:
    type: str
    data: dict
    context: Context


@dataclass(frozen=True)
class Mqtt:
    topic: str
    payload: str


@dataclass(frozen=True)
class ScriptCall:
    script: str
    data: dict
    context: Context


Input = Union[HaStart, Tick, StateChanged, Event, Mqtt, ScriptCall]


@dataclass(frozen=True)
class AutomationRun:
    name: str
    trigger: dict


@dataclass(frozen=True)
class ScriptRun:
    name: str
    data: dict


Run = Union[AutomationRun, ScriptRun]


@dataclass(frozen=True)
class House:
    automations: Mapping[str, dict]
    helpers: Mapping[str, dict]   # entity id -> HA state object
    labels: Mapping[str, list[str]]   # label id -> entity ids
    render: Callable[[str, dict], object] | None = None


def load_automations(sim, captured: Iterable[str] | None = None) -> dict[str, dict]:
    """One entry per capture, keyed `automation_<file stem>`.

    `DrySim` also holds each capture under its id and the legacy gesture
    aliases, and the preserved reference's own automations; only the captures
    are returned. Every trigger is parsed so an unsupported one fails here.
    """
    if captured is None:
        from tests.e2e.env import LIVE
        captured = [path.stem for path in sorted((LIVE / 'automations').glob('*.json'))]
    loaded = {}
    for stem in captured:
        key = 'automation_' + stem
        if key in sim.automations:   # a blueprint capture has no actions, so DrySim skips it
            loaded[key] = sim.automations[key]
            _triggers(key, loaded[key])
    return loaded


def route(house: House, inp: Input, previous_tick: datetime | None) -> list[Run]:
    if isinstance(inp, ScriptCall):
        if inp.script not in DASHBOARD_SCRIPTS:
            raise ValueError(f'Not a dashboard script: {inp.script!r}')
        return [ScriptRun(inp.script, inp.data)]
    if isinstance(inp, Event) and inp.type in INLINE_EVENTS:
        return []
    firings: list[tuple[datetime | None, int, AutomationRun]] = []
    for order, (name, config) in enumerate(house.automations.items()):
        for instant, trigger in _first_matches(house, name, config, inp, previous_tick).items():
            firings.append((instant, order, AutomationRun(name, trigger)))
    firings.sort(key=lambda firing: (firing[0] is not None, firing[0], firing[1]))
    return [run for _, _, run in firings]


# --- trigger parsing -------------------------------------------------------

@dataclass(frozen=True)
class AtTime:
    """`time` trigger at a literal local time of day."""
    at: time


@dataclass(frozen=True)
class AtEntity:
    """`time` trigger at the value of an input_datetime or timestamp sensor, shifted by `offset`."""
    entity: str
    offset: timedelta


@dataclass(frozen=True)
class Trigger:
    kind: str
    options: Mapping
    index: int
    at: AtTime | AtEntity | None = None

    @property
    def id(self) -> str:
        return str(self.options['id']) if 'id' in self.options else str(self.index)

    def trigger_dict(self, **fields) -> dict:
        return {'platform': self.kind, **fields, 'id': self.id, 'idx': str(self.index)}


def _triggers(name: str, config: Mapping) -> list[Trigger]:
    triggers = []
    for index, raw in enumerate(config.get('triggers', config.get('trigger', []))):
        kind = raw.get('trigger', raw.get('platform'))
        allowed = KINDS.get(kind)
        if allowed is None:
            raise UnsupportedTrigger(f'{name}[{index}]: trigger kind {kind!r}')
        unknown = set(raw) - COMMON_OPTIONS - allowed
        if unknown:
            raise UnsupportedTrigger(f'{name}[{index}]: {kind} option(s) {sorted(unknown)}')
        triggers.append(_parse(f'{name}[{index}]', kind, raw, index))
    return triggers


def _parse(where: str, kind: str, raw: Mapping, index: int) -> Trigger:
    at = None
    if kind == 'homeassistant' and raw.get('event') != 'start':
        raise UnsupportedTrigger(f'{where}: homeassistant event {raw.get("event")!r}')
    if kind == 'time_pattern':
        if not (raw.keys() & {'seconds', 'minutes'}):
            raise UnsupportedTrigger(f'{where}: time_pattern needs seconds or minutes')
        for field in ('seconds', 'minutes'):
            if field in raw:
                _pattern(where, raw[field])
    if kind == 'time':
        at = _parse_at(where, raw.get('at'))
    if kind == 'event':
        if not isinstance(raw.get('event_type'), str):
            raise UnsupportedTrigger(f'{where}: event_type {raw.get("event_type")!r}')
        if not isinstance(raw.get('event_data', {}), Mapping):
            raise UnsupportedTrigger(f'{where}: event_data {raw["event_data"]!r}')
    if kind == 'mqtt':
        if not isinstance(raw.get('topic'), str) or '#' in raw['topic']:
            raise UnsupportedTrigger(f'{where}: mqtt topic {raw.get("topic")!r}')
    if kind == 'state' and not all(isinstance(entity, str) for entity in _as_list(raw.get('entity_id'))):
        raise UnsupportedTrigger(f'{where}: state entity_id {raw.get("entity_id")!r}')
    if kind == 'light.turned_on':
        target = raw.get('target')
        labels = target.get('label_id') if isinstance(target, Mapping) and set(target) == {'label_id'} else None
        if labels is None or not all(isinstance(label, str) for label in _as_list(labels)):
            raise UnsupportedTrigger(f'{where}: light.turned_on target {target!r}')
    return Trigger(kind, raw, index, at)


def _parse_at(where: str, value) -> AtTime | AtEntity:
    """HA's `time` `at`: "HH:MM", "HH:MM:SS", an entity id, or {entity_id, offset}."""
    if isinstance(value, str):
        literal = _parse_time(value)
        if literal is not None:
            return AtTime(literal)
        if _TIME_ENTITY.fullmatch(value):
            return AtEntity(value, timedelta(0))
    elif isinstance(value, Mapping) and set(value) <= {'entity_id', 'offset'}:
        entity, offset = value.get('entity_id'), value.get('offset', '00:00:00')
        if isinstance(entity, str) and _TIME_ENTITY.fullmatch(entity) and isinstance(offset, str) \
                and _OFFSET.fullmatch(offset):
            return AtEntity(entity, _offset(offset))
    raise UnsupportedTrigger(f'{where}: time at {value!r}')


def _parse_time(text: str) -> time | None:
    parts = text.split(':')
    if len(parts) not in (2, 3):
        return None
    try:
        hour, minute, second = (int(part) for part in (parts + ['0'])[:3])
        return time(hour, minute, second)
    except ValueError:
        return None


KINDS: dict[str, frozenset[str]] = {
    'homeassistant': frozenset({'event'}),
    'state': STATE_OPTIONS,
    'time_pattern': frozenset({'seconds', 'minutes'}),
    'time': frozenset({'at'}),
    'event': frozenset({'event_type', 'event_data'}),
    'mqtt': frozenset({'topic', 'payload', 'value_template'}),
    'light.turned_on': frozenset({'target'}),
}


# --- matching --------------------------------------------------------------

def _first_matches(house: House, name: str, config: Mapping, inp: Input,
                   previous_tick: datetime | None) -> dict[datetime | None, dict]:
    """instant (None for an input with no instant) -> trigger dict of the first trigger that fires then."""
    matches: dict[datetime | None, dict] = {}
    for trigger in _triggers(name, config):
        for instant, fields in _fire(house, trigger, inp, previous_tick):
            matches.setdefault(instant, trigger.trigger_dict(**fields))
    return matches


def _fire(house: House, trigger: Trigger, inp: Input, previous_tick: datetime | None):
    """(instant, trigger fields) for each firing of `trigger` on `inp`."""
    options = trigger.options
    if trigger.kind == 'homeassistant':
        if isinstance(inp, HaStart):
            yield None, {'event': 'start'}
    elif trigger.kind == 'state':
        if isinstance(inp, StateChanged) and _state_fires(options, inp):
            yield None, _state_fields(inp)
    elif trigger.kind == 'light.turned_on':
        if isinstance(inp, StateChanged) and _light_turned_on(house, options, inp):
            yield None, _state_fields(inp)
    elif trigger.kind == 'event':
        if isinstance(inp, Event) and _event_fires(options, inp):
            yield None, {'event': {'event_type': inp.type, 'data': inp.data, 'context': _context(inp.context)}}
    elif trigger.kind == 'mqtt':
        if isinstance(inp, Mqtt):
            fields = _mqtt_fields(house, options, inp)
            if fields is not None:
                yield None, fields
    elif isinstance(inp, Tick) and previous_tick is not None:
        window = _utc(previous_tick), _utc(inp.now)
        instants = _pattern_instants(options, *window) if trigger.kind == 'time_pattern' \
            else _time_instants(house, trigger.at, *window)
        for instant in instants:
            yield instant, {'now': instant.astimezone(LOCAL).isoformat()}


def _state_fields(inp: StateChanged) -> dict:
    return {'entity_id': inp.entity, 'from_state': inp.old, 'to_state': inp.new}


def _as_list(value) -> list:
    return list(value) if isinstance(value, (list, tuple)) else [value]


def _state_fires(options: Mapping, inp: StateChanged) -> bool:
    if inp.entity not in _as_list(options['entity_id']):
        return False
    attribute = options.get('attribute')
    if attribute is None:
        old = None if inp.old is None else inp.old['state']
        new = inp.new['state']
    else:
        old = None if inp.old is None else inp.old['attributes'].get(attribute)
        new = inp.new['attributes'].get(attribute)
    filtered = bool(options.keys() & {'to', 'from', 'not_to'})
    if inp.old is not None and old == new and (attribute is not None or filtered):
        return False   # an attribute-only change is not a state change; an attribute trigger needs its attribute to move
    if 'from' in options and old not in _as_list(options['from']):
        return False
    if 'to' in options and new not in _as_list(options['to']):
        return False
    if 'not_to' in options and new in _as_list(options['not_to']):
        return False
    return True


def _light_turned_on(house: House, options: Mapping, inp: StateChanged) -> bool:
    labelled = {entity for label in _as_list(options['target']['label_id']) for entity in house.labels.get(label, [])}
    return (inp.entity in labelled and inp.entity.startswith('light.') and inp.old is not None
            and inp.old['state'] == 'off' and inp.new['state'] == 'on')


def _event_fires(options: Mapping, inp: Event) -> bool:
    return inp.type == options['event_type'] and _subset(options.get('event_data', {}), inp.data)


def _subset(wanted, actual) -> bool:
    if isinstance(wanted, Mapping):
        return isinstance(actual, Mapping) and all(key in actual and _subset(value, actual[key])
                                                   for key, value in wanted.items())
    return wanted == actual


def _context(context: Context) -> dict:
    return {'id': context.id, 'user_id': context.user_id, 'parent_id': context.parent_id}


def _mqtt_fields(house: House, options: Mapping, inp: Mqtt) -> dict | None:
    """As HA's mqtt trigger: `payload` is only checked when given, against the rendered value (if any)."""
    if not _topic_matches(options['topic'], inp.topic):
        return None
    try:
        parsed = {'payload_json': json.loads(inp.payload)}
    except ValueError:
        parsed = {}
    if 'payload' in options:
        rendered = inp.payload
        if 'value_template' in options:
            if house.render is None:
                raise RuntimeError('An mqtt value_template needs House.render')
            try:
                rendered = house.render(options['value_template'], {'value': inp.payload, **(
                    {'value_json': parsed['payload_json']} if parsed else {})})
            except Exception:
                rendered = ''   # HA's error_value: a template that fails never matches
        if rendered != options['payload']:
            return None
    return {'topic': inp.topic, 'payload': inp.payload, **parsed}


def _topic_matches(pattern: str, topic: str) -> bool:
    wanted, actual = pattern.split('/'), topic.split('/')
    return len(wanted) == len(actual) and all(w in ('+', a) for w, a in zip(wanted, actual))


# --- time ------------------------------------------------------------------
# Instants are compared and stepped in UTC. Wall-clock arithmetic on aware
# datetimes ignores DST. For a literal time and for time_pattern, Home Assistant
# fires on every existing local instant that matches: an ambiguous time (clocks
# back) fires in both folds, a skipped time (clocks forward) does not fire that
# day (homeassistant/util/dt.py find_next_time_expression_time, used through
# helpers/event.py async_track_time_change).

def _utc(moment: datetime) -> datetime:
    return (moment.replace(tzinfo=LOCAL) if moment.tzinfo is None else moment).astimezone(timezone.utc)


def _pattern(where: str, value) -> tuple[str, int]:
    text = str(value)
    if text == '*':
        return '*', 1
    if text.startswith('/') and text[1:].isdigit() and int(text[1:]) > 0:
        return '/', int(text[1:])
    if text.isdigit():
        return '=', int(text)
    raise UnsupportedTrigger(f'{where}: time_pattern value {value!r}')


def _pattern_matches(pattern: tuple[str, int], value: int) -> bool:
    mode, number = pattern
    return mode == '*' or (mode == '/' and value % number == 0) or (mode == '=' and value == number)


def _pattern_instants(options: Mapping, after: datetime, until: datetime) -> list[datetime]:
    """Whole UTC seconds in (after, until] whose local minute and second match the pattern."""
    seconds = _pattern('', options['seconds']) if 'seconds' in options else ('=', 0)
    minutes = _pattern('', options['minutes']) if 'minutes' in options else (
        ('*', 1) if 'seconds' in options else ('=', 0))
    instants = []
    moment = after.replace(microsecond=0)
    if moment <= after:
        moment += timedelta(seconds=1)
    end = until.replace(microsecond=0)
    while moment <= end:
        local = moment.astimezone(LOCAL)
        if _pattern_matches(seconds, local.second) and _pattern_matches(minutes, local.minute):
            instants.append(moment)
        moment += timedelta(seconds=1)
    return instants


def _time_instants(house: House, at: AtTime | AtEntity, after: datetime, until: datetime) -> list[datetime]:
    """Instants of the `time` trigger's `at` that fall in (after, until]."""
    if isinstance(at, AtTime):
        return _daily(at.at, after, until, timedelta(0))
    return _entity_instants(house, at, after, until)


def _offset(text: str) -> timedelta:
    sign = -1 if text.startswith('-') else 1
    parts = [int(part) for part in text.lstrip('-').split(':')]
    hours, minutes, seconds = (parts + [0])[:3]
    return sign * timedelta(hours=hours, minutes=minutes, seconds=seconds)


def _daily(at: time, after: datetime, until: datetime, offset: timedelta) -> list[datetime]:
    """Each existing local `at` (both folds when ambiguous), shifted by `offset`, in (after, until]."""
    instants = []
    day = after.astimezone(LOCAL).date() - timedelta(days=2)
    while day <= until.astimezone(LOCAL).date() + timedelta(days=2):
        for moment in _local_instants(day, at):
            if after < moment + offset <= until:
                instants.append(moment + offset)
        day += timedelta(days=1)
    return sorted(instants)


def _local_instants(day: date, at: time) -> set[datetime]:
    """UTC instants at which the Stockholm wall clock reads `at` on `day`; empty when the time is skipped."""
    wall = datetime.combine(day, at)
    instants = set()
    for fold in (0, 1):
        moment = wall.replace(tzinfo=LOCAL, fold=fold).astimezone(timezone.utc)
        if moment.astimezone(LOCAL).replace(tzinfo=None) == wall:   # a skipped time does not round-trip
            instants.add(moment)
    return instants


def _entity_instants(house: House, at: AtEntity, after: datetime, until: datetime) -> list[datetime]:
    helper = house.helpers.get(at.entity)
    if helper is None or helper['state'] in UNAVAILABLE:
        return []
    value = helper['state']
    attributes = helper.get('attributes', {})
    has_date = attributes['has_date'] if 'has_date' in attributes else '-' in value and not value.endswith('Z')
    has_time = attributes['has_time'] if 'has_time' in attributes else ':' in value
    if has_time and not has_date:
        return _daily(time.fromisoformat(value), after, until, at.offset)
    if has_date and not has_time:
        moments = _local_instants(date.fromisoformat(value), time(0, 0, 0))
    else:
        parsed = datetime.fromisoformat(value)
        moments = {_utc(parsed)}
    return sorted(moment + at.offset for moment in moments if after < moment + at.offset <= until)
