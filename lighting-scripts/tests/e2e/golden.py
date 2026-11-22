"""Golden recordings: a scenario run once on the reference, replayed on the port.

`record` runs a scenario on the reference and writes a plain JSON recording to
`.runtime/e2e/golden/<name>.json` (git-ignored: it names catalog entities). It
holds the scenario (its steps and seeds through the codec), the reference's
checkpoints and adjustments, and a hash of what made them: the modules the
reference run goes through and the private captures (ruling 47). `replay` runs
the port on the recorded scenario and compares it with the recording. It raises
`StaleRecording` when that hash has changed, or when the golden scenario of that
name is no longer the recorded one; a recording no golden scenario names (a fuzz
failure) replays as recorded.

    python3 -m tests.e2e.golden record [name ...]   # every golden scenario when none is named
    python3 -m tests.e2e.golden replay [name ...]
"""
from __future__ import annotations
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from functools import cache
import hashlib
import json
from pathlib import Path
import sys

from tests.e2e.codec import Checkpoint, decode, encode
from tests.e2e.compare import Comparison, compare
from tests.e2e.runner import ROOT, BackendRun, describe_house, run_backend
from tests.e2e.scenarios import NAMES, Scenario, scenarios

GOLDEN = ROOT / '.runtime' / 'e2e' / 'golden'
# What a reference run goes through (ruling 47): these modules and the private captures. Not the tests,
# compare.py (it runs at replay), this module, or the port's sources.
HASHED_MODULES = ('env', 'world', 'router', 'codec', 'backend', 'runner', 'services')
CAPTURES = 'reference'


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
    files = [root / 'tests' / 'e2e' / f'{name}.py' for name in HASHED_MODULES]
    files += sorted(path for path in (root / CAPTURES).rglob('*') if path.is_file())
    for path in files:
        digest.update(str(path.relative_to(root)).encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def record(name: str, scenario: Scenario, *, directory: Path = GOLDEN) -> Path:
    """Run `scenario` on the reference and save it as the recording `name`."""
    run = run_backend('reference', scenario.steps, scenario.start, scenario.seeds)
    return save(name, scenario, run, directory=directory)


def replay(name: str, *, directory: Path = GOLDEN,
           current: Callable[[], Mapping[str, Scenario]] | None = None) -> Comparison:
    """The port on the recorded scenario, compared with the recording."""
    recording = load(name, directory=directory)
    if recording.sources != sources_hash():
        raise StaleRecording(f'{name}: the harness or the captures changed since it was recorded')
    golden = (current or current_scenarios)()
    if name in golden and _scenario_json(golden[name]) != _scenario_json(recording.scenario):
        raise StaleRecording(f'{name}: the scenario changed since it was recorded')
    scenario = recording.scenario
    port = run_backend('port', scenario.steps, scenario.start, scenario.seeds)
    result = compare(recording.reference.checkpoints, port.checkpoints)
    # The backends' own rules (the reference's software candle) are adjustments as much as compare's are.
    adjustments = Counter(result.adjustments) + Counter(recording.reference.adjustments) + Counter(port.adjustments)
    return replace(result, adjustments=dict(adjustments))


@cache
def current_scenarios() -> Mapping[str, Scenario]:
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
                          tuple(decode(scenario['steps'])), tuple(tuple(pair) for pair in scenario['proves'])),
        reference=BackendRun(list(checkpoints), dict(document['reference']['adjustments'])),
        sources=document['sources'])


def _scenario_json(scenario: Scenario) -> dict:
    return json.loads(json.dumps({
        'name': scenario.name, 'start': encode(scenario.start), 'seeds': encode(list(scenario.seeds)),
        'steps': encode(list(scenario.steps)), 'proves': [list(pair) for pair in scenario.proves]}))


def differ(first: Checkpoint, second: Checkpoint) -> bool:
    """Two checkpoints show different lamps, switches or dashboard values, by the comparator's own tolerances."""
    aligned = replace(second, step=first.step, t=first.t)
    return bool(compare([first], [aligned]).differences)


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
                failed += bool(result.differences)
                fields = Counter(difference.field for difference in result.differences)
                print(f'{name}: {len(result.differences)} differences {dict(fields)}, adjustments '
                      f'{dict(result.adjustments)}, not ported {dict(result.not_ported)}, '
                      f'{(datetime.now() - started).seconds} s', flush=True)
                (GOLDEN / f'{name}.differences.json').write_text(json.dumps(
                    {'differences': [vars(d) for d in result.differences], 'adjustments': dict(result.adjustments),
                     'not_ported': dict(result.not_ported)}, indent=1, default=repr))
            else:
                raise SystemExit(f'unknown command {command!r}: record or replay')
        except Exception as error:   # one scenario's failure is reported, and the others still run
            failed += 1
            print(f'{name}: {type(error).__name__}: {str(error)[-3000:]}', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
