"""The environment both e2e backends load through.

The setup is lifted from `tests/parity/run.py` (`execute`): the preserved
reference is staged into a temporary directory, the captured live scripts and
automations are normalised into a candidate directory, and `dry_harness` is
imported from the stage. For the port, `adapters.simulator` then patches
`DrySim` so every script run crosses the TypeScript RPC instead of the Jinja
interpreter.

One backend per process: `adapters.simulator` replaces `DrySim` methods on the
imported class, so a process that has run the port must never be trusted to
run the reference. `open_sim` refuses the second backend with `BackendMixed`.
"""
from __future__ import annotations
from collections.abc import Iterator
from contextlib import contextmanager
import importlib
import os
from pathlib import Path
import sys
from typing import TYPE_CHECKING, Literal

PARITY = Path(__file__).resolve().parents[1] / 'parity'
if str(PARITY) not in sys.path:
    sys.path.insert(0, str(PARITY))

from portability import LEGACY, ROOT, Stage, dependencies, ha_wrapper, live_candidate  # noqa: E402

if TYPE_CHECKING:
    from dry_harness import DrySim

Backend = Literal['reference', 'port']

# The names `run.py` exports the live candidate under (run.py:154-155).
# `dry_harness` reads LIGHTING_CANDIDATE once, at import.
CANDIDATE_VARIABLES = ('LIGHTING_CANDIDATE', 'LIGHTING_CORE_DIR', 'INPUT_CANDIDATE')
# The staged directory holding `dry_harness` (one of the run.py:142-144 paths).
DRY_HARNESS_DIR = 'lighting-algebra/tests'
# Modules imported from a stage. They bind the stage path at import, so a
# later `open_sim` must import them again from its own stage.
STAGED_MODULES = ('dry_harness', 'harness')
LIVE = ROOT / 'reference' / 'live'


class BackendMixed(RuntimeError):
    """A process asked for a second backend after opening the first."""


_opened: Backend | None = None


def reference_available() -> bool:
    """The private reference archive and the HA wrapper are present."""
    return ((LEGACY / DRY_HARNESS_DIR / 'dry_harness.py').is_file()
            and any((LIVE / 'scripts').glob('*.json'))
            and any((LIVE / 'automations').glob('*.json'))
            and ha_wrapper() is not None)


def hypothesis_available() -> bool:
    """Hypothesis imports in this interpreter once the HA closure is loaded."""
    dependencies()
    try:
        import hypothesis  # noqa: F401
    except ImportError:
        return False
    return True


@contextmanager
def open_sim(backend: Backend) -> Iterator['DrySim']:
    """Yield a fresh `DrySim` for `backend`; tear down the stage and RPC on exit."""
    global _opened
    if backend not in ('reference', 'port'):
        raise ValueError(f'Unknown backend: {backend!r}')
    if _opened is not None and _opened != backend:
        raise BackendMixed(f'This process opened {_opened!r}; {backend!r} needs its own process')
    _opened = backend
    saved_path = list(sys.path)
    saved_variables = {key: os.environ.get(key) for key in CANDIDATE_VARIABLES}
    try:
        with Stage() as stage:
            candidate = live_candidate(stage.path)
            for key in CANDIDATE_VARIABLES:
                os.environ[key] = str(candidate)
            sys.path.insert(0, str(stage.path / DRY_HARNESS_DIR))
            dry = importlib.import_module('dry_harness')
            # Captured before `adapters.simulator` patches `render` to refuse every
            # template but the frozen wake oracle; the harness renders mqtt
            # value_templates with it, identically on both backends.
            render = dry.DrySim.render
            if backend == 'reference':
                sim = dry.DrySim()
                sim.e2e_render = render.__get__(sim)
                yield sim
                return
            from adapters import simulator
            from rpc import Rpc
            rpc = Rpc()
            try:
                sim = simulator(stage.path, rpc).DrySim()
                sim.e2e_render = render.__get__(sim)
                yield sim
            finally:
                rpc.close()
    finally:
        for name in STAGED_MODULES:
            sys.modules.pop(name, None)
        sys.path[:] = saved_path
        for key, value in saved_variables.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
