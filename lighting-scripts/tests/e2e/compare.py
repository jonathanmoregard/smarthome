"""Decide whether two runs show the same user flow, and (for information) the same exact lamp and switch state.

`compare_flow` is the gate (owner, 2026-11-22: judge the user flow, not the exact levels). It judges each step's
settled checkpoint, its last, on power, colour family, effect, a brightness band and the dashboard; a checkpoint
inside a step only on whether a power, colour or effect difference outlasts one schedule tick; and whether the
port reacts where the reference proves a change and holds where it holds. Level and shade differences are noted
and never fail.

`compare` is the old exact comparison: checkpoints aligned by `(step, t)`, per bulb power, level, colour and
firmware effect; per switch power; the two dashboard attributes. Never the commands that got there. The
tolerances are named constants and are never widened to absorb a difference.
"""
from __future__ import annotations
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field as dataclass_field
from typing import TYPE_CHECKING, Protocol

from tests.e2e.codec import Checkpoint
from tests.e2e.world import BulbState, Kelvin, Off, On, Rgb

if TYPE_CHECKING:
    from tests.e2e.scenarios import Proof, Scenario

LEVEL_STEPS = 2        # settled level, in steps of the 0..254 scale
KELVIN_K = 50
XY_DISTANCE = 0.01     # CIE 1931 xy distance for RGB colours
MID_FADE_LEVEL_PCT = 1  # percent of 254, when either side's bulb is mid-fade
FULL_LEVEL = 254
D65_WHITE_XY = (0.3127, 0.3290)
PLANCKIAN_KELVIN = (1667, 25000)   # the range the Planckian locus spline is fitted for (`planckian_xy`)

LEVEL_BAND = 51          # a fifth of the 1..254 range: bright against dim is flow, the exact level is not
KELVIN_FAMILY = 0.15     # two colour temperatures within 15 % are the same family
XY_FAMILY = 0.05         # two RGB colours within this xy distance are the same family
TICK = 60.0              # one schedule tick of slack on when a change shows
REACTION_STEPS = 3       # a level change this large, the way the reference moved, is the port reacting

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
    rule: str = ''   # in a flow comparison, the flow rule it fails: power, colour, effect, level, dashboard, ...


@dataclass(frozen=True)
class FlowComparison:
    flow: tuple[Difference, ...]        # these fail the gate
    noted: Mapping[str, int]            # counted, reported, never fail
    not_ported: Mapping[str, int]
    # differences an owner-approved divergence excused, by name: an `ExpectedWindow` or an `Adjustment`
    expected: Mapping[str, int] = dataclass_field(default_factory=dict)


@dataclass(frozen=True)
class ExpectedWindow:
    """A named behaviour change the reference does not have, resolved to one subject and one stretch of the run.

    Inside the window (checkpoints of step `after_step` on, before `closes_at`) a `rule` difference on `subject`,
    at a settled checkpoint or as rule-6 timing inside a step, is counted under `name` instead of failing; with
    `port_holds`, only where the port shows the value it showed at the window's first checkpoint. A window that
    excuses nothing is itself a flow difference: the change it names did not happen. With `port_holds`, a checkpoint
    in the window where the port no longer shows that value is one too, whether or not it differs there.
    """
    name: str
    subject: str
    rule: str
    after_step: int
    closes_at: float
    port_holds: bool

    def covers(self, checkpoint: Checkpoint) -> bool:
        return checkpoint.step >= self.after_step and checkpoint.t < self.closes_at


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


class FadeIntoCandleColour:
    """The owner's approved divergence (2026-11-24, "would like lit to candle to fade into candle color over
    transition and then start effect").

    When a scheduled fade leads a lit lamp into a block whose light is the candle, today's scripts fade towards the
    block's own colour and the candle then shows the warm end; the port, on a bulb that can run the firmware candle,
    fades towards the warm end itself, so the candle starts with no colour jump. A colour difference is this, and
    nothing else, when:
    1. the house's catalog says the bulb can run the firmware candle (`candle_bulbs`);
    2. the port shows the bulb in a fade (its `in_fade`), and the window is that unbroken run of the port's fade;
    3. the fade's starting colour is what both sides show, lit and the same within the tolerances, at the checkpoint
       just before the window (at its first, where the window opens the history);
    4. at the window's last checkpoint both sides run the candle, and the port shows the colour the reference's candle
       shows: the warm end, as today's scripts take it from the scenario's config;
    5. the port shows the bulb lit throughout the window, each colour between the starting colour and the warm end (in
       CIE xy, the way from the start through it to the warm end no longer than the straight way plus `XY_DISTANCE`),
       and never further from the warm end than it has already come, beyond `XY_DISTANCE`.
    After the window, colours must agree with no adjustment.
    """
    name = 'fade-into-candle-colour'
    fields = frozenset({'colour'})

    def __init__(self, candle_bulbs: frozenset[str]) -> None:
        self.candle_bulbs = candle_bulbs

    def applies(self, history: Sequence[BulbAt], at: int, subject: str) -> bool:
        if subject not in self.candle_bulbs or not history[at].port_fading:
            return False
        first, last = at, at
        while first > 0 and history[first - 1].port_fading:
            first -= 1
        while last + 1 < len(history) and history[last + 1].port_fading:
            last += 1
        opening, end = history[max(first - 1, 0)], history[last]
        if not (isinstance(opening.ref, On) and isinstance(opening.port, On) and opening.port.colour is not None
                and _same_colour(opening.ref.colour, opening.port.colour)):
            return False
        if not (isinstance(end.ref, On) and isinstance(end.port, On) and end.ref.effect == 'candle'
                and end.port.effect == 'candle' and end.ref.colour is not None
                and _same_colour(end.ref.colour, end.port.colour)):
            return False
        start, warm = _chromaticity(opening.port.colour), _chromaticity(end.ref.colour)
        straight = _distance(start, warm)
        nearest = straight
        for moment in history[first:last + 1]:
            if not (isinstance(moment.ref, On) and isinstance(moment.port, On) and moment.port.colour is not None):
                return False
            point = _chromaticity(moment.port.colour)
            if _distance(start, point) + _distance(point, warm) > straight + XY_DISTANCE:
                return False
            if _distance(point, warm) > nearest + XY_DISTANCE:
                return False
            nearest = min(nearest, _distance(point, warm))
        return True


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


def planckian_xy(kelvin: float) -> tuple[float, float]:
    """A colour temperature's CIE 1931 xy on the Planckian locus, by the cubic spline of Kim et al., "Design of
    advanced color temperature control system for HDTV applications", J. Korean Phys. Soc. 41 (2002) 865-871.

    Raises ValueError outside the 1667 to 25000 K the spline is fitted for.
    """
    if not PLANCKIAN_KELVIN[0] <= kelvin <= PLANCKIAN_KELVIN[1]:
        raise ValueError(f'{kelvin} K is outside the Planckian spline range {PLANCKIAN_KELVIN}')
    t = kelvin
    if t <= 4000:
        x = -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483
    return x, y


def _chromaticity(colour: Kelvin | Rgb) -> tuple[float, float]:
    return planckian_xy(colour.kelvin) if isinstance(colour, Kelvin) else _xy(colour)


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


# --- the flow gate ---------------------------------------------------------------------------------------

FLOW = 'flow'   # a bulb or switch difference's kind when it fails the gate at a settled checkpoint
_INSIDE_FLOW_FIELDS = frozenset({'power', 'colour', 'effect', 'bulb'})   # rules 1, 2, 3: what rule 6 times


def compare_flow(reference: Sequence[Checkpoint], port: Sequence[Checkpoint], scenario: Scenario,
                 expected: Sequence[ExpectedWindow] = (), adjustments: Sequence[Adjustment] = ()) -> FlowComparison:
    """The gate's judgement: flow differences fail, the rest is noted (the rules are in the M1 plan, Task 1).

    A bulb's flow difference an adjustment explains (the owner-approved divergences the exact comparison explains
    too) is counted under its name in `expected`, once per bulb per checkpoint, and never judged further.
    """
    ref_steps, port_steps = _by_step(reference), _by_step(port)
    found: list[tuple[Difference, Checkpoint | None]] = []   # each flow difference, with the port checkpoint
    noted: Counter[str] = Counter()
    explained: Counter[str] = Counter()

    aligned = _aligned(reference, port, ref_steps, port_steps, noted)
    histories = _histories(aligned)
    judged = [(ref, new, _unexplained(_judge(ref, new), histories, index, adjustments, explained))
              for index, (ref, new) in enumerate(aligned)]
    judged_at = {(ref.step, ref.t): differences for ref, _, differences in judged}

    settled: dict[int, tuple[Checkpoint, Checkpoint]] = {}
    for step in sorted(ref_steps.keys() | port_steps.keys()):
        ref, new = ref_steps.get(step, [None])[-1], port_steps.get(step, [None])[-1]
        if ref is None or new is None or ref.t != new.t:   # rule 8
            present = ref if ref is not None else new
            assert present is not None, f'step {step} has no checkpoint on either side'
            t = present.t
            found.append((Difference(step, t, 'checkpoint', 'checkpoint', None if ref is None else ref.t,
                                     None if new is None else new.t, rule='checkpoint'), None))
            continue
        settled[step] = (ref, new)
        for subject, name, value, other, kind in judged_at[(step, ref.t)]:
            if kind == FLOW:
                found.append((Difference(step, ref.t, subject, name, value, other, rule=_rule_of(subject, name)), new))
            else:
                noted[kind] += 1

    for index, (ref, new, differences) in enumerate(judged):
        if ref is not ref_steps[ref.step][-1]:   # inside a step: rule 6, and fade sampling
            for subject, name, value, other, kind in differences:
                if name not in _INSIDE_FLOW_FIELDS or kind != FLOW:
                    if name in ('level', 'colour'):
                        noted['fade-sampling' if name == 'level' else 'colour-shade'] += 1
                    continue
                if _outlasts_a_tick(judged, index, subject, name):
                    found.append((Difference(ref.step, ref.t, subject, name, value, other, rule='timing'), new))
                else:
                    noted['timing-slack'] += 1

    for proof in scenario.proves:   # rule 7
        pair = _pair(settled, proof)
        if pair is not None and not _reacts(*pair, proof):
            found.append((_proof_difference(proof, pair, 'reaction', 'differs', 'same'), None))
    for proof in scenario.holds:
        pair = _pair(settled, proof)
        if pair is not None and _changes(pair[0][1], pair[1][1], proof):
            found.append((_proof_difference(proof, pair, 'hold', 'same', 'differs'), None))

    flow, excused = _apply_expected(found, port, expected)
    return FlowComparison(flow=tuple(flow), noted=dict(noted), not_ported=_count_not_ported(port),
                          expected=dict(excused + explained))


def _by_step(checkpoints: Sequence[Checkpoint]) -> dict[int, list[Checkpoint]]:
    steps: dict[int, list[Checkpoint]] = {}
    for checkpoint in checkpoints:
        steps.setdefault(checkpoint.step, []).append(checkpoint)
    return steps


def _aligned(reference: Sequence[Checkpoint], port: Sequence[Checkpoint], ref_steps: Mapping[int, list[Checkpoint]],
             port_steps: Mapping[int, list[Checkpoint]], noted: Counter[str]) -> list[tuple[Checkpoint, Checkpoint]]:
    """Checkpoints both sides have, in order. One inside a step that one side lacks (each side samples only its own
    fades) is noted as fade sampling; a settled one that one side lacks is rule 8, already found."""
    ref_by_key = {(c.step, c.t): c for c in reference}
    port_by_key = {(c.step, c.t): c for c in port}
    settled_keys = {(cs[-1].step, cs[-1].t) for cs in (*ref_steps.values(), *port_steps.values())}
    pairs = []
    for key in sorted(ref_by_key.keys() | port_by_key.keys()):
        ref, new = ref_by_key.get(key), port_by_key.get(key)
        if ref is not None and new is not None:
            pairs.append((ref, new))
        elif key not in settled_keys:
            noted['fade-sampling'] += 1
    return pairs


def _judge(ref: Checkpoint, port: Checkpoint) -> list[tuple[str, str, object, object, str]]:
    """Every bulb, switch and dashboard difference at one aligned checkpoint: (subject, field, reference, port,
    kind), the kind `FLOW` or the name it is noted under."""
    found: list[tuple[str, str, object, object, str]] = []
    for name in sorted(ref.bulbs.keys() | port.bulbs.keys()):
        if name not in ref.bulbs or name not in port.bulbs:
            found.append((name, 'bulb', 'present' if name in ref.bulbs else None,
                          'present' if name in port.bulbs else None, FLOW))
            continue
        fading = name in ref.in_fade or name in port.in_fade
        found.extend((name, *difference) for difference in _bulb_flow(ref.bulbs[name], port.bulbs[name], fading))
    for name in sorted(ref.switches.keys() | port.switches.keys()):
        if ref.switches.get(name) != port.switches.get(name):
            found.append((name, 'power', ref.switches.get(name), port.switches.get(name), FLOW))
    for key in sorted(ref.dashboard.keys() | port.dashboard.keys()):
        if ref.dashboard.get(key) != port.dashboard.get(key):
            found.append(('dashboard', key, ref.dashboard.get(key), port.dashboard.get(key), FLOW))
    return found


def _unexplained(differences: list[tuple[str, str, object, object, str]], histories: _History, aligned: int,
                 adjustments: Sequence[Adjustment], counted: Counter[str]) -> list[tuple[str, str, object, object, str]]:
    """`differences` at aligned checkpoint `aligned` less each bulb's flow differences an adjustment explains, each
    adjustment counted once per bulb it explains something for, as `compare` counts it."""
    claimed: set[tuple[str, str]] = set()
    for subject in sorted({subject for subject, _, _, _, kind in differences
                           if kind == FLOW and subject in histories and aligned in histories[subject][1]}):
        moments, positions = histories[subject]
        flowing = {name for s, name, _, _, kind in differences if s == subject and kind == FLOW}
        for adjustment in adjustments:
            explained = flowing & adjustment.fields
            if explained and adjustment.applies(moments, positions[aligned], subject):
                counted[adjustment.name] += 1
                claimed |= {(subject, name) for name in explained}
    return [difference for difference in differences
            if difference[4] != FLOW or (difference[0], difference[1]) not in claimed]


def _bulb_flow(ref: BulbState, port: BulbState, fading: bool) -> list[tuple[str, object, object, str]]:
    """Rules 1 to 4 on one bulb, and what each other difference is noted as."""
    if isinstance(ref, Off) or isinstance(port, Off):
        if isinstance(ref, Off) and isinstance(port, Off):
            return []
        return [('power', 'off' if isinstance(ref, Off) else 'on', 'off' if isinstance(port, Off) else 'on', FLOW)]
    found: list[tuple[str, object, object, str]] = []
    if not _same_family(ref.colour, port.colour):
        found.append(('colour', ref.colour, port.colour, FLOW))
    elif not _same_colour(ref.colour, port.colour):
        found.append(('colour', ref.colour, port.colour, 'colour-shade'))
    if ref.effect != port.effect:
        found.append(('effect', ref.effect, port.effect, FLOW))
    apart = abs(ref.level - port.level)
    if apart > (FULL_LEVEL * MID_FADE_LEVEL_PCT / 100 if fading else LEVEL_STEPS):
        if 'candle' in (ref.effect, port.effect):
            kind = 'candle-level'
        elif fading:
            kind = 'fade-sampling'
        else:
            kind = FLOW if apart > LEVEL_BAND else 'level'
        found.append(('level', ref.level, port.level, kind))
    return found


def _same_family(ref: Kelvin | Rgb | None, port: Kelvin | Rgb | None) -> bool:
    if ref is None or port is None:
        return ref is None and port is None
    if isinstance(ref, Kelvin) and isinstance(port, Kelvin):
        return max(ref.kelvin, port.kelvin) <= min(ref.kelvin, port.kelvin) * (1 + KELVIN_FAMILY)
    if isinstance(ref, Rgb) and isinstance(port, Rgb):
        (x1, y1), (x2, y2) = _xy(ref), _xy(port)
        return ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5 <= XY_FAMILY
    return False


def _rule_of(subject: str, name: str) -> str:
    return 'dashboard' if subject == 'dashboard' else name


def _outlasts_a_tick(judged: Sequence[tuple[Checkpoint, Checkpoint, list]], index: int, subject: str, name: str) -> bool:
    """Rule 6: the same flow difference is still there at the next aligned checkpoint more than `TICK` later."""
    t = judged[index][0].t
    for ref, _, differences in judged[index + 1:]:
        if ref.t > t + TICK:
            return any((s, n, kind) == (subject, name, FLOW) for s, n, _, _, kind in differences)
    return False


def _pair(settled: Mapping[int, tuple[Checkpoint, Checkpoint]], proof: Proof
          ) -> tuple[tuple[Checkpoint, Checkpoint], tuple[Checkpoint, Checkpoint]] | None:
    """The two steps' settled checkpoints, (reference, port) each; None when one is missing (rule 8 has it)."""
    if proof.first not in settled or proof.second not in settled:
        return None
    return settled[proof.first], settled[proof.second]


def _changes(first: Checkpoint, second: Checkpoint, scope: Proof) -> bool:
    """One side's two checkpoints differ in scope by rule 1, 2, 3 or 4. A bulb or switch one of them lacks is
    left out: the settled checkpoints' own comparison already fails on it."""
    for name in scope.bulbs:
        if name not in first.bulbs or name not in second.bulbs:
            continue
        fading = name in first.in_fade or name in second.in_fade
        if any(kind == FLOW for *_, kind in _bulb_flow(first.bulbs[name], second.bulbs[name], fading)):
            return True
    return any(first.switches.get(name) != second.switches.get(name) for name in scope.switches
               if name in first.switches and name in second.switches)


def _reacts(first: tuple[Checkpoint, Checkpoint], second: tuple[Checkpoint, Checkpoint], scope: Proof) -> bool:
    """Rule 7: the port changes in scope by a flow rule, or moves a level `REACTION_STEPS` the reference's way."""
    (ref_a, port_a), (ref_b, port_b) = first, second
    if _changes(port_a, port_b, scope):
        return True
    for name in scope.bulbs:
        if any(name not in checkpoint.bulbs for checkpoint in (ref_a, ref_b, port_a, port_b)):
            continue
        states = (ref_a.bulbs[name], ref_b.bulbs[name], port_a.bulbs[name], port_b.bulbs[name])
        lit = [state for state in states if isinstance(state, On)]
        if len(lit) != len(states):
            continue
        ra, rb, pa, pb = (state.level for state in lit)
        if rb != ra and (pb - pa) * (1 if rb > ra else -1) >= REACTION_STEPS:
            return True
    return False


def _proof_difference(proof: Proof, pair: tuple[tuple[Checkpoint, Checkpoint], tuple[Checkpoint, Checkpoint]],
                      rule: str, reference: str, port: str) -> Difference:
    second = pair[1][1]
    return Difference(proof.second, second.t, f'steps {proof.first}-{proof.second}', rule, reference, port, rule=rule)


def _apply_expected(found: Sequence[tuple[Difference, Checkpoint | None]], port: Sequence[Checkpoint],
                    windows: Sequence[ExpectedWindow]) -> tuple[list[Difference], Counter[str]]:
    """Flow differences an expected window excuses are counted under its name; a window that excuses none is one.

    With `port_holds`, every port checkpoint in the window is checked, not only the ones that differ: one where the
    port no longer shows the held value is `expected-not-held`, even where it agrees with the reference. A window
    that excuses nothing is only `expected-missing`.
    """
    flow: list[Difference] = []
    excused: Counter[str] = Counter()
    held = {window: _held_value(port, window) for window in windows}
    seen: set[ExpectedWindow] = set()
    for difference, at in found:
        window = next((w for w in windows if at is not None and w.covers(at) and difference.subject == w.subject
                       and difference.field == w.rule and difference.rule in (w.rule, 'timing')), None)
        if window is None:
            flow.append(difference)
            continue
        seen.add(window)
        if window.port_holds and difference.port != held[window]:
            flow.append(difference)
        else:
            excused[window.name] += 1
    for window in windows:
        if window not in seen:
            flow.append(Difference(window.after_step, window.closes_at, window.subject, window.rule, None, None,
                                   rule='expected-missing'))
        elif window.port_holds:
            flow.extend(Difference(checkpoint.step, checkpoint.t, window.subject, window.rule, held[window], shown,
                                   rule='expected-not-held')
                        for checkpoint in port if window.covers(checkpoint)
                        for shown in (_power_of(checkpoint, window.subject),) if shown != held[window])
    return flow, excused


def _held_value(port: Sequence[Checkpoint], window: ExpectedWindow) -> object:
    """The port's `power` of the window's subject at the window's first checkpoint (None: the window is empty)."""
    first = next((checkpoint for checkpoint in port if window.covers(checkpoint)), None)
    return None if first is None else _power_of(first, window.subject)


def _power_of(checkpoint: Checkpoint, subject: str) -> str | None:
    """A switch's or a bulb's power at `checkpoint` (None: it has no such subject)."""
    if subject in checkpoint.switches:
        return checkpoint.switches[subject]
    state = checkpoint.bulbs.get(subject)
    return None if state is None else ('off' if isinstance(state, Off) else 'on')
