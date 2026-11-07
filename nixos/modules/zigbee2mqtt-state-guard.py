#!/usr/bin/env python3
"""Normalise legacy scalars in Zigbee2MQTT's own persisted registries.

Zigbee2MQTT owns `devices.yaml` and `groups.yaml` at runtime: it writes them
whenever a device is renamed or a group changes.  Its *writer* has historically
accepted shapes its *reader* now rejects.  `homeassistant` is the known case --
Zigbee2MQTT 1.x persisted the bare boolean `false` to mean "hide this entity
from Home Assistant", while 2.x's settings schema constrains the key to
`["object", "null"]` and refuses to start when it finds the boolean.

Nothing re-reads those files between the write and the next start, so the
invalidity is latent: it surfaces on the next restart, which may be weeks later
and triggered by something unrelated (a pulled coordinator, a reboot).  At that
point the service crash-loops and the radio is down.

This guard runs as `ExecStartPre`, so the repair happens before Zigbee2MQTT
parses anything, on every single start.  Running in `ExecStartPre` is also what
makes the failure legible to `systemctl is-active`: a unit whose pre-start
command fails never becomes active, whereas a `Type=simple` service that execs
and *then* rejects its config is reported active for the couple of seconds
before it dies -- long enough for a health gate to sample it as healthy.

Repairs are confined to an allowlist that is behaviour-preserving against
Zigbee2MQTT 2.13.0's own predicate, `options.homeassistant !== undefined &&
!options.homeassistant`:

    homeassistant: false  ->  homeassistant: null   (stays "hidden":
                                                     defined and falsy)
    homeassistant: true   ->  homeassistant: {}     (stays "exposed":
                                                     defined and truthy)

Deliberately conservative about everything else.  Zigbee2MQTT, not this script,
is the authority on whether its configuration is loadable: an invalidity outside
the allowlist is reported and left alone, and the exit status stays 0 so the
service still gets its own attempt.  The only non-zero exit is a repair this
script performed and could not then prove correct, because that is the one case
where proceeding would mean handing Zigbee2MQTT a file this script damaged.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import sys
import time

import yaml

try:
    import jsonschema
except ModuleNotFoundError:  # pragma: no cover - packaging guarantees this
    jsonschema = None

# Legacy scalar -> schema-valid value with identical meaning in Z2M 2.x.
# Keyed by the Python object the YAML scalar parses to.
REPAIRS: list[tuple[bool, object, str]] = [
    (False, None, "null"),
    (True, {}, "{}"),
]

# Anchored on indentation so only a mapping *member* is ever rewritten, never a
# top-level key of a configuration.yaml-shaped document, and on the whole line so
# nothing with unexpected structure is touched.  A trailing comment is carried
# through verbatim: a hand-edited `homeassistant: false # hide` is exactly as
# fatal as a machine-written one, so it has to be repairable too.
LEGACY_LINE = re.compile(
    r"^(?P<indent>[ \t]+)(?P<key>homeassistant)[ \t]*:[ \t]*"
    r"(?P<value>true|false|True|False)"
    r"(?P<gap>[ \t]*)(?P<comment>#[^\r\n]*)?$"
)

# Registry filename -> the schema property describing that file's contents.
REGISTRIES = {"devices.yaml": "devices", "groups.yaml": "groups"}


def log(message: str) -> None:
    print(f"zigbee2mqtt-state-guard: {message}", file=sys.stderr, flush=True)


def subschema(schema: dict, prop: str) -> dict:
    """Extract the sub-schema for one settings property, keeping $ref targets."""
    node = dict(schema.get("properties", {}).get(prop) or {})
    if not node:
        raise KeyError(prop)
    if "definitions" in schema:
        node["definitions"] = schema["definitions"]
    return node


def errors_for(schema: dict, data: object) -> list[str]:
    if jsonschema is None:
        return []
    validator = jsonschema.Draft7Validator(schema)
    return [
        "/".join(str(part) for part in error.absolute_path) + ": " + error.message
        for error in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    ]


def repair_text(text: str) -> tuple[str, list[str]]:
    """Rewrite legacy boolean `homeassistant` members, touching nothing else."""
    lines = text.splitlines(keepends=True)
    notes: list[str] = []
    for index, line in enumerate(lines):
        match = LEGACY_LINE.match(line.rstrip("\r\n"))
        if match is None:
            continue
        parsed = match.group("value").lower() == "true"
        replacement = next(literal for legacy, _, literal in REPAIRS if legacy is parsed)
        ending = line[len(line.rstrip("\r\n")):] or "\n"
        comment = match.group("comment")
        tail = f"{match.group('gap')}{comment}" if comment else ""
        lines[index] = (
            f"{match.group('indent')}homeassistant: {replacement}{tail}{ending}"
        )
        notes.append(f"line {index + 1}: homeassistant: {match.group('value')} -> {replacement}")
    return "".join(lines), notes


def walk(node: object, path: tuple[object, ...] = ()) -> dict[tuple, object]:
    """Flatten a parsed document to {path: leaf-or-container} for comparison."""
    flat: dict[tuple, object] = {}
    if isinstance(node, dict):
        for key, value in node.items():
            flat.update(walk(value, path + (key,)))
        if not node:
            flat[path] = {}
    elif isinstance(node, list):
        for index, value in enumerate(node):
            flat.update(walk(value, path + (index,)))
        if not node:
            flat[path] = []
    else:
        flat[path] = node
    return flat


def delta_is_allowlisted(before: object, after: object) -> list[str]:
    """Return the reasons the before/after difference is NOT purely a repair."""
    flat_before, flat_after = walk(before), walk(after)
    expected = {}
    for legacy, repaired, _ in REPAIRS:
        expected[legacy] = repaired
    problems: list[str] = []
    for path in sorted(set(flat_before) | set(flat_after), key=lambda p: list(map(str, p))):
        old, new = flat_before.get(path, "<absent>"), flat_after.get(path, "<absent>")
        if old == new and type(old) is type(new):
            continue
        shown = "/".join(str(part) for part in path) or "<root>"
        # The repaired value lands at the same path, except `false -> null`
        # which replaces a leaf, and `true -> {}` which replaces a leaf with an
        # empty mapping; both keep `homeassistant` as the final path segment.
        if not path or path[-1] != "homeassistant":
            problems.append(f"{shown}: {old!r} -> {new!r} (outside allowlist)")
            continue
        if not isinstance(old, bool) or expected.get(old, "<none>") != new:
            problems.append(f"{shown}: {old!r} -> {new!r} (not a known legacy repair)")
    return problems


def process(path: pathlib.Path, schema: dict | None, prop: str) -> bool:
    """Validate and if needed repair one registry. Returns False only on a
    repair this script made and could not prove correct."""
    if not path.exists():
        return True

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        log(f"{path.name}: unreadable ({exc}); leaving it for zigbee2mqtt to report")
        return True

    try:
        before = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        log(f"{path.name}: not parseable as YAML ({exc.__class__.__name__}); "
            "leaving it for zigbee2mqtt to report")
        return True

    if before is None:
        return True

    existing = errors_for(schema, before) if schema is not None else []
    if not existing:
        return True

    repaired, notes = repair_text(text)
    if not notes:
        log(f"{path.name}: invalid but nothing in the repair allowlist matched; "
            "leaving it for zigbee2mqtt to report. Schema errors follow:")
        for error in existing:
            log(f"  {path.name}: {error}")
        return True

    try:
        after = yaml.safe_load(repaired)
    except yaml.YAMLError as exc:
        log(f"{path.name}: REFUSING the repair, rewritten file does not parse ({exc})")
        return False

    drift = delta_is_allowlisted(before, after)
    if drift:
        log(f"{path.name}: REFUSING the repair, it would change more than the "
            "legacy scalars:")
        for problem in drift:
            log(f"  {path.name}: {problem}")
        return False

    remaining = errors_for(schema, after) if schema is not None else []
    if remaining:
        log(f"{path.name}: REFUSING the repair, the file is still invalid after it:")
        for error in remaining:
            log(f"  {path.name}: {error}")
        return False

    backup = path.with_name(f"{path.name}.bak.{int(time.time())}")
    scratch = path.with_name(f".{path.name}.state-guard.tmp")
    try:
        # Staged before the backup on purpose: a service that cannot write here
        # is restarting every few seconds, and backing up first would leave a
        # new timestamped copy behind on every one of those attempts.
        scratch.write_text(repaired, encoding="utf-8")
        shutil.copystat(path, scratch)
        shutil.copy2(path, backup)
        # Atomic rename, so an interrupted or unpermitted repair can never leave
        # a truncated registry behind: either the old file or the new one is
        # there. Writing in place would truncate before the first byte lands.
        os.replace(scratch, path)
    except OSError as exc:
        log(f"{path.name}: could not apply the repair ({exc}); the file is "
            "unchanged and zigbee2mqtt will report on it")
        try:
            scratch.unlink(missing_ok=True)
        except OSError:
            pass
        return True

    log(f"{path.name}: repaired {len(notes)} legacy value(s); backup at {backup.name}")
    for note in notes:
        log(f"  {path.name}: {note}")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=pathlib.Path,
                        help="Zigbee2MQTT data directory holding the registries")
    parser.add_argument("--schema", type=pathlib.Path, default=None,
                        help="settings.schema.json from the installed Zigbee2MQTT")
    args = parser.parse_args(argv)

    schema: dict | None = None
    if args.schema is not None and args.schema.exists():
        try:
            schema = json.loads(args.schema.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log(f"could not read schema {args.schema} ({exc}); validation skipped")
    if schema is None:
        log("no usable settings schema; validation skipped, repairs not attempted")
        return 0
    if jsonschema is None:
        log("jsonschema unavailable; validation skipped, repairs not attempted")
        return 0

    ok = True
    for filename, prop in REGISTRIES.items():
        try:
            node = subschema(schema, prop)
        except KeyError:
            log(f"schema has no '{prop}' property; skipping {filename}")
            continue
        try:
            if not process(args.data_dir / filename, node, prop):
                ok = False
        except Exception as exc:  # noqa: BLE001 - deliberate fail-open
            # A defect in this guard must never be what keeps the radio down.
            # Zigbee2MQTT gets its attempt and reports its own verdict.
            log(f"{filename}: guard failed unexpectedly ({exc.__class__.__name__}: "
                f"{exc}); continuing so zigbee2mqtt still starts")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
