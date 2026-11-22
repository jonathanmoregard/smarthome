"""Decide whether two runs ended in the same lamp and switch state.

Compares checkpoints aligned by `(step, t)`: per bulb power, level, colour and
firmware effect; per switch power; the two dashboard attributes. Never the
commands that got there. The tolerances are named constants and are never
widened to absorb a difference.
"""
from __future__ import annotations
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from tests.e2e.codec import Checkpoint
from tests.e2e.world import BulbState, Kelvin, Off, On, Rgb

LEVEL_STEPS = 2        # settled level, in steps of the 0..254 scale
KELVIN_K = 50
XY_DISTANCE = 0.01     # CIE 1931 xy distance for RGB colours
MID_FADE_LEVEL_PCT = 1  # percent of 254, when either side's bulb is mid-fade
FULL_LEVEL = 254
D65_WHITE_XY = (0.3127, 0.3290)

_SRGB_TO_XYZ = (  # linear sRGB to XYZ, D65 white point: IEC 61966-2-1 (the sRGB standard)
    (0.4124564, 0.3575761, 0.1804375),
    (0.2126729, 0.7151522, 0.0721750),
    (0.0193339, 0.1191920, 0.9503041),
)


@dataclass(frozen=True)
class Difference:
    step: int
    t: float
    subject: str
    field: str
    reference: object
    port: object


@dataclass(frozen=True)
class Comparison:
    differences: tuple[Difference, ...]
    adjustments: Mapping[str, int]
    not_ported: Mapping[str, int]


@dataclass(frozen=True)
class BulbAt:
    """One bulb at one aligned checkpoint, on both sides."""
    step: int
    t: float
    ref: BulbState
    port: BulbState
    ref_fading: bool
    port_fading: bool


class Adjustment(Protocol):
    name: str
    fields: frozenset[str]  # the bulb fields it explains, from 'power', 'level', 'colour', 'effect'

    def applies(self, history: Sequence[BulbAt], at: int, subject: str) -> bool:
        """`history`: the bulb at every aligned checkpoint, in order; `history[at]` is the one that differs."""
        ...


class FadeOffToOnGradual:
    """The owner's approved divergence (2026-11-20, "fade should be gradual both directions").

    When a scheduled fade turns an Off lamp On, today's scripts switch it straight to the end level; the port ramps
    it up from the lowest level in the On end's colour. A level difference is this, and nothing else, when:
    1. the port shows the bulb in a fade (its `in_fade`), and the window is that unbroken run of the port's fade;
    2. the reference shows the bulb Off at the checkpoint just before the window, and On throughout it;
    3. the port shows it On throughout the window, its level never falling;
    4. here, the reference is not fading the bulb itself, the colours agree within the tolerances, and the port's
       level is between 1 and the reference's.
    After the window, levels must agree with no adjustment.
    """
    name = 'fade-off-to-on-gradual'
    fields = frozenset({'level'})

    def applies(self, history: Sequence[BulbAt], at: int, subject: str) -> bool:
        here = history[at]
        if not here.port_fading or here.ref_fading:
            return False
        first, last = at, at
        while first > 0 and history[first - 1].port_fading:
            first -= 1
        while last + 1 < len(history) and history[last + 1].port_fading:
            last += 1
        if first == 0 or not isinstance(history[first - 1].ref, Off):
            return False
        window = history[first:last + 1]
        if not all(isinstance(moment.ref, On) and isinstance(moment.port, On) for moment in window):
            return False
        levels = [moment.port.level for moment in window if isinstance(moment.port, On)]
        if any(later < earlier for earlier, later in zip(levels, levels[1:])):
            return False
        ref, port = here.ref, here.port
        assert isinstance(ref, On) and isinstance(port, On)
        return _same_colour(ref.colour, port.colour) and 1 <= port.level <= ref.level


def compare(reference: Sequence[Checkpoint], port: Sequence[Checkpoint],
            adjustments: Sequence[Adjustment] = ()) -> Comparison:
    """Checkpoints aligned by `(step, t)`; one that only one side has is a `checkpoint` difference.

    Each side samples the ticks of its own fades only, so the reference's state at a port-only tick is not known:
    an earlier reference tick of the same step was itself mid-fade, and the previous step's final checkpoint can
    be stale (a pressed plug is put back at the next tick, with no fade and so no sample).
    """
    ref_by_key = {(c.step, c.t): c for c in reference}
    port_by_key = {(c.step, c.t): c for c in port}
    rows: list[Difference | tuple[Checkpoint, Checkpoint]] = []
    for key in sorted(ref_by_key.keys() | port_by_key.keys()):
        ref, new = ref_by_key.get(key), port_by_key.get(key)
        if ref is None or new is None:
            rows.append(Difference(key[0], key[1], 'checkpoint', 'checkpoint',
                                   None if ref is None else 'present', None if new is None else 'present'))
        else:
            rows.append((ref, new))
    histories = _histories([row for row in rows if not isinstance(row, Difference)])
    differences: list[Difference] = []
    counted: Counter[str] = Counter()
    aligned = 0
    for row in rows:
        if isinstance(row, Difference):
            differences.append(row)
            continue
        differences.extend(_compare_checkpoint(*row, histories, aligned, adjustments, counted))
        aligned += 1
    return Comparison(differences=tuple(differences), adjustments=dict(counted), not_ported=_count_not_ported(port))


_History = dict[str, tuple[list[BulbAt], dict[int, int]]]   # bulb -> (its moments, aligned index -> moment index)


def _histories(aligned: Sequence[tuple[Checkpoint, Checkpoint]]) -> _History:
    histories: _History = {}
    for index, (ref, port) in enumerate(aligned):
        for name in ref.bulbs.keys() & port.bulbs.keys():
            moments, positions = histories.setdefault(name, ([], {}))
            positions[index] = len(moments)
            moments.append(BulbAt(ref.step, ref.t, ref.bulbs[name], port.bulbs[name],
                                  name in ref.in_fade, name in port.in_fade))
    return histories


def _count_not_ported(port: Sequence[Checkpoint]) -> dict[str, int]:
    # A fade gives several checkpoints for one step and each repeats that step's misses,
    # so a name counts as often as the most any one checkpoint of the step lists it.
    per_step: dict[int, Counter[str]] = {}
    for checkpoint in port:
        seen = per_step.setdefault(checkpoint.step, Counter())
        seen |= Counter(checkpoint.not_ported)
    total: Counter[str] = Counter()
    for seen in per_step.values():
        total += seen
    return dict(total)


def _compare_checkpoint(ref: Checkpoint, port: Checkpoint, histories: _History, aligned: int,
                        adjustments: Sequence[Adjustment], counted: Counter[str]) -> list[Difference]:
    found: list[Difference] = []

    def add(subject: str, field: str, reference: object, new: object) -> None:
        found.append(Difference(ref.step, ref.t, subject, field, reference, new))

    for name in sorted(ref.bulbs.keys() | port.bulbs.keys()):
        if name not in ref.bulbs or name not in port.bulbs:
            add(name, 'bulb', 'present' if name in ref.bulbs else None, 'present' if name in port.bulbs else None)
            continue
        fading = name in ref.in_fade or name in port.in_fade
        bulb_differences = _compare_bulb(ref.bulbs[name], port.bulbs[name], fading)
        if not bulb_differences:
            continue
        claimed: set[str] = set()
        moments, positions = histories[name]
        for adjustment in adjustments:
            if not adjustment.applies(moments, positions[aligned], name):
                continue
            explained = {field for field, _, _ in bulb_differences if field in adjustment.fields}
            if explained:
                counted[adjustment.name] += 1  # once per bulb per checkpoint, however many fields it explains
                claimed |= explained
        for field, reference, new in bulb_differences:
            if field not in claimed:
                add(name, field, reference, new)
    for name in sorted(ref.switches.keys() | port.switches.keys()):
        if ref.switches.get(name) != port.switches.get(name):
            add(name, 'power', ref.switches.get(name), port.switches.get(name))
    for key in sorted(ref.dashboard.keys() | port.dashboard.keys()):
        if ref.dashboard.get(key) != port.dashboard.get(key):
            add('dashboard', key, ref.dashboard.get(key), port.dashboard.get(key))
    return found


def _compare_bulb(ref: BulbState, port: BulbState, fading: bool) -> list[tuple[str, object, object]]:
    if isinstance(ref, Off) or isinstance(port, Off):
        if isinstance(ref, Off) and isinstance(port, Off):
            return []
        return [('power', 'off' if isinstance(ref, Off) else 'on', 'off' if isinstance(port, Off) else 'on')]
    found: list[tuple[str, object, object]] = []
    allowed = FULL_LEVEL * MID_FADE_LEVEL_PCT / 100 if fading else LEVEL_STEPS
    if abs(ref.level - port.level) > allowed:
        found.append(('level', ref.level, port.level))
    if not _same_colour(ref.colour, port.colour):
        found.append(('colour', ref.colour, port.colour))
    if ref.effect != port.effect:
        found.append(('effect', ref.effect, port.effect))
    return found


def _same_colour(ref: Kelvin | Rgb | None, port: Kelvin | Rgb | None) -> bool:
    if ref is None or port is None:
        return ref is None and port is None
    if isinstance(ref, Kelvin) and isinstance(port, Kelvin):
        return abs(ref.kelvin - port.kelvin) <= KELVIN_K
    if isinstance(ref, Rgb) and isinstance(port, Rgb):
        (x1, y1), (x2, y2) = _xy(ref), _xy(port)
        return ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5 <= XY_DISTANCE
    return False


def _xy(colour: Rgb) -> tuple[float, float]:
    """sRGB to CIE 1931 xy: undo the sRGB transfer curve, matrix to XYZ (D65), then x=X/(X+Y+Z), y=Y/(X+Y+Z).

    Source: IEC 61966-2-1 (sRGB). Pure black has no chromaticity, so it takes the D65 white point.
    """
    def linear(channel: int) -> float:
        c = channel / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = linear(colour.r), linear(colour.g), linear(colour.b)
    x, y, z = (row[0] * r + row[1] * g + row[2] * b for row in _SRGB_TO_XYZ)
    total = x + y + z
    return D65_WHITE_XY if total == 0 else (x / total, y / total)
