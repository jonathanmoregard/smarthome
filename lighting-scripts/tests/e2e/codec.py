"""Tagged JSON for everything the harness carries between processes.

Every dataclass encodes as `{"kind": "<ClassName>", ...fields}`. Values JSON has
no type for are tagged too, so a round trip is exact: a tuple stays a tuple, a
frozenset stays a frozenset, a datetime keeps its offset, and a plain dict is
wrapped so that a payload which happens to hold a `kind` key is never taken for
a tag. Only str, int, float, bool, None and list pass through unwrapped.

Also home to the scenario `Step` variants, `Seed`, `Checkpoint` and the house
description (`HouseInfo`), which only exist to be carried: the runner builds
them, the backends and the comparator read them.
"""
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass, fields, is_dataclass
from datetime import datetime
from typing import Literal, Union

from tests.e2e.router import Context, Event, HaStart, Input, Mqtt, ScriptCall, StateChanged, Tick
from tests.e2e.world import BulbState, Kelvin, Off, On, Rgb


@dataclass(frozen=True)
class Advance:
    """Move the scenario clock forward by `seconds`."""
    seconds: float


@dataclass(frozen=True)
class PressSwitch:
    """A press on a switch's own physical button."""
    entity: str


@dataclass(frozen=True)
class PersonLightChange:
    """A person's `light.turn_on` through Home Assistant."""
    entities: list[str]
    service_data: dict


@dataclass(frozen=True)
class PowerCut:
    """The wall power to these bulbs goes: their lights become unavailable and they ignore every command."""
    bulbs: tuple[str, ...]


@dataclass(frozen=True)
class PowerRestore:
    """The power comes back: each bulb returns as it was at the cut (Zigbee2MQTT `power_on_behavior: previous`)."""
    bulbs: tuple[str, ...]


Step = Union[Input, Advance, PressSwitch, PersonLightChange, PowerCut, PowerRestore]


@dataclass(frozen=True)
class Seed:
    """An entity's state written before the first step, silently: a captured initial state, not an input."""
    entity: str
    state: str
    attributes: Mapping[str, object]


# --- the house, as a scenario picks its entities by role ---------------------------------------------------

@dataclass(frozen=True)
class LampInfo:
    lamp: str   # the lamp's light entity, one of the house schedule's members
    room: str
    bulbs: tuple[str, ...]
    candle_capable: bool   # every bulb of the lamp can run the firmware candle


@dataclass(frozen=True)
class RemoteInfo:
    room: str | None   # the area of the remote's device; None: it has none, so a press does nothing
    topic: str
    presses: tuple[str, ...]   # the payloads the captured mqtt triggers on `topic` fire on


@dataclass(frozen=True)
class HelperInfo:
    """A schedule helper: a block's light (`input_text`), start or weekend start (`input_datetime`), fade
    (`input_number`), or own light / own timing switch (`input_boolean`).

    `room` and `lamp` are both None for the house's own helpers; a lamp's helper names its lamp and the lamp's room.
    (`setting`, not `kind`: `kind` is the codec's tag.) `state` and `attributes` are the helper as the simulator
    holds it before the first step, so a seed can change the state and keep the attributes (`min`, `max`, ...).
    """
    entity: str
    room: str | None
    lamp: str | None
    block: Literal['day', 'cosy', 'night']
    setting: Literal['light', 'start', 'weekend', 'fade', 'own_light', 'own_timing']
    state: str
    attributes: Mapping[str, object]


@dataclass(frozen=True)
class HouseInfo:
    rooms: tuple[str, ...]
    lamps: tuple[LampInfo, ...]
    remotes: tuple[RemoteInfo, ...]
    plugs: tuple[str, ...]
    helpers: tuple[HelperInfo, ...]
    dashboard_options: Mapping[str, tuple]   # '<dashboard script>.<field>' -> the field's select options
    mode_switch: str | None   # the input_boolean a person flips to turn the house mode on and off; None: none captured


@dataclass(frozen=True)
class Checkpoint:
    step: int  # index of the step this checkpoint belongs to; several per step while fading
    # Nominal seconds since scenario start, from the runner's step clock. Never the
    # sim clock: ls_commit nudges that by 1e-6 s and reference delays advance it inline.
    t: float
    bulbs: Mapping[str, BulbState]
    switches: Mapping[str, Literal['on', 'off']]
    dashboard: Mapping[str, object]  # sensor.ls_overrides attributes switch_ranges and range_defaults
    in_fade: frozenset[str]  # bulbs with an active Line at t (includes a fade from Off at t0, level 0)
    not_ported: tuple[str, ...]  # automations the port had no handler for, during this step


class UnknownKind(ValueError):
    """A tagged object names a kind the codec does not know."""


class MalformedKind(ValueError):
    """A tagged object has a missing or unexpected field for its kind."""


_KINDS = {cls.__name__: cls for cls in (
    HaStart, Tick, StateChanged, Event, Mqtt, ScriptCall, Context,
    Advance, PressSwitch, PersonLightChange, PowerCut, PowerRestore, Seed,
    LampInfo, RemoteInfo, HelperInfo, HouseInfo,
    Off, On, Kelvin, Rgb, Checkpoint)}
_TAGGED = [name for name, cls in _KINDS.items() if 'kind' in {f.name for f in fields(cls)}]
if _TAGGED:
    raise TypeError(f'a field named kind would overwrite the tag: {_TAGGED}')


def encode(value: object) -> object:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, datetime):
        if value.utcoffset() is None:
            raise TypeError('cannot encode a naive datetime')
        return {'kind': 'datetime', 'iso': value.isoformat()}
    if is_dataclass(value) and not isinstance(value, type):
        name = type(value).__name__
        if _KINDS.get(name) is not type(value):
            raise TypeError(f'cannot encode {name}: not a known kind')
        return {'kind': name, **{f.name: encode(getattr(value, f.name)) for f in fields(value)}}
    if isinstance(value, list):
        return [encode(item) for item in value]
    if isinstance(value, tuple):
        return {'kind': 'tuple', 'items': [encode(item) for item in value]}
    if isinstance(value, frozenset):
        return {'kind': 'frozenset', 'items': sorted((encode(item) for item in value), key=repr)}
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise TypeError('cannot encode a mapping with non-string keys')
        return {'kind': 'dict', 'items': {key: encode(item) for key, item in value.items()}}
    raise TypeError(f'cannot encode {type(value).__name__}')


def decode(obj: object) -> object:
    if isinstance(obj, list):
        return [decode(item) for item in obj]
    if not isinstance(obj, dict):
        return obj
    kind = obj.get('kind')
    if kind == 'datetime':
        return datetime.fromisoformat(obj['iso'])
    if kind == 'tuple':
        return tuple(decode(item) for item in obj['items'])
    if kind == 'frozenset':
        return frozenset(decode(item) for item in obj['items'])
    if kind == 'dict':
        return {key: decode(item) for key, item in obj['items'].items()}
    cls = _KINDS.get(kind) if isinstance(kind, str) else None
    if cls is None:
        raise UnknownKind(f'unknown kind {kind!r}')
    expected = [f.name for f in fields(cls)]
    missing = [name for name in expected if name not in obj]
    if missing:
        raise MalformedKind(f'{kind}: missing field {missing[0]!r}')
    unexpected = sorted(key for key in obj if key != 'kind' and key not in expected)
    if unexpected:
        raise MalformedKind(f'{kind}: unexpected field {unexpected[0]!r}')
    return cls(**{name: decode(obj[name]) for name in expected})
