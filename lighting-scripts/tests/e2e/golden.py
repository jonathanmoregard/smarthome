"""Golden recordings: a scenario run once on the reference, replayed on the port.

`record` runs a scenario on the reference and writes a plain JSON recording to
`.runtime/e2e/golden/<name>.json` (git-ignored: it names catalog entities). It
holds the scenario (its steps and seeds through the codec), the reference's
checkpoints and adjustments, and a hash of what made them: the modules the
reference run goes through, the private captures and `tests/parity/portability.py`,
whose `live_candidate` turns the captures into what the reference runs (rulings
47, 56). `replay` runs
the port on the recorded scenario and compares it with the recording. It raises
`StaleRecording` when that hash has changed, or when the golden scenario of that
name is no longer the recorded one; a recording no golden scenario names (a fuzz
failure) replays as recorded. A replay is judged on the user flow (`compare_flow`,
the gate) and, for information, by the old exact comparison.

    python3 -m tests.e2e.golden record [name ...]   # every golden scenario when none is named
    python3 -m tests.e2e.golden replay [name ...]
"""
from __future__ import annotations
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, time, timedelta
from functools import cache
import hashlib
import json
import math
from pathlib import Path
import sys

from tests.e2e.codec import Advance, Checkpoint, HouseInfo, LampInfo, decode, encode
from tests.e2e.compare import (Comparison, ExpectedWindow, FadeOffToOnGradual, FlowComparison, compare,
                               compare_flow)
from tests.e2e.router import LOCAL, Mqtt, ScriptCall
from tests.e2e.runner import ROOT, BackendRun, describe_house, run_backend
from tests.e2e.scenarios import (BLOCKS, NAMES, Proof, Scenario, Scenarios, house_entity, plug_of, scenarios,
                                 subject_room)

GOLDEN = ROOT / '.runtime' / 'e2e' / 'golden'
# What a reference run goes through (ruling 47): these modules and the private captures. Not the tests,
# compare.py (it runs at replay), this module, or the port's sources.
HASHED_MODULES = ('env', 'world', 'router', 'codec', 'backend', 'runner', 'services')
CAPTURES = 'reference'
CANDIDATE = 'tests/parity/portability.py'   # `live_candidate`: the captures as the reference runs them
ADJUSTMENTS = (FadeOffToOnGradual(),)   # the owner-approved divergences the exact comparison explains, each counted


@dataclass(frozen=True)
class ExpectedDifference:
    """A named behaviour change the reference does not have, which the flow gate expects of the port.

    Added only by the owner's ruling (M1 plan, Task 1), each in the commit that makes the change.
    """
    name: str                 # e.g. 'plug-press-held'
    scenario: str             # exactly one scenario
    role: str                 # the bulbs or switches its `ROLES` name picks in the scenario at `after_step` (a window
                              # each), never by entity
    rule: str                 # exactly one flow rule, from `EXPECTED_RULES`
    after_step: int           # the window opens at the first checkpoint after this step's input ...
    until: str                # ... and closes at a named event, from `UNTIL`
    port_holds: bool          # inside the window the port keeps the value it showed at the window's first checkpoint


EXPECTED: tuple[ExpectedDifference, ...] = (
    # Owner rule 2026-11-22, the reconciler always restores the target state: a lamp the world starts lit while its
    # own light is off is switched off at HA start, so it is off from the first checkpoint after it (step 1; at
    # step 0 the send has not landed). The reference leaves a lamp holding still alone on a tick, and switches it
    # off only at the first press's render: off by the end of that press's gap.
    ExpectedDifference('reconciler-restores-at-start', 'remote_presses', 'lamp off by its own light at the start',
                       'power', after_step=1, until='first press settled', port_holds=True),
    # Owner rule 2026-11-23 ("a"): a person's off is a hold; anything else that leaves a reachable bulb off under a lit
    # target is switched back on, and only an unreachable bulb or a disconnected bridge is left alone. A lamp whose
    # scheduled light is off in one block (both backends switch it off) and lit in the next: from that block's fade
    # the port lights it and keeps it lit; today's scripts send only to bulbs HA shows on, so they leave it off.
    # Owner rule 2026-11-23 ("A"), The schedule lights lamps again by itself: "the schedule switches lamps on as
    # well as off".
    # A window opens at a step, and a step's first checkpoints can come before the lamp's fade (another bulb's fade
    # is sampled): there the port still shows the off it shares with the reference, so `port_holds` (held from the
    # first checkpoint) cannot hold. Those entries do without it: still only power differences on the bulbs the
    # schedule names, from that step on, and `expected-missing` if the port never lights them.
    *(ExpectedDifference('reconciler-lights-the-next-block', scenario, 'lamp lit again by the block whose fade starts '
                         'in the step', 'power', after_step=step, until='scenario end', port_holds=holds)
      for scenario, step, holds in (('schedule_day', 19, True), ('schedule_day', 22, True),
                                    ('ha_restart_mid_fade', 1, True), ('midnight_weekend', 1, True),
                                    ('midnight_weekend', 6, False), ('next_block_reset', 3, False),
                                    ('person_change_then_expiry', 2, True), ('person_change_then_expiry', 3, False),
                                    ('range_save', 3, True), ('plug_button', 6, True))),
    # The same rule: a lamp the dashboard's house block hold has off and its own block lights is lit again when the
    # hold is cleared; today's scripts leave it off.
    ExpectedDifference('reconciler-lights-after-the-hold', 'dashboard_block_then_clear',
                       'lamp lit again when the block hold is cleared', 'power', after_step=3, until='scenario end',
                       port_holds=True),
    # Owner 2026-11-22: a press on a plug's own button is an override. The port holds the pressed power as a switch
    # overlay until the next-block reset releases it at the night fade's start; today's scripts take the press back at
    # the next tick.
    ExpectedDifference('plug-press-held', 'plug_button', 'subject plug', 'power', after_step=3, until='next fade start',
                       port_holds=True),
)
EXPECTED_RULES = ('power',)


def _next_block_start(scenario: Scenario, house: HouseInfo, after_step: int) -> float:
    """Seconds into `scenario` of the house's first block start after step `after_step`'s checkpoint."""
    return _first_after(scenario, after_step, [start for _, start in _block_starts(scenario, house, after_step)],
                        'block start')


def _next_fade_start(scenario: Scenario, house: HouseInfo, after_step: int) -> float:
    """Seconds into `scenario` of the first house fade to start after step `after_step`'s checkpoint: the earliest
    block start less its fade minutes that lies after it (not the earliest start less its fade, which may already
    be under way at the step). An overlay's next-block reset ends it there."""
    seeds = {seed.entity: seed.state for seed in scenario.seeds}
    fades = []
    for block, start in _block_starts(scenario, house, after_step):
        entity = house_entity(house, None, None, block, 'fade')
        if entity is None or entity not in seeds:
            raise ValueError(f'{scenario.name}: the house {block} block has no fade seeded')
        fades.append(start - float(seeds[entity]) * 60)
    return _first_after(scenario, after_step, fades, 'fade start')


def _block_starts(scenario: Scenario, house: HouseInfo, after_step: int, room: str | None = None
                  ) -> list[tuple[str, float]]:
    """The house's block starts (block, timestamp) from the day before step `after_step`'s checkpoint to two days
    after, placed as the scenarios module describes `ls_base` placing them: a day start on its morning, cosy and
    night on their evening (a night start before noon in the small hours after it); the `_weekend` start on Friday
    and Saturday evenings and on Saturday and Sunday mornings. With `room`, a block the room has its own timing for
    starts on the room's helpers."""
    seeds = {seed.entity: seed.state for seed in scenario.seeds}
    after = _checkpoint_time(scenario, after_step)
    starts = []
    for offset in range(-1, 3):
        day = (datetime.fromtimestamp(after, LOCAL) + timedelta(days=offset)).date()
        for block in BLOCKS:
            weekend = day.weekday() in ((5, 6) if block == 'day' else (4, 5))
            entity = house_entity(house, _timing_scope(scenario, house, room, block), None, block,
                                  'weekend' if weekend else 'start')
            if entity is None or entity not in seeds:
                continue
            clock = time.fromisoformat(seeds[entity])
            date = day + timedelta(days=1) if block == 'night' and clock.hour < 12 else day
            starts.append((block, datetime.combine(date, clock, LOCAL).timestamp()))
    return starts


def _first_after(scenario: Scenario, after_step: int, moments: Sequence[float], event: str) -> float:
    """Seconds into `scenario` of the earliest of `moments` after step `after_step`'s checkpoint."""
    after = _checkpoint_time(scenario, after_step)
    later = [moment for moment in moments if moment > after]
    if not later:
        raise ValueError(f'{scenario.name}: no house {event} after step {after_step}')
    return min(later) - scenario.start.timestamp()


def _first_press_settled(scenario: Scenario, house: HouseInfo, after_step: int) -> float:
    """Seconds into `scenario` of the checkpoint that ends the gap after the first remote press from step
    `after_step` on (that step included)."""
    press = next((index for index, step in enumerate(scenario.steps) if index >= after_step and isinstance(step, Mqtt)),
                 None)
    if press is None or press + 1 >= len(scenario.steps):
        raise ValueError(f'{scenario.name}: no remote press with a gap from step {after_step} on')
    return _checkpoint_time(scenario, press + 1) - scenario.start.timestamp()


def _checkpoint_time(scenario: Scenario, step: int) -> float:
    return scenario.start.timestamp() + sum(s.seconds for s in scenario.steps[:step + 1] if isinstance(s, Advance))


def _off_by_own_light(scenario: Scenario, house: HouseInfo) -> tuple[str, ...]:
    """The bulbs of each lamp whose own light (its store says `own` and not `on`) is off in the house's block as
    the scenario starts."""
    start = scenario.start.timestamp()
    _, block = max((moment, block) for block, moment in _block_starts(scenario, house, 0) if moment <= start)
    seeds = {seed.entity: seed.state for seed in scenario.seeds}
    helpers = {helper.entity: helper.state for helper in house.helpers}
    bulbs: list[str] = []
    for lamp in house.lamps:
        entity = house_entity(house, lamp.room, lamp.lamp, block, 'light')
        text = None if entity is None else seeds.get(entity, helpers.get(entity))
        try:
            store = None if text is None else json.loads(text)
        except ValueError:
            store = None
        if isinstance(store, dict) and store.get('own') is True and store.get('on') is False:
            bulbs += lamp.bulbs
    return tuple(sorted(bulbs))


def _lit_again_by_the_next_block(scenario: Scenario, house: HouseInfo, after_step: int) -> tuple[str, ...]:
    """The bulbs of each lamp whose scheduled light is off in one block and lit in the next, where that next block's
    fade (its start less its fade minutes, on the lamp's room's timing) starts inside step `after_step`: at or after
    the checkpoint before it, before its own."""
    begin, end = _checkpoint_time(scenario, after_step - 1), _checkpoint_time(scenario, after_step)
    bulbs: set[str] = set()
    for lamp in house.lamps:
        for block, start in _block_starts(scenario, house, after_step, lamp.room):
            fade_start = start - _fade_minutes(scenario, house, _timing_scope(scenario, house, lamp.room, block), block) * 60
            if (begin <= fade_start < end and _lamp_lit(scenario, house, lamp, block)
                    and not _lamp_lit(scenario, house, lamp, BLOCKS[BLOCKS.index(block) - 1])):
                bulbs.update(lamp.bulbs)
    return tuple(sorted(bulbs))


def _lit_again_when_the_hold_is_cleared(scenario: Scenario, house: HouseInfo, after_step: int) -> tuple[str, ...]:
    """The bulbs of each lamp the scenario's house block hold (`ls_override_block`) has off and the block it is
    scheduled to at step `after_step`'s checkpoint (on its room's timing) lights."""
    held = next((step.data['block'] for step in scenario.steps if isinstance(step, ScriptCall)
                 and step.script == 'ls_override_block' and step.data.get('scope') == 'house'), None)
    if held is None:
        raise ValueError(f'{scenario.name}: no house block hold')
    at = _checkpoint_time(scenario, after_step)
    bulbs: set[str] = set()
    for lamp in house.lamps:
        _, block = max((start, block) for block, start in _block_starts(scenario, house, after_step, lamp.room)
                       if start <= at)
        if not _lamp_lit(scenario, house, lamp, held) and _lamp_lit(scenario, house, lamp, block):
            bulbs.update(lamp.bulbs)
    return tuple(sorted(bulbs))


def _lamp_lit(scenario: Scenario, house: HouseInfo, lamp: LampInfo, block: str) -> bool:
    """Whether the lamp's scheduled light in `block` is lit: its own light where its store says `own`, else its
    room's where the room has its own light for the block and a light helper, else the house's."""
    own = _store(scenario, house, house_entity(house, lamp.room, lamp.lamp, block, 'light'))
    if own is not None and own.get('own') is True:
        return own.get('on') is True
    if lamp.room is not None and _helper_state(scenario, house, house_entity(house, lamp.room, None, block, 'own_light')) == 'on':
        room = _store(scenario, house, house_entity(house, lamp.room, None, block, 'light'))
        if room is not None:
            return room.get('on') is True
    shared = _store(scenario, house, house_entity(house, None, None, block, 'light'))
    return shared is not None and shared.get('on') is True


def _timing_scope(scenario: Scenario, house: HouseInfo, room: str | None, block: str) -> str | None:
    """`room` where it has its own timing for `block`, else None: the house's."""
    if room is None:
        return None
    return room if _helper_state(scenario, house, house_entity(house, room, None, block, 'own_timing')) == 'on' else None


def _fade_minutes(scenario: Scenario, house: HouseInfo, scope: str | None, block: str) -> float:
    state = _helper_state(scenario, house, house_entity(house, scope, None, block, 'fade'))
    if state is None:
        raise ValueError(f'{scenario.name}: the {scope or "house"} {block} block has no fade')
    return float(state)


def _store(scenario: Scenario, house: HouseInfo, entity: str | None) -> dict | None:
    """A light helper's JSON store, None where there is none or it is not an object."""
    text = _helper_state(scenario, house, entity)
    try:
        store = None if text is None else json.loads(text)
    except ValueError:
        return None
    return store if isinstance(store, dict) else None


def _helper_state(scenario: Scenario, house: HouseInfo, entity: str | None) -> str | None:
    """The state the scenario seeds for `entity`, else the house's own; None for no such helper."""
    if entity is None:
        return None
    seeded = next((seed.state for seed in scenario.seeds if seed.entity == entity), None)
    return seeded if seeded is not None else next((h.state for h in house.helpers if h.entity == entity), None)


def _scenario_end(_scenario: Scenario, _house: HouseInfo, _after_step: int) -> float:
    """Never inside the scenario: the window runs through its last checkpoint."""
    return math.inf


ROLES: Mapping[str, Callable[[Scenario, HouseInfo, int], tuple[str, ...]]] = {
    'subject plug': lambda _scenario, house, _after_step: (plug_of(house, subject_room(house)),),
    'lamp off by its own light at the start': lambda scenario, house, _after_step: _off_by_own_light(scenario, house),
    'lamp lit again by the block whose fade starts in the step': _lit_again_by_the_next_block,
    'lamp lit again when the block hold is cleared': _lit_again_when_the_hold_is_cleared,
}
UNTIL: Mapping[str, Callable[[Scenario, HouseInfo, int], float]] = {'next block start': _next_block_start,
                                                                     'next fade start': _next_fade_start,
                                                                     'first press settled': _first_press_settled,
                                                                     'scenario end': _scenario_end}


def check_expected(entries: Sequence[ExpectedDifference], built: Scenarios) -> None:
    """Raise ValueError on an entry whose scenario, role, rule, step or closing event does not exist."""
    for entry in entries:
        if entry.scenario not in NAMES:
            raise ValueError(f'{entry.name}: no golden scenario {entry.scenario!r}')
        if entry.role not in ROLES or entry.rule not in EXPECTED_RULES or entry.until not in UNTIL:
            raise ValueError(f'{entry.name}: unknown role, rule or closing event')
        scenario = built[entry.scenario]
        if not 0 <= entry.after_step < len(scenario.steps):
            raise ValueError(f'{entry.name}: {entry.scenario} has no step {entry.after_step}')
        windows((entry,), entry.scenario, scenario, built.house)


def windows(entries: Sequence[ExpectedDifference], name: str, scenario: Scenario, house: HouseInfo
            ) -> tuple[ExpectedWindow, ...]:
    """The entries for scenario `name`, each resolved to its window in `scenario`, one per subject its role picks."""
    return tuple(ExpectedWindow(entry.name, subject, entry.rule, entry.after_step,
                                UNTIL[entry.until](scenario, house, entry.after_step), entry.port_holds)
                 for entry in entries if entry.scenario == name
                 for subject in ROLES[entry.role](scenario, house, entry.after_step))


@dataclass(frozen=True)
class Replayed:
    flow: FlowComparison   # the gate's judgement
    exact: Comparison      # the old exact comparison, for information


class StaleRecording(Exception):
    """The recording was made by another harness, captures or scenario: record it again."""


class MissingRecording(FileNotFoundError):
    """No recording of that name: with the reference present, a failure, never a skip."""


@dataclass(frozen=True)
class Recording:
    scenario: Scenario
    reference: BackendRun
    sources: str


def sources_hash(root: Path = ROOT) -> str:
    digest = hashlib.sha256()
    files = [root / 'tests' / 'e2e' / f'{name}.py' for name in HASHED_MODULES] + [root / CANDIDATE]
    files += sorted(path for path in (root / CAPTURES).rglob('*') if path.is_file())
    for path in files:
        digest.update(str(path.relative_to(root)).encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def record(name: str, scenario: Scenario, *, directory: Path = GOLDEN) -> Path:
    """Run `scenario` on the reference and save it as the recording `name`."""
    run = run_backend('reference', scenario.steps, scenario.start, scenario.seeds)
    return save(name, scenario, run, directory=directory)


def replay(name: str, *, directory: Path = GOLDEN,
           current: Callable[[], Scenarios | Mapping[str, Scenario]] | None = None,
           expected: Sequence[ExpectedDifference] = EXPECTED) -> Replayed:
    """The port on the recorded scenario, judged against the recording on the flow and exactly."""
    recording = load(name, directory=directory)
    if recording.sources != sources_hash():
        raise StaleRecording(f'{name}: the harness or the captures changed since it was recorded')
    golden = (current or current_scenarios)()
    if name in golden and _scenario_json(golden[name]) != _scenario_json(recording.scenario):
        raise StaleRecording(f'{name}: the scenario changed since it was recorded')
    scenario = recording.scenario
    port = run_backend('port', scenario.steps, scenario.start, scenario.seeds)
    entries = [entry for entry in expected if entry.scenario == name]
    if entries and not isinstance(golden, Scenarios):
        raise ValueError(f'{name}: an expected difference names its subject by role, which needs the house '
                         '(golden scenarios built by `scenarios`, not a plain mapping)')
    resolved = windows(entries, name, scenario, golden.house) if isinstance(golden, Scenarios) else ()
    judged = compare_flow(recording.reference.checkpoints, port.checkpoints, scenario, resolved)
    exact = compare(recording.reference.checkpoints, port.checkpoints, ADJUSTMENTS)
    # The backends' own rules (the reference's software candle) are adjustments as much as compare's are.
    adjustments = Counter(exact.adjustments) + Counter(recording.reference.adjustments) + Counter(port.adjustments)
    return Replayed(judged, replace(exact, adjustments=dict(adjustments)))


@cache
def current_scenarios() -> Scenarios:
    return scenarios(describe_house())


def save(name: str, scenario: Scenario, run: BackendRun, *, directory: Path = GOLDEN,
         sources: str | None = None) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f'{name}.json'
    path.write_text(json.dumps({
        'name': name, 'sources': sources_hash() if sources is None else sources,
        'scenario': _scenario_json(scenario),
        'reference': {'checkpoints': encode(list(run.checkpoints)), 'adjustments': dict(run.adjustments)},
    }))
    return path


def load(name: str, *, directory: Path = GOLDEN) -> Recording:
    path = directory / f'{name}.json'
    if not path.is_file():
        raise MissingRecording(f'no recording {path}: run `python3 -m tests.e2e.golden record {name}`')
    document = json.loads(path.read_text())
    scenario = document['scenario']
    checkpoints = decode(document['reference']['checkpoints'])
    return Recording(
        scenario=Scenario(scenario['name'], decode(scenario['start']), tuple(decode(scenario['seeds'])),
                          tuple(decode(scenario['steps'])), _proofs(scenario['proves']), _proofs(scenario['holds'])),
        reference=BackendRun(list(checkpoints), dict(document['reference']['adjustments'])),
        sources=document['sources'])


def _scenario_json(scenario: Scenario) -> dict:
    return json.loads(json.dumps({
        'name': scenario.name, 'start': encode(scenario.start), 'seeds': encode(list(scenario.seeds)),
        'steps': encode(list(scenario.steps)), 'proves': [vars(proof) for proof in scenario.proves],
        'holds': [vars(proof) for proof in scenario.holds]}))


def _proofs(document: list[dict]) -> tuple[Proof, ...]:
    return tuple(Proof(proof['first'], proof['second'], tuple(proof['bulbs']), tuple(proof['switches']))
                 for proof in document)


def differ(first: Checkpoint, second: Checkpoint, scope: Proof | None = None) -> bool:
    """Two checkpoints show different lamps, switches or dashboard values, by the comparator's own tolerances;
    with a `scope`, only its bulbs and switches."""
    if scope is not None:
        first, second = _within(first, scope), _within(second, scope)
    aligned = replace(second, step=first.step, t=first.t)
    return bool(compare([first], [aligned]).differences)


def _within(checkpoint: Checkpoint, scope: Proof) -> Checkpoint:
    return replace(checkpoint, bulbs={bulb: checkpoint.bulbs[bulb] for bulb in scope.bulbs},
                   switches={switch: checkpoint.switches[switch] for switch in scope.switches}, dashboard={},
                   in_fade=checkpoint.in_fade & frozenset(scope.bulbs))


def write_differences(name: str, result: Replayed, *, directory: Path = GOLDEN) -> Path | None:
    """`<name>.differences.json` listing the flow and the exact differences, when there are any of either; an
    older one is removed when not."""
    path = directory / f'{name}.differences.json'
    flow, exact = result.flow, result.exact
    if not flow.flow and not exact.differences:
        path.unlink(missing_ok=True)
        return None
    path.write_text(json.dumps({'flow': [vars(d) for d in flow.flow], 'noted': dict(flow.noted),
                                'expected': dict(flow.expected), 'not_ported': dict(flow.not_ported),
                                'exact': {'differences': [vars(d) for d in exact.differences],
                                          'adjustments': dict(exact.adjustments)}},
                               indent=1, default=repr))
    return path


def main(argv: Sequence[str]) -> int:
    command, *names = argv
    names = names or list(NAMES)
    golden = current_scenarios()
    failed = 0
    for name in names:
        started = datetime.now()
        try:
            if command == 'record':
                record(name, golden[name])
                print(f'{name}: recorded in {(datetime.now() - started).seconds} s', flush=True)
            elif command == 'replay':
                result = replay(name)
                failed += bool(result.flow.flow)
                rules = Counter(difference.rule for difference in result.flow.flow)
                fields = Counter(difference.field for difference in result.exact.differences)
                print(f'{name}: {len(result.flow.flow)} flow differences {dict(rules)}, noted {dict(result.flow.noted)}, '
                      f'expected {dict(result.flow.expected)}, not ported {dict(result.flow.not_ported)}; exact: '
                      f'{len(result.exact.differences)} differences {dict(fields)}, adjustments '
                      f'{dict(result.exact.adjustments)}, {(datetime.now() - started).seconds} s', flush=True)
                write_differences(name, result)
            else:
                raise SystemExit(f'unknown command {command!r}: record or replay')
        except Exception as error:   # one scenario's failure is reported, and the others still run
            failed += 1
            print(f'{name}: {type(error).__name__}: {str(error)[-3000:]}', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
