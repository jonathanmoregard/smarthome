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
from pathlib import Path
import sys

from tests.e2e.codec import Advance, Checkpoint, HouseInfo, decode, encode
from tests.e2e.compare import (Comparison, ExpectedWindow, FadeOffToOnGradual, FlowComparison, compare,
                               compare_flow)
from tests.e2e.router import LOCAL
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
    role: str                 # exactly one bulb or switch, by its `ROLES` name, never by entity
    rule: str                 # exactly one flow rule, from `EXPECTED_RULES`
    after_step: int           # the window opens at the first checkpoint after this step's input ...
    until: str                # ... and closes at a named event, from `UNTIL`
    port_holds: bool          # inside the window the port keeps the value it showed at the window's first checkpoint


EXPECTED: tuple[ExpectedDifference, ...] = ()     # empty in M1
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


def _block_starts(scenario: Scenario, house: HouseInfo, after_step: int) -> list[tuple[str, float]]:
    """The house's block starts (block, timestamp) from the day before step `after_step`'s checkpoint to two days
    after, placed as the scenarios module describes `ls_base` placing them: a day start on its morning, cosy and
    night on their evening (a night start before noon in the small hours after it); the `_weekend` start on Friday
    and Saturday evenings and on Saturday and Sunday mornings."""
    seeds = {seed.entity: seed.state for seed in scenario.seeds}
    after = _checkpoint_time(scenario, after_step)
    starts = []
    for offset in range(-1, 3):
        day = (datetime.fromtimestamp(after, LOCAL) + timedelta(days=offset)).date()
        for block in BLOCKS:
            weekend = day.weekday() in ((5, 6) if block == 'day' else (4, 5))
            entity = house_entity(house, None, None, block, 'weekend' if weekend else 'start')
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


def _checkpoint_time(scenario: Scenario, step: int) -> float:
    return scenario.start.timestamp() + sum(s.seconds for s in scenario.steps[:step + 1] if isinstance(s, Advance))


ROLES: Mapping[str, Callable[[HouseInfo], str]] = {'subject plug': lambda house: plug_of(house, subject_room(house))}
UNTIL: Mapping[str, Callable[[Scenario, HouseInfo, int], float]] = {'next block start': _next_block_start,
                                                                     'next fade start': _next_fade_start}


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
    """The entries for scenario `name`, each resolved to its subject and its window in `scenario`."""
    return tuple(ExpectedWindow(entry.name, ROLES[entry.role](house), entry.rule, entry.after_step,
                                UNTIL[entry.until](scenario, house, entry.after_step), entry.port_holds)
                 for entry in entries if entry.scenario == name)


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
