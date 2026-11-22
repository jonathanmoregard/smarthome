"""The golden scenarios, built from the house description at run time.

Every entity a scenario uses is picked by role from `HouseInfo` (the first room
with a placed remote, the reference's candle lamp, that room's plug, the mode
switch), never by name, so no household name is written here. A role the house
does not have raises `MissingRole` in the scenarios that need it, and only there.

Each scenario starts from `seeds_for`: every schedule helper the house has gets
a generated value of its own (ruling 9). A scenario then pins what its proof
needs: the house's block times and lights, and its subject room following the
house. `proves` names pairs of steps whose reference checkpoints must differ on
what the scenario's own input acts on (ruling 55): the subject room's bulbs, the
plug, the candle lamp; the whole house only for the schedule and DST. The pairs
are chosen so the scripts, not the world moving by itself, make the change.
`holds` names pairs that must not differ there.

Blocks, as the captured `ls_base` places them: a day start belongs to the
morning after its evening; cosy and night belong to their evening, a night
start before noon to the small hours after it. Friday and Saturday evenings,
and Saturday and Sunday mornings, use the `_weekend` starts. A fade ends at its
block's start.
"""
from __future__ import annotations
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
import json
import random
import zlib

from tests.e2e.codec import (Advance, HelperInfo, HouseInfo, LampInfo, PersonLightChange, PowerCut, PowerRestore,
                             PressSwitch, RemoteInfo, Seed, Step)
from tests.e2e.router import LOCAL, Context, HaStart, Mqtt, ScriptCall, StateChanged

NAMES = ('schedule_day', 'remote_presses', 'dashboard_block_then_clear', 'range_save', 'person_change_then_expiry',
         'mode_toggle', 'plug_button', 'wall_power_cycle', 'ha_restart_mid_fade', 'midnight_weekend', 'dst_spring',
         'dst_autumn', 'candle_lamp_evening')
BLOCKS = ('day', 'cosy', 'night')
NORMAL, CANDLE = 'Normal light', 'Candle'   # never Breathe or Colour loop
# The captured overlay expiry rules a scenario sets (system helpers, in `HouseInfo.overlay_rules`). On, the
# next-block rule ends an overlay at the next block's fade; the after rule ends it `AFTER_MINUTES` after it began.
NEXT_BLOCK_RULE = 'input_boolean.ls_ovr_next_block_on'
AFTER_RULE = 'input_boolean.ls_ovr_after_on'
AFTER_MINUTES = 'input_number.ls_ovr_after_min'
OVERLAY_MINUTES = 180            # what the scenarios that expire an overlay set it to (the live value)
PERSON = 'e2e-person'
PRESS_GAP = 120                  # seconds between remote presses
SETTLE = 120                     # seconds after an input before its checkpoint is read as settled
PERSON_LEVEL = 8                 # a person's brightness no seeded light uses (they draw from LEVELS)
PERSON_KELVIN = 3300             # and a colour unlike the pinned house lights; both channels, so all of it holds
LEVELS = (40, 255)               # generated light brightness
KELVINS = (2200, 6500)
FADES = (0, 45)                  # generated fade minutes, within each helper's own min/max
# Generated block starts, minutes after midnight, so the blocks keep their order: day, cosy, then night.
START_WINDOWS = {'day': (5 * 60, 10 * 60), 'cosy': (16 * 60, 21 * 60), 'night': (21 * 60 + 30, 25 * 60 + 30)}
WEEKDAY = datetime(2026, 11, 18, tzinfo=LOCAL)   # a Wednesday, far from a DST change
FRIDAY = datetime(2026, 11, 20, tzinfo=LOCAL)
SPRING_EVE = datetime(2026, 3, 28, tzinfo=LOCAL)   # the Saturday before the last Sunday of March
AUTUMN_EVE = datetime(2026, 10, 24, tzinfo=LOCAL)   # the Saturday before the last Sunday of October

# The house schedule a scenario pins, per block: (weekday start, weekend start, fade minutes), and its lights.
HOUSE_TIMES = {'day': ('07:00', '08:30', 20), 'cosy': ('18:00', '19:00', 30), 'night': ('23:00', '23:45', 15)}
HOUSE_LIGHTS = {
    'day': {'on': True, 'b': 230, 'm': 'ct', 'k': 4500, 'effect': NORMAL},
    'cosy': {'on': True, 'b': 90, 'm': 'ct', 'k': 2400, 'effect': NORMAL},
    'night': {'on': True, 'b': 25, 'm': 'hs', 'h': 20.0, 's': 80.0, 'effect': NORMAL},
}


class MissingRole(LookupError):
    """The house has nothing to play a role a scenario needs: a named coverage gap, never a stand-in."""


@dataclass(frozen=True)
class Proof:
    """Steps `first` and `second`, compared on these bulbs and switches only (never the dashboard)."""
    first: int
    second: int
    bulbs: tuple[str, ...]
    switches: tuple[str, ...]


@dataclass(frozen=True)
class Scenario:
    name: str
    start: datetime
    seeds: tuple[Seed, ...]
    steps: tuple[Step, ...]
    proves: tuple[Proof, ...]    # their reference checkpoints differ in scope
    holds: tuple[Proof, ...]     # their reference checkpoints agree in scope


class Scenarios:
    """Every golden scenario by name, each built when it is asked for: one missing role fails only its own.

    Not a Mapping: its `get` and `in` would build the scenario and turn a builder's KeyError into a default.
    """
    names = NAMES

    def __init__(self, house: HouseInfo):
        self.house = house
        self.built: dict[str, Scenario] = {}

    def __getitem__(self, name: str) -> Scenario:
        if name not in self.built:
            self.built[name] = BUILDERS[name](self.house, name)
        return self.built[name]

    def __contains__(self, name: object) -> bool:
        return name in NAMES


def scenarios(house: HouseInfo) -> Scenarios:
    return Scenarios(house)


# --- seeds -----------------------------------------------------------------------------------------------

def seeds_for(house: HouseInfo, rng_seed: int) -> tuple[Seed, ...]:
    """A generated value for every schedule helper the house has, distinct per scope and block (ruling 9).

    Only the state changes; each helper keeps its captured attributes. Weekday and weekend starts differ. A
    room's own light and own timing are on, so the room shows its own values; a lamp draws whether it uses
    its own light. Helpers the house does not have are not invented (ruling 43).
    """
    rng = random.Random(rng_seed)
    used: dict[tuple[str, str], set[str]] = {}
    seeds = []
    for helper in sorted(house.helpers, key=lambda h: h.entity):
        def fresh(draw, key=(helper.setting, helper.block)):
            taken = used.setdefault(key, set())
            for _ in range(1000):
                value = draw()
                if value not in taken:
                    taken.add(value)
                    return value
            raise ValueError(f'no fresh {key} value left')
        if helper.setting == 'light':
            state = fresh(lambda: json.dumps(_light(rng, helper)), key=('light', 'any'))
        elif helper.setting in ('start', 'weekend'):
            state = fresh(lambda: _time(rng.randrange(*START_WINDOWS[helper.block])))
            if helper.setting == 'weekend':
                weekday = house_entity(house, helper.room, helper.lamp, helper.block, 'start')
                while weekday is not None and any(seed.entity == weekday and seed.state == state for seed in seeds):
                    state = fresh(lambda: _time(rng.randrange(*START_WINDOWS[helper.block])))
        elif helper.setting == 'fade':
            low, high = helper.attributes['min'], helper.attributes['max']   # an input_number has both
            state = fresh(lambda: _number(rng.randint(max(low, FADES[0]), min(high, FADES[1]))))
        else:
            state = 'on'
        seeds.append(Seed(helper.entity, state, dict(helper.attributes)))
    return tuple(seeds)


def _light(rng: random.Random, helper: HelperInfo) -> dict:
    light: dict = {'on': helper.room is None or rng.random() < 0.8, 'b': rng.randint(*LEVELS)}
    if rng.random() < 0.7:
        light |= {'m': 'ct', 'k': rng.randrange(KELVINS[0], KELVINS[1] + 1, 50)}
    else:
        light |= {'m': 'hs', 'h': float(rng.randrange(0, 360, 5)), 's': float(rng.randrange(30, 101, 5))}
    if helper.lamp is not None:
        light['own'] = rng.random() < 0.5
    return light | {'effect': NORMAL}


def _time(minutes: int) -> str:
    return f'{minutes // 60 % 24:02d}:{minutes % 60:02d}:00'


def _number(value: float) -> str:
    return str(float(value))   # as HA writes an input_number's state


def house_entity(house: HouseInfo, room: str | None, lamp: str | None, block: str, setting: str) -> str | None:
    """The helper of that scope, block and setting, if the house has it."""
    return next((h.entity for h in house.helpers
                 if (h.room, h.lamp, h.block, h.setting) == (room, lamp, block, setting)), None)


class _Seeds:
    """`seeds_for` with a scenario's pins on top; the last value written for an entity wins."""

    def __init__(self, house: HouseInfo, name: str):
        self.house = house
        self.seeds = {seed.entity: seed for seed in seeds_for(house, zlib.crc32(name.encode()))}

    def set(self, entity: str | None, state: str) -> None:
        """Pin `entity` (None: the house has no such helper, so nothing is pinned), keeping its captured attributes.

        A schedule helper's come from its seed, an overlay rule's from the house; an entity that is neither is a
        role the house does not have.
        """
        if entity is None:
            return
        rules = {rule.entity: rule for rule in self.house.overlay_rules}
        if entity in self.seeds:
            attributes = self.seeds[entity].attributes
        elif entity in rules:
            attributes = rules[entity].attributes
        else:
            raise MissingRole(f'the house captured no {entity}')
        self.seeds[entity] = Seed(entity, state, attributes)

    def overlay_after(self, minutes: int = OVERLAY_MINUTES) -> None:
        """Overlays end `minutes` after they begin."""
        self.set(AFTER_RULE, 'on')
        self.set(AFTER_MINUTES, _number(minutes))

    def light(self, entity: str | None, light: Mapping) -> None:
        self.set(entity, json.dumps(dict(light)))

    def house_schedule(self, times: Mapping[str, tuple[str, str, int]] = HOUSE_TIMES) -> None:
        """Pin the house's block starts and fades to `times` (blocks left out keep theirs) and its lights."""
        for block, (weekday, weekend, fade) in times.items():
            self.set(house_entity(self.house, None, None, block, 'start'), f'{weekday}:00')
            self.set(house_entity(self.house, None, None, block, 'weekend'), f'{weekend}:00')
            self.set(house_entity(self.house, None, None, block, 'fade'), _number(fade))
        for block, light in HOUSE_LIGHTS.items():
            self.light(house_entity(self.house, None, None, block, 'light'), light)

    def follow_house(self, room: str) -> None:
        """`room` shows the house's lights at the house's times: its own switches off, its lamps on the room's."""
        for helper in self.house.helpers:
            if helper.room != room:
                continue
            if helper.lamp is None and helper.setting in ('own_light', 'own_timing'):
                self.set(helper.entity, 'off')
            elif helper.lamp is not None and helper.setting == 'light':
                self.light(helper.entity, {**json.loads(self.seeds[helper.entity].state), 'own': False})

    def tuple(self) -> tuple[Seed, ...]:
        return tuple(self.seeds[entity] for entity in sorted(self.seeds))


# --- roles -----------------------------------------------------------------------------------------------

def placed_remote(house: HouseInfo) -> RemoteInfo:
    """The first remote whose device has a room: one with none does nothing on either backend (ruling 42)."""
    for remote in house.remotes:
        if remote.room is not None:
            return remote
    raise MissingRole('no remote has a room')


def subject_room(house: HouseInfo) -> str:
    room = placed_remote(house).room
    assert room is not None
    return room


def plug_of(house: HouseInfo, room: str) -> str:
    """The room's synthetic plug: the backend seeds plug n into room n of the sorted rooms."""
    if len(house.plugs) != len(house.rooms):
        raise MissingRole(f'{len(house.plugs)} plugs for {len(house.rooms)} rooms')
    return house.plugs[house.rooms.index(room)]


def lamp_in(house: HouseInfo, room: str) -> LampInfo:
    for lamp in house.lamps:
        if lamp.room == room:
            return lamp
    raise MissingRole('the subject room has no lamp')


def candle_lamp(house: HouseInfo) -> LampInfo:
    """The first lamp the reference ran a Candle on that can run the firmware candle (ruling 56)."""
    lamps = {lamp.lamp: lamp for lamp in house.lamps}
    for name in house.candle_lamps:
        if lamps[name].candle_capable:
            return lamps[name]
    raise MissingRole(f'coverage gap: the reference ran a Candle on {len(house.candle_lamps)} lamps, '
                      'none of them firmware candle-capable')


def bulbs_of(house: HouseInfo, room: str | None = None, lamp: str | None = None) -> tuple[str, ...]:
    """The bulbs of one lamp, of one room's lamps, or (neither named) of the house."""
    return tuple(sorted(bulb for info in house.lamps if room in (None, info.room) and lamp in (None, info.lamp)
                        for bulb in info.bulbs))


def on_lamp(lamp: LampInfo, first: int, second: int) -> Proof:
    return Proof(first, second, tuple(sorted(lamp.bulbs)), ())


def in_room(house: HouseInfo, first: int, second: int) -> Proof:
    return Proof(first, second, bulbs_of(house, subject_room(house)), ())


def in_house(house: HouseInfo, first: int, second: int) -> Proof:
    return Proof(first, second, bulbs_of(house), tuple(house.plugs))


def on_plug(house: HouseInfo, first: int, second: int) -> Proof:
    return Proof(first, second, (), (plug_of(house, subject_room(house)),))


def at(day: datetime, clock: str) -> datetime:
    hour, minute = (int(part) for part in clock.split(':'))
    return day.replace(hour=hour, minute=minute)


def person() -> Context:
    return Context(id='e2e-person-change', user_id=PERSON)


def _pinned(house: HouseInfo, name: str, times: Mapping[str, tuple[str, str, int]] = HOUSE_TIMES) -> _Seeds:
    seeds = _Seeds(house, name)
    seeds.house_schedule(times)
    seeds.follow_house(subject_room(house))
    return seeds


# --- the scenarios ---------------------------------------------------------------------------------------

def _schedule_day(house: HouseInfo, name: str) -> Scenario:
    # From 00:30, step k ends at k:30: night at 06:30, day at 08:30, day at 17:30, cosy at 19:30 and 22:30,
    # night again at 00:30.
    steps = (HaStart(), *[Advance(3600)] * 24)
    return Scenario(name, at(WEEKDAY, '00:30'), _pinned(house, name).tuple(), steps,
                    tuple(in_house(house, *pair) for pair in ((6, 8), (17, 19), (22, 24))), ())


def _remote_presses(house: HouseInfo, name: str) -> Scenario:
    # Midday, inside the day block: each press kind once, then on past the after-duration rule (the next block,
    # cosy, is later still). The last press comes twice: a step up and a step down cancel, and the expiry
    # needs an overlay that is not the schedule's own light to end.
    remote = placed_remote(house)
    seeds = _pinned(house, name)
    seeds.overlay_after()
    steps: list[Step] = [HaStart()]
    for press in (*remote.presses, remote.presses[-1]):
        steps += [Mqtt(remote.topic, press), Advance(PRESS_GAP)]
    steps.append(Advance(OVERLAY_MINUTES * 60 + 3600))
    return Scenario(name, at(WEEKDAY, '12:00'), seeds.tuple(), tuple(steps),
                    (in_room(house, 0, 2), in_room(house, len(steps) - 2, len(steps) - 1)), ())


def _dashboard_block_then_clear(house: HouseInfo, name: str) -> Scenario:
    # The house's night light at midday, then cleared back to the day light.
    steps = (HaStart(), ScriptCall('ls_override_block', {'scope': 'house', 'block': 'night'}, person()), Advance(SETTLE),
             ScriptCall('ls_clear_overrides', {}, person()), Advance(SETTLE))
    return Scenario(name, at(WEEKDAY, '12:00'), _pinned(house, name).tuple(), steps,
                    (in_room(house, 0, 2), in_room(house, 2, 4)), ())


def _range_save(house: HouseInfo, name: str) -> Scenario:
    # Saved at night (dim, outside the bright range: the plug stays off), into the day block (inside it: on),
    # then into cosy (outside: off).
    plug = plug_of(house, subject_room(house))
    steps = (HaStart(), ScriptCall('ls_range_save', {'entity': plug, 'profile': 'bright'}, person()),
             Advance(3 * 3600), Advance(11 * 3600))
    return Scenario(name, at(WEEKDAY, '05:00'), _pinned(house, name).tuple(), steps,
                    (on_plug(house, 1, 2), on_plug(house, 2, 3)), ())


def _person_change_then_expiry(house: HouseInfo, name: str) -> Scenario:
    # A person's change at 15:00 holds across the cosy start at 16:00 and ends at 18:00, when the after-duration
    # rule clears it. The next-block rule is off, or it would end the hold at 16:00 (ruling 51).
    seeds = _pinned(house, name, {**HOUSE_TIMES, 'cosy': ('16:00', '16:00', 10)})
    seeds.set(NEXT_BLOCK_RULE, 'off')
    seeds.overlay_after()
    lamp = lamp_in(house, subject_room(house))
    held = 90 * 60   # to 16:30, past the cosy start
    steps = (HaStart(), PersonLightChange([lamp.lamp], {'brightness': PERSON_LEVEL, 'color_temp_kelvin': PERSON_KELVIN}),
             Advance(held), Advance(OVERLAY_MINUTES * 60 - held + 3600))   # to 19:00, an hour past the expiry
    # On the held lamp only: the rest of the room follows the cosy start, which would prove nothing. Held across
    # it (1, 2), it would follow cosy with no hold; let go after (2, 3), it would stay held with no expiry.
    return Scenario(name, at(WEEKDAY, '15:00'), seeds.tuple(), steps, (on_lamp(lamp, 2, 3),), (on_lamp(lamp, 1, 2),))


def _mode_toggle(house: HouseInfo, name: str) -> Scenario:
    if house.mode_switch is None:
        raise MissingRole('the house has no mode switch')
    flip = [StateChanged(house.mode_switch, None, {'state': state, 'attributes': {}},
                         Context(id=f'e2e-mode-{state}', user_id=PERSON)) for state in ('on', 'off')]
    steps = (HaStart(), flip[0], Advance(SETTLE), flip[1], Advance(SETTLE))
    return Scenario(name, at(WEEKDAY, '12:00'), _pinned(house, name).tuple(), steps,
                    (in_room(house, 0, 2), in_room(house, 2, 4)), ())


def _plug_button(house: HouseInfo, name: str) -> Scenario:
    # The plug follows its bright range in the day block; its own button is pressed there, and then the
    # cosy start at 17:00 takes the room out of the range.
    seeds = _pinned(house, name, {**HOUSE_TIMES, 'cosy': ('17:00', '17:00', 10)})
    plug = plug_of(house, subject_room(house))
    steps = (HaStart(), ScriptCall('ls_range_save', {'entity': plug, 'profile': 'bright'}, person()), Advance(SETTLE),
             PressSwitch(plug), Advance(SETTLE), Advance(3600))
    return Scenario(name, at(WEEKDAY, '16:00'), seeds.tuple(), steps, (on_plug(house, 0, 2), on_plug(house, 2, 5)), ())


def _wall_power_cycle(house: HouseInfo, name: str) -> Scenario:
    # A bulb of the subject room, settled at the day light, loses power at 17:56; cosy starts at 18:00 with no
    # fade while it is dark, and it comes back at 18:01 at its day light.
    seeds = _pinned(house, name, {**HOUSE_TIMES, 'cosy': ('18:00', '18:00', 0)})
    bulb = (lamp_in(house, subject_room(house)).bulbs[0],)
    steps = (HaStart(), Advance(SETTLE), PowerCut(bulb), Advance(300), PowerRestore(bulb), Advance(SETTLE))
    # On the cut bulb, from the restore (back at its day light) to cosy: with no cut it shows cosy at both,
    # and with no recovery its day light at both.
    return Scenario(name, at(WEEKDAY, '17:54'), seeds.tuple(), steps, (Proof(4, 5, bulb, ()),), ())


def _ha_restart_mid_fade(house: HouseInfo, name: str) -> Scenario:
    # The hour-long fade into cosy runs 17:00..18:00; HA starts again at 17:30.
    seeds = _pinned(house, name, {**HOUSE_TIMES, 'cosy': ('18:00', '18:00', 60)})
    steps = (HaStart(), Advance(40 * 60), HaStart(), Advance(60 * 60))
    # The restart's right effect is none. On a lamp of the subject room, mid-fade at 17:30: the restart leaves it
    # where it was (1, 2), and the fade goes on to cosy after it (2, 3).
    lamp = lamp_in(house, subject_room(house))
    return Scenario(name, at(WEEKDAY, '16:50'), seeds.tuple(), steps, (on_lamp(lamp, 2, 3),), (on_lamp(lamp, 1, 2),))


def _midnight_weekend(house: HouseInfo, name: str) -> Scenario:
    # Friday evening to Saturday morning runs on the weekend starts only: night at 23:40 and day at 08:40.
    # The weekday ones (22:10, 06:10) are each straddled too, and change nothing there.
    times = {'cosy': ('17:10', '18:40', 10), 'night': ('22:10', '23:40', 10), 'day': ('06:10', '08:40', 10)}
    steps = (HaStart(), Advance(110 * 60), Advance(70 * 60), Advance(90 * 60), Advance(330 * 60), Advance(60 * 60),
             Advance(150 * 60))
    # 20:00 start; steps end 21:50, 23:00, 00:30, 06:00, 07:00, 09:30.
    return Scenario(name, at(FRIDAY, '20:00'), _pinned(house, name, times).tuple(), steps,
                    (in_room(house, 2, 3), in_room(house, 5, 6)), (in_room(house, 1, 2), in_room(house, 4, 5)))


def _dst(house: HouseInfo, name: str, eve: datetime, before: float, after: float) -> Scenario:
    # Saturday evening into the last Sunday of the month: the night starts at 02:30 on the weekend start, inside
    # the hour the clocks skip (March) or repeat (October), with a fade.
    times = {**HOUSE_TIMES, 'night': ('01:20', '02:30', 20)}
    steps = (HaStart(), Advance(before), Advance(after))
    return Scenario(name, at(eve, '23:30'), _pinned(house, name, times).tuple(), steps, (in_house(house, 1, 2),), ())


def _dst_spring(house: HouseInfo, name: str) -> Scenario:
    return _dst(house, name, SPRING_EVE, 2 * 3600, 90 * 60)     # to 01:30 CET, then to 04:00 CEST


def _dst_autumn(house: HouseInfo, name: str) -> Scenario:
    return _dst(house, name, AUTUMN_EVE, 150 * 60, 150 * 60)    # to 02:00 CEST, then to 03:30 CET


def _candle_lamp_evening(house: HouseInfo, name: str) -> Scenario:
    # The candle lamp's cosy light is the candle from 18:00. Its own store carries it; a lamp with none takes
    # it from its room's store, or the house's when the room has none either (ruling 52). The lamp is one the
    # reference runs its candle on (ruling 56), so its software candle meets the port's firmware one.
    lamp = candle_lamp(house)
    seeds = _pinned(house, name)
    seeds.follow_house(lamp.room)
    candle = {'on': True, 'b': 120, 'm': 'ct', 'k': 2200, 'effect': CANDLE}
    own = house_entity(house, lamp.room, lamp.lamp, 'cosy', 'light')
    room = house_entity(house, lamp.room, None, 'cosy', 'light')
    if own is not None:
        seeds.light(own, {**candle, 'own': True})
    elif room is not None:
        seeds.light(room, candle)
        seeds.set(house_entity(house, lamp.room, None, 'cosy', 'own_light'), 'on')
    else:
        seeds.light(house_entity(house, None, None, 'cosy', 'light'), candle)
    steps = (HaStart(), Advance(90 * 60), Advance(30 * 60))
    return Scenario(name, at(WEEKDAY, '17:00'), seeds.tuple(), steps,
                    (Proof(0, 1, bulbs_of(house, lamp=lamp.lamp), ()),), ())


BUILDERS = {
    'schedule_day': _schedule_day, 'remote_presses': _remote_presses,
    'dashboard_block_then_clear': _dashboard_block_then_clear, 'range_save': _range_save,
    'person_change_then_expiry': _person_change_then_expiry, 'mode_toggle': _mode_toggle,
    'plug_button': _plug_button, 'wall_power_cycle': _wall_power_cycle, 'ha_restart_mid_fade': _ha_restart_mid_fade,
    'midnight_weekend': _midnight_weekend, 'dst_spring': _dst_spring, 'dst_autumn': _dst_autumn,
    'candle_lamp_evening': _candle_lamp_evening,
}
