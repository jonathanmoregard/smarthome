"""Parity oracle discovery must be explicit and fail closed."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from . import portability


class PortabilityTests(unittest.TestCase):
    def test_discovers_expected_home_assistant_wrapper(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            wrapper = Path(directory) / 'hash-homeassistant-2026.7.4/bin/.hass-wrapped'
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text('[]')
            self.assertEqual(portability.ha_wrapper(Path(directory)), wrapper)

    def test_explicit_missing_wrapper_fails_with_actionable_message(self):
        with mock.patch.dict(os.environ, {'HA_WRAPPER': '/missing/parity-wrapper'}, clear=False):
            with self.assertRaisesRegex(RuntimeError, 'HA_WRAPPER.*does not exist'):
                portability.ha_wrapper(Path('/unused'))

    def test_missing_or_wrong_oracle_never_degrades_to_empty_dependencies(self):
        with mock.patch.object(portability, 'ha_wrapper', return_value=None), \
             mock.patch.object(portability, 'version', side_effect=portability.PackageNotFoundError):
            with self.assertRaisesRegex(RuntimeError, 'Home Assistant 2026.7.4.*HA_WRAPPER'):
                portability.dependencies()


if __name__ == '__main__':
    unittest.main()
