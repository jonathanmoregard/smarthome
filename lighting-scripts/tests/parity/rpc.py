"""Persistent JSON-lines transport. Never executes reference decision code."""
from __future__ import annotations
import atexit
import copy
from collections.abc import Mapping, Sequence
from datetime import datetime
import json
import math
import os
from pathlib import Path
import select
import shlex
import subprocess
import tempfile
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]


def empty_snapshot():
    return {'state': {}, 'areas': {}, 'members': [], 'now': '2026-10-26T12:00:00+01:00', 'elapsed': 0}


def encode_numbers(value):
    nonfinite = []

    def walk(item, path):
        if isinstance(item, datetime):
            return item.isoformat()
        if isinstance(item, SimpleNamespace):
            return walk(vars(item), path)
        if isinstance(item, float) and not math.isfinite(item):
            nonfinite.append({'path': path, 'value': 'NaN' if math.isnan(item) else 'Infinity' if item > 0 else '-Infinity'})
            return None
        if isinstance(item, Mapping):
            return {key: walk(child, [*path, key]) for key, child in item.items()}
        if isinstance(item, Sequence) and not isinstance(item, (str, bytes, bytearray)):
            return [walk(child, [*path, index]) for index, child in enumerate(item)]
        return item

    return {'payload': walk(value, []), 'nonfinite': nonfinite}


def decode_numbers(envelope):
    payload = envelope['payload']
    for entry in envelope['nonfinite']:
        parent = payload
        for key in entry['path'][:-1]:
            parent = parent[key]
        parent[entry['path'][-1]] = float(entry['value'])
    return payload


class Rpc:
    def __init__(self):
        self.stderr = tempfile.TemporaryFile(mode='w+')
        self.numeric_bridge = 'PARITY_RPC' not in os.environ
        self.process = subprocess.Popen(shlex.split(os.environ.get('PARITY_RPC', 'node --experimental-strip-types tests/parity/bridge.ts')),
                                        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.stderr, text=True, bufsize=1)
        atexit.register(self.close)
        self.entrypoints = set()
        self.requests = 0
        self.comparisons = 0
        self.fixtures = []

    def send(self, payload):
        self.process.stdin.write(json.dumps(encode_numbers(payload) if self.numeric_bridge else payload, allow_nan=False) + '\n')
        self.process.stdin.flush()

    def call(self, name, args=None, snapshot=None, callback=None, callback_mode='all', instrument_log=False):
        self.entrypoints.add(name)
        self.requests += 1
        payload = {'script': name, 'args': args or {}, 'snapshot': snapshot or empty_snapshot()}
        if callback:
            assert self.numeric_bridge, 'Synchronous callbacks require the explicit parity bridge'
            payload['parityHooks'] = callback_mode
        if instrument_log:
            payload['parityLog'] = True
        try:
            self.send(payload)
        except (BrokenPipeError, OSError) as error:
            raise AssertionError(f'TypeScript RPC exited: {self.diagnostics()}') from error
        callback_error = None
        while True:
            readable, _, _ = select.select([self.process.stdout], [], [], 30)
            assert readable, f'TypeScript RPC timed out running {name}'
            line = self.process.stdout.readline()
            assert line, f'TypeScript RPC exited running {name}: {self.diagnostics()}'
            response = json.loads(line)
            if 'nonfinite' in response:
                response = decode_numbers(response)
            if 'callback' not in response:
                break
            assert callback is not None, 'Unexpected callback from TypeScript'
            try:
                state = callback(response['callback'])
                self.send({'callback_result': {'snapshot': state}})
            except Exception as error:
                callback_error = error
                self.send({'callback_result': {'error': str(error) or type(error).__name__}})
        if callback_error is not None:
            raise callback_error
        assert not response.get('error'), f'TypeScript {name}: {response["error"]}'
        return response

    def pure(self, name, args):
        snapshot = empty_snapshot()
        response = self.call(name, args, copy.deepcopy(snapshot))
        assert response['snapshot'] == snapshot, f'{name} mutated state in dry execution'
        assert response.get('calls', []) == [], f'{name} called an external action in dry execution'
        assert response.get('events', []) == [], f'{name} emitted an event in dry execution'
        return response['result']

    def diagnostics(self):
        self.stderr.seek(0)
        return self.stderr.read()[-4000:]

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()
        self.stderr.close()
        atexit.unregister(self.close)
