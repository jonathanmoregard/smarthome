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
import json
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
# The simulators move their clock this far before each ls_commit, so two commits never share an instant
# (dry_harness `DrySim.run`; adapters, in the patched run and in the ls_commit callback).
SIM_COMMIT_NUDGE = .000001
# The nudge both backends take instead (ruling 53): the port's clock counts milliseconds, so it never saw 1 µs,
# and the reference ran a step at an instant the port could not reach. HA never runs two commits 1 µs apart.
COMMIT_NUDGE = 0.001
PROFILE_STORE, TEMPLATE_LIGHT = 'input_text.', 'light.'   # a block light's store and its template light
# What the reference's template-light shim (`harness.Sim.store`) shows for a field a profile leaves out. Its
# own values, kept; only the colours it derived are replaced (ruling 54).
SHIM_DEFAULTS = {'on': True, 'b': 150, 'k': 3000, 'h': 0, 's': 0}


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
                yield harnessed(sim, backend)
                return
            from adapters import simulator
            from rpc import Rpc
            rpc = Rpc()
            try:
                sim = simulator(stage.path, rpc).DrySim()
                sim.e2e_render = render.__get__(sim)
                yield harnessed(sim, backend)
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


def harnessed(sim: 'DrySim', backend: Backend) -> 'DrySim':
    """`sim` with the clock and the template lights both backends share, set on the instance.

    1. Advance: the commit nudge is `COMMIT_NUDGE`; every other advance is as asked.
    2. Store: a saved profile writes its store and its template light, coloured as HA colours a light.
    3. On the port, a profile a script saves reaches its template light when the run returns. The reference's
       own service routes it through `store` as the script runs. That is the same state: the only captured
       script that saves a profile (`ls_store`, from `effects_set`) reads no template light after it.
    """
    advance = sim.advance

    def nudged(seconds=1):
        return advance(COMMIT_NUDGE if seconds == SIM_COMMIT_NUDGE else seconds)

    def store(entity: str, profile: dict) -> None:
        sim.put(entity, json.dumps(profile))
        template_light(sim, entity, profile)

    sim.advance, sim.store = nudged, store
    if backend == 'port':
        run = sim.run

        def mirrored(name, **context):
            seen = len(sim.calls)
            try:
                return run(name, **context)
            finally:
                for call in sim.calls[seen:]:
                    profile = _saved_profile(call)
                    if profile is not None:
                        for entity in _targets(call):
                            template_light(sim, entity, profile)

        sim.run = mirrored
    return sim


def template_light(sim: 'DrySim', store: str, profile: dict) -> None:
    """The template light over `store` showing `profile`, its colours as HA derives them for a light state."""
    dependencies()
    from homeassistant.util import color
    shown = SHIM_DEFAULTS | profile
    if profile.get('m') == 'hs':
        mode, kelvin, hs = 'hs', None, (shown['h'], shown['s'])
    else:
        mode, kelvin = 'color_temp', shown['k']
        hs = color.color_temperature_to_hs(kelvin)
    hs = [round(float(hs[0]), 3), round(float(hs[1]), 3)]
    sim.put(store.replace(PROFILE_STORE, TEMPLATE_LIGHT, 1), 'on' if shown['on'] else 'off', {
        'brightness': shown['b'], 'color_mode': mode, 'rgb_color': list(color.color_hs_to_RGB(*hs)),
        'hs_color': hs, 'color_temp_kelvin': kelvin})


def _saved_profile(call: dict) -> dict | None:
    """The profile an `input_text.set_value` call saves (a JSON object as its value); None for any other call."""
    if call.get('action') != 'input_text.set_value' or not isinstance(call.get('data', {}).get('value'), str):
        return None
    try:
        value = json.loads(call['data']['value'])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _targets(call: dict) -> list[str]:
    """The entities as the reference's service reads them: the target's `entity_id`."""
    ids = call.get('target', {}).get('entity_id', [])
    return [ids] if isinstance(ids, str) else list(ids)
