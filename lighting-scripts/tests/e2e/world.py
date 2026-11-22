"""World model of bulbs and switches for the e2e harness.

Both backends (the old Jinja scripts and the port) record the service calls
they make against the same simulator. The `World` turns each recorded call
into bulb and switch state, so a later task can compare where the lamps end
up rather than the commands that got them there. Payloads are parsed, never
compared as text: the backends format their JSON differently.

Assumptions (the plan gives no ruling, so they are stated here):
- A bulb starts on, at full level, with no colour ever sent.
- A bulb remembers its last level and colour across Off, so a bare `ON` brings
  it back as it was.
- A colour-only send to an off bulb is remembered and leaves it off.
- A transition ramps the level only; the colour takes its end value at once.
- Time never runs backwards between calls.
"""
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass
import json
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from dry_harness import DrySim


@dataclass(frozen=True)
class Kelvin:
    kelvin: int


@dataclass(frozen=True)
class Rgb:
    r: int
    g: int
    b: int


Colour = Kelvin | Rgb


@dataclass(frozen=True)
class Off:
    """Off has no level and no colour."""


@dataclass(frozen=True)
class On:
    level: int
    colour: Colour | None  # None only before any colour was ever sent
    effect: Literal['none', 'candle']


BulbState = Off | On


@dataclass(frozen=True)
class BulbInfo:
    topic: str
    candle_capable: bool


@dataclass(frozen=True)
class Line:
    """A transition in progress.

    A fade from Off ramps from level 0; a fade to Off ramps to 0 and is Off at `t1`.
    """
    start: BulbState
    end: BulbState
    t0: float
    t1: float


class UnhandledPayload(ValueError):
    """A recorded call carries a key or value the world does not model."""


class UnknownTarget(KeyError):
    """A recorded call names a topic, light or switch that the catalog lacks."""


Z2M_PREFIX = 'zigbee2mqtt/'
Z2M_SUFFIX = '/set'
PROFILE_LIGHT_PREFIX = 'light.ls_'
PROFILE_SWITCH_PREFIX = 'switch.ls_'
BRIDGE_SWITCH_PREFIX = 'switch.zigbee2mqtt_bridge_'
FIRST_LEVEL = 254
Z2M_KEYS = {'state', 'brightness', 'color_temp', 'color', 'transition', 'effect'}
START_EFFECTS = {'channel_change'}
STOP_EFFECTS = {'stop_effect', 'stop_colorloop'}
LIGHT_ON_KEYS = {'brightness', 'rgb_color', 'color_temp_kelvin', 'transition'}
LIGHT_OFF_KEYS = {'transition'}


@dataclass(frozen=True)
class _Change:
    """What one command asks of one bulb, already parsed."""
    power: Literal['on', 'off'] | None
    level: int | None
    colour: Colour | None
    transition: float
    effect: Literal['start', 'stop'] | None


class World:
    def __init__(self, bulbs: Mapping[str, BulbInfo], groups: Mapping[str, list[str]], switches: list[str],
                 ha_lights: Mapping[str, list[str]]):
        self._bulbs = dict(bulbs)
        self._groups = {topic: list(members) for topic, members in groups.items()}
        self._ha_lights = {entity: list(members) for entity, members in ha_lights.items()}
        self._by_topic = {info.topic: name for name, info in self._bulbs.items()}
        self._switches: dict[str, Literal['on', 'off']] = {entity: 'off' for entity in switches}
        self._settled: dict[str, BulbState] = {name: On(FIRST_LEVEL, None, 'none') for name in self._bulbs}
        self._lines: dict[str, Line] = {}
        self._last_level = {name: FIRST_LEVEL for name in self._bulbs}
        self._last_colour: dict[str, Colour | None] = {name: None for name in self._bulbs}

    def apply(self, call: dict, now: float) -> None:
        action = call['action']
        data = call['data']
        if action == 'mqtt.publish':
            if data['topic'].startswith(Z2M_PREFIX):
                self._publish(data['topic'], data['payload'], now)
        elif action in ('light.turn_on', 'light.turn_off'):
            keys = LIGHT_ON_KEYS if action == 'light.turn_on' else LIGHT_OFF_KEYS
            self._service(action, call['target'], data, now, keys, light=True, switch=False)
        elif action in ('switch.turn_on', 'switch.turn_off'):
            self._service(action, call['target'], data, now, set(), light=False, switch=True)
        elif action in ('homeassistant.turn_on', 'homeassistant.turn_off'):
            self._service(action, call['target'], data, now, set(), light=True, switch=True)

    def bulb(self, name: str, now: float) -> BulbState:
        line = self._lines.get(name)
        if line is not None and line.t0 <= now < line.t1:
            return self._along(line, now)
        return self._settled[name]

    def switch(self, entity: str) -> Literal['on', 'off']:
        return self._switches[entity]

    def press_switch_button(self, entity: str) -> None:
        self._switches[entity] = 'off' if self._switches[entity] == 'on' else 'on'

    def ha_states(self, now: float) -> dict[str, dict]:
        states: dict[str, dict] = {}
        for entity, names in self._ha_lights.items():
            lit = [state for state in (self.bulb(name, now) for name in names) if isinstance(state, On)]
            states[entity] = {'entity_id': entity, 'state': 'on' if lit else 'off',
                              'attributes': self._attributes(lit[0]) if lit else {}}
        for entity, power in self._switches.items():
            states[entity] = {'entity_id': entity, 'state': power, 'attributes': {}}
        return states

    @staticmethod
    def from_sim(sim: DrySim) -> 'World':
        """Bulbs, groups, lamps and plugs as the sim's catalog and state define them."""
        catalog = sim.run('effects_catalog')
        stems = {entity: _stem(topic) for entity, topic in catalog['topics'].items()}
        cohort = {stem for group in catalog['multicast'] if 'phase_cohort' in group
                  for stem in map(_stem, group['member_topics'].values())}
        bulbs = {stem: BulbInfo(topic=stem, candle_capable=stem in cohort) for stem in stems.values()}
        groups = {_stem(group['topic']): list(dict.fromkeys(map(_stem, group['member_topics'].values())))
                  for group in catalog['multicast']}
        lamps = {lamp: catalog['members'][lamp] for lamp in sim.members}

        def bulbs_of(entity: str, seen: tuple[str, ...] = ()) -> list[str]:
            if entity in stems:
                return [stems[entity]]
            if entity in lamps:
                return [stems[end] for end in lamps[entity]]
            children = sim.state.get(entity, {}).get('attributes', {}).get('entity_id')
            if not isinstance(children, list) or entity in seen:
                return []
            return list(dict.fromkeys(name for child in children for name in bulbs_of(child, (*seen, entity))))

        candidates = [*stems, *lamps, *catalog['groups'], *(
            entity for entity in sim.state
            if entity.startswith('light.') and not entity.startswith(PROFILE_LIGHT_PREFIX))]
        ha_lights = {entity: bulbs_of(entity) for entity in dict.fromkeys(candidates)}
        switches = [entity for entity in sim.state if entity.startswith('switch.')
                    and not entity.startswith((PROFILE_SWITCH_PREFIX, BRIDGE_SWITCH_PREFIX))]
        return World(bulbs, groups, switches, {entity: names for entity, names in ha_lights.items() if names})

    def _publish(self, topic: str, payload: str, now: float) -> None:
        if not topic.endswith(Z2M_SUFFIX):
            raise UnknownTarget(topic)
        stem = topic.removeprefix(Z2M_PREFIX).removesuffix(Z2M_SUFFIX)
        if stem in self._groups:
            names = self._groups[stem]
        elif stem in self._by_topic:
            names = [self._by_topic[stem]]
        else:
            raise UnknownTarget(topic)
        self._change(names, _parse_z2m(payload), now)

    def _service(self, action: str, target: dict, data: dict, now: float, keys: set[str], *,
                 light: bool, switch: bool) -> None:
        unknown = set(data) - keys
        if unknown:
            raise UnhandledPayload(f'{action}: {sorted(unknown)}')
        entities = target['entity_id']
        entities = [entities] if isinstance(entities, str) else list(entities)
        names: list[str] = []
        plugs: list[str] = []
        for entity in entities:
            if entity.startswith(PROFILE_LIGHT_PREFIX):
                continue
            if entity.startswith('light.') and light:
                if entity not in self._ha_lights:
                    raise UnknownTarget(entity)
                names.extend(self._ha_lights[entity])
            elif entity.startswith('switch.') and switch:
                if entity not in self._switches:
                    raise UnknownTarget(entity)
                plugs.append(entity)
            elif entity.startswith(('light.', 'switch.')) and not action.startswith('homeassistant.'):
                raise UnknownTarget(f'{action}: {entity}')
        on = action.endswith('turn_on')
        for entity in plugs:
            self._switches[entity] = 'on' if on else 'off'
        if names:
            self._change(list(dict.fromkeys(names)), _parse_light(on, data), now)

    def _change(self, names: list[str], change: _Change, now: float) -> None:
        for name in names:
            start = self.bulb(name, now)
            end = self._end(name, start, change)
            if isinstance(end, On):
                self._last_level[name] = end.level
            if change.colour is not None:
                self._last_colour[name] = change.colour
            self._settled[name] = end
            if change.transition > 0 and start != end:
                self._lines[name] = Line(start, end, now, now + change.transition)
            else:
                self._lines.pop(name, None)

    def _end(self, name: str, start: BulbState, change: _Change) -> BulbState:
        if change.power == 'off':
            return Off()
        if isinstance(start, Off) and change.power is None:
            return start
        level = change.level
        if level is None:
            level = start.level if isinstance(start, On) else self._last_level[name]
        colour = change.colour
        if colour is None:
            colour = start.colour if isinstance(start, On) else self._last_colour[name]
        effect = start.effect if isinstance(start, On) else 'none'
        if change.power == 'on':
            effect = 'none'
        if change.effect == 'start':
            effect = 'candle'
        elif change.effect == 'stop':
            effect = 'none'
        return On(level, colour, effect)

    @staticmethod
    def _along(line: Line, now: float) -> On:
        start_level = line.start.level if isinstance(line.start, On) else 0
        end_level = line.end.level if isinstance(line.end, On) else 0
        level = round(start_level + (end_level - start_level) * (now - line.t0) / (line.t1 - line.t0))
        lit = line.end if isinstance(line.end, On) else line.start
        assert isinstance(lit, On)  # a line has an On end; if its end is Off, its start is On
        return On(level, lit.colour, lit.effect)

    @staticmethod
    def _attributes(state: On) -> dict:
        attributes: dict = {'brightness': state.level}
        if isinstance(state.colour, Kelvin):
            attributes |= {'color_mode': 'color_temp', 'color_temp_kelvin': state.colour.kelvin}
        elif isinstance(state.colour, Rgb):
            attributes |= {'color_mode': 'rgb', 'rgb_color': [state.colour.r, state.colour.g, state.colour.b]}
        return attributes


def _stem(topic: str) -> str:
    return topic.removeprefix(Z2M_PREFIX).removesuffix(Z2M_SUFFIX)


def _parse_z2m(payload: str) -> _Change:
    body = json.loads(payload)
    if not isinstance(body, dict):
        raise UnhandledPayload(f'payload is not an object: {payload}')
    unknown = set(body) - Z2M_KEYS
    if unknown:
        raise UnhandledPayload(f'payload keys {sorted(unknown)}')
    power: Literal['on', 'off'] | None = None
    if 'state' in body:
        if body['state'] not in ('ON', 'OFF'):
            raise UnhandledPayload(f"state {body['state']!r}")
        power = 'on' if body['state'] == 'ON' else 'off'
    level = None
    if 'brightness' in body:
        level = round(body['brightness'])
        if power is None:
            power = 'on'
    colour: Colour | None = None
    if 'color_temp' in body:
        colour = Kelvin(round(1e6 / body['color_temp']))
    if 'color' in body:
        if not (isinstance(body['color'], dict) and set(body['color']) == {'rgb'}):
            raise UnhandledPayload(f"color {body['color']!r}")
        colour = Rgb(*(int(part) for part in body['color']['rgb'].split(',')))
    effect: Literal['start', 'stop'] | None = None
    if 'effect' in body:
        if body['effect'] in START_EFFECTS:
            effect = 'start'
        elif body['effect'] in STOP_EFFECTS:
            effect = 'stop'
        else:
            raise UnhandledPayload(f"effect {body['effect']!r}")
    return _Change(power, level, colour, float(body.get('transition', 0)), effect)


def _parse_light(on: bool, data: dict) -> _Change:
    level = round(data['brightness']) if 'brightness' in data else None
    colour: Colour | None = None
    if 'rgb_color' in data:
        colour = Rgb(*(int(part) for part in data['rgb_color']))
    if 'color_temp_kelvin' in data:
        colour = Kelvin(round(data['color_temp_kelvin']))
    return _Change('on' if on else 'off', level, colour, float(data.get('transition', 0)), None)
