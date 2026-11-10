"""Regression tests for Windows Diffusers Python discovery (stdlib-only)."""
from __future__ import annotations

import os
import time
import unittest
from unittest import mock

import diffusers_backend as backend


class DiscoveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved_cache = backend._python_cache
        self.saved_miss = backend._python_cache_last_miss

    def tearDown(self) -> None:
        backend._python_cache = self.saved_cache
        backend._python_cache_last_miss = self.saved_miss

    def test_valid_override_recovers_immediately_from_cached_miss(self) -> None:
        chosen = r"C:\Users\example\AppData\Local\Programs\Python\Python312\python.exe"
        value = {"cmd": [chosen], "version": "3.12.9"}
        backend._python_cache = None
        backend._python_cache_last_miss = time.monotonic()
        with mock.patch.dict(os.environ, {"LUMENDECK_PYTHON": chosen}), \
                mock.patch.object(backend, "_probe_python", return_value=value) as probe:
            self.assertEqual(backend._find_python(), value)
            probe.assert_called_once_with([chosen])

    def test_override_supersedes_cached_different_interpreter(self) -> None:
        chosen = r"C:\Users\example\Python312\python.exe"
        backend._python_cache = {"cmd": ["python"], "version": "3.11.9"}
        value = {"cmd": [chosen], "version": "3.12.9"}
        with mock.patch.dict(os.environ, {"LUMENDECK_PYTHON": chosen}), \
                mock.patch.object(backend, "_probe_python", return_value=value):
            self.assertEqual(backend._find_python(), value)

    def test_negative_cache_avoids_repeated_probes_then_retries(self) -> None:
        backend._python_cache = None
        backend._python_cache_last_miss = time.monotonic()
        with mock.patch.dict(os.environ, {"LUMENDECK_PYTHON": ""}), \
                mock.patch.object(backend, "_probe_python", return_value=None) as probe, \
                mock.patch.object(backend, "_managed_runtime_python", return_value=None), \
                mock.patch.object(backend, "_candidate_paths", return_value=[]):
            self.assertIsNone(backend._find_python())
            probe.assert_not_called()
            backend._python_cache_last_miss -= backend._PYTHON_RETRY_SECONDS + 1
            self.assertIsNone(backend._find_python())
            probe.assert_called()
            self.assertGreater(backend._python_cache_last_miss, 0)

    def test_recovery_without_restart_after_exPIRED_miss(self) -> None:
        backend._python_cache = None
        backend._python_cache_last_miss = time.monotonic() - backend._PYTHON_RETRY_SECONDS - 1
        value = {"cmd": ["python"], "version": "3.12.9"}
        with mock.patch.dict(os.environ, {"LUMENDECK_PYTHON": ""}), \
                mock.patch.object(backend, "_probe_python",
                                  side_effect=lambda cmd: value if cmd == ["python"] else None), \
                mock.patch.object(backend, "_managed_runtime_python", return_value=None), \
                mock.patch.object(backend, "_candidate_paths", return_value=[]):
            self.assertEqual(backend._find_python(), value)

    def test_error_explains_explicit_path_and_restart(self) -> None:
        self.assertIn("LUMENDECK_PYTHON", backend._PYTHON_REQUIRED_MESSAGE)
        self.assertIn("Python 3.12", backend._PYTHON_REQUIRED_MESSAGE)
        self.assertIn("bridge", backend._PYTHON_REQUIRED_MESSAGE)


if __name__ == "__main__":
    unittest.main()
