"""Run one scenario on a backend, or on both, and bring back their checkpoints.

Each backend runs in a process of its own (`python3 -m tests.e2e.backend`):
`adapters.simulator` patches the simulator class for the port, so one process
can never be trusted with both. The scenario goes in on stdin as tagged JSON;
the outcome comes back in a result file, so the child's stdout stays free for
logs. A failure inside the backend comes back as `{kind, message}` and is
raised here as `BackendError`, or as `SettleLoop` when the world never settled.
"""
from __future__ import annotations
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Literal

from tests.e2e.codec import Checkpoint, HouseInfo, Seed, Step, decode, encode

ROOT = Path(__file__).resolve().parents[2]
SETTLE_LIMIT = 200   # settle rounds per step or tick before the backend gives up
LAST_INPUTS = 10     # inputs a SettleLoop names


class SettleLoop(Exception):
    """A step never reached quiescence within `SETTLE_LIMIT` rounds."""

    def __init__(self, last_inputs: list):
        self.last_inputs = list(last_inputs)
        super().__init__(f'no quiescence after {SETTLE_LIMIT} settle rounds; last inputs: {self.last_inputs!r}')


class BackendError(Exception):
    """The backend could not run the scenario: a harness fault, not a difference."""

    def __init__(self, backend: str, kind: str, message: str):
        self.backend, self.kind, self.message = backend, kind, message
        super().__init__(f'{backend}: {kind}: {message}')


@dataclass(frozen=True)
class BackendRun:
    checkpoints: list[Checkpoint]
    adjustments: Mapping[str, int]   # how often each named rule applied inside the backend


def run_backend(backend: Literal['reference', 'port'], steps: Sequence[Step], start: datetime,
                seeds: Sequence[Seed] = ()) -> BackendRun:
    """`steps` from `start` on `backend`, after writing `seeds` silently."""
    payload = json.dumps(encode({'start': start, 'steps': list(steps), 'seeds': list(seeds)}))
    return run_of(backend, _child(backend, [backend], payload))


def run_both(steps: Sequence[Step], start: datetime, seeds: Sequence[Seed] = ()) -> tuple[BackendRun, BackendRun]:
    with ThreadPoolExecutor(max_workers=2) as pool:
        reference = pool.submit(run_backend, 'reference', steps, start, seeds)
        port = pool.submit(run_backend, 'port', steps, start, seeds)
        return reference.result(), port.result()


def describe_house() -> HouseInfo:
    """The house as the reference backend sets it up (`python3 -m tests.e2e.backend describe`)."""
    outcome = _child('reference', ['describe'], '')
    if 'error' in outcome:
        raise BackendError('reference', outcome['error']['kind'], outcome['error']['message'])
    return outcome['house']


def _child(backend: str, command: list[str], payload: str) -> dict:
    with tempfile.TemporaryDirectory(prefix='e2e-backend-') as directory:
        result = Path(directory) / 'result.json'
        completed = subprocess.run([sys.executable, '-m', 'tests.e2e.backend', *command, str(result)],
                                   cwd=ROOT, input=payload, text=True)
        if not result.is_file():
            raise BackendError(backend, 'Crashed', f'exit status {completed.returncode}, no result written')
        return decode(json.loads(result.read_text()))


def run_of(backend: str, outcome: dict) -> BackendRun:
    """A backend's decoded outcome as a `BackendRun`, or the failure it reports, raised."""
    if 'error' in outcome:
        error = outcome['error']
        if error['kind'] == 'SettleLoop':
            raise SettleLoop(error['last_inputs'])
        raise BackendError(backend, error['kind'], error['message'])
    return BackendRun(list(outcome['checkpoints']), dict(outcome['adjustments']))
