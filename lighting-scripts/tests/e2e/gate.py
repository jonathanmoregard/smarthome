#!/usr/bin/env python3
"""The e2e gate: the e2e unit tests, then every golden scenario replayed on the port.

    npm run e2e        # python3 tests/e2e/gate.py

Writes `.runtime/e2e/report.json` (git-ignored: per scenario, its differences by field and its adjustments) and
each scenario's `.differences.json`, then prints one line: `e2e: golden N/N agree, differences D, adjustments
{...}`. Exits 0 only when D is 0, every scenario replayed and every unit test passed. The golden `_agrees` unit
tests are left to the replays here, so no scenario runs twice.
"""
from __future__ import annotations
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:   # run as a script, `tests.e2e` imports from the package root
    sys.path.insert(0, str(ROOT))

REPORT = ROOT / '.runtime' / 'e2e' / 'report.json'


@dataclass(frozen=True)
class Scenario:
    differences: int
    fields: Mapping[str, int]   # the differences by field
    adjustments: Mapping[str, int]
    error: str | None = None   # it could not replay (a missing or stale recording, a backend failure)
    not_ported: Mapping[str, int] = field(default_factory=dict)


def verdict(scenarios: Mapping[str, Scenario], *, units_passed: bool) -> tuple[str, int]:
    """The gate's one line and exit code."""
    agree = sum(s.error is None and s.differences == 0 for s in scenarios.values())
    differences = sum(s.differences for s in scenarios.values())
    adjustments: Counter[str] = Counter()
    for scenario in scenarios.values():
        adjustments.update(scenario.adjustments)
    not_replayed = sum(s.error is not None for s in scenarios.values())
    line = (f'e2e: golden {agree}/{len(scenarios)} agree, differences {differences}, '
            f'adjustments {dict(sorted(adjustments.items()))}')
    if not_replayed:
        line += f', {not_replayed} not replayed'
    if not units_passed:
        line += ', unit tests failed'
    passed = units_passed and bool(scenarios) and agree == len(scenarios)
    return line, 0 if passed else 1


def without_replays(suite: unittest.TestSuite) -> unittest.TestSuite:
    """`suite` without the golden `_agrees` tests: the gate replays each scenario itself."""
    return unittest.TestSuite(sorted((test for test in _flat(suite) if not test.id().endswith('_agrees')),
                                     key=lambda test: test.id()))


def _flat(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from _flat(test)
        else:
            yield test


def unit_tests() -> bool:
    suite = unittest.TestLoader().discover(str(ROOT / 'tests' / 'e2e'), top_level_dir=str(ROOT))
    return unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(without_replays(suite)).wasSuccessful()


def replay_all() -> dict[str, Scenario]:
    from tests.e2e.golden import replay, write_differences
    from tests.e2e.scenarios import NAMES
    results = {}
    for name in NAMES:
        try:
            result = replay(name)
        except Exception as error:   # one scenario's failure is reported, and the others still run
            results[name] = Scenario(0, {}, {}, error=f'{type(error).__name__}: {str(error)[-500:]}')
        else:
            write_differences(name, result)
            results[name] = Scenario(len(result.differences),
                                     dict(Counter(difference.field for difference in result.differences)),
                                     dict(result.adjustments), not_ported=dict(result.not_ported))
        print(f'{name}: {asdict(results[name])}', file=sys.stderr, flush=True)
    return results


def main() -> int:
    from tests.e2e import env
    units_passed = unit_tests()
    if not env.reference_available():
        print('e2e: private reference or HA wrapper missing, golden not replayed')
        return 1
    scenarios = replay_all()
    line, code = verdict(scenarios, units_passed=units_passed)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps({'line': line, 'unit_tests_passed': units_passed,
                                  'scenarios': {name: asdict(s) for name, s in scenarios.items()}}, indent=1))
    print(line)
    return code


if __name__ == '__main__':
    sys.exit(main())
