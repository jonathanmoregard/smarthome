"""Run one scenario on a backend, or on both, and bring back their checkpoints.

Each backend runs in a process of its own (`python3 -m tests.e2e.backend`):
`adapters.simulator` patches the simulator class for the port, so one process
can never be trusted with both. The scenario goes in on stdin as tagged JSON;
the outcome comes back in a result file, so the child's stdout stays free for
logs. A failure inside the backend comes back as `{kind, message}` and is
raised here as `BackendError`, or as `SettleLoop` when the world never settled.
"""
from __future__ import annotations
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Literal

from tests.e2e.codec import Checkpoint, Step, decode, encode
from tests.e2e.world import BulbState

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


class SoftwareCandle:
    """`software-candle-is-firmware-candle`: the reference's streamed candle counts as the bulbs' firmware candle.

    The rule itself is applied where the assignments are visible, in the backend
    (`backend.Session` reports a lamp whose `sensor.ls_effects_runtime`
    assignments hold a Candle record with effect `candle` on its bulbs), on both
    backends alike. By the time two checkpoints meet here, every bulb the rule
    covers already agrees on its effect. An effect that still differs means the
    two sides disagree about the assignment itself, or one side's bulbs run a
    firmware candle the other side never assigned; the rule explains neither, so
    this never claims a difference (constraint 5: an adjustment absorbs only what
    it was made for).
    """
    name = 'software-candle-is-firmware-candle'
    fields = frozenset({'effect'})

    def applies(self, ref: BulbState, port: BulbState, subject: str) -> bool:
        return False


def run_backend(backend: Literal['reference', 'port'], steps: Sequence[Step], start: datetime) -> list[Checkpoint]:
    payload = json.dumps(encode({'start': start, 'steps': list(steps)}))
    with tempfile.TemporaryDirectory(prefix='e2e-backend-') as directory:
        result = Path(directory) / 'result.json'
        completed = subprocess.run([sys.executable, '-m', 'tests.e2e.backend', backend, str(result)],
                                   cwd=ROOT, input=payload, text=True)
        if not result.is_file():
            raise BackendError(backend, 'Crashed', f'exit status {completed.returncode}, no result written')
        outcome = decode(json.loads(result.read_text()))
    return checkpoints_of(backend, outcome)


def run_both(steps: Sequence[Step], start: datetime) -> tuple[list[Checkpoint], list[Checkpoint]]:
    with ThreadPoolExecutor(max_workers=2) as pool:
        reference = pool.submit(run_backend, 'reference', steps, start)
        port = pool.submit(run_backend, 'port', steps, start)
        return reference.result(), port.result()


def checkpoints_of(backend: str, outcome: dict) -> list[Checkpoint]:
    """The checkpoints of a backend's decoded outcome, or the failure it reports, raised."""
    if 'error' in outcome:
        error = outcome['error']
        if error['kind'] == 'SettleLoop':
            raise SettleLoop(error['last_inputs'])
        raise BackendError(backend, error['kind'], error['message'])
    return list(outcome['checkpoints'])
