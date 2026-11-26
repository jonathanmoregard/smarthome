"""Helper services on the reference simulator, written as the port's simulator writes them.

The preserved reference simulator blocks most helper services (`input_number.set_value`
among them), so a remote press stops in its gesture script. The port's simulator
(`src/runtime/engine.ts`, `Context.emit`) handles them by writing the helper's state
text and keeping its attributes. `install` gives the reference sim the same
services, with the same text: JavaScript's `String(value)`, so `2.0` is `"2"` and
`1e21` is `"1e+21"`, as the port writes them.

1. `input_number.set_value`, `input_text.set_value`: the value as text.
2. `input_select.select_option`: the option as text.
3. `input_boolean.turn_on` / `turn_off`: `on` / `off`.
4. `timer.start` / `timer.cancel`: `active` / `idle`. Not helpers, but the gesture
   scripts call them between the helper writes, so without them a press still stops.
5. `input_datetime.set_datetime`: recorded, state left as it is. The port's simulator
   writes no state for it either; no captured script calls it.

A saved profile (an `input_text` set to a JSON object) still goes through the
reference's own template-light shim, which mirrors it into its `light.ls_*`, and
then gets the port's text. Every other service is left to the reference sim.
"""
from __future__ import annotations
from collections.abc import Callable, Mapping
import copy
from decimal import Decimal
import json
import math

# service -> the state text it writes, from its data; None: the service writes no state.
WRITES: dict[str, Callable[[str, Mapping], str | None]] = {
    'input_number.set_value': lambda action, data: js_text(_field(action, data, 'value')),
    'input_text.set_value': lambda action, data: js_text(_field(action, data, 'value')),
    'input_select.select_option': lambda action, data: js_text(_field(action, data, 'option')),
    'input_boolean.turn_on': lambda action, data: 'on',
    'input_boolean.turn_off': lambda action, data: 'off',
    'timer.start': lambda action, data: 'active',
    'timer.cancel': lambda action, data: 'idle',
    'input_datetime.set_datetime': lambda action, data: None,
}


def install(sim) -> None:
    """Route the services in `WRITES` to the port's behaviour on `sim`; leave every other one to it."""
    fallback = sim.service

    def service(action, target, data):
        if action not in WRITES:
            return fallback(action, target, data)
        text = WRITES[action](action, data)
        if action == 'input_text.set_value' and _profile(data['value']):
            fallback(action, target, data)   # records the call; the template-light shim mirrors the profile
        else:
            sim.calls.append({'time': sim.elapsed, 'action': action, 'target': copy.deepcopy(target),
                              'data': copy.deepcopy(data)})
        if text is not None:
            for entity in _entities(target, data):
                sim.put(entity, text)
        return None

    sim.service = service


def js_text(value: object) -> str:
    """`String(value)` in JavaScript, for the values a service's data can carry from JSON."""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if value is None:
        return 'null'
    if isinstance(value, (int, float)):
        return _js_number(float(value))
    raise TypeError(f'no state text for a {type(value).__name__}: {value!r}')


def _js_number(value: float) -> str:
    """ECMAScript Number::toString(10): the shortest round-trip digits, placed as JavaScript places them."""
    if math.isnan(value):
        return 'NaN'
    if math.isinf(value):
        return 'Infinity' if value > 0 else '-Infinity'
    if value == 0:
        return '0'   # -0 included
    sign = '-' if value < 0 else ''
    decimal = Decimal(repr(abs(value))).normalize()   # repr: the shortest digits that round-trip
    _, digit_tuple, exponent = decimal.as_tuple()
    digits = ''.join(map(str, digit_tuple))
    k, n = len(digits), len(digit_tuple) + int(exponent)   # value = 0.<digits> x 10^n
    if k <= n <= 21:
        body = digits + '0' * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        body = '0.' + '0' * -n + digits
    else:
        mantissa = digits[0] + ('.' + digits[1:] if k > 1 else '')
        body = f"{mantissa}e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"
    return sign + body


def _field(action: str, data: Mapping, key: str) -> object:
    if key not in data:   # deliberate (ruling 40): the port's sim writes "undefined" here; no captured call omits it
        raise KeyError(f'{action} without {key!r}: {data!r}')
    return data[key]


def _entities(target: Mapping, data: Mapping) -> list[str]:
    """The entities the port writes: the target's `entity_id`, else the data's (`target?.entity_id ?? data.entity_id`)."""
    ids = target['entity_id'] if target.get('entity_id') is not None else data.get('entity_id')
    return [entity for entity in (ids if isinstance(ids, list) else [ids]) if isinstance(entity, str)]


def _profile(value: object) -> bool:
    if not isinstance(value, str):
        return False
    try:
        return isinstance(json.loads(value), dict)
    except ValueError:
        return False
