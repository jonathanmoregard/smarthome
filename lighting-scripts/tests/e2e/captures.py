"""What the captured scripts and automations do, read from their structure (test-only).

`reads_after_profile_save` backs the port's saved-profile mirror (`env.harnessed`, point 3), which writes a
template light when the run returns rather than as the script saves its store. That is exact as long as no run
reads a template light (`light.ls_*`) after saving a profile in it. Each entry point (every script and
automation) is followed in order: its steps, the scripts it calls in place (an `ls_override` event runs
`ls_commit` in place too), and each loop body twice, so a read early in the body follows the save of the pass
before. Each script's run is summarised once: its first save, its first read, and the reads after a save.
Templates are parsed with Jinja, not searched as text. An action the checker cannot name counts as a read: it
might be one.
"""
from __future__ import annotations
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from functools import cache
import json

from tests.e2e.env import LIVE, dependencies

SAVE = 'input_text.set_value'
STORE, TEMPLATE_LIGHT = 'input_text.ls_', 'light.ls_'
BLOCKS = ('day', 'cosy', 'night')   # a profile store is `input_text.ls_<scope>_<block>`
STEP_LISTS = ('sequence', 'then', 'else', 'default', 'parallel')
SCRIPT_CALLS = ('script.turn_on', 'script.toggle')
EVENT_SCRIPTS = {'ls_override': 'ls_commit'}   # events the simulators route to a script inside the run


def captured() -> tuple[dict[str, dict], dict[str, dict]]:
    """The captured scripts and automations, by file name."""
    def configs(kind: str) -> dict[str, dict]:
        found = {}
        for path in sorted((LIVE / kind).glob('*.json')):
            value = json.loads(path.read_text())
            found[path.stem] = value.get('config', value)
        return found
    return configs('scripts'), configs('automations')


def reads_after_profile_save(scripts: Mapping[str, dict], automations: Mapping[str, dict]) -> list[tuple[str, str, str]]:
    """(entry point, where a profile was saved, where a template light was read after it), one per such run."""
    walk = _Walk(scripts)
    return [(entry, saved, read) for entry, steps in _entry_points(scripts, automations)
            for saved, read in walk.steps(steps, entry).reads_after_save[:1]]


def profile_savers(scripts: Mapping[str, dict], automations: Mapping[str, dict]) -> list[str]:
    """The entry points whose run saves a profile."""
    walk = _Walk(scripts)
    return [entry for entry, steps in _entry_points(scripts, automations) if walk.steps(steps, entry).save]


def _entry_points(scripts, automations) -> Iterator[tuple[str, list]]:
    for name, config in scripts.items():
        yield f'script {name}', config.get('sequence', [])
    for name, config in automations.items():
        yield f'automation {name}', config.get('actions', config.get('action', []))


@dataclass(frozen=True)
class _Run:
    """A stretch of a run, as far as this check needs it."""
    save: str | None = None    # where its first profile save is
    read: str | None = None    # where its first template-light read is (or an action that cannot be named)
    reads_after_save: tuple[tuple[str, str], ...] = ()

    def then(self, later: _Run) -> _Run:
        joined = ((self.save, later.read),) if self.save and later.read else ()
        return _Run(self.save or later.save, self.read or later.read,
                    self.reads_after_save + joined + later.reads_after_save)


class _Walk:
    """Runs of steps; a script's run is worked out once and reused wherever it is called."""

    def __init__(self, scripts: Mapping[str, dict]):
        self.scripts = scripts
        self.known: dict[str, _Run] = {}
        self.calling: set[str] = set()

    def steps(self, steps, where: str) -> _Run:
        run = _Run()
        for index, step in enumerate(steps if isinstance(steps, list) else [steps]):
            if isinstance(step, dict):
                run = run.then(self.step(step, f'{where}/{index}'))
        return run

    def step(self, step: dict, here: str) -> _Run:
        run = _Run(read=here) if any(_reads(text, literal) for text, literal in _own_strings(step)) else _Run()
        for number, branch in enumerate(step.get('choose', [])):
            run = run.then(self.steps(branch.get('sequence', []), f'{here}/choose{number}'))
        if 'repeat' in step:
            body = self.steps(step['repeat'].get('sequence', []), f'{here}/repeat')
            run = run.then(body).then(body)   # twice: the next pass follows this one
        for key in STEP_LISTS:
            if key in step:
                run = run.then(self.steps(step[key], f'{here}/{key}'))
        if step.get('event') in EVENT_SCRIPTS:
            run = run.then(self.script(EVENT_SCRIPTS[step['event']]))
        action = step.get('action', step.get('service'))
        if isinstance(action, str):
            for service in _services(action):
                if service is None:
                    run = run.then(_Run(read=here))   # an action it cannot name
                elif service == SAVE and _saves_profile(step):
                    run = run.then(_Run(save=here))
                elif service in SCRIPT_CALLS:
                    for entity in _targets(step):
                        if entity.startswith('script.'):
                            run = run.then(self.script(entity.removeprefix('script.')))
                elif service.startswith('script.'):
                    run = run.then(self.script(service.removeprefix('script.')))
        return run

    def script(self, name: str) -> _Run:
        if name in self.calling or name not in self.scripts:   # a cycle, or a script the captures do not hold
            return _Run()
        if name not in self.known:
            self.calling.add(name)
            self.known[name] = self.steps(self.scripts[name].get('sequence', []), f'script {name}')
            self.calling.discard(name)
        return self.known[name]


def _own_strings(step: dict) -> Iterator[tuple[str, bool]]:
    """(text, whether it is a condition's literal entity) for the step itself, not for the steps it holds."""
    def collect(value) -> Iterator[tuple[str, bool]]:
        if isinstance(value, str):
            yield value, False
        elif isinstance(value, list):
            for item in value:
                yield from collect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in STEP_LISTS:
                    continue
                if key == 'entity_id' and 'condition' in value:
                    for entity in [item] if isinstance(item, str) else item:
                        yield entity, True
                else:
                    yield from collect(item)
    own = {key: value for key, value in step.items() if key not in ('choose', 'repeat')}
    own['choose'] = [{k: v for k, v in branch.items() if k != 'sequence'} for branch in step.get('choose', [])]
    own['repeat'] = {k: v for k, v in step.get('repeat', {}).items() if k != 'sequence'}
    yield from collect(own)


def _reads(text: str, literal: bool) -> bool:
    if literal:
        return isinstance(text, str) and text.startswith(TEMPLATE_LIGHT)
    if '{{' not in text and '{%' not in text:
        return False
    nodes = _jinja().nodes
    for node in _parse(text).find_all((nodes.Const, nodes.Call, nodes.Getattr)):
        if isinstance(node, nodes.Const) and isinstance(node.value, str) and node.value.startswith(TEMPLATE_LIGHT):
            return True
        if isinstance(node, nodes.Call) and isinstance(node.node, nodes.Getattr) and node.node.attr == 'replace' \
                and [arg.value for arg in node.args if isinstance(arg, nodes.Const)][-1:] == ['light.']:
            return True   # `<store>.replace('input_text.', 'light.')`: the template light over a store
        if isinstance(node, nodes.Getattr) and node.attr.startswith('ls_') and isinstance(node.node, nodes.Getattr) \
                and node.node.attr == 'light' and isinstance(node.node.node, nodes.Name) and node.node.node.name == 'states':
            return True   # `states.light.ls_*`
    return False


def _services(action: str) -> list[str | None]:
    """The services an action can be: itself, the constants a template chooses between, or None (unknown)."""
    if '{{' not in action and '{%' not in action:
        return [action]
    nodes = _jinja().nodes
    body = _parse(action).body
    if len(body) != 1 or not isinstance(body[0], nodes.Output) or len(body[0].nodes) != 1:
        return [None]

    def alternatives(node) -> list[str | None]:
        if isinstance(node, nodes.Const) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, nodes.CondExpr) and node.expr2 is not None:
            return alternatives(node.expr1) + alternatives(node.expr2)
        return [None]
    return alternatives(body[0].nodes[0])


def _saves_profile(step: dict) -> bool:
    """A save whose store may be a profile store: a templated one, or a literal `input_text.ls_<scope>_<block>`."""
    return any('{{' in entity or (entity.startswith(STORE) and entity.rsplit('_', 1)[-1] in BLOCKS)
               for entity in _targets(step))


def _targets(step: dict) -> list[str]:
    ids = step.get('target', {}).get('entity_id', step.get('data', {}).get('entity_id', []))
    return [ids] if isinstance(ids, str) else [entity for entity in ids if isinstance(entity, str)]


@cache
def _parse(text: str):
    return _jinja().Environment().parse(text)


@cache
def _jinja():
    dependencies()   # Jinja comes with the HA closure
    import jinja2
    import jinja2.nodes
    return jinja2
