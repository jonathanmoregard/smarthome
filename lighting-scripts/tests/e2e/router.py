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
from datetime import date, datetime, time, timedelta
import json
from pathlib import Path
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
class Trigger:
    kind: str
    options: Mapping
    index: int

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
        _check_values(name, index, kind, raw)
        triggers.append(Trigger(kind, raw, index))
    return triggers


def _check_values(name: str, index: int, kind: str, raw: Mapping) -> None:
    where = f'{name}[{index}]'
    if kind == 'homeassistant' and raw.get('event') != 'start':
        raise UnsupportedTrigger(f'{where}: homeassistant event {raw.get("event")!r}')
    if kind == 'time_pattern' and not (raw.keys() & {'seconds', 'minutes'}):
        raise UnsupportedTrigger(f'{where}: time_pattern needs seconds or minutes')
    if kind == 'time_pattern':
        for field in ('seconds', 'minutes'):
            if field in raw:
                _pattern(where, raw[field])
    if kind == 'mqtt' and '#' in raw['topic']:
        raise UnsupportedTrigger(f'{where}: mqtt topic wildcard #')


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
        window = _local(previous_tick), _local(inp.now)
        instants = _pattern_instants(options, *window) if trigger.kind == 'time_pattern' \
            else _time_instants(house, options['at'], *window)
        for instant in instants:
            yield instant, {'now': instant.isoformat()}


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
    if not _topic_matches(options['topic'], inp.topic):
        return None
    try:
        parsed = {'payload_json': json.loads(inp.payload)}
    except ValueError:
        parsed = {}
    payload = inp.payload
    if 'value_template' in options:
        if house.render is None:
            raise RuntimeError('An mqtt value_template needs House.render')
        result = house.render(options['value_template'], {'value': inp.payload, **(
            {'value_json': parsed['payload_json']} if parsed else {})})
        if 'payload' not in options and not result:
            return None
        payload = result   # Home Assistant compares the rendered value with `payload`
    if 'payload' in options and payload != options['payload']:
        return None
    return {'topic': inp.topic, 'payload': payload, **parsed}


def _topic_matches(pattern: str, topic: str) -> bool:
    wanted, actual = pattern.split('/'), topic.split('/')
    return len(wanted) == len(actual) and all(w in ('+', a) for w, a in zip(wanted, actual))


# --- time ------------------------------------------------------------------

def _local(moment: datetime) -> datetime:
    return moment.replace(tzinfo=LOCAL) if moment.tzinfo is None else moment.astimezone(LOCAL)


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
    """Whole seconds in (after, until] whose minute and second match the pattern."""
    seconds = _pattern('', options['seconds']) if 'seconds' in options else ('=', 0)
    minutes = _pattern('', options['minutes']) if 'minutes' in options else (
        ('*', 1) if 'seconds' in options else ('=', 0))
    instants = []
    moment = after.replace(microsecond=0)
    if moment <= after:
        moment += timedelta(seconds=1)
    end = until.replace(microsecond=0)
    while moment <= end:
        if _pattern_matches(seconds, moment.second) and _pattern_matches(minutes, moment.minute):
            instants.append(moment)
        moment += timedelta(seconds=1)
    return instants


def _time_instants(house: House, at, after: datetime, until: datetime) -> list[datetime]:
    """Instants of the `time` trigger's `at` that fall in (after, until]."""
    if isinstance(at, Mapping):
        return _entity_instants(house, at['entity_id'], after, until, _offset(at.get('offset', '00:00:00')))
    if _is_literal(at):
        return _daily(time.fromisoformat(at), after, until, timedelta(0))
    return _entity_instants(house, at, after, until, timedelta(0))


def _is_literal(at: str) -> bool:
    return len(at) == 8 and at[2] == ':' and at[5] == ':'


def _offset(text: str) -> timedelta:
    sign = -1 if text.startswith('-') else 1
    hours, minutes, seconds = (int(part) for part in text.lstrip('+-').split(':'))
    return sign * timedelta(hours=hours, minutes=minutes, seconds=seconds)


def _daily(at: time, after: datetime, until: datetime, offset: timedelta) -> list[datetime]:
    """`at` local time on every day, shifted by `offset`, falling in (after, until]."""
    instants = []
    day = after.date() - timedelta(days=2)
    while day <= until.date() + timedelta(days=2):
        moment = _local_instant(day, at) + offset
        if after < moment <= until:
            instants.append(moment)
        day += timedelta(days=1)
    return instants


def _local_instant(day: date, at: time) -> datetime:
    """The first occurrence of `at` on `day` in Stockholm (fold=0 picks the earlier of an ambiguous time)."""
    return datetime.combine(day, at, tzinfo=LOCAL).astimezone(LOCAL)


def _entity_instants(house: House, entity: str, after: datetime, until: datetime, offset: timedelta) -> list[datetime]:
    helper = house.helpers.get(entity)
    if helper is None or helper['state'] in UNAVAILABLE:
        return []
    value = helper['state']
    attributes = helper.get('attributes', {})
    has_date = attributes['has_date'] if 'has_date' in attributes else '-' in value and not value.endswith('Z')
    has_time = attributes['has_time'] if 'has_time' in attributes else ':' in value
    if has_time and not has_date:
        return _daily(time.fromisoformat(value), after, until, offset)
    if has_date and not has_time:
        moments = [_local_instant(date.fromisoformat(value), time(0, 0, 0))]
    else:
        parsed = datetime.fromisoformat(value)
        moments = [parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=LOCAL)]
    return [moment for moment in (m.astimezone(LOCAL) + offset for m in moments) if after < moment <= until]
