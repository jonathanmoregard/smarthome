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


class Adjustment(Protocol):
    name: str
    fields: frozenset[str]  # the bulb fields it explains, from 'power', 'level', 'colour', 'effect'

    def applies(self, ref: BulbState, port: BulbState, subject: str) -> bool: ...


def compare(reference: Sequence[Checkpoint], port: Sequence[Checkpoint],
            adjustments: Sequence[Adjustment] = ()) -> Comparison:
    ref_by_key = {(c.step, c.t): c for c in reference}
    port_by_key = {(c.step, c.t): c for c in port}
    differences: list[Difference] = []
    counted: Counter[str] = Counter()
    for key in sorted(ref_by_key.keys() | port_by_key.keys()):
        ref, new = ref_by_key.get(key), port_by_key.get(key)
        if ref is None or new is None:
            differences.append(Difference(key[0], key[1], 'checkpoint', 'checkpoint',
                                          None if ref is None else 'present', None if new is None else 'present'))
            continue
        differences.extend(_compare_checkpoint(ref, new, adjustments, counted))
    return Comparison(differences=tuple(differences), adjustments=dict(counted), not_ported=_count_not_ported(port))


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


def _compare_checkpoint(ref: Checkpoint, port: Checkpoint, adjustments: Sequence[Adjustment],
                        counted: Counter[str]) -> list[Difference]:
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
        for adjustment in adjustments:
            if not adjustment.applies(ref.bulbs[name], port.bulbs[name], name):
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
