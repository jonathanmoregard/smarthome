"""HA state sequences must cross colour/JSON boundaries as ordinary values."""
import json
import os
import unittest
from collections.abc import Sequence
from pathlib import Path

from dry_harness import DrySim, ROOT
from test_core import base_fixture, record, constant, LIVING, CATALOG


class StateSequence(Sequence):
    """Read-only sequence, like HA's non-JSON-native TupleWrapper."""
    def __init__(self, values):
        self.values = tuple(values)

    def __getitem__(self, index):
        return self.values[index]

    def __len__(self):
        return len(self.values)


class StateSequenceTests(unittest.TestCase):
    def setUp(self):
        self.sim = DrySim()
        root = Path(os.environ.get('LIGHTING_CORE_DIR', ROOT / 'candidate'))
        for name in ['effects_scale', 'effects_resolve']:
            value = json.loads((root / (name + '.json')).read_text())
            self.sim.config[name] = value.get('config', value)

    def test_warm_scale_and_rgb_anchors_accept_state_sequences(self):
        day = {'brightness': 240, 'color': {'rgb': StateSequence([255, 220, 180])}}
        cosy = {'brightness': 128, 'color': {'rgb': StateSequence([255, 145, 25])}}
        for position in [-2, -1.0842519685039371, -1, -.5, 0, .5, 1, 1.5, 2]:
            with self.subTest(position=position):
                result = self.sim.pure('effects_scale', day=day, cosy=cosy,
                                       position=position, warm_end=StateSequence([255, 126, 0]))
                self.assertEqual(json.loads(json.dumps(result)), result)
                if position == 0:
                    self.assertEqual(result['color'], {'rgb': [255, 145, 25]})
                elif position == 1:
                    self.assertEqual(result['color'], {'rgb': [255, 220, 180]})
                elif position == -2:
                    self.assertEqual(result['color'], {'rgb': [255, 126, 0]})

    def test_constant_rgb_override_returns_json_native_colour(self):
        overrides = {'rgb': record(LIVING, {'color': constant({'rgb': StateSequence([25, 40, 80])})})}
        result = self.sim.pure('effects_resolve', base=base_fixture(), overrides=overrides,
                               catalog=CATALOG, private=[], power={}, sara=False,
                               warm_end=StateSequence([255, 126, 0]))
        self.assertEqual(json.loads(json.dumps(result)), result)
        self.assertEqual(result['targets'][LIVING]['color']['value'], {'rgb': [25, 40, 80]})

    def test_base_rgb_and_effect_channels_accept_state_sequences(self):
        base = base_fixture()
        base[LIVING]['color'] = {'rgb': StateSequence([255, 56, 0])}
        base[LIVING]['effect'] = 'Candle'
        catalog = {'effects': {'Candle': {'channels': StateSequence(['brightness', 'color'])}}}
        result = self.sim.pure('effects_resolve', base=base, overrides={}, catalog=catalog,
                               private=[], power={}, sara=False, warm_end=[255, 126, 0])
        self.assertEqual(json.loads(json.dumps(result)), result)
        self.assertEqual(result['targets'][LIVING]['color']['base'], {'rgb': [255, 56, 0]})


if __name__ == '__main__':
    unittest.main()
