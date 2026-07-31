from __future__ import annotations

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from unity_debugger_pure_mcp_launcher.__main__ import (
    EXIT_AMBIGUOUS,
    EXIT_INCOMPATIBLE,
    EXIT_INTEGRITY,
    EXIT_NO_LIVE,
    EXIT_WINDOWS_REQUIRED,
    exec_bridge,
    main,
)
from unity_debugger_pure_mcp_launcher.discovery import (
    AMBIGUOUS_MESSAGE,
    INCOMPATIBLE_MESSAGE,
    INTEGRITY_MESSAGE,
    NO_LIVE_MESSAGE,
    AmbiguousCompanionError,
    IncompatibleProtocolError,
    IntegrityError,
    NoLiveCompanionError,
)
from unity_debugger_pure_mcp_launcher.model import LaunchSelection


LAUNCHER_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = LAUNCHER_ROOT.parent


class MetadataTests(unittest.TestCase):
    def test_package_metadata_console_entry_and_license(self) -> None:
        metadata = (LAUNCHER_ROOT / "pyproject.toml").read_text("utf-8")
        for required in (
            'name = "unity-debugger-pure-mcp"',
            'version = "0.1.0"',
            'requires-python = ">=3.10"',
            "dependencies = []",
            'unity-debugger-pure-mcp = "unity_debugger_pure_mcp_launcher.__main__:main"',
        ):
            self.assertIn(required, metadata)
        self.assertEqual(
            (LAUNCHER_ROOT / "LICENSE.txt").read_bytes(),
            (REPOSITORY_ROOT / "LICENSE.txt").read_bytes(),
        )


class MainTests(unittest.TestCase):
    def selection(self) -> LaunchSelection:
        return LaunchSelection(
            runtime_root="C:\\runtime root",
            client_root="D:\\project 测试",
            bridge_executable="C:\\extension path\\dist\\mcp-bridge.exe",
        )

    def test_exec_bridge_uses_exact_shell_free_registry_argv(self) -> None:
        selection = self.selection()
        with patch("os.execv") as execv:
            with self.assertRaises(RuntimeError):
                exec_bridge(selection)
        execv.assert_called_once_with(selection.bridge_executable, [
            selection.bridge_executable,
            "--registry",
            selection.runtime_root,
            "--client-root",
            selection.client_root,
        ])

    def test_main_rejects_non_windows_and_arguments(self) -> None:
        stderr = io.StringIO()
        self.assertEqual(main([], platform="linux", stderr=stderr), EXIT_WINDOWS_REQUIRED)
        self.assertNotIn("linux", stderr.getvalue())

        stderr = io.StringIO()
        self.assertEqual(main(["--token", "secret"], platform="win32", stderr=stderr), EXIT_INTEGRITY)
        self.assertNotIn("secret", stderr.getvalue())

    def test_main_maps_discovery_failures_without_leaking_details(self) -> None:
        cases = [
            (NoLiveCompanionError, EXIT_NO_LIVE, NO_LIVE_MESSAGE),
            (AmbiguousCompanionError, EXIT_AMBIGUOUS, AMBIGUOUS_MESSAGE),
            (IntegrityError, EXIT_INTEGRITY, INTEGRITY_MESSAGE),
            (IncompatibleProtocolError, EXIT_INCOMPATIBLE, INCOMPATIBLE_MESSAGE),
        ]
        for exception, expected_code, message in cases:
            stderr = io.StringIO()
            def fail(*_args, **_kwargs):
                raise exception("secret-token C:\\private\\path")
            self.assertEqual(
                main([], platform="win32", stderr=stderr, discover_fn=fail),
                expected_code,
            )
            self.assertEqual(stderr.getvalue(), f"{message}\n")

    def test_main_executes_selection_and_redacts_exec_failure(self) -> None:
        selection = self.selection()
        stderr = io.StringIO()
        calls = []
        def discover_fn(*_args, **_kwargs):
            return selection
        def exec_fn(value):
            calls.append(value)
            raise OSError("secret-token C:\\private\\path")
        with tempfile.TemporaryDirectory() as cwd:
            code = main(
                [],
                platform="win32",
                stderr=stderr,
                cwd=cwd,
                environ={"LOCALAPPDATA": "C:\\fixture"},
                discover_fn=discover_fn,
                exec_fn=exec_fn,
            )
        self.assertEqual(calls, [selection])
        self.assertEqual(code, EXIT_INTEGRITY)
        self.assertEqual(stderr.getvalue(), f"{INTEGRITY_MESSAGE}\n")

    def test_main_redacts_unexpected_internal_failures(self) -> None:
        stderr = io.StringIO()
        def fail(*_args, **_kwargs):
            raise ValueError("secret-token C:\\private\\path")
        self.assertEqual(
            main([], platform="win32", stderr=stderr, discover_fn=fail),
            EXIT_INTEGRITY,
        )
        self.assertEqual(stderr.getvalue(), f"{INTEGRITY_MESSAGE}\n")


if __name__ == "__main__":
    unittest.main()
