#!/usr/bin/env python3
"""The e2e gate: the e2e unit tests, then every golden scenario replayed on the port and judged on the user flow.

    npm run e2e                         # python3 tests/e2e/gate.py
    python3 tests/e2e/gate.py --exact   # also print the old exact comparison, for information

Writes `.runtime/e2e/report.json` (git-ignored: per scenario, its flow differences by rule, what was noted and
expected, and the exact comparison's differences by field and adjustments) and each scenario's
`.differences.json`, then prints one line: `e2e: golden N/N flow agree, flow differences F, noted {...},
expected {...}`. Exits 0 only when F is 0, every scenario replayed and every unit test passed; the exact
comparison never fails it. The golden `_agrees` unit tests are left to the replays here, so no scenario runs twice.
"""
from __future__ import annotations
from collections import Counter
from collections.abc import Iterator, Mapping, Sequence
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
    flow: int
    rules: Mapping[str, int]   # the flow differences by rule
    noted: Mapping[str, int]
    expected: Mapping[str, int] = field(default_factory=dict)
    error: str | None = None   # it could not replay (a missing or stale recording, a backend failure)
    not_ported: Mapping[str, int] = field(default_factory=dict)
    exact: int = 0   # the old exact comparison's differences, for information
    fields: Mapping[str, int] = field(default_factory=dict)   # ... by field
    adjustments: Mapping[str, int] = field(default_factory=dict)


def verdict(scenarios: Mapping[str, Scenario], *, units_passed: bool) -> tuple[str, int]:
    """The gate's one line and exit code."""
    agree = sum(s.error is None and s.flow == 0 for s in scenarios.values())
    flow = sum(s.flow for s in scenarios.values())
    not_replayed = sum(s.error is not None for s in scenarios.values())
    line = (f'e2e: golden {agree}/{len(scenarios)} flow agree, flow differences {flow}, '
            f'noted {_total(s.noted for s in scenarios.values())}, '
            f'expected {_total(s.expected for s in scenarios.values())}')
    if not_replayed:
        line += f', {not_replayed} not replayed'
    if not units_passed:
        line += ', unit tests failed'
    passed = units_passed and bool(scenarios) and agree == len(scenarios)
    return line, 0 if passed else 1


def exact_line(scenarios: Mapping[str, Scenario]) -> str:
    """The old exact comparison's line: information, never part of the verdict."""
    agree = sum(s.error is None and s.exact == 0 for s in scenarios.values())
    return (f'e2e --exact (information only): golden {agree}/{len(scenarios)} agree, '
            f'differences {sum(s.exact for s in scenarios.values())}, '
            f'adjustments {_total(s.adjustments for s in scenarios.values())}')


def _total(counts: Iterator[Mapping[str, int]]) -> dict[str, int]:
    total: Counter[str] = Counter()
    for count in counts:
        total.update(count)
    return dict(sorted(total.items()))


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
            flow, exact = result.flow, result.exact
            results[name] = Scenario(len(flow.flow), dict(Counter(difference.rule for difference in flow.flow)),
                                     dict(flow.noted), dict(flow.expected), not_ported=dict(flow.not_ported),
                                     exact=len(exact.differences),
                                     fields=dict(Counter(difference.field for difference in exact.differences)),
                                     adjustments=dict(exact.adjustments))
        print(f'{name}: {asdict(results[name])}', file=sys.stderr, flush=True)
    return results


def main(argv: Sequence[str]) -> int:
    from tests.e2e import env
    units_passed = unit_tests()
    if not env.reference_available():
        print('e2e: private reference or HA wrapper missing, golden not replayed')
        return 1
    scenarios = replay_all()
    line, code = verdict(scenarios, units_passed=units_passed)
    exact = exact_line(scenarios)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps({'line': line, 'exact_line': exact, 'unit_tests_passed': units_passed,
                                  'scenarios': {name: asdict(s) for name, s in scenarios.items()}}, indent=1))
    if '--exact' in argv:
        print(exact)
    print(line)
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
